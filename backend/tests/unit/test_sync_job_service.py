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
# Test Outcome Tracking (synced_ids, updated_ids, etc.)
# ============================================================================


class TestConnectorProgressOutcomeTracking:
    """Tests for outcome tracking fields in ConnectorProgress."""

    def test_outcome_fields_default_to_empty_lists(self):
        """Test that outcome tracking fields default to empty lists."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="binance-transactions",
            account_name="My Binance",
        )
        
        assert progress.synced_ids == []
        assert progress.updated_ids == []
        assert progress.skipped_ids == []
        assert progress.error_details == []

    def test_append_synced_ids(self):
        """Test appending to synced_ids list."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="binance-transactions",
            account_name="Test",
        )
        
        progress.synced_ids.append("tx_001")
        progress.synced_ids.append("tx_002")
        progress.synced_ids.extend(["tx_003", "tx_004"])
        
        assert len(progress.synced_ids) == 4
        assert progress.synced_ids == ["tx_001", "tx_002", "tx_003", "tx_004"]

    def test_append_updated_ids(self):
        """Test appending to updated_ids list."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="etherscan",
            account_name="ETH Wallet",
        )
        
        progress.updated_ids.extend(["upd_1", "upd_2"])
        
        assert len(progress.updated_ids) == 2
        assert "upd_1" in progress.updated_ids

    def test_append_error_details(self):
        """Test appending error details with structured data."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="kraken",
            account_name="Kraken",
        )
        
        progress.error_details.append({
            "source_transaction_id": "tx_err_1",
            "error": "Invalid amount"
        })
        progress.error_details.append({
            "source_transaction_id": "tx_err_2", 
            "error": "Missing asset"
        })
        
        assert len(progress.error_details) == 2
        assert progress.error_details[0]["source_transaction_id"] == "tx_err_1"
        assert progress.error_details[1]["error"] == "Missing asset"

    def test_to_dict_includes_outcome_fields(self):
        """Test that to_dict serializes outcome tracking fields."""
        progress = ConnectorProgress(
            connector_id=42,
            connector_type="coinbase",
            account_name="Coinbase Main",
        )
        progress.synced_ids = ["sync_1", "sync_2"]
        progress.updated_ids = ["upd_1"]
        progress.skipped_ids = ["skip_1", "skip_2", "skip_3"]
        progress.error_details = [{"source_transaction_id": "err_1", "error": "fail"}]
        
        result = progress.to_dict()
        
        assert "synced_ids" in result
        assert result["synced_ids"] == ["sync_1", "sync_2"]
        assert "updated_ids" in result
        assert result["updated_ids"] == ["upd_1"]
        assert "skipped_ids" in result
        assert len(result["skipped_ids"]) == 3
        assert "error_details" in result
        assert len(result["error_details"]) == 1

    def test_outcome_fields_independent_per_instance(self):
        """Test that outcome lists are independent between instances."""
        progress1 = ConnectorProgress(
            connector_id=1,
            connector_type="binance",
            account_name="Binance 1",
        )
        progress2 = ConnectorProgress(
            connector_id=2,
            connector_type="kraken",
            account_name="Kraken 1",
        )
        
        progress1.synced_ids.append("tx_from_1")
        progress2.synced_ids.append("tx_from_2")
        
        # Each instance should have its own list
        assert progress1.synced_ids == ["tx_from_1"]
        assert progress2.synced_ids == ["tx_from_2"]


# ============================================================================
# Test Progress Callback Integration
# ============================================================================


class TestProgressCallbackIntegration:
    """Tests for progress callback updating ConnectorProgress."""

    def test_progress_callback_updates_current_operation(self):
        """Test that progress callback updates current_operation field."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="mexc-deposits",
            account_name="MEXC Main",
        )
        
        # Simulate what the callback does
        progress.current_operation = "Fetching BTC"
        progress.operation_progress = 5
        progress.operation_total = 100
        
        assert progress.current_operation == "Fetching BTC"
        assert progress.operation_progress == 5
        assert progress.operation_total == 100

    def test_progress_callback_adds_log_message(self):
        """Test that progress callback adds log messages."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="binance-transactions",
            account_name="Binance",
        )
        
        # Simulate callback behavior with log message
        progress.current_operation = "Fetching ETH/USDT"
        progress.add_log("INFO", "Found 50 transactions for ETH/USDT")
        
        assert len(progress.logs) == 1
        assert progress.logs[0].level == "INFO"
        assert "50 transactions" in progress.logs[0].message

    def test_progress_callback_pattern_in_job_progress(self):
        """Test the callback pattern with JobProgress.connector_statuses."""
        job_progress = JobProgress()
        
        # Setup connector statuses like sync_job_service does
        job_progress.connector_statuses[1] = ConnectorProgress(
            connector_id=1,
            connector_type="mexc-withdrawals",
            account_name="MEXC",
        )
        job_progress.connector_statuses[2] = ConnectorProgress(
            connector_id=2,
            connector_type="etherscan",
            account_name="ETH Wallet",
        )
        
        # Simulate progress callback updating connector 1
        def mock_progress_callback(connector_id, operation, current, total, log_message=None):
            if connector_id in job_progress.connector_statuses:
                cstatus = job_progress.connector_statuses[connector_id]
                cstatus.current_operation = operation
                cstatus.operation_progress = current
                cstatus.operation_total = total
                if log_message:
                    cstatus.add_log("INFO", log_message)
        
        # Call callback for connector 1
        mock_progress_callback(1, "Fetching USDT", 10, 50, "Processing USDT withdrawals")
        
        # Verify only connector 1 was updated
        assert job_progress.connector_statuses[1].current_operation == "Fetching USDT"
        assert job_progress.connector_statuses[1].operation_progress == 10
        assert job_progress.connector_statuses[1].operation_total == 50
        assert len(job_progress.connector_statuses[1].logs) == 1
        
        # Connector 2 should be unchanged
        assert job_progress.connector_statuses[2].current_operation is None
        assert job_progress.connector_statuses[2].operation_progress == 0
        assert len(job_progress.connector_statuses[2].logs) == 0

    def test_progress_callback_handles_unknown_connector_id(self):
        """Test that callback handles unknown connector IDs gracefully."""
        job_progress = JobProgress()
        job_progress.connector_statuses[1] = ConnectorProgress(
            connector_id=1,
            connector_type="binance",
            account_name="Binance",
        )
        
        def mock_progress_callback(connector_id, operation, current, total, log_message=None):
            if connector_id in job_progress.connector_statuses:
                cstatus = job_progress.connector_statuses[connector_id]
                cstatus.current_operation = operation
        
        # Call with unknown connector_id - should not raise
        mock_progress_callback(999, "Unknown Operation", 0, 0)
        
        # Original connector should be unchanged
        assert job_progress.connector_statuses[1].current_operation is None

    def test_progress_callback_multiple_updates(self):
        """Test multiple progress updates accumulate correctly."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="mexc-deposits",
            account_name="MEXC",
        )
        
        # Simulate multiple callback updates (like iterating through currencies)
        updates = [
            ("Fetching BTC", 1, 10, "Started BTC"),
            ("Fetching ETH", 2, 10, "Started ETH"),
            ("Fetching USDT", 3, 10, "Started USDT"),
        ]
        
        for operation, current, total, log_msg in updates:
            progress.current_operation = operation
            progress.operation_progress = current
            progress.operation_total = total
            progress.add_log("INFO", log_msg)
        
        # Should have latest operation state
        assert progress.current_operation == "Fetching USDT"
        assert progress.operation_progress == 3
        assert progress.operation_total == 10
        
        # Should have all log messages
        assert len(progress.logs) == 3
        assert progress.logs[0].message == "Started BTC"
        assert progress.logs[2].message == "Started USDT"

    def test_to_dict_includes_progress_callback_fields(self):
        """Test to_dict includes all progress callback related fields."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="kraken",
            account_name="Kraken Main",
        )
        progress.current_operation = "Fetching trades"
        progress.operation_progress = 25
        progress.operation_total = 100
        progress.add_log("INFO", "Progress update")
        
        result = progress.to_dict()
        
        assert result["current_operation"] == "Fetching trades"
        assert result["operation_progress"] == 25
        assert result["operation_total"] == 100
        assert "logs" in result
        assert len(result["logs"]) == 1


# ============================================================================
# Test Progress Callback with Metrics
# ============================================================================


class TestProgressCallbackMetrics:
    """Tests for the progress callback supporting real-time metrics updates."""

    def test_progress_callback_updates_metrics(self):
        """Test that progress callback updates new_count, updated_count, skipped_count."""
        # Create a ConnectorProgress instance
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="mexc-withdrawals",
            account_name="MEXC Main",
            status=ConnectorSyncStatus.RUNNING,
        )
        
        # Simulate a progress dict like in sync_job_service
        connector_statuses = {1: progress}
        
        # Simulate the callback function logic
        def connector_progress_callback(
            connector_id: int,
            operation: str,
            current: int,
            total: int,
            log_message=None,
            new_count=None,
            updated_count=None,
            skipped_count=None,
        ):
            if connector_id in connector_statuses:
                cstatus = connector_statuses[connector_id]
                cstatus.current_operation = operation
                cstatus.operation_progress = current
                cstatus.operation_total = total
                if new_count is not None:
                    cstatus.new_count = new_count
                if updated_count is not None:
                    cstatus.updated_count = updated_count
                if skipped_count is not None:
                    cstatus.skipped_count = skipped_count
                if log_message:
                    cstatus.add_log("INFO", log_message)
        
        # Call callback without metrics (just operation update)
        connector_progress_callback(
            connector_id=1,
            operation="[5/100] Fetching BTC",
            current=5,
            total=100,
        )
        
        assert progress.current_operation == "[5/100] Fetching BTC"
        assert progress.operation_progress == 5
        assert progress.operation_total == 100
        assert progress.new_count == 0  # Not updated
        assert progress.updated_count == 0  # Not updated
        assert progress.skipped_count == 0  # Not updated
        
        # Call callback with metrics (real-time update after pipeline processing)
        connector_progress_callback(
            connector_id=1,
            operation="Processing item 10",
            current=10,
            total=100,
            new_count=8,
            updated_count=1,
            skipped_count=1,
        )
        
        assert progress.current_operation == "Processing item 10"
        assert progress.operation_progress == 10
        assert progress.new_count == 8
        assert progress.updated_count == 1
        assert progress.skipped_count == 1

    def test_progress_callback_incremental_metrics(self):
        """Test that metrics can be updated incrementally via callback."""
        progress = ConnectorProgress(
            connector_id=42,
            connector_type="binance-transactions",
            account_name="Binance",
            status=ConnectorSyncStatus.RUNNING,
        )
        
        connector_statuses = {42: progress}
        
        def connector_progress_callback(
            connector_id: int,
            operation: str,
            current: int,
            total: int,
            log_message=None,
            new_count=None,
            updated_count=None,
            skipped_count=None,
        ):
            if connector_id in connector_statuses:
                cstatus = connector_statuses[connector_id]
                cstatus.current_operation = operation
                cstatus.operation_progress = current
                cstatus.operation_total = total
                if new_count is not None:
                    cstatus.new_count = new_count
                if updated_count is not None:
                    cstatus.updated_count = updated_count
                if skipped_count is not None:
                    cstatus.skipped_count = skipped_count
        
        # First item processed: 1 new
        connector_progress_callback(
            connector_id=42,
            operation="Processing item 1",
            current=1,
            total=50,
            new_count=1,
            updated_count=0,
            skipped_count=0,
        )
        assert progress.new_count == 1
        assert progress.updated_count == 0
        assert progress.skipped_count == 0
        
        # Second item: 1 more new (cumulative 2)
        connector_progress_callback(
            connector_id=42,
            operation="Processing item 2",
            current=2,
            total=50,
            new_count=2,
            updated_count=0,
            skipped_count=0,
        )
        assert progress.new_count == 2
        
        # Third item: 1 skipped (cumulative: 2 new, 1 skipped)
        connector_progress_callback(
            connector_id=42,
            operation="Processing item 3",
            current=3,
            total=50,
            new_count=2,
            updated_count=0,
            skipped_count=1,
        )
        assert progress.new_count == 2
        assert progress.skipped_count == 1
        
        # Fourth item: 1 updated (cumulative: 2 new, 1 updated, 1 skipped)
        connector_progress_callback(
            connector_id=42,
            operation="Processing item 4",
            current=4,
            total=50,
            new_count=2,
            updated_count=1,
            skipped_count=1,
        )
        assert progress.new_count == 2
        assert progress.updated_count == 1
        assert progress.skipped_count == 1

    def test_progress_callback_with_log_message(self):
        """Test that log messages are added via callback."""
        progress = ConnectorProgress(
            connector_id=5,
            connector_type="etherscan",
            account_name="ETH Wallet",
            status=ConnectorSyncStatus.RUNNING,
        )
        
        connector_statuses = {5: progress}
        
        def connector_progress_callback(
            connector_id: int,
            operation: str,
            current: int,
            total: int,
            log_message=None,
            new_count=None,
            updated_count=None,
            skipped_count=None,
        ):
            if connector_id in connector_statuses:
                cstatus = connector_statuses[connector_id]
                cstatus.current_operation = operation
                cstatus.operation_progress = current
                cstatus.operation_total = total
                if new_count is not None:
                    cstatus.new_count = new_count
                if updated_count is not None:
                    cstatus.updated_count = updated_count
                if skipped_count is not None:
                    cstatus.skipped_count = skipped_count
                if log_message:
                    cstatus.add_log("INFO", log_message)
        
        # Call with log message
        connector_progress_callback(
            connector_id=5,
            operation="[10/50] Fetching ETH",
            current=10,
            total=50,
            log_message="[10/50] Fetched 5 transactions for ETH",
        )
        
        assert len(progress.logs) == 1
        assert progress.logs[0].level == "INFO"
        assert "Fetched 5 transactions for ETH" in progress.logs[0].message

    def test_progress_callback_unknown_connector_id(self):
        """Test that callback handles unknown connector_id gracefully."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="test",
            account_name="Test",
            status=ConnectorSyncStatus.RUNNING,
        )
        
        connector_statuses = {1: progress}
        warning_logged = []
        
        def connector_progress_callback(
            connector_id: int,
            operation: str,
            current: int,
            total: int,
            log_message=None,
            new_count=None,
            updated_count=None,
            skipped_count=None,
        ):
            if connector_id in connector_statuses:
                cstatus = connector_statuses[connector_id]
                cstatus.current_operation = operation
            else:
                warning_logged.append(f"connector_id={connector_id} not found")
        
        # Call with unknown connector_id
        connector_progress_callback(
            connector_id=999,
            operation="Processing",
            current=1,
            total=10,
            new_count=1,
        )
        
        # Original progress should be unchanged
        assert progress.current_operation is None
        assert progress.new_count == 0
        
        # Warning should have been logged
        assert len(warning_logged) == 1
        assert "999" in warning_logged[0]

    def test_metrics_serialized_in_to_dict(self):
        """Test that metrics are included in to_dict output."""
        progress = ConnectorProgress(
            connector_id=1,
            connector_type="mexc-deposits",
            account_name="MEXC",
            status=ConnectorSyncStatus.RUNNING,
            new_count=15,
            updated_count=3,
            skipped_count=7,
            current_operation="[50/100] Processing",
            operation_progress=50,
            operation_total=100,
        )
        
        result = progress.to_dict()
        
        assert result["new_count"] == 15
        assert result["updated_count"] == 3
        assert result["skipped_count"] == 7
        assert result["current_operation"] == "[50/100] Processing"
        assert result["operation_progress"] == 50
        assert result["operation_total"] == 100