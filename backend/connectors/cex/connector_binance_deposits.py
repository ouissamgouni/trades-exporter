"""
Binance Deposits connector: Fetch deposit history and map to standardized format.
Uses CCXT library for API access.
Object-oriented design implementing BaseConnector interface.
"""

import ccxt
import requests
from datetime import datetime, timezone
from requests.adapters import HTTPAdapter
from typing import Dict, Any, Generator, List
from urllib3.util.retry import Retry

from backend.connectors.base.base_connector import BaseConnector
from backend.connectors.base.connector_exceptions import (
    ConnectorAPIError,
    ErrorReason,
)
from backend.config.loader import configure_logging, load_credentials
from backend.db.models import NormalizedTransaction
from backend.core.network_normalizer import normalize_network

log = configure_logging("binance_deposits")

# Maximum concurrent connections for connection pooling
MAX_WORKERS = 10


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

        # In test/renormalize mode, skip all API configuration
        if self.test_mode or self.renormalize_mode:
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

        # Initialize CCXT exchange with connection pooling
        try:
            # Create a requests session with connection pooling and retry
            session = requests.Session()
            adapter = HTTPAdapter(
                pool_connections=MAX_WORKERS,
                pool_maxsize=MAX_WORKERS + 5,  # Buffer for concurrent requests
                max_retries=Retry(
                    total=0,  # We handle retries ourselves with exponential backoff
                    backoff_factor=0,
                ),
            )
            session.mount("https://", adapter)
            session.mount("http://", adapter)
            
            self.exchange = ccxt.binance(
                {
                    "apiKey": self.api_key,
                    "secret": self.api_secret,
                    "enableRateLimit": True,
                    "session": session,
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
            list: List of deposit objects from CCXT
            
        Raises:
            ConnectorAPIError: On API failures
        """
        try:
            deposits = self.exchange.fetch_deposits(code=None, since=since, limit=limit)
            log.info(f"✅ Fetched {len(deposits)} deposits from Binance")
            return deposits
        except Exception as e:
            error_str = str(e).lower()
            
            # Legitimate empty result
            if "no deposits" in error_str or "empty" in error_str:
                log.debug("ℹ️ No deposits found (legitimate empty result)")
                return []
            
            # Authentication errors
            if "401" in error_str or "unauthorized" in error_str or "invalid api key" in error_str:
                log.error(f"❌ Authentication failed for Binance deposits: {e}")
                raise ConnectorAPIError(
                    message="Authentication failed - check API credentials",
                    connector_name=self.connector_name,
                    operation="fetch_deposits",
                    reason=ErrorReason.AUTHENTICATION_FAILED,
                    http_status_code=401,
                    retryable=False,
                    original_error=e,
                )
            
            if "403" in error_str or "forbidden" in error_str or "permission" in error_str:
                log.error(f"❌ Permission denied for Binance deposits: {e}")
                raise ConnectorAPIError(
                    message="Permission denied - insufficient API key permissions",
                    connector_name=self.connector_name,
                    operation="fetch_deposits",
                    reason=ErrorReason.PERMISSION_DENIED,
                    http_status_code=403,
                    retryable=False,
                    original_error=e,
                )
            
            # Rate limiting
            if "429" in error_str or "rate limit" in error_str or "too many requests" in error_str:
                log.warning(f"⚠️ Rate limited on Binance deposits: {e}")
                raise ConnectorAPIError(
                    message="Rate limited by Binance API",
                    connector_name=self.connector_name,
                    operation="fetch_deposits",
                    reason=ErrorReason.RATE_LIMITED,
                    http_status_code=429,
                    retryable=True,
                    original_error=e,
                )
            
            # Network/timeout errors
            if "timeout" in error_str or "timed out" in error_str:
                log.warning(f"⚠️ Timeout fetching Binance deposits: {e}")
                raise ConnectorAPIError(
                    message="Request timeout",
                    connector_name=self.connector_name,
                    operation="fetch_deposits",
                    reason=ErrorReason.TIMEOUT,
                    retryable=True,
                    original_error=e,
                )
            
            if "connection" in error_str or "network" in error_str:
                log.warning(f"⚠️ Network error fetching Binance deposits: {e}")
                raise ConnectorAPIError(
                    message="Network connection error",
                    connector_name=self.connector_name,
                    operation="fetch_deposits",
                    reason=ErrorReason.NETWORK_ERROR,
                    retryable=True,
                    original_error=e,
                )
            
            # Generic API error
            log.error(f"❌ API error fetching Binance deposits: {e}")
            raise ConnectorAPIError(
                message="API request failed",
                connector_name=self.connector_name,
                operation="fetch_deposits",
                reason=ErrorReason.API_ERROR,
                retryable=False,
                original_error=e,
                details=str(e),
            )

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
        network = normalize_network(raw_item.get("network", ""))
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
            include_fee=False,  # Deposit fees deducted before receipt; quantity is net
            source_from_account=from_address,
            source_to_account=to_address if to_address and to_address != "None" else self._get_account_identifier(),
            to_account_id=self.account_id,  # Resolved account ID
            network=network,
            network_transaction_id=txid,
        )

    def yield_raws(self) -> "Generator[Dict[str, Any], None, None]":
        """
        Fetch deposits from Binance using CCXT and yield them.
        Uses since_timestamp_ms from base class for incremental sync.
        
        Yields:
            Dict[str, Any]: Deposit objects as they are fetched
        """
        from typing import Generator
        
        log.info("🔄 Fetching deposits from Binance API using CCXT...")
        all_deposits = self.get_deposits(since=self.since_timestamp_ms)
        if not all_deposits:
            log.warning("⚠️ No deposits fetched from Binance")
            return
        
        for deposit in all_deposits:
            yield deposit

    # Inherits yield_normalized from BaseConnector
