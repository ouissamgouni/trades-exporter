"""
Sync Job endpoints for the Trade Exporter API.
Provides endpoints for starting, monitoring, and aborting sync jobs.
"""

from fastapi import APIRouter, HTTPException
from typing import Optional
from pydantic import BaseModel

from backend.services.sync_job_service import get_sync_job_service

router = APIRouter(prefix="/sync-job", tags=["Sync Job"])


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
def start_sync_job():
    """
    Start a new sync job to fetch transactions from all sources.

    Test mode is determined by the TEST_MODE environment variable or settings.yaml.
    Returns an error if a job is already running.
    """
    service = get_sync_job_service()

    try:
        result = service.start_job()
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
