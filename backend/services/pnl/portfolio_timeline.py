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

import math
from bisect import bisect_left
from collections import OrderedDict, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

from sqlalchemy import func
from sqlmodel import Session, select

from backend.db.models import (
    AssetCategory,
    CalculationUnit,
    CalculationUnitLeg,
    CalculationVersion,
    CostLot,
    CostLotEvent,
    IncomeEvent,
    PriceSnapshot,
    UnitPattern,
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
    # Cumulative split ratio to apply to the unit price for a split-continuous price series
    split_factor: float = 1.0


@dataclass
class TimelinePoint:
    date: str  # ISO date string
    total_value_in_base: float
    cost_basis_in_base: float
    unrealized_pnl: float
    cumulative_realized_pnl: float
    cumulative_income: float = 0.0
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
    if buckets and buckets[-1].date() < end_date.date():
        buckets.append(_truncate_date(end_date, granularity))

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

def _get_cumulative_income_at_dates(
    session: Session,
    version_id: int,
    bucket_dates: List[datetime],
) -> Dict[str, float]:
    """
    Compute cumulative net income (gross - withholding) up to each date bucket.

    Returns:
        { "YYYY-MM-DD": cumulative_net_income }
    """
    if not bucket_dates:
        return {}

    # Get all income events for this version, ordered by date
    events = session.exec(
        select(IncomeEvent.income_at, IncomeEvent.net_amount_in_base)
        .where(IncomeEvent.version_id == version_id)
        .order_by(IncomeEvent.income_at)
    ).all()

    if not events:
        return {d.strftime("%Y-%m-%d"): 0.0 for d in bucket_dates}

    # Build cumulative sum
    result: Dict[str, float] = {}
    cumulative = 0.0
    event_idx = 0

    for bucket_date in sorted(bucket_dates):
        # Advance through events up to and including this bucket date
        bucket_end = bucket_date.replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)
        while event_idx < len(events):
            evt_date = events[event_idx].income_at
            if evt_date.tzinfo is None:
                evt_date = evt_date.replace(tzinfo=timezone.utc)
            if evt_date <= bucket_end:
                cumulative += float(events[event_idx].net_amount_in_base or 0)
                event_idx += 1
            else:
                break

        result[bucket_date.strftime("%Y-%m-%d")] = cumulative

    return result


def _get_split_events(
    session: Session,
    version_id: int,
    asset_ids: Optional[List[int]] = None,
) -> Dict[int, List[Tuple[str, float]]]:
    """
    Split ratios (inflow qty / outflow qty) per asset from SPLIT units.

    Returns: { asset_id: [(YYYY-MM-DD, ratio), ...] } sorted by date, one entry per day.
    """
    query = (
        select(
            CalculationUnit.id,
            CalculationUnit.timestamp,
            CalculationUnitLeg.asset_id,
            CalculationUnitLeg.leg_type,
            CalculationUnitLeg.quantity,
        )
        .join(CalculationUnitLeg, CalculationUnitLeg.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
        .where(CalculationUnit.pattern == UnitPattern.SPLIT.value)
    )
    if asset_ids:
        query = query.where(CalculationUnitLeg.asset_id.in_(asset_ids))

    per_unit: Dict[Tuple[int, int], List] = defaultdict(lambda: [None, 0.0, 0.0])
    for unit_id, ts, asset_id, leg_type, qty in session.exec(query).all():
        entry = per_unit[(unit_id, asset_id)]
        entry[0] = ts
        kind = getattr(leg_type, "value", leg_type)
        if kind == "inflow":
            entry[1] += abs(float(qty))
        elif kind == "outflow":
            entry[2] += abs(float(qty))

    # Same split booked in several accounts -> keep a single ratio per (asset, day)
    by_asset: Dict[int, Dict[str, float]] = defaultdict(dict)
    for (_, asset_id), (ts, in_qty, out_qty) in per_unit.items():
        if ts is None or in_qty <= 0 or out_qty <= 0:
            continue
        ratio = in_qty / out_qty
        if abs(ratio - 1.0) < 1e-9:
            continue
        by_asset[asset_id].setdefault(_ensure_naive(ts).strftime("%Y-%m-%d"), ratio)

    return {aid: sorted(days.items()) for aid, days in by_asset.items()}


def _compute_split_factors(
    split_events: Dict[int, List[Tuple[str, float]]],
    price_snapshots: Dict[str, Dict[int, float]],
    bucket_ds: List[str],
    window: int,
) -> Dict[int, Dict[str, float]]:
    """
    Cumulative split factor per asset and bucket.

    A split is applied only where the stored price actually drops by ~1/ratio
    near the split date; already split-adjusted price history is left untouched.
    """
    factors: Dict[int, Dict[str, float]] = {}
    for asset_id, events in split_events.items():
        prices = [price_snapshots.get(ds, {}).get(asset_id) for ds in bucket_ds]
        cum = [1.0] * len(bucket_ds)
        applied = False
        for split_ds, ratio in events:
            idx = bisect_left(bucket_ds, split_ds)
            best: Optional[Tuple[float, int]] = None
            for j in range(max(1, idx - window), min(len(bucket_ds), idx + window + 1)):
                p0, p1 = prices[j - 1], prices[j]
                if not p0 or not p1 or p0 <= 0 or p1 <= 0:
                    continue
                err = abs(math.log(p1 / p0 * ratio))
                if best is None or err < best[0]:
                    best = (err, j)
            if best is None or best[0] > 0.25 * abs(math.log(ratio)):
                continue
            for k in range(best[1], len(bucket_ds)):
                cum[k] *= ratio
            applied = True
        if applied:
            factors[asset_id] = dict(zip(bucket_ds, cum))
    return factors


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

    # Ensure timezone awareness (must happen before any comparisons)
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)

    # Extend to today so static holdings still get current-day data points
    now = datetime.now(timezone.utc)
    if date_to is None and end < now:
        end = now

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
        lot_balances, lot_remaining_costs, _ = _get_current_from_cost_lots(
            session, version_id, asset_ids, account_ids,
            include_unsettled_negative=include_unsettled_negative,
        )
        balance_snapshots[last_ds] = lot_balances
        cost_basis_snapshots[last_ds] = lot_remaining_costs

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

    # 4b. Get cumulative income per date bucket
    cumulative_income_by_date = _get_cumulative_income_at_dates(
        session, version_id, buckets
    )

    # 4c. Split factors so per-asset unit prices stay continuous across splits
    bucket_ds = [b.strftime("%Y-%m-%d") for b in buckets]
    split_factors = _compute_split_factors(
        _get_split_events(session, version_id, asset_ids),
        price_snapshots,
        bucket_ds,
        window=5 if granularity == "daily" else 1,
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
                split_factor=split_factors.get(asset_id, {}).get(date_str, 1.0),
            ))

        unrealized = total_value - total_cost_basis

        timeline.append(TimelinePoint(
            date=date_str,
            total_value_in_base=round(total_value, 2),
            cost_basis_in_base=round(total_cost_basis, 2),
            unrealized_pnl=round(unrealized, 2),
            cumulative_realized_pnl=round(rpnl_total, 2),
            cumulative_income=round(cumulative_income_by_date.get(date_str, 0.0), 2),
            breakdown=breakdown,
        ))

    log.info(
        "portfolio_timeline_computed",
        version_id=version_id,
        points=len(timeline),
    )

    return timeline


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

_TIMELINE_CACHE: "OrderedDict[tuple, List[TimelinePoint]]" = OrderedDict()
_TIMELINE_CACHE_MAX = 32


def _price_fingerprint(session: Session) -> tuple:
    # Version data only changes via force-settle (which clears the cache); prices change independently.
    return tuple(
        session.exec(
            select(
                func.count(PriceSnapshot.snapshot_id),
                func.max(PriceSnapshot.snapshot_id),
                func.sum(PriceSnapshot.price),
            )
        ).one()
    )


def compute_portfolio_timeline_cached(
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
    """compute_portfolio_timeline, memoized per version/filters/price data/day."""
    kwargs = dict(
        session=session,
        version_id=version_id,
        granularity=granularity,
        date_from=date_from,
        date_to=date_to,
        asset_ids=asset_ids,
        account_ids=account_ids,
        category_ids=category_ids,
        include_unsettled_negative=include_unsettled_negative,
    )
    # Category membership is mutable and not fingerprinted.
    if category_ids:
        return compute_portfolio_timeline(**kwargs)

    key = (
        version_id,
        granularity,
        date_from,
        date_to,
        tuple(sorted(asset_ids)) if asset_ids else None,
        tuple(sorted(account_ids)) if account_ids else None,
        include_unsettled_negative,
        # The timeline extends to "now" when date_to is open.
        datetime.now(timezone.utc).date(),
        _price_fingerprint(session),
    )
    cached = _TIMELINE_CACHE.get(key)
    if cached is not None:
        _TIMELINE_CACHE.move_to_end(key)
        return cached

    points = compute_portfolio_timeline(**kwargs)
    _TIMELINE_CACHE[key] = points
    if len(_TIMELINE_CACHE) > _TIMELINE_CACHE_MAX:
        _TIMELINE_CACHE.popitem(last=False)
    return points


def clear_portfolio_timeline_cache() -> None:
    _TIMELINE_CACHE.clear()
