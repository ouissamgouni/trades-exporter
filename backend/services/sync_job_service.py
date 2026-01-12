"""
SyncJobService: Manages background sync jobs for fetching transactions from all sources.
Provides job state tracking, progress monitoring, and abort functionality.
"""

import logging
import threading
import traceback
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Callable, Dict, List, Optional
from sqlmodel import Session

from backend.config.loader import configure_logging, load_settings
from backend.connectors.hub.connector_hub import ConnectorHub
from backend.db.database import get_engine
from backend.db.models import SyncJobStatus, SyncJobConnectorStatus
from backend.db.repositories import SyncJobRepository
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


class ConnectorSyncStatus(str, Enum):
    """Possible states for individual connector sync."""
    
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


class PipelineStage(str, Enum):
    """Pipeline stages for tracking progress."""
    
    FETCH = "fetch"
    TRANSFER_DETECTION = "transfer_detection"
    ASSET_ENRICHMENT = "asset_enrichment"
    PERSISTENCE = "persistence"


@dataclass
class LogEntry:
    """A single log entry for a connector."""
    
    timestamp: datetime
    level: str  # DEBUG, INFO, WARNING, ERROR
    message: str
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "timestamp": self.timestamp.isoformat(),
            "level": self.level,
            "message": self.message,
        }


@dataclass
class StageStats:
    """Statistics for a pipeline stage."""
    
    processed: int = 0
    success: int = 0
    failed: int = 0
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "processed": self.processed,
            "success": self.success,
            "failed": self.failed,
        }


@dataclass
class ConnectorProgress:
    """Tracks progress for a single connector."""
    
    connector_id: int
    connector_type: str
    account_name: str
    status: ConnectorSyncStatus = ConnectorSyncStatus.QUEUED
    test_mode: bool = False
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    processed: int = 0
    new_count: int = 0
    updated_count: int = 0
    skipped_count: int = 0
    error_count: int = 0  # Track error count alongside error string
    error: Optional[str] = None
    # New fields for detailed progress
    current_operation: Optional[str] = None
    operation_progress: int = 0
    operation_total: int = 0
    pipeline_stage: Optional[PipelineStage] = None
    stage_stats: Dict[str, StageStats] = field(default_factory=dict)
    logs: List[LogEntry] = field(default_factory=list)
    
    def __post_init__(self):
        # Initialize stage stats for all stages
        if not self.stage_stats:
            for stage in PipelineStage:
                self.stage_stats[stage.value] = StageStats()
    
    def add_log(self, level: str, message: str, max_logs: int = 100):
        """Add a log entry, keeping only the last max_logs entries."""
        self.logs.append(LogEntry(
            timestamp=datetime.now(),
            level=level,
            message=message,
        ))
        # Trim to max_logs
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
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "processed": self.processed,
            "new_count": self.new_count,
            "updated_count": self.updated_count,
            "skipped_count": self.skipped_count,
            "error_count": self.error_count,
            "error": self.error,
            # New fields
            "current_operation": self.current_operation,
            "operation_progress": self.operation_progress,
            "operation_total": self.operation_total,
            "pipeline_stage": self.pipeline_stage.value if self.pipeline_stage else None,
            "stage_stats": {k: v.to_dict() for k, v in self.stage_stats.items()},
            "logs": [log.to_dict() for log in self.logs[-50:]],  # Return last 50 logs in API
        }


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
    # Per-connector status tracking
    connector_statuses: Dict[int, ConnectorProgress] = field(default_factory=dict)
    # Database persistence tracking
    db_job_id: Optional[int] = None  # Persisted SyncJob.id
    db_connector_run_ids: Dict[int, int] = field(default_factory=dict)  # connector_id -> SyncJobConnectorRun.id

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
            "connector_statuses": {
                k: v.to_dict() for k, v in self.connector_statuses.items()
            },
            "job_id": self.db_job_id,  # Expose persisted job ID
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
        self.connector_statuses = {}
        self.db_job_id = None
        self.db_connector_run_ids = {}


class ConnectorLogHandler(logging.Handler):
    """
    Custom log handler that captures logs for a specific connector
    and appends them to the connector's progress.
    """
    
    def __init__(self, connector_progress: ConnectorProgress, max_logs: int = 100):
        super().__init__()
        self.connector_progress = connector_progress
        self.max_logs = max_logs
        self.setLevel(logging.DEBUG)
    
    def emit(self, record: logging.LogRecord):
        """Capture log record and add to connector progress."""
        try:
            self.connector_progress.add_log(
                level=record.levelname,
                message=self.format(record),
                max_logs=self.max_logs,
            )
        except Exception:
            self.handleError(record)


@dataclass
class ConnectorOverride:
    """Per-sync override for a single connector."""
    
    connector_id: int
    enabled: Optional[bool] = None
    test_mode: Optional[bool] = None
    test_file_path: Optional[str] = None
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "connector_id": self.connector_id,
            "enabled": self.enabled,
            "test_mode": self.test_mode,
            "test_file_path": self.test_file_path,
        }


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
        self._last_heartbeat_time: Optional[datetime] = None
        self._heartbeat_interval_seconds = 30  # Update heartbeat every 30 seconds
        
        # Clean up orphaned jobs from previous server crashes
        self._cleanup_orphaned_jobs_on_startup()

    def get_status(self) -> Dict[str, Any]:
        """Get the current job status and progress."""
        status = self.progress.to_dict()
        # Handle case where singleton was created before this attribute was added
        if not hasattr(self, '_use_database_connectors'):
            self._use_database_connectors = self._settings.get(
                "use_database_connectors", False
            ) if hasattr(self, '_settings') else False
        status["use_database_connectors"] = self._use_database_connectors
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

    def start_job(
        self,
        connector_overrides: Optional[List[ConnectorOverride]] = None,
    ) -> Dict[str, Any]:
        """
        Start a new sync job.

        Args:
            connector_overrides: Optional list of per-connector overrides for this sync.
                                Allows enabling/disabling connectors and setting test mode
                                without changing persistent configuration.

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
        
        # Store overrides for the job
        self._connector_overrides = connector_overrides or []

        # Start the job in a background thread
        self._job_thread = threading.Thread(target=self._run_job, daemon=True)
        self._job_thread.start()

        return {
            "status": "started",
            "message": "Sync job started",
            "overrides_count": len(self._connector_overrides),
        }

    def retry_connector(self, connector_id: int) -> Dict[str, Any]:
        """
        Retry a failed connector without restarting the entire job.
        
        Can only be called when job is completed/failed and the connector
        has failed status.
        
        Args:
            connector_id: ID of the connector to retry
            
        Returns:
            Dict with status and message
            
        Raises:
            RuntimeError: If job is running or connector not found/not failed
        """
        if self.is_running():
            raise RuntimeError("Cannot retry while a job is running")
        
        if connector_id not in self.progress.connector_statuses:
            raise RuntimeError(f"Connector {connector_id} not found in last job")
        
        cstatus = self.progress.connector_statuses[connector_id]
        if cstatus.status != ConnectorSyncStatus.FAILED:
            raise RuntimeError(f"Connector {connector_id} is not in failed state")
        
        # Reset this connector's status
        cstatus.status = ConnectorSyncStatus.QUEUED
        cstatus.error = None
        cstatus.started_at = None
        cstatus.finished_at = None
        cstatus.current_operation = None
        cstatus.operation_progress = 0
        cstatus.operation_total = 0
        cstatus.logs = []
        
        # Mark job as running again
        self.progress.status = JobStatus.RUNNING
        self.progress.finished_at = None
        self._abort_event.clear()
        
        # Store retry connector id
        self._retry_connector_id = connector_id
        
        # Start retry in background thread
        self._job_thread = threading.Thread(
            target=self._run_single_connector,
            args=(connector_id,),
            daemon=True
        )
        self._job_thread.start()
        
        return {
            "status": "retrying",
            "message": f"Retrying connector {cstatus.connector_type}",
            "connector_id": connector_id,
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

    def _cleanup_orphaned_jobs_on_startup(self):
        """
        Clean up any jobs that were left in 'running' state after a server crash.
        Called once during service initialization.
        """
        try:
            engine = get_engine()
            with Session(engine) as session:
                sync_job_repo = SyncJobRepository(session)
                result = sync_job_repo.cleanup_orphaned_jobs(stale_minutes=5)
                session.commit()
                
                if result["jobs_aborted"] > 0 or result["connector_runs_failed"] > 0:
                    self.logger.warning(
                        f"🧹 Cleaned up orphaned jobs on startup: "
                        f"{result['jobs_aborted']} jobs aborted, "
                        f"{result['connector_runs_failed']} connector runs marked as failed"
                    )
        except Exception as e:
            self.logger.error(f"Failed to cleanup orphaned jobs on startup: {e}")

    def _maybe_update_heartbeat(self, sync_job_repo: SyncJobRepository, session: Session):
        """
        Update heartbeat if enough time has passed since last update.
        Should be called periodically during sync processing.
        """
        if not self.progress.db_job_id:
            return
        
        now = datetime.now()
        if (
            self._last_heartbeat_time is None
            or (now - self._last_heartbeat_time).total_seconds() >= self._heartbeat_interval_seconds
        ):
            try:
                sync_job_repo.update_heartbeat(self.progress.db_job_id)
                session.commit()
                self._last_heartbeat_time = now
            except Exception as e:
                self.logger.warning(f"Failed to update heartbeat: {e}")

    def _run_job(self):
        """
        Execute the sync job in background thread.
        Uses the modular pipeline for transaction processing.
        """
        self.progress.status = JobStatus.RUNNING
        self.progress.started_at = datetime.now()

        connector_hub = None
        session = None
        log_handlers: Dict[int, ConnectorLogHandler] = {}
        sync_job_repo: Optional[SyncJobRepository] = None

        try:
            self.logger.info("🚀 Starting sync job")

            # Create session for pipeline
            engine = get_engine()
            session = Session(engine)
            
            # Initialize sync job repository
            sync_job_repo = SyncJobRepository(session)
            
            # Build overrides lookup
            overrides_map: Dict[int, ConnectorOverride] = {}
            if hasattr(self, '_connector_overrides') and self._connector_overrides:
                for override in self._connector_overrides:
                    overrides_map[override.connector_id] = override
                self.logger.info(f"📋 Applying {len(overrides_map)} connector overrides")
            
            # Create persisted SyncJob record
            config_snapshot = {
                "use_database_connectors": self._use_database_connectors,
                "overrides": [o.to_dict() for o in self._connector_overrides] if hasattr(self, '_connector_overrides') and self._connector_overrides else [],
            }
            db_job = sync_job_repo.create_job(config_snapshot=config_snapshot)
            self.progress.db_job_id = db_job.id
            sync_job_repo.update_job_status(db_job.id, SyncJobStatus.RUNNING)
            session.commit()
            self.logger.info(f"📝 Created sync job record (id={db_job.id})")

            # Initialize connector hub (database or file-based)
            if self._use_database_connectors:
                self.logger.info("📊 Using database-configured connectors")
                # Lazy import to avoid circular dependency
                from backend.connectors.hub.database_connector_hub import (
                    DatabaseConnectorHub,
                )

                connector_hub = DatabaseConnectorHub(
                    session,
                    connector_overrides=overrides_map,
                    progress_callback=self._create_progress_callback(),
                )
                
                # Initialize per-connector statuses for database connectors
                from backend.db.repositories import AccountConnectorRepository
                repo = AccountConnectorRepository(session)
                for account_connector, account in repo.get_enabled():
                    connector_id = account_connector.id
                    config = account_connector.config or {}
                    
                    # Check for overrides
                    override = overrides_map.get(connector_id)
                    if override and override.enabled is False:
                        # Skip this connector entirely
                        continue
                    
                    # Determine test mode (override takes precedence)
                    test_mode = config.get("test_mode", False)
                    if override and override.test_mode is not None:
                        test_mode = override.test_mode
                    
                    # Create in-memory status
                    self.progress.connector_statuses[connector_id] = ConnectorProgress(
                        connector_id=connector_id,
                        connector_type=account_connector.connector_type,
                        account_name=account.name,
                        status=ConnectorSyncStatus.QUEUED,
                        test_mode=test_mode,
                    )
                    
                    # Create persisted connector run record
                    db_run = sync_job_repo.create_connector_run(
                        job_id=db_job.id,
                        connector_id=connector_id,
                        test_mode=test_mode,
                    )
                    self.progress.db_connector_run_ids[connector_id] = db_run.id
                    
                # Update job totals
                sync_job_repo.update_job_totals(
                    db_job.id,
                    total_connectors=len(self.progress.connector_statuses),
                )
                session.commit()
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
            
            # Track current connector_id for status updates
            current_connector_id: Optional[int] = None
            # Track per-connector persistence results
            connector_persistence_results: Dict[int, Dict[str, Any]] = {}

            # Process each item from the connector hub
            for raw_item, normalized_item, error in connector_hub.yield_normalized():
                # Check for abort
                if self._abort_event.is_set():
                    self.logger.info("⚠️ Abort requested, stopping job...")
                    self.progress.status = JobStatus.ABORTED
                    # Mark remaining connectors as skipped
                    for cid, cstatus in self.progress.connector_statuses.items():
                        if cstatus.status == ConnectorSyncStatus.QUEUED:
                            cstatus.status = ConnectorSyncStatus.SKIPPED
                            if cid in self.progress.db_connector_run_ids and sync_job_repo:
                                sync_job_repo.update_connector_run_status(
                                    self.progress.db_connector_run_ids[cid],
                                    SyncJobConnectorStatus.SKIPPED,
                                )
                        elif cstatus.status == ConnectorSyncStatus.RUNNING:
                            cstatus.status = ConnectorSyncStatus.SKIPPED
                            cstatus.finished_at = datetime.now()
                            if cid in self.progress.db_connector_run_ids and sync_job_repo:
                                sync_job_repo.update_connector_run_status(
                                    self.progress.db_connector_run_ids[cid],
                                    SyncJobConnectorStatus.SKIPPED,
                                )
                    break

                # Track current connector from raw_item metadata
                if raw_item and "_master_source" in raw_item:
                    current = raw_item["_master_source"]
                    if current != self.progress.current_connector:
                        # Mark previous connector as completed and persist results
                        if self.progress.current_connector and current_connector_id:
                            self.progress.connectors_completed.append(
                                self.progress.current_connector
                            )
                            if current_connector_id in self.progress.connector_statuses:
                                cstatus = self.progress.connector_statuses[current_connector_id]
                                if cstatus.status == ConnectorSyncStatus.RUNNING:
                                    cstatus.status = ConnectorSyncStatus.COMPLETED
                                    cstatus.finished_at = datetime.now()
                                    
                                    # Persist final connector run results
                                    if current_connector_id in self.progress.db_connector_run_ids and sync_job_repo:
                                        self._persist_connector_run_results(
                                            sync_job_repo,
                                            current_connector_id,
                                            cstatus,
                                            connector_persistence_results.get(current_connector_id, {}),
                                        )
                                        session.commit()  # Commit after each connector to ensure durability
                        
                        self.progress.current_connector = current
                        
                        # Try to extract connector_id from raw_item or master_source
                        new_connector_id = raw_item.get("_connector_id")
                        if new_connector_id and new_connector_id in self.progress.connector_statuses:
                            current_connector_id = new_connector_id
                            cstatus = self.progress.connector_statuses[current_connector_id]
                            cstatus.status = ConnectorSyncStatus.RUNNING
                            cstatus.started_at = datetime.now()
                            
                            # Update DB status
                            if current_connector_id in self.progress.db_connector_run_ids and sync_job_repo:
                                sync_job_repo.update_connector_run_status(
                                    self.progress.db_connector_run_ids[current_connector_id],
                                    SyncJobConnectorStatus.RUNNING,
                                )
                            
                            # Initialize persistence results tracker for this connector
                            connector_persistence_results[current_connector_id] = {
                                "synced_ids": [],
                                "updated_ids": [],
                                "skipped_ids": [],
                                "error_details": [],
                            }

                # Handle errors from connector
                if error:
                    error_msg = f"[{self.progress.current_connector}] {error}"
                    self.progress.errors.append(error_msg)
                    self.logger.warning(f"⚠️ {error_msg}")
                    # Track error in connector status
                    if current_connector_id and current_connector_id in self.progress.connector_statuses:
                        self.progress.connector_statuses[current_connector_id].error = error
                    continue

                # Process normalized item through pipeline
                if normalized_item:
                    self.progress.total_processed += 1
                    
                    # Update per-connector processed count
                    if current_connector_id and current_connector_id in self.progress.connector_statuses:
                        self.progress.connector_statuses[current_connector_id].processed += 1

                    try:
                        # Get sync_connector_run_id for this transaction
                        sync_connector_run_id = None
                        if current_connector_id and current_connector_id in self.progress.db_connector_run_ids:
                            sync_connector_run_id = self.progress.db_connector_run_ids[current_connector_id]
                        
                        # Create pipeline context with raw item and sync tracking
                        context = PipelineContext(
                            session=session,
                            raw_item=raw_item,
                            source=normalized_item.source,
                            sync_connector_run_id=sync_connector_run_id,
                        )

                        # Process through pipeline
                        result = pipeline.process(normalized_item, context)

                        if result.success:
                            # Update progress counters
                            # Count based on what the persistence stage reports
                            self.progress.new_entries_added += result.new_count
                            self.progress.entries_updated += result.updated_count
                            self.progress.duplicates_skipped += result.skipped_count
                            
                            # Update per-connector counts
                            if current_connector_id and current_connector_id in self.progress.connector_statuses:
                                cstatus = self.progress.connector_statuses[current_connector_id]
                                cstatus.new_count += result.new_count
                                cstatus.updated_count += result.updated_count
                                cstatus.skipped_count += result.skipped_count
                                
                                # Track persistence results for this connector
                                if current_connector_id in connector_persistence_results:
                                    pr = connector_persistence_results[current_connector_id]
                                    if hasattr(result, 'persistence_result') and result.persistence_result:
                                        pr["synced_ids"].extend(result.persistence_result.synced_ids)
                                        pr["updated_ids"].extend(result.persistence_result.updated_ids)
                                        pr["skipped_ids"].extend(result.persistence_result.skipped_ids)
                                        pr["error_details"].extend(result.persistence_result.error_details)

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
                                # Track error details
                                if current_connector_id in connector_persistence_results:
                                    connector_persistence_results[current_connector_id]["error_details"].append({
                                        "source_transaction_id": normalized_item.source_transaction_id if normalized_item else "unknown",
                                        "error": err,
                                    })
                            # Track error count for connector
                            if current_connector_id and current_connector_id in self.progress.connector_statuses:
                                self.progress.connector_statuses[current_connector_id].error_count += len(result.errors)

                        # Log warnings
                        for warning in result.warnings:
                            self.logger.warning(f"⚠️ {warning}")

                    except Exception as pipeline_error:
                        error_msg = f"Pipeline error: {pipeline_error}"
                        self.progress.errors.append(error_msg)
                        self.logger.error(f"❌ {error_msg}")
                        # Track error count for connector
                        if current_connector_id and current_connector_id in self.progress.connector_statuses:
                            self.progress.connector_statuses[current_connector_id].error_count += 1
                    
                    # Periodically update heartbeat to indicate job is still alive
                    if sync_job_repo:
                        self._maybe_update_heartbeat(sync_job_repo, session)

            # Mark job as complete (if not aborted)
            if self.progress.status == JobStatus.RUNNING:
                self.progress.status = JobStatus.COMPLETED
                if self.progress.current_connector:
                    self.progress.connectors_completed.append(
                        self.progress.current_connector
                    )
                # Mark last connector as completed
                if current_connector_id and current_connector_id in self.progress.connector_statuses:
                    cstatus = self.progress.connector_statuses[current_connector_id]
                    if cstatus.status == ConnectorSyncStatus.RUNNING:
                        cstatus.status = ConnectorSyncStatus.COMPLETED
                        cstatus.finished_at = datetime.now()
                        
                        # Persist final connector run results
                        if current_connector_id in self.progress.db_connector_run_ids and sync_job_repo:
                            self._persist_connector_run_results(
                                sync_job_repo,
                                current_connector_id,
                                cstatus,
                                connector_persistence_results.get(current_connector_id, {}),
                            )
                            session.commit()  # Commit after last connector
                
                # Mark any remaining queued connectors as completed (no data)
                for cid, cstatus in self.progress.connector_statuses.items():
                    if cstatus.status == ConnectorSyncStatus.QUEUED:
                        cstatus.status = ConnectorSyncStatus.COMPLETED
                        cstatus.finished_at = datetime.now()
                        if cid in self.progress.db_connector_run_ids and sync_job_repo:
                            sync_job_repo.complete_connector_run(
                                self.progress.db_connector_run_ids[cid],
                                processed=0,
                                synced_count=0,
                                updated_count=0,
                                skipped_count=0,
                                error_count=0,
                                synced_ids=[],
                                updated_ids=[],
                                skipped_ids=[],
                                error_details=[],
                            )
                            session.commit()  # Commit queued connector updates
                
                # Update job final status
                if sync_job_repo and self.progress.db_job_id:
                    sync_job_repo.update_job_status(self.progress.db_job_id, SyncJobStatus.COMPLETED)
                    sync_job_repo.recalculate_job_totals(self.progress.db_job_id)
                    session.commit()
                        
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
            
            # Update DB job status
            if sync_job_repo and self.progress.db_job_id:
                try:
                    sync_job_repo.update_job_status(
                        self.progress.db_job_id,
                        SyncJobStatus.FAILED,
                        error_message=str(e),
                    )
                    session.commit()
                except Exception as db_err:
                    self.logger.error(f"Failed to update job status in DB: {db_err}")

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
    
    def _persist_connector_run_results(
        self,
        sync_job_repo: SyncJobRepository,
        connector_id: int,
        cstatus: ConnectorProgress,
        persistence_results: Dict[str, Any],
    ):
        """
        Persist final results for a completed connector run.
        
        Args:
            sync_job_repo: Repository instance
            connector_id: Connector ID
            cstatus: In-memory connector progress
            persistence_results: Accumulated persistence results (synced_ids, updated_ids, etc.)
        """
        if connector_id not in self.progress.db_connector_run_ids:
            return
        
        run_id = self.progress.db_connector_run_ids[connector_id]
        
        # Determine final status
        db_status = SyncJobConnectorStatus.COMPLETED
        if cstatus.status == ConnectorSyncStatus.FAILED:
            db_status = SyncJobConnectorStatus.FAILED
        elif cstatus.status == ConnectorSyncStatus.SKIPPED:
            db_status = SyncJobConnectorStatus.SKIPPED
        
        # Get logs as JSON-serializable list
        logs = [log.to_dict() for log in cstatus.logs]
        
        # Complete the connector run with all data
        sync_job_repo.complete_connector_run(
            run_id=run_id,
            processed=cstatus.processed,  # Model uses 'processed' not 'processed_count'
            synced_count=cstatus.new_count,
            updated_count=cstatus.updated_count,
            skipped_count=cstatus.skipped_count,
            error_count=len(persistence_results.get("error_details", [])),
            synced_ids=persistence_results.get("synced_ids", []),
            updated_ids=persistence_results.get("updated_ids", []),
            skipped_ids=persistence_results.get("skipped_ids", []),
            error_details=persistence_results.get("error_details", []),
        )
        
        # Update status if not completed
        if db_status != SyncJobConnectorStatus.COMPLETED:
            sync_job_repo.update_connector_run_status(run_id, db_status, cstatus.error)

    def _create_progress_callback(self) -> Callable[[int, str, int, int, str], None]:
        """
        Create a progress callback function for connectors to report their progress.
        
        Returns:
            Callback function that updates connector progress
        """
        def progress_callback(
            connector_id: int,
            operation: str,
            current: int,
            total: int,
            log_message: Optional[str] = None,
        ):
            """Update progress for a connector."""
            if connector_id in self.progress.connector_statuses:
                cstatus = self.progress.connector_statuses[connector_id]
                cstatus.current_operation = operation
                cstatus.operation_progress = current
                cstatus.operation_total = total
                
                # If connector is reporting progress, it should be running
                if cstatus.status == ConnectorSyncStatus.QUEUED:
                    cstatus.status = ConnectorSyncStatus.RUNNING
                    cstatus.started_at = datetime.now()
                
                # Add log if provided
                if log_message:
                    cstatus.add_log("INFO", log_message)
        
        return progress_callback

    def _run_single_connector(self, connector_id: int):
        """
        Run a single connector (for retry functionality).
        
        Args:
            connector_id: ID of the connector to run
        """
        session = None
        
        try:
            self.logger.info(f"🔄 Retrying connector {connector_id}")
            
            # Update status
            cstatus = self.progress.connector_statuses[connector_id]
            cstatus.status = ConnectorSyncStatus.RUNNING
            cstatus.started_at = datetime.now()
            cstatus.add_log("INFO", "Starting retry...")
            
            # Create session
            engine = get_engine()
            session = Session(engine)
            
            # Load connector from database
            from backend.services.connector_loader_service import ConnectorLoaderService
            loader = ConnectorLoaderService(session)
            
            connector_instance = loader.load_connector_by_id(
                connector_id,
                progress_callback=self._create_progress_callback(),
            )
            
            if not connector_instance:
                raise RuntimeError(f"Failed to load connector {connector_id}")
            
            # Create pipeline
            pipeline = create_default_pipeline(session)
            
            # Process items from the connector
            cstatus.pipeline_stage = PipelineStage.FETCH
            cstatus.add_log("INFO", "Fetching data...")
            
            for raw_item, normalized_item, error in connector_instance.yield_normalized():
                # Check for abort
                if self._abort_event.is_set():
                    self.logger.info("⚠️ Abort requested during retry")
                    cstatus.status = ConnectorSyncStatus.SKIPPED
                    cstatus.finished_at = datetime.now()
                    self.progress.status = JobStatus.ABORTED
                    return
                
                if error:
                    cstatus.add_log("ERROR", f"Error: {error}")
                    self.progress.errors.append(f"[{cstatus.connector_type}] {error}")
                    continue
                
                if normalized_item:
                    cstatus.processed += 1
                    self.progress.total_processed += 1
                    
                    # Add connector metadata to raw_item
                    if raw_item:
                        raw_item["_connector_id"] = connector_id
                        raw_item["_master_source"] = cstatus.connector_type
                    
                    try:
                        cstatus.pipeline_stage = PipelineStage.PERSISTENCE
                        
                        context = PipelineContext(
                            session=session,
                            raw_item=raw_item,
                            source=normalized_item.source,
                        )
                        
                        result = pipeline.process(normalized_item, context)
                        
                        if result.success:
                            self.progress.new_entries_added += result.new_count
                            self.progress.entries_updated += result.updated_count
                            self.progress.duplicates_skipped += result.skipped_count
                            cstatus.new_count += result.new_count
                            cstatus.updated_count += result.updated_count
                            cstatus.skipped_count += result.skipped_count
                        else:
                            for err in result.errors:
                                cstatus.add_log("ERROR", f"Pipeline: {err}")
                                self.progress.errors.append(err)
                    
                    except Exception as pipeline_error:
                        cstatus.add_log("ERROR", f"Pipeline error: {pipeline_error}")
                        self.progress.errors.append(str(pipeline_error))
            
            # Success
            cstatus.status = ConnectorSyncStatus.COMPLETED
            cstatus.finished_at = datetime.now()
            cstatus.add_log("INFO", f"Completed: {cstatus.new_count} new, {cstatus.updated_count} updated")
            self.logger.info(f"✅ Retry completed for connector {connector_id}")
            
            # Update overall job status
            if self.progress.status == JobStatus.RUNNING:
                # Check if all connectors are done
                all_done = all(
                    cs.status in [ConnectorSyncStatus.COMPLETED, ConnectorSyncStatus.SKIPPED, ConnectorSyncStatus.FAILED]
                    for cs in self.progress.connector_statuses.values()
                )
                if all_done:
                    has_failures = any(
                        cs.status == ConnectorSyncStatus.FAILED
                        for cs in self.progress.connector_statuses.values()
                    )
                    self.progress.status = JobStatus.COMPLETED if not has_failures else JobStatus.FAILED
        
        except Exception as e:
            self.logger.error(f"❌ Retry failed for connector {connector_id}: {e}")
            self.logger.error(traceback.format_exc())
            
            if connector_id in self.progress.connector_statuses:
                cstatus = self.progress.connector_statuses[connector_id]
                cstatus.status = ConnectorSyncStatus.FAILED
                cstatus.error = str(e)
                cstatus.finished_at = datetime.now()
                cstatus.add_log("ERROR", f"Failed: {e}")
            
            self.progress.status = JobStatus.FAILED
        
        finally:
            self.progress.finished_at = datetime.now()
            
            if session:
                try:
                    session.close()
                except Exception as e:
                    self.logger.error(f"Error closing session: {e}")


# Global instance getter
def get_sync_job_service() -> SyncJobService:
    """Get the singleton SyncJobService instance."""
    return SyncJobService()
