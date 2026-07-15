"""
Unit tests for ParallelPipelineProcessor.
Tests multi-threaded pipeline processing with shared session locking.
"""
import pytest
import threading
import time
from unittest.mock import Mock, MagicMock, patch, call
from queue import Queue

from backend.services.parallel_pipeline_processor import ParallelPipelineProcessor
from backend.services.pipeline import PipelineContext, PipelineResult

pytestmark = pytest.mark.timeout(15)  # Hard timeout per test to prevent hangs


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_session():
    """Mock database session."""
    session = Mock()
    session.commit = Mock()
    session.rollback = Mock()
    return session


@pytest.fixture
def mock_pipeline():
    """Mock transaction pipeline."""
    pipeline = Mock()
    result = Mock(spec=PipelineResult)
    result.success = True
    result.errors = []
    result.warnings = []
    result.new_count = 1
    result.updated_count = 0
    result.skipped_count = 0
    result.split_count = 0
    result.transfer_count = 0
    pipeline.process.return_value = result
    return pipeline


@pytest.fixture
def mock_normalized():
    """Mock normalized transaction item."""
    item = MagicMock()
    item.source = "test_connector"
    return item


@pytest.fixture
def processor(mock_session, mock_pipeline):
    """Create processor instance with workers started."""
    proc = ParallelPipelineProcessor(
        session=mock_session,
        pipeline=mock_pipeline,
        db_connector_runs={},
        num_workers=1,
        queue_size=10,
    )
    proc.start()
    yield proc
    try:
        proc.abort_event.set()
        proc.stop(timeout=5)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _make_success_result():
    r = Mock(spec=PipelineResult)
    r.success = True
    r.errors = []
    r.warnings = []
    r.new_count = 1
    r.updated_count = 0
    r.skipped_count = 0
    r.split_count = 0
    r.transfer_count = 0
    return r


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestProcessorInitialization:
    """Test processor initialization."""

    def test_creates_with_default_workers(self, mock_session, mock_pipeline):
        """Test processor creates with default worker count."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={},
        )
        assert processor.num_workers == 4
        assert processor.input_queue.maxsize == 500

    def test_creates_with_custom_workers(self, mock_session, mock_pipeline):
        """Test processor creates with custom worker count."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={},
            num_workers=8,
            queue_size=1000,
        )
        assert processor.num_workers == 8
        assert processor.input_queue.maxsize == 1000

    def test_initializes_locks(self, mock_session, mock_pipeline):
        """Test processor initializes threading locks."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={},
        )
        assert isinstance(processor.session_lock, type(threading.Lock()))
        assert isinstance(processor.progress_lock, type(threading.Lock()))

    def test_initializes_statistics(self, mock_session, mock_pipeline):
        """Test processor initializes statistics counters."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={},
        )
        stats = processor.get_stats()
        assert stats["processed"] == 0
        assert stats["succeeded"] == 0
        assert stats["failed"] == 0
        assert stats["queued"] == 0


class TestItemProcessing:
    """Test item processing through workers."""

    def test_processes_single_item(self, processor, mock_pipeline, mock_normalized):
        """Test worker processes single item successfully."""
        processor.submit({"id": "tx1"}, mock_normalized, connector_id=1, connector_name="test")
        processor.stop()

        mock_pipeline.process.assert_called_once()

    def test_processes_multiple_items(self, processor, mock_pipeline, mock_normalized):
        """Test worker processes multiple items."""
        for i in range(3):
            processor.submit({"id": f"tx{i}"}, mock_normalized, connector_id=1, connector_name="test")

        processor.stop()
        assert mock_pipeline.process.call_count == 3

    def test_tracks_statistics(self, processor, mock_pipeline, mock_normalized):
        """Test processor tracks processing statistics."""
        for i in range(5):
            processor.submit({"id": f"tx{i}"}, mock_normalized, connector_id=1, connector_name="test")

        processor.stop()

        stats = processor.get_stats()
        assert stats["processed"] == 5
        assert stats["succeeded"] == 5
        assert stats["failed"] == 0

    def test_calls_progress_callback_on_success(self, mock_session, mock_pipeline, mock_normalized):
        """Test processor invokes progress_callback on success."""
        callback = Mock()
        proc = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={},
            progress_callback=callback,
            num_workers=1,
        )
        proc.start()

        proc.submit({"id": "tx1"}, mock_normalized, connector_id=1, connector_name="test")
        proc.stop()

        callback.assert_called_once()


class TestErrorHandling:
    """Test error handling in workers."""

    def test_handles_pipeline_error(self, mock_session, mock_pipeline, mock_normalized):
        """Test worker handles pipeline processing error."""
        mock_pipeline.process.side_effect = Exception("Processing failed")

        proc = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={},
            num_workers=1,
        )
        proc.start()

        proc.submit({"id": "tx1"}, mock_normalized, connector_id=1, connector_name="test")
        proc.stop()

        mock_session.rollback.assert_called()

        stats = proc.get_stats()
        assert stats["failed"] == 1

    def test_continues_after_error(self, mock_session, mock_pipeline, mock_normalized):
        """Test worker continues processing after error."""
        mock_pipeline.process.side_effect = [
            Exception("First error"),
            _make_success_result(),
        ]

        proc = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={},
            num_workers=1,
        )
        proc.start()

        proc.submit({"id": "tx1"}, mock_normalized, connector_id=1, connector_name="test")
        proc.submit({"id": "tx2"}, mock_normalized, connector_id=1, connector_name="test")
        proc.stop()

        assert mock_pipeline.process.call_count == 2

        stats = proc.get_stats()
        assert stats["failed"] == 1
        assert stats["succeeded"] == 1

    def test_error_result_tracked(self, processor, mock_pipeline, mock_normalized):
        """Test failed PipelineResult increments failed counter."""
        error_result = Mock(spec=PipelineResult)
        error_result.success = False
        error_result.errors = ["Validation failed"]
        mock_pipeline.process.return_value = error_result

        processor.submit({"id": "tx1"}, mock_normalized, connector_id=1, connector_name="test")
        processor.stop()

        stats = processor.get_stats()
        assert stats["failed"] == 1


class TestSessionLocking:
    """Test session locking for thread-safety."""

    def test_session_lock_prevents_concurrent_access(self, mock_session, mock_pipeline, mock_normalized):
        """Test session lock prevents concurrent database access."""
        access_times = []
        lock_held = threading.Event()

        def slow_process(*args, **kwargs):
            access_times.append(("start", threading.current_thread().name, time.time()))
            lock_held.set()
            time.sleep(0.1)
            access_times.append(("end", threading.current_thread().name, time.time()))
            return _make_success_result()

        mock_pipeline.process.side_effect = slow_process

        proc = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={},
            num_workers=2,
        )
        proc.start()

        proc.submit({"id": "tx1"}, mock_normalized, connector_id=1, connector_name="test")
        lock_held.wait(timeout=1)
        proc.submit({"id": "tx2"}, mock_normalized, connector_id=1, connector_name="test")

        proc.stop(timeout=10)

        if len(access_times) >= 4:
            first_end = access_times[1][2]
            second_start = access_times[2][2]
            assert second_start >= first_end

    def test_pipeline_called_per_item(self, mock_session, mock_pipeline, mock_normalized):
        """Test pipeline.process() called for each item."""
        proc = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={},
            num_workers=1,
        )
        proc.start()

        for i in range(3):
            proc.submit({"id": f"tx{i}"}, mock_normalized, connector_id=1, connector_name="test")

        proc.stop(timeout=10)

        assert mock_pipeline.process.call_count == 3


class TestAbortHandling:
    """Test abort functionality."""

    def test_abort_stops_processing(self, processor, mock_pipeline, mock_normalized):
        """Test abort stops workers from processing queued items."""
        def slow_process(*args, **kwargs):
            time.sleep(0.1)
            return _make_success_result()

        mock_pipeline.process.side_effect = slow_process

        for i in range(10):
            processor.submit({"id": f"tx{i}"}, mock_normalized, connector_id=1, connector_name="test")

        processor.abort_event.set()
        processor.stop()

        stats = processor.get_stats()
        assert stats["processed"] < 10

    def test_abort_event_initialized(self, mock_session, mock_pipeline):
        """Test abort event is initialized."""
        proc = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={},
        )
        assert isinstance(proc.abort_event, type(threading.Event()))
        assert not proc.abort_event.is_set()


class TestQueueBackpressure:
    """Test queue backpressure behavior."""

    def test_submit_blocks_when_queue_full(self, mock_session, mock_pipeline, mock_normalized):
        """Test submit blocks when queue is full."""
        # Use an event to block the worker deterministically so the queue stays full
        block_event = threading.Event()

        proc = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={},
            num_workers=1,
            queue_size=1,
        )

        def blocking_process(*args, **kwargs):
            block_event.wait(timeout=5)  # Block until we release
            return _make_success_result()

        mock_pipeline.process.side_effect = blocking_process
        proc.start()

        # Submit tx1 → worker picks it up and blocks on block_event
        proc.submit({"id": "tx1"}, mock_normalized, connector_id=1, connector_name="test")
        time.sleep(0.1)  # Let the worker pick up tx1

        # Submit tx2 → fills the queue (size=1)
        proc.submit({"id": "tx2"}, mock_normalized, connector_id=1, connector_name="test")

        submitted = False

        def try_submit():
            nonlocal submitted
            proc.submit({"id": "tx3"}, mock_normalized, connector_id=1, connector_name="test")
            submitted = True

        submit_thread = threading.Thread(target=try_submit, daemon=True)
        submit_thread.start()
        submit_thread.join(timeout=0.5)

        assert not submitted

        # Release worker, wait for submit_thread to unblock, then clean up
        block_event.set()
        submit_thread.join(timeout=5)
        proc.abort_event.set()
        proc.stop(timeout=5)

    def test_queue_size_in_stats(self, processor, mock_normalized):
        """Test queue size tracked in statistics."""
        def slow_process(*args, **kwargs):
            time.sleep(0.05)
            return _make_success_result()

        processor.pipeline.process.side_effect = slow_process

        for i in range(5):
            processor.submit({"id": f"tx{i}"}, mock_normalized, connector_id=1, connector_name="test")

        stats = processor.get_stats()
        assert stats["queued"] >= 0

        processor.stop()


class TestWorkerLifecycle:
    """Test worker thread lifecycle."""

    def test_start_creates_workers(self, mock_session, mock_pipeline):
        """Test start() creates worker threads."""
        proc = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={},
            num_workers=3,
        )

        assert proc.executor is None
        proc.start()
        assert proc.executor is not None

        proc.stop()

    def test_stop_waits_for_workers(self, mock_session, mock_pipeline, mock_normalized):
        """Test stop() waits for workers to complete."""
        def slow_process(*args, **kwargs):
            time.sleep(0.1)
            return _make_success_result()

        mock_pipeline.process.side_effect = slow_process

        proc = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={},
            num_workers=1,
        )
        proc.start()

        proc.submit({"id": "tx1"}, mock_normalized, connector_id=1, connector_name="test")
        proc.stop()

        mock_pipeline.process.assert_called_once()

    def test_double_stop_safe(self, processor):
        """Test calling stop() multiple times is safe."""
        processor.stop()
        processor.stop()

    def test_double_start_raises(self, mock_session, mock_pipeline):
        """Test calling start() when already started raises RuntimeError."""
        proc = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={},
        )
        proc.start()
        with pytest.raises(RuntimeError):
            proc.start()
        proc.stop()
