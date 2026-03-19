"""
Unit tests for MarketstackPriceGetter.

Fully mocked — no network calls. Tests ticker resolution, response parsing,
API key handling, and error paths.
"""

import pytest
from datetime import datetime, timedelta
from unittest.mock import patch, MagicMock, Mock

from backend.services.price_getters.marketstack import MarketstackPriceGetter
from backend.services.price_getters.base import PriceGetterConfig, PriceGetterError, PriceResult


@pytest.fixture
def getter():
    g = MarketstackPriceGetter()
    g._api_key = "test_key_123"
    return g


@pytest.fixture
def mock_asset():
    asset = MagicMock()
    asset.symbol = "AAPL"
    asset.asset_id = 1
    return asset


# ============================================================================
# Ticker Resolution
# ============================================================================


class TestMarketstackTickerResolution:

    def test_uses_external_id_from_config(self, getter, mock_asset):
        config = PriceGetterConfig(external_id="AAPL.XNAS")
        ticker, quote = getter._resolve_ticker_with_quote(mock_asset, config)
        assert ticker == "AAPL.XNAS"

    def test_falls_back_to_symbol(self, getter, mock_asset):
        ticker, quote = getter._resolve_ticker_with_quote(mock_asset, None)
        assert ticker == "AAPL"
        assert quote == "USD"

    def test_native_quote_from_extra(self, getter, mock_asset):
        config = PriceGetterConfig(
            external_id="PE500.PA",
            extra={"native_quote_currency": "EUR"},
        )
        ticker, quote = getter._resolve_ticker_with_quote(mock_asset, config)
        assert ticker == "PE500.PA"
        assert quote == "EUR"


# ============================================================================
# API Key Handling
# ============================================================================


class TestMarketstackApiKey:

    def test_uses_env_api_key(self, getter):
        assert getter._get_api_key() == "test_key_123"

    def test_config_api_key_overrides(self, getter):
        config = PriceGetterConfig(extra={"api_key": "override_key"})
        assert getter._get_api_key(config) == "override_key"

    def test_missing_api_key_raises(self, mock_asset):
        getter = MarketstackPriceGetter()
        getter._api_key = ""

        with pytest.raises(PriceGetterError, match="No API key"):
            getter.get_current_price(mock_asset)


# ============================================================================
# Response Parsing — get_current_price
# ============================================================================


class TestMarketstackCurrentPrice:

    def test_parses_eod_latest(self, getter, mock_asset):
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "data": [{"close": 175.50, "date": "2025-03-05T00:00:00+0000"}]
        }
        getter._session.get = Mock(return_value=mock_resp)

        result = getter.get_current_price(mock_asset)

        assert isinstance(result, PriceResult)
        assert result.price == 175.50
        assert result.source == "marketstack"
        assert result.ticker_used == "AAPL"

    def test_empty_data_raises(self, getter, mock_asset):
        getter.max_retries = 1
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"data": []}
        getter._session.get = Mock(return_value=mock_resp)

        with pytest.raises(PriceGetterError):
            getter.get_current_price(mock_asset)


# ============================================================================
# Response Parsing — get_historical_price
# ============================================================================


class TestMarketstackHistoricalPrice:

    def test_parses_historical_eod(self, getter, mock_asset):
        target = datetime(2025, 1, 15)
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "data": [
                {"close": 232.50, "date": "2025-01-15T00:00:00+0000"},
                {"close": 230.00, "date": "2025-01-14T00:00:00+0000"},
            ]
        }
        getter._session.get = Mock(return_value=mock_resp)

        result = getter.get_historical_price(mock_asset, target)

        assert result.price == 232.50
        assert result.source == "marketstack"


# ============================================================================
# Error Handling
# ============================================================================


class TestMarketstackErrors:

    def test_401_raises_missing_api_key(self, getter, mock_asset):
        getter.max_retries = 1
        mock_resp = Mock()
        mock_resp.status_code = 401
        getter._session.get = Mock(return_value=mock_resp)

        with pytest.raises(PriceGetterError):
            getter.get_current_price(mock_asset)

    def test_429_raises_rate_limited(self, getter, mock_asset):
        getter.max_retries = 1
        mock_resp = Mock()
        mock_resp.status_code = 429
        getter._session.get = Mock(return_value=mock_resp)

        with pytest.raises(PriceGetterError):
            getter.get_current_price(mock_asset)

    def test_api_error_in_response_body(self, getter, mock_asset):
        getter.max_retries = 1
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "error": {"message": "Invalid API key", "code": "function_access_restricted"}
        }
        getter._session.get = Mock(return_value=mock_resp)

        with pytest.raises(PriceGetterError):
            getter.get_current_price(mock_asset)
