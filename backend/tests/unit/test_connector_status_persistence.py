"""
Unit tests for connector status persistence in SyncJobService.

Tests the real-time persistence of connector status changes to AccountConnector table.
"""

import pytest
from unittest.mock import MagicMock, patch, call
from datetime import datetime

from backend.services.sync_job_service import SyncJobService


class TestConnectorStatusPersistence:
    """Tests for _persist_connector_status method and status transitions."""

    @patch('backend.services.sync_job_service.get_session')
    def test_persist_connector_status_uses_fresh_session(self, mock_get_session):
        """Ensure status persistence uses fresh sessions for thread-safety."""
        # Setup
        mock_session = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        
        mock_connector = MagicMock()
        mock_session.get.return_value = mock_connector
        
        service = SyncJobService()
        
        # Act
        service._persist_connector_status(1, "running")
        
        # Assert
        mock_get_session.assert_called_once()  # Fresh session created
        mock_session.get.assert_called_once()
        mock_session.add.assert_called_once_with(mock_connector)
        mock_session.commit.assert_called_once()

    @patch('backend.services.sync_job_service.get_session')
    def test_persist_running_status(self, mock_get_session):
        """Test persisting RUNNING status."""
        # Setup
        mock_session = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        
        mock_connector = MagicMock()
        mock_connector.last_sync_status = "pending"
        mock_session.get.return_value = mock_connector
        
        service = SyncJobService()
        
        # Act
        service._persist_connector_status(42, "running")
        
        # Assert
        assert mock_connector.last_sync_status == "running"
        # last_sync_at should NOT be updated for "running" status
        assert not hasattr(mock_connector, 'last_sync_at') or mock_connector.last_sync_at is None

    @patch('backend.services.sync_job_service.get_session')
    def test_persist_pending_status(self, mock_get_session):
        """Test persisting PENDING (QUEUED) status."""
        # Setup
        mock_session = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        
        mock_connector = MagicMock()
        mock_connector.last_sync_status = None
        mock_session.get.return_value = mock_connector
        
        service = SyncJobService()
        
        # Act
        service._persist_connector_status(42, "pending")
        
        # Assert
        assert mock_connector.last_sync_status == "pending"
        # last_sync_at should NOT be updated for "pending" status

    @patch('backend.services.sync_job_service.get_session')
    def test_persist_success_status_updates_timestamp(self, mock_get_session):
        """Test persisting SUCCESS status updates last_sync_at."""
        # Setup
        mock_session = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        
        mock_connector = MagicMock()
        mock_connector.last_sync_status = "running"
        mock_connector.last_sync_at = None
        mock_connector.last_error = "Some old error"
        mock_session.get.return_value = mock_connector
        
        service = SyncJobService()
        
        # Act
        service._persist_connector_status(42, "success")
        
        # Assert
        assert mock_connector.last_sync_status == "success"
        assert mock_connector.last_sync_at is not None  # Timestamp updated
        assert mock_connector.last_error is None  # Error cleared

    @patch('backend.services.sync_job_service.get_session')
    def test_persist_failed_status_with_error(self, mock_get_session):
        """Test persisting FAILED status with error message."""
        # Setup
        mock_session = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        
        mock_connector = MagicMock()
        mock_connector.last_sync_status = "running"
        mock_connector.last_sync_at = None
        mock_session.get.return_value = mock_connector
        
        service = SyncJobService()
        error_msg = "API rate limit exceeded"
        
        # Act
        service._persist_connector_status(42, "failed", error_msg)
        
        # Assert
        assert mock_connector.last_sync_status == "failed"
        assert mock_connector.last_sync_at is not None  # Timestamp updated
        assert mock_connector.last_error == error_msg

    @patch('backend.services.sync_job_service.get_session')
    def test_persist_handles_missing_connector(self, mock_get_session):
        """Test graceful handling when connector doesn't exist."""
        # Setup
        mock_session = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        mock_session.get.return_value = None  # Connector not found
        
        service = SyncJobService()
        
        # Act - should not raise exception
        service._persist_connector_status(999, "running")
        
        # Assert - no add/commit called when connector not found
        mock_session.add.assert_not_called()
        mock_session.commit.assert_not_called()

    @patch('backend.services.sync_job_service.get_session')
    def test_persist_handles_database_error(self, mock_get_session):
        """Test graceful handling of database errors."""
        # Setup
        mock_session = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        mock_session.commit.side_effect = Exception("Database connection lost")
        
        mock_connector = MagicMock()
        mock_session.get.return_value = mock_connector
        
        service = SyncJobService()
        
        # Act - should not raise exception, just log warning
        service._persist_connector_status(42, "running")
        
        # Assert - exception was caught and handled

    @patch('backend.services.sync_job_service.get_session')
    def test_concurrent_persistence_uses_separate_sessions(self, mock_get_session):
        """Test that concurrent status updates use separate sessions."""
        # Setup
        call_count = 0
        def create_mock_session():
            nonlocal call_count
            call_count += 1
            mock_session = MagicMock()
            mock_session.get.return_value = MagicMock()
            return mock_session
        
        mock_get_session.return_value.__enter__.side_effect = [
            create_mock_session(),
            create_mock_session(),
            create_mock_session(),
        ]
        
        service = SyncJobService()
        
        # Act - simulate concurrent updates from different connectors
        service._persist_connector_status(1, "running")
        service._persist_connector_status(2, "running")
        service._persist_connector_status(3, "success")
        
        # Assert - each call created its own session
        assert mock_get_session.call_count == 3
        assert call_count == 3


class TestStatusTransitions:
    """Tests for connector status transition logic."""

    def test_initialization_failure_sets_failed_status(self):
        """Test that connectors failing initialization get FAILED status."""
        # This is an integration-level test that would require more setup
        # Placeholder for future implementation
        pass

    def test_queued_to_running_on_first_item(self):
        """Test QUEUED → RUNNING transition when first item yields."""
        # This is an integration-level test
        # Placeholder for future implementation
        pass

    def test_running_to_completed_on_connector_finish(self):
        """Test RUNNING → COMPLETED transition when connector finishes."""
        # This is an integration-level test
        # Placeholder for future implementation
        pass
