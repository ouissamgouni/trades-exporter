"""
Unit tests for Account Connectors API and service.
"""

import pytest
from unittest.mock import MagicMock, patch
from datetime import datetime

from backend.db.models import Account, AccountConnector
from backend.api.routes.account_connectors import (
    get_available_connectors,
    resolve_credentials,
    AccountConnectorCreate,
    AccountConnectorUpdate,
)


# ============================================================================
# Test Fixtures
# ============================================================================


@pytest.fixture
def mock_account():
    """Create a mock account."""
    return Account(
        id=1,
        name="Test Wallet",
        account_type="wallet",
        address_or_identifier="0x1234567890abcdef",
        tags=["test", "defi"],
        created_at=datetime(2024, 1, 1, 12, 0, 0),
    )


@pytest.fixture
def mock_connector():
    """Create a mock account connector."""
    return AccountConnector(
        id=1,
        account_id=1,
        connector_type="blockscout",
        enabled=True,
        config={
            "chain": "bnb",
            "address": "0x1234567890abcdef",
            "start_block": 35000000,
        },
        credentials_ref="env:BSCSCAN_API_KEY",
        sync_priority=100,
        last_sync_status="pending",
        created_at=datetime(2024, 1, 1, 12, 0, 0),
        updated_at=datetime(2024, 1, 1, 12, 0, 0),
    )


# ============================================================================
# Test Available Connectors Configuration
# ============================================================================


class TestAvailableConnectors:
    """Tests for the available connectors configuration."""

    def test_all_expected_connectors_registered(self):
        """Test that all expected connector types are registered."""
        available = get_available_connectors()
        expected_types = [
            "binance-transactions",
            "binance-deposits",
            "binance-withdrawals",
            "coinbase-transactions",
            "mexc-transactions",
            "okx-transactions",
            "blockscout",
            "etherscan",
        ]
        for ctype in expected_types:
            assert ctype in available, f"Missing connector type: {ctype}"

    def test_blockscout_has_supported_chains(self):
        """Test that blockscout connector has supported chains."""
        available = get_available_connectors()
        blockscout = available["blockscout"]
        assert blockscout.supported_chains is not None
        assert "bnb" in blockscout.supported_chains
        assert "base" in blockscout.supported_chains
        assert "ethereum" in blockscout.supported_chains

    def test_cex_connectors_have_correct_category(self):
        """Test that CEX connectors have correct category."""
        available = get_available_connectors()
        cex_types = [
            "binance-transactions",
            "binance-deposits",
            "binance-withdrawals",
            "coinbase-transactions",
            "mexc-transactions",
            "okx-transactions",
        ]
        for ctype in cex_types:
            assert available[ctype].category == "cex"

    def test_onchain_connectors_have_correct_category(self):
        """Test that on-chain connectors have correct category."""
        available = get_available_connectors()
        onchain_types = ["blockscout", "etherscan"]
        for ctype in onchain_types:
            assert available[ctype].category == "onchain"

    def test_binance_has_optional_symbols(self):
        """Test that Binance connector has symbols as optional config."""
        available = get_available_connectors()
        binance = available["binance-transactions"]
        assert "symbols" in binance.optional_config

    def test_blockscout_requires_chain_and_address(self):
        """Test that Blockscout connector requires chain and address."""
        available = get_available_connectors()
        blockscout = available["blockscout"]
        assert "chain" in blockscout.required_config
        assert "address" in blockscout.required_config


# ============================================================================
# Test Credentials Resolution
# ============================================================================


class TestResolveCredentials:
    """Tests for credentials resolution."""

    def test_resolve_none_credentials(self):
        """Test resolving None credentials returns None."""
        result = resolve_credentials(None)
        assert result is None

    def test_resolve_empty_credentials(self):
        """Test resolving empty string credentials returns None."""
        result = resolve_credentials("")
        assert result is None

    @patch.dict("os.environ", {"TEST_API_KEY": "secret123"})
    def test_resolve_env_credentials(self):
        """Test resolving environment variable credentials."""
        result = resolve_credentials("env:TEST_API_KEY")
        assert result == "secret123"

    @patch.dict("os.environ", {}, clear=True)
    def test_resolve_missing_env_credentials(self):
        """Test resolving missing environment variable returns None."""
        result = resolve_credentials("env:NONEXISTENT_KEY")
        assert result is None

    def test_resolve_direct_value(self):
        """Test resolving direct value (not recommended but supported)."""
        result = resolve_credentials("direct_api_key_value")
        assert result == "direct_api_key_value"


# ============================================================================
# Test Pydantic Models
# ============================================================================


class TestAccountConnectorCreate:
    """Tests for AccountConnectorCreate model."""

    def test_create_minimal(self):
        """Test creating with minimal required fields."""
        data = AccountConnectorCreate(connector_type="binance")
        assert data.connector_type == "binance"
        assert data.enabled is True
        assert data.config == {}
        assert data.sync_priority == 100

    def test_create_full(self):
        """Test creating with all fields."""
        data = AccountConnectorCreate(
            connector_type="blockscout",
            enabled=True,
            config={
                "chain": "bnb",
                "address": "0x123",
                "start_block": 1000000,
            },
            credentials_ref="env:API_KEY",
            sync_priority=50,
        )
        assert data.connector_type == "blockscout"
        assert data.config["chain"] == "bnb"
        assert data.credentials_ref == "env:API_KEY"
        assert data.sync_priority == 50


class TestAccountConnectorUpdate:
    """Tests for AccountConnectorUpdate model."""

    def test_update_empty(self):
        """Test update with no fields (all optional)."""
        data = AccountConnectorUpdate()
        assert data.enabled is None
        assert data.config is None
        assert data.credentials_ref is None
        assert data.sync_priority is None

    def test_update_partial(self):
        """Test update with partial fields."""
        data = AccountConnectorUpdate(enabled=False, sync_priority=10)
        assert data.enabled is False
        assert data.sync_priority == 10
        assert data.config is None


# ============================================================================
# Test AccountConnector Model
# ============================================================================


class TestAccountConnectorModel:
    """Tests for AccountConnector database model."""

    def test_connector_defaults(self):
        """Test connector model defaults."""
        connector = AccountConnector(
            account_id=1,
            connector_type="binance",
        )
        assert connector.enabled is True
        assert connector.sync_priority == 100
        assert connector.last_sync_status == "pending"

    def test_connector_with_config(self, mock_connector):
        """Test connector with full config."""
        assert mock_connector.connector_type == "blockscout"
        assert mock_connector.config["chain"] == "bnb"
        assert mock_connector.config["start_block"] == 35000000
        assert mock_connector.enabled is True

    def test_connector_relationship_fields(self, mock_connector):
        """Test connector has account relationship fields."""
        assert mock_connector.account_id == 1


# ============================================================================
# Test Connector Loader Service
# ============================================================================


class TestConnectorLoaderService:
    """Tests for ConnectorLoaderService."""

    def test_resolve_env_credentials(self):
        """Test resolving environment variable credentials."""
        from backend.services.connector_loader_service import ConnectorLoaderService

        service = ConnectorLoaderService(session=MagicMock())

        with patch.dict("os.environ", {"MY_API_KEY": "test_secret"}):
            result = service.resolve_credentials("env:MY_API_KEY")
            assert result == "test_secret"

    def test_resolve_no_credentials(self):
        """Test resolving None credentials."""
        from backend.services.connector_loader_service import ConnectorLoaderService

        service = ConnectorLoaderService(session=MagicMock())
        result = service.resolve_credentials(None)
        assert result is None

    def test_chain_config_via_registry(self):
        """Test chain configuration is available via registry."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()
        # Blockscout should have chain config for supported chains
        chain_config = registry.get_chain_config("blockscout", "bnb")
        assert chain_config is not None
        chain_config = registry.get_chain_config("blockscout", "base")
        assert chain_config is not None

    def test_connector_registry_has_connectors(self):
        """Test connector registry has expected connectors."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()
        # CEX connectors
        assert registry.get("binance-transactions") is not None
        assert registry.get("coinbase-transactions") is not None

        # On-chain connectors
        assert registry.get("blockscout") is not None
        assert registry.get("etherscan") is not None

    def test_build_connector_config(self, mock_account, mock_connector):
        """Test building full connector configuration."""
        from backend.services.connector_loader_service import ConnectorLoaderService

        service = ConnectorLoaderService(session=MagicMock())

        with patch.dict("os.environ", {"BSCSCAN_API_KEY": "test_key"}):
            config = service.build_connector_config(mock_connector, mock_account)

        # Should include original config
        assert config["chain"] == "bnb"
        assert config["address"] == "0x1234567890abcdef"
        assert config["start_block"] == 35000000

        # Should add account context
        assert config["_account_id"] == 1
        assert config["_account_name"] == "Test Wallet"
        assert config["_connector_id"] == 1

        # Should resolve credentials
        assert config["api_key"] == "test_key"


# ============================================================================
# Test Validation Logic
# ============================================================================


class TestValidation:
    """Tests for validation logic."""

    def test_valid_connector_types(self):
        """Test all valid connector types."""
        available = get_available_connectors()
        valid_types = list(available.keys())
        assert len(valid_types) >= 7  # At least 7 connectors defined

    def test_blockscout_chain_validation(self):
        """Test Blockscout supported chains."""
        available = get_available_connectors()
        blockscout = available["blockscout"]
        valid_chains = blockscout.supported_chains

        assert "bnb" in valid_chains
        assert "base" in valid_chains
        assert "ethereum" in valid_chains
        assert "polygon" in valid_chains
        assert "invalid_chain" not in valid_chains

    def test_required_config_fields(self):
        """Test required config fields for different connectors."""
        available = get_available_connectors()
        # Binance transactions has no required config (symbols are optional)
        assert available["binance-transactions"].required_config == []

        # Blockscout requires chain and address
        blockscout_required = available["blockscout"].required_config
        assert "chain" in blockscout_required
        assert "address" in blockscout_required

        # Etherscan only requires address
        etherscan_required = available["etherscan"].required_config
        assert "address" in etherscan_required
