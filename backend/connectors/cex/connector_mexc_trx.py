"""
MEXC Exchange connector: API access and trade mapping to trade_sync format.
Uses CCXT library for robust API handling.
Object-oriented design implementing BaseConnector interface.
"""

import ccxt
from datetime import datetime, timezone
from typing import Dict, Any, List

from backend.connectors.base.base_connector import BaseConnector
from backend.config.loader import configure_logging, load_credentials
from backend.db.models import NormalizedTransaction

log = configure_logging("mexc")


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
        **kwargs,
    ):
        """Initialize MEXC connector with API credentials from settings.yaml if not provided."""
        super().__init__(account_id=account_id, connector_id=connector_id)

        # Store symbols filter (if provided, only fetch trades for these symbols)
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
            log.info("✅ MEXC exchange initialized successfully")
        except Exception as e:
            log.error(f"❌ Failed to initialize MEXC exchange: {e}")
            raise

    def get_symbols(self) -> List[str]:
        """
        Get list of trading symbols from MEXC.
        If symbols filter was provided at init, returns only those symbols.
        Otherwise fetches all available symbols from the exchange.

        Returns:
            list: List of symbols (e.g., ['BTC/USDT', 'ETH/USDT', ...])
        """
        # Use provided symbols filter if available
        if self._symbols_filter:
            log.info(
                f"📊 Using {len(self._symbols_filter)} configured symbols for MEXC"
            )
            return self._symbols_filter

        try:
            symbols = self.exchange.symbols
            log.info(f"📊 Found {len(symbols)} symbols on MEXC")
            return symbols
        except Exception as e:
            log.error(f"Error fetching symbols: {e}")
            return []

    def get_trades(self, symbol: str) -> List[Dict[str, Any]]:
        """
        Fetch private trade history from MEXC for a specific symbol using CCXT.

        Args:
            symbol (str): Trading pair symbol (e.g., 'BTC/USDT')

        Returns:
            list: List of trade objects from CCXT or empty list on error
        """
        try:
            trades = self.exchange.fetch_my_trades(symbol)
            return trades
        except Exception as e:
            error_str = str(e).lower()
            # MEXC error 703 can mean either: no trades OR no permission
            # Treat it as "no trades" since most symbols won't have any trades
            if "703" in error_str or "permission" in error_str or "权限" in error_str:
                log.debug(f"ℹ️ No trades available for {symbol} (code 703)")
            elif "no trades" in error_str or "empty" in error_str:
                log.debug(f"ℹ️ No trades found for {symbol}")
            else:
                log.debug(f"ℹ️ Error fetching trades for {symbol}: {e}")
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
                source_transaction_id=trade_id,
                date_time=dt,
                direction="inflow" if source_transaction_type == "buy" else "outflow",
                transaction_type="acquisition"
                if source_transaction_type == "buy"
                else "disposal",
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

        def fetch_symbol_trades(indexed_symbol):
            """Helper function to fetch trades for a single symbol."""
            idx, symbol = indexed_symbol
            prefix = f"[{idx + 1}/{len(symbols)}]"
            try:
                trades = self.get_trades(symbol)
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
                try:
                    trades = future.result()
                    all_trades.extend(trades)
                except Exception as e:
                    log.debug(f"Error processing future result: {e}")

        return all_trades

    # Inherits yield_normalized from BaseConnector


# Integration tests available at:
# pytest tests/integration/exchanges/test_connector_integration.py::TestConnectorIntegration::test_mexc_connector -v
