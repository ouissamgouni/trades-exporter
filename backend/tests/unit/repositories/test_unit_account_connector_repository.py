"""
Unit tests for AccountConnectorRepository.
"""

import pytest
from datetime import datetime
from unittest.mock import MagicMock

from sqlmodel import Session

from backend.db.models import Account, AccountConnector
from backend.db.repositories import AccountConnectorRepository


# ============================================================================
# Test Fixtures
# ============================================================================


@pytest.fixture
def mock_session():
    """Create a mock session."""
    return MagicMock(spec=Session)


@pytest.fixture
def sample_account():
    """Create a sample account."""
    return Account(
        id=1,
        name="Test Account",
        account_type="wallet",
        address_or_identifier="0x1234567890abcdef",
        created_at=datetime(2024, 1, 1, 12, 0, 0),
    )


@pytest.fixture
def sample_connector():
    """Create a sample connector."""
    return AccountConnector(
        id=1,
        account_id=1,
        connector_type="binance",
        enabled=True,
        config={"symbols": ["BTCUSDT", "ETHUSDT"]},
        sync_priority=100,
        last_sync_status="pending",
        created_at=datetime(2024, 1, 1, 12, 0, 0),
        updated_at=datetime(2024, 1, 1, 12, 0, 0),
    )


@pytest.fixture
def repo(mock_session):
    """Create a repository instance."""
    return AccountConnectorRepository(mock_session)


# ============================================================================
# Test Repository Methods
# ============================================================================


class TestAccountConnectorRepository:
    """Tests for AccountConnectorRepository."""

    def test_create_connector(self, repo, mock_session, sample_connector):
        """Test creating a new connector."""
        mock_session.refresh = MagicMock()

        result = repo.create(sample_connector)

        mock_session.add.assert_called_once_with(sample_connector)
        mock_session.flush.assert_called_once()
        mock_session.refresh.assert_called_once_with(sample_connector)
        assert result == sample_connector

    def test_get_connector_by_id(self, repo, mock_session, sample_connector):
        """Test getting a connector by ID."""
        mock_session.get.return_value = sample_connector

        result = repo.get(1)

        mock_session.get.assert_called_once_with(AccountConnector, 1)
        assert result == sample_connector

    def test_get_connector_not_found(self, repo, mock_session):
        """Test getting a non-existent connector."""
        mock_session.get.return_value = None

        result = repo.get(999)

        assert result is None

    def test_get_enabled_connectors(
        self, repo, mock_session, sample_connector, sample_account
    ):
        """Test getting all enabled connectors with accounts."""
        mock_exec = MagicMock()
        mock_exec.all.return_value = [(sample_connector, sample_account)]
        mock_session.exec.return_value = mock_exec

        result = repo.get_enabled()

        assert len(result) == 1
        assert result[0] == (sample_connector, sample_account)

    def test_get_by_account(self, repo, mock_session, sample_connector):
        """Test getting connectors by account ID."""
        mock_exec = MagicMock()
        mock_exec.all.return_value = [sample_connector]
        mock_session.exec.return_value = mock_exec

        result = repo.get_by_account(1)

        assert len(result) == 1
        assert result[0] == sample_connector

    def test_get_by_account_enabled_only(self, repo, mock_session, sample_connector):
        """Test getting only enabled connectors for an account."""
        mock_exec = MagicMock()
        mock_exec.all.return_value = [sample_connector]
        mock_session.exec.return_value = mock_exec

        result = repo.get_by_account(1, enabled_only=True)

        assert len(result) == 1
        # Verify the query was called (session.exec was invoked)
        assert mock_session.exec.called

    def test_get_by_account_and_type(self, repo, mock_session, sample_connector):
        """Test getting a connector by account ID and type."""
        mock_exec = MagicMock()
        mock_exec.first.return_value = sample_connector
        mock_session.exec.return_value = mock_exec

        result = repo.get_by_account_and_type(1, "binance")

        assert result == sample_connector

    def test_get_by_account_and_type_not_found(self, repo, mock_session):
        """Test getting a non-existent connector by account ID and type."""
        mock_exec = MagicMock()
        mock_exec.first.return_value = None
        mock_session.exec.return_value = mock_exec

        result = repo.get_by_account_and_type(1, "nonexistent")

        assert result is None

    def test_update_connector(self, repo, mock_session, sample_connector):
        """Test updating a connector."""
        mock_session.refresh = MagicMock()
        sample_connector.enabled = False

        result = repo.update(sample_connector)

        mock_session.add.assert_called_once_with(sample_connector)
        mock_session.flush.assert_called_once()
        mock_session.refresh.assert_called_once_with(sample_connector)
        assert result == sample_connector

    def test_update_sync_status_success(self, repo, mock_session, sample_connector):
        """Test updating sync status to success."""
        mock_session.get.return_value = sample_connector

        result = repo.update_sync_status(1, "success")

        assert result is not None
        assert result.last_sync_status == "success"
        assert result.last_error is None
        assert result.last_sync_at is not None

    def test_update_sync_status_failed(self, repo, mock_session, sample_connector):
        """Test updating sync status to failed with error."""
        mock_session.get.return_value = sample_connector

        result = repo.update_sync_status(1, "failed", "Connection timeout")

        assert result is not None
        assert result.last_sync_status == "failed"
        assert result.last_error == "Connection timeout"
        assert result.last_sync_at is not None

    def test_update_sync_status_running(self, repo, mock_session, sample_connector):
        """Test updating sync status to running (no timestamp update)."""
        original_sync_at = sample_connector.last_sync_at
        mock_session.get.return_value = sample_connector

        result = repo.update_sync_status(1, "running")

        assert result is not None
        assert result.last_sync_status == "running"
        # last_sync_at should not change for running status
        assert result.last_sync_at == original_sync_at

    def test_update_sync_status_not_found(self, repo, mock_session):
        """Test updating sync status for non-existent connector."""
        mock_session.get.return_value = None

        result = repo.update_sync_status(999, "success")

        assert result is None

    def test_delete_connector(self, repo, mock_session, sample_connector):
        """Test deleting a connector."""
        mock_session.get.return_value = sample_connector

        result = repo.delete(1)

        mock_session.delete.assert_called_once_with(sample_connector)
        assert result is True

    def test_delete_connector_not_found(self, repo, mock_session):
        """Test deleting a non-existent connector."""
        mock_session.get.return_value = None

        result = repo.delete(999)

        mock_session.delete.assert_not_called()
        assert result is False

    def test_list_all_connectors(self, repo, mock_session, sample_connector):
        """Test listing all connectors."""
        mock_exec = MagicMock()
        mock_exec.all.return_value = [sample_connector]
        mock_session.exec.return_value = mock_exec

        result = repo.list_all()

        assert len(result) == 1
        assert result[0] == sample_connector

    def test_get_by_type(self, repo, mock_session, sample_connector):
        """Test getting connectors by type."""
        mock_exec = MagicMock()
        mock_exec.all.return_value = [sample_connector]
        mock_session.exec.return_value = mock_exec

        result = repo.get_by_type("binance")

        assert len(result) == 1
        assert result[0] == sample_connector
