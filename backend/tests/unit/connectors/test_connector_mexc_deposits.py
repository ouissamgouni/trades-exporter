"""
Unit tests for MEXC Deposits connector
"""

import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone

from backend.connectors.cex.connector_mexc_deposits import MEXCDepositsConnector
from backend.db.models import NormalizedTransaction


@pytest.fixture
def mock_mexc_credentials():
    """Mock credentials loading for MEXC."""
    with patch("backend.connectors.cex.connector_mexc_base.load_credentials") as mock_creds:
        mock_creds.return_value = {"api_key": "test_key", "api_secret": "test_secret"}
        yield mock_creds


@pytest.fixture
def mock_ccxt_mexc():
    """Mock CCXT MEXC exchange."""
    with patch("backend.connectors.cex.connector_mexc_base.ccxt.mexc") as mock_exchange:
        mock_instance = MagicMock()
        mock_instance.load_markets = MagicMock()
        mock_exchange.return_value = mock_instance
        yield mock_instance


class TestMEXCDepositsConnector:
    """Test suite for MEXC deposits connector."""

    def test_connector_name(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test that connector_name property returns correct identifier."""
        connector = MEXCDepositsConnector(account_id=1)
        assert connector.connector_name == "mexc_deposits"

    def test_initialization_with_credentials(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test connector initialization loads credentials correctly."""
        connector = MEXCDepositsConnector(account_id=1)
        
        assert connector.api_key == "test_key"
        assert connector.api_secret == "test_secret"
        mock_mexc_credentials.assert_called_once_with("mexc")

    def test_initialization_with_provided_credentials(self, mock_ccxt_mexc):
        """Test connector initialization with directly provided credentials."""
        connector = MEXCDepositsConnector(
            api_key="custom_key",
            api_secret="custom_secret",
            account_id=1
        )
        
        assert connector.api_key == "custom_key"
        assert connector.api_secret == "custom_secret"

    def test_raw_to_normalized_successful_deposit(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test successful deposit normalization."""
        connector = MEXCDepositsConnector(account_id=1)
        
        ccxt_deposit = {
            "id": "deposit123",
            "txid": "0xabc123def456",
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 1.5,
            "status": "ok",
            "addressTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
            "addressFrom": "0x123abc456def789",
            "network": "erc20",
            "fee": {
                "cost": 0.001,
                "currency": "ETH"
            }
        }
        
        result = connector.raw_to_normalized(ccxt_deposit)
        
        assert isinstance(result, NormalizedTransaction)
        assert result.source == "mexc-deposits"
        assert result.source_account == "mexc_deposits"
        assert result.source_transaction_id == "deposit123"
        assert result.direction == "inflow"
        assert result.transaction_type == "transfer"
        assert result.source_transaction_type == "deposit"
        assert result.source_asset_symbol == "ETH"
        assert result.quantity == 1.5
        assert result.fee == 0.001
        assert result.source_fee_quote_asset_symbol == "ETH"
        assert result.network_transaction_id == "0xabc123def456"
        assert result.network == "erc20"

    def test_raw_to_normalized_with_non_ok_status(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test that non-ok status deposits raise ValueError."""
        connector = MEXCDepositsConnector(account_id=1)
        
        ccxt_deposit = {
            "id": "deposit123",
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 1.5,
            "status": "pending",
            "addressTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
        }
        
        with pytest.raises(ValueError, match="Deposit status is not 'ok'"):
            connector.raw_to_normalized(ccxt_deposit)

    def test_raw_to_normalized_missing_id(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test that missing id field raises ValueError."""
        connector = MEXCDepositsConnector(account_id=1)
        
        ccxt_deposit = {
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 1.5,
            "status": "ok",
            "addressTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
        }
        
        with pytest.raises(ValueError, match="Missing 'id' field"):
            connector.raw_to_normalized(ccxt_deposit)

    def test_raw_to_normalized_missing_currency(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test that missing currency field raises ValueError."""
        connector = MEXCDepositsConnector(account_id=1)
        
        ccxt_deposit = {
            "id": "deposit123",
            "timestamp": 1640995200000,
            "amount": 1.5,
            "status": "ok",
            "addressTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
        }
        
        with pytest.raises(ValueError, match="Missing 'currency' field"):
            connector.raw_to_normalized(ccxt_deposit)

    def test_raw_to_normalized_invalid_amount(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test that None amount raises ValueError."""
        connector = MEXCDepositsConnector(account_id=1)
        
        ccxt_deposit = {
            "id": "deposit123",
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": None,
            "status": "ok",
            "addressTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
        }
        
        with pytest.raises(ValueError, match="Missing or invalid 'amount' field"):
            connector.raw_to_normalized(ccxt_deposit)

    def test_raw_to_normalized_with_float_fee(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test deposit with fee as float instead of dict."""
        connector = MEXCDepositsConnector(account_id=1)
        
        ccxt_deposit = {
            "id": "deposit123",
            "timestamp": 1640995200000,
            "currency": "BTC",
            "amount": 0.5,
            "status": "ok",
            "addressTo": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
            "fee": 0.0005
        }
        
        result = connector.raw_to_normalized(ccxt_deposit)
        
        assert result.fee == 0.0005
        assert result.source_fee_quote_asset_symbol == "BTC"

    def test_raw_to_normalized_with_zero_fee(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test deposit with zero fee."""
        connector = MEXCDepositsConnector(account_id=1)
        
        ccxt_deposit = {
            "id": "deposit123",
            "timestamp": 1640995200000,
            "currency": "USDT",
            "amount": 1000.0,
            "status": "ok",
            "addressTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
            "fee": 0
        }
        
        result = connector.raw_to_normalized(ccxt_deposit)
        
        assert result.fee == 0
        assert result.source_fee_quote_asset_symbol == "USDT"

    def test_get_deposits_success(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test successful deposit fetching with 7-day windowing."""
        connector = MEXCDepositsConnector(account_id=1)
        
        # Mock returns same data for each 7-day window
        mock_deposits = [
            {"id": "d1", "currency": "BTC", "amount": 1.0, "status": "ok"},
            {"id": "d2", "currency": "BTC", "amount": 0.5, "status": "ok"},
        ]
        mock_ccxt_mexc.fetch_deposits.return_value = mock_deposits
        
        result = connector.get_deposits("BTC")
        
        # Should have called fetch_deposits multiple times (for 7-day windows over 90 days)
        assert mock_ccxt_mexc.fetch_deposits.call_count > 1
        # Result should contain deposits from all windows
        assert len(result) >= 2
        assert result[0]["id"] == "d1"
        # Verify that since parameter was used (90 days ago by default)
        first_call_args = mock_ccxt_mexc.fetch_deposits.call_args_list[0]
        assert first_call_args[1]["code"] == "BTC"
        assert first_call_args[1]["since"] is not None

    def test_get_deposits_with_custom_since(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test deposit fetching with custom since parameter."""
        connector = MEXCDepositsConnector(account_id=1)
        
        mock_deposits = [{"id": "d1", "currency": "BTC", "amount": 1.0, "status": "ok"}]
        mock_ccxt_mexc.fetch_deposits.return_value = mock_deposits
        
        # Use a recent timestamp (within 7 days) to avoid multiple windows
        from datetime import datetime, timezone, timedelta
        now = datetime.now(timezone.utc)
        custom_since = int((now - timedelta(days=3)).timestamp() * 1000)
        
        result = connector.get_deposits("BTC", since=custom_since)
        
        assert len(result) >= 1
        # Should have been called at least once
        assert mock_ccxt_mexc.fetch_deposits.call_count >= 1
        first_call_args = mock_ccxt_mexc.fetch_deposits.call_args_list[0]
        assert first_call_args[1]["code"] == "BTC"
        assert first_call_args[1]["since"] == custom_since

    def test_get_deposits_error_703(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test that error 703 is handled gracefully."""
        connector = MEXCDepositsConnector(account_id=1)
        
        mock_ccxt_mexc.fetch_deposits.side_effect = Exception("Error 703: Permission denied")
        
        result = connector.get_deposits("BTC")
        
        assert result == []

    def test_get_deposits_empty_result(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test handling of empty deposit list."""
        connector = MEXCDepositsConnector(account_id=1)
        
        mock_ccxt_mexc.fetch_deposits.side_effect = Exception("No deposits found")
        
        result = connector.get_deposits("BTC")
        
        assert result == []

    def test_get_raws(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test get_raws method with 7-day windowing."""
        connector = MEXCDepositsConnector(account_id=1)
        
        # Mock currencies
        mock_ccxt_mexc.currencies = {"BTC": {}, "ETH": {}}
        
        mock_deposits_btc = [
            {"id": "d1", "currency": "BTC", "amount": 1.0, "status": "ok"},
        ]
        mock_deposits_eth = []
        
        def fetch_side_effect(code, since, limit, params=None):
            if code == "BTC":
                return mock_deposits_btc
            return mock_deposits_eth
        
        mock_ccxt_mexc.fetch_deposits.side_effect = fetch_side_effect
        
        result = connector.get_raws()
        
        # Should have results from BTC (multiple windows over 90 days)
        assert len(result) >= 1
        assert result[0]["id"] == "d1"
        # Verify BTC was queried multiple times (7-day windows)
        assert mock_ccxt_mexc.fetch_deposits.call_count > 2

    def test_raw_to_normalized_lowercase_network(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test that network is normalized to lowercase."""
        connector = MEXCDepositsConnector(account_id=1)
        
        ccxt_deposit = {
            "id": "deposit123",
            "timestamp": 1640995200000,
            "currency": "USDT",
            "amount": 100.0,
            "status": "ok",
            "addressTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
            "network": "ERC20"
        }
        
        result = connector.raw_to_normalized(ccxt_deposit)
        
        assert result.network == "erc20"
