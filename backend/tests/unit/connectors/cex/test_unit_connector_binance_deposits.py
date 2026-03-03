"""
Unit tests for Binance Deposits connector.
Tests the raw_to_normalized method that transforms CCXT deposit responses to NormalizedTransaction.
"""

import pytest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from backend.connectors.cex.connector_binance_deposits import (
    ConnectorBinanceDeposits,
)
from backend.db.models import NormalizedTransaction


class TestBinanceDepositsConnector:
    """Unit tests for Binance deposits connector raw_to_normalized method."""

    @patch("backend.connectors.cex.connector_binance_deposits.load_credentials")
    @patch("ccxt.binance")
    def test_raw_to_normalized_eth_deposit(self, mock_ccxt, mock_creds):
        """Test normalizing an ETH deposit from CCXT format."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorBinanceDeposits(
            account_id=1,
            config={"_account_address_or_identifier": "binance-main-account"}
        )

        # Mock CCXT deposit response
        ccxt_deposit = {
            "id": "dep12345",
            "txid": "0xabc123def456",
            "timestamp": 1640995200000,
            "datetime": "2022-01-01T00:00:00.000Z",
            "currency": "ETH",
            "amount": 1.5,
            "address": "0xmyaddress",
            "addressTo": "0xmyaddress",
            "addressFrom": "0xsenderaddress",
            "tag": None,
            "status": "ok",
            "fee": {"currency": "ETH", "cost": 0.001},
            "network": "eth",
            "info": {},
        }

        result = connector.raw_to_normalized(ccxt_deposit)

        # Assert it returns NormalizedTransaction
        assert isinstance(result, NormalizedTransaction)

        # Assert normalized structure for deposits
        assert result.source == "binance-deposits"
        assert result.account_id == 1
        assert result.source_transaction_id == "dep12345"
        assert result.direction == "inflow"
        assert result.source_transaction_type == "deposit"
        assert result.transaction_type == "transfer"  # Deposits are transfers
        assert result.source_asset_symbol == "ETH"
        assert result.quantity == 1.5
        assert result.fee == 0.001
        assert result.source_fee_quote_asset_symbol == "ETH"
        assert result.network_transaction_id == "0xabc123def456"
        assert result.network == "ethereum"
        # Verify account fields: destination (to) is blockchain address, source (from) is blockchain address
        assert result.source_to_account == "0xmyaddress"  # Blockchain to-address
        assert result.to_account_id == 1  # Resolved account ID
        assert result.source_from_account == "0xsenderaddress"  # Blockchain address
        assert result.date_time == datetime(2022, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

    @patch("backend.connectors.cex.connector_binance_deposits.load_credentials")
    @patch("ccxt.binance")
    def test_raw_to_normalized_btc_deposit_with_fee_dict(self, mock_ccxt, mock_creds):
        """Test normalizing a BTC deposit with fee as dictionary."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorBinanceDeposits()

        ccxt_deposit = {
            "id": "dep67890",
            "txid": "0xdef789abc012",
            "timestamp": 1640995300000,
            "datetime": "2022-01-01T00:01:40.000Z",
            "currency": "BTC",
            "amount": 0.05,
            "address": "bc1qmyaddress",
            "addressTo": "bc1qmyaddress",
            "addressFrom": "bc1qsender",
            "status": "ok",
            "fee": {"currency": "BTC", "cost": 0.0001},
            "network": "btc",
            "info": {},
        }

        result = connector.raw_to_normalized(ccxt_deposit)

        assert result.source_transaction_type == "deposit"
        assert result.quantity == 0.05
        assert result.fee == 0.0001
        assert result.source_fee_quote_asset_symbol == "BTC"
        assert result.network == "bitcoin"

    @patch("backend.connectors.cex.connector_binance_deposits.load_credentials")
    @patch("ccxt.binance")
    def test_raw_to_normalized_skips_pending_status(self, mock_ccxt, mock_creds):
        """Test that deposits with non-ok status are rejected."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorBinanceDeposits()

        ccxt_deposit = {
            "id": "dep_pending",
            "txid": "0xpending123",
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 1.0,
            "status": "pending",  # Not 'ok'
            "network": "eth",
        }

        with pytest.raises(ValueError, match="Deposit status is not 'ok': pending"):
            connector.raw_to_normalized(ccxt_deposit)

    @patch("backend.connectors.cex.connector_binance_deposits.load_credentials")
    @patch("ccxt.binance")
    def test_raw_to_normalized_missing_id_raises(self, mock_ccxt, mock_creds):
        """Test that missing id field raises ValueError."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorBinanceDeposits()

        ccxt_deposit = {
            "txid": "0xabc123",
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 1.0,
            "status": "ok",
        }

        with pytest.raises(ValueError, match="Missing 'id' field"):
            connector.raw_to_normalized(ccxt_deposit)

    @patch("backend.connectors.cex.connector_binance_deposits.load_credentials")
    @patch("ccxt.binance")
    def test_raw_to_normalized_missing_currency_raises(self, mock_ccxt, mock_creds):
        """Test that missing currency field raises ValueError."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorBinanceDeposits()

        ccxt_deposit = {
            "id": "dep123",
            "txid": "0xabc123",
            "timestamp": 1640995200000,
            "amount": 1.0,
            "status": "ok",
        }

        with pytest.raises(ValueError, match="Missing 'currency' field"):
            connector.raw_to_normalized(ccxt_deposit)

    @patch("backend.connectors.cex.connector_binance_deposits.load_credentials")
    @patch("ccxt.binance")
    def test_raw_to_normalized_fee_as_float(self, mock_ccxt, mock_creds):
        """Test normalizing a deposit with fee as float instead of dict."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorBinanceDeposits()

        ccxt_deposit = {
            "id": "dep_float_fee",
            "txid": "0xfloatfee123",
            "timestamp": 1640995200000,
            "currency": "USDT",
            "amount": 100.0,
            "addressTo": "0xdest",
            "addressFrom": "0xsrc",
            "status": "ok",
            "fee": 0.5,  # Fee as float
            "network": "bsc",
        }

        result = connector.raw_to_normalized(ccxt_deposit)

        assert result.fee == 0.5
        assert result.source_fee_quote_asset_symbol == "USDT"  # Defaults to currency

    @patch("backend.connectors.cex.connector_binance_deposits.load_credentials")
    @patch("ccxt.binance")
    def test_raw_to_normalized_no_fee(self, mock_ccxt, mock_creds):
        """Test normalizing a deposit with no fee."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorBinanceDeposits()

        ccxt_deposit = {
            "id": "dep_no_fee",
            "txid": "0xnofee123",
            "timestamp": 1640995200000,
            "currency": "SOL",
            "amount": 10.0,
            "addressTo": "addr1",
            "addressFrom": "addr2",
            "status": "ok",
            "network": "sol",
        }

        result = connector.raw_to_normalized(ccxt_deposit)

        assert result.fee == 0
        assert result.source_asset_symbol == "SOL"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
