"""
Unit tests for AlphaVantagePriceGetter.

Fully mocked — no network calls. Tests ticker resolution, response parsing,
crypto vs stock routing, and API key/rate-limit handling.
"""

import pytest
from datetime import datetime, timedelta
from unittest.mock import patch, MagicMock, Mock

from backend.services.price_getters.alphavantage import AlphaVantagePriceGetter
from backend.services.price_getters.base import PriceGetterConfig, PriceGetterError, PriceResult


@pytest.fixture
def getter():
    g = AlphaVantagePriceGetter()
    g._api_key = "test_key_AV"
    return g


@pytest.fixture
def mock_stock():
    asset = MagicMock()
    asset.symbol = "AAPL"
    asset.asset_id = 1
    asset.price_type = "stock"
    return asset


@pytest.fixture
def mock_crypto():
    asset = MagicMock()
    asset.symbol = "BTC"
    asset.asset_id = 2
    asset.price_type = "crypto"
    return asset


# ============================================================================
# Ticker Resolution
# ============================================================================


class TestAlphaVantageTickerResolution:

    def test_uses_external_id_from_config(self, getter, mock_stock):
        config = PriceGetterConfig(external_id="PE500.PA")
        ticker, quote = getter._resolve_ticker_with_quote(mock_stock, config)
        assert ticker == "PE500.PA"

    def test_falls_back_to_symbol(self, getter, mock_stock):
        ticker, quote = getter._resolve_ticker_with_quote(mock_stock, None)
        assert ticker == "AAPL"
        assert quote == "USD"

    def test_is_crypto_detection(self, getter, mock_stock, mock_crypto):
        assert not getter._is_crypto(mock_stock)
        assert getter._is_crypto(mock_crypto)


# ============================================================================
# Response Parsing — Current Price (Stock)
# ============================================================================


class TestAlphaVantageCurrentPriceStock:

    def test_parses_global_quote(self, getter, mock_stock):
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "Global Quote": {
                "01. symbol": "AAPL",
                "05. price": "175.50",
                "07. latest trading day": "2025-03-05",
            }
        }
        getter._session.get = Mock(return_value=mock_resp)

        result = getter.get_current_price(mock_stock)

        assert isinstance(result, PriceResult)
        assert result.price == 175.50
        assert result.source == "alphavantage"

    def test_empty_global_quote_raises(self, getter, mock_stock):
        getter.max_retries = 1
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"Global Quote": {}}
        getter._session.get = Mock(return_value=mock_resp)

        with pytest.raises(PriceGetterError):
            getter.get_current_price(mock_stock)


# ============================================================================
# Response Parsing — Current Price (Crypto)
# ============================================================================


class TestAlphaVantageCurrentPriceCrypto:

    def test_parses_currency_exchange_rate(self, getter, mock_crypto):
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "Realtime Currency Exchange Rate": {
                "1. From_Currency Code": "BTC",
                "3. To_Currency Code": "USD",
                "5. Exchange Rate": "87500.00",
            }
        }
        getter._session.get = Mock(return_value=mock_resp)

        result = getter.get_current_price(mock_crypto)

        assert result.price == 87500.0
        assert result.source == "alphavantage"


# ============================================================================
# Response Parsing — Historical Price
# ============================================================================


class TestAlphaVantageHistoricalPrice:

    def test_parses_time_series_daily(self, getter, mock_stock):
        target = datetime(2025, 1, 15)
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "Time Series (Daily)": {
                "2025-01-15": {"4. close": "232.50"},
                "2025-01-14": {"4. close": "230.00"},
            }
        }
        getter._session.get = Mock(return_value=mock_resp)

        result = getter.get_historical_price(mock_stock, target)

        assert result.price == 232.50
        assert result.source == "alphavantage"

    def test_falls_back_to_previous_day(self, getter, mock_stock):
        """Weekend date should fall back to previous trading day."""
        target = datetime(2025, 1, 18)  # Saturday
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "Time Series (Daily)": {
                "2025-01-17": {"4. close": "233.00"},
                "2025-01-16": {"4. close": "231.00"},
            }
        }
        getter._session.get = Mock(return_value=mock_resp)

        result = getter.get_historical_price(mock_stock, target)
        # Should find 2025-01-17 (1 day before Saturday)
        assert result.price == 233.00


# ============================================================================
# Error Handling
# ============================================================================


class TestAlphaVantageErrors:

    def test_rate_limit_note(self, getter, mock_stock):
        getter.max_retries = 1
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "Note": "Thank you for using Alpha Vantage! API call frequency limit reached."
        }
        getter._session.get = Mock(return_value=mock_resp)

        with pytest.raises(PriceGetterError):
            getter.get_current_price(mock_stock)

    def test_error_message_invalid_ticker(self, getter, mock_stock):
        getter.max_retries = 1
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "Error Message": "Invalid API call. Please retry or visit documentation."
        }
        getter._session.get = Mock(return_value=mock_resp)

        with pytest.raises(PriceGetterError):
            getter.get_current_price(mock_stock)

    def test_information_rate_limit(self, getter, mock_stock):
        getter.max_retries = 1
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "Information": "Thank you! API rate limit is 25 requests per day."
        }
        getter._session.get = Mock(return_value=mock_resp)

        with pytest.raises(PriceGetterError):
            getter.get_current_price(mock_stock)
