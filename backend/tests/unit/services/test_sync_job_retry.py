"""
Unit tests for the retry_connector feature in SyncJobService.

Tests cover:
- Validation: connector existence, retryable status, duplicate retry guard
- Progress reset: old stats subtracted, fields zeroed, status set to QUEUED
- DB record creation: new SyncJobConnectorRun under the same job
- Worker coordination: _active_worker_count incremented, thread spawned
- _finalize_connector helper: RUNNING → COMPLETED/WARNING transitions
- _determine_and_set_job_status helper: job-level status from connector states
- _decrement_active_workers: thread-safe counter and last-worker detection
- API route: POST /sync-job/retry/{connector_id} returns correct responses
"""
import pytest
import threading
from datetime import datetime
from unittest.mock import Mock, MagicMock, patch, PropertyMock

from backend.services.sync_job_service import (
    SyncJobService,
    ConnectorProgress,
    ConnectorSyncStatus,
    JobProgress,
    JobStatus,
    PipelineStage,
    StageStats,
)


# ─── Fixtures ───────────────────────────────────────────────────────────


@pytest.fixture
def service():
    """Create a SyncJobService with fresh progress and worker coordination."""
    svc = SyncJobService()
    svc.progress = JobProgress()
    svc.progress.job_id = 42
    svc._run_job_db_connector_runs = {}
    svc._active_worker_count = 0
    svc._retry_threads = {}
    return svc


def _make_connector_progress(
    connector_id: int = 1,
    status: ConnectorSyncStatus = ConnectorSyncStatus.FAILED,
    *,
    processed: int = 100,
    new_count: int = 50,
    updated_count: int = 10,
    skipped_count: int = 30,
    error_count: int = 5,
    connector_type: str = "binance-transactions",
    account_name: str = "Binance Main",
) -> ConnectorProgress:
    cp = ConnectorProgress(
        connector_id=connector_id,
        connector_type=connector_type,
        account_name=account_name,
        status=status,
        processed=processed,
        new_count=new_count,
        updated_count=updated_count,
        skipped_count=skipped_count,
        error_count=error_count,
    )
    cp.started_at = datetime(2024, 1, 1, 12, 0)
    cp.finished_at = datetime(2024, 1, 1, 12, 5)
    cp.error = "API rate limited" if error_count > 0 else None
    cp.logs = []
    cp.synced_ids = [1, 2, 3]
    cp.updated_ids = [4]
    cp.skipped_ids = [5, 6]
    cp.error_details = [{"id": 7, "error": "bad data"}] if error_count > 0 else []
    cp.stage_stats = {stage.value: StageStats() for stage in PipelineStage}
    return cp


# ─── Validation Tests ───────────────────────────────────────────────────


class TestRetryConnectorValidation:
    """Tests for retry_connector input validation."""

    def test_raises_if_connector_not_in_job(self, service):
        with pytest.raises(ValueError, match="not found"):
            service.retry_connector(999)

    def test_raises_if_connector_is_running(self, service):
        service.progress.connector_statuses[1] = _make_connector_progress(
            status=ConnectorSyncStatus.RUNNING
        )
        with pytest.raises(ValueError, match="only 'failed' or 'warning'"):
            service.retry_connector(1)

    def test_raises_if_connector_is_completed(self, service):
        service.progress.connector_statuses[1] = _make_connector_progress(
            status=ConnectorSyncStatus.COMPLETED
        )
        with pytest.raises(ValueError, match="only 'failed' or 'warning'"):
            service.retry_connector(1)

    def test_raises_if_connector_is_queued(self, service):
        service.progress.connector_statuses[1] = _make_connector_progress(
            status=ConnectorSyncStatus.QUEUED
        )
        with pytest.raises(ValueError, match="only 'failed' or 'warning'"):
            service.retry_connector(1)

    def test_raises_if_no_job_id(self, service):
        service.progress.connector_statuses[1] = _make_connector_progress()
        service.progress.job_id = None
        with pytest.raises(ValueError, match="No job record"):
            service.retry_connector(1)

    def test_raises_if_retry_already_in_progress(self, service):
        service.progress.connector_statuses[1] = _make_connector_progress()
        alive_thread = Mock(spec=threading.Thread)
        alive_thread.is_alive.return_value = True
        service._retry_threads[1] = alive_thread
        with pytest.raises(RuntimeError, match="already in progress"):
            service.retry_connector(1)

    def test_cleans_dead_thread_and_allows_retry(self, service):
        """If the old thread is dead, it should be cleaned up and retry allowed."""
        service.progress.connector_statuses[1] = _make_connector_progress()
        dead_thread = Mock(spec=threading.Thread)
        dead_thread.is_alive.return_value = False
        service._retry_threads[1] = dead_thread

        # Patch DB interactions to avoid real DB calls
        with patch("backend.db.database.get_session") as mock_gs, \
             patch.object(service, "_run_single_connector"):
            mock_session = MagicMock()
            mock_gs.return_value.__enter__.return_value = mock_session
            mock_repo = MagicMock()
            mock_run = MagicMock()
            mock_run.id = 200
            mock_repo.create_connector_run.return_value = mock_run
            with patch("backend.db.repositories.sync_job_repository.SyncJobRepository", return_value=mock_repo):
                result = service.retry_connector(1)

        assert result["status"] == "retry_started"

    def test_allows_retry_for_failed_connector(self, service):
        service.progress.connector_statuses[1] = _make_connector_progress(
            status=ConnectorSyncStatus.FAILED
        )
        with patch("backend.db.database.get_session") as mock_gs, \
             patch.object(service, "_run_single_connector"):
            mock_session = MagicMock()
            mock_gs.return_value.__enter__.return_value = mock_session
            mock_repo = MagicMock()
            mock_run = MagicMock()
            mock_run.id = 200
            mock_repo.create_connector_run.return_value = mock_run
            with patch("backend.db.repositories.sync_job_repository.SyncJobRepository", return_value=mock_repo):
                result = service.retry_connector(1)
        assert result["status"] == "retry_started"

    def test_allows_retry_for_warning_connector(self, service):
        service.progress.connector_statuses[1] = _make_connector_progress(
            status=ConnectorSyncStatus.WARNING
        )
        with patch("backend.db.database.get_session") as mock_gs, \
             patch.object(service, "_run_single_connector"):
            mock_session = MagicMock()
            mock_gs.return_value.__enter__.return_value = mock_session
            mock_repo = MagicMock()
            mock_run = MagicMock()
            mock_run.id = 200
            mock_repo.create_connector_run.return_value = mock_run
            with patch("backend.db.repositories.sync_job_repository.SyncJobRepository", return_value=mock_repo):
                result = service.retry_connector(1)
        assert result["status"] == "retry_started"


# ─── Progress Reset Tests ────────────────────────────────────────────────


class TestRetryProgressReset:
    """Tests that retry_connector correctly resets connector progress."""

    @patch("backend.db.database.get_session")
    def test_subtracts_old_stats_from_job_aggregates(self, mock_gs, service):
        cp = _make_connector_progress(processed=100, new_count=50, updated_count=10, skipped_count=30)
        service.progress.connector_statuses[1] = cp
        service.progress.total_processed = 200
        service.progress.new_entries_added = 80
        service.progress.entries_updated = 20
        service.progress.duplicates_skipped = 50

        mock_session = MagicMock()
        mock_gs.return_value.__enter__.return_value = mock_session
        mock_repo = MagicMock()
        mock_run = MagicMock()
        mock_run.id = 300
        mock_repo.create_connector_run.return_value = mock_run

        with patch("backend.db.repositories.sync_job_repository.SyncJobRepository", return_value=mock_repo), \
             patch.object(service, "_run_single_connector"):
            service.retry_connector(1)

        assert service.progress.total_processed == 100  # 200 - 100
        assert service.progress.new_entries_added == 30  # 80 - 50
        assert service.progress.entries_updated == 10    # 20 - 10
        assert service.progress.duplicates_skipped == 20  # 50 - 30

    @patch("backend.db.database.get_session")
    def test_resets_connector_fields(self, mock_gs, service):
        cp = _make_connector_progress()
        service.progress.connector_statuses[1] = cp

        mock_session = MagicMock()
        mock_gs.return_value.__enter__.return_value = mock_session
        mock_repo = MagicMock()
        mock_run = MagicMock()
        mock_run.id = 300
        mock_repo.create_connector_run.return_value = mock_run

        with patch("backend.db.repositories.sync_job_repository.SyncJobRepository", return_value=mock_repo), \
             patch.object(service, "_run_single_connector"):
            service.retry_connector(1)

        assert cp.status == ConnectorSyncStatus.QUEUED
        assert cp.started_at is None
        assert cp.finished_at is None
        assert cp.processed == 0
        assert cp.new_count == 0
        assert cp.updated_count == 0
        assert cp.skipped_count == 0
        assert cp.error is None
        assert cp.error_count == 0
        assert cp.logs == []
        assert cp.synced_ids == []
        assert cp.updated_ids == []
        assert cp.skipped_ids == []
        assert cp.error_details == []

    @patch("backend.db.database.get_session")
    def test_sets_job_status_to_running_on_retry(self, mock_gs, service):
        """Job status should flip to RUNNING — work is happening."""
        service.progress.status = JobStatus.FAILED
        service.progress.finished_at = datetime.now()
        service.progress.connector_statuses[1] = _make_connector_progress()

        mock_session = MagicMock()
        mock_gs.return_value.__enter__.return_value = mock_session
        mock_repo = MagicMock()
        mock_run = MagicMock()
        mock_run.id = 300
        mock_repo.create_connector_run.return_value = mock_run

        with patch("backend.db.repositories.sync_job_repository.SyncJobRepository", return_value=mock_repo), \
             patch.object(service, "_run_single_connector"):
            service.retry_connector(1)

        assert service.progress.status == JobStatus.RUNNING
        assert service.progress.finished_at is None


# ─── Worker Coordination Tests ───────────────────────────────────────────


class TestWorkerCoordination:
    """Tests for _active_worker_count and _decrement_active_workers."""

    def test_decrement_returns_true_when_last_worker(self, service):
        service._active_worker_count = 1
        assert service._decrement_active_workers() is True
        assert service._active_worker_count == 0

    def test_decrement_returns_false_when_not_last(self, service):
        service._active_worker_count = 3
        assert service._decrement_active_workers() is False
        assert service._active_worker_count == 2

    @patch("backend.db.database.get_session")
    def test_retry_increments_worker_count(self, mock_gs, service):
        service.progress.connector_statuses[1] = _make_connector_progress()

        mock_session = MagicMock()
        mock_gs.return_value.__enter__.return_value = mock_session
        mock_repo = MagicMock()
        mock_run = MagicMock()
        mock_run.id = 300
        mock_repo.create_connector_run.return_value = mock_run

        with patch("backend.db.repositories.sync_job_repository.SyncJobRepository", return_value=mock_repo), \
             patch.object(service, "_run_single_connector"):
            service.retry_connector(1)

        assert service._active_worker_count == 1

    def test_thread_safety_of_decrement(self, service):
        """Verify _decrement_active_workers is thread-safe under contention."""
        service._active_worker_count = 100
        results = []

        def worker():
            results.append(service._decrement_active_workers())

        threads = [threading.Thread(target=worker) for _ in range(100)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert service._active_worker_count == 0
        assert sum(results) == 1  # Exactly one thread sees True (last worker)


# ─── _finalize_connector Tests ───────────────────────────────────────────


class TestFinalizeConnector:
    """Tests for the _finalize_connector shared helper."""

    @patch.object(SyncJobService, "_persist_connector_status")
    def test_running_no_errors_becomes_completed(self, mock_persist, service):
        cp = _make_connector_progress(status=ConnectorSyncStatus.RUNNING, error_count=0)
        service.progress.connector_statuses[1] = cp
        db_runs = {1: 101}
        mock_repo = MagicMock()

        service._finalize_connector(1, db_runs, mock_repo)

        assert cp.status == ConnectorSyncStatus.COMPLETED
        assert cp.finished_at is not None
        mock_persist.assert_called_once_with(1, "success")

    @patch.object(SyncJobService, "_persist_connector_status")
    def test_running_with_errors_becomes_warning(self, mock_persist, service):
        cp = _make_connector_progress(status=ConnectorSyncStatus.RUNNING, error_count=3)
        service.progress.connector_statuses[1] = cp
        db_runs = {1: 101}
        mock_repo = MagicMock()

        service._finalize_connector(1, db_runs, mock_repo)

        assert cp.status == ConnectorSyncStatus.WARNING
        assert cp.finished_at is not None
        mock_persist.assert_called_once_with(1, "warning")

    @patch.object(SyncJobService, "_persist_connector_status")
    def test_skips_non_running_connectors(self, mock_persist, service):
        cp = _make_connector_progress(status=ConnectorSyncStatus.COMPLETED)
        service.progress.connector_statuses[1] = cp
        original_finished = cp.finished_at

        service._finalize_connector(1, {}, MagicMock())

        assert cp.status == ConnectorSyncStatus.COMPLETED
        assert cp.finished_at == original_finished
        mock_persist.assert_not_called()

    @patch.object(SyncJobService, "_persist_connector_status")
    def test_skips_unknown_connector_id(self, mock_persist, service):
        service._finalize_connector(999, {}, MagicMock())
        mock_persist.assert_not_called()

    @patch.object(SyncJobService, "_persist_connector_status")
    def test_adds_to_connectors_completed_list(self, mock_persist, service):
        cp = _make_connector_progress(status=ConnectorSyncStatus.RUNNING, error_count=0)
        service.progress.connector_statuses[1] = cp
        service.progress.connectors_completed = []

        service._finalize_connector(1, {}, MagicMock())

        assert cp.connector_type in service.progress.connectors_completed

    @patch.object(SyncJobService, "_persist_connector_status")
    def test_updates_db_connector_run(self, mock_persist, service):
        cp = _make_connector_progress(status=ConnectorSyncStatus.RUNNING, error_count=0)
        service.progress.connector_statuses[1] = cp
        db_runs = {1: 101}
        mock_repo = MagicMock()

        service._finalize_connector(1, db_runs, mock_repo)

        mock_repo.update_connector_run_status.assert_called_once()
        call_args = mock_repo.update_connector_run_status.call_args
        assert call_args[0][0] == 101  # run_id


# ─── _determine_and_set_job_status Tests ─────────────────────────────────


class TestDetermineAndSetJobStatus:
    """Tests for _determine_and_set_job_status shared helper."""

    def test_all_completed_results_in_completed(self, service):
        service.progress.connector_statuses = {
            1: _make_connector_progress(status=ConnectorSyncStatus.COMPLETED, error_count=0),
            2: _make_connector_progress(connector_id=2, status=ConnectorSyncStatus.COMPLETED, error_count=0),
        }
        service._determine_and_set_job_status()
        assert service.progress.status == JobStatus.COMPLETED

    def test_any_failure_results_in_failed(self, service):
        service.progress.connector_statuses = {
            1: _make_connector_progress(status=ConnectorSyncStatus.COMPLETED, error_count=0),
            2: _make_connector_progress(connector_id=2, status=ConnectorSyncStatus.FAILED),
        }
        service._determine_and_set_job_status()
        assert service.progress.status == JobStatus.FAILED

    def test_warning_without_failure_results_in_warning(self, service):
        service.progress.connector_statuses = {
            1: _make_connector_progress(status=ConnectorSyncStatus.COMPLETED, error_count=0),
            2: _make_connector_progress(connector_id=2, status=ConnectorSyncStatus.WARNING),
        }
        service._determine_and_set_job_status()
        assert service.progress.status == JobStatus.WARNING

    def test_queued_connectors_marked_completed(self, service):
        cp = _make_connector_progress(status=ConnectorSyncStatus.QUEUED, error_count=0)
        service.progress.connector_statuses = {1: cp}

        service._determine_and_set_job_status()

        assert cp.status == ConnectorSyncStatus.COMPLETED
        assert service.progress.status == JobStatus.COMPLETED

    def test_sets_finished_at(self, service):
        service.progress.connector_statuses = {
            1: _make_connector_progress(status=ConnectorSyncStatus.COMPLETED, error_count=0),
        }
        service._determine_and_set_job_status()
        assert service.progress.finished_at is not None


# ─── API Route Tests ─────────────────────────────────────────────────────


class TestRetryAPIRoute:
    """Tests for the POST /sync-job/retry/{connector_id} route."""

    @patch("backend.api.routes.sync_job.get_sync_job_service")
    def test_successful_retry_returns_200(self, mock_get_svc):
        from fastapi.testclient import TestClient
        from backend.api.routes.sync_job import router
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        mock_svc = MagicMock()
        mock_svc.retry_connector.return_value = {
            "status": "retry_started",
            "connector_id": 1,
            "job_id": 42,
            "connector_run_id": 300,
        }
        mock_get_svc.return_value = mock_svc

        resp = client.post("/sync-job/retry/1")
        assert resp.status_code == 200
        assert resp.json()["status"] == "retry_started"

    @patch("backend.api.routes.sync_job.get_sync_job_service")
    def test_value_error_returns_400(self, mock_get_svc):
        from fastapi.testclient import TestClient
        from backend.api.routes.sync_job import router
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        mock_svc = MagicMock()
        mock_svc.retry_connector.side_effect = ValueError("Connector 999 not found")
        mock_get_svc.return_value = mock_svc

        resp = client.post("/sync-job/retry/999")
        assert resp.status_code == 400
        assert "not found" in resp.json()["detail"]

    @patch("backend.api.routes.sync_job.get_sync_job_service")
    def test_runtime_error_returns_409(self, mock_get_svc):
        from fastapi.testclient import TestClient
        from backend.api.routes.sync_job import router
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        mock_svc = MagicMock()
        mock_svc.retry_connector.side_effect = RuntimeError("already in progress")
        mock_get_svc.return_value = mock_svc

        resp = client.post("/sync-job/retry/1")
        assert resp.status_code == 409
        assert "already in progress" in resp.json()["detail"]
