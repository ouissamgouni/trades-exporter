"""
Sync Job endpoints for the Trade Exporter API.
Provides endpoints for starting, monitoring, and aborting sync jobs.
"""

from datetime import datetime
from fastapi import APIRouter, HTTPException, Depends
from typing import Optional, List, Dict, Any
from pydantic import BaseModel
from sqlmodel import Session

from backend.db.database import get_session_dependency
from backend.services.sync_job_service import get_sync_job_service, ConnectorOverride
from backend.api.schemas import SyncJobStartRequest, ConnectorOverrideRequest

router = APIRouter(prefix="/sync-job", tags=["Sync Job"])


class ConnectorProgressResponse(BaseModel):
    """Response model for individual connector progress."""
    
    connector_id: int
    connector_type: str
    account_name: str
    status: str
    test_mode: bool = False
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    processed: int = 0
    new_count: int = 0
    updated_count: int = 0
    skipped_count: int = 0
    error_count: int = 0
    error: Optional[str] = None
    current_operation: Optional[str] = None
    operation_progress: int = 0
    operation_total: int = 0
    pipeline_stage: Optional[str] = None
    stage_stats: Optional[Dict[str, Any]] = None
    logs: Optional[List[Dict[str, Any]]] = None

    class Config:
        extra = "allow"


class JobStatusResponse(BaseModel):
    """Response model for job status."""

    status: str
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    total_processed: int = 0
    new_entries_added: int = 0
    entries_updated: int = 0
    duplicates_skipped: int = 0
    errors: list = []
    error_count: int = 0
    current_connector: Optional[str] = None
    connectors_completed: list = []
    total_connectors: int = 0
    abort_requested: bool = False
    error_message: Optional[str] = None
    use_database_connectors: bool = False
    connector_statuses: Optional[Dict[int, ConnectorProgressResponse]] = None

    class Config:
        extra = "allow"


class ConnectorSourceRequest(BaseModel):
    """Request model for setting connector source."""

    use_database: bool


class ConnectorDefaultInfo(BaseModel):
    """Information about a connector's default since datetime."""
    
    connector_id: int
    connector_type: str
    account_name: str
    display_name: str
    supports_incremental_sync: bool
    default_since_datetime: Optional[str] = None  # Computed from max transaction datetime


@router.get("/status", response_model=JobStatusResponse)
def get_job_status():
    """
    Get the current sync job status and progress.

    Returns detailed information about:
    - Current job status (idle, running, completed, aborted, failed)
    - Progress statistics (processed, added, skipped, errors)
    - Currently processing connector
    - Timing information
    """
    service = get_sync_job_service()
    return service.get_status()


@router.post("/start")
def start_sync_job(request: Optional[SyncJobStartRequest] = None):
    """
    Start a new sync job to fetch transactions from all sources.

    Test mode is determined by the TEST_MODE environment variable or settings.yaml,
    unless overridden per-connector in the request body.
    
    Args:
        request: Optional request body with:
            - connector_overrides: List of per-connector enable/disable/test_mode overrides
            - since_overrides: Dict mapping connector_id to since_datetime for incremental sync
    
    Returns an error if a job is already running.
    """
    service = get_sync_job_service()

    try:
        # Convert connector overrides (enable/disable, test mode) to internal format
        connector_overrides = None
        if request and request.connector_overrides:
            connector_overrides = [
                ConnectorOverride(
                    connector_id=o.connector_id,
                    enabled=o.enabled,
                    test_mode=o.test_mode,
                    test_file_path=o.test_file_path,
                )
                for o in request.connector_overrides
            ]
        
        # Parse since datetime overrides for incremental sync
        since_overrides = None
        if request and request.since_overrides:
            since_overrides = {}
            for connector_id, override in request.since_overrides.items():
                if override.since_datetime:
                    # Parse ISO datetime string
                    since_overrides[connector_id] = datetime.fromisoformat(
                        override.since_datetime.replace('Z', '+00:00')
                    )
                else:
                    # Explicit null means full sync (no since filter)
                    since_overrides[connector_id] = None
        
        result = service.start_job(
            connector_overrides=connector_overrides,
            since_overrides=since_overrides
        )
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start job: {str(e)}")


@router.get("/connector-defaults")
def get_connector_defaults(session: Session = Depends(get_session_dependency)):
    """
    Get default since_datetime for each enabled connector that supports incremental sync.
    
    Returns connectors with:
    - connector_id: Database ID
    - connector_type: Type string (e.g., "binance-transactions")
    - account_name: Associated account name
    - display_name: Human-readable connector name
    - supports_incremental_sync: Whether this connector supports the since parameter
    - default_since_datetime: Computed from max transaction datetime for this connector
    
    Only returns connectors that support incremental sync (CEX connectors).
    """
    from backend.connectors.connector_registry import get_connector_registry
    from backend.db.repositories import AccountConnectorRepository, NormalizedTransactionRepository
    
    try:
        registry = get_connector_registry()
        connector_repo = AccountConnectorRepository(session)
        tx_repo = NormalizedTransactionRepository(session)
        
        enabled_connectors = connector_repo.get_enabled()
        result = []
        
        for account_connector, account in enabled_connectors:
            connector_info = registry.get(account_connector.connector_type)
            if not connector_info:
                continue
            
            # Only include connectors that support incremental sync
            if not connector_info.supports_incremental_sync:
                continue
            
            # Get max datetime from transactions for this connector
            max_datetime = tx_repo.get_max_datetime_by_connector(account_connector.id)
            
            result.append(ConnectorDefaultInfo(
                connector_id=account_connector.id,
                connector_type=account_connector.connector_type,
                account_name=account.name,
                display_name=connector_info.display_name,
                supports_incremental_sync=connector_info.supports_incremental_sync,
                default_since_datetime=max_datetime.isoformat() if max_datetime else None,
            ))
        
        return {"connectors": result}
    
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to get connector defaults: {str(e)}"
        )


@router.post("/abort")
def abort_sync_job():
    """
    Request abort of the currently running sync job.

    The job will stop after completing its current operation.
    This is a graceful abort - the job status will change to 'aborted'.
    """
    service = get_sync_job_service()
    return service.abort_job()


@router.get("/connectors")
def get_available_connectors():
    """
    Get list of available connectors and their current initialization status.

    Returns information about which connectors are available for syncing.
    """
    from backend.connectors.connector_registry import get_connector_registry

    try:
        # Get connector info from the centralized registry
        registry = get_connector_registry()
        connector_types = registry.list_types()
        return {
            "available_connectors": connector_types,
            "connector_count": len(connector_types),
        }
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to get connectors: {str(e)}"
        )


@router.post("/connector-source")
def set_connector_source(request: ConnectorSourceRequest):
    """
    Set whether to use database-configured connectors or file-based connectors.

    - use_database=True: Load connectors from AccountConnector table
    - use_database=False: Use hardcoded ConnectorHub with settings.yaml
    """
    service = get_sync_job_service()

    try:
        result = service.set_use_database_connectors(request.use_database)
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to set connector source: {str(e)}"
        )
