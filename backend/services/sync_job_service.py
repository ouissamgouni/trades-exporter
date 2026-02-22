"""
SyncJobService: Manages background sync jobs for fetching transactions from all sources.
Provides job state tracking, progress monitoring, and abort functionality.
"""

import os
import threading
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable, Dict, List, Optional
from sqlmodel import Session

from backend.config.loader import configure_logging, load_settings, get_connectors_output_path
from backend.connectors.base.connector_exceptions import ConnectorAPIError
from backend.connectors.hub.connector_hub import ConnectorHub
from backend.db.database import get_engine
from backend.services.pipeline import (
    create_default_pipeline,
    PipelineContext,
)
from backend.services.parallel_pipeline_processor import ParallelPipelineProcessor, PipelineStage


class JobStatus(str, Enum):
    """Possible states for a sync job."""

    IDLE = "idle"
    RUNNING = "running"
    COMPLETED = "completed"
    WARNING = "warning"
    ABORTED = "aborted"
    FAILED = "failed"


class ConnectorSyncStatus(str, Enum):
    """Possible states for individual connector sync."""
    
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    WARNING = "warning"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass
class LogEntry:
    """A single log entry for connector progress."""
    
    timestamp: datetime
    level: str
    message: str
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for API response."""
        return {
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            "level": self.level,
            "message": self.message,
        }


@dataclass
class StageStats:
    """Statistics for a single pipeline stage."""
    
    processed: int = 0
    success: int = 0
    failed: int = 0
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for API response."""
        return {
            "processed": self.processed,
            "success": self.success,
            "failed": self.failed,
        }


@dataclass
class ConnectorOverride:
    """Per-sync override for a single connector."""
    
    connector_id: int
    enabled: Optional[bool] = None
    test_mode: Optional[bool] = None
    test_file_path: Optional[str] = None
    since_datetime: Optional[datetime] = None
    symbols: Optional[List[str]] = None
    currencies: Optional[List[str]] = None
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "connector_id": self.connector_id,
            "enabled": self.enabled,
            "test_mode": self.test_mode,
            "test_file_path": self.test_file_path,
            "since_datetime": self.since_datetime.isoformat() if self.since_datetime else None,
            "symbols": self.symbols,
            "currencies": self.currencies,
        }


@dataclass
class ConnectorProgress:
    """Tracks progress for a single connector."""
    
    connector_id: int
    connector_type: str
    account_name: str
    status: ConnectorSyncStatus = ConnectorSyncStatus.QUEUED
    test_mode: bool = False
    connector_run_id: Optional[int] = None  # Database connector run ID for history tracking
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    processed: int = 0
    fetched_count: int = 0  # Items fetched from API (updated during fetch phase)
    new_count: int = 0
    updated_count: int = 0
    skipped_count: int = 0
    error: Optional[str] = None
    
    # Real-time progress fields
    current_operation: Optional[str] = None
    operation_progress: int = 0
    operation_total: int = 0
    pipeline_stage: Optional[PipelineStage] = None
    error_count: int = 0
    
    # Stage statistics (initialized in __post_init__)
    stage_stats: Dict[str, StageStats] = field(default_factory=dict)
    
    # Logs (capped list of log entries)
    logs: List[LogEntry] = field(default_factory=list)
    
    # Outcome tracking (IDs of synced/updated/skipped/error transactions)
    synced_ids: List[str] = field(default_factory=list)
    updated_ids: List[str] = field(default_factory=list)
    skipped_ids: List[str] = field(default_factory=list)
    error_details: List[Dict[str, str]] = field(default_factory=list)
    
    def __post_init__(self):
        """Initialize stage_stats for all pipeline stages."""
        if not self.stage_stats:
            self.stage_stats = {stage.value: StageStats() for stage in PipelineStage}
    
    def add_log(self, level: str, message: str, max_logs: int = 100):
        """Add a log entry, trimming to max_logs if needed."""
        self.logs.append(LogEntry(timestamp=datetime.now(), level=level, message=message))
        if len(self.logs) > max_logs:
            self.logs = self.logs[-max_logs:]
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for API response."""
        return {
            "connector_id": self.connector_id,
            "connector_type": self.connector_type,
            "account_name": self.account_name,
            "status": self.status.value,
            "test_mode": self.test_mode,
            "connector_run_id": self.connector_run_id,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "processed": self.processed,
            "fetched_count": self.fetched_count,
            "new_count": self.new_count,
            "updated_count": self.updated_count,
            "skipped_count": self.skipped_count,
            "error": self.error,
            "current_operation": self.current_operation,
            "operation_progress": self.operation_progress,
            "operation_total": self.operation_total,
            "pipeline_stage": self.pipeline_stage.value if self.pipeline_stage else None,
            "error_count": self.error_count,
            "stage_stats": {k: v.to_dict() for k, v in self.stage_stats.items()},
            "logs": [log.to_dict() for log in self.logs],
            "synced_ids": self.synced_ids,
            "updated_ids": self.updated_ids,
            "skipped_ids": self.skipped_ids,
            "error_details": self.error_details,
        }


@dataclass
class JobProgress:
    """Tracks the progress of a sync job."""

    status: JobStatus = JobStatus.IDLE
    job_id: Optional[int] = None  # Database job ID for history tracking
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
    # Per-connector status tracking
    connector_statuses: Dict[int, ConnectorProgress] = field(default_factory=dict)
    
    # Track last database update time per connector for periodic flushing
    _connector_last_db_update: Dict[int, datetime] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for API response."""
        return {
            "status": self.status.value,
            "job_id": self.job_id,
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
            "connector_statuses": {
                k: v.to_dict() for k, v in self.connector_statuses.items()
            },
        }

    def reset(self):
        """Reset progress for a new job run."""
        self.status = JobStatus.IDLE
        self.job_id = None
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
        self.connector_statuses = {}


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
        # Safety check: ensure progress is initialized
        if not hasattr(self, 'progress') or self.progress is None:
            self.progress = JobProgress()
        status = self.progress.to_dict()
        # Handle case where singleton was created before this attribute was added
        if not hasattr(self, '_use_database_connectors'):
            self._use_database_connectors = self._settings.get(
                "use_database_connectors", False
            ) if hasattr(self, '_settings') else False
        status["use_database_connectors"] = self._use_database_connectors
        status["renormalize"] = getattr(self, '_renormalize', False)
        return status

    def is_running(self) -> bool:
        """Check if a job is currently running."""
        # Safety check: ensure progress is initialized
        if not hasattr(self, 'progress') or self.progress is None:
            self.progress = JobProgress()
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

    def start_job(
        self,
        connector_overrides: Optional[List[ConnectorOverride]] = None,
        renormalize: bool = False,
    ) -> Dict[str, Any]:
        """
        Start a new sync job.

        Test mode is determined by the global is_test_mode() setting, unless
        overridden per-connector.

        Args:
            connector_overrides: Optional list of per-connector overrides containing:
                - enabled: Whether the connector is enabled
                - test_mode: Whether to use test mode for this connector
                - test_file_path: Path to test file (for test mode)
                - since_datetime: Sync from this datetime (None = full sync)
            renormalize: If True, re-normalize from stored raw data instead of
                fetching from external APIs.

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
        
        # Store overrides and renormalize flag for the job thread
        self._connector_overrides = connector_overrides
        self._renormalize = renormalize
        
        # Count how many overrides are configured
        overrides_count = len(connector_overrides) if connector_overrides else 0

        # Start the job in a background thread
        self._job_thread = threading.Thread(target=self._run_job, daemon=True)
        self._job_thread.start()

        job_type = "renormalize" if renormalize else "sync"
        return {
            "status": "started",
            "message": f"{'Re-normalization' if renormalize else 'Sync'} job started",
            "overrides_count": overrides_count,
            "renormalize": renormalize,
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

    def _persist_connector_status(
        self, 
        connector_id: int, 
        status: str, 
        error: Optional[str] = None
    ):
        """
        Persist connector status to AccountConnector table (thread-safe).
        
        Uses a fresh session per call to avoid concurrency issues with parallel processing.
        
        Args:
            connector_id: The AccountConnector ID
            status: New status ('pending', 'running', 'success', 'warning', 'failed')
            error: Optional error message if status is 'failed' or 'warning'
        """
        from backend.db.database import get_session
        from backend.db.models import AccountConnector
        
        try:
            with get_session() as fresh_session:
                connector = fresh_session.get(AccountConnector, connector_id)
                if connector:
                    connector.last_sync_status = status
                    if status in ["success", "warning", "failed"]:
                        connector.last_sync_at = datetime.now(timezone.utc)
                    if error:
                        connector.last_error = error
                    elif status == "success":
                        connector.last_error = None
                    fresh_session.add(connector)
                    fresh_session.commit()
                    self.logger.debug(f"📝 Persisted status '{status}' for connector {connector_id}")
        except Exception as e:
            self.logger.warning(f"⚠️ Failed to persist status for connector {connector_id}: {e}")

    def _handle_pipeline_result(
        self,
        connector_id: int,
        result: Any,
        context: Any,
        connector_progress_callback: Callable,
    ) -> None:
        """
        Handle pipeline processing result (called from worker threads).
        
        Args:
            connector_id: Connector ID
            result: Pipeline result
            context: Pipeline context
            connector_progress_callback: Callback for progress updates
        """
        # Update progress counters
        self.progress.new_entries_added += result.new_count
        self.progress.entries_updated += result.updated_count
        self.progress.duplicates_skipped += result.skipped_count
        
        # Update per-connector counts and aggregate outcome IDs
        if connector_id and connector_id in self.progress.connector_statuses:
            cstatus = self.progress.connector_statuses[connector_id]
            cstatus.new_count += result.new_count
            cstatus.updated_count += result.updated_count
            cstatus.skipped_count += result.skipped_count
            cstatus.pipeline_stage = PipelineStage.PERSISTENCE
            cstatus.current_operation = f"Processing item {cstatus.processed}"
            
            # Report updated metrics via progress callback for real-time updates
            connector_progress_callback(
                connector_id=connector_id,
                operation=f"Processing item {cstatus.processed}",
                current=cstatus.processed,
                total=cstatus.operation_total or cstatus.processed,
                new_count=cstatus.new_count,
                updated_count=cstatus.updated_count,
                skipped_count=cstatus.skipped_count,
            )
            
            # Aggregate outcome IDs from PersistenceResult
            if context.persistence_result:
                pr = context.persistence_result
                cstatus.synced_ids.extend(pr.synced_ids)
                cstatus.updated_ids.extend(pr.updated_ids)
                cstatus.skipped_ids.extend(pr.skipped_ids)
                cstatus.error_details.extend(pr.error_details)
                cstatus.error_count += len(pr.error_details)
                
                # Truncate outcome lists to prevent unbounded growth (keep last 1000)
                max_outcomes = 1000
                if len(cstatus.synced_ids) > max_outcomes:
                    cstatus.synced_ids = cstatus.synced_ids[-max_outcomes:]
                if len(cstatus.updated_ids) > max_outcomes:
                    cstatus.updated_ids = cstatus.updated_ids[-max_outcomes:]
                if len(cstatus.skipped_ids) > max_outcomes:
                    cstatus.skipped_ids = cstatus.skipped_ids[-max_outcomes:]
            
            # 📊 Periodically flush connector metrics to database for live viewing
            # Update every 5 seconds or every 50 items (whichever comes first)
            now = datetime.now()
            last_update = self.progress._connector_last_db_update.get(connector_id)
            should_update = (
                last_update is None or
                (now - last_update).total_seconds() >= 5.0 or
                cstatus.processed % 50 == 0
            )
            
            if should_update and hasattr(self, '_run_job_db_connector_runs'):
                db_connector_runs = self._run_job_db_connector_runs
                if connector_id in db_connector_runs:
                    run_id = db_connector_runs[connector_id]
                    self._update_connector_run_metrics(run_id, cstatus)
                    self.progress._connector_last_db_update[connector_id] = now

        # Log splits and transfers
        if result.split_count > 0:
            self.logger.debug(f"Split transaction into {result.split_count + 1} legs")
        if result.transfer_count > 0:
            self.logger.debug(f"Detected {result.transfer_count} internal transfer(s)")
        
        # Log warnings
        for warning in result.warnings:
            self.logger.warning(f"⚠️ {warning}")
        
        # Handle errors
        if not result.success:
            for err in result.errors:
                self.progress.errors.append(err)
                self.logger.error(f"❌ Pipeline error: {err}")
                if connector_id and connector_id in self.progress.connector_statuses:
                    cstatus = self.progress.connector_statuses[connector_id]
                    cstatus.error_count += 1
                    cstatus.add_log("ERROR", err)
    
    def _handle_connector_completion(self, connector_id: int) -> None:
        """
        Handle completion of all items for a connector (called from worker thread via callback).
        Transitions connector status from RUNNING to COMPLETED/WARNING and persists to database.
        
        Args:
            connector_id: Connector ID that finished processing
        """
        try:
            if connector_id not in self.progress.connector_statuses:
                self.logger.warning(f"⚠️ Completion callback for unknown connector {connector_id}")
                return
            
            cstatus = self.progress.connector_statuses[connector_id]
            
            # Only transition if still in RUNNING state
            if cstatus.status != ConnectorSyncStatus.RUNNING:
                self.logger.debug(f"ℹ️ Connector {connector_id} already in {cstatus.status} state, skipping completion")
                return
            
            # Mark as finished
            cstatus.finished_at = datetime.now()
            
            # Determine final status: WARNING if errors occurred, otherwise COMPLETED
            if cstatus.error_count > 0:
                cstatus.status = ConnectorSyncStatus.WARNING
                final_status_str = "warning"
                cstatus.add_log("WARNING", f"Completed with {cstatus.error_count} errors")
                self.logger.info(f"⚠️ Connector {connector_id} completed with warnings: {cstatus.error_count} errors")
            else:
                cstatus.status = ConnectorSyncStatus.COMPLETED
                final_status_str = "success"
                cstatus.add_log("INFO", "Completed successfully")
                self.logger.info(f"✅ Connector {connector_id} completed successfully")
            
            # Persist to database (AccountConnector.last_sync_status and SyncJobConnectorRun)
            self._persist_connector_status(connector_id, final_status_str, error=cstatus.error)
            
            # Update database connector run with final status
            from backend.db.database import get_session
            from backend.db.repositories.sync_job_repository import SyncJobRepository
            from backend.db.models import SyncJobConnectorStatus
            
            # Use a fresh session to avoid concurrency issues
            with get_session() as fresh_session:
                repo = SyncJobRepository(fresh_session)
                if hasattr(self, '_run_job_db_connector_runs'):
                    db_connector_runs = self._run_job_db_connector_runs
                    if connector_id in db_connector_runs:
                        run_id = db_connector_runs[connector_id]
                        db_status = SyncJobConnectorStatus.WARNING if cstatus.error_count > 0 else SyncJobConnectorStatus.COMPLETED
                        repo.update_connector_run_status(
                            run_id,
                            db_status,
                            finished_at=cstatus.finished_at,
                            error_message=cstatus.error if cstatus.error else None
                        )
                        fresh_session.commit()
                        self.logger.debug(f"📝 Updated connector run {run_id} to {db_status}")
            
            # Add to completed list for job-level tracking
            if cstatus.account_name not in self.progress.connectors_completed:
                self.progress.connectors_completed.append(cstatus.account_name)
            
            self.logger.info(
                f"✅ Connector {connector_id} ({cstatus.account_name}) finished: "
                f"fetched={cstatus.fetched_count}, new={cstatus.new_count}, "
                f"updated={cstatus.updated_count}, skipped={cstatus.skipped_count}, "
                f"errors={cstatus.error_count}"
            )
            
        except Exception as e:
            self.logger.error(f"❌ Error in connector completion handler for {connector_id}: {e}")
            import traceback
            self.logger.error(traceback.format_exc())
    
    def _update_connector_run_metrics(self, run_id: int, cstatus: ConnectorProgress) -> None:
        """
        Update connector run metrics in database (called periodically during processing).
        Uses a fresh session to avoid blocking the main thread.
        
        Args:
            run_id: Database connector run ID
            cstatus: Current connector status with metrics
        """
        try:
            from backend.db.database import get_session
            from backend.db.repositories.sync_job_repository import SyncJobRepository
            
            # Use a fresh session to avoid concurrency issues
            with get_session() as fresh_session:
                repo = SyncJobRepository(fresh_session)
                # Update only metrics, not status (status updates happen on transitions)
                repo.update_connector_run_metrics(
                    run_id=run_id,
                    processed=cstatus.processed,
                    synced_count=cstatus.new_count,
                    updated_count=cstatus.updated_count,
                    skipped_count=cstatus.skipped_count,
                    error_count=cstatus.error_count,
                    synced_ids=cstatus.synced_ids,
                    updated_ids=cstatus.updated_ids,
                    skipped_ids=cstatus.skipped_ids,
                    error_details=cstatus.error_details,
                    logs=[log.to_dict() for log in cstatus.logs],
                )
                fresh_session.commit()
                self.logger.debug(f"📝 Updated connector run {run_id} metrics in database")
        except Exception as e:
            # Don't fail the sync if database update fails
            self.logger.warning(f"⚠️ Failed to update connector run {run_id} metrics: {e}")
    
    def _run_job(self):
        """
        Execute the sync job in background thread.

        Test mode is determined by the global is_test_mode() setting.
        Uses the modular pipeline for transaction processing.
        Persists job and connector run records to database for history tracking.
        """
        self.progress.status = JobStatus.RUNNING
        self.progress.started_at = datetime.now()

        connector_hub = None
        session = None
        db_job = None  # Database job record for history tracking
        db_connector_runs: Dict[int, int] = {}  # connector_id -> SyncJobConnectorRun.id
        sync_job_repo = None  # Repository for job persistence
        
        # Store db_connector_runs for access by completion callback
        self._run_job_db_connector_runs = db_connector_runs
        
        # Get overrides passed from start_job
        connector_overrides: Optional[List[ConnectorOverride]] = getattr(self, '_connector_overrides', None)
        renormalize: bool = getattr(self, '_renormalize', False)
        
        # Build override lookup maps
        override_enabled: Dict[int, bool] = {}
        override_test_mode: Dict[int, bool] = {}
        override_test_file: Dict[int, str] = {}
        override_since: Dict[int, Optional[datetime]] = {}
        has_since_override: set = set()  # Track which connectors have explicit since override
        
        if connector_overrides:
            for o in connector_overrides:
                if o.enabled is not None:
                    override_enabled[o.connector_id] = o.enabled
                if o.test_mode is not None:
                    override_test_mode[o.connector_id] = o.test_mode
                if o.test_file_path is not None:
                    override_test_file[o.connector_id] = o.test_file_path
                # Track since_datetime override (can be explicitly None for full sync)
                if hasattr(o, 'since_datetime'):
                    has_since_override.add(o.connector_id)
                    override_since[o.connector_id] = o.since_datetime

        try:
            self.logger.info(
                f"🚀 Starting {'renormalize' if renormalize else 'sync'} job"
            )
            
            # Generate sync session timestamp and output path
            sync_timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            sync_output_path = os.path.join(get_connectors_output_path(), sync_timestamp)
            self.logger.info(f"📁 Sync output path: {sync_output_path}")

            # Create session for pipeline
            engine = get_engine()
            session = Session(engine)
            
            # --- Create database job record for history tracking ---
            from backend.db.repositories.sync_job_repository import SyncJobRepository
            sync_job_repo = SyncJobRepository(session)
            
            # Build config snapshot from overrides
            config_snapshot = {
                #"test_mode": False,
                "use_database_connectors": self._use_database_connectors,
                "renormalize": renormalize,
                "connector_overrides": [o.to_dict() for o in connector_overrides] if connector_overrides else [],
            }
            db_job = sync_job_repo.create_job(config_snapshot=config_snapshot)
            self.progress.job_id = db_job.id
            self.logger.info(f"📝 Created job record in database: job_id={db_job.id}")
            
            # Update status to PENDING and commit immediately so job appears in history
            from backend.db.models import SyncJobStatus
            sync_job_repo.update_job_status(db_job.id, SyncJobStatus.PENDING)
            session.commit()
            self.logger.info(f"⏳ Job {db_job.id} status updated to PENDING (initializing connectors)")

            # Initialize connector hub (database or file-based)
            if self._use_database_connectors:
                self.logger.info("📊 Using database-configured connectors")
                # Lazy import to avoid circular dependency
                from backend.connectors.hub.database_connector_hub import (
                    DatabaseConnectorHub,
                )
                from backend.db.repositories import NormalizedTransactionRepository
                
                # Compute since_datetime for each connector
                tx_repo = NormalizedTransactionRepository(session)
                connector_since_map: Dict[int, Optional[datetime]] = {}
                
                from backend.db.repositories import AccountConnectorRepository
                from backend.connectors.connector_registry import get_connector_registry
                
                repo = AccountConnectorRepository(session)
                registry = get_connector_registry()
                
                # Collect enabled connectors, filtering by overrides
                enabled_connectors = []
                for account_connector, account in repo.get_all():
                    connector_id = account_connector.id
                    
                    # Check if this connector is disabled by override
                   
                    enabled =  override_enabled.get(connector_id, account_connector.enabled) 
                    self.logger.info(f"⏭️ Connector {connector_id} ({account_connector.connector_type}) enabled status={enabled} {'(overridden)' if connector_id in override_enabled else ''} ")
          
                    if not enabled: 
                        continue

                    enabled_connectors.append((account_connector, account))
                    connector_info = registry.get(account_connector.connector_type)
                    
                    # Only compute since for connectors that support incremental sync
                    if connector_info and connector_info.supports_incremental_sync:
                        if connector_id in has_since_override:
                            # Use explicit override (can be None for full sync)
                            connector_since_map[connector_id] = override_since.get(connector_id)
                            if override_since.get(connector_id):
                                self.logger.info(
                                    f"📅 Connector {connector_id} using override since: {override_since[connector_id]}"
                                )
                            else:
                                self.logger.info(
                                    f"📅 Connector {connector_id} performing full sync (override)"
                                )
                        else:
                            # Compute default from max transaction datetime
                            max_dt = tx_repo.get_max_datetime_by_connector(connector_id)
                            connector_since_map[connector_id] = max_dt
                            if max_dt:
                                self.logger.info(
                                    f"📅 Connector {connector_id} computed since: {max_dt}"
                                )

                # Initialize per-connector statuses BEFORE creating hub
                # This ensures the progress callback can find connector IDs
                for account_connector, account in enabled_connectors:
                    config = account_connector.config or {}
                    connector_id = account_connector.id
                    
                    # Determine test mode: override > config > global
                    effective_test_mode = override_test_mode.get(
                        connector_id, config.get("test_mode", False)
                    )
                    
                    self.progress.connector_statuses[connector_id] = ConnectorProgress(
                        connector_id=connector_id,
                        connector_type=account_connector.connector_type,
                        account_name=account.name,
                        status=ConnectorSyncStatus.QUEUED,
                        test_mode=effective_test_mode,
                    )
                    
                    # Create database connector run record for history tracking
                    if db_job:
                        db_run = sync_job_repo.create_connector_run(
                            job_id=db_job.id,
                            connector_id=connector_id,
                            test_mode=effective_test_mode,
                        )
                        # Store connector type and account name on the run record
                        db_run.connector_type = account_connector.connector_type
                        db_run.account_name = account.name
                        session.add(db_run)
                        session.commit()
                        db_connector_runs[connector_id] = db_run.id
                        # Link the run ID back to the ConnectorProgress object
                        self.progress.connector_statuses[connector_id].connector_run_id = db_run.id
                        self.logger.debug(f"📝 Created connector run record: run_id={db_run.id} for connector {connector_id}")

                # Create progress callback to update ConnectorProgress during fetching
                def connector_progress_callback(
                    connector_id: int,
                    operation: str,
                    current: int,
                    total: int,
                    log_message: Optional[str] = None,
                    fetched_count: Optional[int] = None,
                    new_count: Optional[int] = None,
                    updated_count: Optional[int] = None,
                    skipped_count: Optional[int] = None,
                ):
                    """Update connector progress from child connectors, including metrics if provided."""
                    if connector_id in self.progress.connector_statuses:
                        cstatus = self.progress.connector_statuses[connector_id]
                        old_status = cstatus.status
                        
                        # Update in-memory progress
                        cstatus.current_operation = operation
                        cstatus.operation_progress = current
                        cstatus.operation_total = total
                        if fetched_count is not None:
                            cstatus.fetched_count = fetched_count
                        if new_count is not None:
                            cstatus.new_count = new_count
                        if updated_count is not None:
                            cstatus.updated_count = updated_count
                        if skipped_count is not None:
                            cstatus.skipped_count = skipped_count
                        if log_message:
                            cstatus.add_log("INFO", log_message)
                        
                        # Handle initialization lifecycle events from worker threads
                        # Persist status changes safely from main thread to avoid session conflicts
                        if operation == "Initializing connector" and cstatus.status == ConnectorSyncStatus.QUEUED:
                            # Connector started initializing
                            cstatus.status = ConnectorSyncStatus.RUNNING
                            cstatus.started_at = datetime.now()
                            self._persist_connector_status(connector_id, "running")
                            self.logger.debug(f"🔄 Connector {connector_id} started initialization")
                        elif operation == "Initialization failed":
                            # Connector failed during initialization
                            cstatus.status = ConnectorSyncStatus.FAILED
                            cstatus.finished_at = datetime.now()
                            # Extract detailed error from log message (format: ERROR_DETAIL:...)
                            if log_message and log_message.startswith("ERROR_DETAIL:"):
                                error_msg = log_message.replace("ERROR_DETAIL:", "", 1)
                                cstatus.error = error_msg
                            elif log_message and "failed:" in log_message:
                                error_msg = log_message.split("failed:", 1)[1].strip()
                                cstatus.error = error_msg
                            else:
                                cstatus.error = "Connector initialization failed"
                            self._persist_connector_status(connector_id, "failed", cstatus.error)
                            self.logger.warning(f"❌ Connector {connector_id} initialization failed: {cstatus.error[:100]}")
                        
                        # Note: QUEUED → RUNNING transition for fetching is handled in main loop when first item yields
                    else:
                        self.logger.warning(f"⚠️ Progress callback: connector_id={connector_id} not found in statuses")

                connector_hub = DatabaseConnectorHub(
                    session,
                    parent_output_path=sync_output_path,
                    connector_since_map=connector_since_map,
                    connector_overrides=connector_overrides,  # Pass enable/disable/test_mode overrides
                    progress_callback=connector_progress_callback,
                    renormalize_mode=renormalize,
                )
            else:
                self.logger.info("📁 Using file-configured connectors")
                connector_hub = ConnectorHub(parent_output_path=sync_output_path)

            # Create pipeline with default stages (split, transfer detection, asset enrichment, persistence)
            pipeline = create_default_pipeline(session)

            enabled_connectors = connector_hub.get_enabled_connectors()
            self.progress.total_connectors = len(enabled_connectors)

            self.logger.info(
                f"📋 Processing {self.progress.total_connectors} connectors"
            )
            self.logger.info(f"📋 Connector statuses initialized: {list(self.progress.connector_statuses.keys())}")
            
            # For DatabaseConnectorHub with lazy initialization, connectors will be
            # instantiated in worker threads. Status updates will come via progress callback.
            # For eager initialization (ConnectorHub), connectors are already instantiated.
            # In both cases, start all as QUEUED and let them transition based on actual execution.
            for cid, cstatus in self.progress.connector_statuses.items():
                cstatus.status = ConnectorSyncStatus.QUEUED
                self._persist_connector_status(cid, "pending")
                self.logger.debug(f"⏭️ Connector {cid} queued for execution")
            
            # Track current connector_id for status updates
            current_connector_id: Optional[int] = None
            item_count = 0

            # === Multi-threaded Pipeline Processing ===
            # Create parallel processor
            processor = ParallelPipelineProcessor(
                session=session,
                pipeline=pipeline,
                db_connector_runs=db_connector_runs,
                progress_callback=lambda connector_id, result, context: self._handle_pipeline_result(
                    connector_id, result, context, connector_progress_callback
                ),
                abort_event=self._abort_event,
                num_workers=4,
                queue_size=500,
                renormalize_mode=renormalize,
            )
            
            processor.start()
            
            self.logger.info("🔄 Starting to iterate over connector_hub.yield_normalized()...")
            
            # Track whether any connector has started running (for PENDING → RUNNING transition)
            job_running_status_set = False
            
            try:
                # Process each item from the connector hub
                for raw_item, normalized_item, error in connector_hub.yield_normalized():
                    item_count += 1
                    # Log first few items for debugging
                    if item_count <= 3:
                        connector = raw_item.get("_master_source", "unknown") if isinstance(raw_item, dict) else "unknown"
                        if normalized_item:
                            tx_type = normalized_item.transaction_type
                            tx_id = normalized_item.source_transaction_id
                            timestamp = normalized_item.date_time.isoformat() if normalized_item.date_time else "N/A"
                            amount = normalized_item.quantity
                            asset = normalized_item.source_asset_symbol
                        else:
                            tx_type = "N/A"
                            tx_id = "N/A"
                            timestamp = "N/A"
                            amount = "N/A"
                            asset = "N/A"
                        self.logger.info(
                            f"🔍 Item #{item_count} [{connector}]: type={tx_type}, "
                            f"id={tx_id}, timestamp={timestamp}, amount={amount} {asset}, "
                            f"has_error={error is not None}"
                        )
                        
                    # Check for abort
                    if self._abort_event.is_set():
                        self.logger.info("⚠️ Abort requested, stopping job...")
                        self.progress.status = JobStatus.ABORTED
                        # Mark remaining connectors as skipped
                        for cid, cstatus in self.progress.connector_statuses.items():
                            if cstatus.status == ConnectorSyncStatus.QUEUED:
                                cstatus.status = ConnectorSyncStatus.SKIPPED
                            elif cstatus.status == ConnectorSyncStatus.RUNNING:
                                cstatus.status = ConnectorSyncStatus.SKIPPED
                                cstatus.finished_at = datetime.now()
                        break

                    # Track current connector from raw_item metadata
                    if raw_item and "_master_source" in raw_item:
                        current = raw_item["_master_source"]
                        if current != self.progress.current_connector:
                            # Previous connector finished YIELDING items (not yet fully processed)
                            if self.progress.current_connector and current_connector_id:
                                if current_connector_id in self.progress.connector_statuses:
                                    cstatus = self.progress.connector_statuses[current_connector_id]
                                    if cstatus.status == ConnectorSyncStatus.RUNNING:
                                        # Mark as finishing (items still being processed in queue)
                                        cstatus.current_operation = "Finishing processing..."
                                        cstatus.add_log("INFO", f"Finished fetching {cstatus.fetched_count} items, processing queue...")
                                        self.logger.info(f"📥 Connector {current_connector_id} finished fetching, waiting for queue processing")
                                        
                                        # Note: Completion callback already registered when connector started (QUEUED→RUNNING)
                                        # Check for special case: 0 items fetched means completion is immediate
                                        pending_count = processor.get_connector_pending_count(current_connector_id)
                                        if pending_count == 0 and cstatus.fetched_count == 0:
                                            self.logger.info(f"ℹ️ Connector {current_connector_id} fetched 0 items - completing immediately")
                                            self._handle_connector_completion(current_connector_id)
                            
                            self.progress.current_connector = current
                            
                            # Try to extract connector_id from raw_item or master_source
                            new_connector_id = raw_item.get("_connector_id")
                            self.logger.debug(
                                f"🔍 Connector change detected: {current}, _connector_id={new_connector_id}, "
                                f"available_ids={list(self.progress.connector_statuses.keys())}"
                            )
                            if new_connector_id and new_connector_id in self.progress.connector_statuses:
                                current_connector_id = new_connector_id
                                cstatus = self.progress.connector_statuses[current_connector_id]
                                
                                # QUEUED → RUNNING transition - first item from this connector
                                if cstatus.status == ConnectorSyncStatus.QUEUED:
                                    cstatus.status = ConnectorSyncStatus.RUNNING
                                    cstatus.started_at = datetime.now()
                                    cstatus.current_operation = "Processing transactions"
                                    cstatus.pipeline_stage = PipelineStage.FETCH
                                    cstatus.add_log("INFO", f"Started sync for {cstatus.account_name}")
                                    # Persist RUNNING status to both AccountConnector and SyncJobConnectorRun
                                    self._persist_connector_status(current_connector_id, "running")
                                    # Update database connector run status in real-time
                                    if current_connector_id in db_connector_runs:
                                        from backend.db.models import SyncJobConnectorStatus
                                        run_id = db_connector_runs[current_connector_id]
                                        sync_job_repo.update_connector_run_status(
                                            run_id,
                                            SyncJobConnectorStatus.RUNNING,
                                            started_at=cstatus.started_at
                                        )
                                    
                                    self.logger.info(f"▶️ Connector {current_connector_id} ({current}) started: QUEUED → RUNNING")
                                
                                # ✅ Register completion callback for ANY connector entering the main loop,
                                # regardless of whether status was QUEUED or already RUNNING from
                                # lazy initialization in DatabaseConnectorHub worker threads.
                                def on_complete(connector_id: int):
                                    self._handle_connector_completion(connector_id)
                                
                                processor.register_connector_completion_callback(
                                    current_connector_id,
                                    on_complete
                                )
                                self.logger.debug(f"📝 Registered completion callback for connector {current_connector_id}")
                            else:
                                self.logger.warning(
                                    f"⚠️ Could not find connector_id {new_connector_id} in statuses. "
                                    f"Available: {list(self.progress.connector_statuses.keys())}"
                                )

                    # Handle errors from connector
                    if error:
                        error_msg = f"[{self.progress.current_connector}] {error}"
                        self.progress.errors.append(error_msg)
                        self.logger.warning(f"⚠️ {error_msg}")
                        # Track error in connector status
                        if current_connector_id and current_connector_id in self.progress.connector_statuses:
                            cstatus = self.progress.connector_statuses[current_connector_id]
                            cstatus.error = error
                            cstatus.error_count += 1
                            cstatus.add_log("ERROR", error_msg)
                        continue

                    # Process normalized item through parallel pipeline
                    if normalized_item:
                        self.progress.total_processed += 1
                        
                        # Update per-connector processed count
                        if current_connector_id and current_connector_id in self.progress.connector_statuses:
                            self.progress.connector_statuses[current_connector_id].processed += 1

                        # Submit to parallel processor (blocks if queue full - backpressure)
                        # Extract actual raw data from wrapped hub connector item
                        actual_raw_item = raw_item.get("raw_item") if isinstance(raw_item, dict) and "raw_item" in raw_item else raw_item
                        processor.submit(
                            raw_item=actual_raw_item,
                            normalized_item=normalized_item,
                            connector_id=current_connector_id,
                            connector_name=self.progress.current_connector,
                        )
            
            except ConnectorAPIError as e:
                # Fatal connector error - mark connector as FAILED
                self.logger.error(f"❌ Connector API error: {e}")
                
                # Determine which connector failed
                failed_connector_id = current_connector_id
                if failed_connector_id and failed_connector_id in self.progress.connector_statuses:
                    cstatus = self.progress.connector_statuses[failed_connector_id]
                    cstatus.status = ConnectorSyncStatus.FAILED
                    cstatus.finished_at = datetime.now()
                    cstatus.error = str(e)
                    cstatus.add_log("ERROR", f"Connector failed: {e}")
                    self._persist_connector_status(
                        failed_connector_id,
                        "failed",
                        error=str(e)
                    )
                    # Update database connector run status in real-time
                    if failed_connector_id in db_connector_runs:
                        from backend.db.models import SyncJobConnectorStatus
                        run_id = db_connector_runs[failed_connector_id]
                        sync_job_repo.update_connector_run_status(
                            run_id,
                            SyncJobConnectorStatus.FAILED,
                            error_message=str(e),
                            finished_at=cstatus.finished_at
                        )
                    self.logger.error(
                        f"❌ Connector {failed_connector_id} ({cstatus.connector_type}) "
                        f"marked as FAILED: {e.reason.value if hasattr(e, 'reason') else 'unknown'}"
                    )
                
                # Add to job-level errors
                error_msg = f"Connector failed: {e}"
                self.progress.errors.append(error_msg)
                self.progress.error_message = error_msg
                
                # Continue processing other connectors (don't abort entire job)
                self.logger.info("ℹ️ Continuing with remaining connectors...")
            
            except Exception as e:
                # Unexpected error - log and abort
                self.logger.error(f"❌ Unexpected error during sync: {e}")
                self.logger.error(traceback.format_exc())
                self.progress.status = JobStatus.FAILED
                self.progress.error_message = f"Unexpected error: {str(e)}"
                raise
            
            finally:
                # Stop processor and wait for workers to finish
                processor.stop(timeout=60)
                self.logger.info(f"📊 Processor stats: {processor.get_stats()}")
            
            # Mark job as complete (if not aborted)
            if self.progress.status == JobStatus.RUNNING:
                # Now that processor has stopped, mark any remaining RUNNING connectors as COMPLETED or WARNING
                # (most should have been handled by completion callbacks already)
                for cid, cstatus in self.progress.connector_statuses.items():
                    if cstatus.status == ConnectorSyncStatus.RUNNING:
                        self.logger.info(f"ℹ️ Connector {cid} still in RUNNING state after processor stopped - finalizing now")
                        # Set WARNING if connector has errors, otherwise COMPLETED
                        if cstatus.error_count > 0:
                            cstatus.status = ConnectorSyncStatus.WARNING
                            cstatus.finished_at = datetime.now()
                            cstatus.current_operation = None
                            cstatus.add_log("WARNING", f"Completed with {cstatus.error_count} errors: {cstatus.new_count} new, {cstatus.updated_count} updated, {cstatus.skipped_count} skipped")
                            self._persist_connector_status(cid, "warning")
                            # Update database connector run status
                            if cid in db_connector_runs:
                                from backend.db.models import SyncJobConnectorStatus
                                run_id = db_connector_runs[cid]
                                sync_job_repo.update_connector_run_status(
                                    run_id,
                                    SyncJobConnectorStatus.WARNING,
                                    finished_at=cstatus.finished_at
                                )
                            self.logger.warning(f"⚠️ Connector {cid} completed with {cstatus.error_count} errors")
                        else:
                            cstatus.status = ConnectorSyncStatus.COMPLETED
                            cstatus.finished_at = datetime.now()
                            cstatus.current_operation = None
                            cstatus.add_log("INFO", f"Completed sync: {cstatus.new_count} new, {cstatus.updated_count} updated, {cstatus.skipped_count} skipped")
                            self._persist_connector_status(cid, "success")
                            # Update database connector run status in real-time
                            if cid in db_connector_runs:
                                from backend.db.models import SyncJobConnectorStatus
                                run_id = db_connector_runs[cid]
                                sync_job_repo.update_connector_run_status(
                                    run_id,
                                    SyncJobConnectorStatus.COMPLETED,
                                    finished_at=cstatus.finished_at
                                )
                            self.logger.info(f"✅ Connector {cid} completed after processing queue")
                        # Add to completed list
                        connector_name = cstatus.connector_type
                        if connector_name not in self.progress.connectors_completed:
                            self.progress.connectors_completed.append(connector_name)
                
                # Mark any remaining queued connectors as completed (no data produced)
                for cid, cstatus in self.progress.connector_statuses.items():
                    if cstatus.status == ConnectorSyncStatus.QUEUED:
                        cstatus.status = ConnectorSyncStatus.COMPLETED
                        cstatus.finished_at = datetime.now()
                        cstatus.add_log("INFO", "Completed (no items fetched)")
                        # Don't persist for connectors that never ran
                
                # Determine job-level status based on connector outcomes
                has_failures = any(
                    cstatus.status == ConnectorSyncStatus.FAILED 
                    for cstatus in self.progress.connector_statuses.values()
                )
                has_warnings = any(
                    cstatus.status == ConnectorSyncStatus.WARNING or cstatus.error_count > 0
                    for cstatus in self.progress.connector_statuses.values()
                )
                
                if has_failures:
                    self.progress.status = JobStatus.FAILED
                    self.logger.warning(f"⚠️ Sync job completed with failures")
                elif has_warnings:
                    self.progress.status = JobStatus.WARNING
                    self.logger.warning(f"⚠️ Sync job completed with warnings ({self.progress.error_count} errors)")
                else:
                    self.progress.status = JobStatus.COMPLETED
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
            
            # --- Finalize database job and connector run records ---
            if db_job and session:
                try:
                    from backend.db.models import SyncJobStatus, SyncJobConnectorStatus, AccountConnector
                    
                    # Map internal status to database status
                    status_map = {
                        JobStatus.COMPLETED: SyncJobStatus.COMPLETED,
                        JobStatus.WARNING: SyncJobStatus.WARNING,
                        JobStatus.FAILED: SyncJobStatus.FAILED,
                        JobStatus.ABORTED: SyncJobStatus.ABORTED,
                    }
                    db_status = status_map.get(self.progress.status, SyncJobStatus.FAILED)
                    
                    # Update each connector run with final metrics and outcomes
                    for cid, cstatus in self.progress.connector_statuses.items():
                        if cid in db_connector_runs:
                            run_id = db_connector_runs[cid]
                            # Map connector status
                            connector_status_map = {
                                ConnectorSyncStatus.COMPLETED: SyncJobConnectorStatus.COMPLETED,
                                ConnectorSyncStatus.WARNING: SyncJobConnectorStatus.WARNING,
                                ConnectorSyncStatus.FAILED: SyncJobConnectorStatus.FAILED,
                                ConnectorSyncStatus.SKIPPED: SyncJobConnectorStatus.SKIPPED,
                                ConnectorSyncStatus.RUNNING: SyncJobConnectorStatus.COMPLETED,  # Still running = completed
                                ConnectorSyncStatus.QUEUED: SyncJobConnectorStatus.SKIPPED,  # Never started = skipped
                            }
                            db_connector_status = connector_status_map.get(cstatus.status, SyncJobConnectorStatus.COMPLETED)
                            
                            sync_job_repo.update_connector_run_status(
                                run_id, 
                                db_connector_status,
                                started_at=cstatus.started_at,
                                finished_at=cstatus.finished_at,
                            )
                            sync_job_repo.update_connector_run_metrics(
                                run_id,
                                processed=cstatus.processed,
                                synced_count=cstatus.new_count,
                                updated_count=cstatus.updated_count,
                                skipped_count=cstatus.skipped_count,
                                error_count=cstatus.error_count,
                            )
                            
                            # Persist outcome tracking (synced_ids, updated_ids, etc.)
                            sync_job_repo.update_connector_run_outcomes(
                                run_id,
                                synced_ids=cstatus.synced_ids,
                                updated_ids=cstatus.updated_ids,
                                skipped_ids=cstatus.skipped_ids,
                                error_details=cstatus.error_details,
                                logs=[log.to_dict() for log in cstatus.logs],
                            )
                            
                            self.logger.debug(
                                f"📝 Updated connector run {run_id}: processed={cstatus.processed}, "
                                f"new={cstatus.new_count}, updated={cstatus.updated_count}, "
                                f"synced_ids={len(cstatus.synced_ids)}, error_count={cstatus.error_count}"
                            )
                        
                        # Note: AccountConnector.last_sync_status already persisted in real-time
                        # via _persist_connector_status() calls during processing
                    
                    # Update job status and recalculate totals
                    sync_job_repo.update_job_status(
                        db_job.id, 
                        db_status, 
                        error_message=self.progress.error_message
                    )
                    sync_job_repo.recalculate_job_totals(db_job.id)
                    session.commit()
                    
                    self.logger.info(f"📝 Finalized job record in database: job_id={db_job.id}, status={db_status.value}")
                    
                except Exception as e:
                    self.logger.error(f"Error finalizing job record: {e}")
                    try:
                        session.rollback()
                    except:
                        pass

            # Clean up resources
            if connector_hub:
                # Call cleanup first to handle file deletion for file connectors
                if hasattr(connector_hub, "cleanup"):
                    try:
                        connector_hub.cleanup()
                        self.logger.info("🧹 Connector hub cleaned up")
                    except Exception as e:
                        self.logger.error(f"Error cleaning up connector hub: {e}")
                
                # Then close to release resources
                if hasattr(connector_hub, "close"):
                    try:
                        connector_hub.close()
                    except Exception as e:
                        self.logger.error(f"Error closing connector hub: {e}")

# Global instance getter
def get_sync_job_service() -> SyncJobService:
    """Get the singleton SyncJobService instance."""
    return SyncJobService()
