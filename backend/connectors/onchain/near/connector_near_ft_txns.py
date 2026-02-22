"""
NEAR connector for fungible token (NEP-141) transfers.
Uses NearBlocks API v1 endpoint: /account/{account}/ft-txns
"""

import json
import os
from decimal import Decimal
from typing import Dict, Any, Generator

from backend.connectors.onchain.near.base_near_connector import (
    NearConnectorBase,
    NEAR_DIVISOR,
)
from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction

log = configure_logging("near_ft_txns")


class ConnectorNearFtTxns(NearConnectorBase):
    """NearBlocks API connector for fungible token (NEP-141) transfers."""

    @property
    def connector_name(self) -> str:
        return "near_ft_txns"

    def __init__(
        self,
        wallet_address: str = "",
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        **kwargs,
    ):
        """
        Initialize NearBlocks FT transfers connector.

        Args:
            wallet_address: The NEAR wallet address to scan
            account_id: Optional account ID for database linking
            connector_id: Optional connector ID for database linking
            config: Optional connector configuration dict
        """
        super().__init__(
            wallet_address=wallet_address,
            account_id=account_id,
            connector_id=connector_id,
            config=config,
        )

        # FT metadata cache: contract_address -> {"symbol": ..., "decimals": ...}
        self._ft_cache: Dict[str, Dict[str, Any]] = {}

    def _get_default_test_file(self) -> str:
        """Get the default test fixture file path."""
        connector_dir = os.path.dirname(__file__)
        return os.path.join(
            connector_dir, "..", "..", "..", "tests", "fixtures", "near", "near_ft_txns.json"
        )

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """Fetch and yield raw FT transfer events with cursor-based pagination."""
        try:
            # Test mode: Load from fixture file
            if self.test_mode:
                test_file = self.config.get("test_file_path") or self._get_default_test_file()
                log.info(f"🧪 [TEST MODE] Loading test data from {test_file}")

                if not os.path.exists(test_file):
                    log.warning(f"Test file not found: {test_file}")
                    return

                with open(test_file, "r") as f:
                    data = json.load(f)

                items = data if isinstance(data, list) else data.get("txns", data.get("transactions", []))
                for item in items:
                    yield item

                log.info(f"🧪 [TEST MODE] Loaded {len(items)} test transactions")
                return

            self.update_progress(
                operation="Fetching NEAR FT transfers",
                current=0,
                total=1,
                log_message=f"Fetching FT transfers for {self.wallet_address[:20]}...",
            )

            endpoint = f"/account/{self.wallet_address}/ft-txns"
            cursor = None
            total_items = 0
            page = 0

            while True:
                page += 1
                params = {
                    "per_page": self.per_page,
                    "order": "asc",
                }
                if cursor:
                    params["cursor"] = cursor

                result = self.safe_request(endpoint, params)

                items = result.get("txns", [])
                if not isinstance(items, list) or not items:
                    break

                for item in items:
                    total_items += 1
                    yield item

                log.info(
                    f"   Page {page}: yielded {len(items)} FT transfers"
                )

                # Cursor-based pagination
                cursor = result.get("cursor")
                if not cursor:
                    if len(items) < self.per_page:
                        break
                    break

            log.info(f"   ✅ Found {total_items} FT transfers on NEAR")

            self.update_progress(
                operation="Completed",
                current=1,
                total=1,
                log_message=f"✅ Found {total_items} FT transfers on NEAR",
            )
        except Exception as e:
            log.error(f"   ⚠️ Error fetching NEAR FT transfers: {e}")
            self.update_progress(
                operation="Failed",
                current=1,
                total=1,
                log_message=f"❌ Error: {str(e)[:100]}",
            )
            raise

    def _get_ft_metadata(self, ft_info: Dict) -> Dict[str, Any]:
        """
        Extract FT metadata from the inline `ft` object in NearBlocks response.
        Caches by contract address.

        Args:
            ft_info: The `ft` object from the API response

        Returns:
            Dict with 'symbol', 'decimals', 'contract' keys
        """
        contract = ft_info.get("contract", "")

        if contract in self._ft_cache:
            return self._ft_cache[contract]

        symbol = (ft_info.get("symbol") or "UNKNOWN").upper()
        decimals = int(ft_info.get("decimals") or 0)

        result = {
            "symbol": symbol,
            "decimals": decimals,
            "contract": contract,
        }
        self._ft_cache[contract] = result
        return result

    def raw_to_normalized(
        self, tx: Dict
    ) -> Generator[NormalizedTransaction, None, None]:
        """
        Map raw NearBlocks FT transfer event to standardized format.

        Each FT transfer event yields one NormalizedTransaction.

        NearBlocks ft-txns response shape:
        {
            "event_index": "...",
            "affected_account_id": "wallet.near",
            "involved_account_id": "counterparty.near",
            "delta_amount": "1000000000000000000",
            "cause": "TRANSFER",
            "transaction_hash": "...",
            "block_timestamp": "1760471790453709387",
            "block": {"block_height": ...},
            "outcomes": {"status": true},
            "outcomes_agg": {"transaction_fee": ...},
            "ft": {"contract": "...", "symbol": "...", "decimals": 18, ...}
        }

        The `affected_account_id` is always the wallet address.
        - Positive `delta_amount` → inflow (wallet received tokens)
        - Negative `delta_amount` → outflow (wallet sent tokens)
        The `involved_account_id` is the counterparty.

        Args:
            tx: Raw FT transfer event from NearBlocks API

        Yields:
            NormalizedTransaction: Standardized transaction object
        """
        try:
            tx_hash = tx.get("transaction_hash")
            if not tx_hash:
                log.warning(f"Missing transaction_hash in FT transfer: {tx}")
                return

            # Skip failed transactions
            outcomes = tx.get("outcomes", {})
            if not outcomes.get("status", True):
                log.debug(f"Skipping failed FT transfer {tx_hash}")
                return

            # Parse timestamp
            block_timestamp = tx.get("block_timestamp", "")
            date_time = self.parse_block_timestamp(block_timestamp)

            # Get event index for unique source_transaction_id
            event_index = tx.get("event_index", "0")

            # Determine direction from delta_amount sign
            delta_raw = tx.get("delta_amount", "0")
            try:
                delta = Decimal(str(delta_raw))
            except Exception:
                delta = Decimal(0)

            if delta == 0:
                return

            # Affected account is always the wallet; involved is the counterparty
            affected = tx.get("affected_account_id", "")
            involved = tx.get("involved_account_id", "")

            if delta > 0:
                direction = "inflow"
                from_account = involved
                to_account = affected
            else:
                direction = "outflow"
                from_account = affected
                to_account = involved
                delta = abs(delta)

            # Get token metadata
            ft_info = tx.get("ft", {})
            ft_meta = self._get_ft_metadata(ft_info)
            symbol = ft_meta["symbol"]
            decimals = ft_meta["decimals"]
            contract = ft_meta["contract"]

            # Convert raw amount using token decimals
            if decimals > 0:
                amount = delta / Decimal(10**decimals)
            else:
                amount = delta

            # Parse fee (the wallet may or may not have paid it)
            outcomes_agg = tx.get("outcomes_agg", {})
            fee_yocto = outcomes_agg.get("transaction_fee", 0)
            try:
                fee_near = Decimal(str(fee_yocto)) / Decimal(NEAR_DIVISOR)
            except Exception:
                fee_near = Decimal(0)

            source_tx_id = f"{tx_hash}_ft_{event_index}"

            yield NormalizedTransaction(
                # Source identification
                source=self.connector_name,
                account_id=self.account_id,
                source_account=self.wallet_address,
                source_transaction_id=source_tx_id,
                network_transaction_id=tx_hash,
                # Core transaction data
                date_time=date_time,
                direction=direction,
                transaction_type="transfer",
                source_transaction_type=tx.get("cause", "TRANSFER"),
                # Asset and amounts
                source_asset_symbol=symbol,
                quantity=amount,
                # Fee — only include if wallet paid it (outflow direction)
                fee=fee_near if direction == "outflow" else Decimal(0),
                source_fee_quote_asset_symbol=self.native_token,
                include_fee=True if direction == "outflow" else False,
                # Addresses
                source_from_account=from_account,
                source_to_account=to_account,
                network="near",
                token_contract_address=contract,
            )

        except Exception as e:
            log.error(
                f"Error normalizing FT transfer "
                f"{tx.get('transaction_hash', 'unknown')}: {e}"
            )
            raise
