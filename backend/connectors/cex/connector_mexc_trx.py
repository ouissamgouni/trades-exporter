"""
MEXC Exchange connector: API access and trade mapping to trade_sync format.
Uses CCXT library for robust API handling.
Object-oriented design implementing BaseConnector interface.
"""

import ccxt
import requests
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from requests.adapters import HTTPAdapter
from typing import Dict, Any, List
from urllib3.util.retry import Retry

from backend.connectors.base.base_connector import BaseConnector
from backend.connectors.base.connector_exceptions import (
    ConnectorAPIError,
    ErrorReason,
)
from backend.config.loader import configure_logging, load_credentials
from backend.db.models import NormalizedTransaction

log = configure_logging("mexc")

# Maximum concurrent workers for API requests (balances rate limits vs speed)
MAX_WORKERS = 8


# ===== MEXC Connector Class =====


class MEXCConnectorTrx(BaseConnector):
    """MEXC exchange connector using CCXT library with symbol iteration pattern."""

    @property
    def connector_name(self) -> str:
        return "mexc_trx"

    def __init__(
        self,
        api_key: str = None,
        api_secret: str = None,
        account_id: int = None,
        connector_id: int = None,
        symbols: List[str] = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        """Initialize MEXC connector with API credentials from settings.yaml if not provided."""
        super().__init__(account_id=account_id, connector_id=connector_id, config=config, progress_callback=progress_callback)

        # Store symbols filter - from parameter or config (for override support)
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
            log.info("✅ MEXC exchange initialized successfully")
        except Exception as e:
            log.error(f"❌ Failed to initialize MEXC exchange: {e}")
            raise

    def _get_balance_symbols(self) -> List[str]:
        """
        Extract list of trading symbols from user's balance.
        Constructs trading pairs by crossing balance currencies with common quote currencies.
        
        Returns:
            list: List of symbol pairs (e.g., ['BTC/USDT', 'ETH/USDT', ...]) or empty list on error
        """
        try:
            log.debug("Fetching balance to identify user trading pairs...")
            balance = self.exchange.fetch_balance()
            
            # Extract currency symbols (exclude special keys like 'info', 'free', 'used', 'total')
            special_keys = {'info', 'free', 'used', 'total', 'timestamp', 'datetime'}
            balance_currencies = [
                symbol for symbol in balance.keys()
                if symbol not in special_keys and isinstance(balance[symbol], dict)
            ]
            
            if not balance_currencies:
                return []
            
            # Common quote currencies on MEXC (prioritized order)
            common_quotes = ['USDT', 'USDC', 'BTC', 'ETH', 'BNB']
            
            # Construct trading pairs by crossing balance currencies with common quotes
            balance_symbols = []
            available_symbols = set(s for s in self.exchange.symbols if self.exchange.markets[s].get('active', False) and self.exchange.markets[s].get('spot', False))  # Get all available active spot symbols for validation
            
            for base in balance_currencies:
                for quote in common_quotes:
                    if base != quote:  # Don't create pairs like BTC/BTC
                        symbol = f"{base}/{quote}"
                        # Only add if this symbol actually exists on the exchange
                        if symbol in available_symbols:
                            balance_symbols.append(symbol)
            
            if balance_symbols:
                log.info(f"📊 Found {len(balance_symbols)} trading pairs from {len(balance_currencies)} balance currencies")
            
            return balance_symbols
        except Exception as e:
            log.warning(f"⚠️ Could not fetch balance symbols: {e}")
            return []  # Graceful degradation

    def get_symbols(self) -> List[str]:
        """
        Get list of trading symbols from MEXC.
        Priority order:
        1. If symbols filter was provided at init, returns only those symbols
        2. Fetches balance first, then all available symbols from exchange
           Returns balance symbols first, followed by remaining symbols

        Returns:
            list: List of symbols (e.g., ['BTC/USDT', 'ETH/USDT', ...])
        """
        # Use provided symbols filter if available
        if self._symbols_filter:
            log.info(
                f"📊 Using {len(self._symbols_filter)} configured symbols for MEXC"
            )
            return self._symbols_filter

        # First: Try to get symbols from balance (prioritize symbols user has/had)
        balance_symbols = self._get_balance_symbols()
        if balance_symbols:
            log.info(f"📊 {len(balance_symbols)} symbols from balance will be processed first")

        # Second: Get all available symbols from exchange
        try:
            log.debug("Fetching all available symbols from exchange...")
            all_symbols = [s for s in self.exchange.markets if self.exchange.markets[s].get('active', False) and self.exchange.markets[s].get('spot', False)]
            
            # Remove balance symbols from all_symbols to avoid duplicates
            balance_set = set(balance_symbols)
            remaining_symbols = [s for s in all_symbols if s not in balance_set]
            
            # Combine: balance symbols first, then remaining symbols
            final_symbols = balance_symbols + remaining_symbols
            
            log.info(f"📊 Total: {len(final_symbols)} symbols ({len(balance_symbols)} from balance + {len(remaining_symbols)} others)")
            return final_symbols
        except Exception as e:
            # Fallback to balance symbols only if fetch fails
            if balance_symbols:
                log.warning(f"⚠️ Error fetching all symbols: {e}")
                log.warning(f"Using {len(balance_symbols)} symbols from balance only")
                return balance_symbols
            log.error(f"❌ Error fetching symbols: {e}")
            return []

    def raw_to_normalized(self, ccxt_trade: dict) -> "NormalizedTransaction":
        """
        Map a CCXT trade response from MEXC to NormalizedTransaction dataclass.

        CCXT trade format:
        {
            'id': str,
            'timestamp': int (milliseconds),
            'datetime': str (ISO 8601),
            'symbol': str (e.g., 'BTC/USDT'),
            'type': str ('limit' or 'market'),
            'side': str ('buy' or 'sell'),
            'price': float,
            'amount': float (quantity),
            'cost': float (total in quote currency),
            'fee': {'currency': str, 'cost': float, 'rate': float},
            'info': dict (raw exchange response)
        }
        """
        from backend.db.models import NormalizedTransaction
        from backend.core.utils import compute_trade_content_hash

        try:
            trade_id = str(ccxt_trade.get("id", ""))
            symbol = str(ccxt_trade.get("symbol", "")).upper()
            base, quote = symbol.split("/")
            if not base or not quote:
                raise ValueError(
                    f"Invalid base or quote currency: base='{base}', quote='{quote}'"
                )
            price = float(ccxt_trade.get("price", 0))
            qty = float(ccxt_trade.get("amount", 0))
            total = float(ccxt_trade.get("cost"))
            source_transaction_type = str(ccxt_trade.get("side")).lower()
            if source_transaction_type not in ["buy", "sell"]:
                raise ValueError(
                    f"Unexpected source_transaction_type '{source_transaction_type}'"
                )
            fee_info = ccxt_trade.get("fee", {})
            fee = float(fee_info.get("cost", 0)) if fee_info else 0
            fee_quote = str(fee_info.get("currency", "")).upper() if fee_info else quote
            timestamp_ms = int(ccxt_trade.get("timestamp", 0))
            dt = datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc)

            # Compute content hash for cross-source deduplication
            content_hash = compute_trade_content_hash(
                dt=dt,
                base=base,
                quote=quote,
                quantity=qty,
                price=price,
                side=source_transaction_type,
            )

            return NormalizedTransaction(
                source="mexc-transactions",
                account_id=self.account_id,
                source_account=self.connector_name,  # Raw account identifier for mapping
                source_transaction_id=trade_id,
                date_time=dt,
                direction="inflow" if source_transaction_type == "buy" else "outflow",
                transaction_type="trade",
                source_transaction_type=source_transaction_type,
                source_asset_symbol=base,
                quantity=qty,
                price=price,
                total=total,
                source_price_quote_asset_symbol=quote,
                fee=fee,
                source_fee_quote_asset_symbol=fee_quote,
                content_hash=content_hash,
            )
        except Exception as e:
            error_msg = f"Failed to map MEXC trade: {e}"
            log.error(error_msg)
            raise ValueError(error_msg) from e

    def _fetch_with_retry(
        self,
        fetch_func,
        entity_name: str,
        max_retries: int = 10,
    ) -> List[Dict[str, Any]]:
        """
        Execute a fetch function with exponential backoff retry for rate limiting.
        
        Args:
            fetch_func: Callable that performs the fetch
            entity_name: Name for logging (e.g., "BTC/USDT")
            max_retries: Maximum number of retries for rate limit errors
            
        Returns:
            List of results from the fetch function
            
        Raises:
            ConnectorAPIError: On persistent API failures after retries
        """
        import random
        import time
        
        retry_count = 0
        while retry_count < max_retries:
            try:
                result = fetch_func()
                return result if result else []
            except Exception as e:
                error_str = str(e).lower()
                
                # Handle rate limiting (429 / too many requests)
                if "429" in error_str or "too many requests" in error_str or "rate" in error_str:
                    retry_count += 1
                    if retry_count < max_retries:
                        # Exponential backoff with jitter
                        base_wait = 2 ** retry_count  # 2, 4, 8, 16, 32...
                        jitter = random.uniform(0, 2)
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
                            operation="fetch_trades",
                            reason=ErrorReason.RATE_LIMITED,
                            http_status_code=429,
                            retryable=False,
                            original_error=e,
                            details=entity_name,
                        )
                
                # MEXC error 703 can mean either: no data OR no permission
                # Treat it as "no data" (legitimate empty result)
                if "703" in error_str or ("权限" in error_str and "permission" in error_str):
                    log.debug(f"ℹ️ No data available for {entity_name} (code 703 - legitimate empty)")
                    return []
                
                # Legitimate empty result
                if "no trades" in error_str or "empty" in error_str:
                    log.debug(f"ℹ️ No trades found for {entity_name}")
                    return []
                
                # Authentication errors - non-retryable
                if "401" in error_str or "unauthorized" in error_str or "invalid api key" in error_str:
                    log.error(f"❌ Authentication failed for {entity_name}: {e}")
                    raise ConnectorAPIError(
                        message="Authentication failed - check API credentials",
                        connector_name=self.connector_name,
                        operation="fetch_trades",
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
                        operation="fetch_trades",
                        reason=ErrorReason.PERMISSION_DENIED,
                        http_status_code=403,
                        retryable=False,
                        original_error=e,
                        details=entity_name,
                    )
                
                # Other errors - fatal
                log.error(f"❌ API error fetching {entity_name}: {e}")
                raise ConnectorAPIError(
                    message="API request failed",
                    connector_name=self.connector_name,
                    operation="fetch_trades",
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
            operation="fetch_trades",
            reason=ErrorReason.UNKNOWN,
            retryable=False,
            details=entity_name,
        )

    def yield_raws(self) -> "Generator[Dict[str, Any], None, None]":
        """
        Fetch trades from MEXC using CCXT with queue-based streaming.
        Yields trades as they are fetched from each symbol in parallel.
        
        Uses a ThreadPoolExecutor with limited workers to prevent overwhelming
        the API rate limits and connection pool.
        
        Yields:
            Dict[str, Any]: Trade objects as they are fetched
        """
        from typing import Generator
        from queue import Queue
        import threading
        
        log.info(f"🔄 Fetching trades from MEXC API using CCXT (streaming with {MAX_WORKERS} workers)...")
        symbols = self.get_symbols()
        if not symbols:
            log.warning("⚠️ No symbols fetched from MEXC")
            return

        log.info(f"📊 Processing {len(symbols)} symbols")
        self.update_progress(
            operation="Fetching symbols",
            current=0,
            total=len(symbols),
            log_message=f"Starting to fetch trades for {len(symbols)} symbols",
            fetched_count=0,
        )

        # Queue for streaming trades from worker threads
        queue: Queue = Queue()
        
        # Shared state for progress tracking
        completed_count = 0
        fetched_total = 0
        completed_lock = threading.Lock()

        def fetch_symbol_trades(indexed_symbol):
            """Worker function to fetch trades for a single symbol with retry logic."""
            nonlocal completed_count, fetched_total
            idx, symbol = indexed_symbol
            prefix = f"[{idx + 1}/{len(symbols)}]"
            
            try:
                # Use retry wrapper for rate limiting
                trades = self._fetch_with_retry(
                    fetch_func=lambda: self.exchange.fetch_my_trades(symbol, since=self.since_timestamp_ms),
                    entity_name=symbol,
                )
                
                # Put each trade in the queue immediately
                if trades:
                    for trade in trades:
                        queue.put(trade)
                
                with completed_lock:
                    completed_count += 1
                    if trades:
                        fetched_total += len(trades)
                    self.update_progress(
                        operation=f"{prefix} Fetching {symbol}",
                        current=completed_count,
                        total=len(symbols),
                        log_message=f"{prefix} Fetched {len(trades)} trades for {symbol}" if trades else None,
                        fetched_count=fetched_total,
                    )
                
                # Log at debug level for individual symbols, info only for significant finds
                if trades:
                    if len(trades) >= 10:
                        log.info(f"{prefix} ✅ Found {len(trades)} trades for {symbol}")
                    else:
                        log.debug(f"{prefix} ✅ Found {len(trades)} trades for {symbol}")
            except Exception as e:
                log.error(f"{prefix} ❌ Error fetching trades for {symbol}: {e}")
            finally:
                # Signal this worker is done
                queue.put(None)

        # Use ThreadPoolExecutor with limited workers to prevent rate limit issues
        total_workers = len(symbols)
        completed_workers = 0
        total_yielded = 0
        
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            # Submit all tasks to the executor
            futures = []
            for item in enumerate(symbols):
                future = executor.submit(fetch_symbol_trades, item)
                futures.append(future)
            
            # Yield items as they arrive from any worker thread
            while completed_workers < total_workers:
                # Check for abort
                if self.is_abort_requested():
                    log.info("⚠️ Abort requested, stopping MEXC trades fetching")
                    executor.shutdown(wait=False, cancel_futures=True)
                    break
                
                try:
                    item = queue.get(timeout=900)
                    if item is None:
                        # Worker finished
                        completed_workers += 1
                        # Log progress every 10% or so
                        if completed_workers % max(1, total_workers // 10) == 0:
                            log.info(f"📊 Progress: {completed_workers}/{total_workers} symbols processed")
                    else:
                        total_yielded += 1
                        yield item
                except Exception as e:
                    log.warning(f"⚠️ Queue timeout: {e}")

        self.update_progress(
            operation="Completed",
            current=len(symbols),
            total=len(symbols),
            log_message=f"✅ Total trades fetched: {total_yielded}",
            fetched_count=total_yielded,
        )
        log.info(f"✅ Completed fetching {total_yielded} trades from {len(symbols)} symbols")

    # Inherits yield_normalized from BaseConnector


# Integration tests available at:
# pytest tests/integration/exchanges/test_connector_integration.py::TestConnectorIntegration::test_mexc_connector -v
