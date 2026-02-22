"""
Unit tests for OKX Trades file loader
"""

import pytest
import pandas as pd
from io import BytesIO
from datetime import datetime

from backend.file_loaders.okx_trades_loader import (
    load_okx_trades_file,
    get_okx_trades_file_preview,
)


class TestOKXTradesLoader:
    """Test suite for OKX trades file loader."""

    def test_load_valid_csv(self):
        """Test loading a valid OKX trades CSV file."""
        csv_content = """Order ID,Trade ID,Trade Time,Instrument,Symbol,Filled Amount,Filled Amount Unit,Filled Price,Fill Price Unit,Trading Volume,Trading Volume Unit,taker/maker,Fee,Fee Unit
2944876033454710784,923433,2025-10-12 11:55:44,Spot,USDC-EUR,16.1864,USDC,0.87060000,EUR,14.09188855,EUR,taker,0.00000000,USDC
2944876033454710784,923432,2025-10-12 11:55:44,Spot,USDC-EUR,558.8469,USDC,0.87040000,EUR,486.42036004,EUR,taker,0.00000000,USDC"""
        
        df = load_okx_trades_file(content=csv_content.encode())
        
        assert len(df) == 2
        assert "transaction_id" in df.columns
        assert "datetime" in df.columns
        assert "base_asset" in df.columns
        assert "quantity" in df.columns
        assert "price" in df.columns
        assert "quote_asset" in df.columns
        assert "total" in df.columns
        assert "fee" in df.columns
        assert "fee_currency" in df.columns
        
        # Check first row values
        first_row = df.iloc[0]
        assert first_row["transaction_id"] == "923433"
        assert first_row["base_asset"] == "USDC"
        assert first_row["quantity"] == 16.1864
        assert first_row["price"] == 0.87060000
        assert first_row["quote_asset"] == "EUR"
        assert first_row["total"] == 14.09188855
        assert first_row["fee"] == 0.0
        assert first_row["fee_currency"] == "USDC"
        assert first_row["symbol"] == "USDC-EUR"
        assert first_row["instrument"] == "Spot"

    def test_load_with_convert_trade(self):
        """Test loading CSV with convert trades."""
        csv_content = """Order ID,Trade ID,Trade Time,Instrument,Symbol,Filled Amount,Filled Amount Unit,Filled Price,Fill Price Unit,Trading Volume,Trading Volume Unit,taker/maker,Fee,Fee Unit
2914509106635153408,2914509106544775170,2025-10-02 00:32:19,Spot,BTC-EUR-CONVERT,0.0123,BTC,101852.81713905,EUR,1250.00000000,EUR,taker,0.00000000,BTC"""
        
        df = load_okx_trades_file(content=csv_content.encode())
        
        assert len(df) == 1
        first_row = df.iloc[0]
        assert "CONVERT" in first_row["symbol"]
        assert first_row["base_asset"] == "BTC"
        assert first_row["quote_asset"] == "EUR"
        assert first_row["transaction_id"] == "2914509106544775170"

    def test_load_with_negative_fees(self):
        """Test that negative fees are converted to absolute values."""
        csv_content = """Order ID,Trade ID,Trade Time,Instrument,Symbol,Filled Amount,Filled Amount Unit,Filled Price,Fill Price Unit,Trading Volume,Trading Volume Unit,taker/maker,Fee,Fee Unit
2917047534379671552,7495027,2025-10-02 21:33:11,Spot,ETH-EUR,0.0783,ETH,3817.51000000,EUR,298.76215011,EUR,taker,-0.00027391,ETH"""
        
        df = load_okx_trades_file(content=csv_content.encode())
        
        assert len(df) == 1
        first_row = df.iloc[0]
        assert first_row["fee"] == 0.00027391  # Should be positive
        assert first_row["fee_currency"] == "ETH"

    def test_timezone_aware_datetime(self):
        """Test that datetimes are timezone-aware (UTC)."""
        csv_content = """Order ID,Trade ID,Trade Time,Instrument,Symbol,Filled Amount,Filled Amount Unit,Filled Price,Fill Price Unit,Trading Volume,Trading Volume Unit,taker/maker,Fee,Fee Unit
2944876033454710784,923433,2025-10-12 11:55:44,Spot,USDC-EUR,16.1864,USDC,0.87060000,EUR,14.09188855,EUR,taker,0.00000000,USDC"""
        
        df = load_okx_trades_file(content=csv_content.encode())
        
        first_dt = df.iloc[0]["datetime"]
        assert first_dt.tzinfo is not None
        assert str(first_dt.tzinfo) == "UTC"

    def test_missing_required_columns(self):
        """Test that missing required columns raises ValueError."""
        csv_content = """Order ID,Trade ID,Trade Time
123,456,2025-10-12 11:55:44"""
        
        with pytest.raises(ValueError, match="Missing required columns"):
            load_okx_trades_file(content=csv_content.encode())

    def test_neither_file_path_nor_content(self):
        """Test that neither file_path nor content raises ValueError."""
        with pytest.raises(ValueError, match="Either file_path or content must be provided"):
            load_okx_trades_file()

    def test_both_file_path_and_content(self):
        """Test that both file_path and content raises ValueError."""
        with pytest.raises(ValueError, match="Only one of file_path or content should be provided"):
            load_okx_trades_file(file_path="/tmp/test.csv", content=b"test")

    def test_preview_function(self):
        """Test the preview function returns correct structure."""
        csv_content = """Order ID,Trade ID,Trade Time,Instrument,Symbol,Filled Amount,Filled Amount Unit,Filled Price,Fill Price Unit,Trading Volume,Trading Volume Unit,taker/maker,Fee,Fee Unit
2944876033454710784,923433,2025-10-12 11:55:44,Spot,USDC-EUR,16.1864,USDC,0.87060000,EUR,14.09188855,EUR,taker,0.00000000,USDC
2944876033454710784,923432,2025-10-12 11:55:44,Spot,BTC-EUR,558.8469,BTC,0.87040000,EUR,486.42036004,EUR,taker,0.00000000,BTC
2914509106635153408,2914509106544775170,2025-10-02 00:32:19,Spot,ETH-EUR-CONVERT,0.0123,ETH,101852.81713905,EUR,1250.00000000,EUR,taker,0.00000000,ETH"""
        
        preview = get_okx_trades_file_preview(csv_content.encode())
        
        assert preview["row_count"] == 3
        assert "date_range" in preview
        assert preview["date_range"]["min_date"] is not None
        assert preview["date_range"]["max_date"] is not None
        assert "currencies" in preview
        assert set(preview["currencies"]) == {"USDC", "BTC", "ETH"}
        assert preview["convert_trades_count"] == 1
        assert "sample_rows" in preview
        assert len(preview["sample_rows"]) <= 5

    def test_preview_empty_file(self):
        """Test preview function with empty CSV."""
        csv_content = """Order ID,Trade ID,Trade Time,Instrument,Symbol,Filled Amount,Filled Amount Unit,Filled Price,Fill Price Unit,Trading Volume,Trading Volume Unit,taker/maker,Fee,Fee Unit"""
        
        preview = get_okx_trades_file_preview(csv_content.encode())
        
        assert preview["row_count"] == 0
        assert preview["date_range"] is None
        assert preview["currencies"] == []
        assert preview["convert_trades_count"] == 0
        assert preview["sample_rows"] == []

    def test_uppercase_asset_symbols(self):
        """Test that asset symbols are converted to uppercase."""
        csv_content = """Order ID,Trade ID,Trade Time,Instrument,Symbol,Filled Amount,Filled Amount Unit,Filled Price,Fill Price Unit,Trading Volume,Trading Volume Unit,taker/maker,Fee,Fee Unit
2944876033454710784,923433,2025-10-12 11:55:44,Spot,usdc-eur,16.1864,usdc,0.87060000,eur,14.09188855,EUR,taker,0.00000000,usdc"""
        
        df = load_okx_trades_file(content=csv_content.encode())
        
        first_row = df.iloc[0]
        assert first_row["base_asset"] == "USDC"
        assert first_row["quote_asset"] == "EUR"
        assert first_row["fee_currency"] == "USDC"

    def test_numeric_precision(self):
        """Test that high-precision decimal values are preserved."""
        csv_content = """Order ID,Trade ID,Trade Time,Instrument,Symbol,Filled Amount,Filled Amount Unit,Filled Price,Fill Price Unit,Trading Volume,Trading Volume Unit,taker/maker,Fee,Fee Unit
2944876033454710784,923433,2025-10-12 11:55:44,Spot,USDC-EUR,16.186400000000,USDC,0.870600000000000,EUR,14.091888550000,EUR,taker,-0.000273910000,USDC"""
        
        df = load_okx_trades_file(content=csv_content.encode())
        
        first_row = df.iloc[0]
        assert first_row["quantity"] == pytest.approx(16.1864)
        assert first_row["price"] == pytest.approx(0.87060000)
        assert first_row["total"] == pytest.approx(14.09188855)
        assert first_row["fee"] == pytest.approx(0.00027391)  # Absolute value
