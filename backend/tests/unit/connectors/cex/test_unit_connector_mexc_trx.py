"""
Unit tests for MEXC connector.
Tests the mapping of CCXT trade responses to normalized format.
"""

import pytest
from unittest.mock import MagicMock, patch
from datetime import datetime

from backend.connectors.cex.connector_mexc_trx import MEXCConnectorTrx


class TestMEXCConnector:
    """Unit tests for MEXC connector trade mapping."""

    @patch("backend.connectors.cex.connector_mexc_trx.load_credentials")
    @patch("ccxt.mexc")
    def test_map_trade_buy(self, mock_ccxt, mock_creds):
        """Test mapping a buy trade from CCXT format to normalized format."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = MEXCConnectorTrx()

        # Mock CCXT trade response (buy)
        ccxt_trade = {
            "id": "mx12345",
            "timestamp": 1640995200000,
            "datetime": "2022-01-01T00:00:00.000Z",
            "symbol": "BTC/USDT",
            "type": "limit",
            "side": "buy",
            "price": 48000.0,
            "amount": 0.05,
            "cost": 2400.0,
            "fee": {"currency": "USDT", "cost": 2.4},
            "info": {},
        }

        result = connector.raw_to_normalized(ccxt_trade)

        # Assert normalized structure
        assert result.source == "mexc-transactions"
        assert result.source_transaction_id == "mx12345"
        assert result.direction == "inflow"
        assert result.source_transaction_type == "buy"  # Original preserved
        assert result.transaction_type == "trade"  # All CEX trades use 'trade' type
        assert result.quantity == 0.05
        assert result.price == 48000.0
        assert result.source_price_quote_asset_symbol == "USDT"
        assert result.total == 2400.0
        assert result.source_fee_quote_asset_symbol == "USDT"
        assert result.fee == 2.4
        assert isinstance(result.date_time, datetime)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
