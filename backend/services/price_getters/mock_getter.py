"""Mock Price Getter for Testing.

Returns deterministic prices from config when available, otherwise random
prices within configurable ranges per asset type.
Enabled/disabled via the mock_mode_enabled DB setting (UI toggle).

Features:
- Deterministic prices via params: {"prices": {"2025-01-15T10:00:00": 40000, "current": 55000}}
- Historical lookups use last-observation-carried-forward (LOCF): the most
  recent waypoint at or before the requested date. This means a handful of
  sparse waypoints correctly cover every in-between day (a quote stays valid
  until the next quote replaces it), so no dense day-by-day data is required.
- Per-asset-type random ranges (crypto, stock, fiat) as fallback
- Per-asset range overrides via params: {"min_price": X, "max_price": Y}
- Optional quote_currency override via params: {"quote_currency": "EUR"}

Usage:
    # Enable per-asset via the UI mock pricing toggle in Assets Editor
    # Configure deterministic prices via prices.yaml in scenario seed data
"""

import random
from datetime import datetime, timezone
from typing import Any, List, Optional, Dict, Tuple

from backend.config.loader import configure_logging
from backend.db.models import Asset
from backend.services.price_getters.base import (
    BasePriceGetter,
    PriceGetterConfig,
    PriceResult,
)

log = configure_logging("mock_price_getter")


# ============================================================================
# Price Ranges by Asset Type
# ============================================================================

# (min_price, max_price) tuples per price_type
PRICE_RANGES: Dict[str, Tuple[float, float]] = {
    "crypto": (100.0, 50000.0),  # BTC-like range: $100 to $50,000
    "stock": (10.0, 500.0),  # Stock range: $10 to $500
    "fiat": (0.5, 2.0),  # Forex range: 0.5 to 2.0 (relative rates)
}

# Default range for unknown asset types
DEFAULT_RANGE: Tuple[float, float] = (1.0, 1000.0)


class MockPriceGetter(BasePriceGetter):
    """
    Mock price getter that returns random prices for testing.

    Useful for:
    - Quick manual testing without hitting external APIs
    - Testing P&L calculations with controlled (seeded) prices
    - UI development when price APIs are unavailable
    """

    name = "mock"

    # No retries needed for mock
    max_retries = 1
    initial_delay = 0.0

    def __init__(self):
        """Initialize mock price getter."""
        super().__init__()

    def _get_price_range(
        self, asset: Asset, config: Optional[PriceGetterConfig] = None
    ) -> Tuple[float, float]:
        """Get the price range, checking config.extra overrides first."""
        if config and config.extra:
            custom_min = config.extra.get("min_price")
            custom_max = config.extra.get("max_price")
            if custom_min is not None and custom_max is not None:
                try:
                    cmin, cmax = float(custom_min), float(custom_max)
                    if cmin <= cmax:
                        return (cmin, cmax)
                except (ValueError, TypeError):
                    pass  # Fall through to type-based defaults
        price_type = (asset.price_type or "crypto").lower()
        return PRICE_RANGES.get(price_type, DEFAULT_RANGE)

    def _generate_price(
        self, asset: Asset, config: Optional[PriceGetterConfig] = None
    ) -> float:
        """Generate a random price within the configured range."""
        min_price, max_price = self._get_price_range(asset, config)
        return random.uniform(min_price, max_price)

    def _get_configured_prices(
        self, config: Optional[PriceGetterConfig]
    ) -> Optional[Dict[str, float]]:
        """Return the prices dict from config.extra, or None."""
        if config and config.extra:
            prices = config.extra.get("prices")
            if isinstance(prices, dict) and prices:
                return prices
        return None

    def _get_quote_currency(self, config: Optional[PriceGetterConfig]) -> str:
        """Return quote_currency from config.extra, defaulting to USD."""
        if config and config.extra:
            return config.extra.get("quote_currency", "USD")
        return "USD"

    @staticmethod
    def _to_naive_utc(dt: datetime) -> datetime:
        """Normalize a datetime to naive UTC so aware/naive values compare safely."""
        if dt.tzinfo is not None:
            return dt.astimezone(timezone.utc).replace(tzinfo=None)
        return dt

    def _lookup_historical_price(
        self, prices: Dict[str, float], dt: datetime
    ) -> Optional[float]:
        """
        Return the price in effect on ``dt`` using last-observation-carried-forward.

        A quote remains valid until the next quote replaces it, so we return the
        most recent waypoint at or before ``dt``. For dates before the earliest
        waypoint we carry the earliest known price backward (so historical
        backfill never leaves gaps). Only when there are no dated waypoints at
        all do we fall back to the ``"current"`` key. Returns ``None`` if nothing
        is available.

        Note: waypoint keys are naive ISO strings while callers may pass a
        timezone-aware ``dt`` (e.g. midnight UTC from the snapshot backfill), so
        both sides are normalized to naive UTC before comparison.
        """
        target = self._to_naive_utc(dt)

        dated: List[Tuple[datetime, float]] = []
        for key, value in prices.items():
            if key == "current":
                continue
            try:
                key_dt = self._to_naive_utc(datetime.fromisoformat(key))
                dated.append((key_dt, float(value)))
            except (ValueError, TypeError):
                continue

        if dated:
            dated.sort(key=lambda item: item[0])
            carried: Optional[float] = None
            for key_dt, value in dated:
                if key_dt <= target:
                    carried = value
                else:
                    break
            if carried is not None:
                return carried
            # `dt` precedes every waypoint → carry the earliest known price back.
            return dated[0][1]

        # No dated waypoints → fall back to the "current" price if present.
        if "current" in prices:
            return float(prices["current"])

        return None

    def get_current_price(
        self,
        asset: Asset,
        config: Optional[PriceGetterConfig] = None,
    ) -> PriceResult:
        """
        Return a current price for the asset.

        Uses the "current" key from configured prices if available,
        otherwise falls back to a random price.
        """
        prices = self._get_configured_prices(config)
        quote_currency = self._get_quote_currency(config)

        if prices and "current" in prices:
            price = float(prices["current"])
            log.debug(
                f"[MockPriceGetter] Configured price for {asset.symbol}: "
                f"{price:.2f} {quote_currency}"
            )
        else:
            price = self._generate_price(asset, config)
            quote_currency = "USD"
            log.debug(
                f"[MockPriceGetter] Random price for {asset.symbol}: "
                f"{price:.2f} {quote_currency} (type={asset.price_type})"
            )

        return PriceResult(
            price=price,
            quote_currency=quote_currency,
            source="mock",
            timestamp=datetime.now(),
            ticker_used=asset.symbol,
        )

    def get_historical_price(
        self,
        asset: Asset,
        dt: datetime,
        config: Optional[PriceGetterConfig] = None,
    ) -> PriceResult:
        """
        Return a historical price for the asset.

        Uses last-observation-carried-forward over the configured waypoints
        (see ``_lookup_historical_price``), falling back to random only when
        no waypoints are configured.
        """
        prices = self._get_configured_prices(config)
        quote_currency = self._get_quote_currency(config)

        if prices:
            looked_up = self._lookup_historical_price(prices, dt)
            if looked_up is not None:
                log.debug(
                    f"[MockPriceGetter] Configured historical price for "
                    f"{asset.symbol} at {dt}: {looked_up:.2f} {quote_currency}"
                )
                return PriceResult(
                    price=looked_up,
                    quote_currency=quote_currency,
                    source="mock",
                    timestamp=dt,
                    ticker_used=asset.symbol,
                )

        # Fallback to random
        price = self._generate_price(asset, config)
        log.debug(
            f"[MockPriceGetter] Random historical price for {asset.symbol} "
            f"at {dt}: {price:.2f} USD (type={asset.price_type})"
        )

        return PriceResult(
            price=price,
            quote_currency="USD",
            source="mock",
            timestamp=dt,
            ticker_used=asset.symbol,
        )

    def get_daily_series(
        self,
        asset: Asset,
        start_date,
        end_date,
        config: Optional[PriceGetterConfig] = None,
    ) -> List[Dict[str, Any]]:
        """
        Build a deterministic daily close series from configured waypoints.

        Mirrors ``YahooDirectPriceGetter.get_daily_series`` so the benchmark
        endpoint can serve seeded (mock) index data in the same shape:
        ``[{"date": "YYYY-MM-DD", "close": float}, ...]`` sorted by date.

        Uses last-observation-carried-forward per day, so sparse waypoints
        produce a gap-free daily series. Returns an empty list when no
        waypoints are configured.
        """
        from datetime import date as date_cls, timedelta

        prices = self._get_configured_prices(config)
        if not prices:
            return []

        # Coerce to plain dates.
        if isinstance(start_date, datetime):
            start_date = start_date.date()
        if isinstance(end_date, datetime):
            end_date = end_date.date()
        if not isinstance(start_date, date_cls) or not isinstance(end_date, date_cls):
            return []
        if end_date < start_date:
            return []

        points: List[Dict[str, Any]] = []
        current = start_date
        while current <= end_date:
            close = self._lookup_historical_price(
                prices, datetime(current.year, current.month, current.day)
            )
            if close is not None:
                points.append(
                    {"date": current.isoformat(), "close": round(float(close), 4)}
                )
            current += timedelta(days=1)

        return points
