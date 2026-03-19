"""
MEXC Base connector: Common functionality for all MEXC connectors.
Uses CCXT library for API access.
"""

import ccxt
import time
import requests
from abc import abstractmethod
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from requests.adapters import HTTPAdapter
from typing import Dict, Any, Generator, List, Callable, Optional
from urllib3.util.retry import Retry

from backend.connectors.base.base_connector import BaseConnector
from backend.connectors.base.connector_exceptions import (
    ConnectorAPIError,
    ErrorReason,
)
from backend.config.loader import configure_logging, load_credentials

# Maximum concurrent workers for API requests (balances rate limits vs speed)
MAX_WORKERS = 10


class MEXCBaseConnector(BaseConnector):
    """
    Base class for all MEXC connectors (deposits, withdrawals, transactions).
    
    Provides common functionality including:
    - CCXT exchange initialization with rate limiting
    - Credentials loading from settings.yaml
    - Balance fetching to identify user's currencies
    - Exponential backoff retry for rate limit errors
    - Common error handling (703, 429, etc.)
    - Parallel fetching with ThreadPoolExecutor
    
    MEXC API Rate Limits:
    - Each endpoint: 500 requests per 10 seconds (50 req/s)
    - CCXT enableRateLimit handles automatic throttling
    - Exponential backoff with jitter (2-4s, 4-6s, 8-10s, etc.) for HTTP 429 errors
    - max_workers=5 to handle multiple connectors running simultaneously
    - max_retries=10 with random jitter to prevent thundering herd
    """

    def __init__(
        self,
        api_key: str = None,
        api_secret: str = None,
        account_id: int = None,
        connector_id: int = None,
        currencies: List[str] = None,
        symbols: List[str] = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        """Initialize MEXC connector with API credentials from settings.yaml if not provided."""
        super().__init__(account_id=account_id, connector_id=connector_id, config=config, progress_callback=progress_callback)

        # Store filters - from parameter or config (for override support)
        self._currencies_filter = currencies or (config.get("currencies") if config else None)
        self._symbols_filter = symbols or (config.get("symbols") if config else None)

        # In test/renormalize mode, skip all API configuration
        if self.test_mode or self.renormalize_mode:
            return

        # Load credentials from settings.yaml if not provided
        if api_key is None or api_secret is None:
            creds = load_credentials("mexc")
            api_key = creds.get("api_key")
            api_secret = creds.get("api_secret")

        self.api_key = api_key
        self.api_secret = api_secret

        # Validate configuration
        if not self.api_key or not self.api_secret:
            raise ValueError("Missing API credentials for MEXC")

        # Initialize CCXT exchange with connection pooling
        try:
            # Create a requests session with connection pooling and retry
            session = requests.Session()
            adapter = HTTPAdapter(
                pool_connections=MAX_WORKERS,
                pool_maxsize=MAX_WORKERS + 2,  # Small buffer for concurrent requests
                max_retries=Retry(
                    total=0,  # We handle retries ourselves with exponential backoff
                    backoff_factor=0,
                ),
            )
            session.mount("https://", adapter)
            session.mount("http://", adapter)
            
            self.exchange = ccxt.mexc(
                {
                    "apiKey": self.api_key,
                    "secret": self.api_secret,
                    "enableRateLimit": True,
                    "rateLimit": 200,  # Milliseconds between requests (5 req/sec)
                    "session": session,
                }
            )
            self.exchange.load_markets()
            self._get_logger().info(f"✅ MEXC exchange initialized successfully for {self.connector_name}")
        except Exception as e:
            self._get_logger().error(f"❌ Failed to initialize MEXC exchange: {e}")
            raise

    @abstractmethod
    def _get_logger(self):
        """Return the logger instance for this connector."""
        pass

    def _get_transaction_type(self) -> str:
        """Return the transaction type ('withdrawal', 'deposit', or 'transaction'). Optional for transactions connector."""
        return "transaction"

    def _fetch_transactions(self, code: str, since: int, limit: int, params: Dict) -> List[Dict[str, Any]]:
        """Fetch transactions from MEXC API. Optional - only used by deposits/withdrawals connectors."""
        raise NotImplementedError("This method is only used by deposits/withdrawals connectors")

    def _get_balance_currencies(self) -> List[str]:
        """
        Extract list of currencies from user's balance.
        
        Returns:
            list: List of currency codes (e.g., ['BTC', 'ETH', 'USDT']) or empty list on error
        """
        log = self._get_logger()
        try:
            log.debug("Fetching balance to identify user currencies...")
            balance = self.exchange.fetch_balance()
            
            # Extract currency symbols (exclude special keys like 'info', 'free', 'used', 'total')
            special_keys = {'info', 'free', 'used', 'total', 'timestamp', 'datetime'}
            balance_currencies = [
                symbol for symbol in balance.keys()
                if symbol not in special_keys and isinstance(balance[symbol], dict)
            ]
            
            if balance_currencies:
                log.info(f"📊 Found {len(balance_currencies)} currencies in balance")
            return balance_currencies
        except Exception as e:
            log.warning(f"⚠️ Could not fetch balance: {e}")
            return []

    def _fetch_with_retry(
        self,
        fetch_func: Callable,
        entity_name: str,
        max_retries: int = 10,
        entity_type: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Execute a fetch function with exponential backoff retry for rate limit errors.
        Uses jitter to prevent thundering herd when multiple connectors run simultaneously.
        
        Args:
            fetch_func: Function to call that returns list of results
            entity_name: Name of entity being fetched (for logging, e.g., 'BTC', 'BTC/USDT')
            max_retries: Maximum number of retry attempts (default: 10)
            entity_type: Type of entity (e.g., 'withdrawal', 'deposit', 'trade'). If None, uses _get_transaction_type()
            
        Returns:
            list: Results from fetch_func
            
        Raises:
            ConnectorAPIError: On persistent API failures after retries
        """
        import random
        log = self._get_logger()
        if entity_type is None:
            entity_type = self._get_transaction_type()
        
        retry_count = 0
        while retry_count < max_retries:
            try:
                result = fetch_func()
                return result
            except Exception as e:
                error_str = str(e).lower()
                
                # Handle rate limiting (429)
                if "429" in error_str or "too many requests" in error_str:
                    retry_count += 1
                    if retry_count < max_retries:
                        # Exponential backoff with jitter: prevents all threads from retrying simultaneously
                        base_wait = 2 ** retry_count  # 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024
                        jitter = random.uniform(0, 2)  # Add 0-2 seconds random jitter
                        wait_time = base_wait + jitter
                        log.debug(f"⏳ Rate limit hit for {entity_name}, waiting {wait_time:.1f}s (retry {retry_count}/{max_retries})")
                        time.sleep(wait_time)
                        continue
                    else:
                        # Max retries exhausted for rate limiting
                        log.error(f"❌ Rate limit exceeded for {entity_name} after {max_retries} retries")
                        raise ConnectorAPIError(
                            message=f"Rate limit exceeded after {max_retries} retries",
                            connector_name=self.connector_name,
                            operation=f"fetch_{entity_type}s",
                            reason=ErrorReason.RATE_LIMITED,
                            http_status_code=429,
                            retryable=False,
                            original_error=e,
                            details=entity_name,
                        )
                
                # MEXC error 703 can mean either: no data OR no permission
                # Treat it as "no data" (legitimate empty result) since most entities won't have any
                if "703" in error_str or ("权限" in error_str and "permission" in error_str):
                    log.debug(f"ℹ️ No {entity_type}s available for {entity_name} (code 703 - legitimate empty)")
                    return []
                
                # Legitimate empty result
                if f"no {entity_type}s" in error_str or "empty" in error_str:
                    log.debug(f"ℹ️ No {entity_type}s found for {entity_name}")
                    return []
                
                # Authentication errors - non-retryable
                if "401" in error_str or "unauthorized" in error_str or "invalid api key" in error_str:
                    log.error(f"❌ Authentication failed for {entity_name}: {e}")
                    raise ConnectorAPIError(
                        message="Authentication failed - check API credentials",
                        connector_name=self.connector_name,
                        operation=f"fetch_{entity_type}s",
                        reason=ErrorReason.AUTHENTICATION_FAILED,
                        http_status_code=401,
                        retryable=False,
                        original_error=e,
                        details=entity_name,
                    )
                
                if "403" in error_str or "forbidden" in error_str:
                    log.error(f"❌ Permission denied for {entity_name}: {e}")
                    raise ConnectorAPIError(
                        message="Permission denied - insufficient API key permissions",
                        connector_name=self.connector_name,
                        operation=f"fetch_{entity_type}s",
                        reason=ErrorReason.PERMISSION_DENIED,
                        http_status_code=403,
                        retryable=False,
                        original_error=e,
                        details=entity_name,
                    )
                
                # Other errors - fatal
                log.error(f"❌ API error fetching {entity_type}s for {entity_name}: {e}")
                raise ConnectorAPIError(
                    message="API request failed",
                    connector_name=self.connector_name,
                    operation=f"fetch_{entity_type}s",
                    reason=ErrorReason.API_ERROR,
                    retryable=False,
                    original_error=e,
                    details=entity_name,
                )
        
        # Should not reach here, but handle edge case
        log.error(f"❌ Max retries ({max_retries}) exhausted for {entity_name}")
        raise ConnectorAPIError(
            message=f"Max retries ({max_retries}) exhausted",
            connector_name=self.connector_name,
            operation=f"fetch_{entity_type}s",
            reason=ErrorReason.UNKNOWN,
            retryable=False,
            details=entity_name,
        )

    def get_currencies(self) -> List[str]:
        """
        Get list of currencies from MEXC.
        Priority order:
        1. If currencies filter was provided at init, returns only those currencies
        2. Fetches balance first, then all available currencies from exchange
           Returns balance currencies first, followed by remaining currencies

        Returns:
            list: List of currencies with balance currencies first (e.g., ['USDT', 'BTC', ...others])
        """
        log = self._get_logger()
        
        # Use provided currencies filter if available
        if self._currencies_filter:
            log.info(
                f"📊 Using {len(self._currencies_filter)} configured currencies for MEXC {self._get_transaction_type()}s"
            )
            return self._currencies_filter

        # First: Try to get currencies from balance (prioritize currencies user has/had)
        balance_currencies = self._get_balance_currencies()
        if balance_currencies:
            log.info(f"📊 {len(balance_currencies)} currencies from balance will be processed first")

        # Second: Get all available currencies from exchange
        try:
            log.debug("Fetching all available currencies from exchange...")
            all_currencies = [code for code, info in self.exchange.currencies.items() if info.get('active', False)]
            
            # Remove balance currencies from all_currencies to avoid duplicates
            balance_set = set(balance_currencies)
            remaining_currencies = [c for c in all_currencies if c not in balance_set]
            
            # Combine: balance currencies first, then remaining currencies
            final_currencies = balance_currencies + remaining_currencies
            
            log.info(f"📊 Total currencies: {len(final_currencies)} ({len(balance_currencies)} from balance + {len(remaining_currencies)} others)")
            return final_currencies
        except Exception as e:
            log.error(f"❌ Error fetching currencies from exchange: {e}")
            # If fetching all currencies fails but we have balance currencies, use those
            if balance_currencies:
                log.warning(f"Using {len(balance_currencies)} currencies from balance only")
                return balance_currencies
            return []

    def fetch_with_7day_windows(
        self, currency: str, since: int = None, limit: int = None
    ) -> List[Dict[str, Any]]:
        """
        Fetch transaction history from MEXC using CCXT for a specific currency.
        MEXC API restrictions:
        - Default returns records of last 7 days
        - startTime and endTime must not exceed 7 days
        - Can query 90 days data at most
        
        This method iterates backwards over 7-day timeframes from now until 89 days ago.
        Starting with most recent data allows syncing latest changes first.

        Args:
            currency (str): Currency code (e.g., 'BTC', 'ETH', 'USDT')
            since (int): Timestamp in milliseconds to start fetching from (defaults to 89 days ago)
            limit (int): Limit number of transactions to fetch per request

        Returns:
            list: List of transaction objects from CCXT or empty list on error
        """
        log = self._get_logger()
        transaction_type = self._get_transaction_type()
        
        # Current time in milliseconds
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        
        # Set default start time to 89 days ago (MEXC's max is 90 days, use 89 for safety margin)
        if since is None:
            since = now_ms - (89 * 24 * 60 * 60 * 1000)
        
        # Ensure since is not more than 89 days ago from now (MEXC restriction)
        max_lookback = now_ms - (89 * 24 * 60 * 60 * 1000)
        if since < max_lookback:
            since = max_lookback
            log.debug(f"Adjusted since to 89 days ago due to MEXC 90-day limit")
        
        # MEXC allows max 7 days per request
        seven_days_ms = 7 * 24 * 60 * 60 * 1000
        
        all_transactions = []
        current_end = now_ms
        window_count = 0
        total_windows = max(1, int((current_end - since) / seven_days_ms))
        
        # Iterate backwards over 7-day windows (most recent first)
        while current_end > since:
            window_count += 1
            current_start = max(current_end - seven_days_ms, since)
            
            # Log the timeframe being fetched
            start_date = datetime.fromtimestamp(current_start / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M')
            end_date = datetime.fromtimestamp(current_end / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M')
            log.debug(f"Fetching {transaction_type}s for {currency} [{window_count}/{total_windows}] from {start_date} to {end_date}")
            
            # Use retry logic with exponential backoff
            def fetch_func():
                return self._fetch_transactions(
                    code=currency,
                    since=current_start,
                    limit=limit,
                    params={'startTime': current_start, 'endTime': current_end}
                )
            
            transactions = self._fetch_with_retry(fetch_func, currency, entity_type=transaction_type)
            
            all_transactions.extend(transactions)
            
            # Move to previous 7-day window
            current_end = current_start
        
        if all_transactions:
            log.debug(f"Completed {currency}: fetched {len(all_transactions)} {transaction_type}s across {window_count} windows")
        
        return all_transactions

    def yield_raws(self) -> "Generator[Dict[str, Any], None, None]":
        """
        Fetch transactions from MEXC using CCXT with queue-based streaming.
        Yields transactions as they are fetched from each currency in parallel.
        
        Uses a ThreadPoolExecutor with limited workers to prevent overwhelming
        the API rate limits and connection pool.
        
        Yields:
            Dict[str, Any]: Transaction objects as they are fetched
        """
        from typing import Generator
        from queue import Queue
        import threading
        
        log = self._get_logger()
        transaction_type = self._get_transaction_type()
        
        log.info(f"🔄 Fetching {transaction_type}s from MEXC API using CCXT (streaming with {MAX_WORKERS} workers)...")
        currencies = self.get_currencies()
        if not currencies:
            log.warning("⚠️ No currencies fetched from MEXC")
            return

        log.info(f"📊 Processing {len(currencies)} currencies")
        self.update_progress(
            operation="Fetching currencies",
            current=0,
            total=len(currencies),
            log_message=f"Starting to fetch {transaction_type}s for {len(currencies)} currencies",
            fetched_count=0,
        )

        # Queue for streaming transactions from worker threads
        queue: Queue = Queue()
        
        # Shared state for progress tracking
        completed_count = 0
        fetched_total = 0
        completed_lock = threading.Lock()

        def fetch_currency_transactions(indexed_currency):
            """Worker function to fetch transactions for a single currency and put them in queue."""
            nonlocal completed_count, fetched_total
            idx, currency = indexed_currency
            prefix = f"[{idx + 1}/{len(currencies)}]"
            try:
                transactions = self.fetch_with_7day_windows(currency)
                
                # Put each transaction in the queue immediately
                if transactions:
                    for tx in transactions:
                        queue.put(tx)
                
                with completed_lock:
                    completed_count += 1
                    if transactions:
                        fetched_total += len(transactions)
                    self.update_progress(
                        operation=f"{prefix} Fetching {currency}",
                        current=completed_count,
                        total=len(currencies),
                        log_message=f"{prefix} Fetched {len(transactions)} {transaction_type}s for {currency}" if transactions else None,
                        fetched_count=fetched_total,
                    )
                
                # Log at debug level for individual currencies, info only for significant finds
                if transactions:
                    if len(transactions) >= 10:
                        log.info(f"{prefix} ✅ Found {len(transactions)} {transaction_type}s for {currency}")
                    else:
                        log.debug(f"{prefix} ✅ Found {len(transactions)} {transaction_type}s for {currency}")
            except Exception as e:
                log.error(f"{prefix} ❌ Error fetching {transaction_type}s for {currency}: {e}")
            finally:
                # Signal this worker is done
                queue.put(None)

        # Use ThreadPoolExecutor with limited workers to prevent rate limit issues
        total_workers = len(currencies)
        completed_workers = 0
        total_yielded = 0
        
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            # Submit all tasks to the executor
            futures = []
            for item in enumerate(currencies):
                future = executor.submit(fetch_currency_transactions, item)
                futures.append(future)
            
            # Yield items as they arrive from any worker thread
            while completed_workers < total_workers:
                # Check for abort
                if self.is_abort_requested():
                    log.info(f"⚠️ Abort requested, stopping MEXC {transaction_type}s fetching")
                    executor.shutdown(wait=False, cancel_futures=True)
                    break
                
                try:
                    item = queue.get(timeout=900)
                    if item is None:
                        # Worker finished
                        completed_workers += 1
                        # Log progress every 10% or so
                        if completed_workers % max(1, total_workers // 10) == 0:
                            log.info(f"📊 Progress: {completed_workers}/{total_workers} currencies processed")
                    else:
                        total_yielded += 1
                        yield item
                except Exception as e:
                    # Timeout - log warning
                    log.warning(
                        f"⚠️ Queue timeout. Completed: {completed_workers}/{total_workers}"
                    )

        self.update_progress(
            operation="Completed",
            current=len(currencies),
            total=len(currencies),
            log_message=f"✅ Total {transaction_type}s fetched: {total_yielded}",
            fetched_count=total_yielded,
        )
        log.info(f"✅ Completed fetching {total_yielded} {transaction_type}s from {len(currencies)} currencies")
