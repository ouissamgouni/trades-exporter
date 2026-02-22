"""
Unit tests for Incremental Sync feature.

Tests:
- ConnectorInfo.supports_incremental_sync field
- BaseConnector.since_datetime and since_timestamp_ms properties
- NormalizedTransactionRepository.get_max_datetime_by_connector method
"""

import pytest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch, PropertyMock

from backend.connectors.connector_registry import ConnectorRegistry, ConnectorInfo


# ============================================================================
# Test ConnectorInfo.supports_incremental_sync
# ============================================================================


class TestConnectorInfoIncrementalSync:
    """Test supports_incremental_sync field in ConnectorInfo."""

    def test_cex_connectors_support_incremental_sync(self):
        """CEX connectors should have supports_incremental_sync=True."""
        registry = ConnectorRegistry()
        
        cex_connector_types = [
            "binance-transactions",
            "binance-deposits", 
            "binance-withdrawals",
            "mexc-transactions",
            "okx-transactions",
            "okx-convert",
            "coinbase-transactions",
        ]
        
        for connector_type in cex_connector_types:
            info = registry.get(connector_type)
            assert info is not None, f"Connector {connector_type} not found in registry"
            assert info.supports_incremental_sync is True, \
                f"CEX connector {connector_type} should support incremental sync"

    def test_onchain_connectors_do_not_support_incremental_sync(self):
        """On-chain connectors should have supports_incremental_sync=False."""
        registry = ConnectorRegistry()
        
        onchain_connector_types = [
            "blockscout",
            "etherscan",
        ]
        
        for connector_type in onchain_connector_types:
            info = registry.get(connector_type)
            assert info is not None, f"Connector {connector_type} not found in registry"
            assert info.supports_incremental_sync is False, \
                f"On-chain connector {connector_type} should NOT support incremental sync"

    def test_connector_info_to_api_dict_includes_incremental_sync(self):
        """ConnectorInfo.to_api_dict() should include supports_incremental_sync."""
        info = ConnectorInfo(
            type="test-connector",
            category="cex",
            display_name="Test Connector",
            required_config=["api_key"],
            optional_config=[],
            supports_incremental_sync=True,
        )
        
        api_dict = info.to_api_dict()
        
        assert "supports_incremental_sync" in api_dict
        assert api_dict["supports_incremental_sync"] is True


# ============================================================================
# Test BaseConnector.since_datetime and since_timestamp_ms
# ============================================================================


class TestBaseConnectorSinceDatetime:
    """Test since_datetime property in BaseConnector."""

    def test_since_datetime_from_config(self):
        """BaseConnector should read since_datetime from config."""
        from backend.connectors.base.base_connector import BaseConnector
        
        test_datetime = datetime(2024, 6, 15, 10, 30, 0, tzinfo=timezone.utc)
        
        # Create a concrete implementation for testing
        class TestConnector(BaseConnector):
            @property
            def connector_name(self) -> str:
                return "test-connector"
            
            def yield_raws(self):
                return
                yield  # Makes this a generator
            
            def raw_to_normalized(self, raw):
                return None
        
        connector = TestConnector(
            account_id=1,
            connector_id=1,
            config={"since_datetime": test_datetime, "test_mode": True}
        )
        
        assert connector.since_datetime == test_datetime

    def test_since_datetime_none_when_not_in_config(self):
        """since_datetime should be None when not provided in config."""
        from backend.connectors.base.base_connector import BaseConnector
        
        class TestConnector(BaseConnector):
            @property
            def connector_name(self) -> str:
                return "test-connector"
            
            def yield_raws(self):
                return
                yield  # Makes this a generator
            
            def raw_to_normalized(self, raw):
                return None
        
        connector = TestConnector(
            account_id=1,
            connector_id=1,
            config={"test_mode": True}
        )
        
        assert connector.since_datetime is None

    def test_since_timestamp_ms_conversion(self):
        """since_timestamp_ms should convert datetime to milliseconds."""
        from backend.connectors.base.base_connector import BaseConnector
        
        # 2024-06-15 10:30:00 UTC = 1718444400000 ms
        test_datetime = datetime(2024, 6, 15, 10, 30, 0, tzinfo=timezone.utc)
        expected_ms = int(test_datetime.timestamp() * 1000)
        
        class TestConnector(BaseConnector):
            @property
            def connector_name(self) -> str:
                return "test-connector"
            
            def yield_raws(self):
                return
                yield  # Makes this a generator
            
            def raw_to_normalized(self, raw):
                return None
        
        connector = TestConnector(
            account_id=1,
            connector_id=1,
            config={"since_datetime": test_datetime, "test_mode": True}
        )
        
        assert connector.since_timestamp_ms == expected_ms

    def test_since_timestamp_ms_none_when_no_datetime(self):
        """since_timestamp_ms should be None when since_datetime is None."""
        from backend.connectors.base.base_connector import BaseConnector
        
        class TestConnector(BaseConnector):
            @property
            def connector_name(self) -> str:
                return "test-connector"
            
            def yield_raws(self):
                return
                yield  # Makes this a generator
            
            def raw_to_normalized(self, raw):
                return None
        
        connector = TestConnector(
            account_id=1,
            connector_id=1,
            config={"test_mode": True}
        )
        
        assert connector.since_timestamp_ms is None


# ============================================================================
# Test NormalizedTransactionRepository.get_max_datetime_by_connector
# ============================================================================


class TestNormalizedTransactionRepositoryMaxDatetime:
    """Test get_max_datetime_by_connector in NormalizedTransactionRepository."""

    def test_get_max_datetime_returns_none_for_empty_connector(self):
        """Should return None when connector has no transactions."""
        from backend.db.repositories.normalized_transaction_repository import NormalizedTransactionRepository
        
        mock_session = MagicMock()
        mock_session.exec.return_value.first.return_value = None
        
        repo = NormalizedTransactionRepository(mock_session)
        result = repo.get_max_datetime_by_connector(999)  # Non-existent connector
        
        assert result is None

    def test_get_max_datetime_returns_datetime(self):
        """Should return max datetime when connector has transactions."""
        from backend.db.repositories.normalized_transaction_repository import NormalizedTransactionRepository
        
        expected_datetime = datetime(2024, 6, 15, 10, 30, 0, tzinfo=timezone.utc)
        
        mock_session = MagicMock()
        mock_session.exec.return_value.first.return_value = expected_datetime
        
        repo = NormalizedTransactionRepository(mock_session)
        result = repo.get_max_datetime_by_connector(1)
        
        assert result == expected_datetime
