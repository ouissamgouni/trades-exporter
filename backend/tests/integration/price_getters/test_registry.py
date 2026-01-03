"""
Tests for Price Getter Registry.

These tests verify the registry lookup and base class functionality.
No network access required.
"""

import pytest

from backend.services.price_getters import (
    get_price_getter,
    list_price_getters,
    YahooPriceGetter,
    CoinGeckoPriceGetter,
    BasePriceGetter,
)


class TestPriceGetterRegistry:
    """Tests for the price getter registry."""

    def test_list_price_getters_returns_available_getters(self):
        """Should return list of registered price getter names."""
        getters = list_price_getters()

        assert isinstance(getters, list)
        assert len(getters) >= 2
        assert "yahoo" in getters
        assert "coingecko" in getters

    def test_get_price_getter_returns_yahoo(self):
        """Should return Yahoo price getter instance."""
        getter = get_price_getter("yahoo")

        assert isinstance(getter, YahooPriceGetter)
        assert getter.name == "yahoo"

    def test_get_price_getter_returns_coingecko(self):
        """Should return CoinGecko price getter instance."""
        getter = get_price_getter("coingecko")

        assert isinstance(getter, CoinGeckoPriceGetter)
        assert getter.name == "coingecko"

    def test_get_price_getter_default_returns_yahoo(self):
        """Should return default (Yahoo) when no name specified."""
        getter = get_price_getter()

        assert getter.name == "yahoo"

    def test_get_price_getter_unknown_raises_error(self):
        """Should raise ValueError for unknown price getter."""
        with pytest.raises(ValueError, match="Unknown price getter"):
            get_price_getter("unknown_getter")

    def test_get_price_getter_case_insensitive(self):
        """Should handle case-insensitive lookup."""
        getter = get_price_getter("YAHOO")
        assert getter.name == "yahoo"


class TestBasePriceGetter:
    """Tests for BasePriceGetter shared functionality."""

    def test_all_getters_inherit_from_base(self):
        """All registered price getters should inherit from BasePriceGetter."""
        for getter_name in list_price_getters():
            getter = get_price_getter(getter_name)
            assert isinstance(getter, BasePriceGetter)

    def test_all_getters_have_name(self):
        """All registered price getters should have a name attribute."""
        for getter_name in list_price_getters():
            getter = get_price_getter(getter_name)
            assert hasattr(getter, "name")
            assert getter.name == getter_name

    def test_all_getters_have_required_methods(self):
        """All price getters should implement required methods."""
        for getter_name in list_price_getters():
            getter = get_price_getter(getter_name)

            assert hasattr(getter, "get_current_price")
            assert callable(getter.get_current_price)

            assert hasattr(getter, "get_historical_price")
            assert callable(getter.get_historical_price)

    def test_all_getters_have_get_ticker_symbol(self):
        """All price getters should have get_ticker_symbol method."""
        for getter_name in list_price_getters():
            getter = get_price_getter(getter_name)
            assert hasattr(getter, "get_ticker_symbol")
            assert callable(getter.get_ticker_symbol)
