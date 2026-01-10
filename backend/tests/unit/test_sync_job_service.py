"""
Unit tests for SyncJobService - specifically testing per-connector tracking and test mode.
"""

import pytest
from datetime import datetime
from unittest.mock import MagicMock, patch

from backend.services.sync_job_service import (
    ConnectorProgress,
    ConnectorSyncStatus,
    JobProgress,
    JobStatus,
    LogEntry,
    StageStats,
    PipelineStage,
    ConnectorOverride,
)


# ============================================================================
# Test ConnectorProgress
# ============================================================================


class TestConnectorProgress:
    """Tests for the ConnectorProgress dataclass."""

    def test_default_values(self):
        """Test default values are set correctly."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="binance-transactions",
            account_name="My Binance",
        )
        
        assert progress.connector_id == 1
        assert progress.connector_type == "binance-transactions"
        assert progress.account_name == "My Binance"
        assert progress.status == ConnectorSyncStatus.QUEUED
        assert progress.test_mode is False
        assert progress.started_at is None
        assert progress.finished_at is None
        assert progress.processed == 0
        assert progress.new_count == 0
        assert progress.updated_count == 0
        assert progress.skipped_count == 0
        assert progress.error is None

    def test_to_dict(self):
        """Test serialization to dictionary."""
        now = datetime(2024, 1, 15, 10, 30, 0)
        progress = ConnectorProgress(
            connector_id=42,
            connector_type="etherscan",
            account_name="ETH Wallet",
            status=ConnectorSyncStatus.COMPLETED,
            test_mode=True,
            started_at=now,
            finished_at=now,
            processed=100,
            new_count=50,
            updated_count=10,
            skipped_count=40,
            error=None,
        )
        
        result = progress.to_dict()
        
        assert result["connector_id"] == 42
        assert result["connector_type"] == "etherscan"
        assert result["account_name"] == "ETH Wallet"
        assert result["status"] == "completed"
        assert result["test_mode"] is True
        assert result["started_at"] == "2024-01-15T10:30:00"
        assert result["finished_at"] == "2024-01-15T10:30:00"
        assert result["processed"] == 100
        assert result["new_count"] == 50
        assert result["updated_count"] == 10
        assert result["skipped_count"] == 40
        assert result["error"] is None

    def test_to_dict_with_error(self):
        """Test serialization when there's an error."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="binance-deposits",
            account_name="Binance Main",
            status=ConnectorSyncStatus.FAILED,
            error="API rate limit exceeded",
        )
        
        result = progress.to_dict()
        
        assert result["status"] == "failed"
        assert result["error"] == "API rate limit exceeded"


# ============================================================================
# Test JobProgress
# ============================================================================


class TestJobProgress:
    """Tests for the JobProgress dataclass."""

    def test_default_values(self):
        """Test default values are set correctly."""
        progress = JobProgress()
        
        assert progress.status == JobStatus.IDLE
        assert progress.started_at is None
        assert progress.finished_at is None
        assert progress.total_processed == 0
        assert progress.new_entries_added == 0
        assert progress.entries_updated == 0
        assert progress.duplicates_skipped == 0
        assert progress.errors == []
        assert progress.current_connector is None
        assert progress.connectors_completed == []
        assert progress.total_connectors == 0
        assert progress.abort_requested is False
        assert progress.error_message is None
        assert progress.connector_statuses == {}

    def test_to_dict_includes_connector_statuses(self):
        """Test that to_dict includes connector_statuses."""
        progress = JobProgress(
            status=JobStatus.RUNNING,
            total_connectors=2,
        )
        
        # Add connector progress (keys are integers)
        progress.connector_statuses[1] = ConnectorProgress(
            connector_id=1,
            connector_type="binance-transactions",
            account_name="Binance",
            status=ConnectorSyncStatus.COMPLETED,
        )
        progress.connector_statuses[2] = ConnectorProgress(
            connector_id=2,
            connector_type="etherscan",
            account_name="ETH Wallet",
            status=ConnectorSyncStatus.RUNNING,
        )
        
        result = progress.to_dict()
        
        assert "connector_statuses" in result
        assert len(result["connector_statuses"]) == 2
        # Keys are converted to int, check the actual values
        assert result["connector_statuses"][1]["connector_type"] == "binance-transactions"
        assert result["connector_statuses"][1]["status"] == "completed"
        assert result["connector_statuses"][2]["connector_type"] == "etherscan"
        assert result["connector_statuses"][2]["status"] == "running"

    def test_reset_clears_all_fields(self):
        """Test that reset() clears all fields."""
        progress = JobProgress(
            status=JobStatus.COMPLETED,
            total_processed=100,
            new_entries_added=50,
            errors=["error1", "error2"],
            connectors_completed=["conn1", "conn2"],
        )
        progress.connector_statuses[1] = ConnectorProgress(
            connector_id=1,
            connector_type="test",
            account_name="Test",
        )
        
        progress.reset()
        
        assert progress.status == JobStatus.IDLE
        assert progress.total_processed == 0
        assert progress.new_entries_added == 0
        assert progress.errors == []
        assert progress.connectors_completed == []
        assert progress.connector_statuses == {}


# ============================================================================
# Test ConnectorSyncStatus Enum
# ============================================================================


class TestConnectorSyncStatus:
    """Tests for the ConnectorSyncStatus enum."""

    def test_all_statuses_exist(self):
        """Test that all expected statuses are defined."""
        expected = ["queued", "running", "completed", "failed", "skipped"]
        actual = [s.value for s in ConnectorSyncStatus]
        
        for status in expected:
            assert status in actual, f"Missing status: {status}"

    def test_status_values(self):
        """Test specific status values."""
        assert ConnectorSyncStatus.QUEUED.value == "queued"
        assert ConnectorSyncStatus.RUNNING.value == "running"
        assert ConnectorSyncStatus.COMPLETED.value == "completed"
        assert ConnectorSyncStatus.FAILED.value == "failed"
        assert ConnectorSyncStatus.SKIPPED.value == "skipped"


# ============================================================================
# Test JobStatus Enum
# ============================================================================


class TestJobStatus:
    """Tests for the JobStatus enum."""

    def test_all_statuses_exist(self):
        """Test that all expected job statuses are defined."""
        expected = ["idle", "running", "completed", "aborted", "failed"]
        actual = [s.value for s in JobStatus]
        
        for status in expected:
            assert status in actual, f"Missing status: {status}"

    def test_status_values(self):
        """Test specific status values."""
        assert JobStatus.IDLE.value == "idle"
        assert JobStatus.RUNNING.value == "running"
        assert JobStatus.COMPLETED.value == "completed"
        assert JobStatus.ABORTED.value == "aborted"
        assert JobStatus.FAILED.value == "failed"


# ============================================================================
# Test LogEntry
# ============================================================================


class TestLogEntry:
    """Tests for the LogEntry dataclass."""

    def test_create_log_entry(self):
        """Test creating a log entry."""
        now = datetime(2024, 1, 15, 10, 30, 0)
        entry = LogEntry(
            timestamp=now,
            level="INFO",
            message="Fetching trades for BTC/USDT",
        )
        
        assert entry.timestamp == now
        assert entry.level == "INFO"
        assert entry.message == "Fetching trades for BTC/USDT"

    def test_to_dict(self):
        """Test serialization to dictionary."""
        now = datetime(2024, 1, 15, 10, 30, 0)
        entry = LogEntry(
            timestamp=now,
            level="ERROR",
            message="API rate limit exceeded",
        )
        
        result = entry.to_dict()
        
        assert result["timestamp"] == "2024-01-15T10:30:00"
        assert result["level"] == "ERROR"
        assert result["message"] == "API rate limit exceeded"

    def test_log_levels(self):
        """Test various log levels."""
        for level in ["DEBUG", "INFO", "WARNING", "ERROR"]:
            entry = LogEntry(
                timestamp=datetime.now(),
                level=level,
                message=f"Test {level} message",
            )
            assert entry.level == level


# ============================================================================
# Test StageStats
# ============================================================================


class TestStageStats:
    """Tests for the StageStats dataclass."""

    def test_default_values(self):
        """Test default values are set correctly."""
        stats = StageStats()
        
        assert stats.processed == 0
        assert stats.success == 0
        assert stats.failed == 0

    def test_custom_values(self):
        """Test creating with custom values."""
        stats = StageStats(processed=100, success=90, failed=10)
        
        assert stats.processed == 100
        assert stats.success == 90
        assert stats.failed == 10

    def test_to_dict(self):
        """Test serialization to dictionary."""
        stats = StageStats(processed=50, success=45, failed=5)
        
        result = stats.to_dict()
        
        assert result["processed"] == 50
        assert result["success"] == 45
        assert result["failed"] == 5


# ============================================================================
# Test PipelineStage Enum
# ============================================================================


class TestPipelineStage:
    """Tests for the PipelineStage enum."""

    def test_all_stages_exist(self):
        """Test that all expected pipeline stages are defined."""
        expected = ["fetch", "transfer_detection", "asset_enrichment", "persistence"]
        actual = [s.value for s in PipelineStage]
        
        for stage in expected:
            assert stage in actual, f"Missing stage: {stage}"

    def test_stage_values(self):
        """Test specific stage values."""
        assert PipelineStage.FETCH.value == "fetch"
        assert PipelineStage.TRANSFER_DETECTION.value == "transfer_detection"
        assert PipelineStage.ASSET_ENRICHMENT.value == "asset_enrichment"
        assert PipelineStage.PERSISTENCE.value == "persistence"


# ============================================================================
# Test ConnectorOverride
# ============================================================================


class TestConnectorOverride:
    """Tests for the ConnectorOverride dataclass."""

    def test_minimal_override(self):
        """Test creating override with just connector_id."""
        override = ConnectorOverride(connector_id=42)
        
        assert override.connector_id == 42
        assert override.enabled is None
        assert override.test_mode is None
        assert override.test_file_path is None

    def test_full_override(self):
        """Test creating override with all fields."""
        override = ConnectorOverride(
            connector_id=1,
            enabled=False,
            test_mode=True,
            test_file_path="/path/to/test.json",
        )
        
        assert override.connector_id == 1
        assert override.enabled is False
        assert override.test_mode is True
        assert override.test_file_path == "/path/to/test.json"

    def test_enable_override(self):
        """Test enabling a connector via override."""
        override = ConnectorOverride(connector_id=5, enabled=True)
        
        assert override.enabled is True
        assert override.test_mode is None

    def test_disable_override(self):
        """Test disabling a connector via override."""
        override = ConnectorOverride(connector_id=5, enabled=False)
        
        assert override.enabled is False

    def test_test_mode_override(self):
        """Test enabling test mode via override."""
        override = ConnectorOverride(connector_id=3, test_mode=True)
        
        assert override.test_mode is True
        assert override.enabled is None


# ============================================================================
# Test ConnectorProgress with new fields
# ============================================================================


class TestConnectorProgressExtended:
    """Extended tests for ConnectorProgress with new fields."""

    def test_new_fields_defaults(self):
        """Test that new fields have correct defaults."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="binance_trx",
            account_name="Test Account",
        )
        
        assert progress.current_operation is None
        assert progress.operation_progress == 0
        assert progress.operation_total == 0
        assert progress.pipeline_stage is None
        assert progress.logs == []
        assert progress.stage_stats is not None

    def test_add_log(self):
        """Test adding log entries."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="binance_trx",
            account_name="Test Account",
        )
        
        progress.add_log("INFO", "Starting fetch")
        progress.add_log("INFO", "Fetching BTC/USDT")
        progress.add_log("ERROR", "API error")
        
        assert len(progress.logs) == 3
        assert progress.logs[0].level == "INFO"
        assert progress.logs[0].message == "Starting fetch"
        assert progress.logs[2].level == "ERROR"

    def test_add_log_max_entries(self):
        """Test that logs are trimmed to max_logs."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="test",
            account_name="Test",
        )
        
        # Add more than max_logs entries
        for i in range(150):
            progress.add_log("INFO", f"Message {i}", max_logs=100)
        
        # Should only keep last 100
        assert len(progress.logs) == 100
        # First entry should be message 50 (150 - 100)
        assert progress.logs[0].message == "Message 50"
        # Last entry should be message 149
        assert progress.logs[-1].message == "Message 149"

    def test_to_dict_with_new_fields(self):
        """Test serialization includes new fields."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="binance_trx",
            account_name="Test",
            current_operation="Fetching BTC/USDT",
            operation_progress=50,
            operation_total=100,
            pipeline_stage=PipelineStage.FETCH,
        )
        progress.add_log("INFO", "Test log")
        
        result = progress.to_dict()
        
        assert result["current_operation"] == "Fetching BTC/USDT"
        assert result["operation_progress"] == 50
        assert result["operation_total"] == 100
        assert result["pipeline_stage"] == "fetch"
        assert "logs" in result
        assert len(result["logs"]) == 1
        assert "stage_stats" in result

    def test_stage_stats_initialization(self):
        """Test that stage_stats are initialized for all stages."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="test",
            account_name="Test",
        )
        
        # All stages should be initialized
        for stage in PipelineStage:
            assert stage.value in progress.stage_stats
            assert isinstance(progress.stage_stats[stage.value], StageStats)


# ============================================================================
# Test Error Count Tracking
# ============================================================================


class TestConnectorProgressErrorCount:
    """Tests for error_count tracking in ConnectorProgress."""

    def test_error_count_default_value(self):
        """Test error_count defaults to 0."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="binance-transactions",
            account_name="My Binance",
        )
        
        assert progress.error_count == 0

    def test_error_count_in_to_dict(self):
        """Test error_count is included in to_dict output."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="etherscan",
            account_name="ETH Wallet",
            error_count=5,
        )
        
        result = progress.to_dict()
        
        assert "error_count" in result
        assert result["error_count"] == 5

    def test_error_count_increment(self):
        """Test incrementing error_count."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="kraken",
            account_name="Kraken Main",
        )
        
        # Simulate error counting
        progress.error_count += 1
        assert progress.error_count == 1
        
        progress.error_count += 3
        assert progress.error_count == 4

    def test_error_count_with_error_string(self):
        """Test error_count can be used alongside error string."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="coinbase",
            account_name="Coinbase",
            error="Last error message",
            error_count=10,
        )
        
        result = progress.to_dict()
        
        assert result["error"] == "Last error message"
        assert result["error_count"] == 10


# ============================================================================
# Test Service Cleanup Initialization
# ============================================================================


class TestSyncJobServiceCleanup:
    """Tests for SyncJobService cleanup functionality."""

    def test_cleanup_called_on_init(self):
        """Test that cleanup is called during service initialization."""
        with patch('backend.services.sync_job_service.get_engine') as mock_get_engine, \
             patch('backend.services.sync_job_service.Session') as mock_session_class, \
             patch('backend.services.sync_job_service.SyncJobRepository') as mock_repo_class, \
             patch('backend.services.sync_job_service.load_settings') as mock_settings, \
             patch('backend.services.sync_job_service.configure_logging') as mock_logging:
            
            # Setup mocks
            mock_settings.return_value = {}
            mock_logging.return_value = MagicMock()
            mock_engine = MagicMock()
            mock_get_engine.return_value = mock_engine
            mock_session = MagicMock()
            mock_session_class.return_value.__enter__ = MagicMock(return_value=mock_session)
            mock_session_class.return_value.__exit__ = MagicMock(return_value=False)
            mock_repo = MagicMock()
            mock_repo.cleanup_orphaned_jobs.return_value = {"jobs_aborted": 0, "connector_runs_failed": 0}
            mock_repo_class.return_value = mock_repo
            
            # Reset singleton for testing
            from backend.services.sync_job_service import SyncJobService
            SyncJobService._instance = None
            
            # Create instance (triggers __init__)
            service = SyncJobService()
            
            # Verify cleanup was called
            mock_repo.cleanup_orphaned_jobs.assert_called_once_with(stale_minutes=5)
            mock_session.commit.assert_called_once()
            
            # Clean up singleton
            SyncJobService._instance = None

    def test_heartbeat_interval_default(self):
        """Test heartbeat interval is set correctly."""
        with patch('backend.services.sync_job_service.get_engine') as mock_get_engine, \
             patch('backend.services.sync_job_service.Session') as mock_session_class, \
             patch('backend.services.sync_job_service.SyncJobRepository') as mock_repo_class, \
             patch('backend.services.sync_job_service.load_settings') as mock_settings, \
             patch('backend.services.sync_job_service.configure_logging') as mock_logging:
            
            # Setup mocks
            mock_settings.return_value = {}
            mock_logging.return_value = MagicMock()
            mock_engine = MagicMock()
            mock_get_engine.return_value = mock_engine
            mock_session = MagicMock()
            mock_session_class.return_value.__enter__ = MagicMock(return_value=mock_session)
            mock_session_class.return_value.__exit__ = MagicMock(return_value=False)
            mock_repo = MagicMock()
            mock_repo.cleanup_orphaned_jobs.return_value = {"jobs_aborted": 0, "connector_runs_failed": 0}
            mock_repo_class.return_value = mock_repo
            
            # Reset singleton
            from backend.services.sync_job_service import SyncJobService
            SyncJobService._instance = None
            
            service = SyncJobService()
            
            # Verify heartbeat interval
            assert service._heartbeat_interval_seconds == 30
            assert service._last_heartbeat_time is None
            
            # Clean up
            SyncJobService._instance = None