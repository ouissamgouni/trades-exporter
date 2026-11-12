"""
Unit tests for Coinbase Deposits and Withdrawals connectors.
Tests the raw_to_normalized method that transforms CCXT responses to NormalizedTransaction.
"""

import pytest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from backend.connectors.cex.connector_coinbase_deposits import (
    ConnectorCoinbaseDeposits,
)
from backend.connectors.cex.connector_coinbase_withdrawals import (
    ConnectorCoinbaseWithdrawals,
)
from backend.db.models import NormalizedTransaction


class TestCoinbaseDepositsConnector:
    """Unit tests for Coinbase deposits connector raw_to_normalized method."""

    @patch("backend.connectors.cex.connector_coinbase_deposits.load_credentials")
    @patch("ccxt.coinbase")
    def test_connector_name(self, mock_ccxt, mock_creds):
        """Test connector_name property returns correct value."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorCoinbaseDeposits(account_id=1)
        assert connector.connector_name == "coinbase_deposits"

    @patch("backend.connectors.cex.connector_coinbase_deposits.load_credentials")
    @patch("ccxt.coinbase")
    def test_initialization_with_credentials(self, mock_ccxt, mock_creds):
        """Test connector initialization loads credentials from settings.yaml."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorCoinbaseDeposits(account_id=1)
        
        assert connector.api_key == "test_key"
        assert connector.api_secret == "test_secret"
        mock_creds.assert_called_once_with("coinbase")

    @patch("backend.connectors.cex.connector_coinbase_deposits.load_credentials")
    @patch("ccxt.coinbase")
    def test_raw_to_normalized_eth_deposit(self, mock_ccxt, mock_creds):
        """Test normalizing an ETH deposit from CCXT format."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorCoinbaseDeposits(account_id=1)

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
            "network": "ethereum",
            "info": {},
        }

        result = connector.raw_to_normalized(ccxt_deposit)

        # Assert it returns NormalizedTransaction
        assert isinstance(result, NormalizedTransaction)

        # Assert normalized structure for deposits
        assert result.source == "coinbase-deposits"
        assert result.account_id == 1
        assert result.source_account == "coinbase_deposits"
        assert result.source_transaction_id == "dep12345"
        assert result.direction == "inflow"
        assert result.source_transaction_type == "deposit"
        assert result.transaction_type == "transfer"
        assert result.source_asset_symbol == "ETH"
        assert result.quantity == 1.5
        assert result.fee == 0.001
        assert result.source_fee_quote_asset_symbol == "ETH"
        assert result.network_transaction_id == "0xabc123def456"
        assert result.network == "ethereum"
        assert result.source_to_account == "0xmyaddress"
        assert result.source_from_account == "0xsenderaddress"
        assert result.date_time == datetime(2022, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

    @patch("backend.connectors.cex.connector_coinbase_deposits.load_credentials")
    @patch("ccxt.coinbase")
    def test_raw_to_normalized_btc_deposit(self, mock_ccxt, mock_creds):
        """Test normalizing a BTC deposit with fee as dictionary."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorCoinbaseDeposits()

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
            "network": "bitcoin",
            "info": {},
        }

        result = connector.raw_to_normalized(ccxt_deposit)

        assert result.source_transaction_type == "deposit"
        assert result.quantity == 0.05
        assert result.fee == 0.0001
        assert result.source_fee_quote_asset_symbol == "BTC"
        assert result.network == "bitcoin"

    @patch("backend.connectors.cex.connector_coinbase_deposits.load_credentials")
    @patch("ccxt.coinbase")
    def test_raw_to_normalized_rejects_pending_status(self, mock_ccxt, mock_creds):
        """Test that deposits with non-ok status are rejected."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorCoinbaseDeposits()

        ccxt_deposit = {
            "id": "dep_pending",
            "txid": "0xpending123",
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 1.0,
            "status": "pending",  # Not 'ok'
            "network": "ethereum",
        }

        with pytest.raises(ValueError, match="Deposit status is not 'ok': pending"):
            connector.raw_to_normalized(ccxt_deposit)

    @patch("backend.connectors.cex.connector_coinbase_deposits.load_credentials")
    @patch("ccxt.coinbase")
    def test_raw_to_normalized_missing_id_raises(self, mock_ccxt, mock_creds):
        """Test that missing id field raises ValueError."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorCoinbaseDeposits()

        ccxt_deposit = {
            "txid": "0xabc123",
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 1.0,
            "status": "ok",
        }

        with pytest.raises(ValueError, match="Missing 'id' field"):
            connector.raw_to_normalized(ccxt_deposit)

    @patch("backend.connectors.cex.connector_coinbase_deposits.load_credentials")
    @patch("ccxt.coinbase")
    def test_raw_to_normalized_missing_currency_raises(self, mock_ccxt, mock_creds):
        """Test that missing currency field raises ValueError."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorCoinbaseDeposits()

        ccxt_deposit = {
            "id": "dep123",
            "txid": "0xabc123",
            "timestamp": 1640995200000,
            "amount": 1.0,
            "status": "ok",
        }

        with pytest.raises(ValueError, match="Missing 'currency' field"):
            connector.raw_to_normalized(ccxt_deposit)

    @patch("backend.connectors.cex.connector_coinbase_deposits.load_credentials")
    @patch("ccxt.coinbase")
    def test_raw_to_normalized_fee_as_float(self, mock_ccxt, mock_creds):
        """Test normalizing a deposit with fee as float instead of dict."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorCoinbaseDeposits()

        ccxt_deposit = {
            "id": "dep_float_fee",
            "txid": "0xfloatfee123",
            "timestamp": 1640995200000,
            "currency": "USDC",
            "amount": 100.0,
            "addressTo": "0xdest",
            "addressFrom": "0xsrc",
            "status": "ok",
            "fee": 0.5,  # Fee as float
            "network": "ethereum",
        }

        result = connector.raw_to_normalized(ccxt_deposit)

        assert result.fee == 0.5
        assert result.source_fee_quote_asset_symbol == ""  # Float fee does not auto-set quote

    @patch("backend.connectors.cex.connector_coinbase_deposits.load_credentials")
    @patch("ccxt.coinbase")
    def test_raw_to_normalized_no_fee(self, mock_ccxt, mock_creds):
        """Test normalizing a deposit with no fee."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorCoinbaseDeposits()

        ccxt_deposit = {
            "id": "dep_no_fee",
            "txid": "0xnofee123",
            "timestamp": 1640995200000,
            "currency": "SOL",
            "amount": 10.0,
            "addressTo": "addr1",
            "addressFrom": "addr2",
            "status": "ok",
            "network": "solana",
        }

        result = connector.raw_to_normalized(ccxt_deposit)

        assert result.fee == 0
        assert result.source_asset_symbol == "SOL"


class TestCoinbaseWithdrawalsConnector:
    """Unit tests for Coinbase withdrawals connector raw_to_normalized method."""

    @patch("backend.connectors.cex.connector_coinbase_withdrawals.load_credentials")
    @patch("ccxt.coinbase")
    def test_connector_name(self, mock_ccxt, mock_creds):
        """Test connector_name property returns correct value."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorCoinbaseWithdrawals(account_id=1)
        assert connector.connector_name == "coinbase_withdrawals"

    @patch("backend.connectors.cex.connector_coinbase_withdrawals.load_credentials")
    @patch("ccxt.coinbase")
    def test_initialization_with_credentials(self, mock_ccxt, mock_creds):
        """Test connector initialization loads credentials from settings.yaml."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorCoinbaseWithdrawals(account_id=1)
        
        assert connector.api_key == "test_key"
        assert connector.api_secret == "test_secret"
        mock_creds.assert_called_once_with("coinbase")

    @patch("backend.connectors.cex.connector_coinbase_withdrawals.load_credentials")
    @patch("ccxt.coinbase")
    def test_raw_to_normalized_eth_withdrawal(self, mock_ccxt, mock_creds):
        """Test normalizing an ETH withdrawal from CCXT format."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorCoinbaseWithdrawals(account_id=1)

        # Mock CCXT withdrawal response
        ccxt_withdrawal = {
            "id": "with12345",
            "txid": "0xdef456abc789",
            "timestamp": 1640995200000,
            "datetime": "2022-01-01T00:00:00.000Z",
            "currency": "ETH",
            "amount": 2.0,
            "address": "0xrecipient",
            "addressTo": "0xrecipient",
            "addressFrom": "0xmyaddress",
            "tag": None,
            "status": "ok",
            "fee": {"currency": "ETH", "cost": 0.002},
            "network": "ethereum",
            "info": {},
        }

        result = connector.raw_to_normalized(ccxt_withdrawal)

        # Assert it returns NormalizedTransaction
        assert isinstance(result, NormalizedTransaction)

        # Assert normalized structure for withdrawals
        assert result.source == "coinbase-withdrawals"
        assert result.account_id == 1
        assert result.source_account == "coinbase_withdrawals"
        assert result.source_transaction_id == "with12345"
        assert result.direction == "outflow"
        assert result.source_transaction_type == "withdrawal"
        assert result.transaction_type == "transfer"
        assert result.source_asset_symbol == "ETH"
        assert result.quantity == 2.0
        assert result.fee == 0.002
        assert result.source_fee_quote_asset_symbol == "ETH"
        assert result.network_transaction_id == "0xdef456abc789"
        assert result.network == "ethereum"
        assert result.source_to_account == "0xrecipient"
        assert result.source_from_account == "1"  # Falls back to str(account_id) when no config
        assert result.date_time == datetime(2022, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

    @patch("backend.connectors.cex.connector_coinbase_withdrawals.load_credentials")
    @patch("ccxt.coinbase")
    def test_raw_to_normalized_btc_withdrawal(self, mock_ccxt, mock_creds):
        """Test normalizing a BTC withdrawal with fee as dictionary."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorCoinbaseWithdrawals()

        ccxt_withdrawal = {
            "id": "with67890",
            "txid": "0xabc012def345",
            "timestamp": 1640995300000,
            "datetime": "2022-01-01T00:01:40.000Z",
            "currency": "BTC",
            "amount": 0.1,
            "address": "bc1qrecipient",
            "addressTo": "bc1qrecipient",
            "addressFrom": "bc1qmy",
            "status": "ok",
            "fee": {"currency": "BTC", "cost": 0.0002},
            "network": "bitcoin",
            "info": {},
        }

        result = connector.raw_to_normalized(ccxt_withdrawal)

        assert result.source_transaction_type == "withdrawal"
        assert result.direction == "outflow"
        assert result.quantity == 0.1
        assert result.fee == 0.0002
        assert result.source_fee_quote_asset_symbol == "BTC"
        assert result.network == "bitcoin"

    @patch("backend.connectors.cex.connector_coinbase_withdrawals.load_credentials")
    @patch("ccxt.coinbase")
    def test_raw_to_normalized_rejects_failed_status(self, mock_ccxt, mock_creds):
        """Test that withdrawals with non-ok status are rejected."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorCoinbaseWithdrawals()

        ccxt_withdrawal = {
            "id": "with_failed",
            "txid": "0xfailed123",
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 1.0,
            "status": "failed",  # Not 'ok'
            "network": "ethereum",
        }

        assert connector.raw_to_normalized(ccxt_withdrawal) is None

    @patch("backend.connectors.cex.connector_coinbase_withdrawals.load_credentials")
    @patch("ccxt.coinbase")
    def test_raw_to_normalized_missing_id_raises(self, mock_ccxt, mock_creds):
        """Test that missing id field raises ValueError."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorCoinbaseWithdrawals()

        ccxt_withdrawal = {
            "txid": "0xabc123",
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 1.0,
            "status": "ok",
        }

        with pytest.raises(ValueError, match="Missing 'id' field"):
            connector.raw_to_normalized(ccxt_withdrawal)

    @patch("backend.connectors.cex.connector_coinbase_withdrawals.load_credentials")
    @patch("ccxt.coinbase")
    def test_raw_to_normalized_missing_currency_raises(self, mock_ccxt, mock_creds):
        """Test that missing currency field raises ValueError."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorCoinbaseWithdrawals()

        ccxt_withdrawal = {
            "id": "with123",
            "txid": "0xabc123",
            "timestamp": 1640995200000,
            "amount": 1.0,
            "status": "ok",
        }

        with pytest.raises(ValueError, match="Missing 'currency' field"):
            connector.raw_to_normalized(ccxt_withdrawal)

    @patch("backend.connectors.cex.connector_coinbase_withdrawals.load_credentials")
    @patch("ccxt.coinbase")
    def test_raw_to_normalized_fee_as_float(self, mock_ccxt, mock_creds):
        """Test normalizing a withdrawal with fee as float instead of dict."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorCoinbaseWithdrawals()

        ccxt_withdrawal = {
            "id": "with_float_fee",
            "txid": "0xfloatfee456",
            "timestamp": 1640995200000,
            "currency": "USDC",
            "amount": 200.0,
            "addressTo": "0xrecipient",
            "addressFrom": "0xmy",
            "status": "ok",
            "fee": 1.0,  # Fee as float
            "network": "ethereum",
        }

        result = connector.raw_to_normalized(ccxt_withdrawal)

        assert result.fee == 1.0
        assert result.source_fee_quote_asset_symbol == "USDC"  # Defaults to currency

    @patch("backend.connectors.cex.connector_coinbase_withdrawals.load_credentials")
    @patch("ccxt.coinbase")
    def test_raw_to_normalized_no_fee(self, mock_ccxt, mock_creds):
        """Test normalizing a withdrawal with no fee."""
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        mock_exchange = MagicMock()
        mock_ccxt.return_value = mock_exchange

        connector = ConnectorCoinbaseWithdrawals()

        ccxt_withdrawal = {
            "id": "with_no_fee",
            "txid": "0xnofee456",
            "timestamp": 1640995200000,
            "currency": "SOL",
            "amount": 5.0,
            "addressTo": "recip1",
            "addressFrom": "my1",
            "status": "ok",
            "network": "solana",
        }

        result = connector.raw_to_normalized(ccxt_withdrawal)

        assert result.fee == 0
        assert result.source_asset_symbol == "SOL"
        assert result.direction == "outflow"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
