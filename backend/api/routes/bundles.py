
"""Bundle endpoints for the Trade Exporter API.

Bundles are user-created groupings of multiple transactions for P&L purposes.
Stored in the 'bundles' table (UserCalculationBundle model).
"""

from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Query, Depends
from typing import List, Optional
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from backend.db.database import get_db
from backend.db.models import (
    NormalizedTransaction,
    UserCalculationBundle,
    Asset,
    UnitPattern,
    TaxabilityStatus,
    Direction,
    ReviewStatus,
)
from backend.services.suggestion_service import SuggestionService, GroupingSuggestion

router = APIRouter(prefix="/bundles", tags=["Bundles"])


# ============================================================================
# Request/Response Models
# ============================================================================


class UnitCreate(BaseModel):
    """Request model for creating a calculation unit."""

    transaction_ids: List[int] = Field(..., description="Transaction IDs to include")
    label: Optional[str] = Field(None, description="Unit label")
    pattern: Optional[UnitPattern] = Field(None, description="Pattern type")
    notes: Optional[str] = Field(None, description="Notes")
    taxability_override: Optional[TaxabilityStatus] = Field(
        None,
        description="Override taxability for all transactions (taxable or non_taxable)",
    )


class UnitUpdate(BaseModel):
    """Request model for updating a calculation unit."""

    label: Optional[str] = Field(None, description="Unit label")
    pattern: Optional[UnitPattern] = Field(None, description="Pattern type")
    notes: Optional[str] = Field(None, description="Notes")
    taxability_override: Optional[TaxabilityStatus] = Field(
        None, description="Override taxability (null to remove override)"
    )


class TransactionSummary(BaseModel):
    """Summary of a transaction in a unit."""

    id: int
    date_time: Optional[str] = None
    direction: Optional[Direction] = None
    transaction_type: Optional[str] = None
    asset_symbol: Optional[str] = None
    symbol: Optional[str] = None  # Alias for frontend compatibility
    quantity: Optional[float] = None
    source: Optional[str] = None
    source_transaction_id: Optional[str] = None
    network: Optional[str] = None


class UnitResponse(BaseModel):
    """Response model for a calculation unit."""

    id: int
    label: Optional[str]
    pattern: Optional[UnitPattern]
    notes: Optional[str]
    taxability_override: Optional[TaxabilityStatus]
    created_at: str
    transaction_count: int
    transactions: List[TransactionSummary]

    # Computed fields
    total_inflow: Optional[dict] = None  # {asset: quantity}
    total_outflow: Optional[dict] = None  # {asset: quantity}


class SuggestionResponse(BaseModel):
    """Response model for a unit suggestion."""

    pattern: UnitPattern
    transaction_ids: List[int]
    confidence: float
    label: str
    reason: str
    taxability_suggestion: TaxabilityStatus
    total_quantity: Optional[float] = None
    asset_symbol: Optional[str] = None
    date_range: Optional[str] = None
    transactions: List[TransactionSummary] = []


class AcceptSuggestionRequest(BaseModel):
    """Request to accept a suggestion."""

    pattern: UnitPattern
    transaction_ids: List[int]
    label: Optional[str] = None
    notes: Optional[str] = None


# ============================================================================
# Endpoints
# ============================================================================


@router.get("", response_model=List[UnitResponse])
def list_bundles(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    pattern: Optional[str] = Query(None, description="Filter by pattern"),
    min_transaction_count: int = Query(1, ge=0, description="Minimum transaction count"),
    session: Session = Depends(get_db),
):
    """
    List all bundles with their transactions.
    
    By default, only shows bundles with at least 1 transaction.
    Set min_transaction_count=0 to include empty bundles.
    """
    query = select(UserCalculationBundle).order_by(UserCalculationBundle.created_at.desc())

    if pattern:
        query = query.where(UserCalculationBundle.pattern == pattern)

    query = query.offset(offset).limit(limit)
    units = session.exec(query).all()

    # Build responses and filter by transaction count
    responses = []
    for unit in units:
        response = _build_unit_response(unit, session)
        if response.transaction_count >= min_transaction_count:
            responses.append(response)

    return responses


@router.get("/suggestions", response_model=List[SuggestionResponse])
def get_suggestions(
    max_suggestions: int = Query(20, ge=1, le=100),
    session: Session = Depends(get_db),
):
    """
    Get grouping suggestions for pending transactions.

    Suggestions are computed on-demand and not persisted.
    Use POST /units or POST /units/accept-suggestion to create units.
    """
    service = SuggestionService(session)
    suggestions = service.get_suggestions(max_suggestions=max_suggestions)

    return [
        SuggestionResponse(
            pattern=s.pattern,
            transaction_ids=s.transaction_ids,
            confidence=s.confidence,
            label=s.label,
            reason=s.reason,
            taxability_suggestion=_pattern_to_taxability(s.pattern),
            transactions=[
                TransactionSummary(
                    id=t.get("id", 0),
                    date_time=t.get("date_time", ""),
                    source=t.get("source", ""),
                    source_transaction_id=t.get("source_transaction_id", ""),
                    direction=t.get("direction", ""),
                    quantity=t.get("quantity", 0),
                    symbol=t.get("symbol", ""),
                )
                for t in (s.transactions or [])
            ],
        )
        for s in suggestions
    ]


def _pattern_to_taxability(pattern: str) -> TaxabilityStatus:
    """Convert pattern to default taxability."""
    if pattern == UnitPattern.TRANSFER.value or pattern == "transfer":
        return TaxabilityStatus.NON_TAXABLE
    elif pattern == UnitPattern.SPLIT.value or pattern == "split":
        return TaxabilityStatus.NON_TAXABLE
    elif pattern == UnitPattern.SWAP.value or pattern == "swap":
        return TaxabilityStatus.TAXABLE
    return TaxabilityStatus.UNKNOWN


@router.post("/accept-suggestion", response_model=UnitResponse)
def accept_suggestion(
    request: AcceptSuggestionRequest,
    session: Session = Depends(get_db),
):
    """
    Accept a grouping suggestion and create the calculation unit.

    This persists the suggestion as a real unit.
    """
    # Reconstruct the suggestion
    suggestion = GroupingSuggestion(
        pattern=request.pattern,
        label=request.label or f"{request.pattern.title()} Unit",
        reason="User accepted suggestion",
        confidence=1.0,
        transaction_ids=request.transaction_ids,
    )

    service = SuggestionService(session)
    unit = service.accept_suggestion(
        suggestion,
        label=request.label,
        notes=request.notes,
    )

    return _build_unit_response(unit, session)


@router.post("", response_model=UnitResponse)
def create_bundle(
    request: UnitCreate,
    session: Session = Depends(get_db),
):
    """Create a new bundle from selected transactions."""
    # Validate transactions exist and are not already in a bundle
    transactions = []
    for tx_id in request.transaction_ids:
        tx = session.get(NormalizedTransaction, tx_id)
        if not tx:
            raise HTTPException(
                status_code=404, detail=f"Transaction {tx_id} not found"
            )
        if tx.user_calculation_unit_id:
            raise HTTPException(
                status_code=400,
                detail=f"Transaction {tx_id} is already in bundle {tx.user_calculation_unit_id}",
            )
        transactions.append(tx)

    # Create bundle (UserCalculationBundle -> 'bundles' table)
    bundle = UserCalculationBundle(
        label=request.label,
        pattern=request.pattern,
        notes=request.notes,
        taxability_override=request.taxability_override,
    )
    session.add(bundle)
    session.flush()

    # Link transactions via user_calculation_unit_id FK
    for tx in transactions:
        tx.user_calculation_unit_id = bundle.id
        tx.review_status = ReviewStatus.VALID.value
        session.add(tx)

    session.commit()
    session.refresh(bundle)

    return _build_unit_response(bundle, session)


@router.get("/{bundle_id}", response_model=UnitResponse)
def get_bundle(
    bundle_id: int,
    session: Session = Depends(get_db),
):
    """Get a bundle by ID with its transactions."""
    bundle = session.get(UserCalculationBundle, bundle_id)
    if not bundle:
        raise HTTPException(status_code=404, detail="Bundle not found")

    return _build_unit_response(bundle, session)


@router.patch("/{bundle_id}", response_model=UnitResponse)
def update_bundle(
    bundle_id: int,
    request: UnitUpdate,
    session: Session = Depends(get_db),
):
    """Update a bundle's metadata."""
    bundle = session.get(UserCalculationBundle, bundle_id)
    if not bundle:
        raise HTTPException(status_code=404, detail="Bundle not found")

    if request.label is not None:
        bundle.label = request.label
    if request.pattern is not None:
        bundle.pattern = request.pattern
    if request.notes is not None:
        bundle.notes = request.notes
    if request.taxability_override is not None:
        bundle.taxability_override = (
            request.taxability_override if request.taxability_override else None
        )

    bundle.updated_at = datetime.now(timezone.utc)
    session.add(bundle)
    session.commit()
    session.refresh(bundle)

    return _build_unit_response(bundle, session)


@router.delete("/{bundle_id}")
def delete_bundle(
    bundle_id: int,
    unlink_transactions: bool = Query(
        True, description="Set transactions back to pending"
    ),
    session: Session = Depends(get_db),
):
    """
    Delete a bundle.

    By default, transactions are unlinked and set back to pending status.
    """
    bundle = session.get(UserCalculationBundle, bundle_id)
    if not bundle:
        raise HTTPException(status_code=404, detail="Bundle not found")

    # Unlink transactions
    if unlink_transactions:
        transactions = session.exec(
            select(NormalizedTransaction).where(
                NormalizedTransaction.user_calculation_unit_id == bundle_id
            )
        ).all()

        for tx in transactions:
            tx.user_calculation_unit_id = None
            tx.review_status = ReviewStatus.PENDING.value
            session.add(tx)

    session.delete(bundle)
    session.commit()

    return {"success": True, "message": f"Bundle {bundle_id} deleted"}


@router.post("/{bundle_id}/add-transactions")
def add_transactions_to_bundle(
    bundle_id: int,
    transaction_ids: List[int],
    session: Session = Depends(get_db),
):
    """Add transactions to an existing bundle."""
    bundle = session.get(UserCalculationBundle, bundle_id)
    if not bundle:
        raise HTTPException(status_code=404, detail="Bundle not found")

    added = 0
    for tx_id in transaction_ids:
        tx = session.get(NormalizedTransaction, tx_id)
        if not tx:
            continue
        if tx.user_calculation_unit_id:
            continue  # Already in a bundle

        tx.user_calculation_unit_id = bundle_id
        tx.review_status = ReviewStatus.VALID.value
        session.add(tx)
        added += 1

    session.commit()

    return {"success": True, "added_count": added}


@router.post("/{bundle_id}/remove-transactions")
def remove_transactions_from_bundle(
    bundle_id: int,
    transaction_ids: List[int],
    session: Session = Depends(get_db),
):
    """Remove transactions from a bundle."""
    bundle = session.get(UserCalculationBundle, bundle_id)
    if not bundle:
        raise HTTPException(status_code=404, detail="Bundle not found")

    removed = 0
    for tx_id in transaction_ids:
        tx = session.get(NormalizedTransaction, tx_id)
        if not tx:
            continue
        if tx.user_calculation_unit_id != bundle_id:
            continue

        tx.user_calculation_unit_id = None
        tx.review_status = ReviewStatus.PENDING.value
        session.add(tx)
        removed += 1

    session.commit()

    return {"success": True, "removed_count": removed}


# ============================================================================
# Helper Functions
# ============================================================================


def _build_unit_response(bundle: UserCalculationBundle, session: Session) -> UnitResponse:
    """Build a UnitResponse with transaction summaries."""
    # Get transactions in bundle
    transactions = session.exec(
        select(NormalizedTransaction)
        .where(NormalizedTransaction.user_calculation_unit_id == bundle.id)
        .order_by(NormalizedTransaction.date_time)
    ).all()

    # Build summaries
    tx_summaries = []
    inflows: dict = {}
    outflows: dict = {}

    for tx in transactions:
        # Get asset symbol
        asset_symbol = tx.source_asset_symbol
        if not asset_symbol and tx.asset_id:
            asset = session.get(Asset, tx.asset_id)
            asset_symbol = asset.symbol if asset else None

        tx_summaries.append(
            TransactionSummary(
                id=tx.id,
                date_time=tx.date_time.isoformat() if tx.date_time else None,
                direction=tx.direction,
                transaction_type=tx.transaction_type,
                asset_symbol=asset_symbol,
                symbol=asset_symbol,  # Alias for frontend
                quantity=float(tx.quantity) if tx.quantity else 0,
                source=tx.source,
                source_transaction_id=tx.source_transaction_id,
                network=tx.network,
            )
        )

        # Aggregate flows
        if asset_symbol:
            if tx.direction == Direction.INFLOW.value:
                inflows[asset_symbol] = inflows.get(asset_symbol, 0) + float(
                    tx.quantity
                )
            elif tx.direction == Direction.OUTFLOW.value:
                outflows[asset_symbol] = outflows.get(asset_symbol, 0) + float(
                    tx.quantity
                )

    return UnitResponse(
        id=bundle.id,
        label=bundle.label,
        pattern=bundle.pattern,
        notes=bundle.notes,
        taxability_override=bundle.taxability_override,
        created_at=bundle.created_at.isoformat() if bundle.created_at else "",
        transaction_count=len(tx_summaries),
        transactions=tx_summaries,
        total_inflow=inflows if inflows else None,
        total_outflow=outflows if outflows else None,
    )
