"""
OKX Withdrawals connector: Fetch withdrawal history and map to standardized format.
Uses CCXT library for API access.
Object-oriented design implementing BaseConnector interface.
"""

from datetime import datetime, timezone
from typing import Dict, Any, List

from backend.connectors.cex.connector_okx_base import OKXBaseConnector
from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction
from backend.core.network_normalizer import normalize_network

log = configure_logging("okx_withdrawals")


# ===== OKX Withdrawals Connector Class =====


class OKXWithdrawalsConnector(OKXBaseConnector):
    """OKX withdrawals connector using CCXT library to fetch withdrawal history."""

    @property
    def connector_name(self) -> str:
        return "okx_withdrawals"

    def _get_logger(self):
        """Return the logger instance for withdrawals."""
        return log

    def _get_transaction_type(self) -> str:
        """Return 'withdrawal' as the transaction type."""
        return "withdrawal"

    def _fetch_transactions(self, code: str, since: int, limit: int, params: Dict) -> List[Dict[str, Any]]:
        """Fetch withdrawals from OKX API."""
        return self.exchange.fetch_withdrawals(code=code, since=since, limit=limit, params=params)

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
            currency = str(info.get("ccy", "")).upper()
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

        from_address = str(raw_item.get("addressFrom", ""))

        txid = str(raw_item.get("txid", ""))
        network = normalize_network(raw_item.get("info").get("chain", ""))

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

        return NormalizedTransaction(
            source="okx-withdrawals",
            account_id=self.account_id,
            source_account=self.connector_name,  # Raw account identifier for mapping
            source_transaction_id=withdrawal_id,
            date_time=dt,
            direction="outflow",
            transaction_type="transfer",
            source_transaction_type="withdrawal",
            source_asset_symbol=currency,
            source_fee_quote_asset_symbol=fee_quote,
            quantity=amount,
            fee=fee,
            source_from_account=self._get_account_identifier(),  # Connector's account identifier
            from_account_id=self.account_id,  # Resolved account ID
            source_to_account=to_address,
            network=network,
            network_transaction_id=txid,
        )

    # Inherits yield_raws from OKXBaseConnector
    # Inherits yield_normalized from BaseConnector
