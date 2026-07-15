"""
Shared fixtures for price getter tests.

Updated to use new PriceGetterConfig pattern instead of price_getter_asset_id.
"""

import pytest
from unittest.mock import MagicMock

from backend.services.price_getters import get_price_getter, BasePriceGetter
from backend.services.price_getters.base import (
    PriceErrorReason,
    PriceGetterConfig,
    PriceGetterError,
)


# ============================================================================
# Flaky Live-API Error Handling
# ============================================================================

# Reasons that indicate a transient/environmental problem with a free live
# API (rate limiting, temporary outage, no data for the moment) rather than a
# bug in our code — safe to skip instead of failing the test.
FLAKY_PRICE_ERROR_REASONS = {
    PriceErrorReason.API_RATE_LIMITED,
    PriceErrorReason.API_UNAVAILABLE,
    PriceErrorReason.NO_DATA_RETURNED,
    PriceErrorReason.NETWORK_ERROR,
    PriceErrorReason.TIMEOUT,
}


def call_or_skip_on_flaky_error(func, *args, **kwargs):
    """Call a live price-getter API function, skipping the test instead of
    failing when the free API is rate-limiting us (HTTP 429), temporarily
    unavailable, or returning no data — a known flaky condition, not a code
    bug.
    """
    try:
        return func(*args, **kwargs)
    except PriceGetterError as e:
        original = str(e.original_error) if e.original_error else ""
        if (
            e.reason in FLAKY_PRICE_ERROR_REASONS
            or "429" in original
            or "Too Many Requests" in original
        ):
            pytest.skip(f"Live price API flaky/unavailable: {e}")
        raise


# ============================================================================
# Mock Asset Fixtures
# ============================================================================


@pytest.fixture
def mock_asset_aapl():
    """Mock AAPL stock asset - most reliable for Yahoo Finance."""
    asset = MagicMock()
    asset.asset_id = 1
    asset.symbol = "AAPL"
    return asset


@pytest.fixture
def mock_asset_msft():
    """Mock MSFT stock asset."""
    asset = MagicMock()
    asset.asset_id = 2
    asset.symbol = "MSFT"
    return asset


@pytest.fixture
def mock_asset_spy():
    """Mock SPY ETF asset - very liquid, reliable data."""
    asset = MagicMock()
    asset.asset_id = 3
    asset.symbol = "SPY"
    return asset


@pytest.fixture
def mock_asset_btc():
    """Mock BTC crypto asset (symbol only, no config)."""
    asset = MagicMock()
    asset.asset_id = 4
    asset.symbol = "BTC"
    return asset


@pytest.fixture
def mock_asset_eth():
    """Mock ETH crypto asset (symbol only, no config)."""
    asset = MagicMock()
    asset.asset_id = 5
    asset.symbol = "ETH"
    return asset


@pytest.fixture
def mock_asset_no_ticker():
    """Mock asset with no ticker symbol."""
    asset = MagicMock()
    asset.asset_id = 99
    asset.symbol = None
    return asset


# ============================================================================
# PriceGetterConfig Fixtures
# ============================================================================


@pytest.fixture
def config_btc_usd():
    """Config for BTC-USD Yahoo ticker."""
    return PriceGetterConfig(asset_id="BTC-USD")


@pytest.fixture
def config_eth_usd():
    """Config for ETH-USD Yahoo ticker."""
    return PriceGetterConfig(asset_id="ETH-USD")


@pytest.fixture
def config_bitcoin_coingecko():
    """Config for bitcoin CoinGecko ID."""
    return PriceGetterConfig(asset_id="bitcoin")


@pytest.fixture
def config_ethereum_coingecko():
    """Config for ethereum CoinGecko ID."""
    return PriceGetterConfig(asset_id="ethereum")


# ============================================================================
# Price Getter Fixtures
# ============================================================================


@pytest.fixture
def yahoo_getter() -> BasePriceGetter:
    """Get Yahoo price getter instance."""
    return get_price_getter("yahoo")


@pytest.fixture
def yahoo_direct_getter() -> BasePriceGetter:
    """Get Yahoo Direct (Chart API v8) price getter instance."""
    return get_price_getter("yahoo_direct")


@pytest.fixture
def coingecko_getter() -> BasePriceGetter:
    """Get CoinGecko price getter instance."""
    return get_price_getter("coingecko")


@pytest.fixture
def marketstack_getter() -> BasePriceGetter:
    """Get Marketstack price getter instance."""
    return get_price_getter("marketstack")


@pytest.fixture
def alphavantage_getter() -> BasePriceGetter:
    """Get Alpha Vantage price getter instance."""
    return get_price_getter("alphavantage")


@pytest.fixture
def forex_getter() -> BasePriceGetter:
    """Get Forex price getter instance."""
    return get_price_getter("forex")
