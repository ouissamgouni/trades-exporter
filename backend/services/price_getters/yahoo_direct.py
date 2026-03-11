"""
Yahoo Finance Direct Price Getter (Chart API v8).

Uses Yahoo Finance Chart API v8 directly via HTTP requests.
Does NOT use the yfinance library, avoiding the fc.yahoo.com crumb/cookie
mechanism which can fail in certain DNS environments (e.g., Tailscale, corporate VPNs).

This getter hits `query2.finance.yahoo.com` directly and requires no API key.

The external_id should be the full Yahoo Finance ticker:
- Crypto: "BTC-USD", "ETH-EUR"
- Forex: "EURUSD=X", "GBPUSD=X"  
- Stocks: "AAPL", "MSFT"
- ETFs: "PE500.PA", "AGGU.L"
- Funds: "ERDK.F", "0P0001IMHW.F"

Quote Currency Handling:
- Prices are returned in the ticker's native currency (from API response metadata)
- The PriceService handles conversion to the requested quote currency
- Configure native_quote_currency in AssetPriceGetter.params to override if needed
"""

from datetime import datetime, date, timedelta
from typing import Optional, Tuple, Dict, Any, List

import requests

from backend.config.loader import configure_logging
from backend.db.models import Asset
from backend.services.price_getters.base import (
    BasePriceGetter,
    PriceErrorReason,
    PriceGetterConfig,
    PriceGetterError,
    PriceResult,
)

log = configure_logging("yahoo_direct_price_getter")

# Yahoo Chart API v8 base URL
CHART_API_BASE = "https://query2.finance.yahoo.com/v8/finance/chart"

# Default headers to avoid being blocked
DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
}

# Request timeout in seconds
REQUEST_TIMEOUT = 15


class YahooDirectPriceGetter(BasePriceGetter):
    """
    Price getter using Yahoo Finance Chart API v8 directly via HTTP.

    This is an alternative to the yfinance-based YahooPriceGetter that:
    - Does NOT require fc.yahoo.com DNS (works behind VPNs/Tailscale)
    - Uses query2.finance.yahoo.com Chart API v8 directly
    - No external library dependencies beyond `requests`
    - Returns currency info from API response metadata

    Ticker Resolution:
    - Uses config.external_id from database (AssetPriceGetter.external_id)
    - Falls back to asset.symbol

    Configure via UI: Assets > [asset] > Price Getters > Add yahoo_direct > External ID.
    """

    name = "yahoo_direct"

    DEFAULT_NATIVE_QUOTE = "USD"

    def __init__(self):
        """Initialize Yahoo Direct price getter."""
        super().__init__()
        self._session = requests.Session()
        self._session.headers.update(DEFAULT_HEADERS)

    def _parse_ticker_quote_currency(self, ticker: str) -> Optional[str]:
        """
        Try to parse quote currency from a Yahoo Finance ticker.

        Args:
            ticker: Yahoo Finance ticker (e.g., "BTC-USD", "EURUSD=X")

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

        return None

    def _resolve_ticker_with_quote(
        self,
        asset: Asset,
        config: Optional[PriceGetterConfig],
    ) -> Tuple[str, str]:
        """
        Resolve ticker symbol and its native quote currency.

        Returns:
            Tuple of (ticker_symbol, native_quote_currency)
        """
        if config and config.external_id:
            ticker = config.external_id
            native_quote = config.extra.get("native_quote_currency") if config.extra else None
            if not native_quote:
                native_quote = self._parse_ticker_quote_currency(ticker)
            if not native_quote:
                native_quote = self.DEFAULT_NATIVE_QUOTE
            return ticker, native_quote.upper()

        ticker = asset.symbol.upper()
        native_quote = self._parse_ticker_quote_currency(ticker)
        if not native_quote:
            native_quote = self.DEFAULT_NATIVE_QUOTE
        return ticker, native_quote.upper()

    def _fetch_chart(
        self, ticker: str, params: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Fetch data from Yahoo Chart API v8.

        Args:
            ticker: Yahoo Finance ticker symbol
            params: Query parameters (interval, range, period1, period2, etc.)

        Returns:
            The chart result dict from Yahoo API.

        Raises:
            PriceGetterError: If API call fails or returns no data.
        """
        url = f"{CHART_API_BASE}/{ticker}"

        try:
            response = self._session.get(url, params=params, timeout=REQUEST_TIMEOUT)
        except requests.exceptions.RequestException as e:
            raise PriceGetterError(
                message=f"[yahoo_direct] HTTP request failed for {ticker}: {e}",
                reason=PriceErrorReason.API_ERROR,
                source="yahoo_direct",
                ticker=ticker,
            )

        if response.status_code == 404:
            raise PriceGetterError(
                message=f"[yahoo_direct] Ticker '{ticker}' not found on Yahoo Finance (404)",
                reason=PriceErrorReason.TICKER_NOT_FOUND,
                source="yahoo_direct",
                ticker=ticker,
            )

        if response.status_code == 429:
            raise PriceGetterError(
                message=f"[yahoo_direct] Rate limited by Yahoo Finance (429) for {ticker}",
                reason=PriceErrorReason.RATE_LIMITED,
                source="yahoo_direct",
                ticker=ticker,
            )

        if response.status_code != 200:
            raise PriceGetterError(
                message=f"[yahoo_direct] Yahoo API returned HTTP {response.status_code} for {ticker}",
                reason=PriceErrorReason.API_ERROR,
                source="yahoo_direct",
                ticker=ticker,
            )

        try:
            data = response.json()
        except ValueError:
            raise PriceGetterError(
                message=f"[yahoo_direct] Invalid JSON response for {ticker}",
                reason=PriceErrorReason.API_ERROR,
                source="yahoo_direct",
                ticker=ticker,
            )

        chart = data.get("chart", {})
        error = chart.get("error")
        if error:
            raise PriceGetterError(
                message=f"[yahoo_direct] API error for {ticker}: {error.get('description', error)}",
                reason=PriceErrorReason.API_ERROR,
                source="yahoo_direct",
                ticker=ticker,
            )

        results = chart.get("result")
        if not results:
            raise PriceGetterError(
                message=f"[yahoo_direct] No chart data returned for {ticker}",
                reason=PriceErrorReason.NO_DATA,
                source="yahoo_direct",
                ticker=ticker,
            )

        return results[0]

    def get_current_price(
        self,
        asset: Asset,
        config: Optional[PriceGetterConfig] = None,
    ) -> PriceResult:
        """
        Fetch current asset price from Yahoo Finance Chart API.

        Uses regularMarketPrice from chart metadata (most up-to-date),
        with fallback to the latest close from recent history.
        """
        ticker_symbol, native_quote = self._resolve_ticker_with_quote(asset, config)

        log.info(
            f"[yahoo_direct] Fetching current price: asset={asset.symbol}, "
            f"ticker={ticker_symbol}, native_quote={native_quote}"
        )

        def fetch() -> Optional[float]:
            result = self._fetch_chart(ticker_symbol, {"interval": "1d", "range": "5d"})

            meta = result.get("meta", {})

            # Use currency from API if available (more reliable than our guess)
            api_currency = meta.get("currency")
            if api_currency:
                nonlocal native_quote
                native_quote = api_currency.upper()

            # Primary: regularMarketPrice from metadata
            reg_price = meta.get("regularMarketPrice")
            if reg_price is not None and reg_price > 0:
                log.debug(f"[yahoo_direct] Got regularMarketPrice: {reg_price}")
                return float(reg_price)

            # Fallback: latest close from history
            quotes = result.get("indicators", {}).get("quote", [{}])[0]
            closes = quotes.get("close", [])
            valid_closes = [c for c in closes if c is not None]
            if valid_closes:
                price = valid_closes[-1]
                log.debug(f"[yahoo_direct] Got from last close: {price}")
                return float(price)

            return None

        price = self._fetch_with_retry(
            f"Fetch current price for {asset.symbol} ({ticker_symbol})",
            fetch,
            asset=asset,
            ticker=ticker_symbol,
        )

        log.info(
            f"[yahoo_direct] ✓ Current price for {asset.symbol}: "
            f"{price} {native_quote} ({ticker_symbol})"
        )

        return PriceResult(
            price=price,
            quote_currency=native_quote,
            source="yahoo_direct",
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
        Fetch historical asset price from Yahoo Finance Chart API.

        Uses period1/period2 Unix timestamps to request a date range
        around the target date, then picks the closest available close.
        """
        ticker_symbol, native_quote = self._resolve_ticker_with_quote(asset, config)

        log.info(
            f"[yahoo_direct] Fetching historical price: asset={asset.symbol}, "
            f"date={dt.date()}, ticker={ticker_symbol}, native_quote={native_quote}"
        )

        def fetch() -> Optional[float]:
            # Request a window around the target date
            start = dt - timedelta(days=7)
            end = dt + timedelta(days=2)
            period1 = int(start.timestamp())
            period2 = int(end.timestamp())

            result = self._fetch_chart(
                ticker_symbol,
                {"interval": "1d", "period1": period1, "period2": period2},
            )

            meta = result.get("meta", {})
            api_currency = meta.get("currency")
            if api_currency:
                nonlocal native_quote
                native_quote = api_currency.upper()

            timestamps = result.get("timestamp", [])
            quotes = result.get("indicators", {}).get("quote", [{}])[0]
            closes = quotes.get("close", [])

            if not timestamps or not closes:
                return None

            # Build date->price map
            target_date = dt.date()
            best_price = None
            best_date_diff = None

            for ts, close in zip(timestamps, closes):
                if close is None:
                    continue
                bar_date = datetime.utcfromtimestamp(ts).date()
                diff = abs((bar_date - target_date).days)

                if best_date_diff is None or diff < best_date_diff:
                    best_date_diff = diff
                    best_price = float(close)

                # Exact match — stop searching
                if diff == 0:
                    break

            return best_price

        price = self._fetch_with_retry(
            f"Fetch historical price for {asset.symbol} at {dt.date()} ({ticker_symbol})",
            fetch,
            asset=asset,
            ticker=ticker_symbol,
        )

        log.info(
            f"[yahoo_direct] ✓ Historical price for {asset.symbol} at {dt.date()}: "
            f"{price} {native_quote} ({ticker_symbol})"
        )

        return PriceResult(
            price=price,
            quote_currency=native_quote,
            source="yahoo_direct",
            timestamp=dt,
            ticker_used=ticker_symbol,
        )

    # -----------------------------------------------------------------
    # Bulk daily series (for benchmark comparisons)
    # -----------------------------------------------------------------

    def get_daily_series(
        self,
        ticker: str,
        start_date: date,
        end_date: date,
    ) -> List[Dict[str, Any]]:
        """
        Fetch daily close prices for a Yahoo Finance ticker over a date range.

        This bypasses the Asset-based workflow and fetches directly by ticker.
        Intended for external benchmark indices (^GSPC, ^IXIC, BTC-USD, etc.).

        Args:
            ticker: Yahoo Finance ticker (e.g., "^GSPC", "BTC-USD").
            start_date: First date (inclusive).
            end_date: Last date (inclusive).

        Returns:
            List of {"date": "YYYY-MM-DD", "close": float} dicts, sorted by date.

        Raises:
            PriceGetterError: On API failure.
        """
        period1 = int(datetime.combine(start_date, datetime.min.time()).timestamp())
        period2 = int(datetime.combine(end_date + timedelta(days=1), datetime.min.time()).timestamp())

        log.info(
            f"[yahoo_direct] Fetching daily series: ticker={ticker}, "
            f"range={start_date} → {end_date}"
        )

        result = self._fetch_chart(
            ticker,
            {"interval": "1d", "period1": period1, "period2": period2},
        )

        timestamps = result.get("timestamp", [])
        quotes = result.get("indicators", {}).get("quote", [{}])[0]
        closes = quotes.get("close", [])

        points: List[Dict[str, Any]] = []
        for ts, close in zip(timestamps, closes):
            if close is None:
                continue
            bar_date = datetime.utcfromtimestamp(ts).date()
            points.append({"date": bar_date.isoformat(), "close": round(float(close), 4)})

        log.info(f"[yahoo_direct] ✓ Got {len(points)} daily bars for {ticker}")
        return points
