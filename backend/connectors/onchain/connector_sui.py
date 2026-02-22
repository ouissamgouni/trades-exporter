"""
SUI connector using SUI JSON-RPC API via Ankr (free tier with archival data).
Fetches transactions for a SUI wallet address and normalizes balance changes.

Uses a two-step pattern:
1. Collect transaction digests via suix_queryTransactionBlocks (FromAddress + ToAddress)
2. Batch-fetch full details via sui_multiGetTransactionBlocks (with showBalanceChanges)

Multi-yield normalization: each balance change entry becomes a NormalizedTransaction,
plus a dedicated fee transaction per on-chain transaction.

⚠️ SUI JSON-RPC is deprecated — sunset target April 2026.
   Migration to gRPC or GraphQL RPC will be needed.
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


class ConnectorSui(BaseConnector):
    """SUI JSON-RPC connector for wallet transactions via Ankr."""

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
        self.request_delay = 0.5
        self.max_retries = 5
        self.digest_page_limit = 50  # Max per suix_queryTransactionBlocks page
        self.detail_batch_size = 50  # Max per sui_multiGetTransactionBlocks call

        # In test/renormalize mode, skip API-related configuration
        if self.test_mode or self.renormalize_mode:
            if self.test_mode:
                log.warning(
                    "⚠️ SUI JSON-RPC is deprecated (sunset: April 2026). "
                    "Plan migration to gRPC or GraphQL RPC."
                )
            return

        # Live mode: API configuration
        # Support configurable RPC URL for different providers (Ankr, BlockPI, etc.)
        ankr_api_key = os.getenv("ANKR_API_KEY")
        custom_rpc = os.getenv("SUI_RPC_URL")

        if custom_rpc:
            self.base_url = custom_rpc
        elif ankr_api_key:
            self.base_url = f"https://rpc.ankr.com/sui/{ankr_api_key}"
        else:
            # Ankr public endpoint (free, rate-limited)
            self.base_url = "https://rpc.ankr.com/sui"

        log.info(f"Using SUI RPC endpoint: {self.base_url[:50]}...")
        log.warning(
            "⚠️ SUI JSON-RPC is deprecated (sunset: April 2026). "
            "Plan migration to gRPC or GraphQL RPC."
        )

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

    def safe_request(self, method: str, params: list) -> Any:
        """
        Perform JSON-RPC request with retry, backoff, and rate limiting.

        Args:
            method: JSON-RPC method name (e.g., "suix_queryTransactionBlocks")
            params: JSON-RPC params array

        Returns:
            The "result" field from the JSON-RPC response

        Raises:
            RuntimeError: If all retries fail
        """
        delay = self.request_delay

        for attempt in range(1, self.max_retries + 1):
            try:
                time.sleep(delay)

                payload = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": method,
                    "params": params,
                }

                response = requests.post(
                    self.base_url,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                    timeout=30,
                )

                # Check HTTP status
                if response.status_code == 429:
                    log.warning(f"⚠️ Rate limited (attempt {attempt}): HTTP 429")
                    delay *= 2
                    continue
                elif response.status_code >= 400:
                    error_text = response.text[:200]
                    log.error(f"HTTP {response.status_code}: {error_text}")
                    raise RuntimeError(f"HTTP {response.status_code}: {error_text}")

                data = response.json()

                # Check for JSON-RPC errors
                if "error" in data:
                    error = data["error"]
                    error_msg = error.get("message", str(error))
                    log.error(f"JSON-RPC error: {error_msg}")
                    raise RuntimeError(f"JSON-RPC error: {error_msg}")

                return data.get("result")

            except requests.exceptions.RequestException as e:
                log.warning(f"⚠️ Network error (attempt {attempt}): {e}")
                if attempt < self.max_retries:
                    delay *= 2
                    continue
                raise RuntimeError(
                    f"Network error after {self.max_retries} retries: {e}"
                )
            except RuntimeError:
                if attempt < self.max_retries:
                    delay *= 2
                    continue
                raise
            except Exception as e:
                log.error(f"⚠️ API error: {e}")
                if attempt < self.max_retries:
                    delay *= 2
                    continue
                raise RuntimeError(
                    f"API error after {self.max_retries} retries: {e}"
                )

        raise RuntimeError(
            f"Failed after {self.max_retries} retries - API request failed"
        )

    def _collect_digests(self, filter_key: str) -> set:
        """
        Collect all transaction digests for a given address filter.

        Args:
            filter_key: Either "FromAddress" or "ToAddress"

        Returns:
            Set of transaction digest strings
        """
        digests = set()
        cursor = None

        while True:
            params = [
                {
                    "filter": {filter_key: self.wallet_address},
                    "options": {"showInput": False, "showEffects": False},
                },
                cursor,  # cursor (null for first page)
                self.digest_page_limit,  # limit
                False,  # descending order (False = ascending, oldest first)
            ]

            result = self.safe_request("suix_queryTransactionBlocks", params)

            items = result.get("data", [])
            for item in items:
                digest = item.get("digest") if isinstance(item, dict) else item
                if digest:
                    digests.add(digest)

            has_next = result.get("hasNextPage", False)
            next_cursor = result.get("nextCursor")

            if not has_next or not next_cursor:
                break

            cursor = next_cursor

        return digests

    def _batch_fetch_details(self, digests: list) -> list:
        """
        Batch-fetch full transaction details for a list of digests.

        Args:
            digests: List of transaction digest strings

        Returns:
            List of full transaction block dicts
        """
        all_txs = []

        for i in range(0, len(digests), self.detail_batch_size):
            batch = digests[i : i + self.detail_batch_size]

            params = [
                batch,
                {
                    "showInput": True,
                    "showEffects": True,
                    "showBalanceChanges": True,
                },
            ]

            result = self.safe_request("sui_multiGetTransactionBlocks", params)

            if isinstance(result, list):
                all_txs.extend(result)
            else:
                log.warning(f"Unexpected result type from multiGet: {type(result)}")

            done = min(i + self.detail_batch_size, len(digests))
            self.update_progress(
                operation="Fetching transaction details",
                current=done,
                total=len(digests),
                log_message=f"Fetched details: {done}/{len(digests)} transactions",
            )

        return all_txs

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

            # Live mode: Two-step fetch
            self.update_progress(
                operation="Collecting transaction digests",
                current=0,
                total=1,
                log_message=f"Collecting digests for {self.wallet_address[:10]}... on SUI",
            )

            # Phase 1: Collect digests from both FromAddress and ToAddress queries
            log.info("Phase 1: Collecting sent transaction digests (FromAddress)...")
            sent_digests = self._collect_digests("FromAddress")
            log.info(f"  Found {len(sent_digests)} sent digests")

            log.info("Phase 1: Collecting received transaction digests (ToAddress)...")
            received_digests = self._collect_digests("ToAddress")
            log.info(f"  Found {len(received_digests)} received digests")

            # Merge and deduplicate
            all_digests = sent_digests | received_digests
            log.info(
                f"  Total unique digests: {len(all_digests)} "
                f"(sent={len(sent_digests)}, received={len(received_digests)}, "
                f"overlap={len(sent_digests & received_digests)})"
            )

            if not all_digests:
                log.info("No transactions found for this wallet")
                self.update_progress(
                    operation="Completed",
                    current=1,
                    total=1,
                    log_message="✅ No transactions found on SUI",
                )
                return

            # Phase 2: Batch-fetch full transaction details
            digest_list = sorted(all_digests)  # Sort for deterministic ordering
            log.info(
                f"Phase 2: Fetching full details for {len(digest_list)} transactions..."
            )

            self.update_progress(
                operation="Fetching transaction details",
                current=0,
                total=len(digest_list),
                log_message=f"Fetching details for {len(digest_list)} transactions",
            )

            transactions = self._batch_fetch_details(digest_list)

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

        Uses suix_getCoinMetadata JSON-RPC call for non-SUI tokens.
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
            result = self.safe_request("suix_getCoinMetadata", [coin_type])

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
            tx: Raw transaction block from sui_multiGetTransactionBlocks

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
                    transaction_type="technical",
                    source_transaction_type=source_tx_type,
                    # Asset and amounts (quantity=0 for fee transaction)
                    source_asset_symbol="SUI",
                    quantity=Decimal(0),
                    # Fee information
                    fee=fee_sui,
                    source_fee_quote_asset_symbol="SUI",
                    include_fee=True,
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
