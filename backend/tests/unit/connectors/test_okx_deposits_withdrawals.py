"""
Unit tests for OKX Deposits and Withdrawals connectors
"""

import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone

from backend.connectors.cex.connector_okx_deposits import OKXDepositsConnector
from backend.connectors.cex.connector_okx_withdrawals import OKXWithdrawalsConnector
from backend.db.models import NormalizedTransaction


@pytest.fixture
def mock_okx_credentials():
    """Mock credentials loading for OKX."""
    with patch("backend.connectors.cex.connector_okx_base.load_credentials") as mock_creds:
        mock_creds.return_value = {
            "api_key": "test_key",
            "api_secret": "test_secret",
            "api_passphrase": "test_passphrase"
        }
        yield mock_creds


@pytest.fixture
def mock_ccxt_okx():
    """Mock CCXT OKX exchange."""
    with patch("backend.connectors.cex.connector_okx_base.ccxt.myokx") as mock_exchange:
        mock_instance = MagicMock()
        mock_instance.load_markets = MagicMock()
        mock_exchange.return_value = mock_instance
        yield mock_instance


class TestOKXDepositsConnector:
    """Test suite for OKX deposits connector."""

    def test_connector_name(self, mock_ccxt_okx, mock_okx_credentials):
        """Test that connector_name property returns correct identifier."""
        connector = OKXDepositsConnector(account_id=1)
        assert connector.connector_name == "okx_deposits"

    def test_initialization_with_credentials(self, mock_ccxt_okx, mock_okx_credentials):
        """Test connector initialization loads credentials correctly."""
        connector = OKXDepositsConnector(account_id=1)
        
        assert connector.api_key == "test_key"
        assert connector.api_secret == "test_secret"
        assert connector.api_passphrase == "test_passphrase"
        mock_okx_credentials.assert_called_once_with("okx")

    def test_initialization_with_provided_credentials(self, mock_ccxt_okx):
        """Test connector initialization with directly provided credentials."""
        connector = OKXDepositsConnector(
            api_key="custom_key",
            api_secret="custom_secret",
            api_passphrase="custom_passphrase",
            account_id=1
        )
        
        assert connector.api_key == "custom_key"
        assert connector.api_secret == "custom_secret"
        assert connector.api_passphrase == "custom_passphrase"

    def test_raw_to_normalized_successful_deposit(self, mock_ccxt_okx, mock_okx_credentials):
        """Test successful deposit normalization."""
        connector = OKXDepositsConnector(account_id=1)
        
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
        assert result.source == "okx-deposits"
        assert result.source_account == "okx_deposits"
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

    def test_raw_to_normalized_with_non_ok_status(self, mock_ccxt_okx, mock_okx_credentials):
        """Test that non-ok status deposits raise ValueError."""
        connector = OKXDepositsConnector(account_id=1)
        
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

    def test_raw_to_normalized_missing_id(self, mock_ccxt_okx, mock_okx_credentials):
        """Test that missing id field raises ValueError."""
        connector = OKXDepositsConnector(account_id=1)
        
        ccxt_deposit = {
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 1.5,
            "status": "ok",
            "addressTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
        }
        
        with pytest.raises(ValueError, match="Missing 'id' field"):
            connector.raw_to_normalized(ccxt_deposit)

    def test_raw_to_normalized_missing_currency(self, mock_ccxt_okx, mock_okx_credentials):
        """Test that missing currency field raises ValueError."""
        connector = OKXDepositsConnector(account_id=1)
        
        ccxt_deposit = {
            "id": "deposit123",
            "timestamp": 1640995200000,
            "amount": 1.5,
            "status": "ok",
            "addressTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
        }
        
        with pytest.raises(ValueError, match="Missing 'currency' field"):
            connector.raw_to_normalized(ccxt_deposit)

    def test_raw_to_normalized_invalid_amount(self, mock_ccxt_okx, mock_okx_credentials):
        """Test that None amount raises ValueError."""
        connector = OKXDepositsConnector(account_id=1)
        
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

    def test_raw_to_normalized_with_fee_as_float(self, mock_ccxt_okx, mock_okx_credentials):
        """Test deposit normalization when fee is a float instead of dict."""
        connector = OKXDepositsConnector(account_id=1)
        
        ccxt_deposit = {
            "id": "deposit123",
            "txid": "0xabc123def456",
            "timestamp": 1640995200000,
            "currency": "BTC",
            "amount": 0.5,
            "status": "ok",
            "addressTo": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
            "fee": 0.0001,
            "network": "bitcoin"
        }
        
        result = connector.raw_to_normalized(ccxt_deposit)
        
        assert result.fee == 0.0001
        assert result.source_fee_quote_asset_symbol == "BTC"


class TestOKXWithdrawalsConnector:
    """Test suite for OKX withdrawals connector."""

    def test_connector_name(self, mock_ccxt_okx, mock_okx_credentials):
        """Test that connector_name property returns correct identifier."""
        connector = OKXWithdrawalsConnector(account_id=1)
        assert connector.connector_name == "okx_withdrawals"

    def test_initialization_with_credentials(self, mock_ccxt_okx, mock_okx_credentials):
        """Test connector initialization loads credentials correctly."""
        connector = OKXWithdrawalsConnector(account_id=1)
        
        assert connector.api_key == "test_key"
        assert connector.api_secret == "test_secret"
        assert connector.api_passphrase == "test_passphrase"
        mock_okx_credentials.assert_called_once_with("okx")

    def test_initialization_with_provided_credentials(self, mock_ccxt_okx):
        """Test connector initialization with directly provided credentials."""
        connector = OKXWithdrawalsConnector(
            api_key="custom_key",
            api_secret="custom_secret",
            api_passphrase="custom_passphrase",
            account_id=1
        )
        
        assert connector.api_key == "custom_key"
        assert connector.api_secret == "custom_secret"
        assert connector.api_passphrase == "custom_passphrase"

    def test_raw_to_normalized_successful_withdrawal(self, mock_ccxt_okx, mock_okx_credentials):
        """Test successful withdrawal normalization."""
        connector = OKXWithdrawalsConnector(account_id=1)
        
        ccxt_withdrawal = {
            "id": "withdrawal123",
            "txid": "0xabc123def456",
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 1.5,
            "status": "ok",
            "addressTo": "0x123abc456def789",
            "addressFrom": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
            "network": "erc20",
            "fee": {
                "cost": 0.001,
                "currency": "ETH"
            }
        }
        
        result = connector.raw_to_normalized(ccxt_withdrawal)
        
        assert isinstance(result, NormalizedTransaction)
        assert result.source == "okx-withdrawals"
        assert result.source_account == "okx_withdrawals"
        assert result.source_transaction_id == "withdrawal123"
        assert result.direction == "outflow"
        assert result.transaction_type == "transfer"
        assert result.source_transaction_type == "withdrawal"
        assert result.source_asset_symbol == "ETH"
        assert result.quantity == 1.5
        assert result.fee == 0.001
        assert result.source_fee_quote_asset_symbol == "ETH"
        assert result.network_transaction_id == "0xabc123def456"
        assert result.network == "erc20"

    def test_raw_to_normalized_with_non_ok_status(self, mock_ccxt_okx, mock_okx_credentials):
        """Test that non-ok status withdrawals raise ValueError."""
        connector = OKXWithdrawalsConnector(account_id=1)
        
        ccxt_withdrawal = {
            "id": "withdrawal123",
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 1.5,
            "status": "pending",
            "addressTo": "0x123abc456def789",
        }
        
        with pytest.raises(ValueError, match="Withdrawal status is not 'ok'"):
            connector.raw_to_normalized(ccxt_withdrawal)

    def test_raw_to_normalized_missing_id(self, mock_ccxt_okx, mock_okx_credentials):
        """Test that missing id field raises ValueError."""
        connector = OKXWithdrawalsConnector(account_id=1)
        
        ccxt_withdrawal = {
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 1.5,
            "status": "ok",
            "addressTo": "0x123abc456def789",
        }
        
        with pytest.raises(ValueError, match="Missing 'id' field"):
            connector.raw_to_normalized(ccxt_withdrawal)

    def test_raw_to_normalized_missing_currency(self, mock_ccxt_okx, mock_okx_credentials):
        """Test that missing currency field raises ValueError."""
        connector = OKXWithdrawalsConnector(account_id=1)
        
        ccxt_withdrawal = {
            "id": "withdrawal123",
            "timestamp": 1640995200000,
            "amount": 1.5,
            "status": "ok",
            "addressTo": "0x123abc456def789",
        }
        
        with pytest.raises(ValueError, match="Missing currency field"):
            connector.raw_to_normalized(ccxt_withdrawal)

    def test_raw_to_normalized_missing_address(self, mock_ccxt_okx, mock_okx_credentials):
        """Test that missing addressTo field raises ValueError."""
        connector = OKXWithdrawalsConnector(account_id=1)
        
        ccxt_withdrawal = {
            "id": "withdrawal123",
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 1.5,
            "status": "ok",
        }
        
        with pytest.raises(ValueError, match="Missing destination address"):
            connector.raw_to_normalized(ccxt_withdrawal)

    def test_raw_to_normalized_invalid_amount(self, mock_ccxt_okx, mock_okx_credentials):
        """Test that zero or negative amount raises ValueError."""
        connector = OKXWithdrawalsConnector(account_id=1)
        
        ccxt_withdrawal = {
            "id": "withdrawal123",
            "timestamp": 1640995200000,
            "currency": "ETH",
            "amount": 0,
            "status": "ok",
            "addressTo": "0x123abc456def789",
        }
        
        with pytest.raises(ValueError, match="Invalid amount"):
            connector.raw_to_normalized(ccxt_withdrawal)

    def test_raw_to_normalized_with_fee_as_float(self, mock_ccxt_okx, mock_okx_credentials):
        """Test withdrawal normalization when fee is a float instead of dict."""
        connector = OKXWithdrawalsConnector(account_id=1)
        
        ccxt_withdrawal = {
            "id": "withdrawal123",
            "txid": "0xabc123def456",
            "timestamp": 1640995200000,
            "currency": "BTC",
            "amount": 0.5,
            "status": "ok",
            "addressTo": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
            "fee": 0.0001,
            "network": "bitcoin"
        }
        
        result = connector.raw_to_normalized(ccxt_withdrawal)
        
        assert result.fee == 0.0001
        assert result.source_fee_quote_asset_symbol == "BTC"

    def test_raw_to_normalized_currency_from_info(self, mock_ccxt_okx, mock_okx_credentials):
        """Test withdrawal normalization when currency is in info.ccy field."""
        connector = OKXWithdrawalsConnector(account_id=1)
        
        ccxt_withdrawal = {
            "id": "withdrawal123",
            "timestamp": 1640995200000,
            "amount": 100,
            "status": "ok",
            "addressTo": "0x123abc456def789",
            "info": {
                "ccy": "USDT"
            }
        }
        
        result = connector.raw_to_normalized(ccxt_withdrawal)
        
        assert result.source_asset_symbol == "USDT"


class TestConnectorRegistry:
    """Test OKX connectors are properly registered in the connector registry."""

    def test_okx_deposits_registered(self):
        """Test that okx-deposits is registered in connector registry."""
        from backend.connectors.connector_registry import get_connector_registry
        
        registry = get_connector_registry()
        info = registry.get("okx-deposits")
        
        assert info is not None
        assert info.type == "okx-deposits"
        assert info.category == "cex"
        assert info.display_name == "OKX Deposits"
        assert info.supports_incremental_sync is True
        assert "currencies" in info.optional_config
        assert "start_date" in info.optional_config

    def test_okx_withdrawals_registered(self):
        """Test that okx-withdrawals is registered in connector registry."""
        from backend.connectors.connector_registry import get_connector_registry
        
        registry = get_connector_registry()
        info = registry.get("okx-withdrawals")
        
        assert info is not None
        assert info.type == "okx-withdrawals"
        assert info.category == "cex"
        assert info.display_name == "OKX Withdrawals"
        assert info.supports_incremental_sync is True
        assert "currencies" in info.optional_config
        assert "start_date" in info.optional_config

    def test_okx_deposits_class_mapping(self):
        """Test that okx-deposits maps to OKXDepositsConnector class."""
        from backend.connectors.connector_registry import get_connector_registry
        from backend.connectors.cex.connector_okx_deposits import OKXDepositsConnector
        
        registry = get_connector_registry()
        connector_class = registry.get_class("okx-deposits")
        
        assert connector_class is not None
        assert connector_class == OKXDepositsConnector

    def test_okx_withdrawals_class_mapping(self):
        """Test that okx-withdrawals maps to OKXWithdrawalsConnector class."""
        from backend.connectors.connector_registry import get_connector_registry
        from backend.connectors.cex.connector_okx_withdrawals import OKXWithdrawalsConnector
        
        registry = get_connector_registry()
        connector_class = registry.get_class("okx-withdrawals")
        
        assert connector_class is not None
        assert connector_class == OKXWithdrawalsConnector
