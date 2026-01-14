"""
SyncJobService: Manages background sync jobs for fetching transactions from all sources.
Provides job state tracking, progress monitoring, and abort functionality.
"""

import os
import threading
import traceback
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional
from sqlmodel import Session

from backend.config.loader import configure_logging, load_settings, is_test_mode, get_connectors_output_path
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


class ConnectorSyncStatus(str, Enum):
    """Possible states for individual connector sync."""
    
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


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
    error: Optional[str] = None
    
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
            "error": self.error,
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
        # Handle case where singleton was created before this attribute was added
        if not hasattr(self, '_use_database_connectors'):
            self._use_database_connectors = self._settings.get(
                "use_database_connectors", False
            ) if hasattr(self, '_settings') else False
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

    def start_job(
        self,
        connector_overrides: Optional[List[ConnectorOverride]] = None,
        since_overrides: Optional[Dict[int, Optional[datetime]]] = None
    ) -> Dict[str, Any]:
        """
        Start a new sync job.

        Test mode is determined by the global is_test_mode() setting, unless
        overridden per-connector.

        Args:
            connector_overrides: Optional list of per-connector overrides for
                enable/disable and test mode settings.
            since_overrides: Optional dict mapping connector_id to since_datetime.
                - If since_datetime is provided, sync from that datetime
                - If since_datetime is None, perform full sync (no since filter)
                - If connector not in dict, use computed default (max transaction datetime)

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
        
        # Store overrides for the job thread
        self._connector_overrides = connector_overrides
        self._since_overrides = since_overrides
        
        # Count how many overrides are configured
        overrides_count = 0
        if connector_overrides:
            overrides_count += len(connector_overrides)
        if since_overrides:
            overrides_count += len(since_overrides)

        # Start the job in a background thread
        self._job_thread = threading.Thread(target=self._run_job, daemon=True)
        self._job_thread.start()

        test_mode = is_test_mode()
        return {
            "status": "started",
            "message": f"Sync job started in {'test' if test_mode else 'live'} mode",
            "test_mode": test_mode,
            "overrides_count": overrides_count,
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
        
        # Get overrides passed from start_job
        connector_overrides: Optional[List[ConnectorOverride]] = getattr(self, '_connector_overrides', None)
        since_overrides: Optional[Dict[int, Optional[datetime]]] = getattr(self, '_since_overrides', None)
        
        # Build override lookup maps
        override_enabled: Dict[int, bool] = {}
        override_test_mode: Dict[int, bool] = {}
        override_test_file: Dict[int, str] = {}
        
        if connector_overrides:
            for o in connector_overrides:
                if o.enabled is not None:
                    override_enabled[o.connector_id] = o.enabled
                if o.test_mode is not None:
                    override_test_mode[o.connector_id] = o.test_mode
                if o.test_file_path is not None:
                    override_test_file[o.connector_id] = o.test_file_path

        try:
            self.logger.info(
                f"🚀 Starting sync job in {'TEST' if test_mode else 'LIVE'} mode"
            )
            
            # Generate sync session timestamp and output path
            sync_timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            sync_output_path = os.path.join(get_connectors_output_path(), sync_timestamp)
            self.logger.info(f"📁 Sync output path: {sync_output_path}")

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
                for account_connector, account in repo.get_enabled():
                    connector_id = account_connector.id
                    
                    # Check if this connector is disabled by override
                    if connector_id in override_enabled and not override_enabled[connector_id]:
                        self.logger.info(f"⏭️ Connector {connector_id} ({account_connector.connector_type}) disabled by override, skipping")
                        continue
                    
                    enabled_connectors.append((account_connector, account))
                    connector_info = registry.get(account_connector.connector_type)
                    
                    # Only compute since for connectors that support incremental sync
                    if connector_info and connector_info.supports_incremental_sync:
                        if since_overrides and connector_id in since_overrides:
                            # Use explicit override (can be None for full sync)
                            connector_since_map[connector_id] = since_overrides[connector_id]
                            if since_overrides[connector_id]:
                                self.logger.info(
                                    f"📅 Connector {connector_id} using override since: {since_overrides[connector_id]}"
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

                connector_hub = DatabaseConnectorHub(
                    session,
                    parent_output_path=sync_output_path,
                    connector_since_map=connector_since_map,
                    connector_overrides=connector_overrides,  # Pass enable/disable/test_mode overrides
                )
                
                # Initialize per-connector statuses for database connectors
                for account_connector, account in enabled_connectors:
                    config = account_connector.config or {}
                    connector_id = account_connector.id
                    
                    # Determine test mode: override > config > global
                    effective_test_mode = override_test_mode.get(
                        connector_id, config.get("test_mode", test_mode)
                    )
                    
                    self.progress.connector_statuses[connector_id] = ConnectorProgress(
                        connector_id=connector_id,
                        connector_type=account_connector.connector_type,
                        account_name=account.name,
                        status=ConnectorSyncStatus.QUEUED,
                        test_mode=effective_test_mode,
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
            
            # Track current connector_id for status updates
            current_connector_id: Optional[int] = None

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
                        elif cstatus.status == ConnectorSyncStatus.RUNNING:
                            cstatus.status = ConnectorSyncStatus.SKIPPED
                            cstatus.finished_at = datetime.now()
                    break

                # Track current connector from raw_item metadata
                if raw_item and "_master_source" in raw_item:
                    current = raw_item["_master_source"]
                    if current != self.progress.current_connector:
                        # Mark previous connector as completed
                        if self.progress.current_connector and current_connector_id:
                            self.progress.connectors_completed.append(
                                self.progress.current_connector
                            )
                            if current_connector_id in self.progress.connector_statuses:
                                cstatus = self.progress.connector_statuses[current_connector_id]
                                if cstatus.status == ConnectorSyncStatus.RUNNING:
                                    cstatus.status = ConnectorSyncStatus.COMPLETED
                                    cstatus.finished_at = datetime.now()
                        
                        self.progress.current_connector = current
                        
                        # Try to extract connector_id from raw_item or master_source
                        new_connector_id = raw_item.get("_connector_id")
                        if new_connector_id and new_connector_id in self.progress.connector_statuses:
                            current_connector_id = new_connector_id
                            cstatus = self.progress.connector_statuses[current_connector_id]
                            cstatus.status = ConnectorSyncStatus.RUNNING
                            cstatus.started_at = datetime.now()

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
                        # Create pipeline context with raw item and connector_id
                        context = PipelineContext(
                            session=session,
                            raw_item=raw_item,
                            source=normalized_item.source,
                            connector_id=current_connector_id,
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
                # Mark last connector as completed
                if current_connector_id and current_connector_id in self.progress.connector_statuses:
                    cstatus = self.progress.connector_statuses[current_connector_id]
                    if cstatus.status == ConnectorSyncStatus.RUNNING:
                        cstatus.status = ConnectorSyncStatus.COMPLETED
                        cstatus.finished_at = datetime.now()
                # Mark any remaining queued connectors as completed (no data)
                for cid, cstatus in self.progress.connector_statuses.items():
                    if cstatus.status == ConnectorSyncStatus.QUEUED:
                        cstatus.status = ConnectorSyncStatus.COMPLETED
                        cstatus.finished_at = datetime.now()
                        
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
