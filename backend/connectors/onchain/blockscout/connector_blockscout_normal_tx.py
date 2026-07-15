"""
Blockscout connector for normal transactions: Fetch blockchain normal transactions for a wallet address.
Uses Blockscout API v2. Supports multiple networks.
"""

from decimal import Decimal
from typing import Dict, Any, Generator

from backend.connectors.onchain.blockscout.base_blockscout_connector import (
    BlockscoutConnectorBase,
)
from backend.config.loader import configure_logging
from backend.core.network_normalizer import normalize_network
from backend.core.spam_detection import detect_blockscout_phishing, apply_spam_markers
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
        config: Dict[str, Any] = None,
        **kwargs,
    ):
        """
        Initialize Blockscout API connector for normal transactions.

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

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """Fetch and yield raw normal transactions with pagination support."""
        try:
            self.update_progress(
                operation="Fetching normal transactions",
                current=0,
                total=1,
                log_message=f"Fetching normal transactions for {self.wallet_address[:10]}..."
            )
            
            # Blockscout API v2 transactions endpoint with pagination
            next_page_params = None
            total_items = 0
            page = 0
            
            while True:
                page += 1
                endpoint = f"/addresses/{self.wallet_address}/transactions"
                params = next_page_params if next_page_params else {}
                
                result = self.safe_request(endpoint, params)

                # Blockscout returns {"items": [...], "next_page_params": ...}
                items = result.get("items", [])
                if not isinstance(items, list):
                    log.warning(f"Unexpected transactions format: {type(items)}")
                    break
                
                # Yield items from this page immediately
                for item in items:
                    total_items += 1
                    yield item
                
                log.info(f"   Page {page}: yielded {len(items)} normal transactions")
                
                # Check for more pages
                next_page_params = result.get("next_page_params")
                if not next_page_params:
                    break

            log.info(
                f"   ✅ Found {total_items} normal transactions on {self.chain_name}"
            )
            
            self.update_progress(
                operation="Completed",
                current=1,
                total=1,
                log_message=f"✅ Found {total_items} normal transactions on {self.chain_name}"
            )
        except Exception as e:
            log.error(f"   ⚠️ Error fetching normal transactions: {e}")
            self.update_progress(
                operation="Failed",
                current=1,
                total=1,
                log_message=f"❌ Error: {str(e)[:100]}"
            )
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

            value_raw = int(tx.get("value") or 0)
            gas_used = int(tx.get("gas_used") or 0)
            gas_price = int(tx.get("gas_price") or 0)

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

            is_cost = value == 0

            if is_cost:
                # COST: fee-only transaction — qty=fee, price=1, price_quote=native_token
                normalized = NormalizedTransaction(
                    source=f"blockscout_{self.chain_name.lower()}_normal_tx",
                    account_id=self.account_id,
                    source_account=self.wallet_address,
                    source_transaction_id=tx_hash,
                    network_transaction_id=tx_hash,
                    date_time=dt,
                    direction="outflow",
                    transaction_type="cost",
                    source_transaction_type="normal-tx",
                    source_asset_symbol=self.native_token,
                    quantity=float(fee),
                    price=1.0,
                    source_price_quote_asset_symbol=self.native_token,
                    include_fee=False,
                    source_from_account=tx_from,
                    source_to_account=to_addr,
                    network=normalize_network(self.chain_name),
                    tags=tags,
                )
            else:
                # TRANSFER: normal transfer with optional embedded fee
                normalized = NormalizedTransaction(
                    source=f"blockscout_{self.chain_name.lower()}_normal_tx",
                    account_id=self.account_id,
                    source_account=self.wallet_address,
                    source_transaction_id=tx_hash,
                    network_transaction_id=tx_hash,
                    date_time=dt,
                    direction=direction,
                    transaction_type="transfer",
                    source_transaction_type="normal-tx",
                    source_asset_symbol=self.native_token,
                    quantity=float(value),
                    fee=float(fee),
                    source_fee_quote_asset_symbol=self.native_token,
                    include_fee=True if direction == "outflow" else False,
                    source_from_account=tx_from,
                    source_to_account=to_addr,
                    network=normalize_network(self.chain_name),
                    tags=tags,
                )

            # Phishing / spam detection
            spam_reasons = detect_blockscout_phishing(tx)
            if spam_reasons:
                apply_spam_markers(
                    normalized,
                    reasons=spam_reasons,
                    tags=tags,
                    tx_id=tx_hash,
                )

            return normalized
        except Exception as e:
            log.error(f"   ⚠️ Error mapping normal transaction: {e}")
            raise
