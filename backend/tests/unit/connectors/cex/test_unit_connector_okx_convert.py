"""
Unit tests for OKX Convert connector.
Tests the raw_to_normalized method that transforms CCXT convert trade responses to NormalizedTransaction.
"""

import pytest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from backend.connectors.cex.connector_okx_convert import OKXConvertConnector
from backend.db.models import NormalizedTransaction


class TestOKXConvertConnector:
    """Unit tests for OKX convert connector raw_to_normalized method."""

    @patch("backend.connectors.cex.connector_okx_convert.load_credentials")
    @patch("ccxt.myokx")
    def test_raw_to_normalized_buy_convert(self, mock_ccxt, mock_creds):
        """Test normalizing a buy convert trade from CCXT format."""
        mock_creds.return_value = {
            "api_key": "test_key",
            "api_secret": "test_secret",
            "api_passphrase": "test_pass",
        }
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = OKXConvertConnector(account_id=1)

        # Mock CCXT convert trade response (buy BTC with EUR)
        ccxt_convert = {
            "id": "conv12345",
            "timestamp": 1640995200000,
            "datetime": "2022-01-01T00:00:00.000Z",
            "fromCurrency": "EUR",
            "fromAmount": 1000.0,
            "toCurrency": "BTC",
            "toAmount": 0.02,
            "price": 50000.0,
            "fee": 5.0,
            "info": {
                "baseCcy": "BTC",
                "quoteCcy": "EUR",
                "fillBaseSz": "0.02",
                "fillQuoteSz": "1000",
                "side": "buy",
            },
        }

        result = connector.raw_to_normalized(ccxt_convert)

        # Assert it returns NormalizedTransaction
        assert isinstance(result, NormalizedTransaction)

        # Assert normalized structure for buy convert
        assert result.source == "okx-convert"
        assert result.account_id == 1
        assert result.source_transaction_id == "conv12345"
        assert result.direction == "inflow"  # Buy = inflow of base asset
        assert result.source_transaction_type == "buy"
        assert result.transaction_type == "acquisition"  # Buy converts to acquisition
        assert result.source_asset_symbol == "BTC"
        assert result.quantity == 0.02
        assert result.price == 50000.0
        assert result.source_price_quote_asset_symbol == "EUR"
        assert result.total == 1000.0
        assert result.fee == 5.0
        assert result.source_fee_quote_asset_symbol == "EUR"
        assert result.tags == {"type": "convert"}
        assert result.date_time == datetime(2022, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

    @patch("backend.connectors.cex.connector_okx_convert.load_credentials")
    @patch("ccxt.myokx")
    def test_raw_to_normalized_sell_convert(self, mock_ccxt, mock_creds):
        """Test normalizing a sell convert trade from CCXT format."""
        mock_creds.return_value = {
            "api_key": "test_key",
            "api_secret": "test_secret",
            "api_passphrase": "test_pass",
        }
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = OKXConvertConnector()

        # Mock CCXT convert trade response (sell ETH for USDT)
        ccxt_convert = {
            "id": "conv67890",
            "timestamp": 1640995300000,
            "datetime": "2022-01-01T00:01:40.000Z",
            "fromCurrency": "ETH",
            "fromAmount": 1.0,
            "toCurrency": "USDT",
            "toAmount": 3500.0,
            "price": 3500.0,
            "fee": 3.5,
            "info": {
                "baseCcy": "ETH",
                "quoteCcy": "USDT",
                "fillBaseSz": "1.0",
                "fillQuoteSz": "3500",
                "side": "sell",
            },
        }

        result = connector.raw_to_normalized(ccxt_convert)

        assert result.source == "okx-convert"
        assert result.source_transaction_id == "conv67890"
        assert result.direction == "outflow"  # Sell = outflow of base asset
        assert result.source_transaction_type == "sell"
        assert result.transaction_type == "disposal"  # Sell converts to disposal
        assert result.source_asset_symbol == "ETH"
        assert result.quantity == 1.0
        assert result.price == 3500.0
        assert result.source_price_quote_asset_symbol == "USDT"
        assert result.total == 3500.0
        assert result.fee == 3.5

    @patch("backend.connectors.cex.connector_okx_convert.load_credentials")
    @patch("ccxt.myokx")
    def test_raw_to_normalized_no_fee(self, mock_ccxt, mock_creds):
        """Test normalizing a convert trade with no fee."""
        mock_creds.return_value = {
            "api_key": "test_key",
            "api_secret": "test_secret",
            "api_passphrase": "test_pass",
        }
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = OKXConvertConnector()

        ccxt_convert = {
            "id": "conv_nofee",
            "timestamp": 1640995400000,
            "fromCurrency": "BNB",
            "fromAmount": 10.0,
            "toCurrency": "USDC",
            "toAmount": 3000.0,
            "price": 300.0,
            "fee": None,  # No fee
            "info": {
                "baseCcy": "BNB",
                "quoteCcy": "USDC",
                "fillBaseSz": "10.0",
                "fillQuoteSz": "3000",
                "side": "sell",
            },
        }

        result = connector.raw_to_normalized(ccxt_convert)

        assert result.fee == 0
        assert result.source_asset_symbol == "BNB"
        assert result.quantity == 10.0

    @patch("backend.connectors.cex.connector_okx_convert.load_credentials")
    @patch("ccxt.myokx")
    def test_raw_to_normalized_invalid_currency_pair_raises(
        self, mock_ccxt, mock_creds
    ):
        """Test that invalid currency pair raises ValueError."""
        mock_creds.return_value = {
            "api_key": "test_key",
            "api_secret": "test_secret",
            "api_passphrase": "test_pass",
        }
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = OKXConvertConnector()

        ccxt_convert = {
            "id": "conv_invalid",
            "timestamp": 1640995200000,
            "price": 100.0,
            "info": {
                "baseCcy": "",  # Empty base currency
                "quoteCcy": "EUR",
                "fillBaseSz": "1.0",
                "fillQuoteSz": "100",
                "side": "buy",
            },
        }

        with pytest.raises(ValueError, match="Invalid currency pair"):
            connector.raw_to_normalized(ccxt_convert)

    @patch("backend.connectors.cex.connector_okx_convert.load_credentials")
    @patch("ccxt.myokx")
    def test_raw_to_normalized_missing_quote_currency_raises(
        self, mock_ccxt, mock_creds
    ):
        """Test that missing quote currency raises ValueError."""
        mock_creds.return_value = {
            "api_key": "test_key",
            "api_secret": "test_secret",
            "api_passphrase": "test_pass",
        }
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = OKXConvertConnector()

        ccxt_convert = {
            "id": "conv_no_quote",
            "timestamp": 1640995200000,
            "price": 100.0,
            "info": {
                "baseCcy": "BTC",
                "quoteCcy": "",  # Empty quote currency
                "fillBaseSz": "1.0",
                "fillQuoteSz": "100",
                "side": "buy",
            },
        }

        with pytest.raises(ValueError, match="Invalid currency pair"):
            connector.raw_to_normalized(ccxt_convert)

    @patch("backend.connectors.cex.connector_okx_convert.load_credentials")
    @patch("ccxt.myokx")
    def test_raw_to_normalized_stablecoin_convert(self, mock_ccxt, mock_creds):
        """Test normalizing a stablecoin convert trade."""
        mock_creds.return_value = {
            "api_key": "test_key",
            "api_secret": "test_secret",
            "api_passphrase": "test_pass",
        }
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = OKXConvertConnector()

        ccxt_convert = {
            "id": "conv_stable",
            "timestamp": 1640995500000,
            "fromCurrency": "USDT",
            "fromAmount": 1000.0,
            "toCurrency": "USDC",
            "toAmount": 999.5,
            "price": 0.9995,
            "fee": 0.5,
            "info": {
                "baseCcy": "USDT",
                "quoteCcy": "USDC",
                "fillBaseSz": "1000.0",
                "fillQuoteSz": "999.5",
                "side": "sell",
            },
        }

        result = connector.raw_to_normalized(ccxt_convert)

        assert result.source_asset_symbol == "USDT"
        assert result.source_price_quote_asset_symbol == "USDC"
        assert result.quantity == 1000.0
        assert result.total == 999.5
        assert result.fee == 0.5

    @patch("backend.connectors.cex.connector_okx_convert.load_credentials")
    @patch("ccxt.myokx")
    def test_raw_to_normalized_small_amount(self, mock_ccxt, mock_creds):
        """Test normalizing a convert trade with small amounts."""
        mock_creds.return_value = {
            "api_key": "test_key",
            "api_secret": "test_secret",
            "api_passphrase": "test_pass",
        }
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = OKXConvertConnector()

        ccxt_convert = {
            "id": "conv_small",
            "timestamp": 1640995600000,
            "fromCurrency": "EUR",
            "fromAmount": 50.0,
            "toCurrency": "BTC",
            "toAmount": 0.001,
            "price": 50000.0,
            "fee": 0.25,
            "info": {
                "baseCcy": "BTC",
                "quoteCcy": "EUR",
                "fillBaseSz": "0.001",
                "fillQuoteSz": "50",
                "side": "buy",
            },
        }

        result = connector.raw_to_normalized(ccxt_convert)

        assert result.quantity == 0.001
        assert result.total == 50.0
        assert result.price == 50000.0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
