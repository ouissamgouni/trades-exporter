"""
Blockscout connector for token transfers: Fetch blockchain token transfers for a wallet address.
Uses Blockscout API v2. Supports multiple networks.
"""

from decimal import Decimal
from typing import Dict, Any, List

from backend.connectors.onchain.blockscout.base_blockscout_connector import (
    BlockscoutConnectorBase,
)
from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction

log = configure_logging("blockscout_token_transfers")


class ConnectorBlockscoutTokenTransfers(BlockscoutConnectorBase):
    """Blockscout API connector for token transfers."""

    @property
    def connector_name(self) -> str:
        return f"blockscout_token_transfers_{self.chain_name}"

    def __init__(
        self,
        wallet_address: str = "",
        chain_name: str = "base",
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        **kwargs,
    ):
        """
        Initialize Blockscout API connector for token transfers.

        Args:
            wallet_address: The wallet address to scan
            chain_name: Chain identifier (e.g., "base", "ethereum", "arbitrum")
            account_id: Optional account ID for database linking
            connector_id: Optional connector ID for database linking
            config: Optional connector configuration dict
            **kwargs: Additional configuration parameters
        """
        super().__init__(
            wallet_address=wallet_address,
            chain_name=chain_name,
            account_id=account_id,
            connector_id=connector_id,
            config=config,
        )

    def get_raws(self) -> List[Dict[str, Any]]:
        """Get raw token transfers without mapping (for JSON logging)."""
        try:
            self.update_progress(
                operation="Fetching token transfers",
                current=0,
                total=1,
                log_message=f"Fetching token transfers for {self.wallet_address[:10]}..."
            )
            
            # Blockscout API v2 token transfers endpoint
            result = self.safe_request(
                f"/addresses/{self.wallet_address}/token-transfers"
            )

            # Blockscout returns {"items": [...], "next_page_params": ...}
            items = result.get("items", [])
            if not isinstance(items, list):
                log.warning(f"Unexpected token transfers format: {type(items)}")
                return []

            log.info(f"   ✅ Found {len(items)} token transfers on {self.chain_name}")
            
            self.update_progress(
                operation="Completed",
                current=1,
                total=1,
                log_message=f"✅ Found {len(items)} token transfers on {self.chain_name}"
            )
            
            return items
        except Exception as e:
            log.error(f"   ⚠️ Error fetching token transfers: {e}")
            self.update_progress(
                operation="Failed",
                current=1,
                total=1,
                log_message=f"❌ Error: {str(e)[:100]}"
            )
            raise

    def raw_to_normalized(self, tx: Dict) -> NormalizedTransaction:
        """
        Map raw Blockscout API transaction to standardized format for token transfers.

        Args:
            tx: Raw token transfer from Blockscout API v2

        Returns:
            NormalizedTransaction: Standardized transaction object
        """
        try:
            # Blockscout API v2 format - token transfers use 'transaction_hash' not 'hash'
            tx_hash = tx.get("transaction_hash") or tx.get("hash")
            tx_log_index = tx.get("log_index", "")

            # Token transfer structure
            token_info = tx.get("token")
            token_symbol = token_info.get("symbol").upper()
            token_name = token_info.get("name")
            contract_address = token_info.get("address_hash")
            token_decimal = int(token_info.get("decimals", 18))

            # Transfer details
            tx_from = tx.get("from", {}).get("hash", "")
            tx_to = tx.get("to", {}).get("hash", "")
            value_raw = int(tx.get("total", {}).get("value", 0))

            # Fee calculation
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
            tags = {
                "contract_address": contract_address,
                "token_symbol": token_symbol,
                "token_name": token_name,
            }

            return NormalizedTransaction(
                source=f"blockscout_token_transfers_{self.chain_name.lower()}",
                account_id=self.account_id,
                source_account=self.wallet_address,  # Raw account identifier for mapping
                source_transaction_id=f"{tx_hash}_{tx_log_index}",
                date_time=dt,
                direction=direction,
                transaction_type="transfer",
                source_transaction_type="token-transfer",
                source_asset_symbol=f"{token_symbol}_{contract_address}",
                quantity=float(value),
                fee=float(fee),
                source_fee_quote_asset_symbol=self.native_token,
                include_fee=True if direction == "outflow" else False,
                source_from_account=tx_from,
                source_to_account=to_addr,
                network=self.chain_name.lower(),
                token_contract_address=contract_address,
                tags=tags,
            )
        except Exception as e:
            log.error(f"   ⚠️ Error mapping token transfer: {e}")
            raise
