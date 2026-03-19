"""
Duplicate Detection Service

Detects potential duplicate transactions across different sources and sync runs.
Uses fuzzy matching with configurable time window and amount tolerance.
Groups are identified by deterministic hash of sorted member TX IDs.
Stores duplicate group information in transaction tags for resolution tracking.
"""

import hashlib
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal, ROUND_DOWN
from typing import Dict, List, Optional, Set, Tuple, Any

from sqlmodel import Session, select, and_, or_
from sqlalchemy.orm.attributes import flag_modified

from backend.config.loader import configure_logging, load_settings
from backend.db.models import NormalizedTransaction, SyncJobConnectorRun

log = configure_logging("duplicate_detection")


@dataclass
class DuplicateGroup:
    """Represents a group of potentially duplicate transactions."""
    
    group_hash: str
    transactions: List[Dict[str, Any]]
    match_criteria_summary: str
    connector_breakdown: Dict[str, List[int]]  # e.g., {"mexc-api|run_45": [1,2], "manual": [5]}
    detected_at: datetime = field(default_factory=datetime.now)
    match_type: str = "fuzzy"  # "fuzzy" (default for new detection)
    
    @property
    def transaction_count(self) -> int:
        return len(self.transactions)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict for API responses."""
        return {
            "group_hash": self.group_hash,
            "transactions": self.transactions,
            "match_criteria_summary": self.match_criteria_summary,
            "connector_breakdown": self.connector_breakdown,
            "detected_at": self.detected_at.isoformat() if self.detected_at else None,
            "transaction_count": len(self.transactions),
            "match_type": self.match_type,
        }


def get_duplicate_detection_config() -> Dict[str, Any]:
    """Load duplicate detection configuration from settings."""
    settings = load_settings()
    return settings.get("duplicate_detection", {
        "enabled": True,
        "time_window_seconds": 30,
        "amount_tolerance_percent": 1.0,
    })


def compute_transaction_hash(
    account_id: int,
    datetime_obj: datetime,
    source_asset_symbol: str,
    source_price_quote_asset_symbol: str,
    direction: str,
    quantity: Decimal,
    price: Optional[Decimal],
    session: Optional[Session] = None,
    asset_id: Optional[int] = None,
    price_quote_asset_id: Optional[int] = None,
) -> str:
    """
    DEPRECATED: Kept for backward compatibility. No longer used for duplicate detection.
    Fuzzy detection now uses SQL self-joins on existing columns instead.
    """
    from backend.db.models import Asset
    
    dt_str = datetime_obj.strftime("%Y-%m-%dT%H:%M:%S") if datetime_obj else ""
    base_symbol = source_asset_symbol
    quote_symbol = source_price_quote_asset_symbol
    
    if session is not None:
        if asset_id is not None:
            asset = session.get(Asset, asset_id)
            if asset and asset.symbol:
                base_symbol = asset.symbol
        if price_quote_asset_id is not None:
            quote_asset = session.get(Asset, price_quote_asset_id)
            if quote_asset and quote_asset.symbol:
                quote_symbol = quote_asset.symbol
    
    base_normalized = base_symbol.upper() if base_symbol else ""
    quote_normalized = quote_symbol.upper() if quote_symbol else ""
    direction_normalized = direction.lower() if direction else ""
    qty_decimal = Decimal(str(quantity)).quantize(Decimal("0.00000001"), rounding=ROUND_DOWN)
    price_decimal = Decimal(str(price or 0)).quantize(Decimal("0.00000001"), rounding=ROUND_DOWN)
    unique_str = f"{account_id}_{dt_str}_{base_normalized}_{quote_normalized}_{direction_normalized}_{qty_decimal}_{price_decimal}"
    return hashlib.md5(unique_str.encode()).hexdigest()


def compute_group_hash(tx_ids: List[int]) -> str:
    """Compute a deterministic group hash from sorted transaction IDs.
    
    This is the canonical identifier for a fuzzy duplicate group.
    Changing membership changes the hash.
    
    Args:
        tx_ids: List of transaction IDs in the group
        
    Returns:
        MD5 hash of comma-separated sorted IDs (32 hex chars)
    """
    sorted_ids = sorted(tx_ids)
    id_str = ",".join(str(i) for i in sorted_ids)
    return hashlib.md5(id_str.encode()).hexdigest()


def _resolve_asset_symbol(tx: NormalizedTransaction) -> str:
    """Get the best asset symbol for a transaction (resolved > source), uppercased."""
    if tx.asset and tx.asset.symbol:
        return tx.asset.symbol.upper()
    return (tx.source_asset_symbol or "").upper()


def _transaction_has_resolution_tag(tags: Optional[List[Dict[str, str]]], group_hash: str) -> bool:
    """Check if transaction has been resolved for this group hash."""
    if not tags:
        return False
    return any(
        tag.get("sys_group") == group_hash
        for tag in tags
    )


def _transaction_has_any_resolution(tags: Optional[List[Dict[str, str]]]) -> bool:
    """Check if transaction has any duplicate resolution tag (any group)."""
    if not tags:
        return False
    return any(
        tag.get("sys_resolution") in ("kept", "merged", "dismissed")
        for tag in tags
    )


def _filter_same_run_different_id_transactions(transactions: List[NormalizedTransaction]) -> List[NormalizedTransaction]:
    """
    Filter out transactions that come from the same connector run but have different source_transaction_id.
    
    If transactions share the same sync_connector_run_id but have different source_transaction_id values,
    they are genuinely different transactions from the source system and should not be considered duplicates.
    """
    by_run: Dict[Optional[int], List[NormalizedTransaction]] = defaultdict(list)
    
    for tx in transactions:
        by_run[tx.sync_connector_run_id].append(tx)
    
    valid_duplicates = []
    for run_id, run_txs in by_run.items():
        if run_id is None:
            valid_duplicates.extend(run_txs)
            continue
        
        # Only apply filtering when there are 2+ transactions from the same run.
        # A single transaction in a run bucket is always valid (can't conflict with itself).
        if len(run_txs) < 2:
            valid_duplicates.extend(run_txs)
            continue
        
        source_ids = [tx.source_transaction_id for tx in run_txs if tx.source_transaction_id]
        
        if len(source_ids) == len(set(source_ids)):
            log.debug(
                "Excluding transactions from same run with different source IDs",
                run_id=run_id,
                count=len(run_txs),
                source_ids=source_ids[:5]
            )
            continue
        
        valid_duplicates.extend(run_txs)
    
    return valid_duplicates


class _UnionFind:
    """Simple union-find for clustering fuzzy-matched transaction pairs."""
    
    def __init__(self):
        self._parent: Dict[int, int] = {}
    
    def find(self, x: int) -> int:
        if x not in self._parent:
            self._parent[x] = x
        while self._parent[x] != x:
            self._parent[x] = self._parent[self._parent[x]]  # path compression
            x = self._parent[x]
        return x
    
    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self._parent[ra] = rb
    
    def groups(self) -> Dict[int, List[int]]:
        """Return groups as {root: [members]}."""
        result: Dict[int, List[int]] = defaultdict(list)
        for x in self._parent:
            result[self.find(x)].append(x)
        return dict(result)


def detect_duplicate_groups(
    session: Session,
    account_id: Optional[int] = None,
    transaction_ids: Optional[List[int]] = None,
    config: Optional[Dict[str, Any]] = None,
    time_filter_cutoff: Optional[datetime] = None,
) -> List[DuplicateGroup]:
    """
    Detect fuzzy duplicate transaction groups using SQL self-join.
    
    Matches transactions that share:
    - Same account_id
    - Same asset symbol (resolved or source, case-insensitive)
    - Same direction
    - date_time within ±time_window_seconds
    - quantity within ±amount_tolerance_percent
    
    Excludes review_status="invalid" and same-run-different-ID pairs.
    Uses union-find to merge transitive matches into groups.
    Groups with all transactions resolved are skipped.
    
    Args:
        session: Database session
        account_id: Optional account ID to filter by
        transaction_ids: Optional list of transaction IDs to filter by  
        config: Configuration dict (uses default if not provided)
        time_filter_cutoff: Optional datetime cutoff for created_at filter
    
    Returns:
        List of DuplicateGroup objects containing grouped duplicates.
    """
    if config is None:
        config = get_duplicate_detection_config()
    
    if not config.get("enabled", True):
        return []
    
    time_window = config.get("time_window_seconds", 30)
    amount_tolerance = config.get("amount_tolerance_percent", 1.0)
    
    from sqlalchemy import func, text, literal_column, cast, Float
    from sqlalchemy.orm import selectinload, aliased
    
    T1 = aliased(NormalizedTransaction, name="t1")
    T2 = aliased(NormalizedTransaction, name="t2")
    
    # Build the self-join query to find fuzzy-matching pairs
    # Match criteria:
    #   - Same account_id
    #   - Same direction
    #   - Same asset (COALESCE resolved asset symbol vs source_asset_symbol, case-insensitive)
    #   - date_time within ±time_window_seconds
    #   - quantity within ±amount_tolerance_percent
    #   - t1.id < t2.id to avoid duplicate pairs
    
    # For asset matching: use UPPER(source_asset_symbol) since asset_id may be null
    # and source_asset_symbol is always present
    pair_query = (
        select(T1.id, T2.id)
        .where(T1.id < T2.id)
        .where(T1.review_status != "invalid")
        .where(T2.review_status != "invalid")
        .where(T1.account_id.isnot(None))
        .where(T2.account_id.isnot(None))
        .where(T1.date_time.isnot(None))
        .where(T2.date_time.isnot(None))
        .where(T1.account_id == T2.account_id)
        .where(T1.direction == T2.direction)
        .where(func.upper(T1.source_asset_symbol) == func.upper(T2.source_asset_symbol))
        # Time window: abs difference in seconds <= time_window
        .where(
            func.abs(
                func.extract("epoch", T1.date_time) - func.extract("epoch", T2.date_time)
            ) <= time_window
        )
        # Amount tolerance: abs(q1 - q2) / greatest(q1, q2) * 100 <= tolerance
        .where(
            func.abs(T1.quantity - T2.quantity)
            / func.greatest(func.abs(T1.quantity), func.abs(T2.quantity), Decimal("0.00000001"))
            * 100
            <= amount_tolerance
        )
    )
    
    # Apply filters
    if account_id is not None:
        pair_query = pair_query.where(T1.account_id == account_id)
    
    if transaction_ids:
        pair_query = pair_query.where(
            or_(T1.id.in_(transaction_ids), T2.id.in_(transaction_ids))
        )
    
    if time_filter_cutoff is not None:
        pair_query = pair_query.where(T1.created_at >= time_filter_cutoff)
        pair_query = pair_query.where(T2.created_at >= time_filter_cutoff)
    
    # Execute to get all matching pairs
    pairs = session.exec(pair_query).all()
    
    if not pairs:
        log.debug("No fuzzy duplicate pairs found")
        return []
    
    log.debug("Found fuzzy duplicate pairs", pair_count=len(pairs))
    
    # Build union-find groups from pairs
    uf = _UnionFind()
    all_tx_ids_in_pairs: Set[int] = set()
    for t1_id, t2_id in pairs:
        uf.union(t1_id, t2_id)
        all_tx_ids_in_pairs.add(t1_id)
        all_tx_ids_in_pairs.add(t2_id)
    
    # Fetch all involved transactions with relationships
    tx_query = (
        select(NormalizedTransaction)
        .where(NormalizedTransaction.id.in_(list(all_tx_ids_in_pairs)))
        .options(
            selectinload(NormalizedTransaction.asset),
            selectinload(NormalizedTransaction.price_quote_asset),
            selectinload(NormalizedTransaction.fee_quote_asset),
        )
    )
    all_txs = session.exec(tx_query).all()
    tx_map: Dict[int, NormalizedTransaction] = {tx.id: tx for tx in all_txs}
    
    # Build groups from union-find
    raw_groups = uf.groups()
    
    duplicate_groups: List[DuplicateGroup] = []
    
    for root, member_ids in raw_groups.items():
        if len(member_ids) < 2:
            continue
        
        group_txs = [tx_map[tid] for tid in member_ids if tid in tx_map]
        if len(group_txs) < 2:
            continue
        
        # Filter out same-run-different-ID transactions
        group_txs = _filter_same_run_different_id_transactions(group_txs)
        if len(group_txs) < 2:
            continue
        
        # Compute deterministic group hash from sorted TX IDs
        group_tx_ids = sorted(tx.id for tx in group_txs)
        group_hash = compute_group_hash(group_tx_ids)
        
        # Check if all transactions are resolved for this group
        unresolved_count = sum(
            1 for tx in group_txs
            if not _transaction_has_resolution_tag(tx.tags, group_hash)
        )
        
        if unresolved_count == 0:
            log.debug(
                "Skipping fully resolved fuzzy duplicate group",
                hash=group_hash[:8],
                txs=len(group_txs),
            )
            continue
        
        # Build connector breakdown
        connector_breakdown: Dict[str, List[int]] = defaultdict(list)
        for tx in group_txs:
            if tx.sync_connector_run_id:
                run = session.get(SyncJobConnectorRun, tx.sync_connector_run_id)
                if run:
                    key = f"{run.connector_type}|run_{run.id}"
                else:
                    key = f"{tx.source}|unknown_run"
            else:
                key = "manual"
            connector_breakdown[key].append(tx.id)
        
        # Build match criteria summary
        first_tx = group_txs[0]
        base_symbol = _resolve_asset_symbol(first_tx)
        
        # Calculate actual time delta and qty delta for the summary
        datetimes = [tx.date_time for tx in group_txs if tx.date_time]
        quantities = [float(tx.quantity) for tx in group_txs if tx.quantity]
        
        time_delta_str = ""
        if len(datetimes) >= 2:
            min_dt = min(datetimes)
            max_dt = max(datetimes)
            delta_secs = abs((max_dt - min_dt).total_seconds())
            time_delta_str = f"{delta_secs:.0f}s apart"
        
        qty_delta_str = ""
        if len(quantities) >= 2:
            min_q, max_q = min(quantities), max(quantities)
            if max_q > 0:
                pct_diff = abs(max_q - min_q) / max_q * 100
                qty_delta_str = f"{pct_diff:.2f}% qty diff"
        
        direction = first_tx.direction or "unknown"
        match_criteria_summary = (
            f"{base_symbol} {direction}"
            f"{', ' + time_delta_str if time_delta_str else ''}"
            f"{', ' + qty_delta_str if qty_delta_str else ''}"
            f", from {len(connector_breakdown)} source(s)"
            f", {unresolved_count} unresolved"
        )
        
        # Convert transactions to dicts
        tx_dicts = []
        for tx in group_txs:
            tx_dict = {
                "id": tx.id,
                "source": tx.source,
                "source_transaction_id": tx.source_transaction_id,
                "source_transaction_type": tx.source_transaction_type,
                "date_time": tx.date_time.isoformat() if tx.date_time else None,
                "source_asset_symbol": tx.source_asset_symbol,
                "source_price_quote_asset_symbol": tx.source_price_quote_asset_symbol,
                "quantity": float(tx.quantity) if tx.quantity else 0,
                "price": float(tx.price) if tx.price else None,
                "total": float(tx.total) if tx.total else None,
                "direction": tx.direction,
                "account_id": tx.account_id,
                "review_status": tx.review_status,
                "tags": tx.tags,
                "sync_connector_run_id": tx.sync_connector_run_id,
                "synced_at": tx.synced_at.isoformat() if tx.synced_at else None,
                "created_at": tx.created_at.isoformat() if tx.created_at else None,
                "dup_resolved": _transaction_has_resolution_tag(tx.tags, group_hash),
            }
            
            # Add connector info if available
            if tx.sync_connector_run_id:
                run = session.get(SyncJobConnectorRun, tx.sync_connector_run_id)
                if run:
                    tx_dict["connector_type"] = run.connector_type
                    tx_dict["run_id"] = run.id
                    tx_dict["account_name"] = run.account_name
            
            # Add resolution info if resolved
            if tx.tags:
                dup_resolution = None
                dup_resolved_at = None
                for tag in tx.tags:
                    if tag.get("sys_group") == group_hash:
                        pass
                    if tag.get("sys_resolution"):
                        dup_resolution = tag.get("sys_resolution")
                    if tag.get("sys_resolved_at"):
                        dup_resolved_at = tag.get("sys_resolved_at")
                
                if dup_resolution:
                    tx_dict["dup_resolution"] = dup_resolution
                if dup_resolved_at:
                    tx_dict["dup_resolved_at"] = dup_resolved_at
            
            tx_dicts.append(tx_dict)
        
        duplicate_groups.append(DuplicateGroup(
            group_hash=group_hash,
            transactions=tx_dicts,
            match_criteria_summary=match_criteria_summary,
            connector_breakdown=dict(connector_breakdown),
            match_type="fuzzy",
        ))
    
    if duplicate_groups:
        total_unresolved = sum(
            sum(1 for tx in g.transactions if not tx.get("dup_resolved", False))
            for g in duplicate_groups
        )
        log.debug(
            "Found fuzzy duplicate groups",
            groups=len(duplicate_groups),
            unresolved_transactions=total_unresolved,
        )
    
    return duplicate_groups


def detect_duplicate_suspicions(
    session: Session,
    account_id: Optional[int] = None,
    transaction_ids: Optional[List[int]] = None,
    config: Optional[Dict[str, Any]] = None,
    time_filter_cutoff: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    """
    Lightweight duplicate detection returning only group hashes and TX IDs.
    
    Used by the /duplicate-suspicions endpoint for the TransactionsTable map hook.
    Same detection logic as detect_duplicate_groups but returns minimal data.
    
    Returns:
        List of dicts: [{"group_hash": str, "transaction_ids": [int], "match_criteria": str}]
    """
    groups = detect_duplicate_groups(
        session=session,
        account_id=account_id,
        transaction_ids=transaction_ids,
        config=config,
        time_filter_cutoff=time_filter_cutoff,
    )
    
    return [
        {
            "group_hash": g.group_hash,
            "transaction_ids": [tx["id"] for tx in g.transactions],
            "match_criteria": g.match_criteria_summary,
        }
        for g in groups
    ]




def mark_duplicate_resolution(
    group_hash: str,
    kept_tx_ids: List[int],
    merged_tx_ids: List[int],
    dismissed_tx_ids: List[int],
    session: Session,
) -> None:
    """
    Mark duplicate resolution for transactions in a group.
    
    This implements incremental resolution:
    - Only updates resolution tags for transactions involved in the current action
    - Previously-resolved transactions keep their existing resolution state
    - This allows partial resolution of large groups over time
    
    Updates tags based on resolution action (combined into single tag dicts keyed by sys_group):
    - Kept: {"sys_group": "...", "sys_resolution": "kept", "sys_resolved_at": "..."}
    - Merged: {"sys_group": "...", "sys_resolution": "merged", "sys_kept_ids": "...", "sys_resolved_at": "..."}
    - Dismissed: {"sys_group": "...", "sys_resolution": "dismissed", "sys_resolved_at": "..."}
    
    Args:
        group_hash: Transaction hash for this duplicate group
        kept_tx_ids: Transaction IDs to keep
        merged_tx_ids: Transaction IDs to merge (mark as duplicates)
        dismissed_tx_ids: Transaction IDs to dismiss from group
        session: Database session
    """
    # Mark kept transactions
    resolved_at = datetime.now().isoformat()
    for tx_id in kept_tx_ids:
        tx = session.get(NormalizedTransaction, tx_id)
        if not tx:
            continue
        
        # Remove old resolution tags for this group (if any)
        tags = list(tx.tags or [])
        tags = [
            tag for tag in tags
            if not tag.get("sys_group") == group_hash
        ]
        
        # Add combined resolution tag
        tags.append({
            "sys_group": group_hash,
            "sys_resolution": "kept",
            "sys_resolved_at": resolved_at,
        })
        
        tx.tags = tags if tags else None
        flag_modified(tx, "tags")
        session.add(tx)
    
    # Mark merged transactions
    for tx_id in merged_tx_ids:
        tx = session.get(NormalizedTransaction, tx_id)
        if not tx:
            continue
        
        # Remove old resolution tags for this group (if any)
        tags = list(tx.tags or [])
        tags = [
            tag for tag in tags
            if not tag.get("sys_group") == group_hash
        ]
        
        # Add combined resolution tag
        tags.append({
            "sys_group": group_hash,
            "sys_resolution": "merged",
            "sys_kept_ids": ",".join(map(str, kept_tx_ids)),
            "sys_resolved_at": resolved_at,
        })
        
        tx.tags = tags if tags else None
        flag_modified(tx, "tags")
        session.add(tx)
    
    # Mark dismissed transactions
    for tx_id in dismissed_tx_ids:
        tx = session.get(NormalizedTransaction, tx_id)
        if not tx:
            continue
        
        # Remove old resolution tags for this group (if any)
        tags = list(tx.tags or [])
        tags = [
            tag for tag in tags
            if not tag.get("sys_group") == group_hash
        ]
        
        # Add combined resolution tag
        tags.append({
            "sys_group": group_hash,
            "sys_resolution": "dismissed",
            "sys_resolved_at": resolved_at,
        })
        
        tx.tags = tags if tags else None
        flag_modified(tx, "tags")
        session.add(tx)
    
    session.commit()
    
    # Gather additional info for comprehensive log
    all_tx_ids = kept_tx_ids + merged_tx_ids + dismissed_tx_ids
    if all_tx_ids:
        sample_tx = session.get(NormalizedTransaction, all_tx_ids[0])
        if sample_tx:
            # Get account name and connector type if available
            account_name = None
            connector_type = None
            if sample_tx.sync_connector_run_id:
                run = session.get(SyncJobConnectorRun, sample_tx.sync_connector_run_id)
                if run:
                    account_name = run.account_name
                    connector_type = run.connector_type
            
            account_info = account_name or sample_tx.account_id or 'manual'
            connector_info = connector_type or 'manual'
            
            # Use resolved asset symbols if available
            display_asset = sample_tx.asset.symbol if sample_tx.asset else sample_tx.source_asset_symbol
            display_quote = (sample_tx.price_quote_asset.symbol if sample_tx.price_quote_asset 
                           else sample_tx.source_price_quote_asset_symbol or 'N/A')
            
            log.info(
                "Resolved duplicate group",
                hash=group_hash,
                account=account_info,
                connector=connector_info,
                asset=display_asset,
                quote_asset=display_quote,
                qty=float(sample_tx.quantity),
                price=float(sample_tx.price) if sample_tx.price else None,
                direction=sample_tx.direction,
                kept=len(kept_tx_ids),
                merged=len(merged_tx_ids),
                dismissed=len(dismissed_tx_ids)
            )
        else:
            log.info(
                "Resolved duplicate group",
                hash=group_hash,
                kept=len(kept_tx_ids),
                merged=len(merged_tx_ids),
                dismissed=len(dismissed_tx_ids)
            )
    else:
        log.info(
            "Resolved duplicate group",
            hash=group_hash,
            kept=len(kept_tx_ids),
            merged=len(merged_tx_ids),
            dismissed=len(dismissed_tx_ids)
        )

