"""
Transaction endpoints for the Trade Exporter API.
"""

import uuid
from datetime import datetime
from fastapi import APIRouter, HTTPException, Query, Body, Depends
from typing import List, Optional, Dict
from pydantic import BaseModel, Field
from sqlmodel import Session, select
from sqlalchemy.orm import joinedload

from backend.api.schemas import TransactionResponse, TransactionUpdate
from backend.db.database import get_db
from backend.db.models import (
    NormalizedTransaction,
    Asset,
    CalculationUnit,
    Account,
    ReviewStatus,
    TaxabilityStatus,
    Direction,
    TransactionType,
)
from backend.services.pipeline import (
    create_default_pipeline,
    PipelineContext,
)

router = APIRouter(prefix="/transactions", tags=["Transactions"])


# ============================================================================
# Bulk Operation Models
# ============================================================================


class BulkUpdateRequest(BaseModel):
    """Request model for bulk updating transactions."""

    transaction_ids: List[int] = Field(..., description="IDs of transactions to update")
    review_status: Optional[ReviewStatus] = Field(
        None, description="New review status"
    )
    transaction_type: Optional[str] = Field(None, description="New transaction type")


class BulkStatusUpdate(BaseModel):
    """Request model for bulk review status update."""

    transaction_ids: List[int] = Field(..., description="IDs of transactions to update")
    review_status: ReviewStatus = Field(
        ..., description="New review status"
    )
    taxability_status: Optional[TaxabilityStatus] = Field(
        None,
        description="New taxability status",
    )


class BulkDeleteRequest(BaseModel):
    """Request model for bulk deleting transactions."""

    transaction_ids: List[int] = Field(..., description="IDs of transactions to delete")


class BulkAddToUnitRequest(BaseModel):
    """Request model for adding transactions to a unit."""

    transaction_ids: List[int] = Field(..., description="IDs of transactions to add")
    unit_id: Optional[int] = Field(None, description="Existing unit ID (optional)")
    unit_label: Optional[str] = Field(
        None, description="New unit label (creates new unit if unit_id not provided)"
    )


class BulkOperationResponse(BaseModel):
    """Response model for bulk operations."""

    success: bool
    affected_count: int
    message: str
    errors: List[str] = []


class TransactionCreate(BaseModel):
    """Request model for creating a manual transaction."""

    date_time: str = Field(..., description="Transaction datetime (ISO format)")
    direction: Direction = Field(
        ..., description="Transaction direction"
    )
    transaction_type: str = Field(
        ...,
        description="Transaction type (predefined or custom)",
    )
    quantity: float = Field(..., gt=0, description="Transaction quantity")

    # Required asset links
    asset_id: int = Field(..., description="Linked asset ID (required)")
    price_quote_asset_id: int = Field(
        ..., description="Linked price quote asset ID (required)"
    )
    fee_quote_asset_id: int = Field(
        ..., description="Linked fee quote asset ID (required)"
    )

    # Optional fields
    source: Optional[str] = Field(
        None, description="Source identifier (e.g., manual, binance-transactions)"
    )
    source_transaction_type: Optional[str] = Field(
        None, description="Source transaction type"
    )
    account_id: Optional[int] = Field(
        None, description="Account ID for trades (exchange where trade occurred)"
    )
    from_account_id: Optional[int] = Field(
        None, description="From account ID for transfers"
    )
    to_account_id: Optional[int] = Field(
        None, description="To account ID for transfers"
    )
    source_asset_symbol: Optional[str] = Field(None, description="Asset symbol")
    price: Optional[float] = Field(None, ge=0, description="Price per unit")
    source_price_quote_asset_symbol: Optional[str] = Field(
        None, description="Price quote asset symbol"
    )
    total: Optional[float] = Field(None, ge=0, description="Total value")
    fee: Optional[float] = Field(None, ge=0, description="Fee amount")
    source_fee_quote_asset_symbol: Optional[str] = Field(
        None, description="Fee quote asset symbol"
    )
    include_fee: bool = Field(False, description="Include fee in cost basis/proceeds")
    disposal_taxable: bool = Field(False, description="Is disposal taxable event")
    source_from_account: Optional[str] = Field(
        None, description="Source account/address"
    )
    source_to_account: Optional[str] = Field(
        None, description="Destination account/address"
    )
    network: Optional[str] = Field(None, description="Network name")
    network_transaction_id: Optional[str] = Field(None, description="Network TX ID")
    token_contract_address: Optional[str] = Field(None, description="Token contract")
    review_status: ReviewStatus = Field(
        ReviewStatus.PENDING,
        description="Review status",
    )
    review_notes: Optional[str] = Field(None, description="Notes")
    tags: Optional[List[Dict[str, str]]] = Field(
        None, description="Tags as list of {key: value} pairs"
    )


def _serialize_datetime(value):
    """Convert datetime to ISO string if needed."""
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def _build_transaction_response(
    tx: NormalizedTransaction, session: Session
) -> TransactionResponse:
    """
    Build a TransactionResponse from a NormalizedTransaction.

    Resolves asset IDs to symbols for the linked_*_symbol fields.
    Resolves account IDs to names for the account_name, from_account_name, to_account_name fields.
    """
    linked_asset_symbol = tx.asset.symbol if tx.asset else None
    linked_price_quote_symbol = tx.price_quote_asset.symbol if tx.price_quote_asset else None
    linked_fee_quote_symbol = tx.fee_quote_asset.symbol if tx.fee_quote_asset else None

    # Resolve account names server-side
    account_name = tx.account_rel.name if tx.account_rel else None
    from_account_name = tx.from_account.name if tx.from_account else None
    to_account_name = tx.to_account.name if tx.to_account else None

    tx_dict = tx.model_dump()
    tx_dict["linked_asset_symbol"] = linked_asset_symbol
    tx_dict["linked_price_quote_asset_symbol"] = linked_price_quote_symbol
    tx_dict["linked_fee_quote_asset_symbol"] = linked_fee_quote_symbol
    tx_dict["account_name"] = account_name
    tx_dict["from_account_name"] = from_account_name
    tx_dict["to_account_name"] = to_account_name
    tx_dict["synced_at"] = _serialize_datetime(tx_dict.get("synced_at"))

    return TransactionResponse(**tx_dict)


@router.get("", response_model=List[TransactionResponse])
def list_transactions(
    review_status: Optional[str] = Query(
        None, description="Filter by review status (valid/pending/invalid)"
    ),
    taxability: Optional[str] = Query(
        None, description="Filter by taxability status (taxable/non_taxable/unknown)"
    ),
    source: Optional[str] = Query(None, description="Filter by source exchange"),
    account_id: Optional[int] = Query(None, description="Filter by account ID"),
    unit_id: Optional[int] = Query(None, description="Filter by unit ID"),
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of results"),
    offset: int = Query(0, ge=0, description="Number of results to skip"),
    session: Session = Depends(get_db),
):
    """
    List all normalized transactions with optional filtering.

    - **review_status**: Filter by review status (valid, pending, invalid)
    - **taxability**: Filter by taxability_status (taxable, non_taxable, unknown)
    - **source**: Filter by source exchange (e.g., binance, coinbase)
    - **account_id**: Filter by account ID
    - **unit_id**: Filter to transactions in a specific unit
    - **limit**: Maximum number of results to return
    - **offset**: Number of results to skip for pagination
    """
    try:
        # Build query with filters
        statement = select(NormalizedTransaction).options(
            joinedload(NormalizedTransaction.asset),
            joinedload(NormalizedTransaction.price_quote_asset),
            joinedload(NormalizedTransaction.fee_quote_asset),
            joinedload(NormalizedTransaction.account_rel),
            joinedload(NormalizedTransaction.from_account),
            joinedload(NormalizedTransaction.to_account),
        )

        if review_status:
            statement = statement.where(NormalizedTransaction.review_status == review_status)

        if taxability:
            statement = statement.where(
                NormalizedTransaction.taxability_status == taxability
            )

        if source:
            statement = statement.where(NormalizedTransaction.source == source)

        if account_id is not None:
            statement = statement.where(NormalizedTransaction.account_id == account_id)

        if unit_id is not None:
            statement = statement.where(NormalizedTransaction.user_calculation_unit_id == unit_id)

        statement = (
            statement.order_by(NormalizedTransaction.date_time.desc())
            .offset(offset)
            .limit(limit)
        )

        transactions = session.exec(statement).all()

        # Build response with linked asset symbols
        return [_build_transaction_response(tx, session) for tx in transactions]

    except Exception as e:
        print(e)
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/inbox", response_model=Dict)
def get_inbox(
    limit: int = Query(200, ge=1, le=1000, description="Maximum number of results"),
    session: Session = Depends(get_db),
):
    """
    Get inbox view with pending transactions.
    
    Returns:
    - pending_transactions: List of pending transactions
    - needs_taxability_review_count: Count of transactions with unknown taxability
    - total_pending_count: Total pending transactions
    """
    try:
        # Get pending transactions (review_status=pending)
        statement = (
            select(NormalizedTransaction)
            .options(
                joinedload(NormalizedTransaction.asset),
                joinedload(NormalizedTransaction.price_quote_asset),
                joinedload(NormalizedTransaction.fee_quote_asset),
                joinedload(NormalizedTransaction.account_rel),
                joinedload(NormalizedTransaction.from_account),
                joinedload(NormalizedTransaction.to_account),
            )
            .where(NormalizedTransaction.review_status == ReviewStatus.PENDING.value)
            .order_by(NormalizedTransaction.date_time.desc())
            .limit(limit)
        )
        
        pending_txs = session.exec(statement).all()
        
        # Count transactions needing taxability review
        taxability_count = session.exec(
            select(NormalizedTransaction)
            .where(NormalizedTransaction.review_status == ReviewStatus.PENDING.value)
            .where(NormalizedTransaction.taxability_status == TaxabilityStatus.UNKNOWN.value)
        ).all()
        
        # Total pending count
        total_pending = session.exec(
            select(NormalizedTransaction)
            .where(NormalizedTransaction.review_status == ReviewStatus.PENDING.value)
        ).all()
        
        return {
            "pending_transactions": [_build_transaction_response(tx, session) for tx in pending_txs],
            "needs_taxability_review_count": len(taxability_count),
            "total_pending_count": len(total_pending),
        }
    
    except Exception as e:
        print(e)
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/reviewed", response_model=List[TransactionResponse])
def get_reviewed_transactions(
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of results"),
    offset: int = Query(0, ge=0, description="Number of results to skip"),
    session: Session = Depends(get_db),
):
    """
    Get reviewed transactions (review_status='valid').
    
    Returns transactions that have been reviewed and approved by the user.
    """
    try:
        statement = (
            select(NormalizedTransaction)
            .options(
                joinedload(NormalizedTransaction.asset),
                joinedload(NormalizedTransaction.price_quote_asset),
                joinedload(NormalizedTransaction.fee_quote_asset),
                joinedload(NormalizedTransaction.account_rel),
                joinedload(NormalizedTransaction.from_account),
                joinedload(NormalizedTransaction.to_account),
            )
            .where(NormalizedTransaction.review_status == ReviewStatus.VALID.value)
            .order_by(NormalizedTransaction.date_time.desc())
            .offset(offset)
            .limit(limit)
        )
        
        transactions = session.exec(statement).all()
        return [_build_transaction_response(tx, session) for tx in transactions]
    
    except Exception as e:
        print(e)
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/tags", response_model=List[Dict[str, str]])
def list_tags(
    session: Session = Depends(get_db),
):
    """
    List all unique tags used across transactions.

    Tags are stored as list of {key: value} dicts.
    Returns a deduplicated list of all unique tag key-value pairs.
    """
    try:
        # Get all transactions with tags
        statement = select(NormalizedTransaction.tags).where(
            NormalizedTransaction.tags != None
        )
        results = session.exec(statement).all()

        # Collect unique tags (using tuple for hashability)
        unique_tags_set = set()
        for tags in results:
            if tags and isinstance(tags, list):
                for tag in tags:
                    if isinstance(tag, dict):
                        # Convert dict to tuple of items for hashability
                        for k, v in tag.items():
                            unique_tags_set.add((k, str(v)))
            elif tags and isinstance(tags, dict):
                # Handle legacy dict format
                for k, v in tags.items():
                    unique_tags_set.add((k, str(v)))

        # Convert back to list of dicts
        return [{"key": k, "value": v} for k, v in sorted(unique_tags_set)]

    except Exception as e:
        print(e)
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


# ============================================================================
# V2 Workflow Endpoints (Inbox/Reviewed/Excluded)
# ============================================================================


@router.get("/inbox", response_model=List[TransactionResponse])
def get_inbox(
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_db),
):
    """
    Get pending transactions (Inbox view).

    Returns transactions with review_status='pending'.
    These are transactions that need user review.
    """
    statement = (
        select(NormalizedTransaction)
        .options(
            joinedload(NormalizedTransaction.asset),
            joinedload(NormalizedTransaction.price_quote_asset),
            joinedload(NormalizedTransaction.fee_quote_asset),
            joinedload(NormalizedTransaction.account_rel),
            joinedload(NormalizedTransaction.from_account),
            joinedload(NormalizedTransaction.to_account),
        )
        .where(NormalizedTransaction.review_status == ReviewStatus.PENDING.value)
        .order_by(NormalizedTransaction.date_time.desc())
        .offset(offset)
        .limit(limit)
    )

    transactions = session.exec(statement).all()
    return [_build_transaction_response(tx, session) for tx in transactions]


@router.get("/reviewed", response_model=List[TransactionResponse])
def get_reviewed(
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_db),
):
    """
    Get reviewed standalone transactions.

    Returns transactions with review_status='valid'.
    """
    statement = (
        select(NormalizedTransaction)
        .options(
            joinedload(NormalizedTransaction.asset),
            joinedload(NormalizedTransaction.price_quote_asset),
            joinedload(NormalizedTransaction.fee_quote_asset),
            joinedload(NormalizedTransaction.account_rel),
            joinedload(NormalizedTransaction.from_account),
            joinedload(NormalizedTransaction.to_account),
        )
        .where(NormalizedTransaction.review_status == ReviewStatus.VALID.value)
        .order_by(NormalizedTransaction.date_time.desc())
        .offset(offset)
        .limit(limit)
    )

    transactions = session.exec(statement).all()
    return [_build_transaction_response(tx, session) for tx in transactions]


@router.post("/bulk-status", response_model=BulkOperationResponse)
def bulk_update_status(
    request: BulkStatusUpdate,
    session: Session = Depends(get_db),
):
    """
    Bulk update transaction status and taxability.

    Use this to mark multiple transactions as reviewed/excluded.
    """
    updated = 0
    errors = []

    for tx_id in request.transaction_ids:
        tx = session.get(NormalizedTransaction, tx_id)
        if not tx:
            errors.append(f"Transaction {tx_id} not found")
            continue

        tx.status = request.status
        if request.taxability_status:
            tx.taxability_status = request.taxability_status

        session.add(tx)
        updated += 1

    session.commit()

    return BulkOperationResponse(
        success=len(errors) == 0,
        affected_count=updated,
        message=f"Updated {updated} transactions",
        errors=errors,
    )


@router.get("/{transaction_id}", response_model=TransactionResponse)
def get_transaction(
    transaction_id: int,
    session: Session = Depends(get_db),
):
    """
    Get a specific transaction by ID.

    - **transaction_id**: The ID of the transaction to retrieve
    """
    try:
        statement = (
            select(NormalizedTransaction)
            .options(
                joinedload(NormalizedTransaction.asset),
                joinedload(NormalizedTransaction.price_quote_asset),
                joinedload(NormalizedTransaction.fee_quote_asset),
                joinedload(NormalizedTransaction.account_rel),
                joinedload(NormalizedTransaction.from_account),
                joinedload(NormalizedTransaction.to_account),
            )
            .where(NormalizedTransaction.id == transaction_id)
        )
        tx = session.exec(statement).first()

        if not tx:
            raise HTTPException(status_code=404, detail="Transaction not found")

        return _build_transaction_response(tx, session)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.patch("/{transaction_id}", response_model=TransactionResponse)
def update_transaction(
    transaction_id: int,
    update: TransactionUpdate = Body(...),
    session: Session = Depends(get_db),
):
    """
    Update review fields of a transaction.

    - **transaction_id**: The ID of the transaction to update
    - **update**: Fields to update (only provided fields will be changed)
    """
    try:
        statement = (
            select(NormalizedTransaction)
            .options(
                joinedload(NormalizedTransaction.asset),
                joinedload(NormalizedTransaction.price_quote_asset),
                joinedload(NormalizedTransaction.fee_quote_asset),
                joinedload(NormalizedTransaction.account_rel),
                joinedload(NormalizedTransaction.from_account),
                joinedload(NormalizedTransaction.to_account),
            )
            .where(NormalizedTransaction.id == transaction_id)
        )
        tx = session.exec(statement).first()

        if not tx:
            raise HTTPException(status_code=404, detail="Transaction not found")

        # Update only provided fields
        update_data = update.model_dump(exclude_unset=True)
        print(f"DEBUG: Updating transaction {transaction_id} with data: {update_data}")
        
        for key, value in update_data.items():
            setattr(tx, key, value)

        session.add(tx)
        session.commit()
        session.refresh(tx)

        return _build_transaction_response(tx, session)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


class CreateTransactionResponse(BaseModel):
    """Response model for transaction creation (may return multiple if split)."""

    transactions: List[TransactionResponse]
    split: bool = False
    message: str


@router.post("", response_model=CreateTransactionResponse)
def create_transaction(
    transaction: TransactionCreate = Body(...),
    session: Session = Depends(get_db),
):
    """
    Create a new manual transaction.

    If the transaction is a buy/sell, it will be split into atomic legs
    (outflow for what you give, inflow for what you receive).
    Both legs will be linked via a group.

    - **transaction**: Transaction data to create

    Returns:
        CreateTransactionResponse with list of created transactions
    """
    try:
        # Parse datetime from ISO string
        try:
            dt = datetime.fromisoformat(transaction.date_time.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(
                status_code=400, detail="Invalid datetime format. Use ISO format."
            )

        # Generate unique source_transaction_id for manual transactions
        source_tx_id = f"manual_{uuid.uuid4().hex[:12]}"

        # Create NormalizedTransaction model for pipeline processing
        # SQLModel is also Pydantic, so it works as a DTO
        pydantic_tx = NormalizedTransaction(
            source=transaction.source or "manual",
            source_transaction_id=source_tx_id,
            source_transaction_type=transaction.source_transaction_type
            or "manual_entry",
            source_asset_symbol=transaction.source_asset_symbol,
            source_price_quote_asset_symbol=transaction.source_price_quote_asset_symbol,
            source_fee_quote_asset_symbol=transaction.source_fee_quote_asset_symbol,
            account_id=transaction.account_id,
            asset_id=transaction.asset_id,
            price_quote_asset_id=transaction.price_quote_asset_id,
            fee_quote_asset_id=transaction.fee_quote_asset_id,
            date_time=dt,
            direction=transaction.direction,
            transaction_type=transaction.transaction_type,
            quantity=transaction.quantity,
            price=transaction.price,
            total=transaction.total,
            fee=transaction.fee,
            include_fee=transaction.include_fee,
            disposal_taxable=transaction.disposal_taxable,
            source_from_account=transaction.source_from_account,
            source_to_account=transaction.source_to_account,
            from_account_id=transaction.from_account_id,
            to_account_id=transaction.to_account_id,
            network_transaction_id=transaction.network_transaction_id,
            token_contract_address=transaction.token_contract_address,
            review_status=transaction.review_status,
            review_notes=transaction.review_notes,
            tags=transaction.tags or [],
        )

        # Use the default pipeline (split, transfer detection, asset enrichment, persistence)
        pipeline = create_default_pipeline(session)
        context = PipelineContext(session=session, source=pydantic_tx.source)

        # Process through pipeline - this handles everything including persistence
        result = pipeline.process(pydantic_tx, context)

        if not result.success:
            raise HTTPException(
                status_code=500, detail=f"Pipeline error: {'; '.join(result.errors)}"
            )

        # Query persisted transactions to build response
        created_transactions = []
        for pydantic_tx in result.pydantic_transactions:
            statement = (
                select(NormalizedTransaction)
                .options(
                    joinedload(NormalizedTransaction.asset),
                    joinedload(NormalizedTransaction.price_quote_asset),
                    joinedload(NormalizedTransaction.fee_quote_asset),
                    joinedload(NormalizedTransaction.account_rel),
                    joinedload(NormalizedTransaction.from_account),
                    joinedload(NormalizedTransaction.to_account),
                )
                .where(
                    NormalizedTransaction.source == pydantic_tx.source,
                    NormalizedTransaction.source_transaction_id == pydantic_tx.source_transaction_id,
                )
            )
            db_tx = session.exec(statement).first()
            if db_tx:
                created_transactions.append(db_tx)

        # Build response using helper
        response_transactions = [
            _build_transaction_response(tx, session) for tx in created_transactions
        ]

        # Build message
        was_split = len(created_transactions) > 1

        if was_split:
            message = f"Transaction split into {len(created_transactions)} legs"
        else:
            message = "Transaction created successfully"

        return CreateTransactionResponse(
            transactions=response_transactions,
            split=was_split,
            message=message,
        )

    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


# ============================================================================
# Bulk Operations
# ============================================================================


@router.post("/bulk/update", response_model=BulkOperationResponse)
def bulk_update_transactions(
    request: BulkUpdateRequest = Body(...),
    session: Session = Depends(get_db),
):
    """
    Bulk update multiple transactions at once.

    - **transaction_ids**: List of transaction IDs to update
    - **review_status**: New review status to set (optional)
    - **transaction_type**: New transaction type to set (optional)
    """
    if not request.transaction_ids:
        raise HTTPException(status_code=400, detail="No transaction IDs provided")

    if not request.review_status and not request.transaction_type:
        raise HTTPException(
            status_code=400,
            detail="At least one field to update must be provided",
        )

    try:
        updated_count = 0
        errors = []

        for tx_id in request.transaction_ids:
            tx = session.get(NormalizedTransaction, tx_id)
            if not tx:
                errors.append(f"Transaction {tx_id} not found")
                continue

            if request.review_status:
                tx.review_status = request.review_status
            if request.transaction_type:
                tx.transaction_type = request.transaction_type

            session.add(tx)
            updated_count += 1

        session.commit()

        return BulkOperationResponse(
            success=True,
            affected_count=updated_count,
            message=f"Updated {updated_count} transaction(s)",
            errors=errors,
        )

    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.post("/bulk/delete", response_model=BulkOperationResponse)
def bulk_delete_transactions(
    request: BulkDeleteRequest = Body(...),
    session: Session = Depends(get_db),
):
    """
    Bulk delete multiple transactions at once.

    - **transaction_ids**: List of transaction IDs to delete
    """
    if not request.transaction_ids:
        raise HTTPException(status_code=400, detail="No transaction IDs provided")

    try:
        deleted_count = 0
        errors = []

        for tx_id in request.transaction_ids:
            tx = session.get(NormalizedTransaction, tx_id)
            if not tx:
                errors.append(f"Transaction {tx_id} not found")
                continue

            session.delete(tx)
            deleted_count += 1

        session.commit()

        return BulkOperationResponse(
            success=True,
            affected_count=deleted_count,
            message=f"Deleted {deleted_count} transaction(s)",
            errors=errors,
        )

    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.post("/bulk/add-to-unit", response_model=BulkOperationResponse)
def bulk_add_to_unit(
    request: BulkAddToUnitRequest = Body(...),
    session: Session = Depends(get_db),
):
    """
    Add multiple transactions to a unit.

    Either provide an existing unit_id, or a unit_label to create a new unit.

    - **transaction_ids**: List of transaction IDs to add to unit
    - **unit_id**: Existing unit ID (optional)
    - **unit_label**: New unit label - creates new unit (optional)
    """
    if not request.transaction_ids:
        raise HTTPException(status_code=400, detail="No transaction IDs provided")

    if not request.unit_id and not request.unit_label:
        raise HTTPException(
            status_code=400,
            detail="Either unit_id or unit_label must be provided",
        )

    try:
        # Get or create unit
        if request.unit_id:
            unit = session.get(CalculationUnit, request.unit_id)
            if not unit:
                raise HTTPException(
                    status_code=404, detail=f"Unit {request.unit_id} not found"
                )
        else:
            # Create new unit
            unit = CalculationUnit(label=request.unit_label or "Bulk Unit")
            session.add(unit)
            session.flush()  # Get ID

        updated_count = 0
        errors = []

        for tx_id in request.transaction_ids:
            tx = session.get(NormalizedTransaction, tx_id)
            if not tx:
                errors.append(f"Transaction {tx_id} not found")
                continue

            tx.user_calculation_unit_id = unit.id
            session.add(tx)
            updated_count += 1

        session.commit()

        return BulkOperationResponse(
            success=True,
            affected_count=updated_count,
            message=f"Added {updated_count} transaction(s) to unit {unit.id}",
            errors=errors,
        )

    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
