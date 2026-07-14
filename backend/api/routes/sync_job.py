"""
Sync Job endpoints for the TradeTrail API.
Provides endpoints for starting, monitoring, and aborting sync jobs.
"""

from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends, Request
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, ConfigDict
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
    connector_run_id: Optional[int] = None

    model_config = ConfigDict(extra="allow")


class JobStatusResponse(BaseModel):
    """Response model for job status."""

    status: str
    job_id: Optional[int] = None
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
    renormalize: bool = False
    connector_statuses: Optional[Dict[int, ConnectorProgressResponse]] = None

    model_config = ConfigDict(extra="allow")


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
    default_since_datetime: Optional[str] = (
        None  # Computed from max transaction datetime
    )


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
def start_sync_job(http_request: Request, request: SyncJobStartRequest):
    """
    Start a new sync job to fetch transactions from all sources.

    Test mode is determined by the TEST_MODE environment variable or settings.yaml,
    unless overridden per-connector in the request body.

    Args:
        request: Optional request body with connector_overrides list containing
                 per-connector settings (enabled, test_mode, since_datetime, etc.)

    Returns an error if a job is already running.
    """
    service = get_sync_job_service()

    if request.trigger_source != "manual":
        raise HTTPException(
            status_code=400,
            detail="Sync jobs must be started by an explicit manual user request",
        )

    try:
        # Convert connector overrides to internal format
        connector_overrides = None
        if request and request.connector_overrides:
            connector_overrides = []
            for o in request.connector_overrides:
                # Parse since_datetime if explicitly provided in the request.
                # Use _UNSET (the default) when the field was not sent at all,
                # and None when the field was explicitly set to null (= full sync).
                from backend.services.sync_job_service import _UNSET

                since_dt = _UNSET  # default: not provided
                if "since_datetime" in o.model_fields_set:
                    # Field was explicitly included in the JSON payload
                    if o.since_datetime:
                        since_dt = datetime.fromisoformat(
                            o.since_datetime.replace("Z", "+00:00")
                        )
                    else:
                        since_dt = None  # Explicit null → full sync

                connector_overrides.append(
                    ConnectorOverride(
                        connector_id=o.connector_id,
                        enabled=o.enabled,
                        test_mode=o.test_mode,
                        test_file_path=o.test_file_path,
                        since_datetime=since_dt,
                        symbols=o.symbols,
                        currencies=o.currencies,
                    )
                )

        service.logger.info(
            "Manual sync start requested from %s user_agent=%s renormalize=%s overrides=%s",
            http_request.client.host if http_request.client else "unknown",
            http_request.headers.get("user-agent", "unknown"),
            bool(request.renormalize),
            len(connector_overrides) if connector_overrides else 0,
        )
        result = service.start_job(
            connector_overrides=connector_overrides,
            renormalize=bool(request.renormalize),
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
    from backend.db.repositories import (
        AccountConnectorRepository,
        NormalizedTransactionRepository,
    )

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

            result.append(
                ConnectorDefaultInfo(
                    connector_id=account_connector.id,
                    connector_type=account_connector.connector_type,
                    account_name=account.name,
                    display_name=connector_info.display_name,
                    supports_incremental_sync=connector_info.supports_incremental_sync,
                    default_since_datetime=max_datetime.replace(
                        tzinfo=timezone.utc
                    ).isoformat()
                    if max_datetime
                    else None,
                )
            )

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


@router.post("/retry/{connector_id}")
def retry_connector(connector_id: int):
    """
    Retry a failed connector within the current (or most recent) sync job.

    Resets the connector's progress card in-place, creates a new
    SyncJobConnectorRun for audit, and re-runs the connector in a
    background thread.  Works whether the job is still running or
    already finished.
    """
    service = get_sync_job_service()
    try:
        result = service.retry_connector(connector_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return result


@router.get("/all-connectors")
def get_all_connectors(session: Session = Depends(get_session_dependency)):
    """
    Get all connectors grouped by account for the SyncConfigPanel.

    Returns ALL connectors (enabled and disabled) so users can enable/disable them
    in the sync configuration UI. Includes incremental sync info.

    Returns:
    - connectors: List of all connectors with account info (enabled and disabled)
    - accounts: List of unique accounts with summary info
    - connector_count: Total number of connectors
    - account_count: Total number of accounts
    """
    from backend.connectors.connector_registry import get_connector_registry
    from backend.db.repositories import (
        AccountConnectorRepository,
        NormalizedTransactionRepository,
    )
    from backend.db.repositories.sync_job_repository import SyncJobRepository

    try:
        registry = get_connector_registry()
        connector_repo = AccountConnectorRepository(session)
        tx_repo = NormalizedTransactionRepository(session)
        sync_job_repo = SyncJobRepository(session)

        # Get ALL connectors (enabled and disabled)
        all_connectors = connector_repo.get_all_with_accounts()

        connectors = []
        accounts_map = {}

        for account_connector, account in all_connectors:
            connector_info = registry.get(account_connector.connector_type)
            config = account_connector.config or {}

            # Check incremental sync support and get default since datetime
            supports_incremental = (
                connector_info.supports_incremental_sync if connector_info else False
            )
            default_since = None
            if supports_incremental:
                max_datetime = tx_repo.get_max_datetime_by_connector(
                    account_connector.id
                )
                default_since = (
                    max_datetime.replace(tzinfo=timezone.utc).isoformat()
                    if max_datetime
                    else None
                )

            # Extract chain name and wallet address for on-chain connectors
            chain_name = config.get("chain") if config else None
            wallet_address = config.get("address") if config else None

            # Get last job run for this connector
            last_run = sync_job_repo.get_latest_run_by_connector(account_connector.id)
            last_job_status = last_run.status if last_run else None
            last_job_started_at = (
                last_run.started_at.replace(tzinfo=timezone.utc).isoformat()
                if last_run and last_run.started_at
                else None
            )
            last_job_finished_at = (
                last_run.finished_at.replace(tzinfo=timezone.utc).isoformat()
                if last_run and last_run.finished_at
                else None
            )
            last_job_new = last_run.synced_count if last_run else 0
            last_job_updated = last_run.updated_count if last_run else 0
            last_job_errors = last_run.error_count if last_run else 0
            last_job_error_message = last_run.error_message if last_run else None

            # Get last transaction for this connector run
            last_tx = None
            if last_run and last_run.synced_count > 0:
                last_tx_obj = sync_job_repo.get_latest_transaction_for_run(last_run.id)
                if last_tx_obj:
                    last_tx = {
                        "datetime": last_tx_obj.date_time.replace(
                            tzinfo=timezone.utc
                        ).isoformat()
                        if last_tx_obj.date_time
                        else None,
                        "type": last_tx_obj.transaction_type,
                        "asset": last_tx_obj.source_asset_symbol,
                        "qty": float(last_tx_obj.quantity)
                        if last_tx_obj.quantity
                        else None,
                        "price": float(last_tx_obj.price)
                        if last_tx_obj.price
                        else None,
                    }

            # Get last successfully synced transaction (across all successful runs)
            last_synced_tx = None
            last_synced_tx_obj = (
                sync_job_repo.get_latest_synced_transaction_for_connector(
                    account_connector.id
                )
            )
            if last_synced_tx_obj:
                last_synced_tx = {
                    "datetime": last_synced_tx_obj.date_time.replace(
                        tzinfo=timezone.utc
                    ).isoformat()
                    if last_synced_tx_obj.date_time
                    else None,
                    "type": last_synced_tx_obj.transaction_type,
                    "asset": last_synced_tx_obj.source_asset_symbol,
                    "qty": float(last_synced_tx_obj.quantity)
                    if last_synced_tx_obj.quantity
                    else None,
                    "price": float(last_synced_tx_obj.price)
                    if last_synced_tx_obj.price
                    else None,
                }

            connectors.append(
                {
                    "connector_id": account_connector.id,
                    "connector_type": account_connector.connector_type,
                    "account_id": account.id,
                    "account_name": account.name,
                    "account_type": account.account_type,
                    "account_enabled": account.enabled,
                    "account_group": account.group,
                    "enabled": account_connector.enabled,
                    "test_mode": config.get("test_mode", False),
                    "test_file_path": config.get("test_file_path"),
                    "sync_priority": account_connector.sync_priority,
                    "last_sync_at": account_connector.last_sync_at.isoformat()
                    if account_connector.last_sync_at
                    else None,
                    "last_sync_status": account_connector.last_sync_status,
                    "supports_incremental_sync": supports_incremental,
                    "default_since_datetime": default_since,
                    "optional_config": connector_info.optional_config
                    if connector_info
                    else [],
                    "config": config,  # Full config for file upload UI (sync_mode, import_history, etc.)
                    # File connector metadata (from registry)
                    "is_file_connector": connector_info.is_file_connector
                    if connector_info
                    else False,
                    "connector_family": connector_info.connector_family
                    if connector_info
                    else None,
                    "display_name": connector_info.display_name
                    if connector_info
                    else account_connector.connector_type,
                    # On-chain connector specific fields
                    "chain_name": chain_name,
                    "wallet_address": wallet_address,
                    # Last job data
                    "last_job_status": last_job_status,
                    "last_job_started_at": last_job_started_at,
                    "last_job_finished_at": last_job_finished_at,
                    "last_job_new": last_job_new,
                    "last_job_updated": last_job_updated,
                    "last_job_errors": last_job_errors,
                    "last_job_error_message": last_job_error_message,
                    "last_job_last_transaction": last_tx,
                    "last_synced_transaction": last_synced_tx,
                    # Start datetime from connector config (default since for sync)
                    "start_datetime": config.get("start_datetime"),
                }
            )

            # Build accounts map for deduplication
            if account.id not in accounts_map:
                accounts_map[account.id] = {
                    "id": account.id,
                    "name": account.name,
                    "account_type": account.account_type,
                    "enabled": account.enabled,
                    "address_or_identifier": account.address_or_identifier,
                    "group": account.group,
                }

        return {
            "connectors": connectors,
            "accounts": list(accounts_map.values()),
            "connector_count": len(connectors),
            "account_count": len(accounts_map),
        }

    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to get all connectors: {str(e)}"
        )


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


class ConnectorRunResponse(BaseModel):
    """Response model for a connector run within a job."""

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


class SyncJobSummaryResponse(BaseModel):
    """Summary of a sync job for history listing."""

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
    renormalize: bool = False
    connector_runs: Optional[List[ConnectorRunResponse]] = None


class JobHistoryResponse(BaseModel):
    """Response for job history endpoint."""

    jobs: List[SyncJobSummaryResponse]
    total: int
    limit: int
    offset: int


class ConnectorRunDetailResponse(BaseModel):
    """Detailed response for a single connector run including outcome tracking."""

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
    synced_ids: Optional[List[str]] = None
    updated_ids: Optional[List[str]] = None
    skipped_ids: Optional[List[str]] = None
    error_details: Optional[List[Dict[str, Any]]] = None
    logs: Optional[List[Dict[str, Any]]] = None
    error_message: Optional[str] = None


class SyncJobDetailResponse(BaseModel):
    """Detailed response for a single sync job."""

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
    renormalize: bool = False
    config_snapshot: Optional[Dict[str, Any]] = None
    connector_runs: List[ConnectorRunResponse] = []


@router.get("/jobs/{job_id}", response_model=SyncJobDetailResponse)
def get_job_detail(
    job_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get detailed information about a specific sync job.

    Args:
        job_id: The ID of the sync job

    Returns:
        Detailed job information including connector runs
    """
    from backend.db.repositories.sync_job_repository import SyncJobRepository

    try:
        repo = SyncJobRepository(session)
        job = repo.get_job_with_runs(job_id)

        if not job:
            raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

        connector_runs = [
            ConnectorRunResponse(
                id=run.id,
                connector_id=run.connector_id,
                connector_type=run.connector_type,
                account_name=run.account_name,
                status=run.status,
                test_mode=run.test_mode,
                started_at=run.started_at.isoformat() if run.started_at else None,
                finished_at=run.finished_at.isoformat() if run.finished_at else None,
                processed_count=run.processed,
                synced_count=run.synced_count,
                updated_count=run.updated_count,
                skipped_count=run.skipped_count,
                error_count=run.error_count,
            )
            for run in (job.connector_runs or [])
        ]

        return SyncJobDetailResponse(
            id=job.id,
            status=job.status,
            started_at=job.started_at.isoformat() if job.started_at else None,
            finished_at=job.finished_at.isoformat() if job.finished_at else None,
            total_connectors=job.total_connectors,
            total_processed=job.total_processed,
            total_new=job.total_new,
            total_updated=job.total_updated,
            total_skipped=job.total_skipped,
            total_errors=job.total_errors,
            error_message=job.error_message,
            renormalize=(job.config_snapshot or {}).get("renormalize", False),
            config_snapshot=job.config_snapshot,
            connector_runs=connector_runs,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to get job detail: {str(e)}"
        )


@router.get("/history", response_model=JobHistoryResponse)
def get_job_history(
    limit: int = 10,
    offset: int = 0,
    session: Session = Depends(get_session_dependency),
):
    """
    Get paginated sync job history.

    Args:
        limit: Maximum number of jobs to return (default: 10)
        offset: Number of jobs to skip (default: 0)

    Returns:
        Paginated list of sync job summaries
    """
    from backend.db.repositories.sync_job_repository import SyncJobRepository

    try:
        repo = SyncJobRepository(session)
        jobs = repo.list_jobs(limit=limit, offset=offset)
        total = repo.count_jobs()

        job_summaries = []
        for job in jobs:
            # Get connector runs for this job
            connector_runs = repo.get_connector_runs_for_job(job.id)
            connector_run_responses = [
                ConnectorRunResponse(
                    id=run.id,
                    connector_id=run.connector_id,
                    connector_type=run.connector_type,
                    account_name=run.account_name,
                    status=run.status,
                    test_mode=run.test_mode,
                    started_at=run.started_at.isoformat() if run.started_at else None,
                    finished_at=run.finished_at.isoformat()
                    if run.finished_at
                    else None,
                    processed_count=run.processed,
                    synced_count=run.synced_count,
                    updated_count=run.updated_count,
                    skipped_count=run.skipped_count,
                    error_count=run.error_count,
                )
                for run in connector_runs
            ]

            job_summaries.append(
                SyncJobSummaryResponse(
                    id=job.id,
                    status=job.status,
                    started_at=job.started_at.isoformat() if job.started_at else None,
                    finished_at=job.finished_at.isoformat()
                    if job.finished_at
                    else None,
                    total_connectors=job.total_connectors,
                    total_processed=job.total_processed,
                    total_new=job.total_new,
                    total_updated=job.total_updated,
                    total_skipped=job.total_skipped,
                    total_errors=job.total_errors,
                    error_message=job.error_message,
                    renormalize=(job.config_snapshot or {}).get("renormalize", False),
                    connector_runs=connector_run_responses,
                )
            )

        return JobHistoryResponse(
            jobs=job_summaries,
            total=total,
            limit=limit,
            offset=offset,
        )
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to get job history: {str(e)}"
        )


@router.get("/connector-runs/{run_id}", response_model=ConnectorRunDetailResponse)
def get_connector_run_detail(
    run_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get detailed information about a specific connector run.

    If the connector is currently running (part of an active sync job),
    merges real-time progress data from SyncJobService with database data
    for live updates.

    Args:
        run_id: The ID of the connector run

    Returns:
        Detailed connector run information including synced/updated/skipped IDs
    """
    from backend.db.repositories.sync_job_repository import SyncJobRepository

    try:
        repo = SyncJobRepository(session)
        run = repo.get_connector_run(run_id)

        if not run:
            raise HTTPException(
                status_code=404, detail=f"Connector run {run_id} not found"
            )

        # Start with database values
        response_data = {
            "id": run.id,
            "job_id": run.job_id,
            "connector_id": run.connector_id,
            "connector_type": run.connector_type,
            "account_name": run.account_name,
            "status": run.status,
            "test_mode": run.test_mode,
            "started_at": run.started_at.isoformat() if run.started_at else None,
            "finished_at": run.finished_at.isoformat() if run.finished_at else None,
            "processed_count": run.processed,
            "synced_count": run.synced_count,
            "updated_count": run.updated_count,
            "skipped_count": run.skipped_count,
            "error_count": run.error_count,
            "synced_ids": run.synced_ids or [],
            "updated_ids": run.updated_ids or [],
            "skipped_ids": run.skipped_ids or [],
            "error_details": run.error_details or [],
            "logs": run.logs or [],
            "error_message": run.error_message,
        }

        # 📊 If connector is running, merge real-time data from SyncJobService
        service = get_sync_job_service()
        if service and service.progress.job_id == run.job_id:
            # Check if this connector is in progress
            if run.connector_id in service.progress.connector_statuses:
                real_time = service.progress.connector_statuses[run.connector_id]
                # Only merge if connector is still running (not completed yet)
                if real_time.status.value in ("running", "queued"):
                    response_data.update(
                        {
                            "status": real_time.status.value,
                            "processed_count": real_time.processed,
                            "synced_count": real_time.new_count,
                            "updated_count": real_time.updated_count,
                            "skipped_count": real_time.skipped_count,
                            "error_count": real_time.error_count,
                            "synced_ids": real_time.synced_ids,
                            "updated_ids": real_time.updated_ids,
                            "skipped_ids": real_time.skipped_ids,
                            "error_details": real_time.error_details,
                            "logs": [log.to_dict() for log in real_time.logs],
                        }
                    )

        return ConnectorRunDetailResponse(**response_data)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to get connector run detail: {str(e)}"
        )
