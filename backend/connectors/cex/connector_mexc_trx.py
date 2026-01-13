"""
MEXC Exchange connector: API access and trade mapping to trade_sync format.
Uses CCXT library for robust API handling.
Inherits from MEXCBaseConnector for common MEXC functionality.
"""

from datetime import datetime, timezone
from typing import Dict, Any, List

from backend.connectors.cex.connector_mexc_base import MEXCBaseConnector
from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction

log = configure_logging("mexc")


# ===== MEXC Connector Class =====


class MEXCConnectorTrx(MEXCBaseConnector):
    """MEXC exchange connector using CCXT library with symbol iteration pattern."""

    @property
    def connector_name(self) -> str:
        return "mexc_trx"

    def _get_logger(self):
        """Return the logger instance for this connector."""
        return log

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
        """Initialize MEXC transactions connector. Inherits exchange setup from MEXCBaseConnector."""
        super().__init__(
            api_key=api_key,
            api_secret=api_secret,
            account_id=account_id,
            connector_id=connector_id,
            symbols=symbols,
            config=config,
            progress_callback=progress_callback,
            **kwargs
        )

    def get_symbols(self) -> List[str]:
        """
        Get list of trading symbols from MEXC.
        Priority order:
        1. If symbols filter was provided at init, returns only those symbols
        2. Fetches balance first to identify user's currencies, then builds symbols
           from those currencies paired with common quotes (USDT, USDC, BTC, ETH)
           Returns user-relevant symbols first, followed by remaining symbols
        3. Adds remaining symbols from exchange to ensure complete coverage

        Returns:
            list: List of symbols with user-relevant symbols first (e.g., ['BTC/USDT', 'ETH/USDT', ...])
        """
        # Use provided symbols filter if available
        if self._symbols_filter:
            log.info(
                f"📊 Using {len(self._symbols_filter)} configured symbols for MEXC"
            )
            return self._symbols_filter

        user_symbols = []
        
        # First: Try to build symbols from user's balance currencies
        user_currencies = self._get_balance_currencies()
        if user_currencies:
            # Common quote currencies to pair with
            quote_currencies = ['USDT', 'USDC', 'BTC', 'ETH', 'BUSD']
            
            # Build symbols from user's currencies
            all_exchange_symbols = set(self.exchange.symbols)
            for currency in user_currencies:
                for quote in quote_currencies:
                    # Try both base/quote and quote/base combinations
                    symbol1 = f"{currency}/{quote}"
                    symbol2 = f"{quote}/{currency}"
                    
                    if symbol1 in all_exchange_symbols:
                        user_symbols.append(symbol1)
                    if symbol2 in all_exchange_symbols and currency != quote:
                        user_symbols.append(symbol2)
            
            # Remove duplicates while preserving order
            user_symbols = list(dict.fromkeys(user_symbols))
            
            if user_symbols:
                log.info(f"📊 Built {len(user_symbols)} symbols from {len(user_currencies)} user currencies (will be processed first)")

        # Second: Get all available symbols from exchange
        try:
            log.debug("Fetching all available symbols from exchange...")
            all_symbols = self.exchange.symbols
            
            # Remove user symbols from all_symbols to avoid duplicates
            user_symbols_set = set(user_symbols)
            remaining_symbols = [s for s in all_symbols if s not in user_symbols_set]
            
            # Combine: user symbols first, then remaining symbols
            final_symbols = user_symbols + remaining_symbols
            
            log.info(f"📊 Total symbols: {len(final_symbols)} ({len(user_symbols)} from balance + {len(remaining_symbols)} others)")
            return final_symbols
        except Exception as e:
            log.error(f"❌ Error fetching symbols from exchange: {e}")
            # If fetching all symbols fails but we have user symbols, use those
            if user_symbols:
                log.warning(f"Using {len(user_symbols)} symbols from balance only")
                return user_symbols
            return []

    def get_trades(self, symbol: str) -> List[Dict[str, Any]]:
        """
        Fetch private trade history from MEXC for a specific symbol using CCXT.
        Uses base class retry logic with exponential backoff for rate limit errors.

        Args:
            symbol (str): Trading pair symbol (e.g., 'BTC/USDT')

        Returns:
            list: List of trade objects from CCXT or empty list on error
        """
        return self._fetch_with_retry(
            fetch_func=lambda: self.exchange.fetch_my_trades(symbol),
            entity_name=symbol,
            entity_type="trade"
        )

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
            )
        except Exception as e:
            error_msg = f"Failed to map MEXC trade: {e}"
            log.error(error_msg)
            raise ValueError(error_msg) from e

    def get_raws(self) -> List[Dict[str, Any]]:
        """
        Fetch all trades from MEXC using CCXT, fetching per symbol in parallel.
        Returns:
            list: List of trade objects from all symbols
        """
        log.info("🔄 Fetching trades from MEXC API using CCXT...")
        symbols = self.get_symbols()
        if not symbols:
            log.warning("⚠️ No symbols fetched from MEXC")
            return []

        self.update_progress(
            operation="Fetching symbols",
            current=0,
            total=len(symbols),
            log_message=f"Starting to fetch trades for {len(symbols)} symbols"
        )

        import threading
        completed_count = 0
        completed_lock = threading.Lock()

        def fetch_symbol_trades(indexed_symbol):
            """Helper function to fetch trades for a single symbol."""
            nonlocal completed_count
            idx, symbol = indexed_symbol
            prefix = f"[{idx + 1}/{len(symbols)}]"
            try:
                trades = self.get_trades(symbol)
                
                with completed_lock:
                    completed_count += 1
                    self.update_progress(
                        operation=f"Fetching {symbol}",
                        current=completed_count,
                        total=len(symbols),
                        log_message=f"{prefix} Fetched {len(trades)} trades for {symbol}" if trades else None
                    )
                
                if trades:
                    log.info(f"{prefix} ✅ Found {len(trades)} trades for {symbol}")
                    return trades
                else:
                    log.debug(f"{prefix} ℹ️ No trades for {symbol}")
                    return []
            except Exception as e:
                log.error(f"{prefix} ❌ Error fetching trades for {symbol}: {e}")
                return []

        # Use ThreadPoolExecutor for parallel symbol fetching
        from concurrent.futures import ThreadPoolExecutor, as_completed

        all_trades = []
        with ThreadPoolExecutor(max_workers=5) as executor:
            futures = {
                executor.submit(fetch_symbol_trades, item): item
                for item in enumerate(symbols)
            }
            for future in as_completed(futures):
                # Check for abort before processing next future
                if self.is_abort_requested():
                    log.info("⚠️ Abort requested, stopping MEXC symbol fetching")
                    executor.shutdown(wait=False, cancel_futures=True)
                    break
                    
                try:
                    trades = future.result()
                    all_trades.extend(trades)
                except Exception as e:
                    log.debug(f"Error processing future result: {e}")

        self.update_progress(
            operation="Completed",
            current=len(symbols),
            total=len(symbols),
            log_message=f"✅ Total trades fetched: {len(all_trades)}"
        )

        return all_trades

    # Inherits yield_normalized from BaseConnector


# Integration tests available at:
# pytest tests/integration/exchanges/test_connector_integration.py::TestConnectorIntegration::test_mexc_connector -v
