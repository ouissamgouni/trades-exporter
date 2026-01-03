"""
Price Getter Package.

Provides price getter implementations for fetching asset prices
from various data sources (Yahoo Finance, CoinGecko, etc.).

Usage:
    from backend.services.price_getters import get_price_getter, list_price_getters

    # Get a specific price getter
    yahoo = get_price_getter("yahoo")
    price = yahoo.get_current_price(asset, "USD")

    # List available price getters
    available = list_price_getters()  # ["coingecko", "yahoo"]

Adding New Price Getters:
    1. Create a new file (e.g., binance.py)
    2. Create class inheriting from BasePriceGetter
    3. Set `name` class attribute
    4. Implement get_current_price and get_historical_price
    5. Add to registry.py's _get_price_getter_classes()
"""

# Base class for creating new price getters
from backend.services.price_getters.base import (
    BasePriceGetter,
    PriceResult,
    PriceGetterConfig,
)

# Concrete implementations
from backend.services.price_getters.coingecko import CoinGeckoPriceGetter
from backend.services.price_getters.yahoo import YahooPriceGetter
from backend.services.price_getters.datareader import DataReaderPriceGetter
from backend.services.price_getters.forex import ForexPriceGetter

# Registry functions (the main API)
from backend.services.price_getters.registry import (
    get_price_getter,
    list_price_getters,
    get_default_price_getter_name,
    register_price_getter,
    reset_registry,
    DEFAULT_PRICE_GETTER,
)

# Backward compatibility alias
get_default_price_getter = get_default_price_getter_name

__all__ = [
    # Base class
    "BasePriceGetter",
    "PriceResult",
    "PriceGetterConfig",
    # Implementations
    "CoinGeckoPriceGetter",
    "YahooPriceGetter",
    "DataReaderPriceGetter",
    "ForexPriceGetter",
    # Registry API
    "get_price_getter",
    "list_price_getters",
    "get_default_price_getter",
    "get_default_price_getter_name",
    "register_price_getter",
    "reset_registry",
    "DEFAULT_PRICE_GETTER",
]
