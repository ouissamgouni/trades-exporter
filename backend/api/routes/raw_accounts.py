"""
Raw Accounts endpoints for the Trade Exporter API.
Maps source-specific account labels/addresses to normalized accounts.
"""

import time
from fastapi import APIRouter, HTTPException, Query, Depends
from typing import List, Optional
from datetime import datetime
from pydantic import BaseModel, Field
from sqlmodel import Session, select, func
from sqlalchemy import update, or_
from sqlalchemy.exc import OperationalError

from backend.db.database import get_db
from backend.db.models import RawAccount, NormalizedTransaction
from backend.config.loader import configure_logging

log = configure_logging("raw_accounts_api")
router = APIRouter(prefix="/raw-accounts", tags=["Raw Accounts"])


class RawAccountCreate(BaseModel):
    """Request model for creating a raw account."""

    source: str
    label: str
    network: str = ""
    account_id: Optional[int] = None


class RawAccountUpdate(BaseModel):
    """Request model for updating a raw account."""

    account_id: Optional[int] = None


class RawAccountResponse(BaseModel):
    """Response model for raw account."""

    id: int
    source: str
    label: str
    network: str = ""
    account_id: Optional[int] = None
    transaction_count: int = 0
    dismissed: bool = False
    dismissed_at: Optional[datetime] = None
    dismissed_reason: Optional[str] = None


class BulkMapAccountItem(BaseModel):
    """Single item for bulk account mapping."""
    raw_account_id: int = Field(..., description="Raw account ID")
    account_id: int = Field(..., description="Target account_id to map to")


class BulkMapAccountRequest(BaseModel):
    """Request model for bulk account mapping."""
    mappings: List[BulkMapAccountItem] = Field(..., description="List of mappings to apply")


class DismissRequest(BaseModel):
    """Request model for dismissing a raw account."""
    reason: str = Field(..., description="Reason for dismissing this raw account mapping")


class BulkDismissItem(BaseModel):
    """Single item for bulk dismiss."""
    source: str = Field(..., description="Source identifier")
    label: str = Field(..., description="Raw account label")
    network: str = Field("", description="Network/chain filter")
    reason: str = Field(..., description="Reason for dismissing")


class BulkDismissRequest(BaseModel):
    """Request model for bulk dismiss."""
    items: List[BulkDismissItem] = Field(..., description="List of raw accounts to dismiss")


class BulkMapAccountResponse(BaseModel):
    """Response model for bulk mapping operations."""
    success_count: int = Field(..., description="Number of successful mappings")
    failed_count: int = Field(..., description="Number of failed mappings")
    errors: List[str] = Field(default_factory=list, description="Error messages for failed mappings")


@router.post("/bulk-map", response_model=BulkMapAccountResponse)
def bulk_map_accounts(
    request: BulkMapAccountRequest,
    session: Session = Depends(get_db),
):
    """
    Bulk map multiple raw accounts to normalized accounts.
    
    Each mapping updates the raw_account record and propagates to all linked transactions.
    Used by "Apply All Suggestions" feature in Data Health Check.
    """
    success_count = 0
    failed_count = 0
    errors = []
    
    try:
        for item in request.mappings:
            try:
                # Find the raw account by ID
                raw_account = session.get(RawAccount, item.raw_account_id)
                
                if not raw_account:
                    failed_count += 1
                    errors.append(f"Raw account ID {item.raw_account_id} not found")
                    continue
                
                source = raw_account.source
                label = raw_account.label
                network = raw_account.network
                raw_account.account_id = item.account_id
                
                # Propagate to transactions
                # When network is set, only propagate to matching-network transactions
                # Update from_account_id for transactions matching source_from_account
                from_conditions = [
                    NormalizedTransaction.source == source,
                    NormalizedTransaction.source_from_account == label,
                ]
                if network:
                    from_conditions.append(NormalizedTransaction.network == network)
                stmt_from = (
                    update(NormalizedTransaction)
                    .where(*from_conditions)
                    .values(from_account_id=item.account_id)
                )
                session.exec(stmt_from)
                
                # Update to_account_id for transactions matching source_to_account
                to_conditions = [
                    NormalizedTransaction.source == source,
                    NormalizedTransaction.source_to_account == label,
                ]
                if network:
                    to_conditions.append(NormalizedTransaction.network == network)
                stmt_to = (
                    update(NormalizedTransaction)
                    .where(*to_conditions)
                    .values(to_account_id=item.account_id)
                )
                session.exec(stmt_to)
                
                # Update account_id for transactions matching source_account
                account_conditions = [
                    NormalizedTransaction.source == source,
                    NormalizedTransaction.source_account == label,
                ]
                if network:
                    account_conditions.append(NormalizedTransaction.network == network)
                stmt_account = (
                    update(NormalizedTransaction)
                    .where(*account_conditions)
                    .values(account_id=item.account_id)
                )
                session.exec(stmt_account)
                
                success_count += 1
                
            except Exception as e:
                failed_count += 1
                errors.append(f"Raw account ID {item.raw_account_id}: {str(e)}")
        
        session.commit()
        
        return BulkMapAccountResponse(
            success_count=success_count,
            failed_count=failed_count,
            errors=errors
        )
        
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=f"Bulk mapping failed: {str(e)}")


@router.get("", response_model=List[RawAccountResponse])
def list_raw_accounts(
    source: Optional[str] = Query(None, description="Filter by source"),
    has_account_id: Optional[bool] = Query(
        None, description="Filter by whether account_id is set"
    ),
    include_dismissed: bool = Query(
        False, description="Include dismissed raw accounts in results"
    ),
    only_valid_pending: bool = Query(
        False, description="Only include raw accounts used in valid/pending transactions (excludes invalid)"
    ),
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of results"),
    offset: int = Query(0, ge=0, description="Number of results to skip"),
    session: Session = Depends(get_db),
):
    """
    List raw accounts with optional filtering.

    - **source**: Filter by source exchange/platform
    - **has_account_id**: Filter by whether account_id is linked
    - **include_dismissed**: Include dismissed raw accounts (default: False)
    - **only_valid_pending**: Only show raw accounts used in valid/pending transactions (default: False)
    - **limit**: Maximum number of results to return
    - **offset**: Number of results to skip for pagination
    """
    try:
        statement = select(RawAccount)

        if source:
            statement = statement.where(RawAccount.source == source)

        if has_account_id is True:
            statement = statement.where(RawAccount.account_id != None)
        elif has_account_id is False:
            statement = statement.where(RawAccount.account_id == None)
        
        # Filter dismissed by default
        if not include_dismissed:
            statement = statement.where(RawAccount.dismissed == False)
        
        # Filter to only raw accounts used in valid/pending transactions
        if only_valid_pending:
            from backend.db.models import ReviewStatus
            from sqlalchemy import tuple_
            
            # Subquery to find raw accounts used in non-invalid transactions
            valid_pending_subquery = (
                select(RawAccount.source, RawAccount.label)
                .select_from(RawAccount)
                .join(
                    NormalizedTransaction,
                    or_(
                        (NormalizedTransaction.source == RawAccount.source) & (NormalizedTransaction.source_account == RawAccount.label),
                        (NormalizedTransaction.source == RawAccount.source) & (NormalizedTransaction.source_from_account == RawAccount.label),
                        (NormalizedTransaction.source == RawAccount.source) & (NormalizedTransaction.source_to_account == RawAccount.label),
                    )
                )
                .where(NormalizedTransaction.review_status != ReviewStatus.INVALID)
                .distinct()
            )
            
            # Apply the filter
            statement = statement.where(
                tuple_(RawAccount.source, RawAccount.label).in_(valid_pending_subquery)
            )

        statement = (
            statement.order_by(RawAccount.source, RawAccount.label)
            .offset(offset)
            .limit(limit)
        )

        raw_accounts = session.exec(statement).all()

        # Build response with transaction counts
        results = []
        for ra in raw_accounts:
            # Count transactions that reference this raw account
            tx_count_stmt = select(func.count()).select_from(NormalizedTransaction).where(
                NormalizedTransaction.source == ra.source,
                or_(
                    NormalizedTransaction.source_account == ra.label,
                    NormalizedTransaction.source_from_account == ra.label,
                    NormalizedTransaction.source_to_account == ra.label,
                )
            )
            
            # Exclude invalid transactions if only_valid_pending is true
            if only_valid_pending:
                from backend.db.models import ReviewStatus
                tx_count_stmt = tx_count_stmt.where(NormalizedTransaction.review_status != ReviewStatus.INVALID)
            
            tx_count = session.exec(tx_count_stmt).one()
            
            results.append(
                RawAccountResponse(
                    id=ra.id,
                    source=ra.source,
                    label=ra.label,
                    network=ra.network,
                    account_id=ra.account_id,
                    transaction_count=tx_count,
                    dismissed=ra.dismissed,
                    dismissed_at=ra.dismissed_at,
                    dismissed_reason=ra.dismissed_reason,
                )
            )
        
        # Sort by transaction count descending
        results.sort(key=lambda x: x.transaction_count, reverse=True)
        
        return results

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/count")
def count_raw_accounts(
    source: Optional[str] = Query(None, description="Filter by source"),
    has_account_id: Optional[bool] = Query(
        None, description="Filter by whether account_id is set"
    ),
    include_dismissed: bool = Query(
        False, description="Include dismissed raw accounts in count"
    ),
    session: Session = Depends(get_db),
):
    """
    Count raw accounts with optional filtering.
    """
    try:
        from sqlmodel import func

        statement = select(func.count()).select_from(RawAccount)

        if source:
            statement = statement.where(RawAccount.source == source)

        if has_account_id is True:
            statement = statement.where(RawAccount.account_id != None)
        elif has_account_id is False:
            statement = statement.where(RawAccount.account_id == None)
        
        # Filter dismissed by default
        if not include_dismissed:
            statement = statement.where(RawAccount.dismissed == False)

        count = session.exec(statement).one()
        return {"count": count}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/{source}/{label}", response_model=RawAccountResponse)
def get_raw_account(
    source: str,
    label: str,
    network: str = Query("", description="Network/chain filter"),
    session: Session = Depends(get_db),
):
    """
    Get a specific raw account by composite key.

    - **source**: Source exchange/platform name
    - **label**: Account label/address from the source
    - **network**: Network/chain filter (optional)
    """
    try:
        statement = select(RawAccount).where(
            RawAccount.source == source,
            RawAccount.label == label,
            RawAccount.network == network,
        )
        raw_account = session.exec(statement).first()

        if not raw_account:
            raise HTTPException(status_code=404, detail="Raw account not found")

        # Count transactions for this raw account
        tx_count_stmt = select(func.count()).select_from(NormalizedTransaction).where(
            NormalizedTransaction.source == raw_account.source,
            or_(
                NormalizedTransaction.source_account == raw_account.label,
                NormalizedTransaction.source_from_account == raw_account.label,
                NormalizedTransaction.source_to_account == raw_account.label,
            )
        )
        tx_count = session.exec(tx_count_stmt).one()
        
        return RawAccountResponse(
            id=raw_account.id,
            source=raw_account.source,
            label=raw_account.label,
            network=raw_account.network,
            account_id=raw_account.account_id,
            transaction_count=tx_count,
            dismissed=raw_account.dismissed,
            dismissed_at=raw_account.dismissed_at,
            dismissed_reason=raw_account.dismissed_reason,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/{source}/{label}/transactions")
def get_raw_account_transactions(
    source: str,
    label: str,
    network: str = Query("", description="Network/chain filter (optional)"),
    field_type: str = Query(
        "all",
        description="Filter by field type: 'account' (source_account), 'from' (source_from_account), 'to' (source_to_account), or 'all'"
    ),
    limit: int = Query(1000, ge=1, le=10000, description="Maximum number of transactions to return"),
    offset: int = Query(0, ge=0, description="Number of transactions to skip"),
    session: Session = Depends(get_db),
):
    """
    Get all transactions associated with a specific raw account.
    
    Returns transactions where the raw account label appears in:
    - source_account (main account for CEX trades) - field_type='account'
    - source_from_account (transfer sender) - field_type='from'
    - source_to_account (transfer recipient) - field_type='to'
    - all of the above - field_type='all' (default)
    
    - **source**: Source exchange/platform name
    - **label**: Account label/address from the source
    - **field_type**: Filter by specific field type or 'all'
    - **limit**: Maximum number of results to return
    - **offset**: Number of results to skip for pagination
    """
    try:
        from backend.api.routes.transactions import _build_transaction_response
        from sqlalchemy.orm import joinedload
        
        # Build field-specific filter conditions
        field_conditions = []
        if field_type in ["account", "all"]:
            field_conditions.append(NormalizedTransaction.source_account == label)
        if field_type in ["from", "all"]:
            field_conditions.append(NormalizedTransaction.source_from_account == label)
        if field_type in ["to", "all"]:
            field_conditions.append(NormalizedTransaction.source_to_account == label)
        
        if not field_conditions:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid field_type: {field_type}. Must be 'account', 'from', 'to', or 'all'"
            )
        
        # Build base conditions (source + optional network)
        base_conditions = [NormalizedTransaction.source == source]
        if network:
            base_conditions.append(NormalizedTransaction.network == network)

        # Query transactions matching this raw account with necessary joins
        statement = (
            select(NormalizedTransaction)
            .options(
                joinedload(NormalizedTransaction.asset),
                joinedload(NormalizedTransaction.price_quote_asset),
                joinedload(NormalizedTransaction.fee_quote_asset),
                joinedload(NormalizedTransaction.account_rel),
                joinedload(NormalizedTransaction.from_account),
                joinedload(NormalizedTransaction.to_account),
                joinedload(NormalizedTransaction.sync_connector_run),
            )
            .where(
                *base_conditions,
                or_(*field_conditions)
            )
            .order_by(NormalizedTransaction.date_time.desc())
        )
        
        # Get field-specific counts for metadata
        account_count_stmt = select(func.count()).select_from(NormalizedTransaction).where(
            *base_conditions,
            NormalizedTransaction.source_account == label
        )
        from_count_stmt = select(func.count()).select_from(NormalizedTransaction).where(
            *base_conditions,
            NormalizedTransaction.source_from_account == label
        )
        to_count_stmt = select(func.count()).select_from(NormalizedTransaction).where(
            *base_conditions,
            NormalizedTransaction.source_to_account == label
        )
        
        account_count = session.exec(account_count_stmt).one()
        from_count = session.exec(from_count_stmt).one()
        to_count = session.exec(to_count_stmt).one()
        total_count = account_count + from_count + to_count
        account_count = session.exec(account_count_stmt).one()
        from_count = session.exec(from_count_stmt).one()
        to_count = session.exec(to_count_stmt).one()
        total_count = account_count + from_count + to_count
        
        # Apply pagination
        statement = statement.offset(offset).limit(limit)
        transactions = session.exec(statement).all()
        
        return {
            "results": [_build_transaction_response(tx, session) for tx in transactions],
            "metadata": {
                "total_count": total_count,
                "account_count": account_count,
                "from_count": from_count,
                "to_count": to_count,
                "filtered_count": len(transactions),
                "field_type": field_type,
                "limit": limit,
                "offset": offset,
            }
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.post("", response_model=RawAccountResponse)
def create_raw_account(
    raw_account_data: RawAccountCreate,
    session: Session = Depends(get_db),
):
    """
    Create a new raw account mapping.

    - **raw_account_data**: The raw account data to create
    """
    try:
        # Check if raw account already exists
        statement = select(RawAccount).where(
            RawAccount.source == raw_account_data.source,
            RawAccount.label == raw_account_data.label,
            RawAccount.network == raw_account_data.network,
        )
        existing = session.exec(statement).first()

        if existing:
            raise HTTPException(
                status_code=400,
                detail=f"Raw account ({raw_account_data.source}, {raw_account_data.label}, {raw_account_data.network}) already exists",
            )

        raw_account = RawAccount(
            source=raw_account_data.source,
            label=raw_account_data.label,
            network=raw_account_data.network,
            account_id=raw_account_data.account_id,
        )

        session.add(raw_account)
        session.commit()
        session.refresh(raw_account)

        return RawAccountResponse(
            id=raw_account.id,
            source=raw_account.source,
            label=raw_account.label,
            network=raw_account.network,
            account_id=raw_account.account_id,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.patch("/{source}/{label}", response_model=RawAccountResponse)
def update_raw_account(
    source: str,
    label: str,
    account_update: RawAccountUpdate,
    network: str = Query("", description="Network/chain filter (optional)"),
    session: Session = Depends(get_db),
):
    """
    Update a raw account's account_id.
    When account_id is updated, propagates to all linked transactions.

    - **source**: Source exchange/platform name
    - **label**: Account label/address from the source
    - **update**: Fields to update
    """
    max_retries = 3
    for attempt in range(max_retries):
        try:
            # Lock the raw_account row first to serialize concurrent updates
            statement = (
                select(RawAccount)
                .where(
                    RawAccount.source == source,
                    RawAccount.label == label,
                    RawAccount.network == network,
                )
                .with_for_update()
            )
            existing = session.exec(statement).first()

            if not existing:
                raise HTTPException(status_code=404, detail="Raw account not found")

            # Update account_id
            update_data = account_update.model_dump(exclude_unset=True)
            if "account_id" in update_data:
                new_account_id = update_data["account_id"]
                existing.account_id = new_account_id

                # Propagate account_id to transactions where this raw account is used.
                # Lock affected rows first (sorted by id) to prevent deadlocks when
                # two concurrent updates touch overlapping transaction sets.
                base_conditions = [NormalizedTransaction.source == source]
                if network:
                    base_conditions.append(NormalizedTransaction.network == network)

                # Find all transaction IDs that match any of the three source fields
                affected_ids_stmt = (
                    select(NormalizedTransaction.id)
                    .where(
                        *base_conditions,
                        or_(
                            NormalizedTransaction.source_from_account == label,
                            NormalizedTransaction.source_to_account == label,
                            NormalizedTransaction.source_account == label,
                        ),
                    )
                    .order_by(NormalizedTransaction.id)
                    .with_for_update()
                )
                affected_ids = [row for row in session.exec(affected_ids_stmt).all()]

                if affected_ids:
                    # Update from_account_id
                    stmt_from = (
                        update(NormalizedTransaction)
                        .where(
                            NormalizedTransaction.id.in_(affected_ids),
                            NormalizedTransaction.source_from_account == label,
                        )
                        .values(from_account_id=new_account_id)
                    )
                    session.exec(stmt_from)

                    # Update to_account_id
                    stmt_to = (
                        update(NormalizedTransaction)
                        .where(
                            NormalizedTransaction.id.in_(affected_ids),
                            NormalizedTransaction.source_to_account == label,
                        )
                        .values(to_account_id=new_account_id)
                    )
                    session.exec(stmt_to)

                    # Update account_id (ownership)
                    stmt_account = (
                        update(NormalizedTransaction)
                        .where(
                            NormalizedTransaction.id.in_(affected_ids),
                            NormalizedTransaction.source_account == label,
                        )
                        .values(account_id=new_account_id)
                    )
                    session.exec(stmt_account)

            session.add(existing)
            session.commit()
            session.refresh(existing)

            return RawAccountResponse(
                id=existing.id,
                source=existing.source,
                label=existing.label,
                network=existing.network,
                account_id=existing.account_id,
            )

        except OperationalError as e:
            session.rollback()
            if "deadlock detected" in str(e).lower() and attempt < max_retries - 1:
                time.sleep(0.1 * (attempt + 1))
                continue
            raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
        except HTTPException:
            raise
        except Exception as e:
            session.rollback()
            raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


class UpdateTransferSourceRequest(BaseModel):
    """Request model for updating a transaction's transfer source field."""
    field: str = Field(..., description="Field to update: 'source_from_account' or 'source_to_account'", pattern="^(source_from_account|source_to_account)$")
    value: str = Field(..., description="Value to set for the field")
    account_id: Optional[int] = Field(None, description="Optional account_id to link (creates RawAccount mapping)")


class UpdateTransferSourceResponse(BaseModel):
    """Response model for transfer source update."""
    transaction_id: int
    field: str
    value: str
    account_id_set: Optional[int] = None
    raw_account_created: bool = False


@router.patch("/transfer-source/{transaction_id}", response_model=UpdateTransferSourceResponse)
def update_transfer_source(
    transaction_id: int,
    request: UpdateTransferSourceRequest,
    session: Session = Depends(get_db),
):
    """
    Update a transaction's transfer source field (source_from_account or source_to_account).
    
    Optionally creates a RawAccount mapping if account_id is provided, which enables:
    - Linking the source value to a canonical account
    - Setting the corresponding from_account_id or to_account_id
    
    Use cases:
    - Setting source field only (external transfer): Provide value only
    - Setting source field + linking account (internal transfer): Provide value + account_id
    
    Args:
        transaction_id: Transaction ID to update
        request: Update request with field name, value, and optional account_id
    
    Returns:
        UpdateTransferSourceResponse with update details
    """
    max_retries = 3
    for attempt in range(max_retries):
        try:
            # Fetch transaction
            tx = session.get(NormalizedTransaction, transaction_id)
            if not tx:
                raise HTTPException(status_code=404, detail="Transaction not found")
            
            # Validate field matches transaction direction
            if request.field == "source_from_account" and tx.direction != "inflow":
                raise HTTPException(
                    status_code=400, 
                    detail="source_from_account only applies to inflow transactions"
                )
            if request.field == "source_to_account" and tx.direction != "outflow":
                raise HTTPException(
                    status_code=400, 
                    detail="source_to_account only applies to outflow transactions"
                )
            
            # Update the source field
            setattr(tx, request.field, request.value)
            
            raw_account_created = False
            account_id_set = None
            
            # If account_id provided, create/update RawAccount mapping and set account link
            if request.account_id is not None:
                # Check if RawAccount mapping already exists (FOR UPDATE to prevent deadlocks)
                tx_network = tx.network or ""
                existing_raw = session.exec(
                    select(RawAccount)
                    .where(
                        RawAccount.source == tx.source,
                        RawAccount.label == request.value,
                        RawAccount.network == tx_network,
                    )
                    .with_for_update()
                ).first()
                
                if existing_raw:
                    # Update existing mapping
                    existing_raw.account_id = request.account_id
                    session.add(existing_raw)
                else:
                    # Create new mapping
                    new_raw = RawAccount(
                        source=tx.source,
                        label=request.value,
                        network=tx_network,
                        account_id=request.account_id,
                    )
                    session.add(new_raw)
                    raw_account_created = True
                
                # Set the corresponding account link on transaction
                if request.field == "source_from_account":
                    tx.from_account_id = request.account_id
                else:  # source_to_account
                    tx.to_account_id = request.account_id
                
                account_id_set = request.account_id
            
            session.add(tx)
            session.commit()
            session.refresh(tx)
            
            return UpdateTransferSourceResponse(
                transaction_id=tx.id,
                field=request.field,
                value=request.value,
                account_id_set=account_id_set,
                raw_account_created=raw_account_created,
            )
        
        except OperationalError as e:
            session.rollback()
            if "deadlock detected" in str(e).lower() and attempt < max_retries - 1:
                time.sleep(0.1 * (attempt + 1))  # backoff: 100ms, 200ms
                continue
            raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
        except HTTPException:
            raise
        except Exception as e:
            session.rollback()
            raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.post("/{source}/{label}/dismiss")
def dismiss_raw_account(
    source: str,
    label: str,
    request: DismissRequest,
    network: str = Query("", description="Network/chain filter (optional)"),
    session: Session = Depends(get_db),
):
    """
    Dismiss a raw account mapping.
    
    Marks the raw account as dismissed with a reason, hiding it from
    default queries while preserving the data for audit purposes.
    
    - **source**: Source exchange/platform name
    - **label**: Account label/address from the source
    - **reason**: Reason for dismissing (e.g., "External account - not owned")
    """
    try:
        statement = select(RawAccount).where(
            RawAccount.source == source,
            RawAccount.label == label,
            RawAccount.network == network,
        )
        raw_account = session.exec(statement).first()
        
        if not raw_account:
            raise HTTPException(status_code=404, detail="Raw account not found")
        
        # Mark as dismissed
        raw_account.dismissed = True
        raw_account.dismissed_at = datetime.utcnow()
        raw_account.dismissed_reason = request.reason
        
        session.add(raw_account)
        session.commit()
        session.refresh(raw_account)
        
        log.info(f"Dismissed raw account {source}:{label}:{network} - Reason: {request.reason}")
        
        return {
            "message": "Raw account dismissed successfully",
            "source": source,
            "label": label,
            "network": network,
            "dismissed_at": raw_account.dismissed_at,
            "dismissed_reason": raw_account.dismissed_reason,
        }
    
    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        log.error(f"Error dismissing raw account: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.delete("/{source}/{label}/dismiss")
def undismiss_raw_account(
    source: str,
    label: str,
    network: str = Query("", description="Network/chain filter (optional)"),
    session: Session = Depends(get_db),
):
    """
    Un-dismiss a raw account mapping.
    
    Removes the dismissed flag, making the raw account visible again
    in default queries.
    
    - **source**: Source exchange/platform name
    - **label**: Account label/address from the source
    """
    try:
        statement = select(RawAccount).where(
            RawAccount.source == source,
            RawAccount.label == label,
            RawAccount.network == network,
        )
        raw_account = session.exec(statement).first()
        
        if not raw_account:
            raise HTTPException(status_code=404, detail="Raw account not found")
        
        if not raw_account.dismissed:
            raise HTTPException(status_code=400, detail="Raw account is not dismissed")
        
        # Remove dismiss flag
        raw_account.dismissed = False
        raw_account.dismissed_at = None
        raw_account.dismissed_reason = None
        
        session.add(raw_account)
        session.commit()
        session.refresh(raw_account)
        
        log.info(f"Un-dismissed raw account {source}:{label}:{network}")
        
        return {
            "message": "Raw account un-dismissed successfully",
            "source": source,
            "label": label,
            "network": network,
        }
    
    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        log.error(f"Error un-dismissing raw account: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.post("/bulk-dismiss")
def bulk_dismiss_raw_accounts(
    request: BulkDismissRequest,
    session: Session = Depends(get_db),
):
    """
    Dismiss multiple raw accounts in bulk.
    
    - **items**: List of raw accounts to dismiss with their reasons
    """
    try:
        dismissed_count = 0
        errors = []
        
        for item in request.items:
            try:
                statement = select(RawAccount).where(
                    RawAccount.source == item.source,
                    RawAccount.label == item.label,
                    RawAccount.network == item.network,
                )
                raw_account = session.exec(statement).first()
                
                if not raw_account:
                    errors.append(f"{item.source}:{item.label}:{item.network} not found")
                    continue
                
                raw_account.dismissed = True
                raw_account.dismissed_at = datetime.utcnow()
                raw_account.dismissed_reason = item.reason
                
                session.add(raw_account)
                dismissed_count += 1
                
            except Exception as e:
                errors.append(f"{item.source}:{item.label} - {str(e)}")
        
        session.commit()
        
        log.info(f"Bulk dismissed {dismissed_count} raw accounts")
        
        return {
            "message": f"Successfully dismissed {dismissed_count} raw account(s)",
            "dismissed_count": dismissed_count,
            "errors": errors if errors else None,
        }
    
    except Exception as e:
        session.rollback()
        log.error(f"Error in bulk dismiss: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.delete("/{source}/{label}")
def delete_raw_account(
    source: str,
    label: str,
    network: str = Query("", description="Network/chain filter (optional)"),
    session: Session = Depends(get_db),
):
    """
    Delete a raw account by composite key.

    - **source**: Source exchange/platform name
    - **label**: Account label/address from the source
    """
    try:
        statement = select(RawAccount).where(
            RawAccount.source == source,
            RawAccount.label == label,
            RawAccount.network == network,
        )
        existing = session.exec(statement).first()

        if not existing:
            raise HTTPException(status_code=404, detail="Raw account not found")

        session.delete(existing)
        session.commit()

        return {
            "message": "Raw account deleted successfully",
            "source": source,
            "label": label,
            "network": network,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
