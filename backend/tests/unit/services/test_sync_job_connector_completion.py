"""
Unit tests for connector completion handling in SyncJobService.
Tests the _handle_connector_completion method and immediate status transitions.
"""
import pytest
from datetime import datetime
from unittest.mock import Mock, MagicMock, patch, call
from threading import Event

from backend.services.sync_job_service import (
    SyncJobService,
    ConnectorProgress,
    ConnectorSyncStatus,
    JobProgress,
    JobStatus,
)


@pytest.fixture
def sync_service():
    """Create SyncJobService instance."""
    service = SyncJobService()
    service.progress = JobProgress()
    service._run_job_db_connector_runs = {1: 101, 2: 102}
    return service


@pytest.fixture
def mock_connector_progress():
    """Create mock ConnectorProgress."""
    progress = ConnectorProgress(
        connector_id=1,
        connector_type="binance-transactions",
        account_name="Binance Main",
        status=ConnectorSyncStatus.RUNNING,
        fetched_count=100,
        new_count=50,
        updated_count=10,
        skipped_count=40,
        error_count=0
    )
    progress.started_at = datetime.now()
    return progress


class TestHandleConnectorCompletion:
    """Test _handle_connector_completion method."""

    @patch('backend.db.database.get_session')
    @patch('backend.services.sync_job_service.SyncJobService._persist_connector_status')
    def test_successful_completion_transitions_to_completed(
        self, mock_persist, mock_get_session, sync_service, mock_connector_progress
    ):
        """Test that successful connector transitions to COMPLETED status."""
        # Setup
        sync_service.progress.connector_statuses[1] = mock_connector_progress
        mock_session = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        
        # Execute
        sync_service._handle_connector_completion(1)
        
        # Assert
        assert sync_service.progress.connector_statuses[1].status == ConnectorSyncStatus.COMPLETED
        assert sync_service.progress.connector_statuses[1].finished_at is not None
        mock_persist.assert_called_once_with(1, "success", error=None)

    @patch('backend.db.database.get_session')
    @patch('backend.services.sync_job_service.SyncJobService._persist_connector_status')
    def test_completion_with_errors_transitions_to_warning(
        self, mock_persist, mock_get_session, sync_service, mock_connector_progress
    ):
        """Test that connector with errors transitions to WARNING status."""
        # Setup - add errors to connector
        mock_connector_progress.error_count = 5
        mock_connector_progress.error = "Some error occurred"
        sync_service.progress.connector_statuses[1] = mock_connector_progress
        
        mock_session = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        
        # Execute
        sync_service._handle_connector_completion(1)
        
        # Assert
        assert sync_service.progress.connector_statuses[1].status == ConnectorSyncStatus.WARNING
        assert sync_service.progress.connector_statuses[1].finished_at is not None
        mock_persist.assert_called_once_with(1, "warning", error="Some error occurred")

    @patch('backend.db.database.get_session')
    def test_completion_sets_finished_timestamp(
        self, mock_get_session, sync_service, mock_connector_progress
    ):
        """Test that completion sets finished_at timestamp."""
        # Setup
        sync_service.progress.connector_statuses[1] = mock_connector_progress
        mock_session = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        
        before = datetime.now()
        
        # Execute
        sync_service._handle_connector_completion(1)
        
        after = datetime.now()
        
        # Assert
        finished_at = sync_service.progress.connector_statuses[1].finished_at
        assert finished_at is not None
        assert before <= finished_at <= after

    @patch('backend.db.database.get_session')
    def test_completion_adds_to_completed_list(
        self, mock_get_session, sync_service, mock_connector_progress
    ):
        """Test that completion adds connector to completed list."""
        # Setup
        sync_service.progress.connector_statuses[1] = mock_connector_progress
        sync_service.progress.connectors_completed = []
        mock_session = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        
        # Execute
        sync_service._handle_connector_completion(1)
        
        # Assert
        assert "Binance Main" in sync_service.progress.connectors_completed

    def test_completion_unknown_connector_handles_gracefully(self, sync_service):
        """Test that completion of unknown connector doesn't crash."""
        # Execute - connector 999 doesn't exist
        sync_service._handle_connector_completion(999)
        
        # Should not raise exception

    @patch('backend.db.database.get_session')
    def test_completion_non_running_connector_skipped(
        self, mock_get_session, sync_service, mock_connector_progress
    ):
        """Test that completion of non-running connector is skipped."""
        # Setup - connector already completed
        mock_connector_progress.status = ConnectorSyncStatus.COMPLETED
        sync_service.progress.connector_statuses[1] = mock_connector_progress
        
        original_finished_at = mock_connector_progress.finished_at
        
        # Execute
        sync_service._handle_connector_completion(1)
        
        # Assert - finished_at should not change
        assert sync_service.progress.connector_statuses[1].finished_at == original_finished_at

    @patch('backend.db.database.get_session')
    def test_completion_updates_database_connector_run(
        self, mock_get_session, sync_service, mock_connector_progress
    ):
        """Test that completion updates database connector run record."""
        # Setup
        sync_service.progress.connector_statuses[1] = mock_connector_progress
        
        mock_session = MagicMock()
        mock_repo = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        
        with patch('backend.db.repositories.sync_job_repository.SyncJobRepository') as mock_repo_class:
            mock_repo_class.return_value = mock_repo
            
            # Execute
            sync_service._handle_connector_completion(1)
            
            # Assert - repository methods were called
            assert mock_repo.update_connector_run_status.called

    @patch('backend.db.database.get_session')
    def test_completion_handles_database_errors_gracefully(
        self, mock_get_session, sync_service, mock_connector_progress
    ):
        """Test that database errors during completion don't crash the process."""
        # Setup
        sync_service.progress.connector_statuses[1] = mock_connector_progress
        
        # Mock database error
        mock_get_session.return_value.__enter__.side_effect = Exception("Database error")
        
        # Execute - should not raise
        sync_service._handle_connector_completion(1)
        
        # Connector status should still be updated (before DB persistence)
        assert sync_service.progress.connector_statuses[1].status in [
            ConnectorSyncStatus.COMPLETED,
            ConnectorSyncStatus.WARNING
        ]

    @patch('backend.db.database.get_session')
    def test_completion_adds_log_entries(
        self, mock_get_session, sync_service, mock_connector_progress
    ):
        """Test that completion adds appropriate log entries."""
        # Setup
        sync_service.progress.connector_statuses[1] = mock_connector_progress
        mock_session = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        
        initial_log_count = len(mock_connector_progress.logs)
        
        # Execute
        sync_service._handle_connector_completion(1)
        
        # Assert - log entry was added
        final_log_count = len(sync_service.progress.connector_statuses[1].logs)
        assert final_log_count > initial_log_count

    @patch('backend.db.database.get_session')
    def test_completion_with_warning_logs_error_count(
        self, mock_get_session, sync_service, mock_connector_progress
    ):
        """Test that completion with errors logs the error count."""
        # Setup
        mock_connector_progress.error_count = 3
        sync_service.progress.connector_statuses[1] = mock_connector_progress
        mock_session = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        
        # Execute
        sync_service._handle_connector_completion(1)
        
        # Assert - log should mention errors
        logs = sync_service.progress.connector_statuses[1].logs
        assert any("error" in log.message.lower() for log in logs)


class TestConcurrentCompletions:
    """Test concurrent connector completions."""

    @patch('backend.db.database.get_session')
    def test_multiple_connectors_complete_independently(
        self, mock_get_session, sync_service
    ):
        """Test that multiple connectors can complete independently."""
        # Setup multiple connectors
        for i in range(1, 4):
            progress = ConnectorProgress(
                connector_id=i,
                connector_type=f"connector-{i}",
                account_name=f"Account {i}",
                status=ConnectorSyncStatus.RUNNING,
                fetched_count=100,
                new_count=50,
                updated_count=10,
                skipped_count=40,
                error_count=0
            )
            progress.started_at = datetime.now()
            sync_service.progress.connector_statuses[i] = progress
        
        mock_session = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        
        # Complete connectors in different order
        sync_service._handle_connector_completion(2)
        sync_service._handle_connector_completion(1)
        sync_service._handle_connector_completion(3)
        
        # Assert all completed
        assert sync_service.progress.connector_statuses[1].status == ConnectorSyncStatus.COMPLETED
        assert sync_service.progress.connector_statuses[2].status == ConnectorSyncStatus.COMPLETED
        assert sync_service.progress.connector_statuses[3].status == ConnectorSyncStatus.COMPLETED
        
        # All should have finished_at
        assert all(
            sync_service.progress.connector_statuses[i].finished_at is not None
            for i in range(1, 4)
        )


class TestEdgeCasesAndErrorHandling:
    """Test edge cases and error handling."""

    def test_completion_without_db_connector_runs(self, sync_service, mock_connector_progress):
        """Test completion when db_connector_runs is not set."""
        # Setup
        sync_service.progress.connector_statuses[1] = mock_connector_progress
        del sync_service._run_job_db_connector_runs  # Remove the attribute
        
        # Execute - should not crash
        with patch('backend.db.database.get_session'):
            sync_service._handle_connector_completion(1)
        
        # Should still update status
        assert sync_service.progress.connector_statuses[1].status == ConnectorSyncStatus.COMPLETED

    @patch('backend.db.database.get_session')
    def test_completion_with_none_error(
        self, mock_get_session, sync_service, mock_connector_progress
    ):
        """Test completion when error is None."""
        # Setup
        mock_connector_progress.error = None
        mock_connector_progress.error_count = 0
        sync_service.progress.connector_statuses[1] = mock_connector_progress
        mock_session = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        
        # Execute
        sync_service._handle_connector_completion(1)
        
        # Should complete successfully
        assert sync_service.progress.connector_statuses[1].status == ConnectorSyncStatus.COMPLETED

    @patch('backend.db.database.get_session')
    def test_completion_thread_safety(self, mock_get_session, sync_service):
        """Test that concurrent completions are thread-safe."""
        import threading
        
        # Setup multiple connectors
        for i in range(1, 11):
            progress = ConnectorProgress(
                connector_id=i,
                connector_type=f"connector-{i}",
                account_name=f"Account {i}",
                status=ConnectorSyncStatus.RUNNING,
                fetched_count=10,
                new_count=5,
                updated_count=3,
                skipped_count=2,
                error_count=0
            )
            progress.started_at = datetime.now()
            sync_service.progress.connector_statuses[i] = progress
        
        mock_session = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        
        # Complete connectors from multiple threads
        def complete_connector(conn_id):
            sync_service._handle_connector_completion(conn_id)
        
        threads = []
        for i in range(1, 11):
            t = threading.Thread(target=complete_connector, args=(i,))
            t.start()
            threads.append(t)
        
        for t in threads:
            t.join()
        
        # All should be completed
        completed_count = sum(
            1 for status in sync_service.progress.connector_statuses.values()
            if status.status == ConnectorSyncStatus.COMPLETED
        )
        assert completed_count == 10

    @patch('backend.db.database.get_session')
    def test_completion_preserves_metrics(
        self, mock_get_session, sync_service, mock_connector_progress
    ):
        """Test that completion preserves connector metrics."""
        # Setup
        mock_connector_progress.fetched_count = 150
        mock_connector_progress.new_count = 75
        mock_connector_progress.updated_count = 25
        mock_connector_progress.skipped_count = 50
        sync_service.progress.connector_statuses[1] = mock_connector_progress
        
        mock_session = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        
        # Execute
        sync_service._handle_connector_completion(1)
        
        # Assert metrics are preserved
        connector = sync_service.progress.connector_statuses[1]
        assert connector.fetched_count == 150
        assert connector.new_count == 75
        assert connector.updated_count == 25
        assert connector.skipped_count == 50


class TestStatusTransitions:
    """Test status transition logic."""

    @patch('backend.db.database.get_session')
    def test_only_running_connectors_transition(
        self, mock_get_session, sync_service
    ):
        """Test that only RUNNING connectors transition on completion."""
        # Setup connectors in different states
        statuses = [
            (1, ConnectorSyncStatus.QUEUED),
            (2, ConnectorSyncStatus.RUNNING),
            (3, ConnectorSyncStatus.COMPLETED),
            (4, ConnectorSyncStatus.FAILED),
            (5, ConnectorSyncStatus.SKIPPED),
        ]
        
        for connector_id, status in statuses:
            progress = ConnectorProgress(
                connector_id=connector_id,
                connector_type=f"connector-{connector_id}",
                account_name=f"Account {connector_id}",
                status=status,
                fetched_count=10,
                new_count=5,
                updated_count=3,
                skipped_count=2,
                error_count=0
            )
            if status == ConnectorSyncStatus.RUNNING:
                progress.started_at = datetime.now()
            sync_service.progress.connector_statuses[connector_id] = progress
        
        mock_session = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        
        # Attempt to complete all
        for connector_id, _ in statuses:
            sync_service._handle_connector_completion(connector_id)
        
        # Only connector 2 (RUNNING) should transition to COMPLETED
        assert sync_service.progress.connector_statuses[1].status == ConnectorSyncStatus.QUEUED
        assert sync_service.progress.connector_statuses[2].status == ConnectorSyncStatus.COMPLETED
        assert sync_service.progress.connector_statuses[3].status == ConnectorSyncStatus.COMPLETED
        assert sync_service.progress.connector_statuses[4].status == ConnectorSyncStatus.FAILED
        assert sync_service.progress.connector_statuses[5].status == ConnectorSyncStatus.SKIPPED

    @patch('backend.db.database.get_session')
    def test_completion_with_mixed_error_counts(
        self, mock_get_session, sync_service
    ):
        """Test completion transitions correctly based on error count."""
        # Setup connectors with different error counts
        test_cases = [
            (1, 0, ConnectorSyncStatus.COMPLETED),  # No errors
            (2, 1, ConnectorSyncStatus.WARNING),     # Some errors
            (3, 10, ConnectorSyncStatus.WARNING),    # Many errors
        ]
        
        for connector_id, error_count, expected_status in test_cases:
            progress = ConnectorProgress(
                connector_id=connector_id,
                connector_type=f"connector-{connector_id}",
                account_name=f"Account {connector_id}",
                status=ConnectorSyncStatus.RUNNING,
                fetched_count=100,
                new_count=50,
                updated_count=10,
                skipped_count=40,
                error_count=error_count
            )
            progress.started_at = datetime.now()
            sync_service.progress.connector_statuses[connector_id] = progress
        
        mock_session = MagicMock()
        mock_get_session.return_value.__enter__.return_value = mock_session
        
        # Complete all connectors
        for connector_id, error_count, expected_status in test_cases:
            sync_service._handle_connector_completion(connector_id)
            actual_status = sync_service.progress.connector_statuses[connector_id].status
            assert actual_status == expected_status, \
                f"Connector {connector_id} with {error_count} errors should be {expected_status}, got {actual_status}"
