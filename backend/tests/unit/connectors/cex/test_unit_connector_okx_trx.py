"""
Unit tests for OKX connector.
Tests the mapping of CCXT trade responses to normalized format.
"""

import pytest
from unittest.mock import MagicMock, patch

from backend.connectors.cex.connector_okx_trx import OKXConnectorTrx


class TestOKXConnector:
    """Unit tests for OKX connector trade mapping."""

    @patch("backend.connectors.cex.connector_okx_trx.load_credentials")
    @patch("ccxt.myokx")
    def test_map_trade_buy(self, mock_ccxt, mock_creds):
        """Test mapping a buy trade from CCXT format to normalized format."""
        mock_creds.return_value = {
            "api_key": "test_key",
            "api_secret": "test_secret",
            "api_passphrase": "test_pass",
        }
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = OKXConnectorTrx()

        # Mock CCXT trade response (buy)
        ccxt_trade = {
            "id": "okx12345",
            "timestamp": 1640995200000,
            "datetime": "2022-01-01T00:00:00.000Z",
            "symbol": "BTC/USDT",
            "type": "limit",
            "side": "buy",
            "price": 49500.0,
            "amount": 0.08,
            "cost": 3960.0,
            "fee": {"currency": "USDT", "cost": 3.96},
            "info": {"billId": "12345"},
        }

        result = connector.raw_to_normalized(ccxt_trade)

        # Assert normalized structure
        assert result.source == "okx-transactions"
        assert result.source_transaction_id == "okx12345"
        assert result.direction == "inflow"
        assert result.transaction_type == "acquisition"
        assert result.source_transaction_type == "buy"
        assert result.quantity == 0.08
        assert result.price == 49500.0
        assert result.source_price_quote_asset_symbol == "USDT"
        assert result.total == 3960.0
        assert result.fee == 3.96


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
