"""
Mock Price Getter for Manual Testing.

Returns random prices within configurable ranges per asset type.
Enable via PRICE_GETTER_OVERRIDE=mock environment variable.

Features:
- Per-asset-type price ranges (crypto, stock, fiat)
- Deterministic seed support via MOCK_PRICES_SEED for reproducible tests
- Prominent warning logging to indicate prices are fake

Usage:
    # Enable mock prices for quick manual testing
    PRICE_GETTER_OVERRIDE=mock python -m backend.api.run
    
    # With reproducible random prices
    PRICE_GETTER_OVERRIDE=mock MOCK_PRICES_SEED=42 python -m backend.api.run
"""

import random
from datetime import datetime
from typing import Optional, Dict, Tuple

from backend.config.loader import configure_logging, get_mock_prices_seed
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
        """Initialize mock price getter with seed and log warning."""
        super().__init__()
        
        # Initialize random seed if configured
        seed = get_mock_prices_seed()
        if seed is not None:
            random.seed(seed)
            log.warning(
                f"🎲 MockPriceGetter initialized with seed={seed} "
                f"(prices will be deterministic)"
            )
        
        # Log prominent warning
        self._log_mock_warning()
    
    def _log_mock_warning(self) -> None:
        """Log prominent warning that prices are fake."""
        warning_banner = """
╔══════════════════════════════════════════════════════════════════════╗
║  ⚠️  MOCK PRICE SERVICE ACTIVE - ALL PRICES ARE FAKE!                 ║
║                                                                      ║
║  This mode is for testing only. Prices are randomly generated        ║
║  and do not reflect real market values.                              ║
║                                                                      ║
║  Disable by removing PRICE_GETTER_OVERRIDE environment variable.     ║
╚══════════════════════════════════════════════════════════════════════╝
"""
        log.warning(warning_banner)
        # Also print to stdout for visibility in all contexts
        print(warning_banner)

    def _get_price_range(self, asset: Asset) -> Tuple[float, float]:
        """Get the price range for an asset based on its type."""
        price_type = (asset.price_type or "crypto").lower()
        return PRICE_RANGES.get(price_type, DEFAULT_RANGE)

    def _generate_price(self, asset: Asset) -> float:
        """Generate a random price within the asset type's range."""
        min_price, max_price = self._get_price_range(asset)
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
            config: Optional configuration (ignored in mock)
            
        Returns:
            PriceResult with random price
        """
        price = self._generate_price(asset)
        
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
            config: Optional configuration (ignored in mock)
            
        Returns:
            PriceResult with random price
        """
        price = self._generate_price(asset)
        
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
