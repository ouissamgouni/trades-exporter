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
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional, Tuple

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

API_BASE = "https://api.marketstack.com/v1"
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
    supports_range = True
    PAGE_LIMIT = 1000  # API max rows per request
    MAX_SYMBOLS_PER_REQUEST = 100

    def __init__(self):
        super().__init__()
        self._api_key = os.environ.get("MARKETSTACK_API_KEY", "")
        self._session = requests.Session()
        # Free plan serves 1 year of history; raise for paid plans
        self.max_history_days = int(os.environ.get("MARKETSTACK_HISTORY_DAYS", "365"))

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
            native_quote = config.extra.get(
                "native_quote_currency", self.DEFAULT_NATIVE_QUOTE
            )
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

        log.info(
            f"[marketstack] Fetching current price: asset={asset.symbol}, ticker={ticker}"
        )

        def fetch() -> Optional[float]:
            data = self._fetch_api(
                "eod/latest", {"symbols": ticker, "limit": 1}, api_key
            )
            eod_data = data.get("data", [])
            if eod_data and len(eod_data) > 0:
                close = eod_data[0].get("close")
                if close is not None:
                    return float(close)
            return None

        price = self._fetch_with_retry(
            f"Fetch current price for {asset.symbol} ({ticker})",
            fetch,
            asset=asset,
            ticker=ticker,
        )

        log.info(
            f"[marketstack] Current price for {asset.symbol}: {price} {native_quote}"
        )

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
            data = self._fetch_api(
                "eod",
                {
                    "symbols": ticker,
                    "date_from": date_from,
                    "date_to": date_to,
                    "limit": 10,
                    "sort": "DESC",
                },
                api_key,
            )
            eod_data = data.get("data", [])
            # Pick closest date
            if eod_data:
                close = eod_data[0].get("close")
                if close is not None:
                    return float(close)
            return None

        price = self._fetch_with_retry(
            f"Fetch historical price for {asset.symbol} at {target_date} ({ticker})",
            fetch,
            asset=asset,
            ticker=ticker,
        )

        log.info(
            f"[marketstack] Historical price for {asset.symbol} at {target_date}: {price} {native_quote}"
        )

        return PriceResult(
            price=price,
            quote_currency=native_quote,
            source="marketstack",
            timestamp=dt,
            ticker_used=ticker,
        )

    def get_historical_prices_range(
        self,
        asset: Asset,
        start: date,
        end: date,
        config: Optional[PriceGetterConfig] = None,
    ) -> List[PriceResult]:
        return self.get_historical_prices_range_many([(asset, config)], start, end).get(
            asset.asset_id, []
        )

    def _batch_api_key(self, items: List[Tuple[Asset, Optional[PriceGetterConfig]]]) -> str:
        return next(
            (
                self._get_api_key(c)
                for _, c in items
                if c and c.extra and c.extra.get("api_key")
            ),
            self._api_key,
        )

    def get_current_prices_many(
        self, items: List[Tuple[Asset, Optional[PriceGetterConfig]]]
    ) -> Dict[int, PriceResult]:
        """eod/latest takes many symbols per request."""
        api_key = self._batch_api_key(items)
        if not api_key:
            return {}
        by_ticker: Dict[str, List[Tuple[int, str]]] = {}
        for asset, config in items:
            ticker, native_quote = self._resolve_ticker_with_quote(asset, config)
            by_ticker.setdefault(ticker.upper(), []).append((asset.asset_id, native_quote))

        results: Dict[int, PriceResult] = {}
        tickers = list(by_ticker)
        for i in range(0, len(tickers), self.MAX_SYMBOLS_PER_REQUEST):
            chunk = tickers[i : i + self.MAX_SYMBOLS_PER_REQUEST]
            try:
                data = self._fetch_api(
                    "eod/latest", {"symbols": ",".join(chunk), "limit": len(chunk)}, api_key
                )
            except PriceGetterError as e:
                log.warning(f"[marketstack] Batch current price failed for {chunk}: {e}")
                continue
            for row in data.get("data") or []:
                symbol = (row.get("symbol") or (chunk[0] if len(chunk) == 1 else "")).upper()
                close = row.get("close")
                if close is None or symbol not in by_ticker:
                    continue
                for asset_id, native_quote in by_ticker[symbol]:
                    results.setdefault(asset_id, PriceResult(
                        price=float(close),
                        quote_currency=native_quote,
                        source="marketstack",
                        timestamp=datetime.now(),
                        ticker_used=symbol,
                    ))
        return results

    def get_historical_prices_range_many(
        self,
        items: List[Tuple[Asset, Optional[PriceGetterConfig]]],
        start: date,
        end: date,
    ) -> Dict[int, List[PriceResult]]:
        """All symbols in one paginated eod call: 1 request per 1000 rows, not per day/asset."""
        api_key = self._batch_api_key(items)
        if not api_key:
            raise PriceGetterError(
                message="[marketstack] No API key configured",
                getter_name=self.name,
                reason=PriceErrorReason.MISSING_API_KEY,
            )

        by_ticker: Dict[str, List[Tuple[int, str]]] = {}
        for asset, config in items:
            ticker, native_quote = self._resolve_ticker_with_quote(asset, config)
            by_ticker.setdefault(ticker.upper(), []).append(
                (asset.asset_id, native_quote)
            )
        results: Dict[int, List[PriceResult]] = {
            asset.asset_id: [] for asset, _ in items
        }

        tickers = list(by_ticker)
        for i in range(0, len(tickers), self.MAX_SYMBOLS_PER_REQUEST):
            chunk = tickers[i : i + self.MAX_SYMBOLS_PER_REQUEST]
            offset = 0
            while True:
                log.info(
                    f"[marketstack] Fetching eod range {start}..{end} for {chunk} (offset={offset})"
                )
                data = self._fetch_api(
                    "eod",
                    {
                        "symbols": ",".join(chunk),
                        "date_from": start.isoformat(),
                        "date_to": end.isoformat(),
                        "limit": self.PAGE_LIMIT,
                        "offset": offset,
                        "sort": "ASC",
                    },
                    api_key,
                )
                rows = data.get("data") or []
                for row in rows:
                    symbol = (
                        row.get("symbol") or (chunk[0] if len(chunk) == 1 else "")
                    ).upper()
                    close = row.get("close")
                    if close is None or not row.get("date") or symbol not in by_ticker:
                        continue
                    bar_dt = datetime.combine(
                        date.fromisoformat(row["date"][:10]), datetime.min.time()
                    )
                    for asset_id, native_quote in by_ticker[symbol]:
                        results[asset_id].append(
                            PriceResult(
                                price=float(close),
                                quote_currency=native_quote,
                                source="marketstack",
                                timestamp=bar_dt,
                                ticker_used=symbol,
                            )
                        )
                offset += len(rows)
                total = (data.get("pagination") or {}).get("total") or 0
                # pagination.total can be capped at the page size, so a full page means "maybe more"
                if not rows or (offset >= total and len(rows) < self.PAGE_LIMIT):
                    break

        log.info(
            f"[marketstack] Range {start}..{end}: "
            + ", ".join(
                f"{t}={sum(len(results[a]) for a, _ in by_ticker[t])}" for t in tickers
            )
        )
        return results
