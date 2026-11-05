"""
Price Getter Registry.

Centralized registry for price getter implementations.
Provides lazy initialization and lookup by name.

Usage:
    from backend.services.price_getters.registry import (
        get_price_getter,
        list_price_getters,
        register_price_getter,
    )

    # Get a price getter by name
    yahoo = get_price_getter("yahoo")

    # List available price getters
    available = list_price_getters()  # ["yahoo", "coingecko"]

Adding New Price Getters:
    1. Create a new file (e.g., binance.py)
    2. Create class inheriting from BasePriceGetter
    3. Set `name` class attribute
    4. Implement get_current_price and get_historical_price
    5. Add to PRICE_GETTER_CLASSES below

Mock Price Getter for Testing:
    MockPriceGetter is always registered; enabled/disabled per-asset via the DB mock_mode_enabled toggle.
"""

from typing import Dict, List, Type, Optional

from backend.config.loader import configure_logging

log = configure_logging("price_getter_registry")

# Type hint for lazy import
TYPE_CHECKING = False
if TYPE_CHECKING:
    from backend.services.price_getters.base import BasePriceGetter


# ============================================================================
# CONFIGURATION
# ============================================================================

# Default price getter when asset.price_getter is not set
DEFAULT_PRICE_GETTER = "datareader"


# ============================================================================
# REGISTRY IMPLEMENTATION
# ============================================================================

_registry: Dict[str, "BasePriceGetter"] = {}
_initialized = False


def _get_price_getter_classes() -> List[Type["BasePriceGetter"]]:
    """
    Get list of price getter classes to register.

    Imports are done here to avoid circular imports at module load time.
    Add new price getter classes to this list.
    """
    from backend.services.price_getters.yahoo import YahooPriceGetter
    from backend.services.price_getters.yahoo_direct import YahooDirectPriceGetter
    from backend.services.price_getters.coingecko import CoinGeckoPriceGetter
    from backend.services.price_getters.datareader import DataReaderPriceGetter
    from backend.services.price_getters.forex import ForexPriceGetter
    from backend.services.price_getters.alphavantage import AlphaVantagePriceGetter
    from backend.services.price_getters.marketstack import MarketstackPriceGetter

    from backend.services.price_getters.mock_getter import MockPriceGetter
    from backend.services.price_getters.manual import ManualPriceGetter

    classes = [
        DataReaderPriceGetter,  # Default for stocks - uses pandas_datareader with Stooq
        YahooPriceGetter,       # Yahoo via yfinance (requires fc.yahoo.com DNS)
        YahooDirectPriceGetter, # Yahoo via Chart API v8 (no yfinance, no crumb needed)
        CoinGeckoPriceGetter,
        ForexPriceGetter,  # For fiat currency conversion
        AlphaVantagePriceGetter,  # Alpha Vantage (free tier: 25 req/day)
        MarketstackPriceGetter,  # Marketstack (free tier: 100 req/month)
        MockPriceGetter,  # Always registered — enabled/disabled per-asset via DB
        ManualPriceGetter,  # Stored prices only (assets with no market feed)
    ]
    
    return classes


def _initialize_registry() -> None:
    """Initialize the price getter registry (lazy initialization)."""
    global _initialized
    if _initialized:
        return

    for getter_class in _get_price_getter_classes():
        try:
            instance = getter_class()
            _registry[instance.name] = instance
            log.debug(f"Registered price getter: {instance.name}")
        except Exception as e:
            log.warning(f"Failed to initialize {getter_class.__name__}: {e}")

    _initialized = True
    log.debug(f"Price getter registry initialized with {len(_registry)} getters")


def register_price_getter(getter: "BasePriceGetter") -> None:
    """
    Manually register a price getter instance.

    Useful for testing or dynamically adding price getters.

    Args:
        getter: Price getter instance to register.
    """
    _initialize_registry()
    _registry[getter.name] = getter
    log.debug(f"Manually registered price getter: {getter.name}")


def get_price_getter(name: Optional[str] = None) -> "BasePriceGetter":
    """
    Get a price getter instance by name.

    Args:
        name: Price getter name (e.g., 'yahoo', 'coingecko').
              If None, returns the default price getter.

    Returns:
        BasePriceGetter: Price getter instance.

    Raises:
        ValueError: If price getter name not found in registry.
    """
    _initialize_registry()

    getter_name = (name or DEFAULT_PRICE_GETTER).lower()

    if getter_name not in _registry:
        available = ", ".join(sorted(_registry.keys()))
        raise ValueError(
            f"Unknown price getter '{getter_name}'. Available: {available}"
        )

    return _registry[getter_name]


def list_price_getters() -> List[str]:
    """
    List all available price getter names.

    Returns:
        List[str]: Sorted list of registered price getter names.
    """
    _initialize_registry()
    return sorted(_registry.keys())


def get_default_price_getter_name() -> str:
    """
    Get the default price getter name.

    Returns:
        str: Default price getter name.
    """
    return DEFAULT_PRICE_GETTER


def reset_registry() -> None:
    """
    Reset the registry. Useful for testing.
    """
    global _initialized, _registry
    _registry = {}
    _initialized = False
