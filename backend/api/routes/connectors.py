"""
API routes for global Connector operations (cross-account).

Provides a unified view of all connectors across all accounts.
"""

import os
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, HTTPException, Depends, Query, UploadFile, File
from sqlmodel import Session, select
from sqlalchemy.orm.attributes import flag_modified
from pydantic import BaseModel, ConfigDict

from backend.db.models import Account, AccountConnector, FileImport
from backend.db.database import get_session_dependency
from backend.db.repositories import FileImportRepository
from backend.connectors.connector_registry import get_connector_registry
from backend.config.loader import configure_logging

log = configure_logging("connectors_api")

router = APIRouter(prefix="/connectors", tags=["connectors"])


# ============================================================================
# Pydantic Models for API
# ============================================================================


class ConnectorWithAccountResponse(BaseModel):
    """Response model for connector with account info."""

    id: int
    account_id: int
    account_name: str
    account_type: str
    connector_type: str
    enabled: bool
    config: Dict[str, Any]
    credentials_ref: Optional[str]
    sync_priority: int
    last_sync_at: Optional[str]
    last_sync_status: Optional[str]
    last_error: Optional[str]
    created_at: str
    updated_at: str

    model_config = ConfigDict(from_attributes=True)


class ConnectorTypeInfo(BaseModel):
    """Information about available connector types."""

    type: str
    category: str  # 'cex', 'onchain', 'broker'
    display_name: str
    supported_chains: Optional[List[str]] = None
    required_config: List[str]
    optional_config: List[str]


class ConnectorUpdate(BaseModel):
    """Request model for updating a connector."""

    enabled: Optional[bool] = None
    config: Optional[Dict[str, Any]] = None
    credentials_ref: Optional[str] = None
    sync_priority: Optional[int] = None


class FileUploadPreviewResponse(BaseModel):
    """Response model for file upload preview."""
    
    row_count: int
    date_range: Optional[Dict[str, Optional[str]]]
    pairs: Optional[List[str]] = None  # For trading files
    currencies: Optional[List[str]] = None  # For deposit/withdrawal files
    sample_rows: List[Dict[str, Any]]


class NormalizedTransactionSample(BaseModel):
    """Sample normalized transaction for preview."""
    
    source_transaction_id: str
    date_time: str
    transaction_type: str
    direction: str
    source_asset_symbol: str
    quantity: float
    fee: float
    source_fee_quote_asset_symbol: Optional[str] = None
    network: Optional[str] = None
    source_price: Optional[float] = None
    source_price_quote_asset_symbol: Optional[str] = None
    source_from_account: Optional[str] = None
    source_to_account: Optional[str] = None


class FileUploadDetailedPreviewResponse(BaseModel):
    """Response model for detailed file preview with normalized transactions."""
    
    row_count: int
    normalized_count: int
    date_range: Optional[Dict[str, Optional[str]]]
    pairs: Optional[List[str]] = None
    currencies: Optional[List[str]] = None
    sample_rows: List[Dict[str, Any]]
    sample_normalized: List[NormalizedTransactionSample]
    normalization_errors: List[Dict[str, Any]]  # [{row_index: int, error: str}]


class FileUploadConfirmResponse(BaseModel):
    """Response model for file upload confirmation."""
    
    status: str
    file_path: str
    filename: str
    row_count: int
    file_import_id: int  # Database ID for tracking


class ImportHistoryEntry(BaseModel):
    """Single import history entry from database."""
    
    id: int
    filename: str
    original_filename: str
    file_path: str
    uploaded_at: str
    processed_at: Optional[str]
    file_size: int
    status: str  # pending, processing, completed, failed
    row_count: int
    new_count: int
    updated_count: int
    skipped_count: int
    error_message: Optional[str]
    sync_job_connector_run_id: Optional[int]
    file_exists: bool = True  # Whether the file still exists on disk


# ============================================================================
# Helper Functions
# ============================================================================


def connector_to_response(
    connector: AccountConnector, account: Account
) -> ConnectorWithAccountResponse:
    """Convert AccountConnector model to API response with account info."""
    return ConnectorWithAccountResponse(
        id=connector.id,
        account_id=connector.account_id,
        account_name=account.name,
        account_type=account.account_type,
        connector_type=connector.connector_type,
        enabled=connector.enabled,
        config=connector.config or {},
        credentials_ref=connector.credentials_ref,
        sync_priority=connector.sync_priority,
        last_sync_at=connector.last_sync_at.isoformat()
        if connector.last_sync_at
        else None,
        last_sync_status=connector.last_sync_status,
        last_error=connector.last_error,
        created_at=connector.created_at.isoformat(),
        updated_at=connector.updated_at.isoformat(),
    )


# ============================================================================
# API Routes
# ============================================================================


@router.get("", response_model=List[ConnectorWithAccountResponse])
def list_all_connectors(
    enabled_only: bool = Query(False, description="Filter to only enabled connectors"),
    connector_type: Optional[str] = Query(None, description="Filter by connector type"),
    account_type: Optional[str] = Query(None, description="Filter by account type"),
    session: Session = Depends(get_session_dependency),
):
    """
    List all connectors across all accounts.

    Returns connectors with their associated account information.
    """
    # Build query with joins
    statement = select(AccountConnector, Account).join(
        Account, AccountConnector.account_id == Account.id
    )

    if enabled_only:
        statement = statement.where(AccountConnector.enabled.is_(True))

    if connector_type:
        statement = statement.where(AccountConnector.connector_type == connector_type)

    if account_type:
        statement = statement.where(Account.account_type == account_type)

    statement = statement.order_by(Account.name, AccountConnector.sync_priority)

    results = session.exec(statement).all()

    return [connector_to_response(connector, account) for connector, account in results]


@router.get("/types", response_model=List[ConnectorTypeInfo])
def list_connector_types():
    """
    List all available connector types and their configuration requirements.
    """
    registry = get_connector_registry()
    available = []
    for connector_type in registry.list_types():
        info = registry.get(connector_type)
        if info:
            available.append(
                ConnectorTypeInfo(
                    type=connector_type,
                    category=info.category,
                    display_name=info.display_name,
                    supported_chains=info.supported_chains,
                    required_config=info.required_config,
                    optional_config=info.optional_config,
                )
            )
    return available


@router.get("/{connector_id}", response_model=ConnectorWithAccountResponse)
def get_connector(
    connector_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get a specific connector by ID.
    """
    result = session.exec(
        select(AccountConnector, Account)
        .join(Account, AccountConnector.account_id == Account.id)
        .where(AccountConnector.id == connector_id)
    ).first()

    if not result:
        raise HTTPException(
            status_code=404, detail=f"Connector {connector_id} not found"
        )

    connector, account = result
    return connector_to_response(connector, account)


@router.patch("/{connector_id}", response_model=ConnectorWithAccountResponse)
def update_connector(
    connector_id: int,
    update: ConnectorUpdate,
    session: Session = Depends(get_session_dependency),
):
    """
    Update a connector by ID.
    """
    connector = session.get(AccountConnector, connector_id)
    if not connector:
        raise HTTPException(
            status_code=404, detail=f"Connector {connector_id} not found"
        )

    account = session.get(Account, connector.account_id)
    if not account:
        raise HTTPException(
            status_code=404, detail=f"Account {connector.account_id} not found"
        )

    # Update fields
    update_data = update.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(connector, key, value)

    session.add(connector)
    session.commit()
    session.refresh(connector)

    return connector_to_response(connector, account)


@router.patch("/{connector_id}/toggle", response_model=ConnectorWithAccountResponse)
def toggle_connector(
    connector_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Toggle a connector's enabled status.
    """
    connector = session.get(AccountConnector, connector_id)
    if not connector:
        raise HTTPException(
            status_code=404, detail=f"Connector {connector_id} not found"
        )

    account = session.get(Account, connector.account_id)
    if not account:
        raise HTTPException(
            status_code=404, detail=f"Account {connector.account_id} not found"
        )

    connector.enabled = not connector.enabled
    session.add(connector)
    session.commit()
    session.refresh(connector)

    return connector_to_response(connector, account)


@router.delete("/{connector_id}", status_code=204)
def delete_connector(
    connector_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Delete a connector by ID.
    """
    connector = session.get(AccountConnector, connector_id)
    if not connector:
        raise HTTPException(
            status_code=404, detail=f"Connector {connector_id} not found"
        )

    session.delete(connector)
    session.commit()

    return None


# ============================================================================
# File Upload Endpoints (Generic - supports file connectors)
# ============================================================================

# File loader dispatch - maps connector types to their loader modules
# Add new file connectors here when adding support for other exchanges
FILE_LOADERS = {
    "mexc-transactions": "backend.file_loaders.mexc_loader",
    "mexc-transactions-file": "backend.file_loaders.mexc_loader",
    "mexc-deposits": "backend.file_loaders.mexc_deposits_loader",
    "mexc-deposits-file": "backend.file_loaders.mexc_deposits_loader",
    "mexc-withdrawals-file": "backend.file_loaders.mexc_withdrawals_loader",
    "okx-funding-file": "backend.file_loaders.okx_funding_loader",
    "okx-trades-file": "backend.file_loaders.okx_trades_loader",
}

# Connector class dispatch - maps connector types to their classes
# Used for normalization preview without database
CONNECTOR_CLASSES = {
    "mexc-transactions-file": "backend.connectors.cex.connector_mexc_trx_file.MEXCTrxFileConnector",
    "mexc-deposits-file": "backend.connectors.cex.connector_mexc_deposits_file.MEXCDepositsFileConnector",
    "mexc-withdrawals-file": "backend.connectors.cex.connector_mexc_withdrawals_file.MEXCWithdrawalsFileConnector",
    "okx-funding-file": "backend.connectors.cex.connector_okx_funding_file.OKXFundingFileConnector",
    "okx-trades-file": "backend.connectors.cex.connector_okx_trades_file.OKXTradesFileConnector",
}


def _get_file_loader(connector_type: str):
    """
    Get the file loader module for a connector type.
    
    Returns the loader module with get_*_file_preview and load_*_file functions.
    """
    loader_module = FILE_LOADERS.get(connector_type)
    if not loader_module:
        return None
    
    import importlib
    return importlib.import_module(loader_module)


def _get_connector_instance(connector_type: str, config: Optional[Dict[str, Any]] = None):
    """
    Get an instance of a connector for preview normalization.
    
    Returns instantiated connector with account_id=None, connector_id=None.
    Does not require database session.
    """
    connector_class_path = CONNECTOR_CLASSES.get(connector_type)
    if not connector_class_path:
        return None
    
    import importlib
    module_path, class_name = connector_class_path.rsplit(".", 1)
    module = importlib.import_module(module_path)
    connector_class = getattr(module, class_name)
    
    # Instantiate with None IDs for preview (no DB interaction)
    return connector_class(
        account_id=None,
        connector_id=None,
        config=config or {}
    )


def _get_upload_dir(connector_id: int) -> str:
    """Get the upload directory path for a connector."""
    # Use backend/data/input/uploads/{connector_id}/
    import os
    backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(backend_dir, "data", "input", "uploads", str(connector_id))


@router.post("/{connector_id}/upload-file/preview", response_model=FileUploadPreviewResponse)
async def preview_file_upload(
    connector_id: int,
    file: UploadFile = File(...),
    session: Session = Depends(get_session_dependency),
):
    """
    Preview a trades file before importing.
    
    Parses the uploaded XLSX file and returns:
    - Row count
    - Date range
    - Trading pairs found
    - Sample rows (first 5)
    
    Supports connectors with file upload capability (is_file_connector or linked via connector_family).
    """
    # Validate connector exists
    connector = session.get(AccountConnector, connector_id)
    if not connector:
        raise HTTPException(status_code=404, detail=f"Connector {connector_id} not found")
    
    # Check if connector supports file upload via registry
    registry = get_connector_registry()
    connector_info = registry.get(connector.connector_type)
    
    # Allow file upload for file connectors OR their linked API connectors
    supports_file = (
        connector_info and (
            connector_info.is_file_connector or 
            connector.connector_type in FILE_LOADERS
        )
    )
    
    if not supports_file:
        raise HTTPException(
            status_code=400, 
            detail=f"File upload not supported for connector type: {connector.connector_type}"
        )
    
    # Get the file loader for this connector
    loader = _get_file_loader(connector.connector_type)
    if not loader:
        raise HTTPException(
            status_code=400,
            detail=f"No file loader configured for connector type: {connector.connector_type}"
        )
    
    # Validate file type based on connector
    if connector.connector_type in ["okx-funding-file", "okx-trades-file"]:
        # CSV connectors
        if not file.filename.endswith(".csv"):
            raise HTTPException(
                status_code=400,
                detail="Only CSV files are supported for this connector"
            )
    else:
        # Excel connectors (MEXC, etc.)
        if not file.filename.endswith((".xlsx", ".xls")):
            raise HTTPException(
                status_code=400,
                detail="Only XLSX/XLS files are supported for this connector"
            )
    
    try:
        # Read file content
        content = await file.read()
        
        # Parse and get preview using the appropriate loader
        # All loaders should have a get_*_file_preview function
        # Find the preview function dynamically
        preview_fn = None
        for attr_name in dir(loader):
            if attr_name.startswith('get_') and attr_name.endswith('_file_preview'):
                preview_fn = getattr(loader, attr_name)
                break
        
        if not preview_fn:
            raise HTTPException(status_code=500, detail="Loader missing preview function")
        
        preview = preview_fn(content)
        
        log.info(f"📊 File preview for connector {connector_id}: {preview['row_count']} rows")
        
        return FileUploadPreviewResponse(**preview)
        
    except Exception as e:
        log.error(f"❌ Failed to preview file for connector {connector_id}: {e}")
        raise HTTPException(status_code=400, detail=f"Failed to parse file: {str(e)}")


@router.post("/{connector_id}/upload-file/preview-detailed", response_model=FileUploadDetailedPreviewResponse)
async def preview_file_upload_detailed(
    connector_id: int,
    file: UploadFile = File(...),
    max_samples: int = Query(10, description="Maximum normalized samples to return (0 for all)"),
    session: Session = Depends(get_session_dependency),
):
    """
    Detailed preview with normalized transaction samples.
    
    Parses the uploaded file and runs normalization logic to show:
    - Raw file preview (row count, date range, assets, samples)
    - Normalized transaction samples (what will be saved to DB)
    - Normalization errors (rows that failed)
    
    This is an on-demand endpoint for users who want to see detailed preview
    before confirming import. Does NOT save anything to database.
    """
    # Validate connector exists
    connector = session.get(AccountConnector, connector_id)
    if not connector:
        raise HTTPException(status_code=404, detail=f"Connector {connector_id} not found")
    
    # Check if connector supports file upload
    registry = get_connector_registry()
    connector_info = registry.get(connector.connector_type)
    
    supports_file = (
        connector_info and (
            connector_info.is_file_connector or 
            connector.connector_type in FILE_LOADERS
        )
    )
    
    if not supports_file:
        raise HTTPException(
            status_code=400, 
            detail=f"File upload not supported for connector type: {connector.connector_type}"
        )
    
    # Get file loader and connector class
    loader = _get_file_loader(connector.connector_type)
    if not loader:
        raise HTTPException(
            status_code=400,
            detail=f"No file loader configured for connector type: {connector.connector_type}"
        )
    
    connector_instance = _get_connector_instance(connector.connector_type)
    if not connector_instance:
        raise HTTPException(
            status_code=400,
            detail=f"No connector class configured for normalization preview: {connector.connector_type}"
        )
    
    # Validate file type based on connector
    if connector.connector_type in ["okx-funding-file", "okx-trades-file"]:
        # CSV connectors
        if not file.filename.endswith(".csv"):
            raise HTTPException(
                status_code=400,
                detail="Only CSV files are supported for this connector"
            )
    else:
        # Excel connectors (MEXC, etc.)
        if not file.filename.endswith((".xlsx", ".xls")):
            raise HTTPException(
                status_code=400,
                detail="Only XLSX/XLS files are supported for this connector"
            )
    
    try:
        # Read file content
        content = await file.read()
        
        # 1. Get quick preview using file loader
        preview_fn = None
        for attr_name in dir(loader):
            if attr_name.startswith('get_') and attr_name.endswith('_file_preview'):
                preview_fn = getattr(loader, attr_name)
                break
        
        if not preview_fn:
            raise HTTPException(status_code=500, detail="Loader missing preview function")
        
        quick_preview = preview_fn(content)
        
        # 2. Load file and normalize
        load_fn = None
        for attr_name in dir(loader):
            if attr_name.startswith('load_') and attr_name.endswith('_file'):
                load_fn = getattr(loader, attr_name)
                break
        
        if not load_fn:
            raise HTTPException(status_code=500, detail="Loader missing load function")
        
        df = load_fn(content=content)
        rows = df.to_dict("records")
        total_rows = len(rows)
        
        # Limit raw samples based on max_samples parameter
        sample_rows = rows if max_samples == 0 else rows[:max_samples]
        
        # 3. Normalize rows and collect results
        normalized_list = []
        normalization_errors = []
        
        # Determine how many rows to process
        rows_to_process = rows if max_samples == 0 else rows[:max_samples]
        
        for idx, raw_row in enumerate(rows_to_process):
            try:
                normalized = connector_instance.raw_to_normalized(raw_row)
                
                # Convert to sample dict
                normalized_list.append(NormalizedTransactionSample(
                    source_transaction_id=normalized.source_transaction_id,
                    date_time=normalized.date_time.replace(tzinfo=timezone.utc).isoformat() if normalized.date_time else "",
                    transaction_type=normalized.transaction_type or "",
                    direction=normalized.direction or "",
                    source_asset_symbol=normalized.source_asset_symbol or "",
                    quantity=float(normalized.quantity or 0),
                    fee=float(normalized.fee or 0),
                    source_fee_quote_asset_symbol=normalized.source_fee_quote_asset_symbol,
                    network=normalized.network,
                    source_price=float(normalized.price) if normalized.price else None,
                    source_price_quote_asset_symbol=normalized.source_price_quote_asset_symbol,
                    source_from_account=normalized.source_from_account,
                    source_to_account=normalized.source_to_account,
                ))
            except Exception as e:
                normalization_errors.append({
                    "row_index": idx + 1,
                    "error": str(e)
                })
        
        log.info(f"📊 Detailed preview for connector {connector_id}: {total_rows} raw rows, {len(normalized_list)}/{len(rows_to_process)} normalized, {len(normalization_errors)} errors")
        
        return FileUploadDetailedPreviewResponse(
            row_count=total_rows,
            normalized_count=len(normalized_list),
            date_range=quick_preview.get("date_range"),
            pairs=quick_preview.get("pairs"),
            currencies=quick_preview.get("currencies"),
            sample_rows=sample_rows,
            sample_normalized=normalized_list,
            normalization_errors=normalization_errors,
        )
        
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"❌ Failed to preview file (detailed) for connector {connector_id}: {e}")
        import traceback
        log.error(traceback.format_exc())
        raise HTTPException(status_code=400, detail=f"Failed to parse file: {str(e)}")


@router.post("/{connector_id}/upload-file/confirm", response_model=FileUploadConfirmResponse)
async def confirm_file_upload(
    connector_id: int,
    file: UploadFile = File(...),
    session: Session = Depends(get_session_dependency),
):
    """
    Confirm and save a trades file for import.
    
    Saves the file to data/input/uploads/{connector_id}/ and updates
    the connector config with:
    - file_path: Path to the uploaded file
    - import_history: Appended with new import record
    
    The file will be processed during the next sync job.
    """
    # Validate connector exists
    connector = session.get(AccountConnector, connector_id)
    if not connector:
        raise HTTPException(status_code=404, detail=f"Connector {connector_id} not found")
    
    # Check if connector supports file upload via registry
    registry = get_connector_registry()
    connector_info = registry.get(connector.connector_type)
    
    # Allow file upload for file connectors OR their linked API connectors
    supports_file = (
        connector_info and (
            connector_info.is_file_connector or 
            connector.connector_type in FILE_LOADERS
        )
    )
    
    if not supports_file:
        raise HTTPException(
            status_code=400,
            detail=f"File upload not supported for connector type: {connector.connector_type}"
        )
    
    # Get the file loader for this connector
    loader = _get_file_loader(connector.connector_type)
    if not loader:
        raise HTTPException(
            status_code=400,
            detail=f"No file loader configured for connector type: {connector.connector_type}"
        )
    
    # Validate file type based on connector
    if connector.connector_type in ["okx-funding-file", "okx-trades-file"]:
        # CSV connectors
        if not file.filename.endswith(".csv"):
            raise HTTPException(
                status_code=400,
                detail="Only CSV files are supported for this connector"
            )
    else:
        # Excel connectors (MEXC, etc.)
        if not file.filename.endswith((".xlsx", ".xls")):
            raise HTTPException(
                status_code=400,
                detail="Only XLSX/XLS files are supported for this connector"
            )
    
    try:
        # Read file content
        content = await file.read()
        file_size = len(content)
        
        # Parse to get row count for history using dynamic function detection
        preview_fn = None
        for attr_name in dir(loader):
            if attr_name.startswith('get_') and attr_name.endswith('_file_preview'):
                preview_fn = getattr(loader, attr_name)
                break
        
        if not preview_fn:
            raise HTTPException(status_code=500, detail="Loader missing preview function")
        
        preview = preview_fn(content)
        row_count = preview["row_count"]
        
        if row_count == 0:
            raise HTTPException(status_code=400, detail="File contains no valid trades")
        
        # Create upload directory
        upload_dir = _get_upload_dir(connector_id)
        os.makedirs(upload_dir, exist_ok=True)
        
        # Generate unique filename with timestamp
        # Format: pending_{timestamp}_{original_filename}
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_filename = file.filename.replace(" ", "_")
        saved_filename = f"pending_{timestamp}_{safe_filename}"
        file_path = os.path.join(upload_dir, saved_filename)
        
        # Save file
        with open(file_path, "wb") as f:
            f.write(content)
        
        log.info(f"📁 Saved file to: {file_path}")
        
        # Create FileImport record in database
        file_import_repo = FileImportRepository(session)
        file_import = FileImport(
            connector_id=connector_id,
            filename=saved_filename,
            original_filename=file.filename,
            file_path=file_path,
            file_size=file_size,
            row_count=row_count,
            status="pending",
        )
        file_import = file_import_repo.create(file_import)
        
        # Update connector config with file_path and file_import_id
        old_config = connector.config or {}
        config = dict(old_config)  # Create a copy
        
        # Set file path and import ID for the connector to use during sync
        config["file_path"] = file_path
        config["file_import_id"] = file_import.id
        
        # Assign the new dict and flag as modified to ensure SQLAlchemy persists the change
        connector.config = config
        flag_modified(connector, "config")
        session.add(connector)
        session.commit()
        session.refresh(connector)
        
        log.info(f"✅ File upload confirmed for connector {connector_id}: {row_count} rows, file_import_id={file_import.id}")
        
        return FileUploadConfirmResponse(
            status="confirmed",
            file_path=file_path,
            filename=file.filename,
            row_count=row_count,
            file_import_id=file_import.id,
        )
        
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"❌ Failed to save file for connector {connector_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save file: {str(e)}")


@router.get("/{connector_id}/import-history", response_model=List[ImportHistoryEntry])
def get_import_history(
    connector_id: int,
    status: Optional[str] = Query(None, description="Filter by status: pending, processing, completed, failed"),
    limit: int = Query(50, description="Maximum number of records to return"),
    offset: int = Query(0, description="Number of records to skip"),
    session: Session = Depends(get_session_dependency),
):
    """
    Get the import history for a connector from database.
    
    Returns all file imports (pending, processing, completed, failed) ordered by upload date.
    Includes processing metrics and error messages for completed/failed imports.
    """
    connector = session.get(AccountConnector, connector_id)
    if not connector:
        raise HTTPException(status_code=404, detail=f"Connector {connector_id} not found")
    
    file_import_repo = FileImportRepository(session)
    imports = file_import_repo.get_by_connector(
        connector_id=connector_id,
        status=status,
        limit=limit,
        offset=offset,
    )
    
    entries = []
    for fi in imports:
        # Check if file exists on disk
        file_exists = os.path.exists(fi.file_path) if fi.file_path else False
        
        entries.append(ImportHistoryEntry(
            id=fi.id,
            filename=fi.filename,
            original_filename=fi.original_filename,
            file_path=fi.file_path,
            uploaded_at=fi.uploaded_at.isoformat() if fi.uploaded_at else "",
            processed_at=fi.processed_at.isoformat() if fi.processed_at else None,
            file_size=fi.file_size,
            status=fi.status,
            row_count=fi.row_count,
            new_count=fi.new_count,
            updated_count=fi.updated_count,
            skipped_count=fi.skipped_count,
            error_message=fi.error_message,
            sync_job_connector_run_id=fi.sync_job_connector_run_id,
            file_exists=file_exists,
        ))
    
    return entries


@router.delete("/{connector_id}/import-history/{file_import_id}")
def delete_file_import(
    connector_id: int,
    file_import_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Delete a file import record and its associated file.
    
    Can be used to:
    - Cancel a pending import before processing
    - Retry a failed import by deleting and re-uploading
    - Clean up old import history
    """
    connector = session.get(AccountConnector, connector_id)
    if not connector:
        raise HTTPException(status_code=404, detail=f"Connector {connector_id} not found")
    
    file_import_repo = FileImportRepository(session)
    file_import = file_import_repo.get(file_import_id)
    
    if not file_import:
        raise HTTPException(status_code=404, detail=f"File import {file_import_id} not found")
    
    if file_import.connector_id != connector_id:
        raise HTTPException(status_code=403, detail="File import does not belong to this connector")
    
    # Don't allow deletion of processing imports
    if file_import.status == "processing":
        raise HTTPException(status_code=400, detail="Cannot delete file import while processing")
    
    file_import_repo.delete(file_import_id)
    session.commit()
    
    log.info(f"🗑️ Deleted file import {file_import_id} for connector {connector_id}")
    
    return {"status": "deleted", "file_import_id": file_import_id}


@router.get("/{connector_id}/import-history/{file_import_id}/preview", response_model=FileUploadPreviewResponse)
def preview_file_import(
    connector_id: int,
    file_import_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Preview a pending/failed file import.
    
    Reads the stored file and returns the same preview as the upload preview.
    Only works for imports where the file still exists.
    """
    connector = session.get(AccountConnector, connector_id)
    if not connector:
        raise HTTPException(status_code=404, detail=f"Connector {connector_id} not found")
    
    file_import_repo = FileImportRepository(session)
    file_import = file_import_repo.get(file_import_id)
    
    if not file_import:
        raise HTTPException(status_code=404, detail=f"File import {file_import_id} not found")
    
    if file_import.connector_id != connector_id:
        raise HTTPException(status_code=403, detail="File import does not belong to this connector")
    
    # Check if file exists
    if not os.path.exists(file_import.file_path):
        raise HTTPException(status_code=400, detail="File no longer exists on disk")
    
    # Get the file loader for this connector
    loader = _get_file_loader(connector.connector_type)
    if not loader:
        raise HTTPException(
            status_code=400,
            detail=f"No file loader configured for connector type: {connector.connector_type}"
        )
    
    try:
        # Read file content
        with open(file_import.file_path, "rb") as f:
            content = f.read()
        
        # Parse and get preview using the appropriate loader
        preview_fn = getattr(loader, "get_mexc_file_preview", None)
        if not preview_fn:
            raise HTTPException(status_code=500, detail="Loader missing preview function")
        
        preview = preview_fn(content)
        
        log.info(f"📊 Preview for file import {file_import_id}: {preview['row_count']} rows")
        
        return FileUploadPreviewResponse(**preview)
        
    except Exception as e:
        log.error(f"❌ Failed to preview file import {file_import_id}: {e}")
        raise HTTPException(status_code=400, detail=f"Failed to parse file: {str(e)}")


@router.post("/{connector_id}/import-history/cleanup")
def cleanup_orphaned_imports(
    connector_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Clean up orphaned file import records.
    
    Deletes records that are in pending/failed status but the file no longer exists.
    This can happen if:
    - Files were manually deleted
    - System crashed during upload
    - Disk space cleanup removed files
    
    Returns count of cleaned up records.
    """
    connector = session.get(AccountConnector, connector_id)
    if not connector:
        raise HTTPException(status_code=404, detail=f"Connector {connector_id} not found")
    
    file_import_repo = FileImportRepository(session)
    
    # Get all pending and failed imports for this connector
    imports = file_import_repo.get_by_connector(connector_id=connector_id, limit=1000)
    
    deleted_count = 0
    deleted_ids = []
    
    for fi in imports:
        # Skip completed imports (they're just history, file was deleted intentionally)
        if fi.status == "completed":
            continue
        
        # Skip processing imports
        if fi.status == "processing":
            continue
        
        # Check if file exists
        if fi.file_path and not os.path.exists(fi.file_path):
            file_import_repo.delete(fi.id)
            deleted_count += 1
            deleted_ids.append(fi.id)
            log.info(f"🧹 Cleaned up orphaned import {fi.id}: {fi.filename}")
    
    session.commit()
    
    log.info(f"🧹 Cleaned up {deleted_count} orphaned imports for connector {connector_id}")
    
    return {
        "status": "cleaned",
        "deleted_count": deleted_count,
        "deleted_ids": deleted_ids,
    }


@router.post("/{connector_id}/import-history/{file_import_id}/retry")
def retry_file_import(
    connector_id: int,
    file_import_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Retry a failed file import by resetting its status to pending.
    
    This allows the file to be processed again in the next sync job.
    Only works for failed imports where the file still exists.
    """
    connector = session.get(AccountConnector, connector_id)
    if not connector:
        raise HTTPException(status_code=404, detail=f"Connector {connector_id} not found")
    
    file_import_repo = FileImportRepository(session)
    file_import = file_import_repo.get(file_import_id)
    
    if not file_import:
        raise HTTPException(status_code=404, detail=f"File import {file_import_id} not found")
    
    if file_import.connector_id != connector_id:
        raise HTTPException(status_code=403, detail="File import does not belong to this connector")
    
    if file_import.status != "failed":
        raise HTTPException(status_code=400, detail="Can only retry failed imports")
    
    # Check if file still exists
    if not os.path.exists(file_import.file_path):
        raise HTTPException(status_code=400, detail="Original file no longer exists, please re-upload")
    
    # Reset to pending
    file_import_repo.update_status(
        file_import_id,
        status="pending",
        error_message=None,
    )
    
    # Update connector config to use this file
    config = dict(connector.config or {})
    config["file_path"] = file_import.file_path
    config["file_import_id"] = file_import.id
    connector.config = config
    flag_modified(connector, "config")
    session.add(connector)
    session.commit()
    
    log.info(f"🔄 Retrying file import {file_import_id} for connector {connector_id}")
    
    return {"status": "pending", "file_import_id": file_import_id}


@router.patch("/{connector_id}/sync-mode")
def set_sync_mode(
    connector_id: int,
    mode: str = Query(..., description="Sync mode: 'api' or 'file'"),
    session: Session = Depends(get_session_dependency),
):
    """
    Set the sync mode for a connector.
    
    - 'api': Use API-based sync (requires credentials)
    - 'file': Use file-based sync (requires uploaded file)
    
    When switching from file to api mode, file_path is cleared but
    import_history is preserved for audit.
    """
    if mode not in ["api", "file"]:
        raise HTTPException(status_code=400, detail="Mode must be 'api' or 'file'")
    
    connector = session.get(AccountConnector, connector_id)
    if not connector:
        raise HTTPException(status_code=404, detail=f"Connector {connector_id} not found")
    
    # Create a new dict to ensure SQLAlchemy detects the change
    config = dict(connector.config or {})
    config["sync_mode"] = mode
    
    # Clear file_path when switching to API mode (keep import_history for audit)
    if mode == "api":
        config.pop("file_path", None)
    
    connector.config = config
    flag_modified(connector, "config")
    session.add(connector)
    session.commit()
    session.refresh(connector)
    
    log.info(f"📊 Connector {connector_id} sync mode set to: {mode}")
    
    return {
        "status": "updated",
        "connector_id": connector_id,
        "sync_mode": mode,
    }
    return None
