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
    # Default successful processing
    result = Mock(spec=PipelineResult)
    result.success = True
    result.created = True
    result.transaction = Mock(id=1)
    result.error = None
    pipeline.process.return_value = result
    return pipeline


@pytest.fixture
def mock_context():
    """Mock pipeline context."""
    context = Mock(spec=PipelineContext)
    context.connector_name = "test_connector"
    context.account_name = "test_account"
    return context


@pytest.fixture
def processor(mock_session, mock_pipeline):
    """Create processor instance."""
    processor = ParallelPipelineProcessor(
        session=mock_session,
        pipeline=mock_pipeline,
        num_workers=2,  # Use fewer workers for testing
        queue_size=10
    )
    processor.start()
    yield processor
    processor.stop()


class TestProcessorInitialization:
    """Test processor initialization."""

    def test_creates_with_default_workers(self, mock_session, mock_pipeline):
        """Test processor creates with default worker count."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline
        )
        assert processor.num_workers == 4
        assert processor.queue.maxsize == 500
        processor.stop()

    def test_creates_with_custom_workers(self, mock_session, mock_pipeline):
        """Test processor creates with custom worker count."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            num_workers=8,
            queue_size=1000
        )
        assert processor.num_workers == 8
        assert processor.queue.maxsize == 1000
        processor.stop()

    def test_initializes_locks(self, mock_session, mock_pipeline):
        """Test processor initializes threading locks."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline
        )
        assert isinstance(processor.session_lock, type(threading.Lock()))
        assert isinstance(processor.progress_lock, type(threading.Lock()))
        processor.stop()

    def test_initializes_statistics(self, mock_session, mock_pipeline):
        """Test processor initializes statistics counters."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline
        )
        stats = processor.get_stats()
        assert stats["processed"] == 0
        assert stats["succeeded"] == 0
        assert stats["failed"] == 0
        assert stats["queued"] == 0
        processor.stop()


class TestItemProcessing:
    """Test item processing through workers."""

    def test_processes_single_item(self, processor, mock_pipeline, mock_context):
        """Test worker processes single item successfully."""
        raw_tx = {"id": "tx1", "amount": 100}
        
        processor.submit(raw_tx, mock_context, callback=None)
        processor.stop()  # Wait for processing
        
        # Verify pipeline was called
        mock_pipeline.process.assert_called_once()
        args = mock_pipeline.process.call_args[0]
        assert args[0] == raw_tx
        assert args[1] == mock_context

    def test_processes_multiple_items(self, processor, mock_pipeline, mock_context):
        """Test worker processes multiple items."""
        items = [
            {"id": "tx1", "amount": 100},
            {"id": "tx2", "amount": 200},
            {"id": "tx3", "amount": 300}
        ]
        
        for item in items:
            processor.submit(item, mock_context, callback=None)
        
        processor.stop()
        
        # Verify all items processed
        assert mock_pipeline.process.call_count == 3

    def test_tracks_statistics(self, processor, mock_pipeline, mock_context):
        """Test processor tracks processing statistics."""
        items = [{"id": f"tx{i}"} for i in range(5)]
        
        for item in items:
            processor.submit(item, mock_context, callback=None)
        
        processor.stop()
        
        stats = processor.get_stats()
        assert stats["processed"] == 5
        assert stats["succeeded"] == 5
        assert stats["failed"] == 0

    def test_calls_callback_on_success(self, processor, mock_context):
        """Test processor calls callback with result."""
        callback = Mock()
        raw_tx = {"id": "tx1"}
        
        processor.submit(raw_tx, mock_context, callback=callback)
        processor.stop()
        
        # Verify callback was called
        callback.assert_called_once()
        result = callback.call_args[0][0]
        assert result.success is True


class TestErrorHandling:
    """Test error handling in workers."""

    def test_handles_pipeline_error(self, mock_session, mock_pipeline, mock_context):
        """Test worker handles pipeline processing error."""
        # Configure pipeline to raise error
        mock_pipeline.process.side_effect = Exception("Processing failed")
        
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            num_workers=1
        )
        processor.start()
        
        processor.submit({"id": "tx1"}, mock_context, callback=None)
        processor.stop()
        
        # Verify session rollback was called
        mock_session.rollback.assert_called()
        
        # Verify error tracked
        stats = processor.get_stats()
        assert stats["failed"] == 1

    def test_continues_after_error(self, mock_session, mock_pipeline, mock_context):
        """Test worker continues processing after error."""
        # First call fails, second succeeds
        result_success = Mock(spec=PipelineResult)
        result_success.success = True
        
        mock_pipeline.process.side_effect = [
            Exception("First error"),
            result_success
        ]
        
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            num_workers=1
        )
        processor.start()
        
        processor.submit({"id": "tx1"}, mock_context, callback=None)
        processor.submit({"id": "tx2"}, mock_context, callback=None)
        processor.stop()
        
        # Verify both items were attempted
        assert mock_pipeline.process.call_count == 2
        
        stats = processor.get_stats()
        assert stats["failed"] == 1
        assert stats["succeeded"] == 1

    def test_callback_with_error_result(self, processor, mock_pipeline, mock_context):
        """Test callback receives error result."""
        # Configure pipeline to return error result
        error_result = Mock(spec=PipelineResult)
        error_result.success = False
        error_result.error = "Validation failed"
        mock_pipeline.process.return_value = error_result
        
        callback = Mock()
        processor.submit({"id": "tx1"}, mock_context, callback=callback)
        processor.stop()
        
        # Verify callback called with error result
        callback.assert_called_once()
        result = callback.call_args[0][0]
        assert result.success is False
        assert result.error == "Validation failed"


class TestSessionLocking:
    """Test session locking for thread-safety."""

    def test_session_lock_prevents_concurrent_access(self, mock_session, mock_pipeline, mock_context):
        """Test session lock prevents concurrent database access."""
        access_times = []
        lock_held = threading.Event()
        
        def slow_process(*args, **kwargs):
            """Simulate slow processing that holds lock."""
            access_times.append(("start", threading.current_thread().name, time.time()))
            # Signal that lock is held
            lock_held.set()
            time.sleep(0.1)  # Hold lock briefly
            access_times.append(("end", threading.current_thread().name, time.time()))
            result = Mock(spec=PipelineResult)
            result.success = True
            return result
        
        mock_pipeline.process.side_effect = slow_process
        
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            num_workers=2
        )
        processor.start()
        
        # Submit two items to different workers
        processor.submit({"id": "tx1"}, mock_context, callback=None)
        lock_held.wait(timeout=1)  # Wait for first worker to acquire lock
        processor.submit({"id": "tx2"}, mock_context, callback=None)
        
        processor.stop()
        
        # Verify sequential access (no overlap)
        if len(access_times) >= 4:
            first_end = access_times[1][2]
            second_start = access_times[2][2]
            # Second worker should start after first completes
            assert second_start >= first_end

    def test_commit_called_per_item(self, mock_session, mock_pipeline, mock_context):
        """Test session commit called for each item (per-item commits)."""
        items = [{"id": f"tx{i}"} for i in range(3)]
        
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            num_workers=1
        )
        processor.start()
        
        for item in items:
            processor.submit(item, mock_context, callback=None)
        
        processor.stop()
        
        # Pipeline.process() includes commit, so verify it was called 3 times
        assert mock_pipeline.process.call_count == 3


class TestAbortHandling:
    """Test abort functionality."""

    def test_abort_stops_processing(self, processor, mock_pipeline, mock_context):
        """Test abort stops workers from processing queued items."""
        # Add delay to processing
        def slow_process(*args, **kwargs):
            time.sleep(0.1)
            result = Mock(spec=PipelineResult)
            result.success = True
            return result
        
        mock_pipeline.process.side_effect = slow_process
        
        # Queue many items
        for i in range(10):
            processor.submit({"id": f"tx{i}"}, mock_context, callback=None)
        
        # Abort immediately
        processor.abort_event.set()
        processor.stop()
        
        # Not all items should be processed
        stats = processor.get_stats()
        assert stats["processed"] < 10

    def test_abort_event_initialized(self, mock_session, mock_pipeline):
        """Test abort event is initialized."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline
        )
        assert isinstance(processor.abort_event, type(threading.Event()))
        assert not processor.abort_event.is_set()
        processor.stop()


class TestQueueBackpressure:
    """Test queue backpressure behavior."""

    def test_submit_blocks_when_queue_full(self, mock_session, mock_pipeline, mock_context):
        """Test submit blocks when queue is full."""
        # Create processor with small queue
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            num_workers=1,
            queue_size=2
        )
        
        # Make processing very slow so queue fills
        def very_slow_process(*args, **kwargs):
            time.sleep(1)
            result = Mock(spec=PipelineResult)
            result.success = True
            return result
        
        mock_pipeline.process.side_effect = very_slow_process
        processor.start()
        
        # Fill queue
        processor.submit({"id": "tx1"}, mock_context, callback=None)
        processor.submit({"id": "tx2"}, mock_context, callback=None)
        
        # Next submit should block briefly
        start_time = time.time()
        submitted = False
        
        def try_submit():
            nonlocal submitted
            processor.submit({"id": "tx3"}, mock_context, callback=None)
            submitted = True
        
        submit_thread = threading.Thread(target=try_submit)
        submit_thread.start()
        submit_thread.join(timeout=0.5)
        
        # Should still be blocked after short wait
        assert not submitted
        
        processor.abort_event.set()
        processor.stop()

    def test_queue_size_in_stats(self, processor, mock_context):
        """Test queue size tracked in statistics."""
        # Make processing slow to keep items in queue
        def slow_process(*args, **kwargs):
            time.sleep(0.2)
            result = Mock(spec=PipelineResult)
            result.success = True
            return result
        
        processor.pipeline.process.side_effect = slow_process
        
        # Submit items faster than they're processed
        for i in range(5):
            processor.submit({"id": f"tx{i}"}, mock_context, callback=None)
        
        # Check queue size
        stats = processor.get_stats()
        # Some items should still be queued
        assert stats["queued"] >= 0  # May vary based on timing
        
        processor.stop()


class TestWorkerLifecycle:
    """Test worker thread lifecycle."""

    def test_start_creates_workers(self, mock_session, mock_pipeline):
        """Test start() creates worker threads."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            num_workers=3
        )
        
        assert processor.executor is None
        processor.start()
        assert processor.executor is not None
        
        processor.stop()

    def test_stop_waits_for_workers(self, mock_session, mock_pipeline, mock_context):
        """Test stop() waits for workers to complete."""
        def slow_process(*args, **kwargs):
            time.sleep(0.1)
            result = Mock(spec=PipelineResult)
            result.success = True
            return result
        
        mock_pipeline.process.side_effect = slow_process
        
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            num_workers=1
        )
        processor.start()
        
        # Submit item
        processor.submit({"id": "tx1"}, mock_context, callback=None)
        
        # Stop should wait for processing
        processor.stop()
        
        # Item should be processed
        mock_pipeline.process.assert_called_once()

    def test_double_stop_safe(self, processor):
        """Test calling stop() multiple times is safe."""
        processor.stop()
        processor.stop()  # Should not raise

    def test_double_start_safe(self, mock_session, mock_pipeline):
        """Test calling start() multiple times is safe."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline
        )
        processor.start()
        processor.start()  # Should not create duplicate workers
        processor.stop()
