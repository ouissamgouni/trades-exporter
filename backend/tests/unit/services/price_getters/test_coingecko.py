"""
Unit tests for CoinGeckoPriceGetter.

Fully mocked — no network calls. Tests ticker resolution, response parsing,
and error handling. Complements the integration tests in tests/integration/.
"""

import pytest
from datetime import datetime
from unittest.mock import patch, MagicMock, Mock

from backend.services.price_getters.coingecko import CoinGeckoPriceGetter
from backend.services.price_getters.base import PriceGetterConfig, PriceGetterError, PriceResult


@pytest.fixture
def getter():
    g = CoinGeckoPriceGetter()
    g.max_retries = 1  # Fast tests
    return g


@pytest.fixture
def mock_asset():
    asset = MagicMock()
    asset.symbol = "BTC"
    asset.asset_id = 1
    return asset


# ============================================================================
# Response Parsing — get_current_price
# ============================================================================


class TestCoinGeckoCurrentPrice:

    @patch("backend.services.price_getters.coingecko.requests.get")
    def test_parses_simple_price(self, mock_get, getter, mock_asset):
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"bitcoin": {"usd": 87500.0}}
        mock_resp.raise_for_status = Mock()
        mock_get.return_value = mock_resp

        config = PriceGetterConfig(asset_id="bitcoin")
        result = getter.get_current_price(mock_asset, config=config)

        assert isinstance(result, PriceResult)
        assert result.price == 87500.0
        assert result.quote_currency == "USD"
        assert result.source == "coingecko"

    @patch("backend.services.price_getters.coingecko.requests.get")
    def test_coin_not_in_response_raises(self, mock_get, getter, mock_asset):
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {}
        mock_resp.raise_for_status = Mock()
        mock_get.return_value = mock_resp

        config = PriceGetterConfig(asset_id="bitcoin")
        with pytest.raises(PriceGetterError):
            getter.get_current_price(mock_asset, config=config)

    @patch("backend.services.price_getters.coingecko.requests.get")
    def test_eur_quote_currency(self, mock_get, getter, mock_asset):
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"bitcoin": {"eur": 80000.0}}
        mock_resp.raise_for_status = Mock()
        mock_get.return_value = mock_resp

        config = PriceGetterConfig(
            asset_id="bitcoin", extra={"native_quote_currency": "EUR"}
        )
        result = getter.get_current_price(mock_asset, config=config)

        assert result.price == 80000.0
        assert result.quote_currency == "EUR"


# ============================================================================
# Response Parsing — get_historical_price
# ============================================================================


class TestCoinGeckoHistoricalPrice:

    @patch("backend.services.price_getters.coingecko.requests.get")
    def test_parses_market_chart_range(self, mock_get, getter, mock_asset):
        target_dt = datetime(2025, 1, 15, 12, 0, 0)
        target_ts = int(target_dt.timestamp())

        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "prices": [
                [target_ts * 1000, 95000.0],
                [(target_ts + 3600) * 1000, 95100.0],
            ]
        }
        mock_resp.raise_for_status = Mock()
        mock_get.return_value = mock_resp

        config = PriceGetterConfig(asset_id="bitcoin")
        result = getter.get_historical_price(mock_asset, target_dt, config=config)

        assert result.price == 95000.0
        assert result.source == "coingecko"

    @patch("backend.services.price_getters.coingecko.requests.get")
    def test_empty_prices_raises(self, mock_get, getter, mock_asset):
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"prices": []}
        mock_resp.raise_for_status = Mock()
        mock_get.return_value = mock_resp

        config = PriceGetterConfig(asset_id="bitcoin")
        with pytest.raises(PriceGetterError):
            getter.get_historical_price(
                mock_asset, datetime(2025, 1, 15), config=config
            )


# ============================================================================
# Error Handling
# ============================================================================


class TestCoinGeckoErrors:

    @patch("backend.services.price_getters.coingecko.requests.get")
    def test_rate_limit_429(self, mock_get, getter, mock_asset):
        mock_resp = Mock()
        mock_resp.status_code = 429
        mock_resp.raise_for_status = Mock(side_effect=Exception("429 Too Many Requests"))
        mock_get.return_value = mock_resp

        config = PriceGetterConfig(asset_id="bitcoin")
        with pytest.raises(PriceGetterError):
            getter.get_current_price(mock_asset, config=config)
