"""
Unit tests for MEXC Withdrawals connector
"""

import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone

from backend.connectors.cex.connector_mexc_withdrawals import MEXCWithdrawalsConnector
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


class TestMEXCWithdrawalsConnector:
    """Test suite for MEXC withdrawals connector."""

    def test_connector_name(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test that connector_name property returns correct identifier."""
        connector = MEXCWithdrawalsConnector(account_id=1)
        assert connector.connector_name == "mexc_withdrawals"

    def test_initialization_with_credentials(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test connector initialization loads credentials correctly."""
        connector = MEXCWithdrawalsConnector(account_id=1)
        
        assert connector.api_key == "test_key"
        assert connector.api_secret == "test_secret"
        mock_mexc_credentials.assert_called_once_with("mexc")

    def test_initialization_with_provided_credentials(self, mock_ccxt_mexc):
        """Test connector initialization with directly provided credentials."""
        connector = MEXCWithdrawalsConnector(
            api_key="custom_key",
            api_secret="custom_secret",
            account_id=1
        )
        
        assert connector.api_key == "custom_key"
        assert connector.api_secret == "custom_secret"

    def test_raw_to_normalized_successful_withdrawal(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test successful withdrawal normalization."""
        connector = MEXCWithdrawalsConnector(account_id=1)
        
        ccxt_withdrawal = {
            "id": "withdraw123",
            "txid": "0xabc123def456",
            "timestamp": 1640995200000,
            "currency": "USDT",
            "amount": 500.0,
            "status": "ok",
            "addressTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
            "addressFrom": "mexc_exchange",
            "network": "TRC20",
            "fee": {
                "cost": 1.0,
                "currency": "USDT"
            }
        }
        
        result = connector.raw_to_normalized(ccxt_withdrawal)
        
        assert isinstance(result, NormalizedTransaction)
        assert result.source == "mexc-withdrawals"
        assert result.source_account == "mexc_withdrawals"
        assert result.source_transaction_id == "withdraw123"
        assert result.direction == "outflow"
        assert result.transaction_type == "transfer"
        assert result.source_transaction_type == "withdrawal"
        assert result.source_asset_symbol == "USDT"
        assert result.quantity == 500.0
        assert result.fee == 1.0
        assert result.source_fee_quote_asset_symbol == "USDT"
        assert result.network_transaction_id == "0xabc123def456"
        assert result.network == "tron"

    def test_raw_to_normalized_with_non_ok_status(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test that non-ok status withdrawals raise ValueError."""
        connector = MEXCWithdrawalsConnector(account_id=1)
        
        ccxt_withdrawal = {
            "id": "withdraw123",
            "timestamp": 1640995200000,
            "currency": "USDT",
            "amount": 500.0,
            "status": "pending",
            "addressTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
        }
        
        with pytest.raises(ValueError, match="Withdrawal status is not 'ok'"):
            connector.raw_to_normalized(ccxt_withdrawal)

    def test_raw_to_normalized_missing_id(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test that missing id field raises ValueError."""
        connector = MEXCWithdrawalsConnector(account_id=1)
        
        ccxt_withdrawal = {
            "timestamp": 1640995200000,
            "currency": "USDT",
            "amount": 500.0,
            "status": "ok",
            "addressTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
        }
        
        with pytest.raises(ValueError, match="Missing 'id' field"):
            connector.raw_to_normalized(ccxt_withdrawal)

    def test_raw_to_normalized_missing_currency(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test that missing currency field raises ValueError."""
        connector = MEXCWithdrawalsConnector(account_id=1)
        
        ccxt_withdrawal = {
            "id": "withdraw123",
            "timestamp": 1640995200000,
            "amount": 500.0,
            "status": "ok",
            "addressTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
        }
        
        with pytest.raises(ValueError, match="Missing currency field"):
            connector.raw_to_normalized(ccxt_withdrawal)

    def test_raw_to_normalized_currency_from_info(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test currency extraction from info field as fallback."""
        connector = MEXCWithdrawalsConnector(account_id=1)
        
        ccxt_withdrawal = {
            "id": "withdraw123",
            "timestamp": 1640995200000,
            "amount": 500.0,
            "status": "ok",
            "addressTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
            "info": {
                "coin": "BTC"
            }
        }
        
        result = connector.raw_to_normalized(ccxt_withdrawal)
        assert result.source_asset_symbol == "BTC"

    def test_raw_to_normalized_invalid_amount(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test that invalid amount raises ValueError."""
        connector = MEXCWithdrawalsConnector(account_id=1)
        
        ccxt_withdrawal = {
            "id": "withdraw123",
            "timestamp": 1640995200000,
            "currency": "USDT",
            "amount": 0,
            "status": "ok",
            "addressTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
        }
        
        with pytest.raises(ValueError, match="Invalid amount"):
            connector.raw_to_normalized(ccxt_withdrawal)

    def test_raw_to_normalized_missing_address(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test that missing destination address raises ValueError."""
        connector = MEXCWithdrawalsConnector(account_id=1)
        
        ccxt_withdrawal = {
            "id": "withdraw123",
            "timestamp": 1640995200000,
            "currency": "USDT",
            "amount": 500.0,
            "status": "ok",
        }
        
        with pytest.raises(ValueError, match="Missing destination address"):
            connector.raw_to_normalized(ccxt_withdrawal)

    def test_raw_to_normalized_with_float_fee(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test withdrawal with fee as float instead of dict."""
        connector = MEXCWithdrawalsConnector(account_id=1)
        
        ccxt_withdrawal = {
            "id": "withdraw123",
            "timestamp": 1640995200000,
            "currency": "BTC",
            "amount": 0.5,
            "status": "ok",
            "addressTo": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
            "fee": 0.0005
        }
        
        result = connector.raw_to_normalized(ccxt_withdrawal)
        
        assert result.fee == 0.0005
        assert result.source_fee_quote_asset_symbol == "BTC"

    def test_raw_to_normalized_with_dict_amount(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test withdrawal with amount as dict."""
        connector = MEXCWithdrawalsConnector(account_id=1)
        
        ccxt_withdrawal = {
            "id": "withdraw123",
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": {"amount": 2.5},
            "status": "ok",
            "addressTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
        }
        
        result = connector.raw_to_normalized(ccxt_withdrawal)
        assert result.quantity == 2.5

    def test_get_withdrawals_success(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test successful withdrawal fetching with 7-day windowing."""
        connector = MEXCWithdrawalsConnector(account_id=1)
        
        # Mock returns same data for each 7-day window
        mock_withdrawals = [
            {"id": "w1", "currency": "BTC", "amount": 1.0, "status": "ok"},
            {"id": "w2", "currency": "BTC", "amount": 0.5, "status": "ok"},
        ]
        mock_ccxt_mexc.fetch_withdrawals.return_value = mock_withdrawals
        
        result = connector.get_withdrawals("BTC")
        
        # Should have called fetch_withdrawals multiple times (for 7-day windows over 90 days)
        assert mock_ccxt_mexc.fetch_withdrawals.call_count > 1
        # Result should contain withdrawals from all windows
        assert len(result) >= 2
        assert result[0]["id"] == "w1"

    def test_get_withdrawals_error_703(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test that error 703 is handled gracefully."""
        connector = MEXCWithdrawalsConnector(account_id=1)
        
        mock_ccxt_mexc.fetch_withdrawals.side_effect = Exception("Error 703: Permission denied")
        
        result = connector.get_withdrawals("BTC")
        
        assert result == []

    def test_get_withdrawals_empty_result(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Test handling of empty withdrawal list."""
        connector = MEXCWithdrawalsConnector(account_id=1)
        
        mock_ccxt_mexc.fetch_withdrawals.side_effect = Exception("No withdrawals found")
        
        result = connector.get_withdrawals("BTC")
        
        assert result == []

    def test_yield_raws(self, mock_ccxt_mexc, mock_mexc_credentials):
        """Per-currency 7-day windowing (used when a currencies filter is configured)."""
        connector = MEXCWithdrawalsConnector(account_id=1, currencies=["BTC", "ETH"])
        
        # Mock currencies - need to mock as dict-like with items() method and active flag
        mock_ccxt_mexc.currencies = {
            "BTC": {"active": True},
            "ETH": {"active": True}
        }
        
        # Mock balance fetch - returns empty balance so we use currencies from exchange
        mock_ccxt_mexc.fetch_balance.return_value = {}
        
        mock_withdrawals_btc = [
            {"id": "w1", "currency": "BTC", "amount": 1.0, "status": "ok"},
        ]
        mock_withdrawals_eth = []
        
        def fetch_side_effect(code, since, limit, params=None):
            if code == "BTC":
                return mock_withdrawals_btc
            return mock_withdrawals_eth
        
        mock_ccxt_mexc.fetch_withdrawals.side_effect = fetch_side_effect
        
        result = list(connector.yield_raws())
        
        # Should have results from BTC (multiple windows over 90 days)
        assert len(result) >= 1
        assert result[0]["id"] == "w1"
        # Verify BTC was queried multiple times (7-day windows)
        assert mock_ccxt_mexc.fetch_withdrawals.call_count > 2
