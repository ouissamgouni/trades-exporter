"""
NEAR connector for native transactions: Fetch native NEAR transfers for a wallet address.
Uses NearBlocks API v1 endpoint: /account/{account}/txns-only
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
from backend.core.network_normalizer import normalize_network
from backend.db.models import NormalizedTransaction

log = configure_logging("near_txns")


class ConnectorNearTxns(NearConnectorBase):
    """NearBlocks API connector for native NEAR transactions."""

    @property
    def connector_name(self) -> str:
        return "near_txns"

    def __init__(
        self,
        wallet_address: str = "",
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        **kwargs,
    ):
        """
        Initialize NearBlocks native transactions connector.

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

    def _get_default_test_file(self) -> str:
        """Get the default test fixture file path."""
        connector_dir = os.path.dirname(__file__)
        return os.path.join(
            connector_dir, "..", "..", "..", "tests", "fixtures", "near", "near_txns.json"
        )

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """Fetch and yield raw native transactions with cursor-based pagination."""
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
                operation="Fetching NEAR transactions",
                current=0,
                total=1,
                log_message=f"Fetching native transactions for {self.wallet_address[:20]}...",
            )

            endpoint = f"/account/{self.wallet_address}/txns-only"
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
                    f"   Page {page}: yielded {len(items)} native transactions"
                )

                # Cursor-based pagination: use cursor from last item
                cursor = result.get("cursor")
                if not cursor:
                    # If no cursor returned, check if we got a full page
                    if len(items) < self.per_page:
                        break
                    # Fall back: no more pages
                    break

            log.info(f"   ✅ Found {total_items} native transactions on NEAR")

            self.update_progress(
                operation="Completed",
                current=1,
                total=1,
                log_message=f"✅ Found {total_items} native transactions on NEAR",
            )
        except Exception as e:
            log.error(f"   ⚠️ Error fetching NEAR native transactions: {e}")
            self.update_progress(
                operation="Failed",
                current=1,
                total=1,
                log_message=f"❌ Error: {str(e)[:100]}",
            )
            raise

    def raw_to_normalized(
        self, tx: Dict
    ) -> Generator[NormalizedTransaction, None, None]:
        """
        Map raw NearBlocks native transaction to standardized format.

        Each transaction may contain multiple TRANSFER actions — each yields
        a NormalizedTransaction. A dedicated fee transaction is also yielded
        when the wallet is the signer (paid the fee).

        Args:
            tx: Raw transaction from NearBlocks API

        Yields:
            NormalizedTransaction: One or more standardized transaction objects
        """
        try:
            tx_hash = tx.get("transaction_hash")
            if not tx_hash:
                log.warning(f"Missing transaction_hash in transaction: {tx}")
                return

            # Skip failed transactions
            outcomes = tx.get("outcomes", {})
            if not outcomes.get("status", True):
                log.debug(f"Skipping failed transaction {tx_hash}")
                return

            # Parse timestamp
            block_timestamp = tx.get("block_timestamp", "")
            date_time = self.parse_block_timestamp(block_timestamp)

            # Determine sender/receiver
            signer = tx.get("signer_account_id", "")
            receiver = tx.get("receiver_account_id", "")
            direction = self.determine_direction(signer, receiver)

            # Determine if wallet paid the fee
            wallet_paid_fee = signer.lower() == self.wallet_address.lower()

            # Parse fee from outcomes_agg (in yoctoNEAR)
            outcomes_agg = tx.get("outcomes_agg", {})
            fee_yocto = outcomes_agg.get("transaction_fee", 0)
            try:
                fee_near = Decimal(str(fee_yocto)) / Decimal(NEAR_DIVISOR)
            except Exception:
                fee_near = Decimal(0)

            # Process actions — each TRANSFER action becomes a NormalizedTransaction
            actions = tx.get("actions", [])
            transfer_count = 0

            for idx, action in enumerate(actions):
                action_type = action.get("action", "")

                if action_type == "TRANSFER":
                    deposit_raw = action.get("deposit", 0)
                    try:
                        amount = Decimal(str(deposit_raw)) / Decimal(NEAR_DIVISOR)
                    except Exception:
                        amount = Decimal(0)

                    if amount <= 0:
                        continue

                    transfer_count += 1
                    source_tx_id = f"{tx_hash}_transfer_{idx}"

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
                        source_transaction_type=action_type,
                        # Asset and amounts
                        source_asset_symbol=self.native_token,
                        quantity=amount,
                        # No fee on individual transfers
                        fee=Decimal(0),
                        source_fee_quote_asset_symbol=self.native_token,
                        include_fee=False,
                        # Addresses
                        source_from_account=signer,
                        source_to_account=receiver,
                        network=normalize_network("near"),
                        token_contract_address=None,
                    )

            # If no TRANSFER actions found but there's a deposit in actions_agg,
            # treat the whole tx as a single transfer
            if transfer_count == 0:
                actions_agg = tx.get("actions_agg", {})
                deposit_raw = actions_agg.get("deposit", 0)
                try:
                    amount = Decimal(str(deposit_raw)) / Decimal(NEAR_DIVISOR)
                except Exception:
                    amount = Decimal(0)

                if amount > 0:
                    yield NormalizedTransaction(
                        source=self.connector_name,
                        account_id=self.account_id,
                        source_account=self.wallet_address,
                        source_transaction_id=f"{tx_hash}_transfer_agg",
                        network_transaction_id=tx_hash,
                        date_time=date_time,
                        direction=direction,
                        transaction_type="transfer",
                        source_transaction_type="TRANSFER",
                        source_asset_symbol=self.native_token,
                        quantity=amount,
                        fee=Decimal(0),
                        source_fee_quote_asset_symbol=self.native_token,
                        include_fee=False,
                        source_from_account=signer,
                        source_to_account=receiver,
                        network=normalize_network("near"),
                        token_contract_address=None,
                    )

            # Dedicated fee transaction if wallet is signer
            if wallet_paid_fee and fee_near > 0:
                yield NormalizedTransaction(
                    source=self.connector_name,
                    account_id=self.account_id,
                    source_account=self.wallet_address,
                    source_transaction_id=f"{tx_hash}_fee",
                    network_transaction_id=tx_hash,
                    date_time=date_time,
                    direction="outflow",
                    transaction_type="cost",
                    source_transaction_type="FEE",
                    source_asset_symbol=self.native_token,
                    quantity=Decimal(0),
                    fee=fee_near,
                    source_fee_quote_asset_symbol=self.native_token,
                    include_fee=True,
                    source_from_account=signer,
                    source_to_account=None,
                    network=normalize_network("near"),
                    token_contract_address=None,
                )

        except Exception as e:
            log.error(
                f"Error normalizing transaction "
                f"{tx.get('transaction_hash', 'unknown')}: {e}"
            )
            raise
