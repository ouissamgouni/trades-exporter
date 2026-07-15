"""
Smoke/integration tests for YahooDirectPriceGetter.

Real API calls — requires network. Tests that the Yahoo Chart API v8
actually returns valid prices for well-known tickers.

Run with: pytest -m network
"""

import pytest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

from backend.services.price_getters.base import (
    PriceGetterConfig,
    PriceGetterError,
    PriceResult,
)
from backend.tests.integration.price_getters.conftest import call_or_skip_on_flaky_error


@pytest.mark.integration
@pytest.mark.network
class TestYahooDirectSmoke:
    """Real API calls against Yahoo Chart API v8."""

    def test_current_price_aapl(self, yahoo_direct_getter, mock_asset_aapl):
        result = call_or_skip_on_flaky_error(
            yahoo_direct_getter.get_current_price, mock_asset_aapl
        )

        assert isinstance(result, PriceResult)
        assert result.price > 50  # AAPL sanity
        assert result.quote_currency == "USD"
        assert result.source == "yahoo_direct"

    def test_current_price_with_config(self, yahoo_direct_getter, mock_asset_btc):
        config = PriceGetterConfig(external_id="BTC-USD")
        result = call_or_skip_on_flaky_error(
            yahoo_direct_getter.get_current_price, mock_asset_btc, config=config
        )

        assert result.price > 1000  # BTC sanity
        assert result.quote_currency == "USD"
        assert result.ticker_used == "BTC-USD"

    def test_current_price_european_etf(self, yahoo_direct_getter):
        """European ETF with EUR quote currency."""
        asset = MagicMock()
        asset.symbol = "PE500"
        config = PriceGetterConfig(
            external_id="PE500.PA",
            extra={"native_quote_currency": "EUR"},
        )
        result = call_or_skip_on_flaky_error(
            yahoo_direct_getter.get_current_price, asset, config=config
        )

        assert result.price > 0
        assert result.quote_currency == "EUR"

    def test_historical_price_aapl_7d(self, yahoo_direct_getter, mock_asset_aapl):
        target = datetime.now(timezone.utc) - timedelta(days=7)
        result = call_or_skip_on_flaky_error(
            yahoo_direct_getter.get_historical_price, mock_asset_aapl, target
        )

        assert isinstance(result, PriceResult)
        assert result.price > 0
        assert result.source == "yahoo_direct"

    def test_historical_price_30d(self, yahoo_direct_getter, mock_asset_aapl):
        target = datetime.now(timezone.utc) - timedelta(days=30)
        result = call_or_skip_on_flaky_error(
            yahoo_direct_getter.get_historical_price, mock_asset_aapl, target
        )

        assert result.price > 0

    def test_invalid_ticker_raises(self, yahoo_direct_getter):
        asset = MagicMock()
        asset.symbol = "ZZZINVALIDXYZ999"

        with pytest.raises(PriceGetterError):
            yahoo_direct_getter.get_current_price(asset)
