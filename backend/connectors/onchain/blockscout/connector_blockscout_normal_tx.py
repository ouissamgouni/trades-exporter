"""
Blockscout connector for normal transactions: Fetch blockchain normal transactions for a wallet address.
Uses Blockscout API v2. Supports multiple networks.
"""

from decimal import Decimal
from typing import Dict, Any, List

from backend.connectors.onchain.blockscout.base_blockscout_connector import (
    BlockscoutConnectorBase,
)
from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction

log = configure_logging("blockscout_normal_tx")


class ConnectorBlockscoutNormalTx(BlockscoutConnectorBase):
    """Blockscout API connector for normal transactions."""

    @property
    def connector_name(self) -> str:
        return f"blockscout_normal_tx_{self.chain_name}"

    def __init__(
        self,
        wallet_address: str = "",
        chain_name: str = "base",
        account_id: int = None,
        connector_id: int = None,
        **kwargs,
    ):
        """
        Initialize Blockscout API connector for normal transactions.

        Args:
            wallet_address: The wallet address to scan
            chain_name: Chain identifier (e.g., "base", "ethereum", "arbitrum")
            account_id: Optional account ID for database linking
            connector_id: Optional connector ID for database linking
            **kwargs: Additional configuration parameters
        """
        super().__init__(
            wallet_address=wallet_address,
            chain_name=chain_name,
            account_id=account_id,
            connector_id=connector_id,
        )

    def get_raws(self) -> List[Dict[str, Any]]:
        """Get raw normal transactions without mapping (for JSON logging)."""
        try:
            # Blockscout API v2 transactions endpoint
            result = self.safe_request(f"/addresses/{self.wallet_address}/transactions")

            # Blockscout returns {"items": [...], "next_page_params": ...}
            items = result.get("items", [])
            if not isinstance(items, list):
                log.warning(f"Unexpected transactions format: {type(items)}")
                return []

            log.info(
                f"   ✅ Found {len(items)} normal transactions on {self.chain_name}"
            )
            return items
        except Exception as e:
            log.error(f"   ⚠️ Error fetching normal transactions: {e}")
            raise

    def raw_to_normalized(self, tx: Dict) -> NormalizedTransaction:
        """
        Map raw Blockscout API transaction to standardized format for normal transactions.

        Args:
            tx: Raw normal transaction from Blockscout API v2

        Returns:
            NormalizedTransaction: Standardized transaction object
        """
        try:
            # Blockscout API v2 format
            tx_hash = tx.get("hash")
            if not tx_hash:
                raise ValueError(f"Cannot determine transaction hash from '{tx}'")
            token_decimal = 18

            # Transaction details - handle both dict and string formats
            tx_from = (
                tx.get("from", {}).get("hash", "")
                if isinstance(tx.get("from"), dict)
                else tx.get("from", "")
            )
            if not tx_from:
                raise ValueError(f"Cannot determine 'from' in '{tx}")

            tx_to = (
                tx.get("to", {}).get("hash", "")
                if isinstance(tx.get("to"), dict)
                else tx.get("to", "")
            )
            if not tx_to:
                raise ValueError(f"Cannot determine 'to' in '{tx}")

            value_raw = int(tx.get("value", 0))
            gas_used = int(tx.get("gas_used", 0))
            gas_price = int(tx.get("gas_price", 0))

            # Calculate amounts
            value = Decimal(value_raw) / Decimal(10**token_decimal)
            fee_wei = gas_used * gas_price
            fee = Decimal(fee_wei) / Decimal(10**18)

            # Parse timestamp
            dt = self.parse_timestamp(tx.get("timestamp", ""))

            # Determine direction
            direction, to_addr = self.determine_direction(tx_from, tx_to)

            # Build tags
            tags = {}

            return NormalizedTransaction(
                source=f"blockscout_{self.chain_name.lower()}_normal_tx",
                account_id=self.account_id,
                source_transaction_id=tx_hash,
                date_time=dt,
                direction=direction,
                transaction_type="technical" if value == 0 else None,
                source_transaction_type="normal-tx",
                source_asset_symbol=self.native_token,
                quantity=float(value),
                fee=float(fee),
                source_fee_quote_asset_symbol=self.native_token,
                include_fee=True if direction == "outflow" else False,
                source_from_account=tx_from,
                source_to_account=to_addr,
                network=self.chain_name.lower(),
                tags=tags,
            )
        except Exception as e:
            log.error(f"   ⚠️ Error mapping normal transaction: {e}")
            raise
