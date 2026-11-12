"""
OKX Base connector: Common functionality for all OKX connectors.
Uses CCXT library for API access.
"""

import ccxt
import time
from abc import abstractmethod
from datetime import datetime, timezone
from typing import Dict, Any, Generator, List, Optional

from backend.connectors.base.base_connector import BaseConnector
from backend.connectors.base.ccxt_errors import call_with_retry
from backend.config.loader import configure_logging, load_credentials

OKX_PAGE_LIMIT = 100  # max page size of /asset/deposit-history and /asset/withdrawal-history


class OKXBaseConnector(BaseConnector):
    """
    Base class for all OKX connectors (deposits, withdrawals, transactions).
    
    Provides common functionality including:
    - CCXT exchange initialization with rate limiting
    - Credentials loading from settings.yaml
    - Balance fetching to identify user's currencies
    - Timestamp-based pagination with 'after' (deposit/withdrawal records have no billId)
    - Common error handling
    
    OKX API Rate Limits:
    - REST API: 20 requests/2s per endpoint (10 req/s)
    - CCXT enableRateLimit handles automatic throttling
    """

    def __init__(
        self,
        api_key: str = None,
        api_secret: str = None,
        api_passphrase: str = None,
        account_id: int = None,
        connector_id: int = None,
        currencies: List[str] = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        """Initialize OKX connector with API credentials from settings.yaml if not provided."""
        super().__init__(account_id=account_id, connector_id=connector_id, config=config, progress_callback=progress_callback)

        # Store filters - from parameter or config (for override support)
        self._currencies_filter = currencies or (config.get("currencies") if config else None)

        # In test/renormalize mode, skip all API configuration
        if self.test_mode or self.renormalize_mode:
            return

        # Load credentials from settings.yaml if not provided
        if api_key is None or api_secret is None or api_passphrase is None:
            creds = load_credentials("okx")
            api_key = creds.get("api_key")
            api_secret = creds.get("api_secret")
            api_passphrase = creds.get("api_passphrase")

        self.api_key = api_key
        self.api_secret = api_secret
        self.api_passphrase = api_passphrase

        # Validate configuration
        if not self.api_key or not self.api_secret or not self.api_passphrase:
            raise ValueError("Missing API credentials for OKX")

        # Initialize CCXT exchange
        try:
            self.exchange = ccxt.myokx(
                {
                    "apiKey": self.api_key,
                    "secret": self.api_secret,
                    "password": self.api_passphrase,
                    "enableRateLimit": True,
                }
            )
            self.exchange.load_markets()
            self._get_logger().info(f"✅ OKX exchange initialized successfully for {self.connector_name}")
        except Exception as e:
            self._get_logger().error(f"❌ Failed to initialize OKX exchange: {e}")
            raise

    @abstractmethod
    def _get_logger(self):
        """Return the logger instance for this connector."""
        pass

    def _get_transaction_type(self) -> str:
        """Return the transaction type ('withdrawal', 'deposit', or 'transaction'). Can be overridden."""
        return "transaction"

    @abstractmethod
    def _fetch_transactions(self, code: str, since: int, limit: int, params: Dict) -> List[Dict[str, Any]]:
        """Fetch transactions from OKX API. Must be implemented by subclasses."""
        pass

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """
        Page backwards through OKX deposit/withdrawal history (newest first, max 100 per page).

        CCXT maps `since` to OKX `before`; older pages are requested with `after` = oldest
        timestamp seen + 1 ms ('after' is exclusive, the +1 keeps same-ms siblings, dedup drops repeats).
        """
        log = self._get_logger()
        transaction_type = self._get_transaction_type()
        since_ms = self.since_timestamp_ms
        since_str = (
            datetime.fromtimestamp(since_ms / 1000, tz=timezone.utc).isoformat() if since_ms else "beginning"
        )
        log.info(f"🔄 Fetching {transaction_type}s from OKX since {since_str}...")

        after: Optional[int] = None
        seen_ids = set()
        total_count = 0
        page = 0

        self.update_progress(
            operation=f"Fetching {transaction_type}s",
            current=0,
            total=1,
            log_message=f"Fetching {transaction_type}s from OKX since {since_str}...",
            fetched_count=0,
        )

        while not self.is_abort_requested():
            page += 1
            params = {"after": after} if after else {}
            transactions = call_with_retry(
                lambda: self._fetch_transactions(
                    code=None, since=since_ms, limit=OKX_PAGE_LIMIT, params=params
                ),
                self.connector_name,
                f"fetch_{transaction_type}s",
                log,
                details=f"page={page} after={after}",
            )
            if not transactions:
                break

            new_in_page = 0
            for trx in transactions:
                trx_id = trx.get("id")
                trx_timestamp = trx.get("timestamp")
                if since_ms and trx_timestamp and trx_timestamp < since_ms:
                    continue
                if not trx_id or trx_id in seen_ids:
                    continue
                seen_ids.add(trx_id)
                new_in_page += 1
                total_count += 1
                yield trx

            timestamps = [t.get("timestamp") for t in transactions if t.get("timestamp")]
            oldest_ts = min(timestamps) if timestamps else None
            log.info(
                f"📄 OKX {transaction_type}s page {page}: {len(transactions)} records, {new_in_page} new"
                + (f", oldest {datetime.fromtimestamp(oldest_ts / 1000, tz=timezone.utc).isoformat()}" if oldest_ts else "")
            )
            self.update_progress(
                operation=f"Fetching {transaction_type}s (page {page})",
                current=0,
                total=1,
                fetched_count=total_count,
            )

            if len(transactions) < OKX_PAGE_LIMIT or new_in_page == 0 or oldest_ts is None:
                break
            if since_ms and oldest_ts < since_ms:
                break
            after = oldest_ts + 1
        else:
            log.info(f"⚠️ Abort requested, stopping OKX {transaction_type} fetching")

        log.info(f"✅ Fetched {total_count} {transaction_type}s from OKX in {page} page(s)")
        self.update_progress(
            operation="Completed",
            current=1,
            total=1,
            log_message=f"✅ Fetched {total_count} {transaction_type}s from OKX",
            fetched_count=total_count,
        )

    # Inherits yield_normalized from BaseConnector
