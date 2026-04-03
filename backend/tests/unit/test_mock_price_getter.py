"""
Tests for MockPriceGetter — deterministic and random modes.

Covers:
- Deterministic prices from config.extra["prices"]
- Historical lookup with ±15 min tolerance
- "current" key fallback
- Random fallback when no prices configured
- quote_currency override
- Fiat cross-rate entries (EUR/USD)
"""

import pytest
from datetime import datetime, timedelta
from unittest.mock import MagicMock

from backend.services.price_getters.mock_getter import MockPriceGetter, PRICE_MATCH_TOLERANCE
from backend.services.price_getters.base import PriceGetterConfig


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_asset(symbol: str = "BTC", price_type: str = "crypto") -> MagicMock:
    """Create a minimal mock Asset."""
    asset = MagicMock()
    asset.symbol = symbol
    asset.price_type = price_type
    return asset


def _make_config(extra: dict) -> PriceGetterConfig:
    return PriceGetterConfig(external_id="", extra=extra)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestMockPriceGetterDeterministic:
    """Tests for deterministic price lookup from config."""

    def setup_method(self):
        self.getter = MockPriceGetter()
        self.btc = _make_asset("BTC", "crypto")
        self.config = _make_config({
            "prices": {
                "2025-01-15T10:00:00": 40000.0,
                "2025-06-15T10:00:00": 60000.0,
                "current": 55000.0,
            },
            "quote_currency": "EUR",
        })

    # -- get_current_price -------------------------------------------------

    def test_current_price_uses_current_key(self):
        result = self.getter.get_current_price(self.btc, self.config)
        assert result.price == 55000.0
        assert result.quote_currency == "EUR"
        assert result.source == "mock"
        assert result.ticker_used == "BTC"

    def test_current_price_no_current_key_falls_back_to_random(self):
        config = _make_config({"prices": {"2025-01-15T10:00:00": 40000.0}})
        result = self.getter.get_current_price(self.btc, config)
        # No "current" key → random fallback, quote_currency defaults to USD
        assert result.quote_currency == "USD"
        assert result.source == "mock"

    # -- get_historical_price — exact match --------------------------------

    def test_historical_exact_match(self):
        dt = datetime(2025, 1, 15, 10, 0, 0)
        result = self.getter.get_historical_price(self.btc, dt, self.config)
        assert result.price == 40000.0
        assert result.quote_currency == "EUR"
        assert result.timestamp == dt

    def test_historical_exact_match_second_entry(self):
        dt = datetime(2025, 6, 15, 10, 0, 0)
        result = self.getter.get_historical_price(self.btc, dt, self.config)
        assert result.price == 60000.0

    # -- get_historical_price — tolerance window ---------------------------

    def test_historical_within_tolerance(self):
        """A datetime 10 minutes off should still match."""
        dt = datetime(2025, 1, 15, 10, 10, 0)  # +10 min
        result = self.getter.get_historical_price(self.btc, dt, self.config)
        assert result.price == 40000.0

    def test_historical_at_tolerance_boundary(self):
        """Exactly 15 minutes off should still match (<=)."""
        dt = datetime(2025, 1, 15, 10, 15, 0)  # exactly +15 min
        result = self.getter.get_historical_price(self.btc, dt, self.config)
        assert result.price == 40000.0

    def test_historical_outside_tolerance_falls_back_to_current(self):
        """16 minutes off should NOT match, falls back to current."""
        dt = datetime(2025, 1, 15, 10, 16, 0)  # +16 min
        result = self.getter.get_historical_price(self.btc, dt, self.config)
        assert result.price == 55000.0  # "current" fallback

    def test_historical_picks_closest_when_multiple_in_range(self):
        """When two keys are within tolerance, pick the closest."""
        config = _make_config({
            "prices": {
                "2025-01-15T10:00:00": 40000.0,
                "2025-01-15T10:20:00": 41000.0,
                "current": 55000.0,
            },
        })
        # dt at 10:12 — 12 min from first, 8 min from second → second is closer
        dt = datetime(2025, 1, 15, 10, 12, 0)
        result = self.getter.get_historical_price(self.btc, dt, config)
        assert result.price == 41000.0

    # -- get_historical_price — current fallback ---------------------------

    def test_historical_unknown_dt_falls_back_to_current(self):
        dt = datetime(2024, 1, 1, 0, 0, 0)  # way before any entry
        result = self.getter.get_historical_price(self.btc, dt, self.config)
        assert result.price == 55000.0  # "current" key

    def test_historical_no_current_no_match_falls_back_to_random(self):
        config = _make_config({"prices": {"2025-01-15T10:00:00": 40000.0}})
        dt = datetime(2024, 1, 1, 0, 0, 0)
        result = self.getter.get_historical_price(self.btc, dt, config)
        # No match, no "current" → random fallback
        assert result.quote_currency == "USD"
        assert result.source == "mock"


class TestMockPriceGetterQuoteCurrency:
    """Tests for quote_currency override."""

    def setup_method(self):
        self.getter = MockPriceGetter()
        self.eur = _make_asset("EUR", "fiat")

    def test_quote_currency_from_config(self):
        config = _make_config({
            "prices": {"current": 1.08},
            "quote_currency": "USD",
        })
        result = self.getter.get_current_price(self.eur, config)
        assert result.price == 1.08
        assert result.quote_currency == "USD"

    def test_default_quote_currency_is_usd(self):
        config = _make_config({"prices": {"current": 1.08}})
        result = self.getter.get_current_price(self.eur, config)
        assert result.quote_currency == "USD"


class TestMockPriceGetterRandomFallback:
    """Tests for random price generation (backward compatible)."""

    def setup_method(self):
        self.getter = MockPriceGetter()

    def test_no_config_returns_random(self):
        asset = _make_asset("BTC", "crypto")
        result = self.getter.get_current_price(asset, None)
        assert result.source == "mock"
        assert result.quote_currency == "USD"
        assert 100.0 <= result.price <= 50000.0  # crypto range

    def test_empty_prices_dict_returns_random(self):
        asset = _make_asset("BTC", "crypto")
        config = _make_config({"prices": {}})
        result = self.getter.get_current_price(asset, config)
        assert result.quote_currency == "USD"  # random fallback

    def test_custom_min_max_range(self):
        asset = _make_asset("XYZ", "crypto")
        config = _make_config({"min_price": 5.0, "max_price": 10.0})
        result = self.getter.get_current_price(asset, config)
        assert 5.0 <= result.price <= 10.0

    def test_fiat_random_range(self):
        asset = _make_asset("GBP", "fiat")
        result = self.getter.get_current_price(asset, None)
        assert 0.5 <= result.price <= 2.0  # fiat range

    def test_stock_random_range(self):
        asset = _make_asset("AAPL", "stock")
        result = self.getter.get_current_price(asset, None)
        assert 10.0 <= result.price <= 500.0  # stock range


class TestMockPriceGetterFiatCrossRate:
    """Tests for fiat cross-rate entries (e.g. EUR/USD)."""

    def setup_method(self):
        self.getter = MockPriceGetter()
        self.eur = _make_asset("EUR", "fiat")
        self.config = _make_config({
            "prices": {"current": 1.08},
            "quote_currency": "USD",
        })

    def test_eur_usd_current(self):
        result = self.getter.get_current_price(self.eur, self.config)
        assert result.price == 1.08
        assert result.quote_currency == "USD"

    def test_eur_usd_historical(self):
        config = _make_config({
            "prices": {
                "2025-01-15T10:00:00": 1.10,
                "current": 1.08,
            },
            "quote_currency": "USD",
        })
        dt = datetime(2025, 1, 15, 10, 0, 0)
        result = self.getter.get_historical_price(self.eur, dt, config)
        assert result.price == 1.10
        assert result.quote_currency == "USD"
