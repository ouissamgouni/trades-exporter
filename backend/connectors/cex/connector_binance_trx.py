"""
Binance Exchange connector: API access and trade mapping to trade_sync format.
Uses CCXT library for robust API handling.
Object-oriented design implementing BaseConnector interface.
"""

import random
import threading
import time
from datetime import datetime, timezone
from typing import Dict, Any, List, Generator
import ccxt
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from backend.connectors.base.base_connector import BaseConnector
from backend.connectors.base.connector_exceptions import (
    ConnectorAPIError,
    ErrorReason,
)
from backend.config.loader import configure_logging, load_credentials
from backend.db.models import NormalizedTransaction

log = configure_logging("binance-trx")

# Maximum concurrent workers for API requests (balances rate limits vs speed)
MAX_WORKERS = 10


# ===== Binance Connector Class =====


class BinanceTrxConnector(BaseConnector):
    """Binance exchange connector using CCXT library with symbol iteration pattern."""

    @property
    def connector_name(self) -> str:
        return "binance_trx"

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
        """Initialize Binance connector with API credentials from settings.yaml if not provided."""
        super().__init__(account_id=account_id, connector_id=connector_id, config=config, progress_callback=progress_callback)

        # Store symbols filter - from parameter or config (for override support)
        self._symbols_filter = symbols or (config.get("symbols") if config else None)

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

    def get_symbols(self) -> List[str]:
        """
        Get list of trading symbols from Binance.
        Priority order:
        1. If symbols filter was provided at init, returns only those symbols
        2. Fetches balance currencies, then filters market symbols to only include
           those containing any balance currency (as base or quote)

        Returns:
            list: List of symbols (e.g., ['BTC/USDT', 'ETH/USDT', ...])
        """
        # Use provided symbols filter if available
        if self._symbols_filter:
            log.info(
                f"📊 Using {len(self._symbols_filter)} configured symbols for Binance"
            )
            return self._symbols_filter

        # Get currencies from balance
        balance_currencies = set()
        try:
            log.debug("Fetching balance to identify user currencies...")
            balance = self.exchange.fetch_balance()
            
            # Extract currency symbols (exclude special keys)
            special_keys = {'info', 'free', 'used', 'total', 'timestamp', 'datetime'}
            balance_currencies = {
                symbol for symbol in balance.keys()
                if symbol not in special_keys and isinstance(balance[symbol], dict)
            }
            
            if balance_currencies:
                log.info(f"📊 Found {len(balance_currencies)} currencies in balance")
        except Exception as e:
            log.warning(f"⚠️ Could not fetch balance: {e}")
        
        # Get all active spot symbols from exchange and filter by balance currencies
        try:
            log.debug("Fetching active spot symbols from exchange...")
            all_symbols = [s for s in self.exchange.markets if self.exchange.markets[s].get('active', False) and self.exchange.markets[s].get('spot', False)]
            
            if balance_currencies:
                # Filter symbols to only those containing balance currencies
                filtered_symbols = []
                for symbol in all_symbols:
                    if '/' in symbol:
                        base, quote = symbol.split('/', 1)
                        if base in balance_currencies or quote in balance_currencies:
                            filtered_symbols.append(symbol)
                
                log.info(f"📊 Filtered to {len(filtered_symbols)} symbols containing balance currencies (from {len(all_symbols)} total)")
                return filtered_symbols
            else:
                # No balance data, use all symbols as fallback
                log.info(f"📊 Using all {len(all_symbols)} active spot symbols (no balance data)")
                return all_symbols
        except Exception as e:
            log.error(f"❌ Error fetching exchange symbols: {e}")
            return []

    def _fetch_with_retry(self, fetch_func, entity_name: str, max_retries: int = 10) -> List[Dict[str, Any]]:
        """
        Execute a fetch function with exponential backoff retry logic.
        Handles connection pool exhaustion, rate limiting, and transient network errors.

        Args:
            fetch_func: Function to execute (should return list or raise exception)
            entity_name: Name of entity being fetched (for logging)
            max_retries: Maximum number of retry attempts

        Returns:
            list: Result from fetch_func
            
        Raises:
            ConnectorAPIError: On persistent API failures after retries
        """
        retry_count = 0
        while retry_count < max_retries:
            try:
                result = fetch_func()
                return result if result else []
            except Exception as e:
                error_str = str(e).lower()
                
                # Check for retryable errors: connection pool, rate limit, network issues
                if any(err in error_str for err in ["429", "too many requests", "connection", "pool", "timeout"]):
                    retry_count += 1
                    if retry_count < max_retries:
                        # Exponential backoff with jitter
                        base_wait = 2 ** retry_count
                        jitter = random.uniform(0, 2)
                        wait_time = base_wait + jitter
                        log.debug(f"Connection/rate limit error for {entity_name}, waiting {wait_time:.1f}s (attempt {retry_count}/{max_retries})")
                        time.sleep(wait_time)
                        continue
                    else:
                        # Max retries exhausted for retryable error
                        if "429" in error_str or "rate limit" in error_str:
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
                        else:
                            log.error(f"❌ Network error for {entity_name} after {max_retries} retries")
                            raise ConnectorAPIError(
                                message=f"Network error after {max_retries} retries",
                                connector_name=self.connector_name,
                                operation="fetch_trades",
                                reason=ErrorReason.NETWORK_ERROR,
                                retryable=False,
                                original_error=e,
                                details=entity_name,
                            )
                
                # Legitimate empty result - not an error
                if "no trades" in error_str or "empty" in error_str:
                    log.debug(f"ℹ️ No trades found for {entity_name}")
                    return []
                
                # Authentication errors - non-retryable
                if "401" in error_str or "unauthorized" in error_str:
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

    def get_trades_by_symbol(self, symbol: str) -> List[Dict[str, Any]]:
        """
        Fetch private trade history from Binance for a specific symbol using CCXT.
        Uses retry logic to handle connection pool exhaustion and rate limits.

        Args:
            symbol (str): Trading pair symbol (e.g., 'BTC/USDT')

        Returns:
            list: List of trade objects from CCXT or empty list on error
        """
        return self._fetch_with_retry(
            lambda: self.exchange.fetch_my_trades(symbol, since=self.since_timestamp_ms, limit=1000),
            f"trades for {symbol}"
        )

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """
        Fetch trades from Binance with ThreadPoolExecutor-based streaming.
        Yields trades as they are fetched from each symbol in parallel.
        
        Uses ThreadPoolExecutor to limit concurrent connections and prevent
        connection pool exhaustion.
        
        Yields:
            Dict[str, Any]: Trade objects as they are fetched
        """
        
        # In test mode, BaseConnector will load test data via _yield_raws()
        if self.test_mode:
            for item in self._load_test_data():
                yield item
            return

        symbols = self.get_symbols()
        if not symbols:
            log.error("❌ No symbols fetched from Binance")
            return

        log.debug(f"Starting to fetch trades for {len(symbols)} symbols (streaming)")
        
        # Report initial progress
        self.update_progress(
            operation="Fetching symbols",
            current=0,
            total=len(symbols),
            log_message=f"Starting to fetch trades for {len(symbols)} symbols",
            fetched_count=0,
        )
        
        # Track seen trade IDs for deduplication
        seen_ids: set = set()
        seen_lock = threading.Lock()
        
        # Track completed symbols for progress
        completed_count = 0

        def fetch_symbol_trades(indexed_symbol):
            """Worker function to fetch trades for a single symbol."""
            idx, symbol = indexed_symbol
            prefix = f"[{idx + 1}/{len(symbols)}]"
            try:
                trades = self.get_trades_by_symbol(symbol)
                
                if trades:
                    log.info(f"{prefix} ✅ Found {len(trades)} trades for {symbol}")
                else:
                    log.debug(f"{prefix} ℹ️ No trades for {symbol}")
                
                return trades
            except Exception as e:
                log.debug(f"{prefix} ❌ Error fetching trades for {symbol}: {e}")
                return []

        # Use ThreadPoolExecutor with limited workers to prevent connection pool exhaustion
        total_yielded = 0
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            # Submit all symbol fetch tasks
            future_to_symbol = {
                executor.submit(fetch_symbol_trades, item): item
                for item in enumerate(symbols)
            }
            
            # Process completed futures as they finish
            for future in as_completed(future_to_symbol):
                # Check for abort
                if self.is_abort_requested():
                    log.info("⚠️ Abort requested, stopping Binance symbol fetching")
                    # Cancel pending futures
                    for f in future_to_symbol:
                        f.cancel()
                    break
                
                idx, symbol = future_to_symbol[future]
                prefix = f"[{idx + 1}/{len(symbols)}]"
                
                try:
                    trades = future.result()
                    
                    # Yield each trade, deduplicating by trade ID
                    if trades:
                        for trade in trades:
                            trade_id = trade.get("id")
                            if trade_id:
                                with seen_lock:
                                    if trade_id not in seen_ids:
                                        seen_ids.add(trade_id)
                                        total_yielded += 1
                                        yield trade
                    
                    # Update progress
                    completed_count += 1
                    
                    self.update_progress(
                        operation=f"{prefix} Fetching {symbol}",
                        current=completed_count,
                        total=len(symbols),
                        log_message=f"{prefix} Fetched {len(trades) if trades else 0} trades for {symbol}" if trades else None,
                        fetched_count=total_yielded,
                    )
                except Exception as e:
                    log.debug(f"{prefix} ❌ Error processing result for {symbol}: {e}")

        # Final progress update
        self.update_progress(
            operation="Completed",
            current=len(symbols),
            total=len(symbols),
            log_message=f"✅ Total trades fetched: {total_yielded}",
            fetched_count=total_yielded,
        )
        
        log.info(f"✅ Total trades fetched: {total_yielded}")

    def raw_to_normalized(self, ccxt_trade: dict) -> "NormalizedTransaction":
        """
        Map a CCXT trade response from Binance to trade_sync structure.

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
        try:
            trade_id = str(ccxt_trade.get("id", ""))
            symbol = str(ccxt_trade.get("symbol", "")).upper()
            base, quote = symbol.split("/")
            if not base or not quote:
                raise ValueError(
                    f"Invalid base or quote currency: base='{base}', quote='{quote}'"
                )
            price = float(ccxt_trade.get("price"))
            qty = float(ccxt_trade.get("amount"))
            total = float(ccxt_trade.get("cost"))
            source_transaction_type = str(ccxt_trade.get("side")).lower()
            if source_transaction_type not in ["buy", "sell"]:
                raise ValueError(
                    f"Unexpected source_transaction_type '{source_transaction_type}'"
                )
            fee_info = ccxt_trade.get("fee", {})
            fee = float(fee_info.get("cost", 0)) if fee_info else 0
            fee_quote = str(fee_info.get("currency")).upper() if fee_info else quote
            timestamp_ms = int(ccxt_trade.get("timestamp"))
            dt = datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc)

            return NormalizedTransaction(
                source="binance-transactions",
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
                source_price_quote_asset_symbol=quote,
                total=total,
                fee=fee,
                source_fee_quote_asset_symbol=fee_quote,
            )
        except Exception as e:
            error_msg = f"Failed to map Binance trade: {e}"
            log.error(error_msg)
            raise ValueError(error_msg) from e

    # Inherits yield_normalized from BaseConnector


# Integration tests available at:
# pytest tests/integration/exchanges/test_connector_integration.py::TestConnectorIntegration::test_binance_connector -v
