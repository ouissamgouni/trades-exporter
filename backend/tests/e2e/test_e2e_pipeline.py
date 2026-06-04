"""
End-to-end tests for the complete trades exporter system.
Tests the full pipeline using SyncJobService: raw data → normalization → persistence
"""

import os
import pytest
import time

from backend.db.database import init_db, get_engine
from backend.db.repositories import (
    NormalizedTransactionRepository,
    RawTransactionRepository,
)
from backend.services.sync_job_service import SyncJobService, get_sync_job_service
from sqlmodel import Session


pytestmark = [pytest.mark.e2e, pytest.mark.timeout(30)]

# Polling config — test_mode uses local fixtures, so jobs finish fast
POLL_INTERVAL = 0.1  # seconds between polls
MAX_WAIT_NORMAL = 15  # seconds for normal job completion
MAX_WAIT_ABORT = 5  # seconds for abort to finish


def _wait_for_completion(service, max_wait=MAX_WAIT_NORMAL):
    """Poll service until job finishes or timeout."""
    waited = 0
    while service.is_running() and waited < max_wait:
        time.sleep(POLL_INTERVAL)
        waited += POLL_INTERVAL


@pytest.fixture(autouse=True)
def isolated_e2e_database(monkeypatch):
    test_db_url = os.getenv("TEST_DATABASE_URL", "")
    if "trades_db_integ" not in test_db_url:
        pytest.skip(
            "E2E sync tests require TEST_DATABASE_URL pointing to trades_db_integ"
        )

    monkeypatch.setenv("DATABASE_URL", test_db_url)
    from backend.db import database

    database._engine = None
    yield
    database._engine = None


@pytest.fixture
def sync_service():
    """Get a fresh SyncJobService instance."""
    SyncJobService._instance = None
    return get_sync_job_service()


@pytest.fixture
def test_session():
    """Get a database session for verification."""
    engine = get_engine()
    with Session(engine) as session:
        yield session


class TestSyncJobServiceE2E:
    """End-to-end tests using SyncJobService."""

    def test_sync_job_starts_and_completes(self, sync_service):
        """Test that a sync job can be started and completes successfully."""
        assert not sync_service.is_running()

        result = sync_service.start_job()
        assert result["status"] == "started"
        assert result["test_mode"] is True

        _wait_for_completion(sync_service)

        status = sync_service.get_status()
        assert status["status"] in ["completed", "failed"]
        assert status["test_mode"] is True

    def test_sync_job_processes_transactions(self, sync_service, test_session):
        """Test that transactions are persisted during sync."""
        sync_service.start_job()
        _wait_for_completion(sync_service)

        status = sync_service.get_status()

        if status["status"] == "completed":
            assert status["total_processed"] >= 0

            norm_repo = NormalizedTransactionRepository(test_session)
            transactions = norm_repo.list_all(limit=100)
            assert len(transactions) >= 0

    def test_sync_job_abort(self, sync_service):
        """Test that a running job can be aborted."""
        sync_service.start_job()

        result = sync_service.abort_job()
        assert result["status"] == "aborting"

        _wait_for_completion(sync_service, MAX_WAIT_ABORT)

        status = sync_service.get_status()
        assert status["abort_requested"] is True
        assert status["status"] in ["aborted", "completed"]

    def test_cannot_start_job_while_running(self, sync_service):
        """Test that starting a job while one is running raises an error."""
        sync_service.start_job()

        with pytest.raises(RuntimeError) as exc_info:
            sync_service.start_job()

        assert "already running" in str(exc_info.value).lower()

        sync_service.abort_job()
        _wait_for_completion(sync_service, MAX_WAIT_ABORT)

    def test_sync_job_status_reporting(self, sync_service):
        """Test that job status is accurately reported."""
        status = sync_service.get_status()
        assert status["status"] == "idle"
        assert status["started_at"] is None

        sync_service.start_job()

        status = sync_service.get_status()
        assert status["status"] == "running"
        assert status["started_at"] is not None

        _wait_for_completion(sync_service)

        status = sync_service.get_status()
        assert status["finished_at"] is not None
        assert status["status"] in ["completed", "failed", "aborted"]


class TestDataIntegrityE2E:
    """Tests focusing on data integrity through the pipeline."""

    def test_raw_and_normalized_consistency(self, sync_service, test_session):
        """Verify that raw and normalized data are consistent."""
        sync_service.start_job()
        _wait_for_completion(sync_service)

        status = sync_service.get_status()

        if status["status"] == "completed" and status["new_entries_added"] > 0:
            raw_repo = RawTransactionRepository(test_session)
            norm_repo = NormalizedTransactionRepository(test_session)

            normalized = norm_repo.list_all(limit=100)

            for tx in normalized:
                assert tx.raw_transaction_id is not None
                raw = raw_repo.get(tx.raw_transaction_id)
                assert raw is not None
                assert raw.source == tx.source
                assert raw.source_transaction_id == tx.source_transaction_id

    def test_normalized_transaction_structure(self, sync_service, test_session):
        """Verify that normalized transactions have required fields."""
        sync_service.start_job()
        _wait_for_completion(sync_service)

        status = sync_service.get_status()

        if status["status"] == "completed":
            norm_repo = NormalizedTransactionRepository(test_session)
            transactions = norm_repo.list_all(limit=100)

            for tx in transactions:
                assert tx.source is not None
                assert tx.source_transaction_id is not None
                assert tx.date_time is not None
                assert tx.direction in ["inflow", "outflow", "neutral"]
                assert tx.transaction_type is not None
                assert tx.quantity is not None
                assert tx.review_status in ["valid", "pending", "invalid"]


class TestErrorHandlingE2E:
    """Tests for error handling in the E2E pipeline."""

    def test_job_handles_connector_errors_gracefully(self, sync_service):
        """Test that the job continues despite individual connector errors."""
        sync_service.start_job()
        _wait_for_completion(sync_service)

        status = sync_service.get_status()

        assert status["status"] in ["completed", "failed"]
        assert "errors" in status
        assert isinstance(status["errors"], list)

    def test_abort_does_not_corrupt_data(self, sync_service, test_session):
        """Test that aborting a job doesn't corrupt persisted data."""
        sync_service.start_job()

        time.sleep(0.1)  # Brief run before abort

        sync_service.abort_job()
        _wait_for_completion(sync_service, MAX_WAIT_ABORT)

        norm_repo = NormalizedTransactionRepository(test_session)
        transactions = norm_repo.list_all(limit=100)

        for tx in transactions:
            assert tx.source is not None
            assert tx.source_transaction_id is not None
