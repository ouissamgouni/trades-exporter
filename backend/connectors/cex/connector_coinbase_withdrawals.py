"""
Coinbase Withdrawals connector: Fetch withdrawal history and map to standardized format.
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
from backend.connectors.base.ccxt_errors import to_connector_error
from backend.config.loader import configure_logging, load_credentials
from backend.db.models import NormalizedTransaction, TransactionType
from backend.core.network_normalizer import normalize_network

log = configure_logging("coinbase_withdrawals")

# Maximum concurrent connections for connection pooling
MAX_WORKERS = 10


# ===== Coinbase Withdrawals Connector Class =====


class ConnectorCoinbaseWithdrawals(BaseConnector):
    """Coinbase withdrawals connector using CCXT library to fetch withdrawal history."""

    @property
    def connector_name(self) -> str:
        return "coinbase_withdrawals"

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
        """Initialize Coinbase withdrawals connector with API credentials from settings.yaml if not provided."""
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
            log.info("✅ Coinbase exchange initialized successfully for withdrawals")
        except Exception as e:
            log.error(f"❌ Failed to initialize Coinbase exchange: {e}")
            raise

    def get_withdrawals(
        self, since: int = None, limit: int = None
    ) -> List[Dict[str, Any]]:
        """
        Fetch withdrawal history from Coinbase using CCXT.

        Args:
            since (int): Timestamp in milliseconds to fetch withdrawals since
            limit (int): Limit number of withdrawals to fetch

        Returns:
            list: List of withdrawal objects from CCXT
            
        Raises:
            ConnectorAPIError: On API failures (auth, network, rate limit, etc.)
        """
        try:
            accounts = self.exchange.fetch_accounts()
            withdrawals = [
                item
                for account in accounts
                for item in self.exchange.fetch_deposits_withdrawals(
                    code=None, since=since, limit=limit, params={"account_id": account['id']}
                )
                if item.get('info', {}).get('type') == 'send' and item.get('type') == 'withdrawal'
            ]
            log.info(f"✅ Fetched {len(withdrawals)} withdrawals from Coinbase")
            return withdrawals
        except Exception as e:
            error_str = str(e).lower()
            # Legitimate empty result - not an error
            if "no withdrawals" in error_str or "empty" in error_str:
                log.debug("ℹ️ No withdrawals found (legitimate empty result)")
                return []

            err = to_connector_error(e, self.connector_name, "fetch_withdrawals")
            log.error(f"❌ {err.reason.value} during fetch_withdrawals: {err.details}")
            raise err from e

    def raw_to_normalized(self, raw_item: dict) -> "NormalizedTransaction":
        """
        Transform a raw withdrawal to NormalizedTransaction dataclass with status filtering.
        Skips withdrawals that are not in 'ok' status.
        """
        from backend.db.models import NormalizedTransaction

        if not self.is_settled_transfer(raw_item, "Withdrawal"):
            return None

        # Extract withdrawal data from CCXT format
        withdrawal_id = str(raw_item.get("id", ""))
        if not withdrawal_id:
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

        # Fee handling
        fee_raw = raw_item.get("fee")
        if isinstance(fee_raw, dict):
            fee_cost = fee_raw.get("cost")
            fee = float(fee_cost) if fee_cost is not None else 0
            fee_quote = str(fee_raw.get("currency", "")).upper()
        elif fee_raw is not None:
            fee = float(fee_raw)
            fee_quote = currency
        else:
            fee = 0
            fee_quote = currency

        # Timestamp
        timestamp_ms = int(raw_item.get("timestamp", 0))
        dt = (
            datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc)
            if timestamp_ms
            else datetime.now(timezone.utc)
        )

        return NormalizedTransaction(
            source="coinbase-withdrawals",
            account_id=self.account_id,
            source_account=self.connector_name,  # Raw account identifier for mapping
            source_transaction_id=withdrawal_id,
            date_time=dt,
            direction="outflow",
            source_transaction_type="withdrawal",
            transaction_type=TransactionType.TRANSFER.value,
            source_asset_symbol=currency,
            quantity=amount,
            fee=fee,
            source_fee_quote_asset_symbol=fee_quote,
            include_fee=True,
            source_from_account=self._get_account_identifier(),  # Connector's account identifier
            from_account_id=self.account_id,  # Resolved account ID
            source_to_account=to_address,
            network=network,
            network_transaction_id=txid,
        )

    def yield_raws(self) -> "Generator[Dict[str, Any], None, None]":
        """
        Fetch withdrawals from Coinbase using CCXT and yield them.
        Uses since_timestamp_ms from base class for incremental sync.
        
        Yields:
            Dict[str, Any]: Withdrawal objects as they are fetched
        """
        log.info("🔄 Fetching withdrawals from Coinbase API using CCXT...")
        
        self.update_progress(
            operation="Fetching withdrawals",
            current=0,
            total=1,
            log_message="Starting to fetch withdrawals from Coinbase",
            fetched_count=0,
        )
        
        all_withdrawals = self.get_withdrawals(since=self.since_timestamp_ms)
        if not all_withdrawals:
            log.warning("⚠️ No withdrawals fetched from Coinbase")
            self.update_progress(
                operation="Completed",
                current=1,
                total=1,
                log_message="No withdrawals found",
                fetched_count=0,
            )
            return
        
        for withdrawal in all_withdrawals:
            if self.is_abort_requested():
                log.info("⚠️ Abort requested, stopping Coinbase withdrawal fetching")
                break
            yield withdrawal
        
        self.update_progress(
            operation="Completed",
            current=1,
            total=1,
            log_message=f"✅ Total withdrawals fetched: {len(all_withdrawals)}",
            fetched_count=len(all_withdrawals),
        )

    # Inherits yield_normalized from BaseConnector


# Integration tests available at:
# pytest tests/integration/exchanges/test_connector_integration.py::TestConnectorIntegration::test_coinbase_withdrawals_connector -v
