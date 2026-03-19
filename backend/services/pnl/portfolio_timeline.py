"""
Portfolio Timeline Service

Reconstructs historical portfolio value from CostLotEvent balance snapshots
and PriceSnapshot data. Used by:
  - GET /pnl/versions/{id}/portfolio-timeline

Strategy:
  For each date bucket (daily/weekly/monthly):
  1. Find the latest CostLotEvent.balance_after per (asset) as of that date
  2. Find the closest PriceSnapshot.price per asset at that date
  3. Multiply qty × price → per-asset value
  4. Sum cost basis from active CostLot records
  5. Compute cumulative realized P&L from RealizedPnl records
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from sqlalchemy import func
from sqlmodel import Session, select

from backend.db.models import (
    AssetCategory,
    CalculationUnit,
    CalculationVersion,
    CostLot,
    CostLotEvent,
)
from backend.config.loader import configure_logging
from backend.services.pnl.metrics_service import (
    _ensure_naive,
    _get_current_from_cost_lots,
    _get_balance_snapshots_at_dates,
    _get_cost_basis_snapshots_at_dates,
    _get_price_at_dates,
    _get_cumulative_realized_pnl,
    _get_asset_symbols,
    _get_asset_labels,
)

log = configure_logging("portfolio_timeline")


# ---------------------------------------------------------------------------
# Data transfer objects
# ---------------------------------------------------------------------------

@dataclass
class BreakdownItem:
    asset_id: int
    symbol: str
    label: Optional[str]
    value_in_base: float
    qty: float
    cost_basis_in_base: float
    realized_pnl_to_date: float


@dataclass
class TimelinePoint:
    date: str  # ISO date string
    total_value_in_base: float
    cost_basis_in_base: float
    unrealized_pnl: float
    cumulative_realized_pnl: float
    breakdown: List[BreakdownItem] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Granularity helpers
# ---------------------------------------------------------------------------

def _generate_date_buckets(
    start_date: datetime,
    end_date: datetime,
    granularity: str,
) -> List[datetime]:
    """Generate bucket boundary dates for the given granularity."""
    buckets: List[datetime] = []
    current = _truncate_date(start_date, granularity)

    while current <= end_date:
        buckets.append(current)
        current = _next_bucket(current, granularity)

    # Always include the end date if the last bucket is before it
    if buckets and buckets[-1] < end_date:
        buckets.append(end_date)

    return buckets


def _truncate_date(dt: datetime, granularity: str) -> datetime:
    """Truncate a datetime to the start of its granularity bucket."""
    if granularity == "daily":
        return dt.replace(hour=0, minute=0, second=0, microsecond=0)
    elif granularity == "weekly":
        # Monday of the week
        weekday = dt.weekday()
        monday = dt - timedelta(days=weekday)
        return monday.replace(hour=0, minute=0, second=0, microsecond=0)
    elif granularity == "monthly":
        return dt.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return dt


def _next_bucket(dt: datetime, granularity: str) -> datetime:
    """Move to the next bucket start."""
    if granularity == "daily":
        return dt + timedelta(days=1)
    elif granularity == "weekly":
        return dt + timedelta(weeks=1)
    elif granularity == "monthly":
        if dt.month == 12:
            return dt.replace(year=dt.year + 1, month=1)
        return dt.replace(month=dt.month + 1)
    return dt + timedelta(days=1)



# ---------------------------------------------------------------------------
# Main service function
# ---------------------------------------------------------------------------

def compute_portfolio_timeline(
    session: Session,
    version_id: int,
    granularity: str = "daily",
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    category_ids: Optional[List[int]] = None,
    include_unsettled_negative: bool = False,
) -> List[TimelinePoint]:
    """
    Compute portfolio value timeline for a calculation version.

    Args:
        session: DB session
        version_id: P&L calculation version ID
        granularity: 'daily', 'weekly', or 'monthly'
        date_from: Start date filter
        date_to: End date filter
        asset_ids: Filter to specific assets
        account_ids: Filter to specific accounts
        category_ids: Filter to specific asset categories

    Returns:
        List of TimelinePoint with per-asset breakdown
    """
    # Verify version exists
    version = session.get(CalculationVersion, version_id)
    if not version:
        return []

    # If filtering by category, resolve to asset_ids
    if category_ids:
        cat_asset_rows = session.exec(
            select(AssetCategory.asset_id)
            .where(AssetCategory.category_id.in_(category_ids))
        ).all()
        cat_asset_ids = list(set(cat_asset_rows))
        if asset_ids:
            asset_ids = list(set(asset_ids) & set(cat_asset_ids))
        else:
            asset_ids = cat_asset_ids
        if not asset_ids:
            return []

    # Determine date range from events
    range_query = (
        select(
            func.min(CostLotEvent.timestamp),
            func.max(CostLotEvent.timestamp),
        )
        .join(CostLot, CostLotEvent.lot_id == CostLot.cost_lot_id)
        .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
    )
    date_range = session.exec(range_query).one()
    min_date, max_date = date_range

    if not min_date or not max_date:
        return []

    # Apply date filters
    start = date_from if date_from else min_date
    end = date_to if date_to else max_date

    # Ensure timezone awareness
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)

    # Generate date buckets
    buckets = _generate_date_buckets(start, end, granularity)
    if not buckets:
        return []

    log.info(
        "computing_portfolio_timeline",
        version_id=version_id,
        granularity=granularity,
        buckets=len(buckets),
        date_range=f"{start.date()} to {end.date()}",
    )

    # 1. Get balance snapshots per date
    balance_snapshots = _get_balance_snapshots_at_dates(
        session, version_id, buckets, asset_ids, account_ids,
        include_unsettled_negative=include_unsettled_negative,
    )

    # 2. Get cost basis snapshots per date
    cost_basis_snapshots = _get_cost_basis_snapshots_at_dates(
        session, version_id, buckets, asset_ids, account_ids,
        include_unsettled_negative=include_unsettled_negative,
    )

    # Override the last bucket with authoritative CostLot data (same source
    # as the /balances endpoint) so the latest point matches the UI.
    if buckets:
        last_ds = buckets[-1].strftime("%Y-%m-%d")
        lot_balances, lot_costs = _get_current_from_cost_lots(
            session, version_id, asset_ids, account_ids,
            include_unsettled_negative=include_unsettled_negative,
        )
        balance_snapshots[last_ds] = lot_balances
        cost_basis_snapshots[last_ds] = lot_costs

    # Collect all asset IDs that appear in any bucket
    all_asset_ids: set = set()
    for balances in balance_snapshots.values():
        all_asset_ids.update(balances.keys())
    all_asset_ids_list = list(all_asset_ids)

    # 3. Get prices for those assets at each date
    price_snapshots = _get_price_at_dates(
        session, version.base_currency_id, all_asset_ids_list, buckets
    )

    # 4. Get cumulative realized P&L
    cumulative_rpnl = _get_cumulative_realized_pnl(
        session, version_id, buckets, asset_ids, account_ids
    )

    # 5. Get asset symbols and labels
    asset_symbols = _get_asset_symbols(session, all_asset_ids_list)
    asset_labels = _get_asset_labels(session, all_asset_ids_list)

    # 6. Assemble timeline points
    timeline: List[TimelinePoint] = []

    for bucket_date in buckets:
        date_str = bucket_date.strftime("%Y-%m-%d")
        balances = balance_snapshots.get(date_str, {})
        costs = cost_basis_snapshots.get(date_str, {})
        prices = price_snapshots.get(date_str, {})
        rpnl_total, rpnl_by_asset = cumulative_rpnl.get(date_str, (0.0, {}))

        total_value = 0.0
        total_cost_basis = 0.0
        breakdown: List[BreakdownItem] = []

        for asset_id in sorted(all_asset_ids):
            qty = balances.get(asset_id, 0.0)
            price = prices.get(asset_id, 0.0)
            cost = costs.get(asset_id, 0.0)
            asset_value = qty * price

            # Skip zero-balance / zero-value assets
            if abs(qty) < 1e-12 and abs(cost) < 1e-12:
                continue

            total_value += asset_value
            total_cost_basis += cost

            breakdown.append(BreakdownItem(
                asset_id=asset_id,
                symbol=asset_symbols.get(asset_id, f"#{asset_id}"),
                label=asset_labels.get(asset_id),
                value_in_base=round(asset_value, 2),
                qty=round(qty, 8),
                cost_basis_in_base=round(cost, 2),
                realized_pnl_to_date=round(rpnl_by_asset.get(asset_id, 0.0), 2),
            ))

        unrealized = total_value - total_cost_basis

        timeline.append(TimelinePoint(
            date=date_str,
            total_value_in_base=round(total_value, 2),
            cost_basis_in_base=round(total_cost_basis, 2),
            unrealized_pnl=round(unrealized, 2),
            cumulative_realized_pnl=round(rpnl_total, 2),
            breakdown=breakdown,
        ))

    log.info(
        "portfolio_timeline_computed",
        version_id=version_id,
        points=len(timeline),
    )

    return timeline
