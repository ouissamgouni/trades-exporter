"""
Portfolio Timeline Service

Reconstructs historical portfolio value from CostLotEvent balance snapshots
and PriceSnapshot data. Used by:
  - GET /pnl/versions/{id}/portfolio-timeline
  - Total Return Scorecard
  - Portfolio Over Time chart
  - Investment vs Return chart

Strategy:
  For each date bucket (daily/weekly/monthly):
  1. Find the latest CostLotEvent.balance_after per (asset) as of that date
  2. Find the closest PriceSnapshot.price per asset at that date
  3. Multiply qty × price → per-asset value
  4. Sum cost basis from active CostLot records
  5. Compute cumulative realized P&L from RealizedPnl records
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Dict, List, Optional, Tuple

from sqlalchemy import func, and_, text
from sqlmodel import Session, select

from backend.db.models import (
    Asset,
    AssetCategory,
    CalculationUnit,
    CalculationVersion,
    CostLot,
    CostLotEvent,
    PriceSnapshot,
    RealizedPnl,
)
from backend.config.loader import configure_logging

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


def _ensure_naive(dt: datetime) -> datetime:
    """Strip timezone info so comparisons with DB-naive timestamps work."""
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


# ---------------------------------------------------------------------------
# Core query functions
# ---------------------------------------------------------------------------

def _get_balance_snapshots_at_dates(
    session: Session,
    version_id: int,
    bucket_dates: List[datetime],
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
) -> Dict[str, Dict[int, float]]:
    """
    For each date bucket, get the latest asset-level balance from CostLotEvents.

    Returns: { date_str: { asset_id: qty } }
    """
    if not bucket_dates:
        return {}

    # Get all cost lot events for this version, ordered by timestamp
    # CostLotEvent links to CostLot → CalculationUnit → CalculationVersion
    events_query = (
        select(
            CostLotEvent.timestamp,
            CostLot.asset_id,
            CostLotEvent.balance_after,
        )
        .join(CostLot, CostLotEvent.lot_id == CostLot.cost_lot_id)
        .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
        .where(CostLotEvent.balance_after.isnot(None))
        .order_by(CostLotEvent.timestamp, CostLotEvent.sequence_num)
    )

    if asset_ids:
        events_query = events_query.where(CostLot.asset_id.in_(asset_ids))

    if account_ids:
        events_query = events_query.where(CostLot.account_id.in_(account_ids))

    events = session.exec(events_query).all()

    if not events:
        return {}

    # Build a chronological list of (timestamp, asset_id, balance_after)
    # We'll scan through events and for each bucket, snapshot the latest balance
    events_list = [(_ensure_naive(e.timestamp), e.asset_id, float(e.balance_after)) for e in events]

    result: Dict[str, Dict[int, float]] = {}
    event_idx = 0
    # Running balance per asset (updated as we scan events)
    current_balances: Dict[int, float] = {}

    for bucket_date in bucket_dates:
        bd = _ensure_naive(bucket_date)
        # Advance through events up to this bucket date
        while event_idx < len(events_list) and events_list[event_idx][0] <= bd:
            _, asset_id, balance = events_list[event_idx]
            current_balances[asset_id] = balance
            event_idx += 1

        date_str = bucket_date.strftime("%Y-%m-%d")
        # Snapshot current balances (copy)
        result[date_str] = dict(current_balances)

    return result


def _get_cost_basis_snapshots_at_dates(
    session: Session,
    version_id: int,
    bucket_dates: List[datetime],
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
) -> Dict[str, Dict[int, float]]:
    """
    For each date bucket, compute cost basis per asset from CostLotEvents.

    Uses cost_basis_remaining_after from events to track running cost basis.
    Falls back to computing from qty_remaining * unit_cost if not available.

    Returns: { date_str: { asset_id: cost_basis } }
    """
    if not bucket_dates:
        return {}

    # Query cost lot events with cost basis info
    events_query = (
        select(
            CostLotEvent.timestamp,
            CostLot.asset_id,
            CostLot.unit_cost_in_base,
            CostLotEvent.qty_remaining_after,
            CostLotEvent.cost_basis_remaining_after,
        )
        .join(CostLot, CostLotEvent.lot_id == CostLot.cost_lot_id)
        .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
        .order_by(CostLotEvent.timestamp, CostLotEvent.sequence_num)
    )

    if asset_ids:
        events_query = events_query.where(CostLot.asset_id.in_(asset_ids))
    if account_ids:
        events_query = events_query.where(CostLot.account_id.in_(account_ids))

    events = session.exec(events_query).all()
    if not events:
        return {}

    # Track cost basis per (asset_id, lot_id equivalent = per event's lot)
    # For simplicity, we aggregate per asset using qty_remaining * unit_cost
    events_list = [
        (
            e.timestamp,
            e.asset_id,
            float(e.cost_basis_remaining_after) if e.cost_basis_remaining_after is not None
            else float(e.qty_remaining_after) * float(e.unit_cost_in_base),
        )
        for e in events
    ]

    # We need per-lot cost basis tracking, but balance_after is asset-level.
    # Simpler approach: at each bucket, query total cost basis from cost lots
    # that existed by that date.
    # Actually, let's use the same event-scanning approach but track per-lot.
    
    # Build per-lot cost basis from events
    lot_cost_events = (
        select(
            CostLotEvent.timestamp,
            CostLotEvent.lot_id,
            CostLot.asset_id,
            CostLotEvent.qty_remaining_after,
            CostLot.unit_cost_in_base,
        )
        .join(CostLot, CostLotEvent.lot_id == CostLot.cost_lot_id)
        .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
        .order_by(CostLotEvent.timestamp, CostLotEvent.sequence_num)
    )

    if asset_ids:
        lot_cost_events = lot_cost_events.where(CostLot.asset_id.in_(asset_ids))
    if account_ids:
        lot_cost_events = lot_cost_events.where(CostLot.account_id.in_(account_ids))

    lot_events = session.exec(lot_cost_events).all()
    if not lot_events:
        return {}

    lot_events_list = [
        (_ensure_naive(e.timestamp), e.lot_id, e.asset_id, float(e.qty_remaining_after), float(e.unit_cost_in_base))
        for e in lot_events
    ]

    result: Dict[str, Dict[int, float]] = {}
    event_idx = 0
    # Per-lot: (asset_id, qty_remaining * unit_cost)
    lot_state: Dict[int, Tuple[int, float]] = {}  # lot_id -> (asset_id, cost_basis)

    for bucket_date in bucket_dates:
        bd = _ensure_naive(bucket_date)
        while event_idx < len(lot_events_list) and lot_events_list[event_idx][0] <= bd:
            _, lot_id, asset_id, qty_remaining, unit_cost = lot_events_list[event_idx]
            lot_state[lot_id] = (asset_id, qty_remaining * unit_cost)
            event_idx += 1

        date_str = bucket_date.strftime("%Y-%m-%d")
        # Aggregate cost basis per asset
        asset_cost: Dict[int, float] = defaultdict(float)
        for lot_id, (asset_id, cost) in lot_state.items():
            asset_cost[asset_id] += cost
        result[date_str] = dict(asset_cost)

    return result


def _get_price_at_dates(
    session: Session,
    base_currency_id: Optional[int],
    asset_ids: List[int],
    bucket_dates: List[datetime],
) -> Dict[str, Dict[int, float]]:
    """
    For each date bucket and asset, get the closest price snapshot.

    Returns: { date_str: { asset_id: price } }
    """
    if not asset_ids or not bucket_dates:
        return {}

    # Fetch all relevant price snapshots ordered by time
    price_query = (
        select(PriceSnapshot.asset_id, PriceSnapshot.price, PriceSnapshot.snapshot_time)
        .where(PriceSnapshot.asset_id.in_(asset_ids))
        .order_by(PriceSnapshot.snapshot_time)
    )

    # If we have a base currency, filter for prices quoted in that currency
    if base_currency_id:
        price_query = price_query.where(PriceSnapshot.quote_asset_id == base_currency_id)

    price_rows = session.exec(price_query).all()

    if not price_rows:
        return {}

    # Build price timeline per asset
    asset_prices: Dict[int, List[Tuple[datetime, float]]] = defaultdict(list)
    for row in price_rows:
        asset_prices[row.asset_id].append((row.snapshot_time, float(row.price)))

    result: Dict[str, Dict[int, float]] = {}
    for bucket_date in bucket_dates:
        bd = _ensure_naive(bucket_date)
        date_str = bucket_date.strftime("%Y-%m-%d")
        prices: Dict[int, float] = {}

        for asset_id in asset_ids:
            price_list = asset_prices.get(asset_id, [])
            if not price_list:
                continue

            # Find the closest price <= bucket_date (most recent before or at)
            best_price = None
            for ts, price in price_list:
                if _ensure_naive(ts) <= bd:
                    best_price = price
                else:
                    break

            # If no price before, use the first available
            if best_price is None and price_list:
                best_price = price_list[0][1]

            if best_price is not None:
                prices[asset_id] = best_price

        result[date_str] = prices

    return result


def _get_cumulative_realized_pnl(
    session: Session,
    version_id: int,
    bucket_dates: List[datetime],
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
) -> Dict[str, Tuple[float, Dict[int, float]]]:
    """
    For each date bucket, compute cumulative realized P&L.

    Returns: { date_str: (total_cumulative_pnl, { asset_id: cumulative_pnl }) }
    """
    if not bucket_dates:
        return {}

    rpnl_query = (
        select(
            RealizedPnl.asset_id,
            RealizedPnl.pnl_in_base,
            RealizedPnl.realized_at,
        )
        .join(CalculationUnit, RealizedPnl.origin_unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
        .where(RealizedPnl.realized_at.isnot(None))
        .order_by(RealizedPnl.realized_at)
    )

    if asset_ids:
        rpnl_query = rpnl_query.where(RealizedPnl.asset_id.in_(asset_ids))

    if account_ids:
        # Filter by account via the transaction
        from backend.db.models import NormalizedTransaction
        rpnl_query = rpnl_query.join(
            NormalizedTransaction,
            RealizedPnl.transaction_id == NormalizedTransaction.id,
            isouter=True,
        ).where(NormalizedTransaction.account_id.in_(account_ids))

    rpnl_rows = session.exec(rpnl_query).all()

    # Build sorted list
    rpnl_list = [
        (_ensure_naive(r.realized_at), r.asset_id, float(r.pnl_in_base))
        for r in rpnl_rows
    ]

    result: Dict[str, Tuple[float, Dict[int, float]]] = {}
    rpnl_idx = 0
    cumulative_total = 0.0
    cumulative_by_asset: Dict[int, float] = defaultdict(float)

    for bucket_date in bucket_dates:
        bd = _ensure_naive(bucket_date)
        while rpnl_idx < len(rpnl_list) and rpnl_list[rpnl_idx][0] <= bd:
            _, asset_id, pnl = rpnl_list[rpnl_idx]
            cumulative_total += pnl
            cumulative_by_asset[asset_id] += pnl
            rpnl_idx += 1

        date_str = bucket_date.strftime("%Y-%m-%d")
        result[date_str] = (cumulative_total, dict(cumulative_by_asset))

    return result


def _get_asset_symbols(session: Session, asset_ids: List[int]) -> Dict[int, str]:
    """Get asset symbols by ID."""
    if not asset_ids:
        return {}
    assets = session.exec(select(Asset).where(Asset.asset_id.in_(asset_ids))).all()
    return {a.asset_id: a.symbol for a in assets}


def _get_asset_labels(session: Session, asset_ids: List[int]) -> Dict[int, Optional[str]]:
    """Get asset labels by ID."""
    if not asset_ids:
        return {}
    assets = session.exec(select(Asset).where(Asset.asset_id.in_(asset_ids))).all()
    return {a.asset_id: a.label for a in assets}


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
        session, version_id, buckets, asset_ids, account_ids
    )

    # 2. Get cost basis snapshots per date
    cost_basis_snapshots = _get_cost_basis_snapshots_at_dates(
        session, version_id, buckets, asset_ids, account_ids
    )

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


# ---------------------------------------------------------------------------
# Period summary
# ---------------------------------------------------------------------------

PERIOD_RANGES = {
    "all": None,
    "1y": 365,
    "6m": 180,
    "3m": 90,
    "1m": 30,
}


@dataclass
class AssetPerformer:
    asset_id: int
    symbol: str
    label: Optional[str]
    total_return: float
    roi_pct: float


@dataclass
class PeriodMetrics:
    total_return: float
    roi_pct: float
    current_value: float
    cost_basis: float
    unrealized_pnl: float
    realized_pnl: float
    realized_in_period: float
    top_performers: List[AssetPerformer]
    flop_performers: List[AssetPerformer]


def compute_period_summary(
    session: Session,
    version_id: int,
    top_n: int = 5,
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    category_ids: Optional[List[int]] = None,
) -> Dict[str, PeriodMetrics]:
    """
    Compute portfolio metrics for all time ranges (all, 1y, 6m, 3m, 1m).

    Instead of computing the full daily timeline, only fetches snapshots at the
    boundary dates (start of each period + today), then derives deltas.

    Returns:
        Dict mapping range key ('all', '1y', ...) to PeriodMetrics.
    """
    version = session.get(CalculationVersion, version_id)
    if not version:
        return {}

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
            return {}

    # Determine data range from events
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
        return {}

    from datetime import timezone as tz
    now = datetime.now(tz.utc)
    if min_date.tzinfo is None:
        min_date = min_date.replace(tzinfo=tz.utc)
    if max_date.tzinfo is None:
        max_date = max_date.replace(tzinfo=tz.utc)

    # Build unique boundary dates: "today" + start of each period
    boundary_dates = [now]  # always include today
    range_starts: Dict[str, datetime] = {}
    for key, days in PERIOD_RANGES.items():
        if days is None:
            range_starts[key] = min_date
        else:
            cutoff = now - timedelta(days=days)
            range_starts[key] = max(cutoff, min_date)
        boundary_dates.append(range_starts[key])

    # De-duplicate and sort
    unique_dates = sorted(set(boundary_dates))

    # Fetch snapshots at boundary dates
    balance_snapshots = _get_balance_snapshots_at_dates(
        session, version_id, unique_dates, asset_ids, account_ids
    )
    cost_basis_snapshots = _get_cost_basis_snapshots_at_dates(
        session, version_id, unique_dates, asset_ids, account_ids
    )

    # Collect all asset IDs
    all_asset_ids: set = set()
    for balances in balance_snapshots.values():
        all_asset_ids.update(balances.keys())
    all_asset_ids_list = list(all_asset_ids)

    price_snapshots = _get_price_at_dates(
        session, version.base_currency_id, all_asset_ids_list, unique_dates
    )
    cumulative_rpnl = _get_cumulative_realized_pnl(
        session, version_id, unique_dates, asset_ids, account_ids
    )

    # Asset metadata
    asset_symbols = _get_asset_symbols(session, all_asset_ids_list)
    asset_labels = _get_asset_labels(session, all_asset_ids_list)

    # Helper: get snapshot at a specific date
    def _snapshot_at(dt: datetime):
        ds = dt.strftime("%Y-%m-%d")
        return (
            balance_snapshots.get(ds, {}),
            cost_basis_snapshots.get(ds, {}),
            price_snapshots.get(ds, {}),
            cumulative_rpnl.get(ds, (0.0, {})),
        )

    now_balances, now_costs, now_prices, now_rpnl = _snapshot_at(now)
    now_rpnl_total, now_rpnl_by_asset = now_rpnl

    result: Dict[str, PeriodMetrics] = {}

    for range_key, start_dt in range_starts.items():
        start_balances, start_costs, start_prices, start_rpnl = _snapshot_at(start_dt)
        start_rpnl_total, start_rpnl_by_asset = start_rpnl

        # Portfolio-level metrics at "now"
        current_value = sum(
            now_balances.get(aid, 0.0) * now_prices.get(aid, 0.0)
            for aid in all_asset_ids
        )
        cost_basis = sum(now_costs.get(aid, 0.0) for aid in all_asset_ids)
        unrealized_pnl = current_value - cost_basis
        realized_pnl = now_rpnl_total
        realized_in_period = now_rpnl_total - start_rpnl_total

        if range_key == "all":
            total_return = unrealized_pnl + realized_pnl
            roi_base = cost_basis
        else:
            # Period specific: change in unrealized + realized events in period
            start_value = sum(
                start_balances.get(aid, 0.0) * start_prices.get(aid, 0.0)
                for aid in all_asset_ids
            )
            start_cost = sum(start_costs.get(aid, 0.0) for aid in all_asset_ids)
            start_unrealized = start_value - start_cost
            unrealized_change = unrealized_pnl - start_unrealized
            total_return = unrealized_change + realized_in_period
            roi_base = start_cost if start_cost != 0 else cost_basis

        roi_pct = (total_return / roi_base * 100) if roi_base != 0 else 0.0

        # Per-asset performance for top/flop
        asset_performances: List[AssetPerformer] = []
        for aid in all_asset_ids:
            qty_now = now_balances.get(aid, 0.0)
            price_now = now_prices.get(aid, 0.0)
            cost_now = now_costs.get(aid, 0.0)
            asset_value = qty_now * price_now
            asset_unrealized = asset_value - cost_now
            asset_rpnl_now = now_rpnl_by_asset.get(aid, 0.0)
            asset_rpnl_start = start_rpnl_by_asset.get(aid, 0.0)
            asset_realized_in_period = asset_rpnl_now - asset_rpnl_start

            if range_key == "all":
                asset_total_return = asset_unrealized + asset_rpnl_now
                asset_roi_base = cost_now
            else:
                qty_start = start_balances.get(aid, 0.0)
                price_start = start_prices.get(aid, 0.0)
                cost_start = start_costs.get(aid, 0.0)
                asset_unrealized_start = qty_start * price_start - cost_start
                asset_unrealized_change = asset_unrealized - asset_unrealized_start
                asset_total_return = asset_unrealized_change + asset_realized_in_period
                asset_roi_base = cost_start if cost_start != 0 else cost_now

            # Skip assets with no meaningful exposure
            if abs(qty_now) < 1e-12 and abs(cost_now) < 1e-12 and abs(asset_total_return) < 0.01:
                continue

            asset_roi = (asset_total_return / asset_roi_base * 100) if asset_roi_base != 0 else 0.0

            asset_performances.append(AssetPerformer(
                asset_id=aid,
                symbol=asset_symbols.get(aid, f"#{aid}"),
                label=asset_labels.get(aid),
                total_return=round(asset_total_return, 2),
                roi_pct=round(asset_roi, 2),
            ))

        # Sort for top/flop
        sorted_by_return = sorted(asset_performances, key=lambda a: a.total_return, reverse=True)
        top = sorted_by_return[:top_n]
        flop = sorted_by_return[-top_n:][::-1] if len(sorted_by_return) > top_n else sorted_by_return[top_n:][::-1]
        # Filter flop to only negatives
        flop = [a for a in flop if a.total_return < 0]

        result[range_key] = PeriodMetrics(
            total_return=round(total_return, 2),
            roi_pct=round(roi_pct, 2),
            current_value=round(current_value, 2),
            cost_basis=round(cost_basis, 2),
            unrealized_pnl=round(unrealized_pnl, 2),
            realized_pnl=round(realized_pnl, 2),
            realized_in_period=round(realized_in_period, 2),
            top_performers=top,
            flop_performers=flop,
        )

    log.info(
        "period_summary_computed",
        version_id=version_id,
        ranges=list(result.keys()),
    )

    return result
