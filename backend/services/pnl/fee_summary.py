"""
Fee Summary by Period Service

Aggregates fee data from FeeEntry into periodic buckets for the Fee Analysis chart.
Supports grouping by period (daily/weekly/monthly) and breaking down by
asset, category, or account.

Used by:
  - GET /pnl/versions/{id}/fee-summary-by-period
  - FeeAnalysisChart component
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Dict, List, Optional, Tuple

from sqlalchemy import func, and_
from sqlmodel import Session, select

from backend.db.models import (
    Account,
    Asset,
    AssetCategory,
    CalculationUnit,
    CalculationUnitLeg,
    CalculationVersion,
    Category,
    FeeEntry,
    NormalizedTransaction,
)
from backend.config.loader import configure_logging

log = configure_logging("fee_summary")


# ---------------------------------------------------------------------------
# Data transfer objects
# ---------------------------------------------------------------------------

@dataclass
class FeeBreakdownItem:
    key: str  # asset symbol, account name, or category name
    key_id: int  # asset_id, account_id, or category_id
    fees_in_base: float


@dataclass
class FeePeriodBucket:
    period: str  # ISO date string for start of period
    total_fees_in_base: float
    count: int
    breakdown: List[FeeBreakdownItem] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _bucket_key(dt: datetime, granularity: str) -> str:
    """Return the period bucket key (ISO date string) for a datetime."""
    if granularity == "daily":
        return dt.strftime("%Y-%m-%d")
    elif granularity == "weekly":
        monday = dt - timedelta(days=dt.weekday())
        return monday.strftime("%Y-%m-%d")
    elif granularity == "monthly":
        return dt.strftime("%Y-%m-01")
    return dt.strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Main service function
# ---------------------------------------------------------------------------

def compute_fee_summary_by_period(
    session: Session,
    version_id: int,
    granularity: str = "monthly",
    group_by: str = "asset",  # "asset" | "account" | "category" | "none"
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    category_ids: Optional[List[int]] = None,
) -> List[FeePeriodBucket]:
    """
    Aggregate fees by time period with optional grouping.

    Args:
        session: DB session
        version_id: P&L calculation version ID
        granularity: 'daily', 'weekly', or 'monthly'
        group_by: How to break down within each period
        date_from / date_to: Date range filter
        asset_ids: Filter to specific assets
        account_ids: Filter to specific accounts
        category_ids: Filter to specific asset categories

    Returns:
        List of FeePeriodBucket sorted by period
    """
    # Verify version
    version = session.get(CalculationVersion, version_id)
    if not version:
        return []

    # Build query: FeeEntry → CalculationUnitLeg → NormalizedTransaction (for date)
    query = (
        select(
            FeeEntry.id,
            FeeEntry.fee_value_in_base,
            FeeEntry.related_asset_id,
            NormalizedTransaction.date_time,
            NormalizedTransaction.account_id,
        )
        .join(CalculationUnitLeg, FeeEntry.fee_leg_id == CalculationUnitLeg.id)
        .join(NormalizedTransaction, CalculationUnitLeg.transaction_id == NormalizedTransaction.id)
        .where(FeeEntry.version_id == version_id)
        .where(NormalizedTransaction.date_time.isnot(None))
    )

    if date_from:
        query = query.where(NormalizedTransaction.date_time >= date_from)
    if date_to:
        query = query.where(NormalizedTransaction.date_time <= date_to)
    if asset_ids:
        query = query.where(FeeEntry.related_asset_id.in_(asset_ids))
    if account_ids:
        query = query.where(NormalizedTransaction.account_id.in_(account_ids))

    # If filtering by category, resolve to asset_ids first
    effective_category_asset_ids = None
    if category_ids:
        cat_rows = session.exec(
            select(AssetCategory.asset_id)
            .where(AssetCategory.category_id.in_(category_ids))
        ).all()
        effective_category_asset_ids = list(set(cat_rows))
        if not effective_category_asset_ids:
            return []
        query = query.where(FeeEntry.related_asset_id.in_(effective_category_asset_ids))

    rows = session.exec(query.order_by(NormalizedTransaction.date_time)).all()

    if not rows:
        return []

    # Collect all IDs we'll need to resolve for labels
    all_asset_ids = set()
    all_account_ids = set()
    for r in rows:
        if r.related_asset_id:
            all_asset_ids.add(r.related_asset_id)
        if r.account_id:
            all_account_ids.add(r.account_id)

    # Resolve labels
    asset_symbols = {}
    if all_asset_ids:
        assets = session.exec(select(Asset).where(Asset.asset_id.in_(list(all_asset_ids)))).all()
        asset_symbols = {a.asset_id: a.symbol for a in assets}

    account_names = {}
    if all_account_ids and group_by == "account":
        accounts = session.exec(select(Account).where(Account.id.in_(list(all_account_ids)))).all()
        account_names = {a.id: a.name for a in accounts}

    # If grouping by category, build asset_id → category_name mapping
    asset_category_map: Dict[int, Tuple[int, str]] = {}
    if group_by == "category" and all_asset_ids:
        cat_rows = session.exec(
            select(AssetCategory.asset_id, Category.id, Category.label)
            .join(Category, AssetCategory.category_id == Category.id)
            .where(AssetCategory.asset_id.in_(list(all_asset_ids)))
        ).all()
        for ac in cat_rows:
            asset_category_map[ac.asset_id] = (ac.id, ac.label)

    # Build period buckets
    # Structure: { period_str: { group_key: (key_id, total_fees, count) } }
    buckets: Dict[str, Dict[str, List]] = defaultdict(lambda: defaultdict(lambda: [0, 0.0, 0]))

    for r in rows:
        period = _bucket_key(r.date_time, granularity)
        fee_val = float(r.fee_value_in_base) if r.fee_value_in_base else 0.0

        if group_by == "asset":
            key = asset_symbols.get(r.related_asset_id, f"#{r.related_asset_id}") if r.related_asset_id else "Unknown"
            key_id = r.related_asset_id or 0
        elif group_by == "account":
            key = account_names.get(r.account_id, f"Account #{r.account_id}") if r.account_id else "Unknown"
            key_id = r.account_id or 0
        elif group_by == "category":
            if r.related_asset_id and r.related_asset_id in asset_category_map:
                key_id, key = asset_category_map[r.related_asset_id]
            else:
                key = "Uncategorized"
                key_id = 0
        else:
            key = "Total"
            key_id = 0

        entry = buckets[period][key]
        entry[0] = key_id
        entry[1] += fee_val
        entry[2] += 1

    # Assemble result
    result: List[FeePeriodBucket] = []
    for period in sorted(buckets.keys()):
        groups = buckets[period]
        total_fees = sum(v[1] for v in groups.values())
        total_count = sum(v[2] for v in groups.values())

        breakdown = [
            FeeBreakdownItem(
                key=group_key,
                key_id=vals[0],
                fees_in_base=round(vals[1], 2),
            )
            for group_key, vals in sorted(groups.items(), key=lambda x: -x[1][1])
        ]

        result.append(FeePeriodBucket(
            period=period,
            total_fees_in_base=round(total_fees, 2),
            count=total_count,
            breakdown=breakdown,
        ))

    log.info(
        "fee_summary_computed",
        version_id=version_id,
        periods=len(result),
        granularity=granularity,
        group_by=group_by,
    )

    return result
