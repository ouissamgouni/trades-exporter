"""
API routes for Account Connector CRUD operations.
"""

import os
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, HTTPException, Depends, Query
from sqlmodel import Session
from pydantic import BaseModel, ConfigDict

from backend.db.models import Account, AccountConnector
from backend.db.database import get_session_dependency
from backend.db.repositories import AccountConnectorRepository
from backend.connectors.connector_registry import get_connector_registry
from backend.services.data_cleanup_service import DataCleanupService

router = APIRouter(
    prefix="/accounts/{account_id}/connectors", tags=["account-connectors"]
)


# ============================================================================
# Pydantic Models for API
# ============================================================================


class ConnectorConfigBase(BaseModel):
    """Base config fields that can appear in connector config."""

    # Common fields
    chain: Optional[str] = None
    address: Optional[str] = None
    start_block: Optional[int] = None
    start_date: Optional[str] = None

    # CEX specific (optional)
    symbols: Optional[List[str]] = None

    # Onchain specific
    include_internal_txs: Optional[bool] = None
    include_token_transfers: Optional[bool] = None
    token_filter: Optional[List[str]] = None

    model_config = ConfigDict(extra="allow")  # Allow additional fields


class AccountConnectorCreate(BaseModel):
    """Request model for creating an account connector."""

    connector_type: str
    enabled: bool = True
    config: Dict[str, Any] = {}
    credentials_ref: Optional[str] = None
    sync_priority: int = 100
    color: Optional[str] = None


class AccountConnectorUpdate(BaseModel):
    """Request model for updating an account connector."""

    enabled: Optional[bool] = None
    config: Optional[Dict[str, Any]] = None
    credentials_ref: Optional[str] = None
    sync_priority: Optional[int] = None
    color: Optional[str] = None


class AccountConnectorResponse(BaseModel):
    """Response model for account connector data."""

    id: int
    account_id: int
    connector_type: str
    enabled: bool
    config: Dict[str, Any]
    credentials_ref: Optional[str]
    sync_priority: int
    last_sync_at: Optional[str]
    last_sync_status: Optional[str]
    last_error: Optional[str]
    color: Optional[str] = None
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
    is_file_connector: bool = False


# ============================================================================
# Helper Functions
# ============================================================================


def get_available_connectors() -> Dict[str, ConnectorTypeInfo]:
    """Get available connectors from ConnectorRegistry."""
    registry = get_connector_registry()
    available = {}
    for connector_type in registry.list_types():
        info = registry.get(connector_type)
        if info:
            available[connector_type] = ConnectorTypeInfo(
                type=connector_type,
                category=info.category,
                display_name=info.display_name,
                supported_chains=info.supported_chains,
                required_config=info.required_config,
                optional_config=info.optional_config,
                is_file_connector=info.is_file_connector,
            )
    return available


# ============================================================================
# More Helper Functions
# ============================================================================


def get_account_or_404(session: Session, account_id: int) -> Account:
    """Get account by ID or raise 404."""
    account = session.get(Account, account_id)
    if not account:
        raise HTTPException(status_code=404, detail=f"Account {account_id} not found")
    return account


def resolve_credentials(credentials_ref: Optional[str]) -> Optional[str]:
    """
    Resolve credentials reference to actual value.

    Supports:
    - env:VAR_NAME - Read from environment variable
    - vault:path/to/secret - Read from HashiCorp Vault (future)
    - None - No credentials needed
    """
    if not credentials_ref:
        return None

    if credentials_ref.startswith("env:"):
        env_var = credentials_ref[4:]
        return os.getenv(env_var)

    if credentials_ref.startswith("vault:"):
        # Future: implement vault integration
        raise HTTPException(
            status_code=501, detail="Vault credentials not yet implemented"
        )

    # Direct value (not recommended, but supported)
    return credentials_ref


def connector_to_response(connector: AccountConnector) -> AccountConnectorResponse:
    """Convert AccountConnector model to API response."""
    return AccountConnectorResponse(
        id=connector.id,
        account_id=connector.account_id,
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
        color=connector.color,
        created_at=connector.created_at.isoformat(),
        updated_at=connector.updated_at.isoformat(),
    )


def get_repo(session: Session) -> AccountConnectorRepository:
    """Get AccountConnectorRepository instance."""
    return AccountConnectorRepository(session)


# ============================================================================
# API Routes
# ============================================================================


@router.get("/types", response_model=List[ConnectorTypeInfo])
def list_connector_types():
    """
    List all available connector types and their configuration requirements.
    """
    return list(get_available_connectors().values())


@router.get("/", response_model=List[AccountConnectorResponse])
def list_account_connectors(
    account_id: int,
    enabled_only: bool = Query(False, description="Filter to only enabled connectors"),
    session: Session = Depends(get_session_dependency),
):
    """
    List all connectors for an account.
    """
    get_account_or_404(session, account_id)
    repo = get_repo(session)

    connectors = repo.get_by_account(account_id, enabled_only=enabled_only)

    return [connector_to_response(c) for c in connectors]


@router.get("/{connector_type}", response_model=AccountConnectorResponse)
def get_account_connector(
    account_id: int,
    connector_type: str,
    session: Session = Depends(get_session_dependency),
):
    """
    Get a specific connector for an account.
    """
    get_account_or_404(session, account_id)
    repo = get_repo(session)

    connector = repo.get_by_account_and_type(account_id, connector_type)

    if not connector:
        raise HTTPException(
            status_code=404,
            detail=f"Connector '{connector_type}' not found for account {account_id}",
        )

    return connector_to_response(connector)


@router.post("/", response_model=AccountConnectorResponse, status_code=201)
def create_account_connector(
    account_id: int,
    connector_data: AccountConnectorCreate,
    session: Session = Depends(get_session_dependency),
):
    """
    Create a new connector for an account.
    """
    get_account_or_404(session, account_id)
    repo = get_repo(session)

    # Get available connectors from registry
    available_connectors = get_available_connectors()

    # Validate connector type
    if connector_data.connector_type not in available_connectors:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid connector_type. Must be one of: {', '.join(available_connectors.keys())}",
        )

    # Check for duplicate using repository
    existing = repo.get_by_account_and_type(account_id, connector_data.connector_type)

    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Connector '{connector_data.connector_type}' already exists for this account",
        )

    # Validate required config
    connector_info = available_connectors[connector_data.connector_type]
    
    # Get the account to check for address inheritance
    account = session.get(Account, account_id)
    
    missing_config = [
        field
        for field in connector_info.required_config
        if field not in connector_data.config or connector_data.config[field] is None
    ]
    
    # Allow missing 'address' for onchain connectors if account has address_or_identifier
    if "address" in missing_config and connector_info.category == "onchain":
        if account and account.address_or_identifier:
            missing_config.remove("address")
    
    if missing_config:
        raise HTTPException(
            status_code=400,
            detail=f"Missing required config fields: {', '.join(missing_config)}",
        )

    # Validate chain if applicable
    if connector_info.supported_chains and "chain" in connector_data.config:
        chain = connector_data.config["chain"]
        if chain not in connector_info.supported_chains:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid chain '{chain}'. Supported: {', '.join(connector_info.supported_chains)}",
            )

    connector = AccountConnector(
        account_id=account_id,
        connector_type=connector_data.connector_type,
        enabled=connector_data.enabled,
        config=connector_data.config,
        credentials_ref=connector_data.credentials_ref,
        sync_priority=connector_data.sync_priority,
        color=connector_data.color,
    )

    created = repo.create(connector)
    session.commit()

    return connector_to_response(created)


@router.put("/{connector_type}", response_model=AccountConnectorResponse)
def update_account_connector(
    account_id: int,
    connector_type: str,
    connector_data: AccountConnectorUpdate,
    session: Session = Depends(get_session_dependency),
):
    """
    Update an existing connector for an account.
    """
    get_account_or_404(session, account_id)
    repo = get_repo(session)

    connector = repo.get_by_account_and_type(account_id, connector_type)

    if not connector:
        raise HTTPException(
            status_code=404,
            detail=f"Connector '{connector_type}' not found for account {account_id}",
        )

    # Update fields
    if connector_data.enabled is not None:
        connector.enabled = connector_data.enabled
    if connector_data.config is not None:
        connector.config = connector_data.config
    if connector_data.credentials_ref is not None:
        connector.credentials_ref = connector_data.credentials_ref
    if connector_data.sync_priority is not None:
        connector.sync_priority = connector_data.sync_priority
    if connector_data.color is not None:
        connector.color = connector_data.color

    updated = repo.update(connector)
    session.commit()

    return connector_to_response(updated)


@router.patch("/{connector_type}/toggle", response_model=AccountConnectorResponse)
def toggle_account_connector(
    account_id: int,
    connector_type: str,
    session: Session = Depends(get_session_dependency),
):
    """
    Toggle the enabled state of a connector.
    """
    get_account_or_404(session, account_id)
    repo = get_repo(session)

    connector = repo.get_by_account_and_type(account_id, connector_type)

    if not connector:
        raise HTTPException(
            status_code=404,
            detail=f"Connector '{connector_type}' not found for account {account_id}",
        )

    connector.enabled = not connector.enabled

    updated = repo.update(connector)
    session.commit()

    return connector_to_response(updated)


@router.delete("/{connector_type}", status_code=204)
def delete_account_connector(
    account_id: int,
    connector_type: str,
    session: Session = Depends(get_session_dependency),
):
    """
    Delete a connector from an account and all its associated data.
    Uses DataCleanupService to handle the full FK dependency tree.
    """
    get_account_or_404(session, account_id)
    repo = get_repo(session)

    connector = repo.get_by_account_and_type(account_id, connector_type)

    if not connector:
        raise HTTPException(
            status_code=404,
            detail=f"Connector '{connector_type}' not found for account {account_id}",
        )

    service = DataCleanupService(session)
    service.execute_connector_cleanup([connector.id], delete_connectors=True)
    session.commit()

    return None


# ============================================================================
# Additional Routes for Sync Operations
# ============================================================================


@router.post("/{connector_type}/sync-status")
def update_sync_status(
    account_id: int,
    connector_type: str,
    status: str = Query(..., description="New sync status"),
    error: Optional[str] = Query(None, description="Error message if failed"),
    session: Session = Depends(get_session_dependency),
):
    """
    Update the sync status of a connector (called by sync job).
    """
    valid_statuses = ["pending", "running", "success", "failed"]
    if status not in valid_statuses:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status. Must be one of: {', '.join(valid_statuses)}",
        )

    repo = get_repo(session)
    connector = repo.get_by_account_and_type(account_id, connector_type)

    if not connector:
        raise HTTPException(
            status_code=404,
            detail=f"Connector '{connector_type}' not found for account {account_id}",
        )

    repo.update_sync_status(connector.id, status, error)
    session.commit()

    return {
        "status": "updated",
        "connector_type": connector_type,
        "sync_status": status,
    }
