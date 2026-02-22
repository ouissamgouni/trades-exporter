"""
Duplicate Detection Service

Detects potential duplicate transactions across different sources and sync runs.
Uses configurable time window and amount tolerance for matching.
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
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict for API responses."""
        return {
            "group_hash": self.group_hash,
            "transactions": self.transactions,
            "match_criteria_summary": self.match_criteria_summary,
            "connector_breakdown": self.connector_breakdown,
            "detected_at": self.detected_at.isoformat() if self.detected_at else None,
            "transaction_count": len(self.transactions),
        }


def get_duplicate_detection_config() -> Dict[str, Any]:
    """Load duplicate detection configuration from settings."""
    settings = load_settings()
    return settings.get("duplicate_detection", {
        "enabled": True,
        "time_window_seconds": 30,
        "amount_tolerance_percent": 1.0,
        "post_persist": True,
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
    Compute transaction hash for duplicate detection.
    
    Uses normalized trade content to group potential duplicates:
    - Account ID
    - Datetime truncated to seconds
    - Asset symbols (resolved from Asset table if asset_id available, else from source)
    - Direction (inflow/outflow)
    - Quantity and price (8 decimal precision)
    
    Args:
        account_id: Account ID
        datetime_obj: Transaction datetime
        source_asset_symbol: Base asset symbol (fallback if asset_id not available)
        source_price_quote_asset_symbol: Quote asset symbol (fallback if price_quote_asset_id not available)
        direction: Transaction direction (inflow/outflow)
        quantity: Transaction quantity
        price: Transaction price
        session: Database session (optional, for resolving asset IDs)
        asset_id: Asset ID to resolve from Asset table (optional)
        price_quote_asset_id: Quote asset ID to resolve from Asset table (optional)
    
    Returns:
        MD5 hash string (32 hex characters)
    """
    from backend.db.models import Asset
    
    # Truncate datetime to seconds for consistency
    dt_str = datetime_obj.strftime("%Y-%m-%dT%H:%M:%S") if datetime_obj else ""
    
    # Resolve asset symbols from Asset table if IDs provided and session available
    base_symbol = source_asset_symbol
    quote_symbol = source_price_quote_asset_symbol
    
    if session is not None:
        # Resolve base asset
        if asset_id is not None:
            asset = session.get(Asset, asset_id)
            if asset and asset.symbol:
                base_symbol = asset.symbol
        
        # Resolve quote asset
        if price_quote_asset_id is not None:
            quote_asset = session.get(Asset, price_quote_asset_id)
            if quote_asset and quote_asset.symbol:
                quote_symbol = quote_asset.symbol
    
    # Normalize symbols to uppercase
    base_normalized = base_symbol.upper() if base_symbol else ""
    quote_normalized = quote_symbol.upper() if quote_symbol else ""
    direction_normalized = direction.lower() if direction else ""
    
    # Format numbers with fixed precision (8 decimals)
    qty_decimal = Decimal(str(quantity)).quantize(Decimal("0.00000001"), rounding=ROUND_DOWN)
    price_decimal = Decimal(str(price or 0)).quantize(Decimal("0.00000001"), rounding=ROUND_DOWN)
    
    # Build unique string
    unique_str = f"{account_id}_{dt_str}_{base_normalized}_{quote_normalized}_{direction_normalized}_{qty_decimal}_{price_decimal}"
    
    # Generate MD5 hash
    return hashlib.md5(unique_str.encode()).hexdigest()


def _transaction_has_resolution_tag(tags: Optional[List[Dict[str, str]]], group_hash: str) -> bool:
    """Check if transaction has been resolved for this group hash."""
    if not tags:
        return False
    # Check for sys_group key
    return any(
        tag.get("sys_group") == group_hash
        for tag in tags
    )


def _filter_same_run_different_id_transactions(transactions: List[NormalizedTransaction]) -> List[NormalizedTransaction]:
    """
    Filter out transactions that come from the same connector run but have different source_transaction_id.
    
    If transactions share the same sync_connector_run_id but have different source_transaction_id values,
    they are genuinely different transactions from the source system and should not be considered duplicates.
    
    Args:
        transactions: List of transactions with the same hash
    
    Returns:
        Filtered list of transactions that should actually be considered as duplicates.
        Returns empty list if all transactions are from same run with different IDs.
    """
    # Group transactions by connector_run_id
    from collections import defaultdict
    by_run: Dict[Optional[int], List[NormalizedTransaction]] = defaultdict(list)
    
    for tx in transactions:
        by_run[tx.sync_connector_run_id].append(tx)
    
    # Check each run group
    valid_duplicates = []
    for run_id, run_txs in by_run.items():
        if run_id is None:
            # Manual transactions or legacy data without run tracking - keep all
            valid_duplicates.extend(run_txs)
            continue
        
        # Check if all transactions in this run have different source_transaction_id
        source_ids = [tx.source_transaction_id for tx in run_txs if tx.source_transaction_id]
        
        if len(source_ids) == len(set(source_ids)):
            # All different IDs - these are not duplicates, exclude them
            log.debug(
                "Excluding transactions from same run with different source IDs",
                run_id=run_id,
                count=len(run_txs),
                source_ids=source_ids[:5]  # Log first 5 for debugging
            )
            continue
        
        # Some transactions have same ID or no ID - keep for duplicate detection
        valid_duplicates.extend(run_txs)
    
    return valid_duplicates


def detect_duplicate_groups(
    session: Session,
    account_id: Optional[int] = None,
    transaction_ids: Optional[List[int]] = None,
    config: Optional[Dict[str, Any]] = None,
    time_filter_cutoff: Optional[datetime] = None,
) -> List[DuplicateGroup]:
    """
    Detect duplicate transaction groups by querying transaction_hash column.
    
    This is a view-time detection that queries for transaction_hash values 
    that appear more than once in the database. Excludes transactions marked 
    as "invalid" (review_status="invalid").
    
    Args:
        session: Database session
        account_id: Optional account ID to filter by
        transaction_ids: Optional list of transaction IDs to filter by  
        config: Configuration dict (uses default if not provided)
        time_filter_cutoff: Optional datetime cutoff for created_at filter (performance optimization)
    
    Returns:
        List of DuplicateGroup objects containing grouped duplicates.
        Groups are filtered to only include those with unresolved transactions.
    """
    if config is None:
        config = get_duplicate_detection_config()
    
    if not config.get("enabled", True):
        return []
    
    # Query for transaction_hash values that appear more than once
    from sqlalchemy import func
    from sqlalchemy.orm import selectinload
    
    # Build base query for duplicate hashes
    hash_query = (
        select(
            NormalizedTransaction.transaction_hash,
            func.count(NormalizedTransaction.id).label("count")
        )
        .where(NormalizedTransaction.transaction_hash.isnot(None))
        .where(NormalizedTransaction.review_status != "invalid")
        .group_by(NormalizedTransaction.transaction_hash)
        .having(func.count(NormalizedTransaction.id) > 1)
    )
    
    # Apply filters if provided
    if account_id is not None:
        hash_query = hash_query.where(NormalizedTransaction.account_id == account_id)
    
    if transaction_ids:
        hash_query = hash_query.where(NormalizedTransaction.id.in_(transaction_ids))
    
    # Apply time filter at query level for performance
    if time_filter_cutoff is not None:
        hash_query = hash_query.where(NormalizedTransaction.created_at >= time_filter_cutoff)
    
    # Execute query to get duplicate hashes
    duplicate_hashes = session.exec(hash_query).all()
    
    if not duplicate_hashes:
        log.debug("No duplicate hashes found")
        return []
    
    # For each duplicate hash, fetch all transactions
    duplicate_groups = []
    hash_details = []  # Track details for final log
    
    for hash_row in duplicate_hashes:
        tx_hash = hash_row[0]  # transaction_hash value
        
        # Fetch all transactions with this hash (eager load asset relationships)
        tx_query = select(NormalizedTransaction).where(
            and_(
                NormalizedTransaction.transaction_hash == tx_hash,
                NormalizedTransaction.review_status != "invalid"
            )
        ).options(
            selectinload(NormalizedTransaction.asset),
            selectinload(NormalizedTransaction.price_quote_asset),
            selectinload(NormalizedTransaction.fee_quote_asset)
        )
        
        # Apply account filter if specified
        if account_id is not None:
            tx_query = tx_query.where(NormalizedTransaction.account_id == account_id)
        
        all_txs = session.exec(tx_query).all()
        
        if len(all_txs) < 2:
            continue  # Skip if less than 2 transactions (shouldn't happen but safety check)
        
        # Filter out transactions from same run with different source IDs
        all_txs = _filter_same_run_different_id_transactions(all_txs)
        
        if len(all_txs) < 2:
            # After filtering, not enough transactions to be duplicates
            continue
        
        # Check if all transactions are resolved
        unresolved_count = sum(
            1 for tx in all_txs 
            if not _transaction_has_resolution_tag(tx.tags, tx_hash)
        )
        
        # Skip this group if all transactions are resolved
        if unresolved_count == 0:
            account_ids = list(set(tx.account_id for tx in all_txs if tx.account_id))
            runner_ids = list(set(tx.sync_connector_run_id for tx in all_txs if tx.sync_connector_run_id))
            
            # Gather account names and connector types
            account_names = []
            connector_types = set()
            for tx in all_txs:
                if tx.sync_connector_run_id:
                    run = session.get(SyncJobConnectorRun, tx.sync_connector_run_id)
                    if run:
                        if run.account_name:
                            account_names.append(run.account_name)
                        connector_types.add(run.connector_type)
            account_names = list(set(account_names))
            
            first_tx = all_txs[0]
            
            # Use resolved asset symbols if available
            display_asset = first_tx.asset.symbol if first_tx.asset else first_tx.source_asset_symbol
            display_quote = (first_tx.price_quote_asset.symbol if first_tx.price_quote_asset 
                           else first_tx.source_price_quote_asset_symbol or 'N/A')
            
            log.debug(
                "Skipping fully resolved duplicate group",
                hash=tx_hash[:8],
                txs=len(all_txs),
                accounts=account_names or account_ids,
                connectors=list(connector_types) or ['manual'],
                asset=display_asset,
                quote_asset=display_quote,
                qty=float(first_tx.quantity),
                price=float(first_tx.price) if first_tx.price else None,
                direction=first_tx.direction,
                datetime=first_tx.date_time.strftime('%Y-%m-%d %H:%M:%S') if first_tx.date_time else 'N/A'
            )
            continue
        
        # Build connector breakdown
        connector_breakdown: Dict[str, List[int]] = defaultdict(list)
        for tx in all_txs:
            if tx.sync_connector_run_id:
                run = session.get(SyncJobConnectorRun, tx.sync_connector_run_id)
                if run:
                    key = f"{run.connector_type}|run_{run.id}"
                else:
                    key = f"{tx.source}|unknown_run"
            else:
                key = "manual"
            connector_breakdown[key].append(tx.id)
        
        # Build match criteria summary with resolved asset symbols
        first_tx = all_txs[0]
        
        # Use resolved asset symbol if available, otherwise use source symbol
        base_symbol = first_tx.asset.symbol if first_tx.asset else first_tx.source_asset_symbol
        base_indicator = "resolved" if first_tx.asset else "raw"
        
        quote_symbol = (first_tx.price_quote_asset.symbol if first_tx.price_quote_asset 
                       else first_tx.source_price_quote_asset_symbol or 'N/A')
        quote_indicator = "resolved" if first_tx.price_quote_asset else "raw"
        
        match_criteria_summary = (
            f"{base_symbol} ({base_indicator})/{quote_symbol} ({quote_indicator}) "
            f"{first_tx.direction} at {first_tx.date_time.strftime('%Y-%m-%d %H:%M:%S') if first_tx.date_time else 'unknown time'}, "
            f"qty {min(float(t.quantity) for t in all_txs):.8f}-{max(float(t.quantity) for t in all_txs):.8f}, "
            f"from {len(connector_breakdown)} source(s), "
            f"{unresolved_count} unresolved"
        )
        
        # Convert transactions to dicts
        tx_dicts = []
        for tx in all_txs:
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
                "dup_resolved": _transaction_has_resolution_tag(tx.tags, tx_hash),
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
                    if tag.get("sys_group") == tx_hash:
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
            group_hash=tx_hash,
            transactions=tx_dicts,
            match_criteria_summary=match_criteria_summary,
            connector_breakdown=dict(connector_breakdown),
        ))
        
        # Track details for final log
        account_ids = list(set(tx.account_id for tx in all_txs if tx.account_id))
        runner_keys = list(connector_breakdown.keys())
        
        # Gather account names and connector types
        account_names = []
        connector_types = set()
        for tx in all_txs:
            if tx.sync_connector_run_id:
                run = session.get(SyncJobConnectorRun, tx.sync_connector_run_id)
                if run:
                    if run.account_name:
                        account_names.append(run.account_name)
                    connector_types.add(run.connector_type)
        account_names = list(set(account_names))
        
        # Use resolved asset symbols if available for display
        display_asset = first_tx.asset.symbol if first_tx.asset else first_tx.source_asset_symbol
        display_quote = (first_tx.price_quote_asset.symbol if first_tx.price_quote_asset 
                       else first_tx.source_price_quote_asset_symbol or 'N/A')
        
        hash_details.append({
            "hash": tx_hash[:8],
            "txs": len(all_txs),
            "unresolved": unresolved_count,
            "accounts": account_names or account_ids,
            "connectors": list(connector_types) or ['manual'],
            "runners": runner_keys,
            "asset": display_asset,
            "quote_asset": display_quote,
            "qty": float(first_tx.quantity),
            "price": float(first_tx.price) if first_tx.price else None,
            "datetime": first_tx.date_time.strftime('%Y-%m-%d %H:%M:%S') if first_tx.date_time else 'N/A',
            "direction": first_tx.direction,
        })
    
    # Build comprehensive debug log with all details
    if duplicate_groups:
        # Summary log
        total_unresolved_txs = sum(h["unresolved"] for h in hash_details)
        all_accounts = list(set(acc for h in hash_details for acc in h["accounts"]))
        
        log_context = {
            "duplicate_groups": len(duplicate_groups),
            "unresolved_transactions": total_unresolved_txs,
            "accounts_count": len(all_accounts),
            "accounts": all_accounts,
        }
        if account_id is not None:
            log_context["filter_account_id"] = account_id
        if time_filter_cutoff is not None:
            log_context["filter_time_cutoff"] = time_filter_cutoff.strftime('%Y-%m-%d')
        if transaction_ids:
            log_context["filter_tx_ids_count"] = len(transaction_ids)
        
        log.debug("Found duplicate groups with unresolved transactions", **log_context)
        
        # Detail logs for each hash
        for detail in hash_details:
            log.debug(
                "Duplicate group detail",
                hash=detail['hash'],
                txs=detail['txs'],
                unresolved=detail['unresolved'],
                accounts=detail['accounts'],
                connectors=detail['connectors'],
                asset=detail['asset'],
                quote_asset=detail['quote_asset'],
                qty=detail['qty'],
                price=detail['price'],
                direction=detail['direction'],
                datetime=detail['datetime']
            )
    
    return duplicate_groups




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
    
    Updates tags based on resolution action:
    - Kept: {"sys_resolution": "kept"}, {"sys_group": "..."}, {"sys_resolved_at": "..."}
    - Merged: {"sys_resolution": "merged"}, {"sys_group": "..."}, {"sys_kept_ids": "..."}, {"sys_resolved_at": "..."}
    - Dismissed: {"sys_resolution": "dismissed"}, {"sys_group": "..."}, {"sys_resolved_at": "..."}
    
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
        
        # Add new resolution tags (separate key:value pairs)
        tags.extend([
            {"sys_resolution": "kept"},
            {"sys_group": group_hash},
            {"sys_resolved_at": resolved_at},
        ])
        
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
        
        # Add new resolution tags (separate key:value pairs)
        tags.extend([
            {"sys_resolution": "merged"},
            {"sys_group": group_hash},
            {"sys_kept_ids": ",".join(map(str, kept_tx_ids))},
            {"sys_resolved_at": resolved_at},
        ])
        
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
        
        # Add new resolution tags (separate key:value pairs)
        tags.extend([
            {"sys_resolution": "dismissed"},
            {"sys_group": group_hash},
            {"sys_resolved_at": resolved_at},
        ])
        
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

