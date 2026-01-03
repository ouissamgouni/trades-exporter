"""
Tests for CoinGecko Price Getter.

Updated for simplified price getter that relies on database config.
No more asset_map - ticker must be specified in config.asset_id
or falls back to lowercase asset.symbol.

Includes:
- Ticker resolution tests (no network)
- Error handling tests (no network)
- Integration tests with real API (network required)
"""

import pytest
from unittest.mock import MagicMock

from backend.services.price_getters.base import PriceGetterConfig, PriceResult


class TestCoinGeckoTickerResolution:
    """Tests for CoinGecko ticker symbol resolution logic (no network)."""

    def test_uses_config_asset_id_when_provided(self, coingecko_getter, mock_asset_btc):
        """Should use config.asset_id when provided."""
        config = PriceGetterConfig(asset_id="bitcoin")
        ticker = coingecko_getter.resolve_ticker(mock_asset_btc, config)
        assert ticker == "bitcoin"

    def test_falls_back_to_lowercase_symbol(self, coingecko_getter, mock_asset_btc):
        """Should use lowercase asset.symbol when no config provided."""
        ticker = coingecko_getter.resolve_ticker(mock_asset_btc, None)
        assert ticker == "btc"

    def test_falls_back_to_lowercase_symbol_with_empty_config(
        self, coingecko_getter, mock_asset_eth
    ):
        """Should use lowercase asset.symbol when config has no asset_id."""
        config = PriceGetterConfig()
        ticker = coingecko_getter.resolve_ticker(mock_asset_eth, config)
        assert ticker == "eth"

    def test_config_asset_id_takes_priority(self, coingecko_getter):
        """Config asset_id should override asset.symbol."""
        asset = MagicMock()
        asset.symbol = "WRONG"
        config = PriceGetterConfig(asset_id="ethereum")

        ticker = coingecko_getter.resolve_ticker(asset, config)
        assert ticker == "ethereum"


class TestCoinGeckoErrorHandling:
    """Tests for CoinGecko price getter error handling (no network)."""

    def test_missing_symbol_raises_error(self, coingecko_getter, mock_asset_no_ticker):
        """Should raise error when asset has no symbol and no config."""
        with pytest.raises(ValueError, match="Asset has no symbol"):
            coingecko_getter.resolve_ticker(mock_asset_no_ticker, None)

    def test_config_overrides_missing_symbol(
        self, coingecko_getter, mock_asset_no_ticker
    ):
        """Config should work even when asset has no symbol."""
        config = PriceGetterConfig(asset_id="bitcoin")
        ticker = coingecko_getter.resolve_ticker(mock_asset_no_ticker, config)
        assert ticker == "bitcoin"


@pytest.mark.integration
@pytest.mark.network
class TestCoinGeckoPriceGetterIntegration:
    """
    Integration tests for CoinGecko price getter (real API calls).

    These tests require:
    1. Network access
    2. CoinGecko API keys (optional, for rate limit handling)

    Run with: pytest -m network
    """

    def test_get_current_price_btc(
        self, coingecko_getter, mock_asset_btc, config_bitcoin_coingecko
    ):
        """Should fetch current BTC price from CoinGecko and return PriceResult."""
        result = coingecko_getter.get_current_price(
            mock_asset_btc, config=config_bitcoin_coingecko
        )
        assert isinstance(result, PriceResult)
        assert isinstance(result.price, float)
        assert result.price > 0
        assert result.price > 1000  # BTC sanity check
        assert result.quote_currency == "USD"
        assert result.source == "coingecko"

    def test_get_current_price_btc_eur(
        self, coingecko_getter, mock_asset_btc, config_bitcoin_coingecko
    ):
        """Should fetch BTC price in EUR when configured."""
        # Create config with EUR as native quote
        config_eur = PriceGetterConfig(
            asset_id="bitcoin", extra={"native_quote_currency": "EUR"}
        )
        result = coingecko_getter.get_current_price(mock_asset_btc, config=config_eur)
        assert isinstance(result, PriceResult)
        assert isinstance(result.price, float)
        assert result.price > 0
        assert result.quote_currency == "EUR"

    def test_get_current_price_eth(
        self, coingecko_getter, mock_asset_eth, config_ethereum_coingecko
    ):
        """Should fetch current ETH price from CoinGecko and return PriceResult."""
        result = coingecko_getter.get_current_price(
            mock_asset_eth, config=config_ethereum_coingecko
        )
        assert isinstance(result, PriceResult)
        assert isinstance(result.price, float)
        assert result.price > 0
        assert result.quote_currency == "USD"

    def test_get_historical_price_btc(
        self, coingecko_getter, mock_asset_btc, config_bitcoin_coingecko
    ):
        """Should fetch historical BTC price and return PriceResult."""
        from datetime import datetime, timedelta

        target_date = datetime.utcnow() - timedelta(days=7)

        result = coingecko_getter.get_historical_price(
            mock_asset_btc, target_date, config=config_bitcoin_coingecko
        )
        assert isinstance(result, PriceResult)
        assert isinstance(result.price, float)
        assert result.price > 0
        assert result.source == "coingecko"

    def test_invalid_coin_id_raises_error(self, coingecko_getter):
        """Should raise error for invalid CoinGecko ID."""
        invalid_asset = MagicMock()
        invalid_asset.symbol = "INVALID"
        invalid_config = PriceGetterConfig(asset_id="zzzinvalidcoinxyz999")

        with pytest.raises(RuntimeError):
            coingecko_getter.get_current_price(invalid_asset, config=invalid_config)
