"""
Data Health API routes for transaction quality checks.

Provides endpoints for:
- Duplicate group detection (with tolerance-based matching)
- Group-based resolution (keep/merge/dismiss actions)
"""

from datetime import datetime, timedelta, timezone
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, HTTPException, Depends, Query
from sqlmodel import Session
from pydantic import BaseModel

from backend.db.models import NormalizedTransaction
from backend.db.database import get_session_dependency
from backend.config.loader import configure_logging, load_settings

log = configure_logging("data_health_api")

router = APIRouter(prefix="/data-health", tags=["data-health"])


# ============================================================================
# Pydantic Models
# ============================================================================


class TransactionSummary(BaseModel):
    """Summary of a transaction for duplicate display."""
    
    id: int
    source: str
    source_transaction_id: Optional[str] = None
    date_time: Optional[str] = None
    source_asset_symbol: str
    quantity: float
    price: Optional[float] = None
    total: Optional[float] = None
    direction: Optional[str] = None
    source_transaction_type: Optional[str] = None
    source_price_quote_asset_symbol: Optional[str] = None
    account_id: Optional[int] = None
    review_status: Optional[str] = None
    tags: Optional[List[Dict[str, Any]]] = None
    dup_resolved: Optional[bool] = None
    dup_resolution: Optional[str] = None
    dup_resolved_at: Optional[str] = None
    dup_kept_ids: Optional[str] = None
    connector_type: Optional[str] = None
    run_id: Optional[int] = None
    synced_at: Optional[str] = None


class ConnectorBreakdown(BaseModel):
    """Breakdown of transactions by connector."""
    
    connector_type: str
    run_id: Optional[int]
    count: int
    transaction_ids: List[int]


class DuplicateGroup(BaseModel):
    """A group of potentially duplicate transactions."""
    
    group_hash: str
    transaction_count: int
    transactions: List[TransactionSummary]
    connector_breakdown: List[ConnectorBreakdown]
    match_criteria: str


class DuplicateGroupsResponse(BaseModel):
    """Response model for duplicate groups."""
    
    total_groups: int
    groups: List[DuplicateGroup]
    time_tolerance_seconds: int
    amount_tolerance_percent: float


class DuplicateSuspicion(BaseModel):
    """Lightweight duplicate suspicion for the TransactionsTable map."""
    group_hash: str
    transaction_ids: List[int]
    match_criteria: str


class DuplicateSuspicionsResponse(BaseModel):
    """Response for duplicate suspicions (lightweight)."""
    suspicions: List[DuplicateSuspicion]


class ResolveDuplicateGroupRequest(BaseModel):
    """Request to resolve a duplicate group."""
    
    group_hash: str
    action: str  # "keep_selected" or "dismiss_selected"
    selected_transaction_ids: List[int]
    all_transaction_ids: List[int]  # All TX IDs in the group (needed for fuzzy groups)
    note: Optional[str] = None


class ResolveDuplicateGroupResponse(BaseModel):
    """Response for resolving a duplicate group."""
    
    status: str
    group_hash: str
    action: str
    affected_transaction_count: int
    message: str
    updated_group: Optional[DuplicateGroup] = None


# ============================================================================
# Helper Functions
# ============================================================================


def _tx_to_summary(tx: NormalizedTransaction) -> TransactionSummary:
    """Convert a transaction to a summary dict."""
    return TransactionSummary(
        id=tx.id,
        source=tx.source,
        source_transaction_id=tx.source_transaction_id,
        date_time=tx.date_time.replace(tzinfo=timezone.utc).isoformat() if tx.date_time else None,
        source_asset_symbol=tx.source_asset_symbol,
        quantity=float(tx.quantity) if tx.quantity else 0,
        price=float(tx.price) if tx.price else None,
        total=float(tx.total) if tx.total else None,
        direction=tx.direction,
        source_transaction_type=tx.source_transaction_type,
        source_price_quote_asset_symbol=tx.source_price_quote_asset_symbol,
        account_id=tx.account_id,
        review_status=tx.review_status,
        tags=tx.tags,
    )


def _get_duplicate_group_transactions(
    session: Session,
    group_hash: str,
    transaction_ids: Optional[List[int]] = None,
) -> List[NormalizedTransaction]:
    """
    Get all non-invalid transactions for a duplicate group.
    
    With fuzzy detection, the group_hash is derived from sorted TX IDs
    and is NOT stored on the transaction rows. So we use transaction_ids
    to look up the transactions.
    
    Falls back to querying by transaction_hash column for backward
    compatibility with already-resolved groups.
    
    Args:
        session: Database session
        group_hash: Group hash (used for tag lookup fallback)
        transaction_ids: Explicit list of transaction IDs in the group
    
    Returns:
        List of NormalizedTransaction objects (excluding invalid transactions)
    """
    from sqlmodel import select
    from backend.services.duplicate_detection_service import _filter_same_run_different_id_transactions
    
    if transaction_ids:
        all_txs = session.exec(
            select(NormalizedTransaction).where(
                NormalizedTransaction.id.in_(transaction_ids),
                NormalizedTransaction.review_status != "invalid"
            )
        ).all()
    else:
        # Fallback: try transaction_hash column (legacy exact-hash groups)
        all_txs = session.exec(
            select(NormalizedTransaction).where(
                NormalizedTransaction.transaction_hash == group_hash,
                NormalizedTransaction.review_status != "invalid"
            )
        ).all()
    
    return _filter_same_run_different_id_transactions(all_txs)


# ============================================================================
# Endpoints
# ============================================================================


@router.get("/duplicate-groups", response_model=DuplicateGroupsResponse)
def get_duplicate_groups(
    account_id: Optional[int] = Query(None, description="Filter by account ID"),
    time_filter: Optional[str] = Query(None, description="Time filter: 'week', '30d', '90d', 'all'"),
    connector_run_id: Optional[int] = Query(None, description="Filter by connector run ID"),
    session: Session = Depends(get_session_dependency),
):
    """
    Get all duplicate groups detected by the duplicate detection service.
    
    Groups are identified by transaction_hash and include all transactions
    with matching hashes (both resolved and unresolved).
    """
    from sqlmodel import select
    from backend.services.duplicate_detection_service import detect_duplicate_groups
    
    log.info(f"🔍 Fetching duplicate groups (account_id={account_id}, time_filter={time_filter})")
    
    # Get settings for display
    settings = load_settings()
    dup_config = settings.get("duplicate_detection", {})
    time_tolerance = dup_config.get("time_window_seconds", 30)
    amount_tolerance = dup_config.get("amount_tolerance_percent", 1.0)
    
    # Calculate time cutoff for performance filtering at query level
    time_filter_cutoff = None
    if time_filter and time_filter != "all":
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
        
        if time_filter == "week":
            time_filter_cutoff = now - timedelta(days=7)
        elif time_filter == "30d":
            time_filter_cutoff = now - timedelta(days=30)
        elif time_filter == "90d":
            time_filter_cutoff = now - timedelta(days=90)
    
    # Detect duplicate groups with time filter at query level
    duplicate_groups = detect_duplicate_groups(
        session=session,
        account_id=account_id,
        transaction_ids=None,
        config=dup_config,
        time_filter_cutoff=time_filter_cutoff,
    )
    
    # Apply connector_run_id filter if specified
    if connector_run_id:
        filtered_groups = []
        for group in duplicate_groups:
            # Check if any transaction in group matches connector_run_id
            matching_txs = [
                tx for tx in group.transactions
                if tx.get("sync_connector_run_id") == connector_run_id
            ]
            if matching_txs:
                filtered_groups.append(group)
        duplicate_groups = filtered_groups
    
    log.info(f"✅ Found {len(duplicate_groups)} duplicate groups")
    
    # Convert to API response format
    api_groups = []
    for group in duplicate_groups:
        # Transactions are already dicts from the service
        # Normalize tags field (empty dict -> empty list)
        transactions = []
        for tx in group.transactions:
            # Convert tags from dict to list if needed
            if isinstance(tx.get("tags"), dict) and not tx["tags"]:
                tx = {**tx, "tags": []}
            elif not isinstance(tx.get("tags"), list):
                tx = {**tx, "tags": [] if tx.get("tags") is None else list(tx["tags"])}
            transactions.append(TransactionSummary(**tx))
        
        # Build connector breakdown
        connector_breakdown = []
        for connector, tx_ids in group.connector_breakdown.items():
            # Parse run_id from connector string (format: "mexc-api|run_45" or "manual")
            run_id = None
            if "|run_" in connector:
                try:
                    run_id = int(connector.split("|run_")[1])
                except (IndexError, ValueError):
                    pass
            
            connector_breakdown.append(ConnectorBreakdown(
                connector_type=connector,
                run_id=run_id,
                count=len(tx_ids),
                transaction_ids=tx_ids
            ))
        
        api_groups.append(DuplicateGroup(
            group_hash=group.group_hash,
            transaction_count=len(group.transactions),
            transactions=transactions,
            connector_breakdown=connector_breakdown,
            match_criteria=group.match_criteria_summary
        ))
    
    log.info(f"✅ Found {len(api_groups)} duplicate groups")
    
    return DuplicateGroupsResponse(
        total_groups=len(api_groups),
        groups=api_groups,
        time_tolerance_seconds=time_tolerance,
        amount_tolerance_percent=amount_tolerance,
    )


@router.post("/resolve-duplicate-group", response_model=ResolveDuplicateGroupResponse)
def resolve_duplicate_group(
    request: ResolveDuplicateGroupRequest,
    session: Session = Depends(get_session_dependency),
):
    """
    Resolve a duplicate group by keeping selected transactions or dismissing them.
    
    Actions:
    - keep_selected: Keep selected transactions, merge/mark others as invalid
    - dismiss_selected: Remove selected transactions from group (partial dismissal)
    """
    from backend.services.duplicate_detection_service import mark_duplicate_resolution
    
    if request.action not in ["keep_selected", "dismiss_selected"]:
        raise HTTPException(
            status_code=400, 
            detail=f"Invalid action '{request.action}'. Must be 'keep_selected' or 'dismiss_selected'"
        )
    
    if not request.selected_transaction_ids:
        raise HTTPException(status_code=400, detail="No transactions selected")
    
    log.info(
        f"🔧 Resolving duplicate group {request.group_hash} "
        f"with action '{request.action}' on {len(request.selected_transaction_ids)} transactions"
    )
    
    # Get all transactions in this group
    from sqlmodel import select
    
    all_group_txs = _get_duplicate_group_transactions(
        session, request.group_hash, request.all_transaction_ids
    )
    
    if not all_group_txs:
        raise HTTPException(
            status_code=404,
            detail=f"No valid transactions found for duplicate group {request.group_hash}. "
                   "All transactions may already be marked as invalid."
        )
    
    all_tx_ids = [tx.id for tx in all_group_txs]
    selected_ids_set = set(request.selected_transaction_ids)
    
    # Determine kept, merged, and dismissed based on action
    if request.action == "keep_selected":
        kept_tx_ids = request.selected_transaction_ids
        merged_tx_ids = [tx_id for tx_id in all_tx_ids if tx_id not in selected_ids_set]
        dismissed_tx_ids = []
        
        # Mark merged transactions as invalid
        for tx_id in merged_tx_ids:
            tx = session.get(NormalizedTransaction, tx_id)
            if tx:
                tx.review_status = "invalid"
                session.add(tx)
    elif request.action == "dismiss_selected":
        kept_tx_ids = []
        merged_tx_ids = []
        dismissed_tx_ids = request.selected_transaction_ids
    else:
        raise HTTPException(status_code=400, detail=f"Invalid action: {request.action}")
    
    # Mark resolution
    mark_duplicate_resolution(
        group_hash=request.group_hash,
        kept_tx_ids=kept_tx_ids,
        merged_tx_ids=merged_tx_ids,
        dismissed_tx_ids=dismissed_tx_ids,
        session=session,
    )
    
    affected_count = len(kept_tx_ids) + len(merged_tx_ids) + len(dismissed_tx_ids)
    
    session.commit()
    
    action_msg = (
        f"Kept {len(request.selected_transaction_ids)} transaction(s), merged/invalidated others"
        if request.action == "keep_selected"
        else f"Dismissed {len(request.selected_transaction_ids)} transaction(s) from group"
    )
    
    log.info(f"✅ Resolved duplicate group {request.group_hash}: {action_msg}")
    
    # Fetch updated group with new resolution statuses
    from backend.db.models import SyncJobConnectorRun
    
    # Get all transactions for this group again (with updated resolution tags)
    updated_txs = _get_duplicate_group_transactions(
        session, request.group_hash, request.all_transaction_ids
    )
    
    # Build updated group response
    transactions = []
    for tx in updated_txs:
        tx_dict = {
            "id": tx.id,
            "source": tx.source,
            "source_transaction_id": tx.source_transaction_id,
            "source_transaction_type": tx.source_transaction_type,
            "date_time": tx.date_time.replace(tzinfo=timezone.utc).isoformat() if tx.date_time else None,
            "source_asset_symbol": tx.source_asset_symbol,
            "source_price_quote_asset_symbol": tx.source_price_quote_asset_symbol,
            "quantity": float(tx.quantity) if tx.quantity else 0,
            "price": float(tx.price) if tx.price else None,
            "total": float(tx.total) if tx.total else None,
            "direction": tx.direction,
            "account_id": tx.account_id,
            "review_status": tx.review_status,
            "tags": tx.tags,
            "synced_at": tx.synced_at.isoformat() if tx.synced_at else None,
            "dup_resolved": False,
        }
        
        # Add connector info
        if tx.sync_connector_run_id:
            run = session.get(SyncJobConnectorRun, tx.sync_connector_run_id)
            if run:
                tx_dict["connector_type"] = run.connector_type
                tx_dict["run_id"] = run.id
        
        # Add resolution info
        if tx.tags:
            dup_resolution = None
            dup_resolved_at = None
            dup_kept_ids = None
            has_group_tag = False
            
            # Iterate through ALL tags to collect resolution info from separate tag objects
            for tag in tx.tags:
                if tag.get("sys_group") == request.group_hash:
                    has_group_tag = True
                if tag.get("sys_resolution"):
                    dup_resolution = tag.get("sys_resolution")
                if tag.get("sys_resolved_at"):
                    dup_resolved_at = tag.get("sys_resolved_at")
                if tag.get("sys_kept_ids"):
                    dup_kept_ids = tag.get("sys_kept_ids")
            
            # Only set resolution fields if transaction belongs to this group and has resolution
            if has_group_tag and dup_resolution:
                tx_dict["dup_resolved"] = True
                tx_dict["dup_resolution"] = dup_resolution
                tx_dict["dup_resolved_at"] = dup_resolved_at
                if dup_kept_ids:
                    tx_dict["dup_kept_ids"] = dup_kept_ids
        
        # Normalize tags
        if isinstance(tx_dict.get("tags"), dict) and not tx_dict["tags"]:
            tx_dict["tags"] = []
        elif not isinstance(tx_dict.get("tags"), list):
            tx_dict["tags"] = [] if tx_dict.get("tags") is None else list(tx_dict["tags"])
        
        transactions.append(TransactionSummary(**tx_dict))
    
    # Build connector breakdown
    connector_breakdown = {}
    for tx in updated_txs:
        if tx.sync_connector_run_id:
            run = session.get(SyncJobConnectorRun, tx.sync_connector_run_id)
            if run:
                key = f"{run.connector_type}|run_{run.id}"
                if key not in connector_breakdown:
                    connector_breakdown[key] = []
                connector_breakdown[key].append(tx.id)
    
    connector_breakdown_list = []
    for connector, tx_ids in connector_breakdown.items():
        run_id = None
        if "|run_" in connector:
            try:
                run_id = int(connector.split("|run_")[1])
            except (IndexError, ValueError):
                pass
        
        connector_breakdown_list.append(ConnectorBreakdown(
            connector_type=connector,
            run_id=run_id,
            count=len(tx_ids),
            transaction_ids=tx_ids
        ))
    
    updated_group = DuplicateGroup(
        group_hash=request.group_hash,
        transaction_count=len(transactions),
        transactions=transactions,
        connector_breakdown=connector_breakdown_list,
        match_criteria="transaction_hash"
    )
    
    return ResolveDuplicateGroupResponse(
        status="success",
        group_hash=request.group_hash,
        action=request.action,
        affected_transaction_count=affected_count,
        message=action_msg,
        updated_group=updated_group,
    )


@router.get("/duplicate-count", deprecated=True)
def get_duplicate_count(
    account_id: Optional[int] = Query(None, description="Filter by account ID"),
    connector_run_id: Optional[int] = Query(None, description="Filter by connector run ID"),
    session: Session = Depends(get_session_dependency),
):
    """
    DEPRECATED: Use /duplicate-groups?summary_only=true instead.
    
    Get count of duplicate groups and unresolved duplicate transactions.
    Queries transaction_hash column to find duplicates.
    Optionally filter by account_id and/or connector_run_id.
    """
    from sqlmodel import select, func
    from backend.services.duplicate_detection_service import detect_duplicate_groups
    
    # Use detect_duplicate_groups to get accurate count
    # This includes proper filtering for unresolved groups
    duplicate_groups = detect_duplicate_groups(
        session=session,
        account_id=account_id,
        transaction_ids=None,
        config=None,
    )
    
    # Apply connector_run_id filter if specified
    if connector_run_id:
        filtered_groups = []
        for group in duplicate_groups:
            # Check if any transaction in group matches connector_run_id
            matching_txs = [
                tx for tx in group.transactions
                if tx.get("sync_connector_run_id") == connector_run_id
            ]
            if matching_txs:
                filtered_groups.append(group)
        duplicate_groups = filtered_groups
    
    # Count unresolved transactions across all groups
    unresolved_tx_count = 0
    for group in duplicate_groups:
        unresolved_tx_count += sum(
            1 for tx in group.transactions
            if not tx.get("dup_resolved", False)
        )
    
    return {
        "duplicate_group_count": len(duplicate_groups),
        "duplicate_transaction_count": unresolved_tx_count,
        "account_id": account_id,
        "connector_run_id": connector_run_id,
    }


@router.get("/duplicate-suspicions", response_model=DuplicateSuspicionsResponse)
def get_duplicate_suspicions(
    account_id: Optional[int] = Query(None, description="Filter by account ID"),
    time_filter: Optional[str] = Query(None, description="Time filter: 'week', '30d', '90d', 'all'"),
    session: Session = Depends(get_session_dependency),
):
    """
    Lightweight endpoint returning only duplicate group hashes and transaction IDs.
    
    Used by the TransactionsTable to build a duplicate-suspicion map
    without fetching full transaction details.
    """
    from backend.services.duplicate_detection_service import detect_duplicate_suspicions

    settings = load_settings()
    dup_config = settings.get("duplicate_detection", {})

    time_filter_cutoff = None
    if time_filter and time_filter != "all":
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
        if time_filter == "week":
            time_filter_cutoff = now - timedelta(days=7)
        elif time_filter == "30d":
            time_filter_cutoff = now - timedelta(days=30)
        elif time_filter == "90d":
            time_filter_cutoff = now - timedelta(days=90)

    suspicions = detect_duplicate_suspicions(
        session=session,
        account_id=account_id,
        config=dup_config,
        time_filter_cutoff=time_filter_cutoff,
    )

    return DuplicateSuspicionsResponse(
        suspicions=[
            DuplicateSuspicion(
                group_hash=s["group_hash"],
                transaction_ids=s["transaction_ids"],
                match_criteria=s["match_criteria"],
            )
            for s in suspicions
        ]
    )

