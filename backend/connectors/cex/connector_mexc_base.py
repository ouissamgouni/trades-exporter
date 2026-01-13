"""
MEXC Base connector: Common functionality for all MEXC connectors.
Uses CCXT library for API access.
"""

import ccxt
import time
from abc import abstractmethod
from datetime import datetime, timezone
from typing import Dict, Any, List, Callable, Optional

from backend.connectors.base.base_connector import BaseConnector
from backend.config.loader import configure_logging, load_credentials


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

        # Store filters (currencies for deposits/withdrawals, symbols for transactions)
        self._currencies_filter = currencies
        self._symbols_filter = symbols

        # In test mode, skip all API configuration
        if self.test_mode:
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

        # Initialize CCXT exchange
        try:
            self.exchange = ccxt.mexc(
                {
                    "apiKey": self.api_key,
                    "secret": self.api_secret,
                    "enableRateLimit": True,
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
            list: Results from fetch_func or empty list if all retries exhausted
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
                        log.warning(f"⚠️ Rate limit exceeded for {entity_name} after {max_retries} retries")
                        return []
                
                # MEXC error 703 can mean either: no data OR no permission
                # Treat it as "no data" since most entities won't have any
                if "703" in error_str or "permission" in error_str or "权限" in error_str:
                    log.debug(f"ℹ️ No {entity_type}s available for {entity_name} (code 703)")
                elif f"no {entity_type}s" in error_str or "empty" in error_str:
                    log.debug(f"ℹ️ No {entity_type}s found for {entity_name}")
                else:
                    log.debug(f"ℹ️ Error fetching {entity_type}s for {entity_name}: {e}")
                return []
        
        return []  # Fallback if max_retries exhausted

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
            all_currencies = list(self.exchange.currencies.keys())
            
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
        
        # Iterate backwards over 7-day windows (most recent first)
        while current_end > since:
            current_start = max(current_end - seven_days_ms, since)
            
            # Log the timeframe being fetched
            start_date = datetime.fromtimestamp(current_start / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M')
            end_date = datetime.fromtimestamp(current_end / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M')
            log.debug(f"Fetching {transaction_type}s for {currency} from {start_date} to {end_date}")
            
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
        
        return all_transactions

    def get_raws(self) -> List[Dict[str, Any]]:
        """
        Fetch all transactions from MEXC using CCXT, fetching per currency in parallel.
        Returns:
            list: List of transaction objects from all currencies
        """
        log = self._get_logger()
        transaction_type = self._get_transaction_type()
        
        log.info(f"🔄 Fetching {transaction_type}s from MEXC API using CCXT...")
        currencies = self.get_currencies()
        if not currencies:
            log.warning("⚠️ No currencies fetched from MEXC")
            return []

        self.update_progress(
            operation="Fetching currencies",
            current=0,
            total=len(currencies),
            log_message=f"Starting to fetch {transaction_type}s for {len(currencies)} currencies"
        )

        import threading
        completed_count = 0
        completed_lock = threading.Lock()

        def fetch_currency_transactions(indexed_currency):
            """Helper function to fetch transactions for a single currency."""
            nonlocal completed_count
            idx, currency = indexed_currency
            prefix = f"[{idx + 1}/{len(currencies)}]"
            try:
                transactions = self.fetch_with_7day_windows(currency)
                
                with completed_lock:
                    completed_count += 1
                    self.update_progress(
                        operation=f"Fetching {currency}",
                        current=completed_count,
                        total=len(currencies),
                        log_message=f"{prefix} Fetched {len(transactions)} {transaction_type}s for {currency}" if transactions else None
                    )
                
                if transactions:
                    log.info(f"{prefix} ✅ Found {len(transactions)} {transaction_type}s for {currency}")
                    return transactions
                else:
                    log.debug(f"{prefix} ℹ️ No {transaction_type}s for {currency}")
                    return []
            except Exception as e:
                log.error(f"{prefix} ❌ Error fetching {transaction_type}s for {currency}: {e}")
                return []

        # Use ThreadPoolExecutor for parallel currency fetching
        # max_workers=5 to stay within rate limits when multiple MEXC connectors run simultaneously
        from concurrent.futures import ThreadPoolExecutor, as_completed

        all_transactions = []
        with ThreadPoolExecutor(max_workers=5) as executor:
            futures = {
                executor.submit(fetch_currency_transactions, item): item
                for item in enumerate(currencies)
            }
            for future in as_completed(futures):
                # Check for abort before processing next future
                if self.is_abort_requested():
                    log.info(f"⚠️ Abort requested, stopping MEXC {transaction_type}s fetching")
                    executor.shutdown(wait=False, cancel_futures=True)
                    break
                    
                try:
                    transactions = future.result()
                    all_transactions.extend(transactions)
                except Exception as e:
                    log.debug(f"Error processing future result: {e}")

        self.update_progress(
            operation="Completed",
            current=len(currencies),
            total=len(currencies),
            log_message=f"✅ Total {transaction_type}s fetched: {len(all_transactions)}"
        )

        return all_transactions
