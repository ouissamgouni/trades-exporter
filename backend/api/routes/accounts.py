"""
API routes for Account CRUD operations.
"""

from typing import List, Optional, Any, Dict
from fastapi import APIRouter, HTTPException, Depends, Query
from sqlmodel import Session, select, col, text
from backend.db.models import Account, AccountConnector, NormalizedTransaction
from backend.db.database import get_session_dependency
from backend.api.schemas import SuggestionInfo, AccountDeletePreviewResponse, CleanupPreviewResponse
from backend.services.similarity_service import get_top_account_suggestions
from backend.services.data_cleanup_service import DataCleanupService

router = APIRouter(prefix="/accounts", tags=["accounts"])


# ============================================================================
# Pydantic Models for API
# ============================================================================


from pydantic import BaseModel, ConfigDict


class AccountCreate(BaseModel):
    """Request model for creating an account."""

    name: str
    account_type: str
    address_or_identifier: Optional[str] = None
    group: Optional[str] = None
    tags: Optional[List[Dict[str, Any]]] = None
    owned: bool = True
    enabled: bool = True
    color: Optional[str] = None


class AccountUpdate(BaseModel):
    """Request model for updating an account."""

    name: Optional[str] = None
    account_type: Optional[str] = None
    address_or_identifier: Optional[str] = None
    group: Optional[str] = None
    tags: Optional[List[Dict[str, Any]]] = None
    owned: Optional[bool] = None
    enabled: Optional[bool] = None
    color: Optional[str] = None


class AccountResponse(BaseModel):
    """Response model for account data."""

    id: int
    name: str
    account_type: str
    address_or_identifier: Optional[str]
    group: Optional[str]
    tags: Optional[List[Dict[str, Any]]]
    owned: bool
    enabled: bool
    color: Optional[str]
    created_at: str

    model_config = ConfigDict(from_attributes=True)


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
            group=acc.group,
            tags=acc.tags or [],
            owned=acc.owned,
            enabled=acc.enabled,
            color=acc.color,
            created_at=acc.created_at.isoformat(),
        )
        for acc in accounts
    ]


# ============================================================================
# Account Suggestion Helpers
# ============================================================================


def _build_connectors_map(session: Session) -> Dict[int, list]:
    """Build account_id → list[AccountConnector] lookup from the database."""
    all_connectors = session.exec(select(AccountConnector)).all()
    connectors_map: Dict[int, list] = {}
    for c in all_connectors:
        connectors_map.setdefault(c.account_id, []).append(c)
    return connectors_map


# ============================================================================
# Account Suggestion Endpoints (must be before /{account_id} to avoid
# FastAPI matching "suggest" as an account_id path parameter)
# ============================================================================


class SuggestAccountItem(BaseModel):
    """Single item in a batch suggestion request."""
    label: str
    source: Optional[str] = None
    network: Optional[str] = None
    min_confidence: float = 0.5
    max_results: int = 3


class SuggestAccountBatchRequest(BaseModel):
    """Request for batch account suggestions."""
    items: List[SuggestAccountItem]


class SuggestAccountBatchResponseItem(BaseModel):
    """Response for a single batch suggestion request item."""
    label: str
    suggestions: List[SuggestionInfo]


@router.get("/suggest", response_model=List[SuggestionInfo])
def suggest_accounts(
    label: str = Query(..., description="Raw account label or address to match"),
    source: Optional[str] = Query(None, description="Connector source type (e.g. 'blockscout')"),
    network: Optional[str] = Query(None, description="Chain/network name (e.g. 'bsc', 'ethereum')"),
    min_confidence: float = Query(0.5, ge=0, le=1, description="Minimum confidence threshold"),
    max_results: int = Query(3, ge=1, le=20, description="Maximum number of suggestions"),
    session: Session = Depends(get_session_dependency),
):
    """
    Get network-aware account suggestions for a raw account label.

    Uses fuzzy matching with Levenshtein distance, boosted by connector
    source matching and filtered by chain/network when available.

    This is the centralized suggestion endpoint that should be used by all
    frontend components instead of client-side similarity matching.
    """
    all_accounts = session.exec(select(Account)).all()
    connectors_map = _build_connectors_map(session)

    return get_top_account_suggestions(
        label=label,
        accounts=all_accounts,
        min_confidence=min_confidence,
        max_results=max_results,
        source=source,
        account_connectors_map=connectors_map,
        network=network,
    )


@router.post("/suggest-batch", response_model=List[SuggestAccountBatchResponseItem])
def suggest_accounts_batch(
    request: SuggestAccountBatchRequest,
    session: Session = Depends(get_session_dependency),
):
    """
    Batch account suggestions — avoids N+1 API calls for bulk operations
    like auto-link or AccountMappingPanel.

    Each item in the request specifies a label (and optional source/network)
    and receives its own list of suggestions.
    """
    all_accounts = session.exec(select(Account)).all()
    connectors_map = _build_connectors_map(session)

    results: List[SuggestAccountBatchResponseItem] = []
    for item in request.items:
        suggestions = get_top_account_suggestions(
            label=item.label,
            accounts=all_accounts,
            min_confidence=item.min_confidence,
            max_results=item.max_results,
            source=item.source,
            account_connectors_map=connectors_map,
            network=item.network,
        )
        results.append(SuggestAccountBatchResponseItem(
            label=item.label,
            suggestions=suggestions,
        ))

    return results


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
        group=account.group,
        tags=account.tags or [],
        owned=account.owned,
        enabled=account.enabled,
        color=account.color,
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
    valid_types = ["cex", "dex", "broker", "wallet", "bank", "investment"]
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
        group=account_data.group,
        tags=account_data.tags or [],
        owned=account_data.owned,
        enabled=account_data.enabled,
        color=account_data.color,
    )

    session.add(account)
    session.commit()
    session.refresh(account)

    return AccountResponse(
        id=account.id,
        name=account.name,
        account_type=account.account_type,
        address_or_identifier=account.address_or_identifier,
        group=account.group,
        tags=account.tags or [],
        owned=account.owned,
        enabled=account.enabled,
        color=account.color,
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
        valid_types = ["cex", "dex", "broker", "wallet", "bank", "investment"]
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
    if account_data.group is not None:
        account.group = account_data.group
    if account_data.color is not None:
        account.color = account_data.color

    session.add(account)
    session.commit()
    session.refresh(account)

    return AccountResponse(
        id=account.id,
        name=account.name,
        account_type=account.account_type,
        address_or_identifier=account.address_or_identifier,
        group=account.group,
        tags=account.tags or [],
        owned=account.owned,
        enabled=account.enabled,
        color=account.color,
        created_at=account.created_at.isoformat(),
    )


@router.get("/{account_id}/delete-preview", response_model=AccountDeletePreviewResponse)
def delete_account_preview(account_id: int, session: Session = Depends(get_session_dependency)):
    """
    Preview what will be affected when deleting an account.
    Returns counts of all dependent rows without modifying anything.
    """
    account = session.get(Account, account_id)
    if not account:
        raise HTTPException(status_code=404, detail=f"Account {account_id} not found")

    def _count(sql: str) -> int:
        return session.exec(text(sql), params={"aid": account_id}).one()[0]

    transactions = _count("SELECT COUNT(*) FROM normalized_transactions WHERE account_id = :aid")
    connectors = _count("SELECT COUNT(*) FROM account_connectors WHERE account_id = :aid")
    cost_lots = _count("SELECT COUNT(*) FROM cost_lots WHERE account_id = :aid")
    derivative_positions = _count("SELECT COUNT(*) FROM derivative_positions WHERE account_id = :aid")
    raw_accounts = _count("SELECT COUNT(*) FROM raw_accounts WHERE account_id = :aid")
    transfer_references = _count(
        "SELECT COUNT(*) FROM normalized_transactions "
        "WHERE (from_account_id = :aid OR to_account_id = :aid) AND account_id != :aid"
    )

    conn_sub = "(SELECT id FROM account_connectors WHERE account_id = :aid)"
    sync_runs = _count(f"SELECT COUNT(*) FROM sync_job_connector_runs WHERE connector_id IN {conn_sub}")
    file_imports = _count(f"SELECT COUNT(*) FROM file_imports WHERE connector_id IN {conn_sub}")

    return AccountDeletePreviewResponse(
        account_id=account_id,
        account_name=account.name,
        transactions=transactions,
        connectors=connectors,
        cost_lots=cost_lots,
        derivative_positions=derivative_positions,
        raw_accounts=raw_accounts,
        transfer_references=transfer_references,
        sync_runs=sync_runs,
        file_imports=file_imports,
    )


@router.delete("/{account_id}", status_code=204)
def delete_account(account_id: int, session: Session = Depends(get_session_dependency)):
    """
    Delete an account and all dependent data.

    Uses DataCleanupService to handle the full FK dependency tree in correct order.
    """
    account = session.get(Account, account_id)
    if not account:
        raise HTTPException(status_code=404, detail=f"Account {account_id} not found")

    service = DataCleanupService(session)
    service.execute_account_delete(account_id)
    session.commit()

    return None


@router.post("/{account_id}/cleanup-preview", response_model=CleanupPreviewResponse)
def account_cleanup_preview(account_id: int, session: Session = Depends(get_session_dependency)):
    """
    Preview the impact of purging all data for an account (without deleting the account itself).
    """
    account = session.get(Account, account_id)
    if not account:
        raise HTTPException(status_code=404, detail=f"Account {account_id} not found")

    service = DataCleanupService(session)
    preview = service.preview_account_cleanup(account_id)

    return CleanupPreviewResponse(
        connector_ids=preview.connector_ids,
        connector_names=preview.connector_names,
        transactions=preview.transactions,
        raw_transactions=preview.raw_transactions,
        cost_lots=preview.cost_lots,
        sync_runs=preview.sync_runs,
        file_imports=preview.file_imports,
        transfer_references=preview.transfer_references,
        derivative_positions=preview.derivative_positions,
        pnl_legs_affected=preview.pnl_legs_affected,
    )


@router.post("/{account_id}/cleanup", status_code=204)
def account_cleanup(account_id: int, session: Session = Depends(get_session_dependency)):
    """
    Purge all data for an account while keeping the account and its connector configs.
    Resets connector sync status to 'pending'.
    """
    account = session.get(Account, account_id)
    if not account:
        raise HTTPException(status_code=404, detail=f"Account {account_id} not found")

    service = DataCleanupService(session)
    service.execute_account_cleanup(account_id, delete_connectors=False)
    session.commit()

    return None

