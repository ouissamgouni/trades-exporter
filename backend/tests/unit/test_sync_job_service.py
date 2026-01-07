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
