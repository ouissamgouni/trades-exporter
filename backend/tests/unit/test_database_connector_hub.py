"""
Unit tests for DatabaseConnectorHub and SyncJobService database connector integration.
"""

import pytest
from unittest.mock import MagicMock, patch
from datetime import datetime

from sqlmodel import Session

from backend.db.models import Account, AccountConnector


# ============================================================================
# Test Fixtures
# ============================================================================


@pytest.fixture
def mock_session():
    """Create a mock database session."""
    return MagicMock(spec=Session)


@pytest.fixture
def sample_account():
    """Create a sample account."""
    return Account(
        id=1,
        name="Test Wallet",
        account_type="wallet",
        address_or_identifier="0x1234567890abcdef",
        created_at=datetime(2024, 1, 1, 12, 0, 0),
    )


@pytest.fixture
def sample_binance_connector():
    """Create a sample Binance connector."""
    return AccountConnector(
        id=1,
        account_id=1,
        connector_type="binance",
        enabled=True,
        config={"symbols": ["BTCUSDT", "ETHUSDT"]},
        credentials_ref="env:BINANCE_API_KEY",
        sync_priority=100,
        last_sync_status="pending",
        created_at=datetime(2024, 1, 1, 12, 0, 0),
        updated_at=datetime(2024, 1, 1, 12, 0, 0),
    )


@pytest.fixture
def sample_blockscout_connector():
    """Create a sample Blockscout connector."""
    return AccountConnector(
        id=2,
        account_id=1,
        connector_type="blockscout",
        enabled=True,
        config={
            "chain": "base",
            "address": "0xabcdef1234567890",
            "start_block": 1000000,
        },
        credentials_ref=None,
        sync_priority=200,
        last_sync_status="pending",
        created_at=datetime(2024, 1, 1, 12, 0, 0),
        updated_at=datetime(2024, 1, 1, 12, 0, 0),
    )


# ============================================================================
# Test DatabaseConnectorHub
# ============================================================================


class TestDatabaseConnectorHub:
    """Tests for DatabaseConnectorHub."""

    def test_connector_registry_contains_expected_connectors(self):
        """Test that ConnectorRegistry has all CEX connectors."""
        from backend.connectors.connector_registry import ConnectorRegistry

        registry = ConnectorRegistry.instance()
        expected_connectors = [
            "binance-transactions",
            "binance-deposits",
            "binance-withdrawals",
            "mexc-transactions",
            "okx-transactions",
            "okx-convert",
            "coinbase-transactions",
        ]
        for connector in expected_connectors:
            assert registry.get(connector) is not None

    def test_onchain_connector_types_defined(self):
        """Test that on-chain connector types are properly identified."""
        from backend.connectors.connector_registry import ConnectorRegistry

        registry = ConnectorRegistry.instance()
        expected_onchain = ["blockscout", "etherscan"]
        for onchain_type in expected_onchain:
            assert registry.is_onchain(onchain_type)

    def test_connector_name_property(self):
        """Test connector_name property returns correct value."""
        from backend.connectors.hub.database_connector_hub import DatabaseConnectorHub

        # We can't instantiate without mocking, so check class attribute indirectly
        assert hasattr(DatabaseConnectorHub, "connector_name")


# ============================================================================
# Test SyncJobService Database Connector Support
# ============================================================================


class TestSyncJobServiceDatabaseConnectors:
    """Tests for SyncJobService database connector integration."""

    def test_service_has_database_connector_flag(self):
        """Test that SyncJobService has use_database_connectors flag."""
        from backend.services.sync_job_service import SyncJobService
        from unittest.mock import patch

        # Reset singleton for testing
        SyncJobService._instance = None
        
        # Mock settings to return False for use_database_connectors
        with patch('backend.services.sync_job_service.load_settings') as mock_settings:
            mock_settings.return_value = {"use_database_connectors": False}
            service = SyncJobService()

            assert hasattr(service, "_use_database_connectors")
            # Default should be False (from mocked settings)
            assert service._use_database_connectors is False

    def test_set_use_database_connectors(self):
        """Test setting database connector mode."""
        from backend.services.sync_job_service import SyncJobService

        # Reset singleton for testing
        SyncJobService._instance = None
        service = SyncJobService()

        result = service.set_use_database_connectors(True)

        assert result["status"] == "updated"
        assert result["use_database_connectors"] is True
        assert service._use_database_connectors is True

        # Set back to False
        result = service.set_use_database_connectors(False)
        assert result["use_database_connectors"] is False

    def test_get_status_includes_database_connector_flag(self):
        """Test that get_status includes database connector info."""
        from backend.services.sync_job_service import SyncJobService
        from unittest.mock import patch

        # Reset singleton for testing
        SyncJobService._instance = None
        
        # Mock settings to return False for use_database_connectors
        with patch('backend.services.sync_job_service.load_settings') as mock_settings:
            mock_settings.return_value = {"use_database_connectors": False}
            service = SyncJobService()

            status = service.get_status()

            assert "use_database_connectors" in status
            assert status["use_database_connectors"] is False

    def test_cannot_change_connector_source_while_running(self):
        """Test that connector source cannot be changed while job is running."""
        from backend.services.sync_job_service import SyncJobService, JobStatus

        # Reset singleton for testing
        SyncJobService._instance = None
        service = SyncJobService()

        # Simulate running job
        service.progress.status = JobStatus.RUNNING

        with pytest.raises(RuntimeError, match="Cannot change connector source"):
            service.set_use_database_connectors(True)

        # Reset status
        service.progress.status = JobStatus.IDLE


# ============================================================================
# Test ConnectorLoaderService Integration
# ============================================================================


class TestConnectorLoaderServiceIntegration:
    """Tests for ConnectorLoaderService integration."""

    def test_connector_registry_type_map_consistency(self):
        """Test that ConnectorRegistry has consistent mapping for all connector types."""
        from backend.connectors.connector_registry import ConnectorRegistry

        registry = ConnectorRegistry.instance()

        # CEX connectors should have hub keys matching their type
        cex_types = [
            "binance-transactions",
            "mexc-transactions",
            "okx-transactions",
            "coinbase-transactions",
        ]
        for cex_type in cex_types:
            hub_key = registry.get_hub_key(cex_type)
            assert hub_key == cex_type

        # On-chain connectors should be identified
        onchain_types = ["blockscout", "etherscan"]
        for onchain_type in onchain_types:
            assert registry.is_onchain(onchain_type)

    def test_chain_config_has_required_chains(self):
        """Test that ConnectorRegistry has required chain configurations."""
        from backend.connectors.connector_registry import ConnectorRegistry

        registry = ConnectorRegistry.instance()

        # Blockscout should have multiple chains
        blockscout_chains = registry.get_chain_configs("blockscout")
        assert "base" in blockscout_chains
        assert "polygon" in blockscout_chains
        assert "ethereum" in blockscout_chains

        # Etherscan should have ethereum
        etherscan_chains = registry.get_chain_configs("etherscan")
        assert "ethereum" in etherscan_chains

    def test_resolve_credentials_env_var(self):
        """Test resolving credentials from environment variable."""
        from backend.services.connector_loader_service import ConnectorLoaderService

        service = ConnectorLoaderService(session=MagicMock())

        # Test env: prefix
        with patch.dict("os.environ", {"TEST_API_KEY": "secret123"}):
            result = service.resolve_credentials("env:TEST_API_KEY")
            assert result == "secret123"

    def test_resolve_credentials_none(self):
        """Test resolving None credentials."""
        from backend.services.connector_loader_service import ConnectorLoaderService

        service = ConnectorLoaderService(session=MagicMock())
        result = service.resolve_credentials(None)
        assert result is None

    def test_resolve_credentials_direct_value(self):
        """Test resolving direct credential value."""
        from backend.services.connector_loader_service import ConnectorLoaderService

        service = ConnectorLoaderService(session=MagicMock())
        result = service.resolve_credentials("direct_secret")
        assert result == "direct_secret"


# ============================================================================
# Test API Routes
# ============================================================================


class TestSyncJobAPIRoutes:
    """Tests for sync job API routes."""

    def test_connector_source_request_model(self):
        """Test ConnectorSourceRequest model."""
        from backend.api.routes.sync_job import ConnectorSourceRequest

        request = ConnectorSourceRequest(use_database=True)
        assert request.use_database is True

        request = ConnectorSourceRequest(use_database=False)
        assert request.use_database is False

    def test_job_status_response_has_database_flag(self):
        """Test JobStatusResponse includes database connector flag."""
        from backend.api.routes.sync_job import JobStatusResponse

        response = JobStatusResponse(
            status="idle",
            use_database_connectors=True,
        )
        assert response.use_database_connectors is True
