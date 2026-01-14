"""
Binance Exchange connector: API access and trade mapping to trade_sync format.
Uses CCXT library for robust API handling.
Object-oriented design implementing BaseConnector interface.
"""

import threading
from datetime import datetime, timezone
import ccxt
from typing import Dict, Any, List
from concurrent.futures import ThreadPoolExecutor, as_completed
from backend.connectors.base.base_connector import BaseConnector
from backend.config.loader import configure_logging, load_credentials
from backend.db.models import NormalizedTransaction

log = configure_logging("binance-trx")


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

        # Store symbols filter (if provided, only fetch trades for these symbols)
        self._symbols_filter = symbols

        # In test mode, skip all API configuration
        if self.test_mode:
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

        # Initialize CCXT exchange
        try:
            self.exchange = ccxt.binance(
                {
                    "apiKey": self.api_key,
                    "secret": self.api_secret,
                    "enableRateLimit": True,
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
        If symbols filter was provided at init, returns only those symbols.
        Otherwise fetches all available symbols from the exchange.

        Returns:
            list: List of symbols (e.g., ['BTC/USDT', 'ETH/USDT', ...])
        """
        # Use provided symbols filter if available
        if self._symbols_filter:
            log.info(
                f"📊 Using {len(self._symbols_filter)} configured symbols for Binance"
            )
            return self._symbols_filter

        try:
            symbols = self.exchange.symbols
            log.info(f"📊 Found {len(symbols)} symbols on Binance")
            return symbols
        except Exception as e:
            log.error(f"Error fetching symbols: {e}")
            return []

    def get_trades_by_symbol(self, symbol: str) -> List[Dict[str, Any]]:
        """
        Fetch private trade history from Binance for a specific symbol using CCXT.

        Args:
            symbol (str): Trading pair symbol (e.g., 'BTC/USDT')

        Returns:
            list: List of trade objects from CCXT or empty list on error
        """
        try:
            # Use since_timestamp_ms from base class for incremental sync
            trades = self.exchange.fetch_my_trades(symbol, since=self.since_timestamp_ms)
            return trades
        except Exception as e:
            error_str = str(e).lower()
            # Handle common error cases
            if "no trades" in error_str or "empty" in error_str:
                log.debug(f"ℹ️ No trades found for {symbol}")
            else:
                log.debug(f"ℹ️ Error fetching trades for {symbol}: {e}")
            return []

    def get_raws(self) -> List[Dict[str, Any]]:
        """
        Fetch all private trades from Binance by fetching symbols in parallel using ThreadPoolExecutor.
        In test mode, this method is bypassed and test data is loaded by BaseConnector.

        Returns:
            list: List of all trade objects from CCXT
        """
        # In test mode, BaseConnector will call _load_test_data() instead
        if self.test_mode:
            return self._load_test_data()

        all_trades = {}
        symbols = self.get_symbols()
        if not symbols:
            log.error("❌ No symbols fetched from Binance")
            return []

        log.debug(f"Starting to fetch trades for {len(symbols)} symbols in parallel")
        
        # Report initial progress
        self.update_progress(
            operation="Fetching symbols",
            current=0,
            total=len(symbols),
            log_message=f"Starting to fetch trades for {len(symbols)} symbols"
        )
        
        # Track completed symbols for progress
        completed_count = 0
        completed_lock = threading.Lock()

        def fetch_symbol_trades(indexed_symbol):
            """Helper function to fetch trades for a single symbol with progress tracking."""
            nonlocal completed_count
            idx, symbol = indexed_symbol
            prefix = f"[{idx + 1}/{len(symbols)}]"
            try:
                trades = self.get_trades_by_symbol(symbol)
                
                # Update progress
                with completed_lock:
                    completed_count += 1
                    self.update_progress(
                        operation=f"Fetching {symbol}",
                        current=completed_count,
                        total=len(symbols),
                        log_message=f"{prefix} Fetched {len(trades) if trades else 0} trades for {symbol}" if trades else None
                    )
                
                if trades:
                    log.info(f"{prefix} ✅ Found {len(trades)} trades for {symbol}")
                    return [
                        (trade.get("id"), trade) for trade in trades if trade.get("id")
                    ]
                else:
                    log.debug(f"{prefix} ℹ️ No trades for {symbol}")
                    return []
            except Exception as e:
                log.debug(f"{prefix} ❌ Error fetching trades for {symbol}: {e}")
                return []

        # Use ThreadPoolExecutor for parallel symbol fetching
        with ThreadPoolExecutor(max_workers=5) as executor:
            futures = {
                executor.submit(fetch_symbol_trades, item): item
                for item in enumerate(symbols)
            }
            for future in as_completed(futures):
                # Check for abort before processing next future
                if self.is_abort_requested():
                    log.info("⚠️ Abort requested, stopping Binance symbol fetching")
                    executor.shutdown(wait=False, cancel_futures=True)
                    break
                    
                try:
                    results = future.result()
                    for trade_id, trade in results:
                        if trade_id not in all_trades:
                            all_trades[trade_id] = trade
                except Exception as e:
                    log.debug(f"Error processing future result: {e}")

        log.debug(
            f"Completed fetching from all symbols. Total unique trades: {len(all_trades)}"
        )
        sorted_trades = list(all_trades.values())
        if sorted_trades:
            sorted_trades = self.exchange.sort_by(sorted_trades, "timestamp")
            if sorted_trades is None:
                sorted_trades = list(all_trades.values())
        
        # Final progress update
        self.update_progress(
            operation="Completed",
            current=len(symbols),
            total=len(symbols),
            log_message=f"✅ Total trades fetched: {len(sorted_trades)}"
        )
        
        log.info(f"✅ Total trades fetched: {len(sorted_trades)}")
        return sorted_trades

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
