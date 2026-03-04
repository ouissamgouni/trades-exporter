"""
Coinbase Exchange connector: API access and trade mapping to trade_sync format.
Uses CCXT library for robust API handling.
Object-oriented design implementing BaseConnector interface.
"""

import random
import time
import ccxt
import requests
from datetime import datetime, timezone
from typing import Dict, Any, List, Generator
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from backend.connectors.base.base_connector import BaseConnector
from backend.config.loader import configure_logging, load_credentials
from backend.db.models import NormalizedTransaction

log = configure_logging("coinbase")


# Maximum number of concurrent workers to avoid connection pool exhaustion
MAX_WORKERS = 10


# ===== Coinbase Connector Class =====


class ConnectorCoinbaseTrx(BaseConnector):
    """Coinbase exchange connector using CCXT library with symbol iteration pattern."""

    @property
    def connector_name(self) -> str:
        return "coinbase_trx"

    def __init__(
        self,
        api_key: str = None,
        api_secret: str = None,
        api_passphrase: str = None,
        account_id: int = None,
        connector_id: int = None,
        symbols: List[str] = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        """Initialize Coinbase connector with API credentials from settings.yaml if not provided."""
        super().__init__(account_id=account_id, connector_id=connector_id, config=config, progress_callback=progress_callback)

        # Store symbols filter (if provided, only fetch trades for these symbols)
        self._symbols_filter = symbols or (config.get("symbols") if config else None)

        # In test/renormalize mode, skip all API configuration
        if self.test_mode or self.renormalize_mode:
            return

        # Load credentials from settings.yaml if not provided
        if api_key is None or api_secret is None:
            creds = load_credentials("coinbase")
            api_key = creds.get("api_key")
            api_secret = creds.get("api_secret")
            api_passphrase = creds.get("api_passphrase")

        self.api_key = api_key
        self.api_secret = api_secret
        self.api_passphrase = api_passphrase

        # Validate configuration
        if not self.api_key or not self.api_secret:
            raise ValueError("Missing API credentials for Coinbase")

        # Initialize CCXT exchange
        try:
            self.exchange = ccxt.coinbase(
                {
                    "apiKey": self.api_key,
                    "secret": self.api_secret,
                    "enableRateLimit": True,
                }
            )
            self.exchange.load_markets()
            log.info("✅ Coinbase exchange initialized successfully")
        except Exception as e:
            log.error(f"❌ Failed to initialize Coinbase exchange: {e}")
            raise

        # Configure HTTP session with connection pooling
        self.session = requests.Session()
        retry_strategy = Retry(
            total=3,
            backoff_factor=1,
            status_forcelist=[429, 500, 502, 503, 504],
        )
        adapter = HTTPAdapter(
            pool_connections=10,
            pool_maxsize=15,
            max_retries=retry_strategy,
        )
        self.session.mount("http://", adapter)
        self.session.mount("https://", adapter)

    def get_symbols(self) -> List[str]:
        """
        Get list of trading symbols from Coinbase.
        If symbols filter was provided at init, returns only those symbols.
        Otherwise fetches all available symbols from the exchange.

        Returns:
            list: List of symbols (e.g., ['BTC/USD', 'ETH/USD', ...])
        """
        # Use provided symbols filter if available
        if self._symbols_filter:
            log.info(
                f"📊 Using {len(self._symbols_filter)} configured symbols for Coinbase"
            )
            return self._symbols_filter

        try:
            symbols = self.exchange.symbols
            log.info(f"📊 Found {len(symbols)} symbols on Coinbase")
            return symbols
        except Exception as e:
            log.error(f"Error fetching symbols: {e}")
            return []

    def _fetch_with_retry(self, symbol: str, limit: int = 100) -> List[Dict[str, Any]]:
        """
        Fetch trades for a symbol with exponential backoff retry logic.
        Handles connection errors, timeouts, and rate limits gracefully.

        Args:
            symbol (str): Trading pair symbol (e.g., 'BTC/USD')
            limit (int): Number of trades to fetch

        Returns:
            list: List of trade objects from CCXT or empty list on error
        """
        max_retries = 10
        retry_count = 0

        while retry_count < max_retries:
            try:
                trades = self.exchange.fetch_my_trades(symbol, since=self.since_timestamp_ms, limit=limit)
                return trades
            except ccxt.RateLimitExceeded:
                retry_count += 1
                if retry_count >= max_retries:
                    log.debug(f"❌ Rate limit for {symbol} after {max_retries} retries")
                    return []
                # Exponential backoff with jitter
                wait_time = (2 ** retry_count) + random.uniform(0, 2)
                log.warning(f"⚠️ Rate limit for {symbol}. Retrying in {wait_time:.1f}s... (attempt {retry_count}/{max_retries})")
                time.sleep(wait_time)
            except Exception as e:
                error_str = str(e).lower()
                # Check if it's a retryable error
                if any(keyword in error_str for keyword in ["429", "too many requests", "connection", "pool", "timeout"]):
                    retry_count += 1
                    if retry_count >= max_retries:
                        log.debug(f"❌ Connection error for {symbol} after {max_retries} retries: {e}")
                        return []
                    wait_time = (2 ** retry_count) + random.uniform(0, 2)
                    log.warning(f"⚠️ Connection error for {symbol}. Retrying in {wait_time:.1f}s... (attempt {retry_count}/{max_retries})")
                    time.sleep(wait_time)
                # Non-retryable errors
                elif "no trades" in error_str or "empty" in error_str or "404" in error_str:
                    log.debug(f"ℹ️ No trades found for {symbol}")
                    return []
                else:
                    log.debug(f"ℹ️ Error fetching trades for {symbol}: {e}")
                    return []

        return []

    def get_trades(self, symbol: str, limit: int = 100) -> List[Dict[str, Any]]:
        """
        Fetch private trade history from Coinbase for a specific symbol using CCXT.
        Delegates to _fetch_with_retry for exponential backoff and error handling.

        Args:
            symbol (str): Trading pair symbol (e.g., 'BTC/USD')
            limit (int): Number of trades to fetch

        Returns:
            list: List of trade objects from CCXT or empty list on error
        """
        return self._fetch_with_retry(symbol, limit)

    def raw_to_normalized(self, ccxt_trade: dict) -> "NormalizedTransaction":
        """
        Map a CCXT trade response from Coinbase to NormalizedTransaction dataclass.

        CCXT trade format:
        {
            'id': str,
            'timestamp': int (milliseconds),
            'datetime': str (ISO 8601),
            'symbol': str (e.g., 'BTC/USD'),
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
            source_transaction_type = str(ccxt_trade.get("side")).lower()
            if source_transaction_type not in ["buy", "sell"]:
                raise ValueError(
                    f"Unexpected source_transaction_type '{source_transaction_type}'"
                )
            cost = float(ccxt_trade.get("cost"))
            fee_info = ccxt_trade.get("fee", {})
            fee = float(fee_info.get("cost", 0)) if fee_info else 0
            fee_quote = str(fee_info.get("currency", "")).upper() if fee_info else quote
            timestamp_ms = int(ccxt_trade.get("timestamp", 0))
            dt = datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc)

            return NormalizedTransaction(
                source="coinbase-transactions",
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
                total=cost,
                fee=fee,
                source_fee_quote_asset_symbol=fee_quote,
                include_fee=True,
            )
        except Exception as e:
            error_msg = f"Failed to map Coinbase trade: {e}"
            log.error(error_msg)
            raise ValueError(error_msg) from e

    def yield_raws(self) -> "Generator[Dict[str, Any], None, None]":
        """
        Fetch trades from Coinbase using CCXT with ThreadPoolExecutor.
        Limits concurrent requests to avoid overwhelming the connection pool.
        
        Yields:
            Dict[str, Any]: Trade objects as they are fetched
        """
        from concurrent.futures import ThreadPoolExecutor, as_completed
        
        log.info("🔄 Fetching trades from Coinbase API using CCXT (streaming)...")
        symbols = self.get_symbols()
        if not symbols:
            log.warning("⚠️ No symbols fetched from Coinbase")
            return

        self.update_progress(
            operation="Fetching symbols",
            current=0,
            total=len(symbols),
            log_message=f"Starting to fetch trades for {len(symbols)} symbols",
            fetched_count=0,
        )

        completed_count = 0
        fetched_total = 0

        def fetch_symbol_trades(indexed_symbol):
            """Worker function to fetch trades for a single symbol."""
            idx, symbol = indexed_symbol
            prefix = f"[{idx + 1}/{len(symbols)}]"
            
            if self.is_abort_requested():
                log.debug(f"{prefix} ⚠️ Abort requested, skipping {symbol}")
                return []
            
            try:
                trades = self._fetch_with_retry(symbol)
                
                if trades:
                    log.info(f"{prefix} ✅ Found {len(trades)} trades for {symbol}")
                else:
                    log.debug(f"{prefix} ℹ️ No trades for {symbol}")
                
                return trades
            except Exception as e:
                log.error(f"{prefix} ❌ Error fetching trades for {symbol}: {e}")
                return []

        # Use ThreadPoolExecutor to limit concurrent threads
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            # Submit all tasks
            future_to_symbol = {
                executor.submit(fetch_symbol_trades, item): item
                for item in enumerate(symbols)
            }

            # Process completed futures as they finish
            for future in as_completed(future_to_symbol):
                if self.is_abort_requested():
                    log.info("⚠️ Abort requested, stopping Coinbase symbol fetching")
                    executor.shutdown(wait=False, cancel_futures=True)
                    break
                
                indexed_symbol = future_to_symbol[future]
                idx, symbol = indexed_symbol
                prefix = f"[{idx + 1}/{len(symbols)}]"
                
                try:
                    trades = future.result()
                    completed_count += 1
                    
                    if trades:
                        fetched_total += len(trades)
                        for trade in trades:
                            yield trade
                    
                    self.update_progress(
                        operation=f"{prefix} Fetching {symbol}",
                        current=completed_count,
                        total=len(symbols),
                        log_message=f"{prefix} Fetched {len(trades)} trades for {symbol}" if trades else None,
                        fetched_count=fetched_total,
                    )
                except Exception as e:
                    log.error(f"{prefix} ❌ Error processing result for {symbol}: {e}")
                    completed_count += 1

        self.update_progress(
            operation="Completed",
            current=len(symbols),
            total=len(symbols),
            log_message=f"✅ Total trades fetched: {fetched_total}",
            fetched_count=fetched_total,
        )

    # Inherits yield_normalized from BaseConnector

    # ------------------------------------------------------------------
    # Balance API
    # ------------------------------------------------------------------

    @property
    def supports_balance(self) -> bool:
        return not self.test_mode and self.exchange is not None

    def get_balance(self):
        from decimal import Decimal
        from backend.connectors.base.base_connector import BalanceEntry

        balance = self.exchange.fetch_balance()
        entries = []
        for asset, total in (balance.get("total") or {}).items():
            if total and float(total) > 0:
                free = float((balance.get("free") or {}).get(asset, 0) or 0)
                used = float((balance.get("used") or {}).get(asset, 0) or 0)
                entries.append(BalanceEntry(
                    asset_symbol=asset,
                    total=Decimal(str(total)),
                    available=Decimal(str(free)),
                    locked=Decimal(str(used)),
                ))
        return entries
