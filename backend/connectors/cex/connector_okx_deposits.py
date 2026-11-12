"""
OKX Deposits connector: Fetch deposit history and map to standardized format.
Uses CCXT library for API access.
Object-oriented design implementing BaseConnector interface.
"""

from datetime import datetime, timezone
from typing import Dict, Any, List

from backend.connectors.cex.connector_okx_base import OKXBaseConnector
from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction
from backend.core.network_normalizer import normalize_network

log = configure_logging("okx_deposits")


# ===== OKX Deposits Connector Class =====


class OKXDepositsConnector(OKXBaseConnector):
    """OKX deposits connector using CCXT library to fetch deposit history."""

    @property
    def connector_name(self) -> str:
        return "okx_deposits"

    def _get_logger(self):
        """Return the logger instance for deposits."""
        return log

    def _get_transaction_type(self) -> str:
        """Return 'deposit' as the transaction type."""
        return "deposit"

    def _fetch_transactions(self, code: str, since: int, limit: int, params: Dict) -> List[Dict[str, Any]]:
        """Fetch deposits from OKX API."""
        return self.exchange.fetch_deposits(code=code, since=since, limit=limit, params=params)

    def raw_to_normalized(self, raw_item: dict) -> "NormalizedTransaction":
        """
        Transform a raw deposit to NormalizedTransaction dataclass with status filtering.
        Skips deposits that are not in 'ok' status.
        """
        from backend.db.models import NormalizedTransaction

        if not self.is_settled_transfer(raw_item, "Deposit"):
            return None

        # Extract deposit data from CCXT format
        deposit_id = str(raw_item.get("id", ""))
        if not deposit_id:
            raise ValueError("Missing 'id' field")

        currency = str(raw_item.get("currency", "")).upper()
        if not currency:
            raise ValueError("Missing 'currency' field")

        amount = raw_item.get("amount")
        if amount is None:
            raise ValueError("Missing or invalid 'amount' field")
        amount = float(amount)

        txid = str(raw_item.get("txid", ""))
        network = normalize_network(raw_item.get("info").get("chain", ""))
        to_address = str(raw_item.get("addressTo", ""))
        from_address = str(raw_item.get("addressFrom", ""))

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
            source="okx-deposits",
            account_id=self.account_id,
            source_account=self.connector_name,  # Raw account identifier for mapping
            source_transaction_id=deposit_id,
            date_time=dt,
            direction="inflow",
            source_transaction_type="deposit",
            transaction_type="transfer",
            source_asset_symbol=currency,
            quantity=amount,
            fee=fee,
            source_fee_quote_asset_symbol=fee_quote,
            include_fee=False,  # Deposit fees deducted before receipt; quantity is net
            source_from_account=from_address,
            source_to_account=to_address if to_address and to_address != "None" else self._get_account_identifier(),
            to_account_id=self.account_id,  # Resolved account ID
            network=network,
            network_transaction_id=txid,
        )

    # Inherits yield_raws from OKXBaseConnector
    # Inherits yield_normalized from BaseConnector
