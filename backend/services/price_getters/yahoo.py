"""
Yahoo Finance Price Getter.

Uses yfinance library to get current and historical prices.
This is the default price getter.

The external_id should be the full Yahoo Finance ticker:
- Crypto: "BTC-USD", "ETH-EUR"
- Forex: "EURUSD=X", "GBPUSD=X"
- Stocks: "AAPL", "MSFT"

Quote Currency Handling:
- Prices are returned in the ticker's native currency
- The PriceService handles conversion to the requested quote currency
- Configure native_quote_currency in AssetPriceGetter.params to specify the ticker's currency
- Defaults to "USD" if not specified or parseable from ticker
"""

import math
from datetime import date, datetime, timedelta
from typing import List, Optional, Tuple

import yfinance as yf

from backend.config.loader import configure_logging
from backend.db.models import Asset
from backend.services.price_getters.base import (
    BasePriceGetter,
    PriceErrorReason,
    PriceGetterConfig,
    PriceGetterError,
    PriceResult,
)

log = configure_logging("yahoo_price_getter")


class YahooPriceGetter(BasePriceGetter):
    """
    Price getter implementation for Yahoo Finance API.

    Ticker Resolution:
    - Uses config.external_id from database (AssetPriceGetter.external_id)
    - Falls back to asset.symbol

    The external_id must be the full Yahoo Finance ticker including currency pair:
    - Crypto: "BTC-USD", "ETH-EUR", "SOL-USD"
    - Forex: "EURUSD=X", "GBPUSD=X"
    - Stocks/ETFs: "AAPL", "MSFT", "SPY"

    Configure via UI: Assets > [asset] > Price Getters > Add Yahoo > External ID.

    Quote Currency Config:
    - Set `native_quote_currency` in config.extra to specify what currency the ticker returns
    - Defaults to "USD" if not specified
    - E.g., for "BTC-EUR", set native_quote_currency="EUR"
    - PriceService handles conversion to requested quote currency
    """

    name = "yahoo"
    supports_range = True

    # Yahoo aggressively rate-limits/blocks rapid successive requests (e.g. in
    # test runs). Retrying with the base default (3 attempts + backoff) just
    # multiplies the wait for a call that's already being blocked. Fail fast
    # instead, same pattern as marketstack.py.
    max_retries = 1  # Keep fast — no retries

    # Default native quote currency for tickers
    DEFAULT_NATIVE_QUOTE = "USD"

    def __init__(self):
        """Initialize Yahoo Finance price getter."""
        super().__init__()

    def _parse_ticker_quote_currency(self, ticker: str) -> Optional[str]:
        """
        Try to parse the quote currency from a Yahoo Finance ticker.

        Args:
            ticker: Yahoo Finance ticker (e.g., "BTC-USD", "AAPL", "EURUSD=X")

        Returns:
            Quote currency if parseable, None otherwise.
        """
        # Crypto format: "BTC-USD", "ETH-EUR"
        if "-" in ticker:
            parts = ticker.split("-")
            if len(parts) == 2:
                return parts[1].upper()

        # Forex format: "EURUSD=X" → USD
        if ticker.endswith("=X") and len(ticker) == 8:
            return ticker[3:6].upper()

        # Stocks are typically in their native currency (USD for US stocks)
        # Can't determine from ticker alone
        return None

    def _resolve_ticker_with_quote(
        self,
        asset: Asset,
        config: Optional[PriceGetterConfig],
    ) -> Tuple[str, str]:
        """
        Resolve ticker symbol and its native quote currency.

        Args:
            asset: Asset object
            config: Price getter config with potential ticker override

        Returns:
            Tuple of (ticker_symbol, native_quote_currency)
            native_quote_currency is what the ticker actually returns prices in
        """
        # 1. If explicit ticker in config, use it
        if config and config.external_id:
            ticker = config.external_id
            # Get native quote from config, or parse from ticker, or use default
            native_quote = config.extra.get("native_quote_currency")
            if not native_quote:
                native_quote = self._parse_ticker_quote_currency(ticker)
            if not native_quote:
                native_quote = self.DEFAULT_NATIVE_QUOTE
            return ticker, native_quote.upper()

        # 2. Use asset symbol as ticker
        ticker = asset.symbol.upper()

        # Try to parse quote from ticker, else use default
        native_quote = self._parse_ticker_quote_currency(ticker)
        if not native_quote:
            native_quote = self.DEFAULT_NATIVE_QUOTE

        return ticker, native_quote.upper()

    def get_current_price(
        self,
        asset: Asset,
        config: Optional[PriceGetterConfig] = None,
    ) -> PriceResult:
        """
        Fetch current asset price from Yahoo Finance.

        Args:
            asset: Asset object.
            config: Optional price getter configuration with ticker override.

        Returns:
            PriceResult: Current price in the ticker's native quote currency.
                        PriceService handles conversion to requested currency.
        """
        ticker_symbol, native_quote = self._resolve_ticker_with_quote(asset, config)

        log.info(
            f"[yahoo] Fetching current price: asset={asset.symbol}, "
            f"ticker={ticker_symbol}, native_quote={native_quote}"
        )

        def fetch() -> Optional[float]:
            ticker = yf.Ticker(ticker_symbol)

            # Try fast_info first (faster), but it can fail with KeyError
            # for certain tickers (e.g., missing 'currentTradingPeriod')
            try:
                fast = ticker.fast_info
                if fast is not None:
                    price = fast.get("lastPrice")
                    if price is not None and price > 0:
                        log.debug(f"[yahoo] Got price from fast_info: {price}")
                        return float(price)
            except (KeyError, AttributeError, Exception) as e:
                # fast_info can throw KeyError for missing fields
                log.debug(f"[yahoo] fast_info failed: {e}")

            # Fallback to history (more reliable)
            try:
                hist = ticker.history(period="1d")
                if not hist.empty:
                    price = float(hist["Close"].iloc[-1])
                    log.debug(f"[yahoo] Got price from history: {price}")
                    return price
            except Exception as e:
                log.debug(f"[yahoo] history failed: {e}")

            # Last resort: try info dict
            try:
                info = ticker.info
                if info:
                    for key in ["regularMarketPrice", "currentPrice", "previousClose"]:
                        price = info.get(key)
                        if price is not None and price > 0:
                            log.debug(f"[yahoo] Got price from info[{key}]: {price}")
                            return float(price)
            except Exception as e:
                log.debug(f"[yahoo] info dict failed: {e}")

            return None

        price = self._fetch_with_retry(
            f"Fetch current price for {asset.symbol} ({ticker_symbol})",
            fetch,
            asset=asset,
            ticker=ticker_symbol,
        )

        log.info(
            f"[yahoo] ✓ Current price for {asset.symbol}: {price} {native_quote} ({ticker_symbol})"
        )

        return PriceResult(
            price=price,
            quote_currency=native_quote,
            source="yahoo",
            timestamp=datetime.now(),
            ticker_used=ticker_symbol,
        )

    def get_historical_price(
        self,
        asset: Asset,
        dt: datetime,
        config: Optional[PriceGetterConfig] = None,
    ) -> PriceResult:
        """
        Fetch historical asset price from Yahoo Finance.

        Args:
            asset: Asset object.
            dt: Datetime for price lookup.
            config: Optional price getter configuration with ticker override.

        Returns:
            PriceResult: Price at specified datetime in the ticker's native quote currency.
                        PriceService handles conversion to requested currency.
        """
        ticker_symbol, native_quote = self._resolve_ticker_with_quote(asset, config)

        log.info(
            f"[yahoo] Fetching historical price: asset={asset.symbol}, "
            f"date={dt.date()}, ticker={ticker_symbol}, native_quote={native_quote}"
        )

        def fetch() -> Optional[float]:
            ticker = yf.Ticker(ticker_symbol)

            # Fetch a range around target date (Yahoo has daily granularity)
            start_date = dt - timedelta(days=7)
            end_date = dt + timedelta(days=2)

            hist = ticker.history(start=start_date, end=end_date)

            if hist.empty:
                log.warning(f"[yahoo] No history data for {ticker_symbol}")
                return None

            target_date = dt.date()
            hist_dates = hist.index.date

            # Find exact match or closest previous date
            exact_idx = None
            closest_before_idx = None

            for idx, hist_date in enumerate(hist_dates):
                if hist_date == target_date:
                    exact_idx = idx
                    break
                elif hist_date < target_date:
                    closest_before_idx = idx

            if exact_idx is not None:
                return float(hist["Close"].iloc[exact_idx])
            elif closest_before_idx is not None:
                return float(hist["Close"].iloc[closest_before_idx])
            else:
                # Use first available if all dates are after target
                return float(hist["Close"].iloc[0])

        price = self._fetch_with_retry(
            f"Fetch historical price for {asset.symbol} at {dt.date()} ({ticker_symbol})",
            fetch,
            asset=asset,
            ticker=ticker_symbol,
        )

        log.info(
            f"[yahoo] ✓ Historical price for {asset.symbol} at {dt.date()}: "
            f"{price} {native_quote} ({ticker_symbol})"
        )

        return PriceResult(
            price=price,
            quote_currency=native_quote,
            source="yahoo",
            timestamp=dt,
            ticker_used=ticker_symbol,
        )

    def get_historical_prices_range(
        self,
        asset: Asset,
        start: date,
        end: date,
        config: Optional[PriceGetterConfig] = None,
    ) -> List[PriceResult]:
        ticker_symbol, native_quote = self._resolve_ticker_with_quote(asset, config)
        hist = yf.Ticker(ticker_symbol).history(start=start, end=end + timedelta(days=1))
        bars: List[PriceResult] = []
        if hist.empty:
            return bars
        for idx, close in hist["Close"].items():
            if close is None or math.isnan(float(close)):
                continue
            bars.append(PriceResult(
                price=float(close),
                quote_currency=native_quote,
                source="yahoo",
                timestamp=datetime.combine(idx.date(), datetime.min.time()),
                ticker_used=ticker_symbol,
            ))
        return bars
