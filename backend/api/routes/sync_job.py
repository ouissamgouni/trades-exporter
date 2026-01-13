"""
Sync Job endpoints for the Trade Exporter API.
Provides endpoints for starting, monitoring, and aborting sync jobs.
"""

from fastapi import APIRouter, HTTPException
from typing import Optional, List, Dict, Any
from pydantic import BaseModel

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
        request: Optional request body with connector overrides for this sync only.
                 Overrides do not modify persistent connector configuration.
    
    Returns an error if a job is already running.
    """
    service = get_sync_job_service()

    try:
        # Convert request overrides to internal format
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
        
        result = service.start_job(connector_overrides=connector_overrides)
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start job: {str(e)}")


@router.post("/abort")
def abort_sync_job():
    """
    Request abort of the currently running sync job.

    The job will stop after completing its current operation.
    This is a graceful abort - the job status will change to 'aborted'.
    """
    service = get_sync_job_service()
    return service.abort_job()


@router.post("/retry/{connector_id}")
def retry_connector(connector_id: int):
    """
    Retry a failed connector from the last sync job.
    
    Can only be called when the job is completed/failed and the specified
    connector has a failed status.
    
    Args:
        connector_id: ID of the connector to retry
    
    Returns:
        Status of the retry operation
        
    Raises:
        409: If a job is currently running or connector is not retryable
        404: If connector not found in last job
    """
    service = get_sync_job_service()
    
    try:
        result = service.retry_connector(connector_id)
        return result
    except RuntimeError as e:
        error_msg = str(e)
        if "not found" in error_msg.lower():
            raise HTTPException(status_code=404, detail=error_msg)
        raise HTTPException(status_code=409, detail=error_msg)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to retry connector: {str(e)}")


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


@router.get("/enabled-connectors")
def get_enabled_connectors():
    """
    Get list of enabled connectors with their current configuration.
    
    Returns connectors that will be included in sync, with their
    current settings for test mode, etc. Used by the sync config panel.
    """
    from backend.db.database import get_engine
    from backend.db.repositories import AccountConnectorRepository
    from sqlmodel import Session
    
    try:
        engine = get_engine()
        with Session(engine) as session:
            repo = AccountConnectorRepository(session)
            enabled = repo.get_enabled()
            
            result = []
            for account_connector, account in enabled:
                config = account_connector.config or {}
                result.append({
                    "connector_id": account_connector.id,
                    "connector_type": account_connector.connector_type,
                    "account_id": account.id,
                    "account_name": account.name,
                    "account_type": account.account_type,
                    "enabled": account_connector.enabled,
                    "test_mode": config.get("test_mode", False),
                    "test_file_path": config.get("test_file_path"),
                    "sync_priority": account_connector.sync_priority,
                    "last_sync_at": account_connector.last_sync_at.isoformat() if account_connector.last_sync_at else None,
                    "last_sync_status": account_connector.last_sync_status,
                })
            
            return {
                "connectors": result,
                "count": len(result),
            }
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to get enabled connectors: {str(e)}"
        )


@router.get("/all-connectors")
def get_all_connectors():
    """
    Get ALL connectors (enabled and disabled) with their current configuration.
    
    Returns all connectors with account info, used by the sync config panel
    to allow users to enable/disable any connector for a sync run.
    Grouped by account for better organization.
    """
    from backend.db.database import get_engine
    from backend.db.repositories import AccountConnectorRepository
    from backend.db.models import Account
    from sqlmodel import Session, select
    
    try:
        engine = get_engine()
        with Session(engine) as session:
            connector_repo = AccountConnectorRepository(session)
            
            # Get all connectors with accounts
            all_connectors = connector_repo.get_all_with_accounts()
            
            # Get all accounts for account-level info
            statement = select(Account).order_by(Account.name)
            all_accounts = list(session.exec(statement).all())
            
            # Build connector list
            connectors_result = []
            for account_connector, account in all_connectors:
                config = account_connector.config or {}
                connectors_result.append({
                    "connector_id": account_connector.id,
                    "connector_type": account_connector.connector_type,
                    "account_id": account.id,
                    "account_name": account.name,
                    "account_type": account.account_type,
                    "account_enabled": account.enabled,
                    "enabled": account_connector.enabled,
                    "test_mode": config.get("test_mode", False),
                    "test_file_path": config.get("test_file_path"),
                    "sync_priority": account_connector.sync_priority,
                    "last_sync_at": account_connector.last_sync_at.isoformat() if account_connector.last_sync_at else None,
                    "last_sync_status": account_connector.last_sync_status,
                })
            
            # Build accounts summary list
            accounts_result = [
                {
                    "id": acc.id,
                    "name": acc.name,
                    "account_type": acc.account_type,
                    "enabled": acc.enabled,
                }
                for acc in all_accounts
            ]
            
            return {
                "connectors": connectors_result,
                "accounts": accounts_result,
                "connector_count": len(connectors_result),
                "account_count": len(accounts_result),
            }
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to get all connectors: {str(e)}"
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


# ============================================================================
# Job History & Details Endpoints
# ============================================================================


class SyncJobSummary(BaseModel):
    """Summary of a sync job for history list."""
    
    id: int
    status: str
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    total_connectors: int = 0
    total_processed: int = 0
    total_new: int = 0
    total_updated: int = 0
    total_skipped: int = 0
    total_errors: int = 0
    error_message: Optional[str] = None


class ConnectorRunSummary(BaseModel):
    """Summary of a connector run."""
    
    id: int
    connector_id: int
    connector_type: Optional[str] = None
    account_name: Optional[str] = None
    status: str
    test_mode: bool = False
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    processed_count: int = 0
    synced_count: int = 0
    updated_count: int = 0
    skipped_count: int = 0
    error_count: int = 0


class SyncJobDetailResponse(BaseModel):
    """Detailed sync job response including connector runs."""
    
    id: int
    status: str
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    total_connectors: int = 0
    total_processed: int = 0
    total_new: int = 0
    total_updated: int = 0
    total_skipped: int = 0
    total_errors: int = 0
    error_message: Optional[str] = None
    config_snapshot: Optional[Dict[str, Any]] = None
    connector_runs: List[ConnectorRunSummary] = []


class JobHistoryResponse(BaseModel):
    """Response for job history list."""
    
    jobs: List[SyncJobSummary]
    total: int
    limit: int
    offset: int


class ConnectorRunDetailResponse(BaseModel):
    """Detailed connector run response."""
    
    id: int
    job_id: int
    connector_id: int
    connector_type: Optional[str] = None
    account_name: Optional[str] = None
    status: str
    test_mode: bool = False
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    processed_count: int = 0
    synced_count: int = 0
    updated_count: int = 0
    skipped_count: int = 0
    error_count: int = 0
    synced_ids: List[str] = []
    updated_ids: List[str] = []
    skipped_ids: List[str] = []
    error_details: List[Dict[str, Any]] = []
    logs: List[Dict[str, Any]] = []


@router.get("/history", response_model=JobHistoryResponse)
def get_job_history(
    limit: int = 50,
    offset: int = 0,
    status: Optional[str] = None,
):
    """
    Get sync job history with pagination.
    
    Args:
        limit: Maximum number of jobs to return (default 50)
        offset: Number of jobs to skip (for pagination)
        status: Optional filter by status (idle, running, completed, aborted, failed)
    
    Returns:
        List of sync jobs with summary info
    """
    from backend.db.database import get_engine
    from backend.db.repositories import SyncJobRepository
    from backend.db.models import SyncJobStatus
    from sqlmodel import Session
    
    try:
        engine = get_engine()
        with Session(engine) as session:
            repo = SyncJobRepository(session)
            
            # Parse status filter
            status_filter = None
            if status:
                try:
                    status_filter = SyncJobStatus(status)
                except ValueError:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Invalid status: {status}. Valid values: {[s.value for s in SyncJobStatus]}"
                    )
            
            jobs = repo.list_jobs(limit=limit, offset=offset, status=status_filter)
            total = repo.count_jobs(status=status_filter)
            
            return JobHistoryResponse(
                jobs=[
                    SyncJobSummary(
                        id=job.id,
                        status=job.status,  # Already a string in the model
                        started_at=job.started_at.isoformat() if job.started_at else None,
                        finished_at=job.finished_at.isoformat() if job.finished_at else None,
                        total_connectors=job.total_connectors or 0,
                        total_processed=job.total_processed or 0,
                        total_new=job.total_new or 0,
                        total_updated=job.total_updated or 0,
                        total_skipped=job.total_skipped or 0,
                        total_errors=job.total_errors or 0,
                        error_message=job.error_message,
                    )
                    for job in jobs
                ],
                total=total,
                limit=limit,
                offset=offset,
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get job history: {str(e)}"
        )


@router.get("/jobs/{job_id}", response_model=SyncJobDetailResponse)
def get_job_detail(job_id: int):
    """
    Get detailed information about a specific sync job.
    
    Args:
        job_id: ID of the sync job
    
    Returns:
        Detailed job info including connector runs
    """
    from backend.db.database import get_engine
    from backend.db.repositories import SyncJobRepository, AccountConnectorRepository
    from backend.db.models import AccountConnector
    from sqlmodel import Session, select
    
    try:
        engine = get_engine()
        with Session(engine) as session:
            repo = SyncJobRepository(session)
            connector_repo = AccountConnectorRepository(session)
            
            job = repo.get_job_with_runs(job_id)
            if not job:
                raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
            
            # Get connector runs with account/connector info
            runs = repo.get_connector_runs_for_job(job_id)
            
            # Build connector info lookup
            connector_info: Dict[int, Dict[str, str]] = {}
            for run in runs:
                if run.connector_id not in connector_info:
                    result = connector_repo.get_with_account(run.connector_id)
                    if result:
                        connector, account = result
                        connector_info[run.connector_id] = {
                            "connector_type": connector.connector_type,
                            "account_name": account.name,
                        }
            
            return SyncJobDetailResponse(
                id=job.id,
                status=job.status,  # Already a string in the model
                started_at=job.started_at.isoformat() if job.started_at else None,
                finished_at=job.finished_at.isoformat() if job.finished_at else None,
                total_connectors=job.total_connectors or 0,
                total_processed=job.total_processed or 0,
                total_new=job.total_new or 0,
                total_updated=job.total_updated or 0,
                total_skipped=job.total_skipped or 0,
                total_errors=job.total_errors or 0,
                error_message=job.error_message,
                config_snapshot=job.config_snapshot,
                connector_runs=[
                    ConnectorRunSummary(
                        id=run.id,
                        connector_id=run.connector_id,
                        connector_type=connector_info.get(run.connector_id, {}).get("connector_type"),
                        account_name=connector_info.get(run.connector_id, {}).get("account_name"),
                        status=run.status,  # Already a string in the model
                        test_mode=run.test_mode or False,
                        started_at=run.started_at.isoformat() if run.started_at else None,
                        finished_at=run.finished_at.isoformat() if run.finished_at else None,
                        processed_count=run.processed or 0,  # Model uses 'processed'
                        synced_count=run.synced_count or 0,
                        updated_count=run.updated_count or 0,
                        skipped_count=run.skipped_count or 0,
                        error_count=run.error_count or 0,
                    )
                    for run in runs
                ],
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get job detail: {str(e)}"
        )


@router.get("/connector-runs/{run_id}", response_model=ConnectorRunDetailResponse)
def get_connector_run_detail(run_id: int):
    """
    Get detailed information about a specific connector run.
    
    Args:
        run_id: ID of the connector run
    
    Returns:
        Detailed connector run info including synced/updated/error IDs and logs
    """
    from backend.db.database import get_engine
    from backend.db.repositories import SyncJobRepository, AccountConnectorRepository
    from sqlmodel import Session
    
    try:
        engine = get_engine()
        with Session(engine) as session:
            repo = SyncJobRepository(session)
            connector_repo = AccountConnectorRepository(session)
            
            run = repo.get_connector_run(run_id)
            if not run:
                raise HTTPException(status_code=404, detail=f"Connector run {run_id} not found")
            
            # Get connector/account info
            connector_type = None
            account_name = None
            result = connector_repo.get_with_account(run.connector_id)
            if result:
                connector, account = result
                connector_type = connector.connector_type
                account_name = account.name
            
            return ConnectorRunDetailResponse(
                id=run.id,
                job_id=run.job_id,
                connector_id=run.connector_id,
                connector_type=connector_type,
                account_name=account_name,
                status=run.status,  # Already a string in the model
                test_mode=run.test_mode or False,
                started_at=run.started_at.isoformat() if run.started_at else None,
                finished_at=run.finished_at.isoformat() if run.finished_at else None,
                processed_count=run.processed or 0,  # Model uses 'processed'
                synced_count=run.synced_count or 0,
                updated_count=run.updated_count or 0,
                skipped_count=run.skipped_count or 0,
                error_count=run.error_count or 0,
                synced_ids=run.synced_ids or [],
                updated_ids=run.updated_ids or [],
                skipped_ids=run.skipped_ids or [],
                error_details=run.error_details or [],
                logs=run.logs or [],
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get connector run detail: {str(e)}"
        )


@router.get("/jobs/{job_id}/transactions")
def get_job_transactions(
    job_id: int,
    limit: int = 100,
    offset: int = 0,
):
    """
    Get transactions created or updated by a specific sync job.
    
    Args:
        job_id: ID of the sync job
        limit: Maximum number of transactions to return
        offset: Number of transactions to skip
    
    Returns:
        List of transactions from this job
    """
    from backend.db.database import get_engine
    from backend.db.repositories import SyncJobRepository
    from sqlmodel import Session
    
    try:
        engine = get_engine()
        with Session(engine) as session:
            repo = SyncJobRepository(session)
            
            # Verify job exists
            job = repo.get_job(job_id)
            if not job:
                raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
            
            transactions = repo.get_transactions_for_job(job_id, limit=limit, offset=offset)
            total = repo.count_transactions_for_job(job_id)
            
            return {
                "transactions": [
                    {
                        "id": tx.id,
                        "source": tx.source,
                        "source_transaction_id": tx.source_transaction_id,
                        "source_transaction_type": tx.source_transaction_type,
                        "date_time": tx.date_time.isoformat() if tx.date_time else None,
                        "direction": tx.direction,
                        "transaction_type": tx.transaction_type,
                        "source_asset_symbol": tx.source_asset_symbol,
                        "quantity": str(tx.quantity) if tx.quantity else None,
                        "price": str(tx.price) if tx.price else None,
                        "fee": str(tx.fee) if tx.fee else None,
                        "sync_connector_run_id": tx.sync_connector_run_id,
                    }
                    for tx in transactions
                ],
                "total": total,
                "limit": limit,
                "offset": offset,
                "job_id": job_id,
            }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get job transactions: {str(e)}"
        )
