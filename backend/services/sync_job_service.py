"""
SyncJobService: Manages background sync jobs for fetching transactions from all sources.
Provides job state tracking, progress monitoring, and abort functionality.
"""

import threading
import traceback
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional
from sqlmodel import Session

from backend.config.loader import configure_logging, load_settings, is_test_mode
from backend.connectors.hub.connector_hub import ConnectorHub
from backend.db.database import get_engine
from backend.services.pipeline import (
    create_default_pipeline,
    PipelineContext,
)


class JobStatus(str, Enum):
    """Possible states for a sync job."""

    IDLE = "idle"
    RUNNING = "running"
    COMPLETED = "completed"
    ABORTED = "aborted"
    FAILED = "failed"


@dataclass
class JobProgress:
    """Tracks the progress of a sync job."""

    status: JobStatus = JobStatus.IDLE
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    total_processed: int = 0
    new_entries_added: int = 0
    entries_updated: int = 0
    duplicates_skipped: int = 0
    errors: List[str] = field(default_factory=list)
    current_connector: Optional[str] = None
    connectors_completed: List[str] = field(default_factory=list)
    total_connectors: int = 0
    abort_requested: bool = False
    error_message: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for API response."""
        return {
            "status": self.status.value,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "total_processed": self.total_processed,
            "new_entries_added": self.new_entries_added,
            "entries_updated": self.entries_updated,
            "duplicates_skipped": self.duplicates_skipped,
            "errors": self.errors[-50:],  # Limit to last 50 errors
            "error_count": len(self.errors),
            "current_connector": self.current_connector,
            "connectors_completed": self.connectors_completed,
            "total_connectors": self.total_connectors,
            "abort_requested": self.abort_requested,
            "error_message": self.error_message,
        }

    def reset(self):
        """Reset progress for a new job run."""
        self.status = JobStatus.IDLE
        self.started_at = None
        self.finished_at = None
        self.total_processed = 0
        self.new_entries_added = 0
        self.entries_updated = 0
        self.duplicates_skipped = 0
        self.errors = []
        self.current_connector = None
        self.connectors_completed = []
        self.total_connectors = 0
        self.abort_requested = False
        self.error_message = None


class SyncJobService:
    """
    Singleton service that manages sync job execution.

    Provides:
    - Starting sync jobs (with test_mode option)
    - Progress tracking during execution
    - Abort functionality
    - Job state persistence
    """

    _instance: Optional["SyncJobService"] = None
    _lock = threading.Lock()

    def __new__(cls):
        """Ensure singleton pattern."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        """Initialize the service (only once due to singleton)."""
        if self._initialized:
            return

        self._initialized = True
        self.progress = JobProgress()
        self._job_thread: Optional[threading.Thread] = None
        self._abort_event = threading.Event()
        self.logger = configure_logging("sync_job_service")
        self._settings = load_settings()
        self._use_database_connectors = self._settings.get(
            "use_database_connectors", False
        )

    def get_status(self) -> Dict[str, Any]:
        """Get the current job status and progress."""
        status = self.progress.to_dict()
        status["use_database_connectors"] = self._use_database_connectors
        status["test_mode"] = is_test_mode()
        return status

    def is_running(self) -> bool:
        """Check if a job is currently running."""
        return self.progress.status == JobStatus.RUNNING

    def set_use_database_connectors(self, use_database: bool) -> Dict[str, Any]:
        """
        Set whether to use database-configured connectors.

        Args:
            use_database: True to use database connectors, False for file-based

        Returns:
            Dict with status and current setting

        Raises:
            RuntimeError: If a job is currently running
        """
        if self.is_running():
            raise RuntimeError("Cannot change connector source while a job is running")

        self._use_database_connectors = use_database
        return {
            "status": "updated",
            "use_database_connectors": self._use_database_connectors,
            "message": f"Connector source set to {'database' if use_database else 'file-based'}",
        }

    def start_job(self) -> Dict[str, Any]:
        """
        Start a new sync job.

        Test mode is determined by the global is_test_mode() setting.

        Returns:
            Dict with status and message

        Raises:
            RuntimeError: If a job is already running
        """
        if self.is_running():
            raise RuntimeError(
                "A sync job is already running. Please wait for it to complete or abort it."
            )

        # Reset progress
        self.progress.reset()
        self._abort_event.clear()

        # Start the job in a background thread
        self._job_thread = threading.Thread(target=self._run_job, daemon=True)
        self._job_thread.start()

        test_mode = is_test_mode()
        return {
            "status": "started",
            "message": f"Sync job started in {'test' if test_mode else 'live'} mode",
            "test_mode": test_mode,
        }

    def abort_job(self) -> Dict[str, Any]:
        """
        Request abort of the current running job.

        Returns:
            Dict with status and message
        """
        if not self.is_running():
            return {"status": "not_running", "message": "No job is currently running"}

        self.progress.abort_requested = True
        self._abort_event.set()

        return {
            "status": "aborting",
            "message": "Abort request sent. Job will stop after current operation.",
        }

    def _run_job(self):
        """
        Execute the sync job in background thread.

        Test mode is determined by the global is_test_mode() setting.
        Uses the modular pipeline for transaction processing.
        """
        test_mode = is_test_mode()
        self.progress.status = JobStatus.RUNNING
        self.progress.started_at = datetime.now()

        connector_hub = None
        session = None

        try:
            self.logger.info(
                f"🚀 Starting sync job in {'TEST' if test_mode else 'LIVE'} mode"
            )

            # Create session for pipeline
            engine = get_engine()
            session = Session(engine)

            # Initialize connector hub (database or file-based)
            if self._use_database_connectors:
                self.logger.info("📊 Using database-configured connectors")
                # Lazy import to avoid circular dependency
                from backend.connectors.hub.database_connector_hub import (
                    DatabaseConnectorHub,
                )

                connector_hub = DatabaseConnectorHub(session)
            else:
                self.logger.info("📁 Using file-configured connectors")
                connector_hub = ConnectorHub()

            # Create pipeline with default stages (split, transfer detection, asset enrichment, persistence)
            pipeline = create_default_pipeline(session)

            enabled_connectors = connector_hub.get_enabled_connectors()
            self.progress.total_connectors = len(enabled_connectors)

            self.logger.info(
                f"📋 Processing {self.progress.total_connectors} connectors"
            )

            # Process each item from the connector hub
            for raw_item, normalized_item, error in connector_hub.yield_normalized():
                # Check for abort
                if self._abort_event.is_set():
                    self.logger.info("⚠️ Abort requested, stopping job...")
                    self.progress.status = JobStatus.ABORTED
                    break

                # Track current connector from raw_item metadata
                if raw_item and "_master_source" in raw_item:
                    current = raw_item["_master_source"]
                    if current != self.progress.current_connector:
                        if self.progress.current_connector:
                            self.progress.connectors_completed.append(
                                self.progress.current_connector
                            )
                        self.progress.current_connector = current

                # Handle errors from connector
                if error:
                    error_msg = f"[{self.progress.current_connector}] {error}"
                    self.progress.errors.append(error_msg)
                    self.logger.warning(f"⚠️ {error_msg}")
                    continue

                # Process normalized item through pipeline
                if normalized_item:
                    self.progress.total_processed += 1

                    try:
                        # Create pipeline context with raw item
                        context = PipelineContext(
                            session=session,
                            raw_item=raw_item,
                            source=normalized_item.source,
                        )

                        # Process through pipeline
                        result = pipeline.process(normalized_item, context)

                        if result.success:
                            # Update progress counters
                            # Count based on what the persistence stage reports
                            self.progress.new_entries_added += result.new_count
                            self.progress.entries_updated += result.updated_count
                            self.progress.duplicates_skipped += result.skipped_count

                            # Log splits
                            if result.split_count > 0:
                                self.logger.debug(
                                    f"Split transaction into {result.split_count + 1} legs"
                                )

                            # Log transfers
                            if result.transfer_count > 0:
                                self.logger.debug(
                                    f"Detected {result.transfer_count} internal transfer(s)"
                                )
                        else:
                            # Pipeline failed
                            for err in result.errors:
                                self.progress.errors.append(err)
                                self.logger.error(f"❌ Pipeline error: {err}")

                        # Log warnings
                        for warning in result.warnings:
                            self.logger.warning(f"⚠️ {warning}")

                    except Exception as pipeline_error:
                        error_msg = f"Pipeline error: {pipeline_error}"
                        self.progress.errors.append(error_msg)
                        self.logger.error(f"❌ {error_msg}")

            # Mark job as complete (if not aborted)
            if self.progress.status == JobStatus.RUNNING:
                self.progress.status = JobStatus.COMPLETED
                if self.progress.current_connector:
                    self.progress.connectors_completed.append(
                        self.progress.current_connector
                    )
                self.logger.info(
                    f"✅ Sync job completed. Added {self.progress.new_entries_added} new, "
                    f"updated {self.progress.entries_updated}, "
                    f"skipped {self.progress.duplicates_skipped} duplicates."
                )

        except Exception as e:
            self.progress.status = JobStatus.FAILED
            self.progress.error_message = str(e)
            self.logger.error(f"❌ Sync job failed: {e}")
            self.logger.error(traceback.format_exc())

        finally:
            self.progress.finished_at = datetime.now()
            self.progress.current_connector = None

            # Clean up resources
            if connector_hub and hasattr(connector_hub, "close"):
                try:
                    connector_hub.close()
                except Exception as e:
                    self.logger.error(f"Error closing connector hub: {e}")

            if session:
                try:
                    session.close()
                except Exception as e:
                    self.logger.error(f"Error closing session: {e}")


# Global instance getter
def get_sync_job_service() -> SyncJobService:
    """Get the singleton SyncJobService instance."""
    return SyncJobService()
