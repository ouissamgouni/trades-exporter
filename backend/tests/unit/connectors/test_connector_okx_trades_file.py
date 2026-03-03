"""
Unit tests for OKX Trades File connector
"""

import pytest
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock
import pandas as pd

from backend.connectors.cex.connector_okx_trades_file import OKXTradesFileConnector
from backend.db.models import NormalizedTransaction


class TestOKXTradesFileConnector:
    """Test suite for OKX trades file connector."""

    def test_connector_name(self):
        """Test that connector_name property returns correct identifier."""
        connector = OKXTradesFileConnector(
            account_id=1,
            config={"file_path": "/tmp/test.csv"},
        )
        assert connector.connector_name == "okx_trades_file"

    def test_initialization_with_config(self):
        """Test connector initialization with config."""
        config = {
            "file_path": "/tmp/test.csv",
            "file_import_id": 123,
        }
        connector = OKXTradesFileConnector(account_id=1, config=config)
        
        assert connector._file_path == "/tmp/test.csv"
        assert connector._file_import_id == 123

    def test_raw_to_normalized_regular_trade(self):
        """Test normalization of regular spot trade."""
        connector = OKXTradesFileConnector(account_id=1)
        
        raw_row = {
            "datetime": pd.Timestamp("2025-10-12 11:55:44+00:00"),
            "transaction_id": "923433",
            "instrument": "Spot",
            "symbol": "USDC-EUR",
            "base_asset": "USDC",
            "quantity": 16.1864,
            "price": 0.87060000,
            "quote_asset": "EUR",
            "total": 14.09188855,
            "fee": 0.00000000,
            "fee_currency": "USDC",
        }
        
        result = connector.raw_to_normalized(raw_row)
        
        assert isinstance(result, NormalizedTransaction)
        assert result.source == "okx-trades-file"
        assert result.source_account == "okx_trades_file"
        assert result.source_transaction_id == "923433"
        assert result.direction == "inflow"
        assert result.source_transaction_type == "buy"
        assert result.transaction_type == "trade"
        assert result.source_asset_symbol == "USDC"
        assert result.quantity == 16.1864
        assert result.price == 0.87060000
        assert result.source_price_quote_asset_symbol == "EUR"
        assert result.total == pytest.approx(14.09188855, rel=1e-4)
        assert result.fee == 0.0
        assert result.source_fee_quote_asset_symbol == "USDC"
        assert result.tags is None or result.tags == []

    def test_raw_to_normalized_convert_trade(self):
        """Test normalization of convert trade with tags."""
        connector = OKXTradesFileConnector(account_id=1)
        
        raw_row = {
            "datetime": pd.Timestamp("2025-10-02 00:32:19+00:00"),
            "transaction_id": "2914509106544775170",
            "instrument": "Spot",
            "symbol": "BTC-EUR-CONVERT",
            "base_asset": "BTC",
            "quantity": 0.0123,
            "price": 101852.81713905,
            "quote_asset": "EUR",
            "total": 1250.00000000,
            "fee": 0.0,
            "fee_currency": "BTC",
        }
        
        result = connector.raw_to_normalized(raw_row)
        
        assert isinstance(result, NormalizedTransaction)
        assert result.source == "okx-trades-file"
        assert result.direction == "inflow"
        assert result.source_transaction_type == "buy"
        assert result.transaction_type == "trade"
        assert result.source_asset_symbol == "BTC"
        assert result.tags is not None
        assert result.tags == {"type": "convert"}

    def test_raw_to_normalized_with_fee(self):
        """Test normalization with non-zero fee."""
        connector = OKXTradesFileConnector(account_id=1)
        
        raw_row = {
            "datetime": pd.Timestamp("2025-10-02 21:33:11+00:00"),
            "transaction_id": "7495027",
            "instrument": "Spot",
            "symbol": "ETH-EUR",
            "base_asset": "ETH",
            "quantity": 0.0783,
            "price": 3817.51000000,
            "quote_asset": "EUR",
            "total": 298.76215011,
            "fee": 0.00027391,  # Already absolute
            "fee_currency": "ETH",
        }
        
        result = connector.raw_to_normalized(raw_row)
        
        assert result.fee == 0.00027391
        assert result.source_fee_quote_asset_symbol == "ETH"

    def test_raw_to_normalized_missing_transaction_id(self):
        """Test that missing transaction_id raises ValueError."""
        connector = OKXTradesFileConnector(account_id=1)
        
        raw_row = {
            "datetime": pd.Timestamp("2025-10-12 11:55:44+00:00"),
            "base_asset": "USDC",
            "quantity": 16.1864,
        }
        
        with pytest.raises(ValueError, match="Missing 'transaction_id' field"):
            connector.raw_to_normalized(raw_row)

    def test_raw_to_normalized_missing_base_asset(self):
        """Test that missing base_asset raises ValueError."""
        connector = OKXTradesFileConnector(account_id=1)
        
        raw_row = {
            "datetime": pd.Timestamp("2025-10-12 11:55:44+00:00"),
            "transaction_id": "923433",
            "quantity": 16.1864,
        }
        
        with pytest.raises(ValueError, match="Missing 'base_asset' field"):
            connector.raw_to_normalized(raw_row)

    def test_raw_to_normalized_missing_quote_asset(self):
        """Test that missing quote_asset raises ValueError."""
        connector = OKXTradesFileConnector(account_id=1)
        
        raw_row = {
            "datetime": pd.Timestamp("2025-10-12 11:55:44+00:00"),
            "transaction_id": "923433",
            "base_asset": "USDC",
            "quantity": 16.1864,
        }
        
        with pytest.raises(ValueError, match="Missing 'quote_asset' field"):
            connector.raw_to_normalized(raw_row)

    def test_raw_to_normalized_missing_quantity(self):
        """Test that missing quantity raises ValueError."""
        connector = OKXTradesFileConnector(account_id=1)
        
        raw_row = {
            "datetime": pd.Timestamp("2025-10-12 11:55:44+00:00"),
            "transaction_id": "923433",
            "base_asset": "USDC",
            "quote_asset": "EUR",
        }
        
        with pytest.raises(ValueError, match="Missing or invalid 'quantity' field"):
            connector.raw_to_normalized(raw_row)

    def test_raw_to_normalized_missing_price(self):
        """Test that missing price raises ValueError."""
        connector = OKXTradesFileConnector(account_id=1)
        
        raw_row = {
            "datetime": pd.Timestamp("2025-10-12 11:55:44+00:00"),
            "transaction_id": "923433",
            "base_asset": "USDC",
            "quote_asset": "EUR",
            "quantity": 16.1864,
        }
        
        with pytest.raises(ValueError, match="Missing or invalid 'price' field"):
            connector.raw_to_normalized(raw_row)

    def test_raw_to_normalized_missing_total(self):
        """Test that missing total raises ValueError."""
        connector = OKXTradesFileConnector(account_id=1)
        
        raw_row = {
            "datetime": pd.Timestamp("2025-10-12 11:55:44+00:00"),
            "transaction_id": "923433",
            "base_asset": "USDC",
            "quote_asset": "EUR",
            "quantity": 16.1864,
            "price": 0.87060000,
        }
        
        with pytest.raises(ValueError, match="Missing or invalid 'total' field"):
            connector.raw_to_normalized(raw_row)

    def test_raw_to_normalized_datetime_handling(self):
        """Test datetime handling for both pandas Timestamp and datetime objects."""
        connector = OKXTradesFileConnector(account_id=1)
        
        # Test with datetime object
        raw_row = {
            "datetime": datetime(2025, 10, 12, 11, 55, 44, tzinfo=timezone.utc),
            "transaction_id": "923433",
            "base_asset": "USDC",
            "quantity": 16.1864,
            "price": 0.87060000,
            "quote_asset": "EUR",
            "total": 14.09188855,
            "fee": 0.0,
            "fee_currency": "USDC",
            "symbol": "USDC-EUR",
            "instrument": "Spot",
        }
        
        result = connector.raw_to_normalized(raw_row)
        assert result.date_time.tzinfo is not None

    def test_raw_to_normalized_timezone_naive_datetime(self):
        """Test that timezone-naive datetime gets UTC timezone."""
        connector = OKXTradesFileConnector(account_id=1)
        
        raw_row = {
            "datetime": datetime(2025, 10, 12, 11, 55, 44),  # No timezone
            "transaction_id": "923433",
            "base_asset": "USDC",
            "quantity": 16.1864,
            "price": 0.87060000,
            "quote_asset": "EUR",
            "total": 14.09188855,
            "fee": 0.0,
            "fee_currency": "USDC",
            "symbol": "USDC-EUR",
            "instrument": "Spot",
        }
        
        result = connector.raw_to_normalized(raw_row)
        assert result.date_time.tzinfo == timezone.utc

    def test_raw_to_normalized_default_fee_currency(self):
        """Test that missing fee_currency defaults to quote_asset."""
        connector = OKXTradesFileConnector(account_id=1)
        
        raw_row = {
            "datetime": pd.Timestamp("2025-10-12 11:55:44+00:00"),
            "transaction_id": "923433",
            "base_asset": "USDC",
            "quantity": 16.1864,
            "price": 0.87060000,
            "quote_asset": "EUR",
            "total": 14.09188855,
            "fee": 0.001,
            "symbol": "USDC-EUR",
            "instrument": "Spot",
        }
        
        result = connector.raw_to_normalized(raw_row)
        assert result.source_fee_quote_asset_symbol == "EUR"

    @patch("backend.file_loaders.okx_trades_loader.load_okx_trades_file")
    def test_load_file_data(self, mock_loader):
        """Test _load_file_data method."""
        mock_df = pd.DataFrame([
            {
                "datetime": pd.Timestamp("2025-10-12 11:55:44+00:00"),
                "transaction_id": "923433",
                "base_asset": "USDC",
                "quantity": 16.1864,
                "price": 0.87,
                "quote_asset": "EUR",
                "total": 14.09,
                "fee": 0.0,
                "fee_currency": "USDC",
                "symbol": "USDC-EUR",
                "instrument": "Spot",
            }
        ])
        mock_loader.return_value = mock_df
        
        connector = OKXTradesFileConnector(
            account_id=1,
            config={"file_path": "/tmp/test.csv"},
        )
        
        data = connector._load_file_data()
        
        assert len(data) == 1
        mock_loader.assert_called_once_with("/tmp/test.csv")

    @patch("backend.file_loaders.okx_trades_loader.load_okx_trades_file")
    def test_yield_raws(self, mock_loader):
        """Test yield_raws method."""
        mock_df = pd.DataFrame([
            {
                "datetime": pd.Timestamp("2025-10-12 11:55:44+00:00"),
                "transaction_id": "923433",
                "base_asset": "USDC",
                "quantity": 16.1864,
                "price": 0.87,
                "quote_asset": "EUR",
                "total": 14.09,
                "fee": 0.0,
                "fee_currency": "USDC",
                "symbol": "USDC-EUR",
                "instrument": "Spot",
            }
        ])
        mock_loader.return_value = mock_df
        
        connector = OKXTradesFileConnector(
            account_id=1,
            config={"file_path": "/tmp/test.csv"},
        )
        
        results = list(connector.yield_raws())
        
        assert len(results) == 1
        assert results[0]["transaction_id"] == "923433"

    def test_all_trades_are_inflow_buy(self):
        """Test that all trades have direction='inflow' and source_transaction_type='buy'."""
        connector = OKXTradesFileConnector(account_id=1)
        
        # Test regular trade
        raw_regular = {
            "datetime": pd.Timestamp("2025-10-12 11:55:44+00:00"),
            "transaction_id": "923433",
            "instrument": "Spot",
            "symbol": "USDC-EUR",
            "base_asset": "USDC",
            "quantity": 16.1864,
            "price": 0.87060000,
            "quote_asset": "EUR",
            "total": 14.09188855,
            "fee": 0.0,
            "fee_currency": "USDC",
        }
        
        result_regular = connector.raw_to_normalized(raw_regular)
        assert result_regular.direction == "inflow"
        assert result_regular.source_transaction_type == "buy"
        
        # Test convert trade
        raw_convert = {
            "datetime": pd.Timestamp("2025-10-02 00:32:19+00:00"),
            "transaction_id": "2914509106544775170",
            "instrument": "Spot",
            "symbol": "BTC-EUR-CONVERT",
            "base_asset": "BTC",
            "quantity": 0.0123,
            "price": 101852.81713905,
            "quote_asset": "EUR",
            "total": 1250.00000000,
            "fee": 0.0,
            "fee_currency": "BTC",
        }
        
        result_convert = connector.raw_to_normalized(raw_convert)
        assert result_convert.direction == "inflow"
        assert result_convert.source_transaction_type == "buy"
