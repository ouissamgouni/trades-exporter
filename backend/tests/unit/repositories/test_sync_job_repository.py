"""
Unit tests for SyncJobRepository.
"""

import pytest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from sqlmodel import Session

from backend.db.models import (
    SyncJob,
    SyncJobConnectorRun,
    SyncJobStatus,
    SyncJobConnectorStatus,
    NormalizedTransaction,
)
from backend.db.repositories import SyncJobRepository


# ============================================================================
# Test Fixtures
# ============================================================================


@pytest.fixture
def mock_session():
    """Create a mock session."""
    return MagicMock(spec=Session)


@pytest.fixture
def sample_job():
    """Create a sample sync job."""
    return SyncJob(
        id=1,
        status=SyncJobStatus.RUNNING,
        started_at=datetime(2024, 1, 15, 10, 0, 0, tzinfo=timezone.utc),
        finished_at=None,
        total_connectors=3,
        total_processed=0,
        total_new=0,
        total_updated=0,
        total_skipped=0,
        total_errors=0,
        config_snapshot={"use_database_connectors": True},
    )


@pytest.fixture
def sample_connector_run():
    """Create a sample connector run."""
    return SyncJobConnectorRun(
        id=1,
        job_id=1,
        connector_id=10,
        status=SyncJobConnectorStatus.QUEUED,
        test_mode=False,
        started_at=None,
        finished_at=None,
        processed=0,  # Model uses 'processed' not 'processed_count'
        synced_count=0,
        updated_count=0,
        skipped_count=0,
        error_count=0,
        synced_ids=[],
        updated_ids=[],
        skipped_ids=[],
        error_details=[],
        logs=[],
    )


@pytest.fixture
def repo(mock_session):
    """Create a repository instance."""
    return SyncJobRepository(mock_session)


# ============================================================================
# Test SyncJob CRUD
# ============================================================================


class TestSyncJobCRUD:
    """Tests for SyncJob CRUD operations."""

    def test_create_job(self, repo, mock_session):
        """Test creating a new sync job."""
        mock_session.refresh = MagicMock()

        # Call create_job
        with patch.object(repo, "create_job", wraps=repo.create_job):
            result = repo.create_job(config_snapshot={"test": True})

        mock_session.add.assert_called_once()
        mock_session.flush.assert_called_once()
        mock_session.refresh.assert_called_once()

        # Verify the job was created with correct initial values
        created_job = mock_session.add.call_args[0][0]
        assert created_job.status == SyncJobStatus.PENDING
        assert created_job.config_snapshot == {"test": True}
        assert created_job.total_connectors == 0

    def test_get_job(self, repo, mock_session, sample_job):
        """Test getting a job by ID."""
        mock_session.get.return_value = sample_job

        result = repo.get_job(1)

        mock_session.get.assert_called_once_with(SyncJob, 1)
        assert result == sample_job
        assert result.status == SyncJobStatus.RUNNING

    def test_get_job_not_found(self, repo, mock_session):
        """Test getting a non-existent job."""
        mock_session.get.return_value = None

        result = repo.get_job(999)

        assert result is None

    def test_update_job_status_to_running(self, repo, mock_session, sample_job):
        """Test updating job status to running."""
        sample_job.status = SyncJobStatus.IDLE
        mock_session.get.return_value = sample_job

        result = repo.update_job_status(1, SyncJobStatus.RUNNING)

        assert result.status == SyncJobStatus.RUNNING
        assert result.finished_at is None

    def test_update_job_status_to_completed(self, repo, mock_session, sample_job):
        """Test updating job status to completed sets finished_at."""
        mock_session.get.return_value = sample_job

        result = repo.update_job_status(1, SyncJobStatus.COMPLETED)

        assert result.status == SyncJobStatus.COMPLETED
        assert result.finished_at is not None

    def test_update_job_status_to_failed(self, repo, mock_session, sample_job):
        """Test updating job status to failed with error message."""
        mock_session.get.return_value = sample_job

        result = repo.update_job_status(
            1, SyncJobStatus.FAILED, error_message="Connection timeout"
        )

        assert result.status == SyncJobStatus.FAILED
        assert result.error_message == "Connection timeout"
        assert result.finished_at is not None

    def test_update_job_totals(self, repo, mock_session, sample_job):
        """Test updating job aggregate statistics."""
        mock_session.get.return_value = sample_job

        result = repo.update_job_totals(
            1,
            total_connectors=3,
            total_processed=100,
            total_new=50,
            total_updated=10,
            total_skipped=40,
            total_errors=5,
        )

        assert result.total_connectors == 3
        assert result.total_processed == 100
        assert result.total_new == 50
        assert result.total_updated == 10
        assert result.total_skipped == 40
        assert result.total_errors == 5


# ============================================================================
# Test SyncJobConnectorRun CRUD
# ============================================================================


class TestSyncJobConnectorRunCRUD:
    """Tests for SyncJobConnectorRun CRUD operations."""

    def test_create_connector_run(self, repo, mock_session):
        """Test creating a new connector run."""
        mock_session.refresh = MagicMock()

        result = repo.create_connector_run(job_id=1, connector_id=10, test_mode=True)

        mock_session.add.assert_called_once()
        mock_session.flush.assert_called_once()

        # Verify the run was created with correct initial values
        created_run = mock_session.add.call_args[0][0]
        assert created_run.job_id == 1
        assert created_run.connector_id == 10
        assert created_run.status == SyncJobConnectorStatus.QUEUED
        assert created_run.test_mode is True
        assert (
            created_run.processed == 0
        )  # Model uses 'processed' not 'processed_count'

    def test_get_connector_run(self, repo, mock_session, sample_connector_run):
        """Test getting a connector run by ID."""
        mock_session.get.return_value = sample_connector_run

        result = repo.get_connector_run(1)

        mock_session.get.assert_called_once_with(SyncJobConnectorRun, 1)
        assert result == sample_connector_run

    def test_update_connector_run_status_to_running(
        self, repo, mock_session, sample_connector_run
    ):
        """Test updating connector run status to running sets started_at."""
        mock_session.get.return_value = sample_connector_run

        result = repo.update_connector_run_status(1, SyncJobConnectorStatus.RUNNING)

        assert result.status == SyncJobConnectorStatus.RUNNING
        assert result.started_at is not None

    def test_update_connector_run_status_to_completed(
        self, repo, mock_session, sample_connector_run
    ):
        """Test updating connector run status to completed sets finished_at."""
        sample_connector_run.status = SyncJobConnectorStatus.RUNNING
        mock_session.get.return_value = sample_connector_run

        result = repo.update_connector_run_status(1, SyncJobConnectorStatus.COMPLETED)

        assert result.status == SyncJobConnectorStatus.COMPLETED
        assert result.finished_at is not None

    def test_update_connector_run_metrics(
        self, repo, mock_session, sample_connector_run
    ):
        """Test updating connector run metrics."""
        mock_session.get.return_value = sample_connector_run

        result = repo.update_connector_run_metrics(
            1,
            processed=100,  # Model uses 'processed' not 'processed_count'
            synced_count=50,
            updated_count=10,
            skipped_count=35,
            error_count=5,
        )

        assert result.processed == 100
        assert result.synced_count == 50
        assert result.updated_count == 10
        assert result.skipped_count == 35
        assert result.error_count == 5

    def test_update_connector_run_outcomes(
        self, repo, mock_session, sample_connector_run
    ):
        """Test updating connector run outcome tracking."""
        mock_session.get.return_value = sample_connector_run

        result = repo.update_connector_run_outcomes(
            1,
            synced_ids=["tx1", "tx2", "tx3"],
            updated_ids=["tx4"],
            skipped_ids=["tx5", "tx6"],
            error_details=[{"source_transaction_id": "tx7", "error": "Invalid data"}],
        )

        assert result.synced_ids == ["tx1", "tx2", "tx3"]
        assert result.updated_ids == ["tx4"]
        assert result.skipped_ids == ["tx5", "tx6"]
        assert len(result.error_details) == 1
        assert result.error_details[0]["error"] == "Invalid data"

    def test_append_connector_run_log(self, repo, mock_session, sample_connector_run):
        """Test appending log entries to a connector run."""
        mock_session.get.return_value = sample_connector_run

        result = repo.append_connector_run_log(
            1, level="INFO", message="Starting sync..."
        )

        assert len(result.logs) == 1
        assert result.logs[0]["level"] == "INFO"
        assert result.logs[0]["message"] == "Starting sync..."
        assert "timestamp" in result.logs[0]

    def test_complete_connector_run(self, repo, mock_session, sample_connector_run):
        """Test completing a connector run with all final data."""
        mock_session.get.return_value = sample_connector_run

        result = repo.complete_connector_run(
            run_id=1,
            processed=100,  # Model uses 'processed' not 'processed_count'
            synced_count=50,
            updated_count=10,
            skipped_count=35,
            error_count=5,
            synced_ids=["tx1", "tx2"],
            updated_ids=["tx3"],
            skipped_ids=["tx4", "tx5"],
            error_details=[],
        )

        assert result.status == SyncJobConnectorStatus.COMPLETED
        assert result.finished_at is not None
        assert result.processed == 100
        assert result.synced_count == 50
        assert result.synced_ids == ["tx1", "tx2"]


# ============================================================================
# Test Data Model Properties
# ============================================================================


class TestSyncJobModel:
    """Tests for SyncJob model."""

    def test_sync_job_default_values(self):
        """Test SyncJob default values."""
        job = SyncJob()

        # Model defaults to "running" string (not enum member)
        assert job.status == "running"
        assert job.total_connectors == 0
        assert job.total_processed == 0
        assert job.total_new == 0
        assert job.config_snapshot is None  # None by default, not {}

    def test_sync_job_status_enum(self):
        """Test SyncJobStatus enum values."""
        assert SyncJobStatus.IDLE.value == "idle"
        assert SyncJobStatus.RUNNING.value == "running"
        assert SyncJobStatus.COMPLETED.value == "completed"
        assert SyncJobStatus.ABORTED.value == "aborted"
        assert SyncJobStatus.FAILED.value == "failed"


class TestSyncJobConnectorRunModel:
    """Tests for SyncJobConnectorRun model."""

    def test_connector_run_default_values(self):
        """Test SyncJobConnectorRun default values."""
        run = SyncJobConnectorRun(job_id=1, connector_id=10)

        # Model defaults to "queued" string (not enum member)
        assert run.status == "queued"
        assert run.test_mode is False
        # Model uses 'processed' not 'processed_count'
        assert run.processed == 0
        assert run.synced_ids is None  # None by default, not []
        assert run.logs is None  # None by default, not []

    def test_connector_run_status_enum(self):
        """Test SyncJobConnectorStatus enum values."""
        assert SyncJobConnectorStatus.QUEUED.value == "queued"
        assert SyncJobConnectorStatus.RUNNING.value == "running"
        assert SyncJobConnectorStatus.COMPLETED.value == "completed"
        assert SyncJobConnectorStatus.FAILED.value == "failed"
        assert SyncJobConnectorStatus.SKIPPED.value == "skipped"


# ============================================================================
# Test Heartbeat and Cleanup
# ============================================================================


class TestHeartbeatAndCleanup:
    """Tests for heartbeat and orphaned job cleanup functionality."""

    def test_update_heartbeat(self, repo, mock_session, sample_job):
        """Test updating heartbeat timestamp."""
        sample_job.last_heartbeat = None
        mock_session.get.return_value = sample_job

        result = repo.update_heartbeat(1)

        assert result is not None
        assert result.last_heartbeat is not None
        mock_session.add.assert_called()
        mock_session.flush.assert_called()

    def test_update_heartbeat_not_found(self, repo, mock_session):
        """Test updating heartbeat for non-existent job."""
        mock_session.get.return_value = None

        result = repo.update_heartbeat(999)

        assert result is None

    def test_cleanup_orphaned_jobs_no_stale_jobs(self, repo, mock_session):
        """Test cleanup when no stale jobs exist."""
        mock_exec = MagicMock()
        mock_exec.all.return_value = []
        mock_session.exec.return_value = mock_exec

        result = repo.cleanup_orphaned_jobs(stale_minutes=5)

        assert result["jobs_aborted"] == 0
        assert result["connector_runs_failed"] == 0

    def test_cleanup_orphaned_jobs_with_stale_job(self, repo, mock_session):
        """Test cleanup marks stale running jobs as aborted."""
        from datetime import timedelta

        # Create a stale job (heartbeat > 5 min ago)
        stale_job = SyncJob(
            id=1,
            status=SyncJobStatus.RUNNING,
            started_at=datetime.now(timezone.utc) - timedelta(hours=1),
            last_heartbeat=datetime.now(timezone.utc) - timedelta(minutes=10),
        )

        # Create a stale connector run
        stale_run = SyncJobConnectorRun(
            id=1,
            job_id=1,
            connector_id=10,
            status=SyncJobConnectorStatus.RUNNING,
        )

        # Mock the queries
        mock_exec_jobs = MagicMock()
        mock_exec_jobs.all.return_value = [stale_job]

        mock_exec_runs = MagicMock()
        mock_exec_runs.all.return_value = [stale_run]

        # Return different results for the two exec calls
        mock_session.exec.side_effect = [mock_exec_jobs, mock_exec_runs]

        result = repo.cleanup_orphaned_jobs(stale_minutes=5)

        assert result["jobs_aborted"] == 1
        assert result["connector_runs_failed"] == 1
        assert stale_job.status == SyncJobStatus.ABORTED
        assert stale_job.finished_at is not None
        assert "Server restarted unexpectedly" in stale_job.error_message
        assert stale_run.status == SyncJobConnectorStatus.FAILED

    def test_cleanup_orphaned_jobs_null_heartbeat(self, repo, mock_session):
        """Test cleanup marks jobs with NULL heartbeat as stale."""
        # Job with NULL heartbeat (legacy or never set)
        stale_job = SyncJob(
            id=2,
            status=SyncJobStatus.RUNNING,
            started_at=datetime.now(timezone.utc),
            last_heartbeat=None,  # NULL heartbeat
        )

        mock_exec_jobs = MagicMock()
        mock_exec_jobs.all.return_value = [stale_job]

        mock_exec_runs = MagicMock()
        mock_exec_runs.all.return_value = []

        mock_session.exec.side_effect = [mock_exec_jobs, mock_exec_runs]

        result = repo.cleanup_orphaned_jobs(stale_minutes=5)

        assert result["jobs_aborted"] == 1
        assert result["connector_runs_failed"] == 0
        assert stale_job.status == SyncJobStatus.ABORTED
        assert result["job_ids"] == [2]

    def test_cleanup_orphaned_jobs_queued_runs_also_marked(self, repo, mock_session):
        """Test that queued connector runs are also marked as failed."""
        from datetime import timedelta

        stale_job = SyncJob(
            id=3,
            status=SyncJobStatus.RUNNING,
            last_heartbeat=datetime.now(timezone.utc) - timedelta(minutes=10),
        )

        # One running, one queued connector run
        running_run = SyncJobConnectorRun(
            id=1, job_id=3, connector_id=10, status=SyncJobConnectorStatus.RUNNING
        )
        queued_run = SyncJobConnectorRun(
            id=2, job_id=3, connector_id=11, status=SyncJobConnectorStatus.QUEUED
        )

        mock_exec_jobs = MagicMock()
        mock_exec_jobs.all.return_value = [stale_job]

        mock_exec_runs = MagicMock()
        mock_exec_runs.all.return_value = [running_run, queued_run]

        mock_session.exec.side_effect = [mock_exec_jobs, mock_exec_runs]

        result = repo.cleanup_orphaned_jobs(stale_minutes=5)

        assert result["jobs_aborted"] == 1
        assert result["connector_runs_failed"] == 2
        assert running_run.status == SyncJobConnectorStatus.FAILED
        assert queued_run.status == SyncJobConnectorStatus.FAILED
