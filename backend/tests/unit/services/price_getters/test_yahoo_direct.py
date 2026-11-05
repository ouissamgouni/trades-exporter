"""
Unit tests for YahooDirectPriceGetter.

Fully mocked — no network calls. Tests ticker resolution, response parsing,
and error handling for the Chart API v8 getter.
"""

import pytest
from datetime import datetime, timedelta
from unittest.mock import patch, MagicMock, Mock

from backend.services.price_getters.yahoo_direct import YahooDirectPriceGetter
from backend.services.price_getters.base import PriceErrorReason, PriceGetterConfig, PriceGetterError, PriceResult


@pytest.fixture
def getter():
    return YahooDirectPriceGetter()


@pytest.fixture
def mock_asset():
    asset = MagicMock()
    asset.symbol = "AAPL"
    asset.asset_id = 1
    return asset


@pytest.fixture
def mock_crypto_asset():
    asset = MagicMock()
    asset.symbol = "BTC"
    asset.asset_id = 2
    return asset


# ============================================================================
# Ticker Resolution
# ============================================================================


class TestYahooDirectTickerResolution:

    def test_uses_external_id_from_config(self, getter, mock_asset):
        config = PriceGetterConfig(external_id="PE500.PA")
        ticker, quote = getter._resolve_ticker_with_quote(mock_asset, config)
        assert ticker == "PE500.PA"

    def test_falls_back_to_symbol(self, getter, mock_asset):
        ticker, quote = getter._resolve_ticker_with_quote(mock_asset, None)
        assert ticker == "AAPL"

    def test_crypto_ticker_parses_quote_currency(self, getter, mock_crypto_asset):
        config = PriceGetterConfig(external_id="BTC-USD")
        ticker, quote = getter._resolve_ticker_with_quote(mock_crypto_asset, config)
        assert ticker == "BTC-USD"
        assert quote == "USD"

    def test_forex_ticker_parses_quote(self, getter, mock_asset):
        config = PriceGetterConfig(external_id="EURUSD=X")
        ticker, quote = getter._resolve_ticker_with_quote(mock_asset, config)
        assert ticker == "EURUSD=X"
        assert quote == "USD"

    def test_native_quote_from_extra(self, getter, mock_asset):
        config = PriceGetterConfig(external_id="PE500.PA", extra={"native_quote_currency": "EUR"})
        ticker, quote = getter._resolve_ticker_with_quote(mock_asset, config)
        assert ticker == "PE500.PA"
        assert quote == "EUR"


# ============================================================================
# Response Parsing — get_current_price
# ============================================================================


class TestYahooDirectCurrentPrice:

    def _mock_chart_response(self, price=150.0, currency="USD"):
        """Build a realistic Yahoo Chart API v8 response."""
        return {
            "chart": {
                "result": [{
                    "meta": {
                        "regularMarketPrice": price,
                        "currency": currency,
                    },
                    "timestamp": [1700000000],
                    "indicators": {
                        "quote": [{"close": [price]}]
                    },
                }],
                "error": None,
            }
        }

    @patch("backend.services.price_getters.yahoo_direct.requests.Session")
    def test_parses_regular_market_price(self, MockSession, mock_asset):
        getter = YahooDirectPriceGetter()
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = self._mock_chart_response(150.25, "USD")
        getter._session.get = Mock(return_value=mock_resp)

        result = getter.get_current_price(mock_asset)

        assert isinstance(result, PriceResult)
        assert result.price == 150.25
        assert result.quote_currency == "USD"
        assert result.source == "yahoo_direct"
        assert result.ticker_used == "AAPL"

    @patch("backend.services.price_getters.yahoo_direct.requests.Session")
    def test_uses_api_currency_over_guess(self, MockSession, mock_asset):
        getter = YahooDirectPriceGetter()
        config = PriceGetterConfig(external_id="PE500.PA")
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = self._mock_chart_response(45.0, "EUR")
        getter._session.get = Mock(return_value=mock_resp)

        result = getter.get_current_price(mock_asset, config=config)

        assert result.quote_currency == "EUR"
        assert result.ticker_used == "PE500.PA"

    @patch("backend.services.price_getters.yahoo_direct.requests.Session")
    def test_fallback_to_last_close(self, MockSession, mock_asset):
        """When regularMarketPrice is missing, uses last close."""
        getter = YahooDirectPriceGetter()
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "chart": {
                "result": [{
                    "meta": {"currency": "USD"},
                    "timestamp": [1700000000, 1700086400],
                    "indicators": {
                        "quote": [{"close": [148.0, 150.5]}]
                    },
                }],
                "error": None,
            }
        }
        getter._session.get = Mock(return_value=mock_resp)

        result = getter.get_current_price(mock_asset)
        assert result.price == 150.5


# ============================================================================
# Response Parsing — get_historical_price
# ============================================================================


class TestYahooDirectHistoricalPrice:

    @patch("backend.services.price_getters.yahoo_direct.requests.Session")
    def test_parses_historical_price(self, MockSession, mock_asset):
        getter = YahooDirectPriceGetter()
        target_dt = datetime(2025, 1, 15, 12, 0, 0)
        target_ts = int(target_dt.timestamp())

        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "chart": {
                "result": [{
                    "meta": {"currency": "USD"},
                    "timestamp": [target_ts - 86400, target_ts, target_ts + 86400],
                    "indicators": {
                        "quote": [{"close": [230.0, 232.5, 234.0]}]
                    },
                }],
                "error": None,
            }
        }
        getter._session.get = Mock(return_value=mock_resp)

        result = getter.get_historical_price(mock_asset, target_dt)

        assert isinstance(result, PriceResult)
        assert result.price == 232.5
        assert result.source == "yahoo_direct"


# ============================================================================
# Error Handling
# ============================================================================


class TestYahooDirectErrors:

    @patch("backend.services.price_getters.yahoo_direct.requests.Session")
    def test_404_raises_ticker_not_found(self, MockSession, mock_asset):
        getter = YahooDirectPriceGetter()
        getter.max_retries = 1
        mock_resp = Mock()
        mock_resp.status_code = 404
        getter._session.get = Mock(return_value=mock_resp)

        with pytest.raises(PriceGetterError):
            getter.get_current_price(mock_asset)

    @patch("backend.services.price_getters.yahoo_direct.requests.Session")
    def test_empty_result_raises_error(self, MockSession, mock_asset):
        getter = YahooDirectPriceGetter()
        getter.max_retries = 1
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"chart": {"result": None, "error": None}}
        getter._session.get = Mock(return_value=mock_resp)

        with pytest.raises(PriceGetterError):
            getter.get_current_price(mock_asset)

    @patch("backend.services.price_getters.yahoo_direct.requests.Session")
    def test_api_error_in_response(self, MockSession, mock_asset):
        getter = YahooDirectPriceGetter()
        getter.max_retries = 1
        mock_resp = Mock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "chart": {"result": None, "error": {"description": "Not Found"}}
        }
        getter._session.get = Mock(return_value=mock_resp)

        with pytest.raises(PriceGetterError):
            getter.get_current_price(mock_asset)

    @pytest.mark.parametrize(
        "status_code, expected_reason",
        [
            (404, PriceErrorReason.TICKER_NOT_FOUND),
            (429, PriceErrorReason.API_RATE_LIMITED),
            (500, PriceErrorReason.API_ERROR),
        ],
    )
    @patch("backend.services.price_getters.yahoo_direct.requests.Session")
    def test_http_errors_keep_their_reason(self, MockSession, mock_asset, status_code, expected_reason):
        getter = YahooDirectPriceGetter()
        getter.max_retries = 1
        mock_resp = Mock()
        mock_resp.status_code = status_code
        getter._session.get = Mock(return_value=mock_resp)

        with pytest.raises(PriceGetterError) as exc_info:
            getter.get_current_price(mock_asset)
        assert exc_info.value.reason == expected_reason
        assert exc_info.value.getter_name == "yahoo_direct"
