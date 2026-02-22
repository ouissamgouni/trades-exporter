"""
Binance Withdrawals connector: Fetch withdrawal history and map to standardized format.
Uses CCXT library for API access.
Object-oriented design implementing BaseConnector interface.
"""

import logging
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

log = configure_logging("binance_withdrawals")

# Maximum concurrent connections for connection pooling
MAX_WORKERS = 10


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
        config: Dict[str, Any] = None,
        **kwargs,
    ):
        """Initialize Binance withdrawals connector with API credentials from settings.yaml if not provided."""
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
            list: List of withdrawal objects from CCXT
            
        Raises:
            ConnectorAPIError: On API failures
        """
        try:
            withdrawals = self.exchange.fetch_withdrawals(
                code=None, since=since, limit=limit
            )
            log.info(f"✅ Fetched {len(withdrawals)} withdrawals from Binance")
            return withdrawals
        except Exception as e:
            error_str = str(e).lower()
            
            # Legitimate empty result
            if "no withdrawals" in error_str or "empty" in error_str:
                log.debug("ℹ️ No withdrawals found (legitimate empty result)")
                return []
            
            # Authentication errors
            if "401" in error_str or "unauthorized" in error_str or "invalid api key" in error_str:
                log.error(f"❌ Authentication failed for Binance withdrawals: {e}")
                raise ConnectorAPIError(
                    message="Authentication failed - check API credentials",
                    connector_name=self.connector_name,
                    operation="fetch_withdrawals",
                    reason=ErrorReason.AUTHENTICATION_FAILED,
                    http_status_code=401,
                    retryable=False,
                    original_error=e,
                )
            
            if "403" in error_str or "forbidden" in error_str or "permission" in error_str:
                log.error(f"❌ Permission denied for Binance withdrawals: {e}")
                raise ConnectorAPIError(
                    message="Permission denied - insufficient API key permissions",
                    connector_name=self.connector_name,
                    operation="fetch_withdrawals",
                    reason=ErrorReason.PERMISSION_DENIED,
                    http_status_code=403,
                    retryable=False,
                    original_error=e,
                )
            
            # Rate limiting
            if "429" in error_str or "rate limit" in error_str or "too many requests" in error_str:
                log.warning(f"⚠️ Rate limited on Binance withdrawals: {e}")
                raise ConnectorAPIError(
                    message="Rate limited by Binance API",
                    connector_name=self.connector_name,
                    operation="fetch_withdrawals",
                    reason=ErrorReason.RATE_LIMITED,
                    http_status_code=429,
                    retryable=True,
                    original_error=e,
                )
            
            # Network/timeout errors
            if "timeout" in error_str or "timed out" in error_str:
                log.warning(f"⚠️ Timeout fetching Binance withdrawals: {e}")
                raise ConnectorAPIError(
                    message="Request timeout",
                    connector_name=self.connector_name,
                    operation="fetch_withdrawals",
                    reason=ErrorReason.TIMEOUT,
                    retryable=True,
                    original_error=e,
                )
            
            if "connection" in error_str or "network" in error_str:
                log.warning(f"⚠️ Network error fetching Binance withdrawals: {e}")
                raise ConnectorAPIError(
                    message="Network connection error",
                    connector_name=self.connector_name,
                    operation="fetch_withdrawals",
                    reason=ErrorReason.NETWORK_ERROR,
                    retryable=True,
                    original_error=e,
                )
            
            # Generic API error
            log.error(f"❌ API error fetching Binance withdrawals: {e}")
            raise ConnectorAPIError(
                message="API request failed",
                connector_name=self.connector_name,
                operation="fetch_withdrawals",
                reason=ErrorReason.API_ERROR,
                retryable=False,
                original_error=e,
                details=str(e),
            )

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
        network = normalize_network(raw_item.get("network", ""))

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
            source_from_account=self._get_account_identifier(),  # Connector's account identifier
            from_account_id=self.account_id,  # Resolved account ID
            source_to_account=to_address,
            network=network,
            network_transaction_id=txid,
        )

    def yield_raws(self) -> "Generator[Dict[str, Any], None, None]":
        """
        Fetch withdrawals from Binance using CCXT and yield them.
        Uses since_timestamp_ms from base class for incremental sync.
        
        Yields:
            Dict[str, Any]: Withdrawal objects as they are fetched
        """
        from typing import Generator
        
        log.info("🔄 Fetching withdrawals from Binance API using CCXT...")
        all_withdrawals = self.get_withdrawals(since=self.since_timestamp_ms)
        if not all_withdrawals:
            log.warning("⚠️ No withdrawals fetched from Binance")
            return

        for withdrawal in all_withdrawals:
            yield withdrawal

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
