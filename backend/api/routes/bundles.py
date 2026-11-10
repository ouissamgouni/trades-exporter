"""Bundle endpoints for the TradeTrail API.

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
    DismissedSuggestion,
    Asset,
    Account,
    UnitPattern,
    TaxabilityStatus,
    Direction,
    ReviewStatus,
)
from backend.api.routes.pnl import TransactionSummary, AssetRef  # Import shared models
from backend.services.suggestion_service import SuggestionService, GroupingSuggestion
from backend.services.suggestion_fingerprint import compute_suggestion_fingerprint
from backend.services.pnl.taxability import suggest_bundle_taxability
from backend.services.pnl.config import PnLConfig

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
    metadata: Optional[dict] = Field(
        None,
        description="Pattern-specific data (e.g. spinoff: {spinoff_source_asset_id, spinoff_allocation_pct})",
    )


class UnitUpdate(BaseModel):
    """Request model for updating a calculation unit."""

    label: Optional[str] = Field(None, description="Unit label")
    pattern: Optional[UnitPattern] = Field(None, description="Pattern type")
    notes: Optional[str] = Field(None, description="Notes")
    taxability_override: Optional[TaxabilityStatus] = Field(
        None, description="Override taxability (null to remove override)"
    )
    metadata: Optional[dict] = Field(
        None,
        description="Pattern-specific data (e.g. spinoff: {spinoff_source_asset_id, spinoff_allocation_pct})",
    )


# TransactionSummary imported from backend.api.routes.pnl to avoid duplication


class UnitResponse(BaseModel):
    """Response model for a calculation unit."""

    id: int
    label: Optional[str]
    pattern: Optional[UnitPattern]
    notes: Optional[str]
    taxability_override: Optional[TaxabilityStatus]
    metadata: Optional[dict] = None
    created_at: str
    transaction_count: int
    transactions: List[TransactionSummary]

    # Computed fields
    total_inflow: Optional[dict] = None  # {asset: quantity}
    total_outflow: Optional[dict] = None  # {asset: quantity}


class SuggestionResponse(BaseModel):
    """Response model for a unit suggestion."""

    fingerprint: str
    pattern: UnitPattern
    transaction_ids: List[int]
    confidence: float
    label: str
    reason: str
    taxability_suggestion: TaxabilityStatus
    taxability_suggestion_reason: str = Field(
        default="",
        description="Explanation of taxability suggestion. This is a hint based on pattern; "
        "actual per-leg taxability is computed during P&L calculation if not overridden.",
    )
    total_quantity: Optional[float] = None
    asset_symbol: Optional[str] = None
    date_range: Optional[str] = None
    transactions: List[TransactionSummary] = []
    existing_bundle_id: Optional[int] = Field(
        default=None,
        description="Broken bundle this suggestion completes (accepting adds the missing legs to it)",
    )


class TransactionIdsRequest(BaseModel):
    """Request model for adding/removing transactions from a bundle."""

    transaction_ids: List[int] = Field(..., description="Transaction IDs to add/remove")


class AcceptSuggestionRequest(BaseModel):
    """Request to accept a suggestion."""

    pattern: UnitPattern
    transaction_ids: List[int]
    label: Optional[str] = None
    notes: Optional[str] = None
    taxability_override: Optional[TaxabilityStatus] = Field(
        None, description="Override taxability for the bundle"
    )


class DismissSuggestionRequest(BaseModel):
    """Request to dismiss a suggestion."""

    pattern: str
    transaction_ids: List[int]
    label: Optional[str] = None
    reason: Optional[str] = None


class CompletionCandidateResponse(BaseModel):
    transaction_id: int
    date_time: Optional[str]
    account_id: Optional[int]
    account_name: Optional[str]
    asset_symbol: str
    quantity: float
    confidence: float
    reason: str


class BrokenBundleResponse(BaseModel):
    bundle_id: int
    label: Optional[str]
    pattern: Optional[str]
    created_at: Optional[str]
    issue: str = Field(..., description="empty | missing_inflow | missing_outflow")
    transaction_ids: List[int]
    candidates: List[CompletionCandidateResponse] = []


class DismissedSuggestionResponse(BaseModel):
    """Response model for a dismissed suggestion."""

    id: int
    fingerprint: str
    pattern: Optional[str]
    transaction_ids: List[int]
    label: Optional[str]
    reason: Optional[str]
    dismissed_at: str


# ============================================================================
# Endpoints
# ============================================================================


@router.get("", response_model=List[UnitResponse])
def list_bundles(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    pattern: Optional[str] = Query(None, description="Filter by pattern"),
    min_transaction_count: int = Query(
        1, ge=0, description="Minimum transaction count"
    ),
    session: Session = Depends(get_db),
):
    """
    List all bundles with their transactions.

    By default, only shows bundles with at least 1 transaction.
    Set min_transaction_count=0 to include empty bundles.
    """
    query = select(UserCalculationBundle).order_by(
        UserCalculationBundle.created_at.desc()
    )

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
    max_suggestions: int = Query(200, ge=1, le=500),
    include_bundled: bool = Query(
        False, description="Include transactions that already belong to a bundle"
    ),
    session: Session = Depends(get_db),
):
    """
    Get grouping suggestions for pending transactions.

    Suggestions are computed on-demand and not persisted.
    Use POST /units or POST /units/accept-suggestion to create units.
    """
    service = SuggestionService(session)
    suggestions = service.get_suggestions(
        max_suggestions=max_suggestions,
        include_bundled=include_bundled,
    )

    # Load config for taxability suggestion (uses same logic as P&L engine)
    config = PnLConfig()

    responses = []
    for s in suggestions:
        # Use shared taxability logic from P&L module
        taxability_hint = suggest_bundle_taxability(
            pattern=s.pattern,
            crypto_swap_taxable=config.crypto_swap_taxable_by_default,
        )

        # Build enriched transaction summaries with account names
        tx_summaries = []
        for t in s.transactions or []:
            account_name = None
            if t.get("account_id"):
                account = session.get(Account, t.get("account_id"))
                account_name = account.name if account else None

            from_account_name = None
            if t.get("from_account_id"):
                from_account = session.get(Account, t.get("from_account_id"))
                from_account_name = from_account.name if from_account else None

            to_account_name = None
            if t.get("to_account_id"):
                to_account = session.get(Account, t.get("to_account_id"))
                to_account_name = to_account.name if to_account else None

            # Build AssetRef with source_symbol for display
            source_asset_symbol = t.get("asset_symbol") or t.get("symbol", "")
            asset_ref = AssetRef(
                id=None,
                symbol=None,
                label=None,
                source_symbol=source_asset_symbol if source_asset_symbol else None,
            )

            tx_summaries.append(
                TransactionSummary(
                    id=t.get("id", 0),
                    date_time=t.get("date_time", ""),
                    source=t.get("source", ""),
                    source_transaction_id=t.get("source_transaction_id", ""),
                    direction=t.get("direction", ""),
                    quantity=t.get("quantity", 0),
                    asset=asset_ref,
                    # Extended fields
                    account_id=t.get("account_id"),
                    account_name=account_name,
                    price=t.get("price"),
                    total=t.get("total"),
                    fee=t.get("fee"),
                    from_account_name=from_account_name,
                    to_account_name=to_account_name,
                    source_from_account=t.get("source_from_account"),
                    source_to_account=t.get("source_to_account"),
                    source_transaction_type=t.get("source_transaction_type"),
                    network=t.get("network"),
                    network_transaction_id=t.get("network_transaction_id"),
                )
            )

        responses.append(
            SuggestionResponse(
                fingerprint=compute_suggestion_fingerprint(
                    s.pattern, s.transaction_ids
                ),
                pattern=s.pattern,
                transaction_ids=s.transaction_ids,
                confidence=s.confidence,
                label=s.label,
                reason=s.reason,
                taxability_suggestion=taxability_hint.taxability,
                taxability_suggestion_reason=taxability_hint.reason,
                transactions=tx_summaries,
                existing_bundle_id=s.existing_bundle_id,
            )
        )

    return responses


@router.post("/suggestions/dismiss", response_model=DismissedSuggestionResponse)
def dismiss_suggestion(
    request: DismissSuggestionRequest,
    session: Session = Depends(get_db),
):
    """
    Dismiss a suggestion so it won't appear in future results.

    The suggestion is identified by (pattern, transaction_ids). Only the exact
    combination is blocked — individual transactions can still appear in other suggestions.
    """
    service = SuggestionService(session)
    try:
        dismissed = service.dismiss_suggestion(
            pattern=request.pattern,
            transaction_ids=request.transaction_ids,
            label=request.label,
            reason=request.reason,
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))

    return DismissedSuggestionResponse(
        id=dismissed.id,
        fingerprint=dismissed.fingerprint,
        pattern=dismissed.pattern,
        transaction_ids=dismissed.transaction_ids,
        label=dismissed.label,
        reason=dismissed.reason,
        dismissed_at=dismissed.dismissed_at.isoformat(),
    )


@router.delete("/suggestions/dismiss/{fingerprint}")
def undismiss_suggestion(
    fingerprint: str,
    session: Session = Depends(get_db),
):
    """
    Restore a dismissed suggestion so it appears again.
    """
    service = SuggestionService(session)
    restored = service.undismiss_suggestion(fingerprint)
    if not restored:
        raise HTTPException(status_code=404, detail="Dismissed suggestion not found")
    return {"success": True, "message": f"Suggestion {fingerprint} restored"}


@router.get("/suggestions/dismissed", response_model=List[DismissedSuggestionResponse])
def list_dismissed_suggestions(
    session: Session = Depends(get_db),
):
    """
    List all dismissed suggestions.
    """
    service = SuggestionService(session)
    dismissed_list = service.list_dismissed()
    return [
        DismissedSuggestionResponse(
            id=d.id,
            fingerprint=d.fingerprint,
            pattern=d.pattern,
            transaction_ids=d.transaction_ids or [],
            label=d.label,
            reason=d.reason,
            dismissed_at=d.dismissed_at.isoformat() if d.dismissed_at else "",
        )
        for d in dismissed_list
    ]


@router.get("/broken", response_model=List[BrokenBundleResponse])
def list_broken_bundles(session: Session = Depends(get_db)):
    """Confirmed bundles that are empty or lost one side, with standalone transactions that could complete them."""
    from backend.services.bundle_health import BundleHealthService

    account_names = {a.id: a.name for a in session.exec(select(Account)).all()}
    return [
        BrokenBundleResponse(
            bundle_id=b.bundle_id,
            label=b.label,
            pattern=b.pattern,
            created_at=b.created_at.isoformat() if b.created_at else None,
            issue=b.issue,
            transaction_ids=b.transaction_ids,
            candidates=[
                CompletionCandidateResponse(
                    transaction_id=c.transaction_id,
                    date_time=c.date_time.isoformat() if c.date_time else None,
                    account_id=c.account_id,
                    account_name=account_names.get(c.account_id),
                    asset_symbol=c.asset_symbol,
                    quantity=c.quantity,
                    confidence=c.confidence,
                    reason=c.reason,
                )
                for c in b.candidates
            ],
        )
        for b in BundleHealthService(session).find_broken()
    ]


@router.post("/accept-suggestion", response_model=UnitResponse)
def accept_suggestion(
    request: AcceptSuggestionRequest,
    session: Session = Depends(get_db),
):
    """
    Accept a grouping suggestion and create the calculation unit.

    This persists the suggestion as a real unit.
    """
    service = SuggestionService(session)
    completes = service.completable_bundle_id(request.transaction_ids) is not None

    # Validate transactions are not already in a bundle
    conflicts = []
    for tx_id in request.transaction_ids:
        tx = session.get(NormalizedTransaction, tx_id)
        if not tx:
            raise HTTPException(
                status_code=404, detail=f"Transaction {tx_id} not found"
            )
        if tx.user_calculation_unit_id and not completes:
            conflicts.append(
                f"Transaction {tx_id} is already in bundle {tx.user_calculation_unit_id}"
            )
    if conflicts:
        raise HTTPException(
            status_code=400,
            detail="Some transactions are already in a bundle: " + "; ".join(conflicts),
        )

    # Reconstruct the suggestion
    suggestion = GroupingSuggestion(
        pattern=request.pattern,
        label=request.label or f"{request.pattern.title()} Unit",
        reason="User accepted suggestion",
        confidence=1.0,
        transactions=[{"id": tx_id} for tx_id in request.transaction_ids],
    )

    unit = service.accept_suggestion(
        suggestion,
        label=request.label,
        notes=request.notes,
        taxability_override=request.taxability_override,
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
        bundle_data=request.metadata,
    )
    session.add(bundle)
    session.flush()

    # Link transactions via user_calculation_unit_id FK
    for tx in transactions:
        tx.user_calculation_unit_id = bundle.id
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
    # Use model_fields_set to detect if taxability_override was explicitly sent (even as null)
    if "taxability_override" in request.model_fields_set:
        bundle.taxability_override = (
            request.taxability_override.value if request.taxability_override else None
        )
    if "metadata" in request.model_fields_set:
        bundle.bundle_data = request.metadata

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
            session.add(tx)

    session.delete(bundle)
    session.commit()

    return {"success": True, "message": f"Bundle {bundle_id} deleted"}


@router.post("/{bundle_id}/add-transactions")
def add_transactions_to_bundle(
    bundle_id: int,
    request: TransactionIdsRequest,
    session: Session = Depends(get_db),
):
    """Add transactions to an existing bundle."""
    bundle = session.get(UserCalculationBundle, bundle_id)
    if not bundle:
        raise HTTPException(status_code=404, detail="Bundle not found")

    added = []
    skipped = []
    for tx_id in request.transaction_ids:
        tx = session.get(NormalizedTransaction, tx_id)
        if not tx:
            continue
        if tx.user_calculation_unit_id:
            skipped.append(
                {"id": tx_id, "existing_bundle_id": tx.user_calculation_unit_id}
            )
            continue  # Already in a bundle

        tx.user_calculation_unit_id = bundle_id
        session.add(tx)
        added.append(tx_id)

    session.commit()

    return {
        "success": True,
        "added_count": len(added),
        "added": added,
        "skipped": skipped,
    }


@router.post("/{bundle_id}/remove-transactions")
def remove_transactions_from_bundle(
    bundle_id: int,
    request: TransactionIdsRequest,
    session: Session = Depends(get_db),
):
    """Remove transactions from a bundle."""
    bundle = session.get(UserCalculationBundle, bundle_id)
    if not bundle:
        raise HTTPException(status_code=404, detail="Bundle not found")

    removed = 0
    for tx_id in request.transaction_ids:
        tx = session.get(NormalizedTransaction, tx_id)
        if not tx:
            continue
        if tx.user_calculation_unit_id != bundle_id:
            continue

        tx.user_calculation_unit_id = None
        session.add(tx)
        removed += 1

    session.commit()

    return {"success": True, "removed_count": removed}


# ============================================================================
# Helper Functions
# ============================================================================


def _build_unit_response(
    bundle: UserCalculationBundle, session: Session
) -> UnitResponse:
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

    # Cache for account and asset lookups
    account_cache: dict = {}
    asset_cache: dict = {}

    def get_account_name(account_id: Optional[int]) -> Optional[str]:
        if not account_id:
            return None
        if account_id not in account_cache:
            account = session.get(Account, account_id)
            account_cache[account_id] = account.name if account else None
        return account_cache[account_id]

    def get_asset_symbol(asset_id: Optional[int]) -> Optional[str]:
        if not asset_id:
            return None
        if asset_id not in asset_cache:
            asset = session.get(Asset, asset_id)
            asset_cache[asset_id] = asset.symbol if asset else None
        return asset_cache[asset_id]

    for tx in transactions:
        # Get asset symbol
        asset_symbol = tx.source_asset_symbol
        if not asset_symbol and tx.asset_id:
            asset_symbol = get_asset_symbol(tx.asset_id)

        # Get price and fee quote asset symbols
        price_quote_asset_symbol = get_asset_symbol(tx.price_quote_asset_id)
        fee_quote_asset_symbol = get_asset_symbol(tx.fee_quote_asset_id)

        # Get account names
        account_name = get_account_name(tx.account_id)
        from_account_name = get_account_name(tx.from_account_id)
        to_account_name = get_account_name(tx.to_account_id)

        # Build AssetRef with linked asset or source_symbol fallback
        asset_ref = None
        if tx.asset_id:
            asset = session.get(Asset, tx.asset_id)
            if asset:
                asset_ref = AssetRef(
                    id=asset.asset_id,
                    symbol=asset.symbol,
                    label=asset.label,
                    source_symbol=tx.source_asset_symbol,
                )
        elif asset_symbol:
            asset_ref = AssetRef(
                id=None, symbol=None, label=None, source_symbol=asset_symbol
            )

        tx_summaries.append(
            TransactionSummary(
                id=tx.id,
                date_time=tx.date_time.replace(tzinfo=timezone.utc).isoformat()
                if tx.date_time
                else None,
                direction=tx.direction,
                transaction_type=tx.transaction_type,
                asset=asset_ref,
                quantity=float(tx.quantity) if tx.quantity else 0,
                source=tx.source,
                source_transaction_id=tx.source_transaction_id,
                network=tx.network,
                # Extended fields
                account_id=tx.account_id,
                account_name=account_name,
                price=float(tx.price) if tx.price else None,
                total=float(tx.total) if tx.total else None,
                fee=float(tx.fee) if tx.fee else None,
                from_account_name=from_account_name,
                to_account_name=to_account_name,
                source_from_account=tx.source_from_account,
                source_to_account=tx.source_to_account,
                source_transaction_type=tx.source_transaction_type,
                network_transaction_id=tx.network_transaction_id,
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
        metadata=bundle.bundle_data,
        created_at=bundle.created_at.replace(tzinfo=timezone.utc).isoformat()
        if bundle.created_at
        else "",
        transaction_count=len(tx_summaries),
        transactions=tx_summaries,
        total_inflow=inflows if inflows else None,
        total_outflow=outflows if outflows else None,
    )
