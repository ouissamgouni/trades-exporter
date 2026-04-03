"""Mock Price Getter for Testing.

Returns deterministic prices from config when available, otherwise random
prices within configurable ranges per asset type.
Enabled/disabled via the mock_mode_enabled DB setting (UI toggle).

Features:
- Deterministic prices via params: {"prices": {"2025-01-15T10:00:00": 40000, "current": 55000}}
- Per-asset-type random ranges (crypto, stock, fiat) as fallback
- Per-asset range overrides via params: {"min_price": X, "max_price": Y}
- Optional quote_currency override via params: {"quote_currency": "EUR"}

Usage:
    # Enable per-asset via the UI mock pricing toggle in Assets Editor
    # Configure deterministic prices via prices.yaml in scenario seed data
"""

import random
from datetime import datetime, timedelta
from typing import Optional, Dict, Tuple

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
    "crypto": (100.0, 50000.0),      # BTC-like range: $100 to $50,000
    "stock": (10.0, 500.0),          # Stock range: $10 to $500
    "fiat": (0.5, 2.0),              # Forex range: 0.5 to 2.0 (relative rates)
}

# Default range for unknown asset types
DEFAULT_RANGE: Tuple[float, float] = (1.0, 1000.0)

# Tolerance for matching historical datetime keys (±15 min, same as PriceCache)
PRICE_MATCH_TOLERANCE = timedelta(minutes=15)


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

    def _lookup_historical_price(
        self, prices: Dict[str, float], dt: datetime
    ) -> Optional[float]:
        """
        Find the closest price entry within ±15 min of `dt`.

        Falls back to the "current" key if no datetime key matches.
        Returns None if nothing matches.
        """
        best_price: Optional[float] = None
        best_delta: Optional[timedelta] = None

        for key, value in prices.items():
            if key == "current":
                continue
            try:
                key_dt = datetime.fromisoformat(key)
                delta = abs(dt - key_dt)
                if delta <= PRICE_MATCH_TOLERANCE:
                    if best_delta is None or delta < best_delta:
                        best_price = float(value)
                        best_delta = delta
            except (ValueError, TypeError):
                continue

        if best_price is not None:
            return best_price

        # Fall back to "current"
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

        Looks up the closest datetime key within ±15 min, then falls back
        to "current", then falls back to random.
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
