"""
Coinbase Exchange connector: API access and trade mapping to trade_sync format.
Uses CCXT library for robust API handling.
Object-oriented design implementing BaseConnector interface.
"""

import time
import ccxt
from datetime import datetime, timezone
from typing import Dict, Any, List

from backend.connectors.base.base_connector import BaseConnector
from backend.config.loader import configure_logging, load_credentials
from backend.db.models import NormalizedTransaction

log = configure_logging("coinbase")


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
        **kwargs,
    ):
        """Initialize Coinbase connector with API credentials from settings.yaml if not provided."""
        super().__init__(account_id=account_id, connector_id=connector_id)

        # In test mode, skip all API configuration
        if self.test_mode:
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

    def get_symbols(self) -> List[str]:
        """
        Get list of all trading symbols from Coinbase using CCXT.

        Returns:
            list: List of symbols (e.g., ['BTC/USD', 'ETH/USD', ...])
        """
        try:
            symbols = self.exchange.symbols
            log.info(f"📊 Found {len(symbols)} symbols on Coinbase")
            return symbols
        except Exception as e:
            log.error(f"Error fetching symbols: {e}")
            return []

    def get_trades(self, symbol: str, limit: int = 100) -> List[Dict[str, Any]]:
        """
        Fetch private trade history from Coinbase for a specific symbol using CCXT.
        Retries on rate limit (429) errors with exponential backoff.

        Args:
            symbol (str): Trading pair symbol (e.g., 'BTC/USD')
            limit (int): Number of trades to fetch

        Returns:
            list: List of trade objects from CCXT or empty list on error
        """
        max_retries = 3
        retry_delay = 2  # seconds

        for attempt in range(max_retries):
            try:
                trades = self.exchange.fetch_my_trades(symbol, limit=limit)
                return trades
            except ccxt.RateLimitExceeded:
                if attempt < max_retries - 1:
                    log.warning(
                        f"⚠️ Rate limit (429) for {symbol}. Retrying in {retry_delay}s... (attempt {attempt + 1}/{max_retries})"
                    )
                    time.sleep(retry_delay)
                    retry_delay *= 2  # Exponential backoff
                    continue
                else:
                    log.debug(
                        f"❌ Rate limit (429) for {symbol} after {max_retries} retries"
                    )
                    return []
            except Exception as e:
                error_str = str(e).lower()
                if (
                    "no trades" in error_str
                    or "empty" in error_str
                    or "404" in error_str
                ):
                    log.debug(f"ℹ️ No trades found for {symbol}")
                else:
                    log.debug(f"ℹ️ Error fetching trades for {symbol}: {e}")
                return []

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
                source_price_quote_asset_symbol=quote,
                total=cost,
                fee=fee,
                source_fee_quote_asset_symbol=fee_quote,
            )
        except Exception as e:
            error_msg = f"Failed to map Coinbase trade: {e}"
            log.error(error_msg)
            raise ValueError(error_msg) from e

    def get_raws(self) -> List[Dict[str, Any]]:
        """
        Fetch all trades from Coinbase using CCXT, fetching per symbol in parallel.
        Returns:
            list: List of trade objects from all symbols
        """
        log.info("🔄 Fetching trades from Coinbase API using CCXT...")
        symbols = self.get_symbols()
        if not symbols:
            log.warning("⚠️ No symbols fetched from Coinbase")
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
# pytest tests/integration/exchanges/test_connector_integration.py::TestConnectorIntegration::test_coinbase_connector -v
