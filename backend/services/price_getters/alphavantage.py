"""
Alpha Vantage Price Getter.

Uses Alpha Vantage API for stock/ETF and crypto prices.
Free tier: 25 requests/day (no credit card required).
Get a free API key at: https://www.alphavantage.co/support/#api-key

Supported endpoints:
- TIME_SERIES_DAILY: Stocks, ETFs, mutual funds
- DIGITAL_CURRENCY_DAILY: Cryptocurrencies
- GLOBAL_QUOTE: Real-time quote (stocks)

The external_id should be the Alpha Vantage ticker symbol:
- Stocks: "AAPL", "MSFT", "PE500.PA"
- Crypto: "BTC" (base symbol, quote handled separately)

Quote Currency Handling:
- Stock prices returned in native exchange currency
- Crypto prices can be requested in any fiat currency
- Configure native_quote_currency in params if needed
"""

import os
from datetime import datetime, timedelta
from typing import Optional, Tuple

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

log = configure_logging("alphavantage_price_getter")

# Alpha Vantage API base
API_BASE = "https://www.alphavantage.co/query"
REQUEST_TIMEOUT = 15


class AlphaVantagePriceGetter(BasePriceGetter):
    """
    Price getter using Alpha Vantage API.

    Free tier: 25 requests/day (rate limited, not per-minute).
    Best used as a fallback/historical-backfill getter, not primary.

    API key is read from:
    1. ALPHAVANTAGE_API_KEY environment variable
    2. config.extra["api_key"] per-asset override

    Ticker Resolution:
    - Uses config.external_id from database
    - Falls back to asset.symbol
    """

    name = "alphavantage"

    DEFAULT_NATIVE_QUOTE = "USD"

    def __init__(self):
        """Initialize Alpha Vantage price getter."""
        super().__init__()
        self._api_key = os.environ.get("ALPHAVANTAGE_API_KEY", "demo")
        self._session = requests.Session()

    def _get_api_key(self, config: Optional[PriceGetterConfig] = None) -> str:
        """Get API key from config or environment."""
        if config and config.extra and config.extra.get("api_key"):
            return config.extra["api_key"]
        return self._api_key

    def _resolve_ticker_with_quote(
        self, asset: Asset, config: Optional[PriceGetterConfig]
    ) -> Tuple[str, str]:
        """Resolve ticker and native quote currency."""
        if config and config.external_id:
            ticker = config.external_id
        else:
            ticker = asset.symbol.upper()

        native_quote = self.DEFAULT_NATIVE_QUOTE
        if config and config.extra:
            native_quote = config.extra.get("native_quote_currency", self.DEFAULT_NATIVE_QUOTE)

        return ticker, native_quote.upper()

    def _is_crypto(self, asset: Asset) -> bool:
        """Check if asset is crypto type."""
        return getattr(asset, "price_type", None) == "crypto"

    def _fetch_api(self, params: dict, api_key: str) -> dict:
        """Make API request to Alpha Vantage."""
        params["apikey"] = api_key

        try:
            resp = self._session.get(API_BASE, params=params, timeout=REQUEST_TIMEOUT)
        except requests.exceptions.RequestException as e:
            raise PriceGetterError(
                message=f"[alphavantage] HTTP request failed: {e}",
                getter_name=self.name,
                reason=PriceErrorReason.NETWORK_ERROR,
            )

        if resp.status_code != 200:
            raise PriceGetterError(
                message=f"[alphavantage] API returned HTTP {resp.status_code}",
                getter_name=self.name,
                reason=PriceErrorReason.API_ERROR,
            )

        data = resp.json()

        # Check for API error messages
        if "Error Message" in data:
            raise PriceGetterError(
                message=f"[alphavantage] {data['Error Message']}",
                getter_name=self.name,
                reason=PriceErrorReason.TICKER_NOT_FOUND,
            )

        if "Note" in data:
            # Rate limit message
            raise PriceGetterError(
                message=f"[alphavantage] Rate limited: {data['Note']}",
                getter_name=self.name,
                reason=PriceErrorReason.API_RATE_LIMITED,
            )

        if "Information" in data and "API rate limit" in data.get("Information", ""):
            raise PriceGetterError(
                message=f"[alphavantage] Rate limited: {data['Information']}",
                getter_name=self.name,
                reason=PriceErrorReason.API_RATE_LIMITED,
            )

        return data

    def get_current_price(
        self, asset: Asset, config: Optional[PriceGetterConfig] = None
    ) -> PriceResult:
        """Fetch current price from Alpha Vantage."""
        ticker, native_quote = self._resolve_ticker_with_quote(asset, config)
        api_key = self._get_api_key(config)
        is_crypto = self._is_crypto(asset)

        log.info(
            f"[alphavantage] Fetching current price: asset={asset.symbol}, "
            f"ticker={ticker}, crypto={is_crypto}"
        )

        def fetch() -> Optional[float]:
            if is_crypto:
                # Use CURRENCY_EXCHANGE_RATE for real-time crypto
                data = self._fetch_api({
                    "function": "CURRENCY_EXCHANGE_RATE",
                    "from_currency": ticker,
                    "to_currency": native_quote,
                }, api_key)
                rate_data = data.get("Realtime Currency Exchange Rate", {})
                price_str = rate_data.get("5. Exchange Rate")
                if price_str:
                    return float(price_str)
                return None
            else:
                # Use GLOBAL_QUOTE for stocks
                data = self._fetch_api({
                    "function": "GLOBAL_QUOTE",
                    "symbol": ticker,
                }, api_key)
                quote = data.get("Global Quote", {})
                price_str = quote.get("05. price")
                if price_str:
                    return float(price_str)
                return None

        price = self._fetch_with_retry(
            f"Fetch current price for {asset.symbol} ({ticker})",
            fetch,
            asset=asset,
            ticker=ticker,
        )

        log.info(f"[alphavantage] Current price for {asset.symbol}: {price} {native_quote}")

        return PriceResult(
            price=price,
            quote_currency=native_quote,
            source="alphavantage",
            timestamp=datetime.now(),
            ticker_used=ticker,
        )

    def get_historical_price(
        self, asset: Asset, dt: datetime, config: Optional[PriceGetterConfig] = None
    ) -> PriceResult:
        """Fetch historical price from Alpha Vantage."""
        ticker, native_quote = self._resolve_ticker_with_quote(asset, config)
        api_key = self._get_api_key(config)
        is_crypto = self._is_crypto(asset)
        target_date = dt.strftime("%Y-%m-%d")

        log.info(
            f"[alphavantage] Fetching historical price: asset={asset.symbol}, "
            f"date={target_date}, ticker={ticker}, crypto={is_crypto}"
        )

        def fetch() -> Optional[float]:
            if is_crypto:
                data = self._fetch_api({
                    "function": "DIGITAL_CURRENCY_DAILY",
                    "symbol": ticker,
                    "market": native_quote,
                }, api_key)
                ts = data.get("Time Series (Digital Currency Daily)", {})
            else:
                data = self._fetch_api({
                    "function": "TIME_SERIES_DAILY",
                    "symbol": ticker,
                    "outputsize": "full",  # Get full history
                }, api_key)
                ts = data.get("Time Series (Daily)", {})

            if not ts:
                return None

            # Try exact date first, then closest previous date within 5 days
            for offset in range(6):
                check_date = (dt - timedelta(days=offset)).strftime("%Y-%m-%d")
                if check_date in ts:
                    day_data = ts[check_date]
                    if is_crypto:
                        price_str = day_data.get(f"4a. close ({native_quote})")
                        if not price_str:
                            price_str = day_data.get("4. close")
                    else:
                        price_str = day_data.get("4. close")
                    if price_str:
                        return float(price_str)
            return None

        price = self._fetch_with_retry(
            f"Fetch historical price for {asset.symbol} at {target_date} ({ticker})",
            fetch,
            asset=asset,
            ticker=ticker,
        )

        log.info(
            f"[alphavantage] Historical price for {asset.symbol} at {target_date}: "
            f"{price} {native_quote}"
        )

        return PriceResult(
            price=price,
            quote_currency=native_quote,
            source="alphavantage",
            timestamp=dt,
            ticker_used=ticker,
        )
