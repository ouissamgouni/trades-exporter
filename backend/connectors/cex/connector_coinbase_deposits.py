"""
Coinbase Deposits connector: Fetch deposit history and map to standardized format.
Uses CCXT library for API access.
Object-oriented design implementing BaseConnector interface.
"""

import ccxt
from fastapi import params
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
from backend.db.models import NormalizedTransaction, TransactionType
from backend.core.network_normalizer import normalize_network

log = configure_logging("coinbase_deposits")

# Maximum concurrent connections for connection pooling
MAX_WORKERS = 10


# ===== Coinbase Deposits Connector Class =====


class ConnectorCoinbaseDeposits(BaseConnector):
    """Coinbase deposits connector using CCXT library to fetch deposit history."""

    @property
    def connector_name(self) -> str:
        return "coinbase_deposits"

    def __init__(
        self,
        api_key: str = None,
        api_secret: str = None,
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        """Initialize Coinbase deposits connector with API credentials from settings.yaml if not provided."""
        super().__init__(account_id=account_id, connector_id=connector_id, config=config, progress_callback=progress_callback)

        # In test/renormalize mode, skip all API configuration
        if self.test_mode or self.renormalize_mode:
            return

        # Load credentials from settings.yaml if not provided
        if api_key is None or api_secret is None:
            creds = load_credentials("coinbase")
            api_key = creds.get("api_key")
            api_secret = creds.get("api_secret")

        self.api_key = api_key
        self.api_secret = api_secret

        # Validate configuration
        if not self.api_key or not self.api_secret:
            raise ValueError("Missing API credentials for Coinbase")

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
            
            self.exchange = ccxt.coinbase(
                {
                    "apiKey": self.api_key,
                    "secret": self.api_secret,
                    "enableRateLimit": True,
                    "session": session,
                }
            )
            self.exchange.load_markets()
            log.info("✅ Coinbase exchange initialized successfully for deposits")
        except Exception as e:
            log.error(f"❌ Failed to initialize Coinbase exchange: {e}")
            raise

    def get_deposits(
        self, since: int = None, limit: int = None
    ) -> List[Dict[str, Any]]:
        """
        Fetch deposit history from Coinbase using CCXT.

        Args:
            since (int): Timestamp in milliseconds to fetch deposits since
            limit (int): Limit number of deposits to fetch

        Returns:
            list: List of deposit objects from CCXT
            
        Raises:
            ConnectorAPIError: On API failures (auth, network, rate limit, etc.)
        """
        try:
            accounts = self.exchange.fetch_accounts()
            deposits = [
                item
                for account in accounts
                for item in self.exchange.fetch_deposits_withdrawals(
                    code=None, since=since, limit=limit, params={"account_id": account['id']}
                )
                if item.get('info', {}).get('type') == 'send' and item.get('type') == 'deposit'
            ]
            log.info(f"✅ Fetched {len(deposits)} deposits from Coinbase")
            return deposits
        except Exception as e:
            error_str = str(e).lower()
            
            # Legitimate empty result - not an error
            if "no deposits" in error_str or "empty" in error_str:
                log.debug("ℹ️ No deposits found (legitimate empty result)")
                return []
            
            # Authentication/Authorization errors - non-retryable
            if "401" in error_str or "unauthorized" in error_str or "invalid api key" in error_str:
                log.error(f"❌ Authentication failed for Coinbase deposits: {e}")
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
                log.error(f"❌ Permission denied for Coinbase deposits: {e}")
                raise ConnectorAPIError(
                    message="Permission denied - insufficient API key permissions",
                    connector_name=self.connector_name,
                    operation="fetch_deposits",
                    reason=ErrorReason.PERMISSION_DENIED,
                    http_status_code=403,
                    retryable=False,
                    original_error=e,
                )
            
            # Rate limiting - retryable
            if "429" in error_str or "rate limit" in error_str or "too many requests" in error_str:
                log.warning(f"⚠️ Rate limited on Coinbase deposits: {e}")
                raise ConnectorAPIError(
                    message="Rate limited by Coinbase API",
                    connector_name=self.connector_name,
                    operation="fetch_deposits",
                    reason=ErrorReason.RATE_LIMITED,
                    http_status_code=429,
                    retryable=True,
                    original_error=e,
                )
            
            # Network/timeout errors - retryable
            if "timeout" in error_str or "timed out" in error_str:
                log.warning(f"⚠️ Timeout fetching Coinbase deposits: {e}")
                raise ConnectorAPIError(
                    message="Request timeout",
                    connector_name=self.connector_name,
                    operation="fetch_deposits",
                    reason=ErrorReason.TIMEOUT,
                    retryable=True,
                    original_error=e,
                )
            
            if "connection" in error_str or "network" in error_str:
                log.warning(f"⚠️ Network error fetching Coinbase deposits: {e}")
                raise ConnectorAPIError(
                    message="Network connection error",
                    connector_name=self.connector_name,
                    operation="fetch_deposits",
                    reason=ErrorReason.NETWORK_ERROR,
                    retryable=True,
                    original_error=e,
                )
            
            # Generic API error
            log.error(f"❌ API error fetching Coinbase deposits: {e}")
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

        amount = raw_item.get("amount")
        if amount is None:
            raise ValueError("Missing or invalid 'amount' field")
        amount = float(amount)

        txid = str(raw_item.get("txid", ""))
        network = normalize_network(raw_item.get("network", ""))
        to_address = str(raw_item.get("addressTo"))
        from_address = str(raw_item.get("addressFrom"))

        # Fee handling - be defensive against null/None values returned by Coinbase
        fee_raw = raw_item.get("fee")
        fee = 0
        fee_quote = ""

        if isinstance(fee_raw, dict):
            fee_cost = fee_raw.get("cost")
            if fee_cost is not None:
                try:
                    fee = float(fee_cost)
                except (TypeError, ValueError):
                    fee = 0

            fee_currency = fee_raw.get("currency")
            if fee_currency:
                fee_quote = str(fee_currency).upper()
            else:
                fee_quote = ""
        elif fee_raw is not None:
            try:
                fee = float(fee_raw)
            except (TypeError, ValueError):
                fee = 0
            fee_quote = ""

        # Timestamp
        timestamp_ms = int(raw_item.get("timestamp", 0))
        dt = (
            datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc)
            if timestamp_ms
            else datetime.now(timezone.utc)
        )

        return NormalizedTransaction(
            source="coinbase-deposits",
            account_id=self.account_id,
            source_account=self.connector_name,  # Raw account identifier for mapping
            source_transaction_id=deposit_id,
            date_time=dt,
            direction="inflow",
            source_transaction_type="deposit",
            transaction_type=TransactionType.TRANSFER.value,
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
        Fetch deposits from Coinbase using CCXT and yield them.
        Uses since_timestamp_ms from base class for incremental sync.
        
        Yields:
            Dict[str, Any]: Deposit objects as they are fetched
        """
        log.info("🔄 Fetching deposits from Coinbase API using CCXT...")
        
        self.update_progress(
            operation="Fetching deposits",
            current=0,
            total=1,
            log_message="Starting to fetch deposits from Coinbase",
            fetched_count=0,
        )
        
        all_deposits = self.get_deposits(since=self.since_timestamp_ms)
        if not all_deposits:
            log.warning("⚠️ No deposits fetched from Coinbase")
            self.update_progress(
                operation="Completed",
                current=1,
                total=1,
                log_message="No deposits found",
                fetched_count=0,
            )
            return
        
        for deposit in all_deposits:
            if self.is_abort_requested():
                log.info("⚠️ Abort requested, stopping Coinbase deposit fetching")
                break
            yield deposit
        
        self.update_progress(
            operation="Completed",
            current=1,
            total=1,
            log_message=f"✅ Total deposits fetched: {len(all_deposits)}",
            fetched_count=len(all_deposits),
        )

    # Inherits yield_normalized from BaseConnector


# Integration tests available at:
# pytest tests/integration/exchanges/test_connector_integration.py::TestConnectorIntegration::test_coinbase_deposits_connector -v
