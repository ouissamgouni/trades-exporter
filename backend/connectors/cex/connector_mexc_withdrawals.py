"""
MEXC Withdrawals connector: Fetch withdrawal history and map to standardized format.
Uses CCXT library for API access.
Object-oriented design implementing BaseConnector interface.
"""

import logging
from datetime import datetime, timezone
from typing import Dict, Any, List

from backend.connectors.cex.connector_mexc_base import MEXCBaseConnector
from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction

log = configure_logging("mexc_withdrawals")


# ===== MEXC Withdrawals Connector Class =====


class MEXCWithdrawalsConnector(MEXCBaseConnector):
    """MEXC withdrawals connector using CCXT library to fetch withdrawal history."""

    @property
    def connector_name(self) -> str:
        return "mexc_withdrawals"

    def _get_logger(self):
        """Return the logger instance for withdrawals."""
        return log

    def _get_transaction_type(self) -> str:
        """Return 'withdrawal' as the transaction type."""
        return "withdrawal"

    def _fetch_transactions(self, code: str, since: int, limit: int, params: Dict) -> List[Dict[str, Any]]:
        """Fetch withdrawals from MEXC API."""
        return self.exchange.fetch_withdrawals(code=code, since=since, limit=limit, params=params)

    # Backward compatibility alias
    def get_withdrawals(self, currency: str, since: int = None, limit: int = None) -> List[Dict[str, Any]]:
        """Alias for fetch_with_7day_windows for backward compatibility."""
        return self.fetch_with_7day_windows(currency, since, limit)

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
            source="mexc-withdrawals",
            account_id=self.account_id,
            source_account=self.connector_name,  # Raw account identifier for mapping
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

    # Inherits get_raws from MEXCBaseConnector
    # Inherits yield_normalized from BaseConnector


def main():
    """Test the MEXC withdrawals connector."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    print("\n" + "=" * 60)
    print("MEXC Withdrawals Connector Test")
    print("=" * 60 + "\n")

    count_success = 0
    count_error = 0

    try:
        currencies=["USDT", "USDC", "PLAY"]
        #currencies=None
        connector = MEXCWithdrawalsConnector(currencies=currencies)
        #b = connector.exchange.fetch_balance()
        #log.info(f"Fetched balance: {b}")
        for raw_item, normalized_item, error  in connector.yield_normalized():
            if error:
                count_error += 1
                print(f"❌ Error: {error}")
            else:
                count_success += 1
                print(f"✅ Success: {normalized_item.source_transaction_id} | {normalized_item.source_asset_symbol} x{normalized_item.quantity}")
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
