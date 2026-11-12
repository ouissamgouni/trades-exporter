"""
Test for the connector completion callback race condition fix.

Verifies that completion callbacks are registered even when a connector's
status is already RUNNING (from lazy initialization in DatabaseConnectorHub)
before the main loop processes its first item.
"""
import threading
import time
import pytest
from datetime import datetime
from unittest.mock import Mock, MagicMock, patch

from backend.services.parallel_pipeline_processor import ParallelPipelineProcessor, PipelineStage
from backend.services.sync_job_service import (
    SyncJobService,
    ConnectorProgress,
    ConnectorSyncStatus,
    JobProgress,
    JobStatus,
)


class TestCompletionCallbackRegisteredForAlreadyRunningConnector:
    """
    Regression test: completion callback must be registered even when
    DatabaseConnectorHub's lazy initialization has already transitioned
    the connector from QUEUED -> RUNNING before the main loop sees items.
    """

    def test_callback_fires_when_connector_already_running(self):
        """
        Simulate the race:
        1. Connector status set to RUNNING (by progress callback from hub init)
        2. Main loop detects connector change, sees status is already RUNNING
        3. Callback should STILL be registered (the fix)
        4. When pending count reaches 0, completion callback fires
        """
        mock_session = MagicMock()
        mock_pipeline = MagicMock()

        # Pipeline returns a successful result
        result = MagicMock()
        result.success = True
        result.new_count = 1
        result.updated_count = 0
        result.skipped_count = 0
        result.split_count = 0
        result.transfer_count = 0
        result.warnings = []
        result.errors = []
        mock_pipeline.process.return_value = result

        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={42: 100},
            num_workers=1,
            queue_size=10,
        )
        processor.start()

        # Track whether completion callback was invoked
        completion_called = threading.Event()
        completed_connector_id = []

        def on_complete(connector_id: int):
            completed_connector_id.append(connector_id)
            completion_called.set()

        # Register callback THEN submit items (mirrors the fix)
        processor.register_connector_completion_callback(42, on_complete)

        # Submit a single item for connector 42
        mock_normalized = MagicMock()
        mock_normalized.source = "test"
        processor.submit(
            raw_item={"id": "tx1"},
            normalized_item=mock_normalized,
            connector_id=42,
            connector_name="test-connector",
        )
        processor.mark_connector_fetch_complete(42)

        # Wait for the callback to fire (worker processes item, pending -> 0)
        fired = completion_called.wait(timeout=5)
        processor.stop(timeout=5)

        assert fired, "Completion callback was never invoked"
        assert completed_connector_id == [42]

    def test_no_callback_means_connector_stays_running(self):
        """
        Without the fix: if no callback is registered, the connector stays
        RUNNING until the post-processor cleanup loop.
        """
        mock_session = MagicMock()
        mock_pipeline = MagicMock()
        result = MagicMock()
        result.success = True
        result.new_count = 0
        result.updated_count = 0
        result.skipped_count = 0
        result.split_count = 0
        result.transfer_count = 0
        result.warnings = []
        result.errors = []
        mock_pipeline.process.return_value = result

        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={42: 100},
            num_workers=1,
            queue_size=10,
        )
        processor.start()

        # Do NOT register callback (simulates the old bug)
        mock_normalized = MagicMock()
        mock_normalized.source = "test"
        processor.submit(
            raw_item={"id": "tx1"},
            normalized_item=mock_normalized,
            connector_id=42,
            connector_name="test-connector",
        )

        # Poll for processing completion instead of fixed sleep
        deadline = time.monotonic() + 5
        while processor.get_connector_pending_count(42) > 0 and time.monotonic() < deadline:
            time.sleep(0.01)
        processor.stop(timeout=5)

        # Pending count should be 0 (item processed), but no callback was fired
        assert processor.get_connector_pending_count(42) == 0

    def test_multiple_connectors_complete_independently_via_callbacks(self):
        """
        Two connectors submit items; each should get its own completion callback
        fired independently as soon as its last item is processed.
        """
        mock_session = MagicMock()
        mock_pipeline = MagicMock()
        result = MagicMock()
        result.success = True
        result.new_count = 1
        result.updated_count = 0
        result.skipped_count = 0
        result.split_count = 0
        result.transfer_count = 0
        result.warnings = []
        result.errors = []
        mock_pipeline.process.return_value = result

        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={1: 100, 2: 200},
            num_workers=2,
            queue_size=10,
        )
        processor.start()

        completed_ids = []
        lock = threading.Lock()

        def on_complete(connector_id: int):
            with lock:
                completed_ids.append(connector_id)

        processor.register_connector_completion_callback(1, on_complete)
        processor.register_connector_completion_callback(2, on_complete)

        mock_norm = MagicMock()
        mock_norm.source = "test"

        # Submit 2 items for connector 1, 1 item for connector 2
        processor.submit({"id": "a"}, mock_norm, connector_id=1, connector_name="c1")
        processor.submit({"id": "b"}, mock_norm, connector_id=1, connector_name="c1")
        processor.submit({"id": "c"}, mock_norm, connector_id=2, connector_name="c2")
        processor.mark_connector_fetch_complete(1)
        processor.mark_connector_fetch_complete(2)

        # Poll until both connectors complete instead of fixed sleep
        deadline = time.monotonic() + 5
        while len(completed_ids) < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        processor.stop(timeout=5)

        assert sorted(completed_ids) == [1, 2], (
            f"Expected both connectors to complete via callbacks, got: {completed_ids}"
        )


def _ok_pipeline():
    pipeline = MagicMock()
    result = MagicMock(success=True, new_count=1, updated_count=0, skipped_count=0,
                       split_count=0, transfer_count=0, warnings=[], errors=[])
    pipeline.process.return_value = result
    return pipeline


class TestCompletionWaitsForFetchComplete:
    """Regression (prod job #813/#814): a slow connector whose queue drains between
    fetched batches must NOT be completed until the hub signals FETCH_COMPLETE."""

    def _processor(self):
        processor = ParallelPipelineProcessor(
            session=MagicMock(), pipeline=_ok_pipeline(), db_connector_runs={7: 70},
            num_workers=1, queue_size=10,
        )
        processor.start()
        return processor

    def _drain(self, processor, cid):
        deadline = time.monotonic() + 5
        while processor.get_connector_pending_count(cid) > 0 and time.monotonic() < deadline:
            time.sleep(0.01)

    def test_drained_queue_does_not_complete_while_still_fetching(self):
        processor = self._processor()
        completed = []
        processor.register_connector_completion_callback(7, completed.append)
        norm = MagicMock(source="test")

        processor.submit({"id": "a"}, norm, connector_id=7, connector_name="mexc")
        self._drain(processor, 7)
        time.sleep(0.05)
        assert completed == []

        processor.submit({"id": "b"}, norm, connector_id=7, connector_name="mexc")
        processor.mark_connector_fetch_complete(7)
        deadline = time.monotonic() + 5
        while not completed and time.monotonic() < deadline:
            time.sleep(0.01)
        processor.stop(timeout=5)

        assert completed == [7]

    def test_fetch_complete_with_nothing_pending_completes_immediately(self):
        processor = self._processor()
        completed = []
        processor.register_connector_completion_callback(7, completed.append)

        processor.mark_connector_fetch_complete(7)
        processor.stop(timeout=5)

        assert completed == [7]

    def test_callback_fires_once(self):
        processor = self._processor()
        completed = []
        processor.register_connector_completion_callback(7, completed.append)
        processor.submit({"id": "a"}, MagicMock(source="t"), connector_id=7, connector_name="c")
        processor.mark_connector_fetch_complete(7)
        self._drain(processor, 7)
        processor.mark_connector_fetch_complete(7)
        processor.stop(timeout=5)

        assert completed == [7]


class TestHandleFetchComplete:
    def _service(self):
        svc = SyncJobService()
        svc.progress = JobProgress()
        svc._fetching_connectors = {5}
        return svc

    def test_registers_callback_marks_processor_and_logs(self):
        svc = self._service()
        cstatus = ConnectorProgress(connector_id=5, connector_type="mexc-withdrawals",
                                    account_name="MEXC", status=ConnectorSyncStatus.RUNNING)
        cstatus.fetched_count = 3
        cstatus.processed = 3
        svc.progress.connector_statuses[5] = cstatus
        processor = MagicMock()
        processor.get_connector_pending_count.return_value = 2

        svc._handle_fetch_complete(5, processor)

        assert 5 not in svc._fetching_connectors
        processor.register_connector_completion_callback.assert_called_once_with(
            5, svc._handle_connector_completion
        )
        processor.mark_connector_fetch_complete.assert_called_once_with(5)
        assert "2 still queued" in cstatus.logs[-1].message

    def test_ignores_missing_connector_id(self):
        svc = self._service()
        processor = MagicMock()
        svc._handle_fetch_complete(None, processor)
        processor.mark_connector_fetch_complete.assert_not_called()
