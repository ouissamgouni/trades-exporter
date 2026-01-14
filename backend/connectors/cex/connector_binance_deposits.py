"""
Binance Deposits connector: Fetch deposit history and map to standardized format.
Uses CCXT library for API access.
Object-oriented design implementing BaseConnector interface.
"""

import ccxt
from datetime import datetime, timezone
from typing import Dict, Any, List

from backend.connectors.base.base_connector import BaseConnector
from backend.config.loader import configure_logging, load_credentials
from backend.db.models import NormalizedTransaction

log = configure_logging("binance_deposits")


# ===== Binance Deposits Connector Class =====


class ConnectorBinanceDeposits(BaseConnector):
    """Binance deposits connector using CCXT library to fetch deposit history."""

    @property
    def connector_name(self) -> str:
        return "binance_deposits"

    def __init__(
        self,
        api_key: str = None,
        api_secret: str = None,
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        **kwargs,
    ):
        """Initialize Binance deposits connector with API credentials from settings.yaml if not provided."""
        super().__init__(account_id=account_id, connector_id=connector_id, config=config)

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
            log.info("✅ Binance exchange initialized successfully for deposits")
        except Exception as e:
            log.error(f"❌ Failed to initialize Binance exchange: {e}")
            raise

    def get_deposits(
        self, since: int = None, limit: int = None
    ) -> List[Dict[str, Any]]:
        """
        Fetch deposit history from Binance using CCXT.

        Args:
            since (int): Timestamp in milliseconds to fetch deposits since
            limit (int): Limit number of deposits to fetch

        Returns:
            list: List of deposit objects from CCXT or empty list on error
        """
        try:
            deposits = self.exchange.fetch_deposits(code=None, since=since, limit=limit)
            log.info(f"✅ Fetched {len(deposits)} deposits from Binance")
            return deposits
        except Exception as e:
            error_str = str(e).lower()
            # Handle common error cases
            if "no deposits" in error_str or "empty" in error_str:
                log.debug("ℹ️ No deposits found")
            else:
                log.error(f"Error fetching deposits: {e}")
            return []

    def raw_to_normalized(self, raw_item: dict) -> "NormalizedTransaction":
        """
        Transform a raw deposit to NormalizedTransaction dataclass with status filtering.
        Skips deposits that are not in 'ok' status.
        """
        from backend.db.models import NormalizedTransaction

        status = str(raw_item.get("status", "")).lower()
        if status != "ok":
            raise ValueError(f"Deposit status is not 'ok': {status}")

        # Extract deposit data from CCXT format
        deposit_id = str(raw_item.get("id", ""))
        if not deposit_id:
            raise ValueError("Missing 'id' field")

        currency = str(raw_item.get("currency", "")).upper()
        if not currency:
            raise ValueError("Missing 'currency' field")

        amount = float(raw_item.get("amount", 0))
        if amount is None:
            raise ValueError("Missing or invalid 'amount' field")

        txid = str(raw_item.get("txid", ""))
        network = str(raw_item.get("network", "")).lower()
        to_address = str(raw_item.get("addressTo"))
        from_address = str(raw_item.get("addressFrom"))

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
            source="binance-deposits",
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
            source_from_account=from_address,
            source_to_account=to_address,
            network=network,
            network_transaction_id=txid,
        )

    def get_raws(self) -> List[Dict[str, Any]]:
        """
        Fetch all deposits from Binance using CCXT.
        Uses since_timestamp_ms from base class for incremental sync.
        Returns:
            list: List of deposit objects
        """
        log.info("🔄 Fetching deposits from Binance API using CCXT...")
        all_deposits = self.get_deposits(since=self.since_timestamp_ms)
        if not all_deposits:
            log.warning("⚠️ No deposits fetched from Binance")
            return []
        return all_deposits

    # Inherits yield_normalized from BaseConnector
