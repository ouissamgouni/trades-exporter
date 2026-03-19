"""Mock Price Getter for Testing.

Returns random prices within configurable ranges per asset type.
Enabled/disabled via the mock_mode_enabled DB setting (UI toggle).

Features:
- Per-asset-type price ranges (crypto, stock, fiat)
- Per-asset range overrides via params: {"min_price": X, "max_price": Y}

Usage:
    # Enable per-asset via the UI mock pricing toggle in Assets Editor
"""

import random
from datetime import datetime
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

    def get_current_price(
        self,
        asset: Asset,
        config: Optional[PriceGetterConfig] = None,
    ) -> PriceResult:
        """
        Return a random current price for the asset.
        
        Args:
            asset: Asset to get price for
            config: Optional configuration with min_price/max_price overrides
            
        Returns:
            PriceResult with random price
        """
        price = self._generate_price(asset, config)
        
        log.debug(
            f"[MockPriceGetter] Generated price for {asset.symbol}: "
            f"{price:.2f} USD (type={asset.price_type})"
        )
        
        return PriceResult(
            price=price,
            quote_currency="USD",
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
        Return a random historical price for the asset.
        
        Args:
            asset: Asset to get price for
            dt: Historical datetime
            config: Optional configuration with min_price/max_price overrides
            
        Returns:
            PriceResult with random price
        """
        price = self._generate_price(asset, config)
        
        log.debug(
            f"[MockPriceGetter] Generated historical price for {asset.symbol} "
            f"at {dt}: {price:.2f} USD (type={asset.price_type})"
        )
        
        return PriceResult(
            price=price,
            quote_currency="USD",
            source="mock",
            timestamp=dt,
            ticker_used=asset.symbol,
        )
