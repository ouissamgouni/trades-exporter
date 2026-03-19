"""
Unit tests for ForexPriceGetter.

Fully mocked — no network calls. Tests rate fetching, caching,
inverse rate calculation, and error handling.
"""

import pytest
from datetime import datetime
from unittest.mock import patch, MagicMock, Mock

from backend.services.price_getters.forex import ForexPriceGetter
from backend.services.price_getters.base import PriceGetterConfig, PriceGetterError, PriceResult


@pytest.fixture
def getter():
    return ForexPriceGetter()


@pytest.fixture
def mock_asset_usd():
    asset = MagicMock()
    asset.symbol = "USD"
    asset.asset_id = 1
    return asset


@pytest.fixture
def mock_asset_eur():
    asset = MagicMock()
    asset.symbol = "EUR"
    asset.asset_id = 2
    return asset


# ============================================================================
# Rate Fetching
# ============================================================================


class TestForexRateFetching:

    @patch("backend.services.price_getters.forex.requests.get")
    def test_direct_rate(self, mock_get, getter):
        mock_resp = Mock()
        mock_resp.ok = True
        mock_resp.json.return_value = {"rates": {"EUR": 0.92}}
        mock_get.return_value = mock_resp

        rate = getter._fetch_rate("USD", "EUR")

        assert rate == 0.92
        mock_get.assert_called_once()

    @patch("backend.services.price_getters.forex.requests.get")
    def test_inverse_rate_fallback(self, mock_get, getter):
        """When direct rate unavailable, tries inverse."""
        resp_no_rate = Mock()
        resp_no_rate.ok = True
        resp_no_rate.json.return_value = {"rates": {}}

        resp_inverse = Mock()
        resp_inverse.ok = True
        resp_inverse.json.return_value = {"rates": {"USD": 1.087}}

        mock_get.side_effect = [resp_no_rate, resp_inverse]

        rate = getter._fetch_rate("USD", "EUR")

        assert abs(rate - (1.0 / 1.087)) < 0.001

    @patch("backend.services.price_getters.forex.requests.get")
    def test_caches_rate(self, mock_get, getter):
        mock_resp = Mock()
        mock_resp.ok = True
        mock_resp.json.return_value = {"rates": {"EUR": 0.92}}
        mock_get.return_value = mock_resp

        # First call — hits API
        rate1 = getter._fetch_rate("USD", "EUR")
        # Second call — should use cache
        rate2 = getter._fetch_rate("USD", "EUR")

        assert rate1 == rate2 == 0.92
        assert mock_get.call_count == 1  # Only called once

    @patch("backend.services.price_getters.forex.requests.get")
    def test_api_error_returns_none(self, mock_get, getter):
        mock_get.side_effect = Exception("Network error")

        rate = getter._fetch_rate("USD", "EUR")
        assert rate is None


# ============================================================================
# get_current_price
# ============================================================================


class TestForexCurrentPrice:

    @patch("backend.services.price_getters.forex.requests.get")
    def test_usd_to_eur(self, mock_get, getter, mock_asset_usd):
        mock_resp = Mock()
        mock_resp.ok = True
        mock_resp.json.return_value = {"rates": {"EUR": 0.92}}
        mock_get.return_value = mock_resp

        config = PriceGetterConfig(extra={"to_currency": "EUR"})
        result = getter.get_current_price(mock_asset_usd, config=config)

        assert isinstance(result, PriceResult)
        assert result.price == 0.92
        assert result.quote_currency == "EUR"
        assert result.source == "forex"

    @patch("backend.services.price_getters.forex.requests.get")
    def test_defaults_to_usd_target(self, mock_get, getter, mock_asset_eur):
        mock_resp = Mock()
        mock_resp.ok = True
        mock_resp.json.return_value = {"rates": {"USD": 1.087}}
        mock_get.return_value = mock_resp

        result = getter.get_current_price(mock_asset_eur)

        assert result.price == 1.087
        assert result.quote_currency == "USD"


# ============================================================================
# get_historical_price
# ============================================================================


class TestForexHistoricalPrice:

    @patch("backend.services.price_getters.forex.requests.get")
    def test_falls_back_to_current(self, mock_get, getter, mock_asset_usd):
        """Forex free API doesn't support historical, falls back to current."""
        mock_resp = Mock()
        mock_resp.ok = True
        mock_resp.json.return_value = {"rates": {"EUR": 0.92}}
        mock_get.return_value = mock_resp

        config = PriceGetterConfig(extra={"to_currency": "EUR"})
        result = getter.get_historical_price(
            mock_asset_usd, datetime(2025, 1, 15), config=config
        )

        assert result.price == 0.92
        assert result.source == "forex"
