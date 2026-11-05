"""
SUI connector using the Sui GraphQL RPC (JSON-RPC was sunset in 2026).
Fetches transactions for a SUI wallet address and normalizes balance changes.

Transactions are paged via `transactions(filter: {affectedAddress})` and
converted to the legacy JSON-RPC transaction-block shape, so raw rows stored
before the migration and new ones normalize identically.

Multi-yield normalization: each balance change entry becomes a NormalizedTransaction,
plus a dedicated fee transaction per on-chain transaction.
"""

import json
import os
import time
import requests
from decimal import Decimal
from datetime import datetime, timezone
from typing import Dict, Any, Generator, Optional, Tuple

from backend.connectors.base.base_connector import BaseConnector
from backend.config.loader import configure_logging
from backend.core.network_normalizer import normalize_network
from backend.db.models import NormalizedTransaction

log = configure_logging("sui")

# SUI native token constants
SUI_NATIVE_COIN_TYPE = "0x2::sui::SUI"
SUI_DECIMALS = 9
SUI_DIVISOR = Decimal(10 ** SUI_DECIMALS)

SUI_GRAPHQL_URL = "https://graphql.mainnet.sui.io/graphql"

TRANSACTIONS_QUERY = """
query($address: SuiAddress!, $after: String) {
  transactions(first: 50, after: $after, filter: { affectedAddress: $address }) {
    pageInfo { hasNextPage endCursor }
    nodes {
      digest
      sender { address }
      kind { __typename }
      effects {
        status
        timestamp
        checkpoint { sequenceNumber }
        gasEffects { gasSummary { computationCost storageCost storageRebate nonRefundableStorageFee } }
        balanceChanges(first: 50) {
          pageInfo { hasNextPage }
          nodes { owner { address } amount coinType { repr } }
        }
      }
    }
  }
}
"""

COIN_METADATA_QUERY = """
query($coinType: String!) { coinMetadata(coinType: $coinType) { symbol decimals } }
"""

BALANCES_QUERY = """
query($address: SuiAddress!) {
  address(address: $address) { balances(first: 50) { nodes { coinType { repr } totalBalance } } }
}
"""


def normalize_coin_type(repr_: str) -> str:
    """Shorten system-package addresses like JSON-RPC did (0x000…02::sui::SUI → 0x2::sui::SUI)."""
    address, sep, rest = (repr_ or "").partition("::")
    if not sep or not address.startswith("0x"):
        return repr_
    try:
        value = int(address, 16)
    except ValueError:
        return repr_
    if value < 0x10000:
        return f"{hex(value)}::{rest}"
    return f"0x{address[2:].rjust(64, '0')}::{rest}"


def _iso_to_ms(timestamp: Optional[str]) -> Optional[str]:
    if not timestamp:
        return None
    dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    return str(round(dt.timestamp() * 1000))


def graphql_tx_to_legacy(node: Dict[str, Any]) -> Dict[str, Any]:
    """Convert a GraphQL transaction node into the legacy JSON-RPC transaction-block shape."""
    effects = node.get("effects") or {}
    gas = ((effects.get("gasEffects") or {}).get("gasSummary")) or {}
    balance_changes = []
    for bc in ((effects.get("balanceChanges") or {}).get("nodes")) or []:
        owner_address = (bc.get("owner") or {}).get("address")
        balance_changes.append(
            {
                "owner": {"AddressOwner": owner_address} if owner_address else {},
                "coinType": normalize_coin_type((bc.get("coinType") or {}).get("repr", "")),
                "amount": str(bc.get("amount", "0")),
            }
        )
    return {
        "digest": node.get("digest"),
        "timestampMs": _iso_to_ms(effects.get("timestamp")),
        "checkpoint": str(((effects.get("checkpoint") or {}).get("sequenceNumber")) or ""),
        "transaction": {
            "data": {
                "sender": (node.get("sender") or {}).get("address", ""),
                "transaction": {"kind": (node.get("kind") or {}).get("__typename", "")},
            }
        },
        "effects": {
            "status": {"status": str(effects.get("status", "")).lower()},
            "gasUsed": {k: str(v) for k, v in gas.items() if v is not None},
        },
        "balanceChanges": balance_changes,
    }


class ConnectorSui(BaseConnector):
    """SUI connector for wallet transactions via the Sui GraphQL RPC."""

    @property
    def connector_name(self) -> str:
        return "sui"

    def __init__(
        self,
        wallet_address: str = "",
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        """
        Initialize SUI connector.

        Args:
            wallet_address: The SUI wallet address to scan (0x-prefixed, 66 chars)
            account_id: Optional account ID for database linking
            connector_id: Optional connector ID for database linking
            config: Optional connector configuration dict
            progress_callback: Optional callback for reporting progress
            **kwargs: Additional configuration parameters
        """
        # Set variables needed for connector_name BEFORE super().__init__()
        self.chain_name = "sui"
        self.wallet_address = wallet_address

        # Initialize base (sets self.test_mode and logs)
        super().__init__(
            account_id=account_id,
            connector_id=connector_id,
            config=config,
            progress_callback=progress_callback,
        )

        # Validate wallet configuration
        if not self.wallet_address:
            raise ValueError("Missing wallet address")

        # Validate SUI address format (0x-prefixed hex, up to 66 chars)
        if not self.wallet_address.startswith("0x"):
            raise ValueError(f"Invalid SUI address format: must start with 0x")

        # Coin metadata cache: coin_type -> (symbol, decimals)
        self._coin_cache: Dict[str, Tuple[str, int]] = {}

        # Pre-populate native SUI
        self._coin_cache[SUI_NATIVE_COIN_TYPE] = ("SUI", SUI_DECIMALS)

        # Set default values
        self.request_delay = 0.3
        self.max_retries = 5

        if self.test_mode or self.renormalize_mode:
            return

        self.base_url = os.getenv("SUI_GRAPHQL_URL") or SUI_GRAPHQL_URL
        log.info(f"Using SUI GraphQL endpoint: {self.base_url}")

    def _get_default_test_file(self) -> str:
        """Get the default test fixture file path."""
        return os.path.join(
            os.path.dirname(__file__),
            "..",
            "..",
            "tests",
            "fixtures",
            "sui",
            "sui_transactions.json",
        )

    def graphql_request(self, query: str, variables: Dict[str, Any]) -> Dict[str, Any]:
        """POST a GraphQL query with retry/backoff; returns the `data` object."""
        delay = self.request_delay
        last_error = None

        for attempt in range(1, self.max_retries + 1):
            try:
                time.sleep(delay)
                response = requests.post(
                    self.base_url,
                    json={"query": query, "variables": variables},
                    timeout=30,
                )
                if response.status_code == 429 or response.status_code >= 500:
                    last_error = f"HTTP {response.status_code}"
                    log.warning(f"⚠️ SUI GraphQL {last_error} (attempt {attempt})")
                    delay *= 2
                    continue
                if response.status_code >= 400:
                    raise RuntimeError(
                        f"HTTP {response.status_code}: {response.text[:200]}"
                    )
                payload = response.json()
                if payload.get("errors"):
                    raise RuntimeError(f"GraphQL error: {payload['errors'][0].get('message')}")
                return payload.get("data") or {}
            except requests.exceptions.RequestException as e:
                last_error = str(e)
                log.warning(f"⚠️ Network error (attempt {attempt}): {e}")
                delay *= 2

        raise RuntimeError(
            f"SUI GraphQL request failed after {self.max_retries} retries: {last_error}"
        )

    def _fetch_transactions(self) -> list:
        """Page through every transaction affecting the wallet."""
        transactions = []
        after = None
        while True:
            data = self.graphql_request(
                TRANSACTIONS_QUERY, {"address": self.wallet_address, "after": after}
            )
            page = data.get("transactions") or {}
            for node in page.get("nodes") or []:
                if ((node.get("effects") or {}).get("balanceChanges") or {}).get(
                    "pageInfo", {}
                ).get("hasNextPage"):
                    log.warning(
                        f"Transaction {node.get('digest')} has >50 balance changes; extra changes ignored"
                    )
                transactions.append(graphql_tx_to_legacy(node))
            self.update_progress(
                operation="Fetching transactions",
                current=len(transactions),
                total=len(transactions),
                log_message=f"Fetched {len(transactions)} transactions",
            )
            page_info = page.get("pageInfo") or {}
            if not page_info.get("hasNextPage"):
                return transactions
            after = page_info.get("endCursor")

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """Fetch and yield raw transactions with two-step digest + batch-fetch pattern."""
        try:
            # Test mode: Load from fixture file
            if self.test_mode:
                test_file = (
                    self.config.get("test_file_path") or self._get_default_test_file()
                )
                log.info(f"🧪 [TEST MODE] Loading test data from {test_file}")

                if not os.path.exists(test_file):
                    log.warning(f"Test file not found: {test_file}")
                    return

                with open(test_file, "r") as f:
                    data = json.load(f)

                # Return the transactions array from the fixture
                items = (
                    data
                    if isinstance(data, list)
                    else data.get("transactions", [])
                )
                for item in items:
                    yield item

                log.info(f"🧪 [TEST MODE] Loaded {len(items)} test transactions")
                return

            self.update_progress(
                operation="Fetching transactions",
                current=0,
                total=1,
                log_message=f"Fetching transactions for {self.wallet_address[:10]}... on SUI",
            )
            transactions = self._fetch_transactions()

            # Sort by timestampMs for chronological order
            transactions.sort(key=lambda tx: int(tx.get("timestampMs", "0")))

            # Yield each transaction
            for tx in transactions:
                yield tx

            log.info(f"   ✅ Found {len(transactions)} transactions on SUI")

            self.update_progress(
                operation="Completed",
                current=1,
                total=1,
                log_message=f"✅ Found {len(transactions)} transactions on SUI",
            )
        except Exception as e:
            log.error(f"   ⚠️ Error fetching SUI transactions: {e}")
            self.update_progress(
                operation="Failed",
                current=1,
                total=1,
                log_message=f"❌ Error: {str(e)[:100]}",
            )
            raise

    def _resolve_coin_metadata(self, coin_type: str) -> Tuple[str, int]:
        """
        Resolve coin type to (symbol, decimals) with caching.

        Uses the GraphQL coinMetadata query for non-SUI tokens.
        Falls back to extracting symbol from coin type string.

        Args:
            coin_type: SUI coin type string (e.g., "0x2::sui::SUI")

        Returns:
            Tuple of (symbol, decimals)
        """
        # Check cache first
        if coin_type in self._coin_cache:
            return self._coin_cache[coin_type]

        # In test mode, extract from coin type string
        if self.test_mode:
            symbol, decimals = self._parse_coin_type_fallback(coin_type)
            self._coin_cache[coin_type] = (symbol, decimals)
            return symbol, decimals

        # Live mode: query RPC
        try:
            result = self.graphql_request(
                COIN_METADATA_QUERY, {"coinType": coin_type}
            ).get("coinMetadata")

            if result:
                symbol = result.get("symbol", None)
                decimals = result.get("decimals", SUI_DECIMALS)

                if not symbol:
                    symbol, _ = self._parse_coin_type_fallback(coin_type)

                self._coin_cache[coin_type] = (symbol, decimals)
                return symbol, decimals

        except Exception as e:
            log.warning(f"Failed to fetch coin metadata for {coin_type}: {e}")

        # Fallback: extract symbol from coin type string
        symbol, decimals = self._parse_coin_type_fallback(coin_type)
        self._coin_cache[coin_type] = (symbol, decimals)
        return symbol, decimals

    def _parse_coin_type_fallback(self, coin_type: str) -> Tuple[str, int]:
        """
        Extract symbol from a SUI coin type string as fallback.

        Coin type format: "0x{address}::{module}::{symbol}"
        Example: "0xdba34...::usdc::USDC" → ("USDC", 9)

        Args:
            coin_type: SUI coin type string

        Returns:
            Tuple of (symbol, default_decimals)
        """
        try:
            parts = coin_type.split("::")
            if len(parts) >= 3:
                return parts[-1], SUI_DECIMALS
        except Exception:
            pass
        return coin_type, SUI_DECIMALS

    def raw_to_normalized(
        self, tx: Dict
    ) -> Generator[NormalizedTransaction, None, None]:
        """
        Map raw SUI transaction block to standardized format.

        Multi-yield: each balance change where owner == wallet becomes a
        NormalizedTransaction, plus a dedicated fee transaction.

        Args:
            tx: Raw transaction block (legacy JSON-RPC shape, see graphql_tx_to_legacy)

        Yields:
            NormalizedTransaction: One or more standardized transaction objects
        """
        try:
            # Extract digest (unique transaction ID)
            digest = tx.get("digest")
            if not digest:
                log.warning(f"Missing digest in transaction: {tx}")
                return

            # Check execution status — skip failed transactions
            effects = tx.get("effects", {})
            status = effects.get("status", {})
            if status.get("status") != "success":
                log.debug(
                    f"Skipping failed transaction: {digest} "
                    f"({status.get('status', 'unknown')})"
                )
                return

            # Parse timestamp (milliseconds since epoch)
            timestamp_ms = tx.get("timestampMs")
            if timestamp_ms:
                dt = datetime.fromtimestamp(
                    int(timestamp_ms) / 1000, tz=timezone.utc
                )
            else:
                log.warning(f"Missing timestampMs for tx {digest}")
                dt = datetime.now(timezone.utc)

            # Get sender address
            sender = ""
            transaction_data = tx.get("transaction", {})
            if transaction_data:
                tx_data_inner = transaction_data.get("data", {})
                sender = tx_data_inner.get("sender", "")

            # Get transaction kind for source_transaction_type
            source_tx_type = "ProgrammableTransaction"
            if transaction_data:
                tx_data_inner = transaction_data.get("data", {})
                transaction_kind = tx_data_inner.get("transaction", {})
                if isinstance(transaction_kind, dict):
                    source_tx_type = transaction_kind.get("kind", source_tx_type)

            # Determine if wallet paid the fee
            wallet_paid_fee = sender.lower() == self.wallet_address.lower()

            # Calculate gas fee from effects
            gas_used = effects.get("gasUsed", {})
            computation_cost = int(gas_used.get("computationCost", "0"))
            storage_cost = int(gas_used.get("storageCost", "0"))
            storage_rebate = int(gas_used.get("storageRebate", "0"))
            net_gas_mist = computation_cost + storage_cost - storage_rebate
            fee_sui = Decimal(max(net_gas_mist, 0)) / SUI_DIVISOR

            # Process balance changes
            balance_changes = tx.get("balanceChanges", [])
            wallet_lower = self.wallet_address.lower()
            yielded_count = 0

            # Pre-index counterparty addresses from balanceChanges
            # Build: { coinType: [(address, amount_int), ...] } for non-wallet entries
            counterparties: Dict[str, list] = {}
            for bc in balance_changes:
                bc_owner = bc.get("owner", {})
                bc_addr = ""
                if isinstance(bc_owner, dict):
                    # Only consider AddressOwner (skip ObjectOwner for shared objects/DEX pools)
                    bc_addr = bc_owner.get("AddressOwner", "")
                elif isinstance(bc_owner, str):
                    bc_addr = bc_owner
                if not bc_addr or bc_addr.lower() == wallet_lower:
                    continue
                bc_coin = bc.get("coinType", SUI_NATIVE_COIN_TYPE)
                bc_amount = int(bc.get("amount", "0"))
                counterparties.setdefault(bc_coin, []).append((bc_addr, bc_amount))

            for idx, change in enumerate(balance_changes):
                # Only process balance changes for our wallet
                owner = change.get("owner", {})
                owner_address = ""
                if isinstance(owner, dict):
                    owner_address = owner.get("AddressOwner", "")
                elif isinstance(owner, str):
                    owner_address = owner

                if owner_address.lower() != wallet_lower:
                    continue

                # Get coin type and resolve metadata
                coin_type = change.get("coinType", SUI_NATIVE_COIN_TYPE)
                symbol, decimals = self._resolve_coin_metadata(coin_type)

                # Parse amount (signed string: positive = received, negative = sent)
                amount_str = change.get("amount", "0")
                amount_raw = int(amount_str)

                # For native SUI, the balance change includes the gas fee deduction.
                # We handle gas fees separately via a dedicated fee transaction,
                # so we need to add back the gas fee to the SUI balance change
                # to get the actual transfer amount.
                if coin_type == SUI_NATIVE_COIN_TYPE and wallet_paid_fee:
                    # Gas fee is already deducted from the balance change.
                    # Add it back to isolate the transfer amount.
                    amount_raw = amount_raw + net_gas_mist

                # Skip zero-amount changes after gas adjustment
                # (e.g., tx where wallet only paid gas with no actual transfer)
                if amount_raw == 0:
                    continue

                # Convert to token units
                token_divisor = Decimal(10**decimals)
                amount = Decimal(abs(amount_raw)) / token_divisor

                # Determine direction from sign
                if amount_raw > 0:
                    direction = "inflow"
                else:
                    direction = "outflow"

                # Build source_transaction_id
                source_tx_id = f"{digest}_{coin_type}_{idx}"

                # Determine from/to addresses based on direction
                # Resolve counterparty from balanceChanges or sender field
                if direction == "outflow":
                    from_address = self.wallet_address
                    # Find recipient: non-wallet address with positive amount for same coin type
                    candidates = counterparties.get(coin_type, [])
                    to_address = next(
                        (addr for addr, amt in candidates if amt > 0), None
                    )
                else:
                    to_address = self.wallet_address
                    # For inflow, sender (from transaction.data.sender) is the most
                    # reliable source — it's who initiated the transaction
                    if sender and sender.lower() != wallet_lower:
                        from_address = sender
                    else:
                        # Fallback: find non-wallet address with negative amount for same coin type
                        candidates = counterparties.get(coin_type, [])
                        from_address = next(
                            (addr for addr, amt in candidates if amt < 0), None
                        )

                yield NormalizedTransaction(
                    # Source identification
                    source=self.connector_name,
                    account_id=self.account_id,
                    source_account=self.wallet_address,
                    source_transaction_id=source_tx_id,
                    network_transaction_id=digest,
                    # Core transaction data
                    date_time=dt,
                    direction=direction,
                    transaction_type="transfer",
                    source_transaction_type=source_tx_type,
                    # Asset and amounts
                    source_asset_symbol=symbol,
                    quantity=amount,
                    # No fee on individual transfers (fee is a separate record)
                    fee=Decimal(0),
                    source_fee_quote_asset_symbol="SUI",
                    include_fee=False,
                    # Addresses
                    source_from_account=from_address,
                    source_to_account=to_address,
                    network=normalize_network(self.chain_name),
                    token_contract_address=(
                        coin_type if coin_type != SUI_NATIVE_COIN_TYPE else None
                    ),
                )
                yielded_count += 1

            # Create dedicated fee transaction if this wallet paid the fee
            if wallet_paid_fee and fee_sui > 0:
                yield NormalizedTransaction(
                    # Source identification
                    source=self.connector_name,
                    account_id=self.account_id,
                    source_account=self.wallet_address,
                    source_transaction_id=f"{digest}_fee",
                    network_transaction_id=digest,
                    # Core transaction data
                    date_time=dt,
                    direction="outflow",
                    transaction_type="cost",
                    source_transaction_type=source_tx_type,
                    # Asset and amounts — qty=fee, price=1, price_quote=native
                    source_asset_symbol="SUI",
                    quantity=fee_sui,
                    price=Decimal(1),
                    source_price_quote_asset_symbol="SUI",
                    include_fee=False,
                    # Addresses
                    source_from_account=self.wallet_address,
                    source_to_account=None,
                    network=normalize_network(self.chain_name),
                    token_contract_address=None,
                )

        except Exception as e:
            log.error(
                f"Error normalizing transaction {tx.get('digest', 'unknown')}: {e}"
            )
            raise

    # ------------------------------------------------------------------
    # Balance API
    # ------------------------------------------------------------------

    @property
    def supports_balance(self) -> bool:
        return bool(self.wallet_address)

    def get_balance(self):
        from decimal import Decimal
        from backend.connectors.base.base_connector import BalanceEntry

        entries = []
        try:
            data = self.graphql_request(BALANCES_QUERY, {"address": self.wallet_address})
            nodes = (((data.get("address") or {}).get("balances")) or {}).get("nodes") or []
            for item in nodes:
                coin_type = normalize_coin_type((item.get("coinType") or {}).get("repr", ""))
                balance_str = str(item.get("totalBalance") or "0")
                if int(balance_str) > 0:
                    symbol, decimals = self._resolve_coin_metadata(coin_type)
                    total = Decimal(balance_str) / Decimal(10**decimals)
                    entries.append(BalanceEntry(
                        asset_symbol=symbol,
                        total=total,
                        available=total,
                        chain="sui",
                        raw=item,
                    ))
        except Exception as e:
            log.warning(f"Failed to fetch SUI balance: {e}")
        return entries
