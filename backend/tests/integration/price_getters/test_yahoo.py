"""
Tests for Yahoo Finance Price Getter.

Updated for simplified price getter that relies on database config.
No more _build_ticker, CRYPTO_SYMBOLS, FIAT_SYMBOLS -
ticker must be fully specified in config.asset_id or use asset.symbol directly.

Includes:
- Ticker resolution tests (no network)
- Error handling tests (no network)
- Integration tests with real API (network required)
"""

import pytest
from datetime import datetime, timedelta
from unittest.mock import MagicMock

from backend.services.price_getters.base import PriceGetterConfig, PriceResult


class TestYahooTickerResolution:
    """Tests for Yahoo Finance ticker symbol resolution logic (no network)."""

    def test_uses_config_asset_id_when_provided(self, yahoo_getter, mock_asset_btc):
        """Should use config.asset_id when provided."""
        config = PriceGetterConfig(asset_id="BTC-USD")
        ticker = yahoo_getter.resolve_ticker(mock_asset_btc, config)
        assert ticker == "BTC-USD"

    def test_falls_back_to_symbol_without_config(self, yahoo_getter, mock_asset_aapl):
        """Should use asset.symbol when no config provided."""
        ticker = yahoo_getter.resolve_ticker(mock_asset_aapl, None)
        assert ticker == "AAPL"

    def test_falls_back_to_symbol_with_empty_config(
        self, yahoo_getter, mock_asset_msft
    ):
        """Should use asset.symbol when config has no asset_id."""
        config = PriceGetterConfig()
        ticker = yahoo_getter.resolve_ticker(mock_asset_msft, config)
        assert ticker == "MSFT"

    def test_config_asset_id_takes_priority_over_symbol(self, yahoo_getter):
        """Config asset_id should override asset.symbol."""
        asset = MagicMock()
        asset.symbol = "WRONG"
        config = PriceGetterConfig(asset_id="CORRECT-USD")

        ticker = yahoo_getter.resolve_ticker(asset, config)
        assert ticker == "CORRECT-USD"


class TestYahooErrorHandling:
    """Tests for Yahoo price getter error handling (no network)."""

    def test_missing_symbol_raises_error(self, yahoo_getter, mock_asset_no_ticker):
        """Should raise error when asset has no symbol and no config."""
        with pytest.raises(ValueError, match="No ticker symbol"):
            yahoo_getter.resolve_ticker(mock_asset_no_ticker, None)

    def test_config_overrides_missing_symbol(self, yahoo_getter, mock_asset_no_ticker):
        """Config should work even when asset has no symbol."""
        config = PriceGetterConfig(asset_id="AAPL")
        ticker = yahoo_getter.resolve_ticker(mock_asset_no_ticker, config)
        assert ticker == "AAPL"


@pytest.mark.integration
@pytest.mark.network
class TestYahooPriceGetterIntegration:
    """
    Integration tests for Yahoo Finance price getter (real API calls).

    These tests require network access and may fail due to rate limits.
    Run with: pytest -m network
    """

    def test_get_current_price_aapl(self, yahoo_getter, mock_asset_aapl):
        """Should fetch current AAPL stock price and return PriceResult."""
        result = yahoo_getter.get_current_price(mock_asset_aapl)

        assert isinstance(result, PriceResult)
        assert isinstance(result.price, float)
        assert result.price > 0
        assert result.price > 50  # AAPL sanity check
        assert result.quote_currency == "USD"
        assert result.source == "yahoo"

    def test_get_current_price_msft(self, yahoo_getter, mock_asset_msft):
        """Should fetch current MSFT stock price and return PriceResult."""
        result = yahoo_getter.get_current_price(mock_asset_msft)

        assert isinstance(result, PriceResult)
        assert isinstance(result.price, float)
        assert result.price > 0
        assert result.price > 100  # MSFT sanity check
        assert result.quote_currency == "USD"

    def test_get_current_price_spy(self, yahoo_getter, mock_asset_spy):
        """Should fetch current SPY ETF price and return PriceResult."""
        result = yahoo_getter.get_current_price(mock_asset_spy)

        assert isinstance(result, PriceResult)
        assert isinstance(result.price, float)
        assert result.price > 0
        assert result.price > 200  # SPY sanity check

    def test_get_current_price_btc_with_config(
        self, yahoo_getter, mock_asset_btc, config_btc_usd
    ):
        """Should fetch BTC price using config.asset_id and return PriceResult."""
        result = yahoo_getter.get_current_price(mock_asset_btc, config=config_btc_usd)

        assert isinstance(result, PriceResult)
        assert isinstance(result.price, float)
        assert result.price > 0
        assert result.price > 1000  # BTC sanity check
        assert result.quote_currency == "USD"
        assert result.ticker_used == "BTC-USD"

    def test_get_historical_price_aapl(self, yahoo_getter, mock_asset_aapl):
        """Should fetch historical AAPL price and return PriceResult."""
        target_date = datetime.utcnow() - timedelta(days=7)
        result = yahoo_getter.get_historical_price(mock_asset_aapl, target_date)

        assert isinstance(result, PriceResult)
        assert isinstance(result.price, float)
        assert result.price > 0
        assert result.source == "yahoo"

    def test_get_historical_price_30_days_ago(self, yahoo_getter, mock_asset_spy):
        """Should fetch historical price from 30 days ago and return PriceResult."""
        target_date = datetime.utcnow() - timedelta(days=30)
        result = yahoo_getter.get_historical_price(mock_asset_spy, target_date)

        assert isinstance(result, PriceResult)
        assert isinstance(result.price, float)
        assert result.price > 0

    def test_invalid_ticker_raises_error(self, yahoo_getter):
        """Should raise error for invalid ticker symbol."""
        invalid_asset = MagicMock()
        invalid_asset.symbol = "ZZZINVALIDXYZ999"

        with pytest.raises(RuntimeError):
            yahoo_getter.get_current_price(invalid_asset)
