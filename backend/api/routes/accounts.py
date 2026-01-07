"""
API routes for Account CRUD operations.
"""

from typing import List, Optional
from fastapi import APIRouter, HTTPException, Depends, Query
from sqlmodel import Session, select, col
from backend.db.models import Account
from backend.db.database import get_session_dependency

router = APIRouter(prefix="/accounts", tags=["accounts"])


# ============================================================================
# Pydantic Models for API
# ============================================================================


from pydantic import BaseModel


class AccountCreate(BaseModel):
    """Request model for creating an account."""

    name: str
    account_type: str
    address_or_identifier: Optional[str] = None
    tags: Optional[List[str]] = None
    owned: bool = True
    enabled: bool = True


class AccountUpdate(BaseModel):
    """Request model for updating an account."""

    name: Optional[str] = None
    account_type: Optional[str] = None
    address_or_identifier: Optional[str] = None
    tags: Optional[List[str]] = None
    owned: Optional[bool] = None
    enabled: Optional[bool] = None


class AccountResponse(BaseModel):
    """Response model for account data."""

    id: int
    name: str
    account_type: str
    address_or_identifier: Optional[str]
    tags: Optional[List[str]]
    owned: bool
    enabled: bool
    created_at: str

    class Config:
        from_attributes = True


# ============================================================================
# API Routes
# ============================================================================


@router.get("/", response_model=List[AccountResponse])
def list_accounts(
    account_type: Optional[str] = Query(None, description="Filter by account type"),
    search: Optional[str] = Query(None, description="Search in name or identifier"),
    session: Session = Depends(get_session_dependency),
):
    """
    List all accounts with optional filtering.

    Args:
        account_type: Filter by account type (cex, broker, wallet)
        search: Search text for name or address_or_identifier
        session: Database session

    Returns:
        List of accounts
    """
    statement = select(Account)

    if account_type:
        statement = statement.where(Account.account_type == account_type)

    if search:
        search_pattern = f"%{search}%"
        statement = statement.where(
            (col(Account.name).ilike(search_pattern))
            | (col(Account.address_or_identifier).ilike(search_pattern))
        )

    statement = statement.order_by(Account.created_at.desc())
    accounts = session.exec(statement).all()

    return [
        AccountResponse(
            id=acc.id,
            name=acc.name,
            account_type=acc.account_type,
            address_or_identifier=acc.address_or_identifier,
            tags=acc.tags or [],
            owned=acc.owned,
            enabled=acc.enabled,
            created_at=acc.created_at.isoformat(),
        )
        for acc in accounts
    ]


@router.get("/{account_id}", response_model=AccountResponse)
def get_account(account_id: int, session: Session = Depends(get_session_dependency)):
    """
    Get a single account by ID.

    Args:
        account_id: Account ID
        session: Database session

    Returns:
        Account details
    """
    account = session.get(Account, account_id)
    if not account:
        raise HTTPException(status_code=404, detail=f"Account {account_id} not found")

    return AccountResponse(
        id=account.id,
        name=account.name,
        account_type=account.account_type,
        address_or_identifier=account.address_or_identifier,
        tags=account.tags or [],
        owned=account.owned,
        enabled=account.enabled,
        created_at=account.created_at.isoformat(),
    )


@router.post("/", response_model=AccountResponse, status_code=201)
def create_account(
    account_data: AccountCreate,
    session: Session = Depends(get_session_dependency),
):
    """
    Create a new account.

    Args:
        account_data: Account creation data
        session: Database session

    Returns:
        Created account
    """
    # Validate account_type
    valid_types = ["cex", "broker", "wallet"]
    if account_data.account_type not in valid_types:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid account_type. Must be one of: {', '.join(valid_types)}",
        )

    # Check for duplicate name
    existing = session.exec(
        select(Account).where(Account.name == account_data.name)
    ).first()
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Account with name '{account_data.name}' already exists",
        )

    account = Account(
        name=account_data.name,
        account_type=account_data.account_type,
        address_or_identifier=account_data.address_or_identifier,
        tags=account_data.tags or [],
        owned=account_data.owned,
        enabled=account_data.enabled,
    )

    session.add(account)
    session.commit()
    session.refresh(account)

    return AccountResponse(
        id=account.id,
        name=account.name,
        account_type=account.account_type,
        address_or_identifier=account.address_or_identifier,
        tags=account.tags or [],
        owned=account.owned,
        enabled=account.enabled,
        created_at=account.created_at.isoformat(),
    )


@router.put("/{account_id}", response_model=AccountResponse)
def update_account(
    account_id: int,
    account_data: AccountUpdate,
    session: Session = Depends(get_session_dependency),
):
    """
    Update an existing account.

    Args:
        account_id: Account ID to update
        account_data: Updated account data
        session: Database session

    Returns:
        Updated account
    """
    account = session.get(Account, account_id)
    if not account:
        raise HTTPException(status_code=404, detail=f"Account {account_id} not found")

    # Validate account_type if provided
    if account_data.account_type is not None:
        valid_types = ["cex", "broker", "wallet"]
        if account_data.account_type not in valid_types:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid account_type. Must be one of: {', '.join(valid_types)}",
            )

    # Check for duplicate name if name is being changed
    if account_data.name and account_data.name != account.name:
        existing = session.exec(
            select(Account).where(Account.name == account_data.name)
        ).first()
        if existing:
            raise HTTPException(
                status_code=400,
                detail=f"Account with name '{account_data.name}' already exists",
            )

    # Update fields
    if account_data.name is not None:
        account.name = account_data.name
    if account_data.account_type is not None:
        account.account_type = account_data.account_type
    if account_data.address_or_identifier is not None:
        account.address_or_identifier = account_data.address_or_identifier
    if account_data.tags is not None:
        account.tags = account_data.tags
    if account_data.owned is not None:
        account.owned = account_data.owned
    if account_data.enabled is not None:
        account.enabled = account_data.enabled

    session.add(account)
    session.commit()
    session.refresh(account)

    return AccountResponse(
        id=account.id,
        name=account.name,
        account_type=account.account_type,
        address_or_identifier=account.address_or_identifier,
        tags=account.tags or [],
        owned=account.owned,
        enabled=account.enabled,
        created_at=account.created_at.isoformat(),
    )


@router.delete("/{account_id}", status_code=204)
def delete_account(account_id: int, session: Session = Depends(get_session_dependency)):
    """
    Delete an account.

    Args:
        account_id: Account ID to delete
        session: Database session

    Returns:
        No content
    """
    account = session.get(Account, account_id)
    if not account:
        raise HTTPException(status_code=404, detail=f"Account {account_id} not found")

    session.delete(account)
    session.commit()

    return None
