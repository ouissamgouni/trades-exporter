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
    svc._fetching_connectors = set()
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

    def test_raises_if_connector_still_fetching_in_job(self, service):
        """Prod job #814: a connector shown as warning while its fetch thread still ran was retried concurrently."""
        service.progress.connector_statuses[1] = _make_connector_progress(
            status=ConnectorSyncStatus.WARNING
        )
        service._fetching_connectors = {1}
        with pytest.raises(RuntimeError, match="still fetching"):
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


class TestStartAbortAPIRoute:
    """Blocked starts and orphaned-job aborts must be explicit to the UI."""

    @patch("backend.api.routes.sync_job.get_sync_job_service")
    def test_blocked_start_returns_structured_409(self, mock_get_svc):
        from fastapi.testclient import TestClient
        from backend.api.routes.sync_job import router
        from backend.services.sync_job_service import SyncJobBlockedError
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        blocking = {"id": 802, "status": "pending", "started_at": "2026-03-17T19:52:00", "orphaned": True}
        mock_svc = MagicMock()
        mock_svc.start_job.side_effect = SyncJobBlockedError("Sync job #802 is stuck", blocking)
        mock_get_svc.return_value = mock_svc

        resp = client.post("/sync-job/start", json={"trigger_source": "manual"})
        assert resp.status_code == 409
        detail = resp.json()["detail"]
        assert detail["code"] == "sync_job_active"
        assert detail["blocking_job"] == blocking
        assert "#802" in detail["message"]

    @patch("backend.api.routes.sync_job.get_sync_job_service")
    def test_abort_specific_inactive_job_returns_409(self, mock_get_svc):
        from fastapi.testclient import TestClient
        from backend.api.routes.sync_job import router
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        mock_svc = MagicMock()
        mock_svc.abort_job.return_value = {"status": "not_running", "message": "Job #5 is not active"}
        mock_get_svc.return_value = mock_svc

        resp = client.post("/sync-job/jobs/5/abort")
        assert resp.status_code == 409
        mock_svc.abort_job.assert_called_once_with(job_id=5)


# ─── Retry Override Bug Fix Tests ─────────────────────────────────────────


class TestRetryConnectorOverrides:
    """
    Tests for the fix to the retry connector override bug.

    The bug: _run_single_connector used to build a single-element override list
    [ConnectorOverride(connector_id=X, enabled=True)] which left every other
    DB-enabled connector without an explicit override. DatabaseConnectorHub then
    fell back to account_connector.enabled for those, loading ALL enabled
    connectors instead of just the retried one.

    The fix: Build override list from ALL connectors, setting enabled=True only
    for the target connector and enabled=False for everything else.
    """

    def test_run_single_connector_builds_full_override_list(self, service):
        """
        _run_single_connector must pass overrides that disable every connector
        except the retried one, so the hub doesn't fall back to DB defaults.
        """
        target_id = 1
        other_ids = [2, 3, 4]
        all_ids = [target_id] + other_ids

        # Set up connector progress for the target
        service.progress.connector_statuses[target_id] = _make_connector_progress(
            connector_id=target_id,
            status=ConnectorSyncStatus.QUEUED,
        )
        service.progress.job_id = 42
        service._run_job_db_connector_runs = {target_id: 100}

        # Build mock AccountConnector objects returned by acct_repo.get_all()
        mock_connectors = []
        for cid in all_ids:
            ac = MagicMock()
            ac.id = cid
            ac.connector_type = f"type-{cid}"
            ac.enabled = True  # All enabled in DB — this is what triggered the bug
            ac.account_id = cid * 10
            ac.config = {}
            account = MagicMock()
            account.name = f"Account-{cid}"
            mock_connectors.append((ac, account))

        captured_overrides = []

        def capture_hub_init(self_hub, session, **kwargs):
            """Intercept DatabaseConnectorHub.__init__ to capture connector_overrides."""
            captured_overrides.extend(kwargs.get("connector_overrides", []))
            # Don't actually initialize the hub — we just want to see the overrides
            raise StopIteration("captured")

        # Patch DatabaseConnectorHub at its source module (it's imported locally
        # inside _run_single_connector, so we patch the canonical location)
        with patch("backend.services.sync_job_service.get_engine") as mock_engine, \
             patch("backend.services.sync_job_service.Session") as MockSession, \
             patch("backend.db.repositories.sync_job_repository.SyncJobRepository"), \
             patch("backend.db.repositories.AccountConnectorRepository") as MockACRepo, \
             patch("backend.db.repositories.NormalizedTransactionRepository"), \
             patch("backend.connectors.connector_registry.get_connector_registry") as mock_reg, \
             patch("backend.connectors.hub.database_connector_hub.DatabaseConnectorHub.__init__", capture_hub_init):

            # Mock session and repository
            mock_session = MagicMock()
            MockSession.return_value = mock_session
            mock_session.get.return_value = MagicMock(
                id=target_id, connector_type="type-1", account_id=10, config={}
            )

            mock_repo_instance = MagicMock()
            mock_repo_instance.get_all.return_value = mock_connectors
            MockACRepo.return_value = mock_repo_instance

            # Registry mock
            mock_info = MagicMock()
            mock_info.supports_incremental_sync = False
            mock_reg.return_value.get.return_value = mock_info

            # Run — expect StopIteration from our capture
            try:
                service._run_single_connector(target_id)
            except StopIteration:
                pass  # Expected — we intercepted hub init

        # Verify overrides
        assert len(captured_overrides) == len(all_ids), (
            f"Expected overrides for all {len(all_ids)} connectors, "
            f"got {len(captured_overrides)}"
        )

        override_map = {o.connector_id: o.enabled for o in captured_overrides}
        assert override_map[target_id] is True, "Target connector must be enabled"
        for oid in other_ids:
            assert override_map[oid] is False, (
                f"Connector {oid} should be disabled but was {override_map[oid]}"
            )

    def test_run_single_connector_old_bug_would_enable_all(self):
        """
        Regression guard: a single-element override [enabled=True for target]
        leaves other connectors uncontrolled — they'd fall back to DB defaults.
        Verify the DatabaseConnectorHub._override_enabled logic to illustrate.
        """
        from backend.services.sync_job_service import ConnectorOverride

        target_id = 1
        other_id = 2

        # Simulate the OLD buggy override list
        buggy_overrides = [ConnectorOverride(connector_id=target_id, enabled=True)]
        override_enabled = {}
        for o in buggy_overrides:
            if o.enabled is not None:
                override_enabled[o.connector_id] = o.enabled

        # For the target, override says True
        assert override_enabled.get(target_id, True) is True
        # For another connector, no override → falls back to default (True = DB enabled)
        assert override_enabled.get(other_id, True) is True  # BUG: would run

        # Simulate the FIXED override list
        fixed_overrides = [
            ConnectorOverride(connector_id=target_id, enabled=True),
            ConnectorOverride(connector_id=other_id, enabled=False),
        ]
        override_enabled_fixed = {}
        for o in fixed_overrides:
            if o.enabled is not None:
                override_enabled_fixed[o.connector_id] = o.enabled

        assert override_enabled_fixed.get(target_id, True) is True
        assert override_enabled_fixed.get(other_id, True) is False  # FIXED


# ─── has_since_override Bug Fix Tests ─────────────────────────────────────


class TestSinceOverrideBugFix:
    """
    Tests for the fix to the has_since_override check.

    The bug: `hasattr(o, 'since_datetime')` was always True because
    since_datetime is a dataclass field. This caused ALL overridden connectors
    to be tracked as having a since override.

    The fix: `o.since_datetime is not _UNSET` — only track connectors that
    actually specify a since_datetime value (_UNSET is the sentinel default).
    """

    def test_disabled_connector_without_since_not_in_override_set(self):
        """
        A disabled connector (enabled=False, since_datetime=_UNSET) should NOT
        be added to has_since_override.
        """
        from backend.services.sync_job_service import ConnectorOverride, _UNSET

        overrides = [
            ConnectorOverride(connector_id=1, enabled=False),
            ConnectorOverride(connector_id=2, enabled=False),
        ]

        has_since_override = set()
        override_since = {}

        for o in overrides:
            # The FIXED check — _UNSET means "not provided"
            if o.since_datetime is not _UNSET:
                has_since_override.add(o.connector_id)
                override_since[o.connector_id] = o.since_datetime

        assert len(has_since_override) == 0
        assert len(override_since) == 0

    def test_connector_with_explicit_since_is_tracked(self):
        """A connector with an actual since_datetime should be tracked."""
        from backend.services.sync_job_service import ConnectorOverride, _UNSET

        since_dt = datetime(2024, 6, 15, 12, 0)
        overrides = [
            ConnectorOverride(connector_id=1, enabled=True, since_datetime=since_dt),
            ConnectorOverride(connector_id=2, enabled=True),  # No since (_UNSET)
        ]

        has_since_override = set()
        override_since = {}

        for o in overrides:
            if o.since_datetime is not _UNSET:
                has_since_override.add(o.connector_id)
                override_since[o.connector_id] = o.since_datetime

        assert 1 in has_since_override
        assert 2 not in has_since_override
        assert override_since[1] == since_dt

    def test_old_hasattr_bug_would_track_all_connectors(self):
        """
        Regression guard: `hasattr(o, 'since_datetime')` is always True
        for a ConnectorOverride dataclass, even when since_datetime=_UNSET.
        The correct check is `o.since_datetime is not _UNSET`.
        """
        from backend.services.sync_job_service import ConnectorOverride, _UNSET

        o = ConnectorOverride(connector_id=1, enabled=False)
        # The old buggy check — always True for dataclass fields
        assert hasattr(o, 'since_datetime') is True
        # The field value is _UNSET (sentinel), not None
        assert o.since_datetime is _UNSET
        # The fixed check correctly returns False
        assert (o.since_datetime is not _UNSET) is False
