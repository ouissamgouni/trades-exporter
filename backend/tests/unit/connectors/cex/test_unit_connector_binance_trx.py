"""
Unit tests for Binance connector.
Tests the mapping of CCXT trade responses to normalized format.
"""

import pytest
from unittest.mock import MagicMock, patch
from datetime import datetime

from backend.connectors.cex.connector_binance_trx import BinanceTrxConnector


class TestBinanceConnector:
    """Unit tests for Binance connector trade mapping."""

    @patch("backend.connectors.cex.connector_binance_trx.load_credentials")
    @patch("ccxt.binance")
    def test_map_trade_buy(self, mock_ccxt, mock_creds):
        """Test mapping a buy trade from CCXT format to normalized format."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = BinanceTrxConnector()

        # Mock CCXT trade response (buy)
        ccxt_trade = {
            "id": "12345",
            "timestamp": 1640995200000,  # 2022-01-01
            "datetime": "2022-01-01T00:00:00.000Z",
            "symbol": "BTC/USDT",
            "type": "limit",
            "side": "buy",
            "price": 50000.0,
            "amount": 0.1,
            "cost": 5000.0,
            "fee": {"currency": "USDT", "cost": 5.0},
            "info": {},
        }

        result = connector.raw_to_normalized(ccxt_trade)

        # Assert normalized structure
        assert result.source == "binance-transactions"
        assert result.source_transaction_id == "12345"
        assert result.direction == "inflow"
        assert result.transaction_type == "trade"  # All CEX trades use 'trade' type
        assert result.source_transaction_type == "buy"  # Original preserved
        assert result.quantity == 0.1
        assert result.price == 50000.0
        assert result.source_price_quote_asset_symbol == "USDT"
        assert result.total == 5000.0
        assert result.fee == 5.0
        assert result.source_fee_quote_asset_symbol == "USDT"
        assert isinstance(result.date_time, datetime)
        assert hasattr(result, "asset_id")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
