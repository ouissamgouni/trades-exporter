"""
ParallelPipelineProcessor: Multi-threaded transaction pipeline processor.

Processes transactions from multiple connectors in parallel using a thread pool.
Uses a shared database session with locking for thread-safe operations.
"""

import threading
import time
from enum import Enum
from queue import Queue, Empty
from concurrent.futures import ThreadPoolExecutor
from typing import Optional, Dict, Any, Callable
from datetime import datetime

from sqlmodel import Session

from backend.config.loader import configure_logging
from backend.services.pipeline import TransactionPipeline, PipelineContext

log = configure_logging("parallel_pipeline_processor")


class PipelineStage(str, Enum):
    """Pipeline stages for progress tracking."""
    
    FETCH = "fetch"
    TRANSFER_DETECTION = "transfer_detection"
    ASSET_ENRICHMENT = "asset_enrichment"
    PERSISTENCE = "persistence"


class ParallelPipelineProcessor:
    """
    Multi-threaded pipeline processor with shared session.
    
    Processes items from a queue using multiple worker threads.
    Each worker acquires a lock on the shared database session before processing.
    Commits are done per-item for immediate visibility in database.
    """

    def __init__(
        self,
        session: Session,
        pipeline: TransactionPipeline,
        db_connector_runs: Dict[int, int],
        progress_callback: Optional[Callable] = None,
        abort_event: Optional[threading.Event] = None,
        num_workers: int = 4,
        queue_size: int = 500,
        renormalize_mode: bool = False,
    ):
        """
        Initialize the parallel pipeline processor.
        
        Args:
            session: SQLAlchemy session (shared across workers)
            pipeline: Transaction pipeline instance
            db_connector_runs: Map of connector_id -> run_id
            progress_callback: Optional callback for progress updates
            abort_event: Optional event for signaling abort
            num_workers: Number of worker threads
            queue_size: Maximum queue size (provides backpressure)
            renormalize_mode: If True, pass renormalize_mode to PipelineContext
        """
        self.session = session
        self.pipeline = pipeline
        self.db_connector_runs = db_connector_runs
        self.progress_callback = progress_callback
        self.abort_event = abort_event or threading.Event()
        self.num_workers = num_workers
        
        # Thread-safe queue for items
        self.input_queue: Queue = Queue(maxsize=queue_size)
        
        # Lock for session access
        self.session_lock = threading.Lock()
        
        # Lock for progress updates
        self.progress_lock = threading.Lock()
        
        # Statistics
        self.items_processed = 0
        self.items_succeeded = 0
        self.items_failed = 0
        
        # Per-connector tracking
        self.connector_pending: Dict[int, int] = {}  # connector_id -> pending count
        self.connector_completion_callbacks: Dict[int, Callable] = {}  # connector_id -> callback
        self.connector_lock = threading.Lock()  # Lock for connector tracking
        
        # Renormalize mode flag
        self.renormalize_mode = renormalize_mode
        
        # Executor for workers
        self.executor: Optional[ThreadPoolExecutor] = None
        
        log.info(f"🔧 Initialized ParallelPipelineProcessor with {num_workers} workers, queue size {queue_size}")

    def _worker(self, worker_id: int) -> None:
        """
        Worker thread that processes items from the queue.
        
        Args:
            worker_id: Unique identifier for this worker
        """
        log.debug(f"🏃 Worker {worker_id} started")
        
        while True:
            # Check for abort before pulling next item
            if self.abort_event.is_set():
                log.debug(f"🛑 Worker {worker_id} aborting (abort event set)")
                break

            try:
                # Get item from queue with timeout
                try:
                    item = self.input_queue.get(timeout=1)
                except Empty:
                    # Check for abort
                    if self.abort_event.is_set():
                        log.debug(f"🛑 Worker {worker_id} aborting (no more items)")
                        break
                    continue
                
                # Poison pill - stop worker
                if item is None:
                    self.input_queue.task_done()
                    log.debug(f"🛑 Worker {worker_id} received poison pill")
                    break
                
                # Process item
                raw_item, normalized_item, connector_id, connector_name = item
                
                try:
                    # Lock session for this item
                    with self.session_lock:
                        # Create pipeline context
                        connector_run_id = self.db_connector_runs.get(connector_id)
                        context = PipelineContext(
                            session=self.session,
                            raw_item=raw_item,
                            source=normalized_item.source,
                            connector_id=connector_id,
                            sync_connector_run_id=connector_run_id,
                            renormalize_mode=self.renormalize_mode,
                        )
                        
                        # Process through pipeline (includes commit)
                        result = self.pipeline.process(normalized_item, context)
                        
                        if result.success:
                            self.items_succeeded += 1
                            
                            # Call progress callback with thread-safe lock
                            if self.progress_callback:
                                with self.progress_lock:
                                    self.progress_callback(
                                        connector_id=connector_id,
                                        result=result,
                                        context=context,
                                    )
                        else:
                            self.items_failed += 1
                            for error in result.errors:
                                log.error(f"❌ Worker {worker_id}: {error}")
                            
                            # Report failure to progress tracker so error_count is updated
                            if self.progress_callback:
                                with self.progress_lock:
                                    self.progress_callback(
                                        connector_id=connector_id,
                                        result=result,
                                        context=context,
                                    )
                
                except Exception as e:
                    self.items_failed += 1
                    log.error(f"❌ Worker {worker_id} error processing item: {e}")
                    
                    # Rollback on error
                    with self.session_lock:
                        try:
                            self.session.rollback()
                        except Exception as rollback_err:
                            log.error(f"Failed to rollback: {rollback_err}")
                
                finally:
                    self.items_processed += 1
                    self.input_queue.task_done()
                    
                    # Decrement pending count for this connector
                    if connector_id is not None:
                        self._decrement_connector_pending(connector_id)
                    
            except Exception as e:
                log.error(f"❌ Worker {worker_id} unexpected error: {e}")
                break
        
        log.debug(f"🛑 Worker {worker_id} stopped")

    def start(self) -> None:
        """Start the worker threads."""
        if self.executor is not None:
            raise RuntimeError("Processor already started")
        
        self.executor = ThreadPoolExecutor(max_workers=self.num_workers)
        
        # Start workers
        for i in range(self.num_workers):
            self.executor.submit(self._worker, i)
        
        log.info(f"✅ Started {self.num_workers} worker threads")

    def submit(self, raw_item: Dict, normalized_item: Any, connector_id: int, connector_name: str) -> bool:
        """
        Submit an item for processing.
        
        Args:
            raw_item: Raw transaction data
            normalized_item: Normalized transaction
            connector_id: Connector ID
            connector_name: Connector name
            
        Returns:
            True if submitted, False if aborted
        """
        if self.abort_event.is_set():
            return False
        
        # Increment pending count for this connector
        if connector_id is not None:
            with self.connector_lock:
                self.connector_pending[connector_id] = self.connector_pending.get(connector_id, 0) + 1
        
        # Put in queue (blocks if full - provides backpressure)
        self.input_queue.put((raw_item, normalized_item, connector_id, connector_name))
        return True

    def stop(self, timeout: float = 60.0) -> None:
        """
        Stop the processor and wait for workers to finish.
        
        Sends poison pills to signal workers to exit after draining the queue.
        If abort_event was set externally, workers exit immediately.
        
        Args:
            timeout: Maximum time to wait for workers (seconds)
        """
        if self.executor is None:
            return
        
        log.info("⏹️ Stopping parallel processor...")
        
        # Send poison pills to stop workers (workers will finish current item first)
        for _ in range(self.num_workers):
            try:
                self.input_queue.put(None, timeout=2)
            except Exception:
                pass
        
        # Shutdown executor with timeout
        self.executor.shutdown(wait=False)
        
        # Wait for executor threads with bounded timeout
        deadline = time.monotonic() + timeout
        for t in list(self.executor._threads):
            remaining = max(0, deadline - time.monotonic())
            if remaining <= 0:
                break
            t.join(timeout=remaining)
        
        # If threads are still alive after timeout, force abort
        if any(t.is_alive() for t in self.executor._threads):
            self.abort_event.set()
        
        log.info(
            f"✅ Processor stopped. Processed: {self.items_processed}, "
            f"Succeeded: {self.items_succeeded}, Failed: {self.items_failed}"
        )

    def register_connector_completion_callback(self, connector_id: int, callback: Callable) -> None:
        """
        Register a callback to be invoked when all items for a connector are processed.
        
        Args:
            connector_id: Connector ID
            callback: Callback function to invoke (takes connector_id as argument)
        """
        with self.connector_lock:
            self.connector_completion_callbacks[connector_id] = callback
            log.debug(f"📝 Registered completion callback for connector {connector_id}")
    
    def _decrement_connector_pending(self, connector_id: int) -> None:
        """
        Decrement pending count for a connector and trigger completion callback if done.
        
        Args:
            connector_id: Connector ID
        """
        with self.connector_lock:
            if connector_id in self.connector_pending:
                self.connector_pending[connector_id] -= 1
                pending = self.connector_pending[connector_id]
                
                # Check if all items for this connector are processed
                if pending == 0:
                    log.debug(f"✅ Connector {connector_id} finished processing all items")
                    
                    # Trigger completion callback if registered
                    callback = self.connector_completion_callbacks.get(connector_id)
                    if callback:
                        try:
                            callback(connector_id)
                            log.debug(f"✅ Invoked completion callback for connector {connector_id}")
                        except Exception as e:
                            log.error(f"❌ Error in completion callback for connector {connector_id}: {e}")
                    else:
                        # ⚠️ Warning: callback should have been registered when connector started
                        log.warning(
                            f"⚠️ Connector {connector_id} pending count reached 0, "
                            f"but no callback was registered. This indicates a race condition "
                            f"where items were processed before callback registration."
                        )
                    
                    # Clean up
                    del self.connector_pending[connector_id]
                    if connector_id in self.connector_completion_callbacks:
                        del self.connector_completion_callbacks[connector_id]
    
    def get_connector_pending_count(self, connector_id: int) -> int:
        """
        Get the number of pending items for a connector.
        
        Args:
            connector_id: Connector ID
            
        Returns:
            Number of pending items (0 if connector not tracked)
        """
        with self.connector_lock:
            return self.connector_pending.get(connector_id, 0)

    def get_stats(self) -> Dict[str, int]:
        """Get processing statistics."""
        return {
            "processed": self.items_processed,
            "succeeded": self.items_succeeded,
            "failed": self.items_failed,
            "queued": self.input_queue.qsize(),
        }
