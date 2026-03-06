"""
Marketstack Price Getter.

Uses Marketstack API for stock/ETF end-of-day prices.
Free tier: 100 requests/month. Standard plan: 10,000 req/month.
Get API key at: https://marketstack.com/

Supported:
- End-of-day prices for stocks and ETFs
- Historical data going back 30+ years
- Covers major world exchanges

The external_id should be the Marketstack ticker (usually same as exchange ticker).
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

log = configure_logging("marketstack_price_getter")

API_BASE = "http://api.marketstack.com/v1"
REQUEST_TIMEOUT = 10


class MarketstackPriceGetter(BasePriceGetter):
    """
    Price getter using Marketstack API.

    Free tier: 100 requests/month (HTTP only, no HTTPS on free).
    Best for European exchange ETFs where Yahoo may lack coverage.

    API key from MARKETSTACK_API_KEY env var or config.extra["api_key"].
    """

    name = "marketstack"
    max_retries = 1  # Keep fast — no retries
    DEFAULT_NATIVE_QUOTE = "USD"

    def __init__(self):
        super().__init__()
        self._api_key = os.environ.get("MARKETSTACK_API_KEY", "")
        self._session = requests.Session()

    def _get_api_key(self, config: Optional[PriceGetterConfig] = None) -> str:
        if config and config.extra and config.extra.get("api_key"):
            return config.extra["api_key"]
        return self._api_key

    def _resolve_ticker_with_quote(
        self, asset: Asset, config: Optional[PriceGetterConfig]
    ) -> Tuple[str, str]:
        if config and config.external_id:
            ticker = config.external_id
        else:
            ticker = asset.symbol.upper()
        native_quote = self.DEFAULT_NATIVE_QUOTE
        if config and config.extra:
            native_quote = config.extra.get("native_quote_currency", self.DEFAULT_NATIVE_QUOTE)
        return ticker, native_quote.upper()

    def _fetch_api(self, endpoint: str, params: dict, api_key: str) -> dict:
        params["access_key"] = api_key
        url = f"{API_BASE}/{endpoint}"
        try:
            resp = self._session.get(url, params=params, timeout=REQUEST_TIMEOUT)
        except requests.exceptions.RequestException as e:
            raise PriceGetterError(
                message=f"[marketstack] HTTP request failed: {e}",
                getter_name=self.name,
                reason=PriceErrorReason.NETWORK_ERROR,
            )
        if resp.status_code == 401:
            raise PriceGetterError(
                message="[marketstack] Invalid API key",
                getter_name=self.name,
                reason=PriceErrorReason.MISSING_API_KEY,
            )
        if resp.status_code == 429:
            raise PriceGetterError(
                message="[marketstack] Rate limit exceeded",
                getter_name=self.name,
                reason=PriceErrorReason.API_RATE_LIMITED,
            )
        if resp.status_code != 200:
            raise PriceGetterError(
                message=f"[marketstack] API returned HTTP {resp.status_code}",
                getter_name=self.name,
                reason=PriceErrorReason.API_ERROR,
            )
        data = resp.json()
        if "error" in data:
            err = data["error"]
            raise PriceGetterError(
                message=f"[marketstack] {err.get('message', err)}",
                getter_name=self.name,
                reason=PriceErrorReason.API_ERROR,
            )
        return data

    def get_current_price(
        self, asset: Asset, config: Optional[PriceGetterConfig] = None
    ) -> PriceResult:
        ticker, native_quote = self._resolve_ticker_with_quote(asset, config)
        api_key = self._get_api_key(config)

        if not api_key:
            raise PriceGetterError(
                message="[marketstack] No API key configured",
                getter_name=self.name,
                reason=PriceErrorReason.MISSING_API_KEY,
            )

        log.info(f"[marketstack] Fetching current price: asset={asset.symbol}, ticker={ticker}")

        def fetch() -> Optional[float]:
            data = self._fetch_api("eod/latest", {"symbols": ticker, "limit": 1}, api_key)
            eod_data = data.get("data", [])
            if eod_data and len(eod_data) > 0:
                close = eod_data[0].get("close")
                if close is not None:
                    return float(close)
            return None

        price = self._fetch_with_retry(
            f"Fetch current price for {asset.symbol} ({ticker})",
            fetch, asset=asset, ticker=ticker,
        )

        log.info(f"[marketstack] Current price for {asset.symbol}: {price} {native_quote}")

        return PriceResult(
            price=price,
            quote_currency=native_quote,
            source="marketstack",
            timestamp=datetime.now(),
            ticker_used=ticker,
        )

    def get_historical_price(
        self, asset: Asset, dt: datetime, config: Optional[PriceGetterConfig] = None
    ) -> PriceResult:
        ticker, native_quote = self._resolve_ticker_with_quote(asset, config)
        api_key = self._get_api_key(config)
        target_date = dt.strftime("%Y-%m-%d")

        if not api_key:
            raise PriceGetterError(
                message="[marketstack] No API key configured",
                getter_name=self.name,
                reason=PriceErrorReason.MISSING_API_KEY,
            )

        log.info(
            f"[marketstack] Fetching historical price: asset={asset.symbol}, "
            f"date={target_date}, ticker={ticker}"
        )

        def fetch() -> Optional[float]:
            # Request a small window around the target date
            date_from = (dt - timedelta(days=5)).strftime("%Y-%m-%d")
            date_to = dt.strftime("%Y-%m-%d")
            data = self._fetch_api("eod", {
                "symbols": ticker,
                "date_from": date_from,
                "date_to": date_to,
                "limit": 10,
                "sort": "DESC",
            }, api_key)
            eod_data = data.get("data", [])
            # Pick closest date
            if eod_data:
                close = eod_data[0].get("close")
                if close is not None:
                    return float(close)
            return None

        price = self._fetch_with_retry(
            f"Fetch historical price for {asset.symbol} at {target_date} ({ticker})",
            fetch, asset=asset, ticker=ticker,
        )

        log.info(f"[marketstack] Historical price for {asset.symbol} at {target_date}: {price} {native_quote}")

        return PriceResult(
            price=price,
            quote_currency=native_quote,
            source="marketstack",
            timestamp=dt,
            ticker_used=ticker,
        )
