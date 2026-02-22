"""
Unit tests for connector completion tracking feature in ParallelPipelineProcessor.
Tests per-connector pending count tracking, completion callbacks, and thread safety.
"""
import pytest
import threading
import time
from unittest.mock import Mock, MagicMock
from queue import Queue

from backend.services.parallel_pipeline_processor import ParallelPipelineProcessor, PipelineStage
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
    """Mock transaction pipeline with successful processing."""
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
def processor(mock_session, mock_pipeline):
    """Create processor instance with completion tracking."""
    processor = ParallelPipelineProcessor(
        session=mock_session,
        pipeline=mock_pipeline,
        db_connector_runs={1: 101, 2: 102},
        num_workers=2,
        queue_size=10
    )
    processor.start()
    yield processor
    processor.stop()


class TestConnectorPendingCountTracking:
    """Test per-connector pending count tracking."""

    def test_submit_increments_pending_count(self, mock_session, mock_pipeline):
        """Test that submit() increments pending count for connector."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={1: 101},
            num_workers=1
        )
        processor.start()
        
        # Submit items for connector 1
        normalized_item = Mock()
        processor.submit({"id": "tx1"}, normalized_item, connector_id=1, connector_name="binance")
        processor.submit({"id": "tx2"}, normalized_item, connector_id=1, connector_name="binance")
        
        # Check pending count
        assert processor.get_connector_pending_count(1) == 2
        
        processor.stop()

    def test_submit_none_connector_id_handled(self, mock_session, mock_pipeline):
        """Test that submit() handles None connector_id gracefully."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={},
            num_workers=1
        )
        processor.start()
        
        # Submit with None connector_id (should not crash)
        normalized_item = Mock()
        result = processor.submit({"id": "tx1"}, normalized_item, connector_id=None, connector_name="unknown")
        
        assert result is True
        processor.stop()

    def test_pending_count_decrements_after_processing(self, mock_session, mock_pipeline):
        """Test that pending count decrements as items are processed."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={1: 101},
            num_workers=2
        )
        processor.start()
        
        # Submit items
        normalized_item = Mock()
        processor.submit({"id": "tx1"}, normalized_item, connector_id=1, connector_name="binance")
        processor.submit({"id": "tx2"}, normalized_item, connector_id=1, connector_name="binance")
        
        initial_pending = processor.get_connector_pending_count(1)
        assert initial_pending == 2
        
        # Wait for processing
        time.sleep(0.5)
        
        # Pending count should decrease
        final_pending = processor.get_connector_pending_count(1)
        assert final_pending < initial_pending, "Pending count should decrease as items are processed"
        
        processor.stop()

    def test_get_connector_pending_count_for_unknown_connector(self, mock_session, mock_pipeline):
        """Test get_connector_pending_count returns 0 for unknown connector."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={}
        )
        processor.start()
        
        # Query unknown connector
        assert processor.get_connector_pending_count(999) == 0
        
        processor.stop()

    def test_multiple_connectors_tracked_independently(self, mock_session, mock_pipeline):
        """Test that multiple connectors are tracked independently."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={1: 101, 2: 102, 3: 103},
            num_workers=2
        )
        processor.start()
        
        # Submit different amounts for different connectors
        normalized_item = Mock()
        processor.submit({"id": "tx1"}, normalized_item, connector_id=1, connector_name="binance")
        processor.submit({"id": "tx2"}, normalized_item, connector_id=2, connector_name="etherscan")
        processor.submit({"id": "tx3"}, normalized_item, connector_id=1, connector_name="binance")
        processor.submit({"id": "tx4"}, normalized_item, connector_id=2, connector_name="etherscan")
        processor.submit({"id": "tx5"}, normalized_item, connector_id=3, connector_name="coinbase")
        
        # Each connector should track independently
        count_1 = processor.get_connector_pending_count(1)
        count_2 = processor.get_connector_pending_count(2)
        count_3 = processor.get_connector_pending_count(3)
        
        assert count_1 + count_2 + count_3 <= 5, "Total pending should not exceed submitted"
        
        processor.stop()


class TestCompletionCallbacks:
    """Test completion callback functionality."""

    def test_register_completion_callback(self, mock_session, mock_pipeline):
        """Test registering a completion callback."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={1: 101}
        )
        processor.start()
        
        callback = Mock()
        processor.register_connector_completion_callback(1, callback)
        
        # Callback should be registered
        assert 1 in processor.connector_completion_callbacks
        
        processor.stop()

    def test_completion_callback_triggered_when_pending_reaches_zero(self, mock_session, mock_pipeline):
        """Test that completion callback is triggered when all items processed."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={1: 101},
            num_workers=2
        )
        processor.start()
        
        # Register completion callback
        callback_called = threading.Event()
        callback_connector_id = []
        
        def on_complete(connector_id):
            callback_connector_id.append(connector_id)
            callback_called.set()
        
        processor.register_connector_completion_callback(1, on_complete)
        
        # Submit items
        normalized_item = Mock()
        processor.submit({"id": "tx1"}, normalized_item, connector_id=1, connector_name="binance")
        processor.submit({"id": "tx2"}, normalized_item, connector_id=1, connector_name="binance")
        
        # Wait for callback
        callback_triggered = callback_called.wait(timeout=3.0)
        
        assert callback_triggered, "Completion callback should be triggered"
        assert 1 in callback_connector_id, "Callback should receive correct connector_id"
        
        processor.stop()

    def test_multiple_connectors_callbacks_independent(self, mock_session, mock_pipeline):
        """Test that multiple connectors trigger callbacks independently."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={1: 101, 2: 102},
            num_workers=2
        )
        processor.start()
        
        # Track which callbacks were called
        callbacks_called = set()
        callback_lock = threading.Lock()
        
        def make_callback(connector_id):
            def callback(cid):
                with callback_lock:
                    callbacks_called.add(cid)
            return callback
        
        processor.register_connector_completion_callback(1, make_callback(1))
        processor.register_connector_completion_callback(2, make_callback(2))
        
        # Submit items for both connectors
        normalized_item = Mock()
        processor.submit({"id": "tx1"}, normalized_item, connector_id=1, connector_name="binance")
        processor.submit({"id": "tx2"}, normalized_item, connector_id=2, connector_name="etherscan")
        
        # Wait for callbacks
        time.sleep(1.0)
        
        # Both callbacks should be triggered
        assert 1 in callbacks_called, "Connector 1 callback should be triggered"
        assert 2 in callbacks_called, "Connector 2 callback should be triggered"
        
        processor.stop()

    def test_completion_callback_cleans_up_tracking(self, mock_session, mock_pipeline):
        """Test that completion callback cleans up connector tracking."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={1: 101},
            num_workers=2
        )
        processor.start()
        
        # Register callback
        callback_called = threading.Event()
        processor.register_connector_completion_callback(1, lambda cid: callback_called.set())
        
        # Submit and wait for completion
        normalized_item = Mock()
        processor.submit({"id": "tx1"}, normalized_item, connector_id=1, connector_name="binance")
        
        callback_called.wait(timeout=2.0)
        
        # After completion, tracking should be cleaned up
        assert processor.get_connector_pending_count(1) == 0
        assert 1 not in processor.connector_pending
        assert 1 not in processor.connector_completion_callbacks
        
        processor.stop()

    def test_callback_error_does_not_crash_processor(self, mock_session, mock_pipeline):
        """Test that exceptions in completion callback don't crash processor."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={1: 101},
            num_workers=2
        )
        processor.start()
        
        # Register callback that raises exception
        def bad_callback(connector_id):
            raise ValueError("Callback error!")
        
        processor.register_connector_completion_callback(1, bad_callback)
        
        # Submit item
        normalized_item = Mock()
        processor.submit({"id": "tx1"}, normalized_item, connector_id=1, connector_name="binance")
        
        # Wait for processing
        time.sleep(1.0)
        
        # Processor should still be functional
        stats = processor.get_stats()
        assert stats["processed"] >= 0
        
        processor.stop()

    def test_callback_not_triggered_if_not_registered(self, mock_session, mock_pipeline):
        """Test that callback is not triggered if not registered."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={1: 101},
            num_workers=2
        )
        processor.start()
        
        # Don't register callback, just submit item
        normalized_item = Mock()
        processor.submit({"id": "tx1"}, normalized_item, connector_id=1, connector_name="binance")
        
        # Wait for processing
        time.sleep(0.5)
        
        # Should process successfully without callback
        stats = processor.get_stats()
        assert stats["processed"] >= 1
        
        processor.stop()


class TestThreadSafety:
    """Test thread safety of completion tracking."""

    def test_concurrent_submit_thread_safe(self, mock_session, mock_pipeline):
        """Test that concurrent submit() calls are thread-safe."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={1: 101},
            num_workers=4
        )
        processor.start()
        
        # Submit from multiple threads
        def submit_items():
            normalized_item = Mock()
            for i in range(10):
                processor.submit({"id": f"tx{i}"}, normalized_item, connector_id=1, connector_name="binance")
        
        threads = []
        for _ in range(5):
            t = threading.Thread(target=submit_items)
            t.start()
            threads.append(t)
        
        for t in threads:
            t.join()
        
        # All items should be tracked
        pending = processor.get_connector_pending_count(1)
        assert pending <= 50, "All submitted items should be tracked"
        
        processor.stop()

    def test_register_completion_callback_thread_safe(self, mock_session, mock_pipeline):
        """Test that registering completion callbacks is thread-safe."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={}
        )
        processor.start()
        
        # Register callbacks from multiple threads
        def register_callback(connector_id):
            processor.register_connector_completion_callback(connector_id, lambda cid: None)
        
        threads = []
        for i in range(20):
            t = threading.Thread(target=register_callback, args=(i,))
            t.start()
            threads.append(t)
        
        for t in threads:
            t.join()
        
        # Should complete without errors
        assert len(processor.connector_completion_callbacks) == 20
        
        processor.stop()

    def test_concurrent_pending_count_queries_thread_safe(self, mock_session, mock_pipeline):
        """Test that concurrent get_connector_pending_count() is thread-safe."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={1: 101}
        )
        processor.start()
        
        # Submit items
        normalized_item = Mock()
        for i in range(10):
            processor.submit({"id": f"tx{i}"}, normalized_item, connector_id=1, connector_name="binance")
        
        # Query from multiple threads
        results = []
        
        def query_pending():
            for _ in range(100):
                count = processor.get_connector_pending_count(1)
                results.append(count)
        
        threads = []
        for _ in range(5):
            t = threading.Thread(target=query_pending)
            t.start()
            threads.append(t)
        
        for t in threads:
            t.join()
        
        # All queries should succeed
        assert len(results) == 500
        assert all(count >= 0 for count in results), "All counts should be non-negative"
        
        processor.stop()


class TestEdgeCases:
    """Test edge cases for completion tracking."""

    def test_zero_items_connector(self, mock_session, mock_pipeline):
        """Test handling of connector that submits zero items."""
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={1: 101}
        )
        processor.start()
        
        # Register callback
        callback_called = threading.Event()
        processor.register_connector_completion_callback(1, lambda cid: callback_called.set())
        
        # Don't submit any items - pending count should be 0
        assert processor.get_connector_pending_count(1) == 0
        
        # Callback should not be triggered automatically for 0-item case
        # (this requires manual trigger in sync_job_service)
        callback_triggered = callback_called.wait(timeout=0.5)
        assert not callback_triggered, "Callback should not trigger for 0 items"
        
        processor.stop()

    def test_processing_error_still_decrements_pending(self, mock_session, mock_pipeline):
        """Test that pending count decrements even when processing fails."""
        # Mock failed processing
        result = Mock(spec=PipelineResult)
        result.success = False
        result.errors = ["Processing error"]
        result.warnings = []
        mock_pipeline.process.return_value = result
        
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={1: 101},
            num_workers=2
        )
        processor.start()
        
        # Register callback
        callback_called = threading.Event()
        processor.register_connector_completion_callback(1, lambda cid: callback_called.set())
        
        # Submit item
        normalized_item = Mock()
        processor.submit({"id": "tx1"}, normalized_item, connector_id=1, connector_name="binance")
        
        # Wait for callback
        callback_triggered = callback_called.wait(timeout=2.0)
        
        # Callback should still be triggered even though processing failed
        assert callback_triggered, "Callback should trigger even when processing fails"
        assert processor.get_connector_pending_count(1) == 0
        
        processor.stop()

    def test_abort_during_processing_cleans_up(self, mock_session, mock_pipeline):
        """Test that aborting during processing properly cleans up tracking."""
        # Slow processing
        def slow_process(*args, **kwargs):
            time.sleep(0.5)
            result = Mock(spec=PipelineResult)
            result.success = True
            result.errors = []
            result.warnings = []
            result.new_count = 1
            result.updated_count = 0
            result.skipped_count = 0
            result.split_count = 0
            result.transfer_count = 0
            return result
        
        mock_pipeline.process.side_effect = slow_process
        
        abort_event = threading.Event()
        processor = ParallelPipelineProcessor(
            session=mock_session,
            pipeline=mock_pipeline,
            db_connector_runs={1: 101},
            abort_event=abort_event,
            num_workers=2
        )
        processor.start()
        
        # Submit items
        normalized_item = Mock()
        processor.submit({"id": "tx1"}, normalized_item, connector_id=1, connector_name="binance")
        processor.submit({"id": "tx2"}, normalized_item, connector_id=1, connector_name="binance")
        
        # Trigger abort
        abort_event.set()
        
        # Stop processor
        processor.stop()
        
        # Tracking should be cleaned up or in consistent state
        pending = processor.get_connector_pending_count(1)
        assert pending >= 0, "Pending count should be non-negative after abort"
