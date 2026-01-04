"""
Binance Withdrawals connector: Fetch withdrawal history and map to standardized format.
Uses CCXT library for API access.
Object-oriented design implementing BaseConnector interface.
"""

import logging
import ccxt
from datetime import datetime, timezone
from typing import Dict, Any, List

from backend.connectors.base.base_connector import BaseConnector
from backend.config.loader import configure_logging, load_credentials
from backend.db.models import NormalizedTransaction

log = configure_logging("binance_withdrawals")


# ===== Binance Withdrawals Connector Class =====


class BinanceWithdrawalsConnector(BaseConnector):
    """Binance withdrawals connector using CCXT library to fetch withdrawal history."""

    @property
    def connector_name(self) -> str:
        return "binance_withdrawals"

    def __init__(
        self,
        api_key: str = None,
        api_secret: str = None,
        account_id: int = None,
        connector_id: int = None,
        **kwargs,
    ):
        """Initialize Binance withdrawals connector with API credentials from settings.yaml if not provided."""
        super().__init__(account_id=account_id, connector_id=connector_id)

        # In test mode, skip all API configuration
        if self.test_mode:
            return

        # Load credentials from settings.yaml if not provided
        if api_key is None or api_secret is None:
            creds = load_credentials("binance")
            api_key = creds.get("api_key")
            api_secret = creds.get("api_secret")

        self.api_key = api_key
        self.api_secret = api_secret

        # Validate configuration
        if not self.api_key or not self.api_secret:
            raise ValueError("Missing API credentials for Binance")

        # Initialize CCXT exchange
        try:
            self.exchange = ccxt.binance(
                {
                    "apiKey": self.api_key,
                    "secret": self.api_secret,
                    "enableRateLimit": True,
                }
            )
            self.exchange.load_markets()
            log.info("✅ Binance exchange initialized successfully for withdrawals")
        except Exception as e:
            log.error(f"❌ Failed to initialize Binance exchange: {e}")
            raise

    def get_withdrawals(
        self, since: int = None, limit: int = None
    ) -> List[Dict[str, Any]]:
        """
        Fetch withdrawal history from Binance using CCXT.

        Args:
            since (int): Timestamp in milliseconds to fetch withdrawals since
            limit (int): Limit number of withdrawals to fetch

        Returns:
            list: List of withdrawal objects from CCXT or empty list on error
        """
        try:
            withdrawals = self.exchange.fetch_withdrawals(
                code=None, since=since, limit=limit
            )
            log.info(f"✅ Fetched {len(withdrawals)} withdrawals from Binance")
            return withdrawals
        except Exception as e:
            error_str = str(e).lower()
            # Handle common error cases
            if "no withdrawals" in error_str or "empty" in error_str:
                log.debug("ℹ️ No withdrawals found")
            else:
                log.error(f"Error fetching withdrawals: {e}")
            return []

    def raw_to_normalized(self, raw_item: dict) -> "NormalizedTransaction":
        """
        Transform a raw withdrawal to NormalizedTransaction dataclass with status filtering.
        Skips withdrawals that are not in 'ok' status.
        """
        from backend.db.models import NormalizedTransaction

        status = str(raw_item.get("status", "")).lower()
        if status != "ok":
            raise ValueError(f"Withdrawal status is not 'ok': {status}")

        # Extract withdrawal data from CCXT format
        withdrawal_id = str(raw_item.get("id", ""))
        if not withdrawal_id:
            raise ValueError("Missing 'id' field")

        currency = str(raw_item.get("currency", "")).upper()
        if not currency:
            info = raw_item.get("info", {})
            currency = str(info.get("coin", "")).upper()
        if not currency:
            raise ValueError("Missing currency field")

        amount_raw = raw_item.get("amount", 0)
        if isinstance(amount_raw, dict):
            amount = float(amount_raw.get("amount", 0))
        else:
            amount = float(amount_raw) if amount_raw else 0

        if amount <= 0:
            raise ValueError(f"Invalid amount: {amount}")

        to_address_raw = raw_item.get("addressTo")
        if not to_address_raw:
            raise ValueError("Missing destination address")
        to_address = str(to_address_raw)

        from_address = raw_item.get("addressFrom")

        txid = str(raw_item.get("txid", ""))
        network = str(raw_item.get("network", ""))

        # Fee handling
        fee_raw = raw_item.get("fee", 0)
        if isinstance(fee_raw, dict):
            fee = float(fee_raw.get("cost", 0))
            fee_quote = str(fee_raw.get("currency", "")).upper()
        else:
            fee = float(fee_raw) if fee_raw else 0
            fee_quote = currency

        # Timestamp
        timestamp_ms = int(raw_item.get("timestamp", 0))
        dt = (
            datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc)
            if timestamp_ms
            else datetime.now(timezone.utc)
        )
        source_transaction_type = "withdrawal"
        return NormalizedTransaction(
            source="binance-withdrawals",
            account_id=self.account_id,
            source_transaction_id=withdrawal_id,
            date_time=dt,
            direction="outflow",
            transaction_type="transfer",
            source_transaction_type=source_transaction_type,
            source_asset_symbol=currency,
            source_fee_quote_asset_symbol=fee_quote,
            quantity=amount,
            fee=fee,
            source_from_account=from_address,
            source_to_account=to_address,
            network=network,
            network_transaction_id=txid,
        )

    def get_raws(self) -> List[Dict[str, Any]]:
        """
        Fetch all withdrawals from Binance using CCXT.
        Returns:
            list: List of withdrawal objects
        """
        log.info("🔄 Fetching withdrawals from Binance API using CCXT...")
        all_withdrawals = self.get_withdrawals()
        if not all_withdrawals:
            log.warning("⚠️ No withdrawals fetched from Binance")
            return []

        return all_withdrawals

    # Inherits yield_normalized from BaseConnector


def main():
    """Test the Binance withdrawals connector."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    print("\n" + "=" * 60)
    print("Binance Withdrawals Connector Test")
    print("=" * 60 + "\n")

    count_success = 0
    count_error = 0

    try:
        connector = BinanceWithdrawalsConnector()

        for withdrawal_or_error in connector.fetch_and_map_withdrawals():
            if "_error" in withdrawal_or_error:
                count_error += 1
                print(
                    f"❌ [{count_error}] Error: {withdrawal_or_error.get('_error', 'Unknown error')}"
                )
            else:
                count_success += 1
                print(
                    f"✅ [{count_success}] {withdrawal_or_error['asset_code']} x{withdrawal_or_error['qty']}"
                )
                print(f"      From: {withdrawal_or_error['from_address'][:20]}...")
                print(f"      To:   {withdrawal_or_error['to_address'][:20]}...")
                print(
                    f"      Fee:  {withdrawal_or_error['fee']} {withdrawal_or_error['fee_quote']}"
                )
                print(f"      TxID: {withdrawal_or_error['network_tx_id'][:20]}...")
    except Exception as e:
        print(f"\n❌ Test failed with exception: {e}")
        import traceback

        traceback.print_exc()
        return

    print("\n" + "=" * 60)
    print(f"Test Complete: {count_success} successful, {count_error} failed")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    main()
