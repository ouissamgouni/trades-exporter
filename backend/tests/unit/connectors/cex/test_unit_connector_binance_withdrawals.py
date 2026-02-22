"""
Unit tests for Binance Withdrawals connector.
Tests the raw_to_normalized method that transforms CCXT withdrawal responses to NormalizedTransaction.
"""

import pytest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from backend.connectors.cex.connector_binance_withdrawals import (
    BinanceWithdrawalsConnector,
)
from backend.db.models import NormalizedTransaction


class TestBinanceWithdrawalsConnector:
    """Unit tests for Binance withdrawals connector raw_to_normalized method."""

    @patch("backend.connectors.cex.connector_binance_withdrawals.load_credentials")
    @patch("ccxt.binance")
    def test_raw_to_normalized_eth_withdrawal(self, mock_ccxt, mock_creds):
        """Test normalizing an ETH withdrawal from CCXT format."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = BinanceWithdrawalsConnector(
            account_id=1,
            config={"_account_address_or_identifier": "binance-main-account"}
        )

        # Mock CCXT withdrawal response
        ccxt_withdrawal = {
            "id": "wd12345",
            "txid": "0xabc123def456",
            "timestamp": 1640995200000,
            "datetime": "2022-01-01T00:00:00.000Z",
            "currency": "ETH",
            "amount": 1.5,
            "address": "0xdestaddress",
            "addressTo": "0xdestaddress",
            "addressFrom": "0xsrcaddress",
            "tag": None,
            "status": "ok",
            "fee": {"currency": "ETH", "cost": 0.005},
            "network": "eth",
            "info": {},
        }

        result = connector.raw_to_normalized(ccxt_withdrawal)

        # Assert it returns NormalizedTransaction
        assert isinstance(result, NormalizedTransaction)

        # Assert normalized structure for withdrawals
        assert result.source == "binance-withdrawals"
        assert result.account_id == 1
        assert result.source_transaction_id == "wd12345"
        assert result.direction == "outflow"
        assert result.source_transaction_type == "withdrawal"
        assert result.transaction_type == "transfer"  # Withdrawals are transfers
        assert result.source_asset_symbol == "ETH"
        assert result.quantity == 1.5
        assert result.fee == 0.005
        assert result.source_fee_quote_asset_symbol == "ETH"
        assert result.network_transaction_id == "0xabc123def456"
        assert result.network == "eth"
        # Verify account fields: source (from) is connector account, destination (to) is blockchain address
        assert result.source_from_account == "binance-main-account"  # Connector account identifier
        assert result.from_account_id == 1  # Resolved account ID
        assert result.source_to_account == "0xdestaddress"  # Blockchain address
        assert result.date_time == datetime(2022, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

    @patch("backend.connectors.cex.connector_binance_withdrawals.load_credentials")
    @patch("ccxt.binance")
    def test_raw_to_normalized_btc_withdrawal(self, mock_ccxt, mock_creds):
        """Test normalizing a BTC withdrawal."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = BinanceWithdrawalsConnector()

        ccxt_withdrawal = {
            "id": "wd67890",
            "txid": "btc_tx_hash_123",
            "timestamp": 1640995300000,
            "currency": "BTC",
            "amount": 0.1,
            "address": "bc1qdestaddress",
            "addressTo": "bc1qdestaddress",
            "addressFrom": "bc1qsrcaddress",
            "status": "ok",
            "fee": {"currency": "BTC", "cost": 0.0001},
            "network": "btc",
            "info": {},
        }

        result = connector.raw_to_normalized(ccxt_withdrawal)

        assert result.source_transaction_type == "withdrawal"
        assert result.quantity == 0.1
        assert result.fee == 0.0001
        assert result.source_fee_quote_asset_symbol == "BTC"
        assert result.network == "btc"

    @patch("backend.connectors.cex.connector_binance_withdrawals.load_credentials")
    @patch("ccxt.binance")
    def test_raw_to_normalized_skips_pending_status(self, mock_ccxt, mock_creds):
        """Test that withdrawals with non-ok status are rejected."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = BinanceWithdrawalsConnector()

        ccxt_withdrawal = {
            "id": "wd_pending",
            "txid": "0xpending123",
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 1.0,
            "addressTo": "0xdest",
            "status": "pending",  # Not 'ok'
            "network": "eth",
        }

        with pytest.raises(ValueError, match="Withdrawal status is not 'ok': pending"):
            connector.raw_to_normalized(ccxt_withdrawal)

    @patch("backend.connectors.cex.connector_binance_withdrawals.load_credentials")
    @patch("ccxt.binance")
    def test_raw_to_normalized_skips_failed_status(self, mock_ccxt, mock_creds):
        """Test that failed withdrawals are rejected."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = BinanceWithdrawalsConnector()

        ccxt_withdrawal = {
            "id": "wd_failed",
            "txid": "0xfailed123",
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 1.0,
            "addressTo": "0xdest",
            "status": "failed",
            "network": "eth",
        }

        with pytest.raises(ValueError, match="Withdrawal status is not 'ok': failed"):
            connector.raw_to_normalized(ccxt_withdrawal)

    @patch("backend.connectors.cex.connector_binance_withdrawals.load_credentials")
    @patch("ccxt.binance")
    def test_raw_to_normalized_missing_id_raises(self, mock_ccxt, mock_creds):
        """Test that missing id field raises ValueError."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = BinanceWithdrawalsConnector()

        ccxt_withdrawal = {
            "txid": "0xabc123",
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 1.0,
            "addressTo": "0xdest",
            "status": "ok",
        }

        with pytest.raises(ValueError, match="Missing 'id' field"):
            connector.raw_to_normalized(ccxt_withdrawal)

    @patch("backend.connectors.cex.connector_binance_withdrawals.load_credentials")
    @patch("ccxt.binance")
    def test_raw_to_normalized_missing_currency_raises(self, mock_ccxt, mock_creds):
        """Test that missing currency field raises ValueError."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = BinanceWithdrawalsConnector()

        ccxt_withdrawal = {
            "id": "wd123",
            "txid": "0xabc123",
            "timestamp": 1640995200000,
            "amount": 1.0,
            "addressTo": "0xdest",
            "status": "ok",
        }

        with pytest.raises(ValueError, match="Missing currency field"):
            connector.raw_to_normalized(ccxt_withdrawal)

    @patch("backend.connectors.cex.connector_binance_withdrawals.load_credentials")
    @patch("ccxt.binance")
    def test_raw_to_normalized_missing_destination_raises(self, mock_ccxt, mock_creds):
        """Test that missing destination address raises ValueError."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = BinanceWithdrawalsConnector()

        ccxt_withdrawal = {
            "id": "wd123",
            "txid": "0xabc123",
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 1.0,
            "status": "ok",
            "addressTo": None,  # Missing destination
        }

        with pytest.raises(ValueError, match="Missing destination address"):
            connector.raw_to_normalized(ccxt_withdrawal)

    @patch("backend.connectors.cex.connector_binance_withdrawals.load_credentials")
    @patch("ccxt.binance")
    def test_raw_to_normalized_invalid_amount_raises(self, mock_ccxt, mock_creds):
        """Test that invalid amount raises ValueError."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = BinanceWithdrawalsConnector()

        ccxt_withdrawal = {
            "id": "wd123",
            "txid": "0xabc123",
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 0,  # Invalid amount
            "addressTo": "0xdest",
            "status": "ok",
        }

        with pytest.raises(ValueError, match="Invalid amount"):
            connector.raw_to_normalized(ccxt_withdrawal)

    @patch("backend.connectors.cex.connector_binance_withdrawals.load_credentials")
    @patch("ccxt.binance")
    def test_raw_to_normalized_fee_as_float(self, mock_ccxt, mock_creds):
        """Test normalizing a withdrawal with fee as float instead of dict."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = BinanceWithdrawalsConnector()

        ccxt_withdrawal = {
            "id": "wd_float_fee",
            "txid": "0xfloatfee123",
            "timestamp": 1640995200000,
            "currency": "USDT",
            "amount": 100.0,
            "addressTo": "0xdest",
            "addressFrom": "0xsrc",
            "status": "ok",
            "fee": 1.0,  # Fee as float
            "network": "bsc",
        }

        result = connector.raw_to_normalized(ccxt_withdrawal)

        assert result.fee == 1.0
        assert result.source_fee_quote_asset_symbol == "USDT"  # Defaults to currency

    @patch("backend.connectors.cex.connector_binance_withdrawals.load_credentials")
    @patch("ccxt.binance")
    def test_raw_to_normalized_currency_from_info(self, mock_ccxt, mock_creds):
        """Test normalizing withdrawal where currency is in info.coin."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = BinanceWithdrawalsConnector()

        ccxt_withdrawal = {
            "id": "wd_info_currency",
            "txid": "0xinfo123",
            "timestamp": 1640995200000,
            "currency": "",  # Empty top-level currency
            "amount": 50.0,
            "addressTo": "0xdest",
            "status": "ok",
            "fee": 0.1,
            "network": "bsc",
            "info": {"coin": "BNB"},  # Currency in info
        }

        result = connector.raw_to_normalized(ccxt_withdrawal)

        assert result.source_asset_symbol == "BNB"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
