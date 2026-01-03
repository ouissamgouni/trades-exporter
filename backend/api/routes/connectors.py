"""
API routes for global Connector operations (cross-account).

Provides a unified view of all connectors across all accounts.
"""

from typing import List, Optional, Dict, Any
from fastapi import APIRouter, HTTPException, Depends, Query
from sqlmodel import Session, select
from pydantic import BaseModel

from backend.db.models import Account, AccountConnector
from backend.db.database import get_session_dependency
from backend.connectors.connector_registry import get_connector_registry

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

    class Config:
        from_attributes = True


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
