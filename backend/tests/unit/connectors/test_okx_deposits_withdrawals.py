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
            "info": {"chain": "erc20"},
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
        assert result.network == "ethereum"

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
            "network": "bitcoin",
            "info": {"chain": "btc"}
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
            "info": {"chain": "erc20"},
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
        assert result.network == "ethereum"

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
            "network": "bitcoin",
            "info": {"chain": "btc"}
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
        assert "start_datetime" in info.optional_config

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
        assert "start_datetime" in info.optional_config

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


class TestOKXTransferPagination:
    """OKX deposit/withdrawal records carry no billId: paging must use timestamps (prod: only page 1 was read)."""

    def _connector(self, since=None):
        config = {"test_mode": False, "disable_file_output": True}
        if since:
            config["since_datetime"] = since
        return OKXDepositsConnector(account_id=1, config=config)

    @staticmethod
    def _page(start_ts, count, prefix):
        # CCXT returns pages sorted ascending by timestamp
        return [{"id": f"{prefix}{i}", "timestamp": start_ts + i * 1000} for i in range(count)]

    def test_pages_backwards_with_after_timestamp(self, mock_ccxt_okx, mock_okx_credentials):
        newest = self._page(2_000_000, 100, "n")
        older = self._page(1_000_000, 30, "o")
        mock_ccxt_okx.fetch_deposits.side_effect = [newest, older]

        items = list(self._connector().yield_raws())

        assert len(items) == 130
        calls = mock_ccxt_okx.fetch_deposits.call_args_list
        assert calls[0].kwargs["params"] == {}
        assert calls[1].kwargs["params"] == {"after": 2_000_000 + 1}
        assert calls[0].kwargs["limit"] == 100

    def test_stops_on_short_page(self, mock_ccxt_okx, mock_okx_credentials):
        mock_ccxt_okx.fetch_deposits.return_value = self._page(1_000_000, 3, "a")

        assert len(list(self._connector().yield_raws())) == 3
        assert mock_ccxt_okx.fetch_deposits.call_count == 1

    def test_stops_when_page_has_nothing_new(self, mock_ccxt_okx, mock_okx_credentials):
        page = self._page(1_000_000, 100, "a")
        mock_ccxt_okx.fetch_deposits.side_effect = [page, page, page]

        assert len(list(self._connector().yield_raws())) == 100
        assert mock_ccxt_okx.fetch_deposits.call_count == 2

    def test_drops_records_before_since(self, mock_ccxt_okx, mock_okx_credentials):
        since = datetime.fromtimestamp(1_050, tz=timezone.utc)
        mock_ccxt_okx.fetch_deposits.return_value = self._page(1_000_000, 100, "a")

        items = list(self._connector(since=since).yield_raws())

        assert [i["timestamp"] for i in items][0] == 1_050_000
        assert mock_ccxt_okx.fetch_deposits.call_count == 1

    def test_retries_rate_limit_then_succeeds(self, mock_ccxt_okx, mock_okx_credentials):
        import ccxt

        mock_ccxt_okx.fetch_deposits.side_effect = [ccxt.RateLimitExceeded("50011 Too Many Requests"), self._page(1, 2, "a")]
        with patch("backend.connectors.base.ccxt_errors.time.sleep"):
            assert len(list(self._connector().yield_raws())) == 2

    def test_auth_error_raises_connector_error(self, mock_ccxt_okx, mock_okx_credentials):
        import ccxt
        from backend.connectors.base.connector_exceptions import ConnectorAPIError, ErrorReason

        mock_ccxt_okx.fetch_deposits.side_effect = ccxt.AuthenticationError("50113 Invalid Sign")
        with pytest.raises(ConnectorAPIError) as exc:
            list(self._connector().yield_raws())
        assert exc.value.reason == ErrorReason.AUTHENTICATION_FAILED
        assert "Invalid Sign" in str(exc.value)
