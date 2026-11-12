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
from backend.config.loader import configure_logging, load_credentials
from backend.db.models import NormalizedTransaction
from backend.core.network_normalizer import normalize_network
from backend.connectors.cex.binance_common import iter_transfer_history
from backend.connectors.base.ccxt_errors import call_with_retry

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
        self, since: int = None, limit: int = None, params: Dict[str, Any] = None
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
        deposits = call_with_retry(
            lambda: self.exchange.fetch_deposits(
                code=None, since=since, limit=limit, params=params or {}
            ),
            self.connector_name,
            "fetch_deposits",
            log,
            details=f"since={since} offset={(params or {}).get('offset', 0)}",
        )
        log.debug(f"Fetched {len(deposits)} deposits from Binance (since={since})")
        return deposits

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
        total = 0
        for item in iter_transfer_history(self.get_deposits, self.since_timestamp_ms):
            total += 1
            yield item
        log.info(f"✅ Fetched {total} deposits from Binance")

    # Inherits yield_normalized from BaseConnector
