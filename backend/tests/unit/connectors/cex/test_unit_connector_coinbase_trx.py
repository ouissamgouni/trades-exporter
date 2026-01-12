"""
Unit tests for Coinbase connector.
Tests the mapping of CCXT trade responses to normalized format.
"""

import pytest
from unittest.mock import MagicMock, patch

from backend.connectors.cex.connector_coinbase_trx import ConnectorCoinbaseTrx


class TestCoinbaseConnector:
    """Unit tests for Coinbase connector trade mapping."""

    @patch("backend.connectors.cex.connector_coinbase_trx.load_credentials")
    @patch("ccxt.coinbase")
    def test_map_trade_buy(self, mock_ccxt, mock_creds):
        """Test mapping a buy trade from CCXT format to normalized format."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorCoinbaseTrx()

        # Mock CCXT trade response (buy)
        ccxt_trade = {
            "id": "cb12345",
            "timestamp": 1640995200000,
            "datetime": "2022-01-01T00:00:00.000Z",
            "symbol": "BTC/USD",
            "type": "limit",
            "side": "buy",
            "price": 50500.0,
            "amount": 0.02,
            "cost": 1010.0,
            "fee": {"currency": "USD", "cost": 5.05},
            "info": {},
        }

        result = connector.raw_to_normalized(ccxt_trade)

        # Assert normalized structure
        assert result.source == "coinbase-transactions"
        assert result.source_transaction_id == "cb12345"
        assert result.direction == "inflow"
        assert result.transaction_type == "trade"  # All CEX trades use 'trade' type
        assert result.source_transaction_type == "buy"  # Original preserved
        assert result.quantity == 0.02
        assert result.price == 50500.0
        assert result.source_price_quote_asset_symbol == "USD"
        assert result.total == 1010.0
        assert result.fee == 5.05
        assert result.source_fee_quote_asset_symbol == "USD"
        assert hasattr(result, "asset_id")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
