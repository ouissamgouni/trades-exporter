"""
Centralized PnL Metrics Service

Single source of truth for all PnL metric computations. Every endpoint
that needs portfolio-level metrics (value, cost, unrealized, realized,
performers) MUST go through this module.

Used by:
  - GET /pnl/versions/{id}          (all-time summary)
  - GET /pnl/versions/{id}/metrics  (full metrics + performers by period)

Guarantees:
  - Identical realized_pnl across all endpoints (controlled by taxable_only flag)
  - Authoritative current balances from CostLot (not event reconstruction)
  - Fresh prices fetched before computing market value
  - Server-side group_by for performers (asset/account/category)
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Dict, List, Optional, Tuple

from sqlalchemy import func, or_
from sqlmodel import Session, select

from backend.db.models import (
    Account,
    Asset,
    AssetCategory,
    CalculationUnit,
    CalculationVersion,
    Category,
    CostLot,
    CostLotEvent,
    FeeEntry,
    PriceSnapshot,
    RealizedPnl,
)
from backend.config.loader import configure_logging

log = configure_logging("pnl_metrics")


# ---------------------------------------------------------------------------
# Data transfer objects
# ---------------------------------------------------------------------------

PERIOD_RANGES: Dict[str, Optional[int]] = {
    "all": None,
    "3y": 1095,
    "1y": 365,
    "6m": 180,
    "3m": 90,
    "1m": 30,
    "1w": 7,
}


@dataclass
class PerformerItem:
    """A ranked performer (asset, account, or category)."""
    id: int
    name: str
    label: Optional[str]
    group_type: str  # "asset", "account", "category"
    total_return: float
    roi_pct: float
    unrealized_pnl: float = 0.0
    market_value: float = 0.0
    cost_basis: float = 0.0
    total_fees: float = 0.0
    efficiency: float = 0.0  # total_return / max(cost_basis, 1)


@dataclass
class RangeMetrics:
    """Metrics for a single time period."""
    total_return: float
    roi_pct: float
    current_value: float
    cost_basis: float
    unrealized_pnl: float
    realized_pnl: float
    taxable_realized_pnl: float
    realized_in_period: float
    cost_basis_in_period: float = 0.0
    unrealized_in_period: float = 0.0
    fees_in_period: float = 0.0
    top_performers: List[PerformerItem] = field(default_factory=list)
    flop_performers: List[PerformerItem] = field(default_factory=list)


@dataclass
class SummaryMetrics:
    """All-time portfolio summary (constant across periods)."""
    current_value: float
    cost_basis: float
    unrealized_pnl: float
    realized_pnl: float
    taxable_realized_pnl: float
    total_fees: float
    fee_entry_count: int


@dataclass
class VersionMetrics:
    """Complete metrics result returned by compute_version_metrics."""
    version_id: int
    summary: SummaryMetrics
    ranges: Dict[str, RangeMetrics] = field(default_factory=dict)


@dataclass
class SettledSummary:
    """All-time settled summary (no market prices needed)."""
    cost_basis: float
    realized_pnl: float
    taxable_realized_pnl: float
    total_fees: float
    fee_entry_count: int


@dataclass
class SettledRangeMetrics:
    """Per-period settled metrics (no market prices needed)."""
    cost_basis: float
    realized_pnl: float
    taxable_realized_pnl: float
    realized_in_period: float
    cost_basis_in_period: float
    fees_in_period: float


@dataclass
class SettledVersionMetrics:
    """Settled metrics result (fast, no price lookup)."""
    version_id: int
    summary: SettledSummary
    ranges: Dict[str, SettledRangeMetrics] = field(default_factory=dict)


@dataclass
class PerformersResult:
    """Standalone performer ranking result."""
    version_id: int
    period: str
    group_type: str
    top_performers: List[PerformerItem] = field(default_factory=list)
    flop_performers: List[PerformerItem] = field(default_factory=list)


@dataclass
class MarketSummary:
    """All-time market summary (price-dependent)."""
    current_value: float
    unrealized_pnl: float


@dataclass
class MarketRangeMetrics:
    """Per-period market metrics (price-dependent)."""
    current_value: float
    unrealized_pnl: float
    unrealized_in_period: float
    total_return: float
    roi_pct: float


@dataclass
class MarketVersionMetrics:
    """Market metrics result (requires prices from PriceSnapshot)."""
    version_id: int
    summary: MarketSummary
    ranges: Dict[str, MarketRangeMetrics] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Internal helpers (moved from portfolio_timeline.py)
# ---------------------------------------------------------------------------

def _ensure_naive(dt: datetime) -> datetime:
    """Strip timezone info so comparisons with DB-naive timestamps work."""
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _get_current_from_cost_lots(
    session: Session,
    version_id: int,
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    include_unsettled_negative: bool = False,
) -> Tuple[Dict[int, float], Dict[int, float]]:
    """
    Get current balances and cost basis directly from CostLot records.

    This is the authoritative source used by the /balances endpoint.

    Returns:
        (balances, costs) where each is { asset_id: value }
    """
    query = (
        select(
            CostLot.asset_id,
            func.sum(CostLot.qty_remaining).label("total_qty"),
            func.sum(CostLot.qty_remaining * CostLot.unit_cost_in_base).label("total_cost"),
        )
        .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
        .group_by(CostLot.asset_id)
    )

    if not include_unsettled_negative:
        query = query.where(
            or_(CostLot.is_negative == False, CostLot.is_settled == True)  # noqa: E712
        )

    if asset_ids:
        query = query.where(CostLot.asset_id.in_(asset_ids))
    if account_ids:
        query = query.where(CostLot.account_id.in_(account_ids))

    rows = session.exec(query).all()

    balances: Dict[int, float] = {}
    costs: Dict[int, float] = {}
    for row in rows:
        aid = row.asset_id
        qty = float(row.total_qty or 0)
        cost = float(row.total_cost or 0)
        if abs(qty) > 1e-12 or abs(cost) > 1e-12:
            balances[aid] = qty
            costs[aid] = cost

    return balances, costs


def _get_current_from_cost_lots_by_account(
    session: Session,
    version_id: int,
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    include_unsettled_negative: bool = False,
) -> Dict[int, Tuple[Dict[int, float], Dict[int, float]]]:
    """
    Get current balances and cost basis grouped by account_id.

    Returns: { account_id: (balances_by_asset, costs_by_asset) }
    """
    query = (
        select(
            CostLot.account_id,
            CostLot.asset_id,
            func.sum(CostLot.qty_remaining).label("total_qty"),
            func.sum(CostLot.qty_remaining * CostLot.unit_cost_in_base).label("total_cost"),
        )
        .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
        .group_by(CostLot.account_id, CostLot.asset_id)
    )

    if not include_unsettled_negative:
        query = query.where(
            or_(CostLot.is_negative == False, CostLot.is_settled == True)  # noqa: E712
        )
    if asset_ids:
        query = query.where(CostLot.asset_id.in_(asset_ids))
    if account_ids:
        query = query.where(CostLot.account_id.in_(account_ids))

    rows = session.exec(query).all()

    result: Dict[int, Tuple[Dict[int, float], Dict[int, float]]] = {}
    for row in rows:
        acct = row.account_id
        if acct not in result:
            result[acct] = ({}, {})
        balances, costs = result[acct]
        qty = float(row.total_qty or 0)
        cost = float(row.total_cost or 0)
        if abs(qty) > 1e-12 or abs(cost) > 1e-12:
            balances[row.asset_id] = qty
            costs[row.asset_id] = cost

    return result


def _get_balance_snapshots_at_dates(
    session: Session,
    version_id: int,
    bucket_dates: List[datetime],
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    include_unsettled_negative: bool = False,
) -> Dict[str, Dict[int, float]]:
    """
    For each date bucket, get the asset-level balance from CostLotEvents.

    Returns: { date_str: { asset_id: qty } }
    """
    if not bucket_dates:
        return {}

    events_query = (
        select(
            CostLotEvent.timestamp,
            CostLotEvent.lot_id,
            CostLot.asset_id,
            CostLotEvent.qty_remaining_after,
        )
        .join(CostLot, CostLotEvent.lot_id == CostLot.cost_lot_id)
        .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
        .order_by(CostLotEvent.timestamp, CostLotEvent.sequence_num)
    )

    if not include_unsettled_negative:
        events_query = events_query.where(
            or_(CostLot.is_negative == False, CostLot.is_settled == True)  # noqa: E712
        )
    if asset_ids:
        events_query = events_query.where(CostLot.asset_id.in_(asset_ids))
    if account_ids:
        events_query = events_query.where(CostLot.account_id.in_(account_ids))

    events = session.exec(events_query).all()
    if not events:
        return {}

    events_list = [
        (_ensure_naive(e.timestamp), e.lot_id, e.asset_id, float(e.qty_remaining_after))
        for e in events
    ]

    result: Dict[str, Dict[int, float]] = {}
    event_idx = 0
    lot_state: Dict[int, Tuple[int, float]] = {}

    for bucket_date in bucket_dates:
        bd = _ensure_naive(bucket_date)
        while event_idx < len(events_list) and events_list[event_idx][0] <= bd:
            _, lot_id, asset_id, qty = events_list[event_idx]
            lot_state[lot_id] = (asset_id, qty)
            event_idx += 1

        date_str = bucket_date.strftime("%Y-%m-%d")
        asset_balance: Dict[int, float] = defaultdict(float)
        for lot_id, (asset_id, qty) in lot_state.items():
            asset_balance[asset_id] += qty
        result[date_str] = dict(asset_balance)

    return result


def _get_cost_basis_snapshots_at_dates(
    session: Session,
    version_id: int,
    bucket_dates: List[datetime],
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    include_unsettled_negative: bool = False,
) -> Dict[str, Dict[int, float]]:
    """
    For each date bucket, compute cost basis per asset from CostLotEvents.

    Returns: { date_str: { asset_id: cost_basis } }
    """
    if not bucket_dates:
        return {}

    query = (
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

    if not include_unsettled_negative:
        query = query.where(
            or_(CostLot.is_negative == False, CostLot.is_settled == True)  # noqa: E712
        )
    if asset_ids:
        query = query.where(CostLot.asset_id.in_(asset_ids))
    if account_ids:
        query = query.where(CostLot.account_id.in_(account_ids))

    lot_events = session.exec(query).all()
    if not lot_events:
        return {}

    lot_events_list = [
        (_ensure_naive(e.timestamp), e.lot_id, e.asset_id, float(e.qty_remaining_after), float(e.unit_cost_in_base))
        for e in lot_events
    ]

    result: Dict[str, Dict[int, float]] = {}
    event_idx = 0
    lot_state: Dict[int, Tuple[int, float]] = {}

    for bucket_date in bucket_dates:
        bd = _ensure_naive(bucket_date)
        while event_idx < len(lot_events_list) and lot_events_list[event_idx][0] <= bd:
            _, lot_id, asset_id, qty_remaining, unit_cost = lot_events_list[event_idx]
            lot_state[lot_id] = (asset_id, qty_remaining * unit_cost)
            event_idx += 1

        date_str = bucket_date.strftime("%Y-%m-%d")
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
        if base_currency_id and bucket_dates:
            return {
                bd.strftime("%Y-%m-%d"): {base_currency_id: 1.0}
                for bd in bucket_dates
                if base_currency_id in (asset_ids or [])
            }
        return {}

    price_query = (
        select(PriceSnapshot.asset_id, PriceSnapshot.price, PriceSnapshot.snapshot_time)
        .where(PriceSnapshot.asset_id.in_(asset_ids))
        .order_by(PriceSnapshot.snapshot_time)
    )

    if base_currency_id:
        price_query = price_query.where(PriceSnapshot.quote_asset_id == base_currency_id)

    price_rows = session.exec(price_query).all()

    # Defensive fallback: if we got no prices with the specific quote_asset_id,
    # try again without the filter (covers NULL-quoted legacy snapshots)
    if not price_rows and base_currency_id:
        log.warning(
            "price_quote_fallback",
            msg="No prices found with quote_asset_id filter, falling back to unfiltered",
            base_currency_id=base_currency_id,
            asset_count=len(asset_ids),
        )
        fallback_query = (
            select(PriceSnapshot.asset_id, PriceSnapshot.price, PriceSnapshot.snapshot_time)
            .where(PriceSnapshot.asset_id.in_(asset_ids))
            .order_by(PriceSnapshot.snapshot_time)
        )
        price_rows = session.exec(fallback_query).all()

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

            best_price = None
            for ts, price in price_list:
                if _ensure_naive(ts) <= bd:
                    best_price = price
                else:
                    break

            if best_price is None and price_list:
                best_price = price_list[0][1]

            if best_price is not None:
                prices[asset_id] = best_price

        if base_currency_id and base_currency_id in asset_ids:
            prices.setdefault(base_currency_id, 1.0)

        result[date_str] = prices

    return result


def _get_cumulative_realized_pnl(
    session: Session,
    version_id: int,
    bucket_dates: List[datetime],
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    taxable_only: bool = False,
) -> Dict[str, Tuple[float, Dict[int, float]]]:
    """
    For each date bucket, compute cumulative realized P&L.

    Args:
        taxable_only: If True, only include disposal_taxable=True entries.
                     Defaults to False (include all realized P&L).

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

    if taxable_only:
        rpnl_query = rpnl_query.where(RealizedPnl.disposal_taxable == True)  # noqa: E712

    if asset_ids:
        rpnl_query = rpnl_query.where(RealizedPnl.asset_id.in_(asset_ids))

    if account_ids:
        from backend.db.models import NormalizedTransaction
        rpnl_query = rpnl_query.join(
            NormalizedTransaction,
            RealizedPnl.transaction_id == NormalizedTransaction.id,
            isouter=True,
        ).where(NormalizedTransaction.account_id.in_(account_ids))

    rpnl_rows = session.exec(rpnl_query).all()

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


def _get_cumulative_realized_pnl_by_account(
    session: Session,
    version_id: int,
    bucket_dates: List[datetime],
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
) -> Dict[str, Dict[int, float]]:
    """
    For each date bucket, compute cumulative realized P&L by account_id.

    Returns: { date_str: { account_id: cumulative_pnl } }
    """
    if not bucket_dates:
        return {}

    from backend.db.models import NormalizedTransaction

    rpnl_query = (
        select(
            NormalizedTransaction.account_id,
            RealizedPnl.pnl_in_base,
            RealizedPnl.realized_at,
        )
        .join(CalculationUnit, RealizedPnl.origin_unit_id == CalculationUnit.id)
        .join(
            NormalizedTransaction,
            RealizedPnl.transaction_id == NormalizedTransaction.id,
            isouter=True,
        )
        .where(CalculationUnit.version_id == version_id)
        .where(RealizedPnl.realized_at.isnot(None))
        .order_by(RealizedPnl.realized_at)
    )

    if asset_ids:
        rpnl_query = rpnl_query.where(RealizedPnl.asset_id.in_(asset_ids))
    if account_ids:
        rpnl_query = rpnl_query.where(NormalizedTransaction.account_id.in_(account_ids))

    rpnl_rows = session.exec(rpnl_query).all()

    rpnl_list = [
        (_ensure_naive(r.realized_at), r.account_id, float(r.pnl_in_base))
        for r in rpnl_rows
        if r.account_id is not None
    ]

    result: Dict[str, Dict[int, float]] = {}
    rpnl_idx = 0
    cumulative_by_account: Dict[int, float] = defaultdict(float)

    for bucket_date in bucket_dates:
        bd = _ensure_naive(bucket_date)
        while rpnl_idx < len(rpnl_list) and rpnl_list[rpnl_idx][0] <= bd:
            _, acct_id, pnl = rpnl_list[rpnl_idx]
            cumulative_by_account[acct_id] += pnl
            rpnl_idx += 1

        date_str = bucket_date.strftime("%Y-%m-%d")
        result[date_str] = dict(cumulative_by_account)

    return result


def _get_asset_symbols(session: Session, asset_ids: List[int]) -> Dict[int, str]:
    if not asset_ids:
        return {}
    assets = session.exec(select(Asset).where(Asset.asset_id.in_(asset_ids))).all()
    return {a.asset_id: a.symbol for a in assets}


def _get_asset_labels(session: Session, asset_ids: List[int]) -> Dict[int, Optional[str]]:
    if not asset_ids:
        return {}
    assets = session.exec(select(Asset).where(Asset.asset_id.in_(asset_ids))).all()
    return {a.asset_id: a.label for a in assets}


def _resolve_category_to_asset_ids(
    session: Session,
    category_ids: List[int],
    asset_ids: Optional[List[int]] = None,
) -> Optional[List[int]]:
    """Resolve category_ids to asset_ids. Returns None if result is empty."""
    cat_asset_rows = session.exec(
        select(AssetCategory.asset_id)
        .where(AssetCategory.category_id.in_(category_ids))
    ).all()
    cat_asset_ids = list(set(cat_asset_rows))
    if asset_ids:
        merged = list(set(asset_ids) & set(cat_asset_ids))
    else:
        merged = cat_asset_ids
    return merged if merged else None


def _refresh_prices_for_assets(
    session: Session,
    asset_ids: List[int],
    base_currency_id: Optional[int],
) -> None:
    """
    Refresh prices for held assets by calling the PriceService.

    This ensures PriceSnapshot has up-to-date prices before we compute
    metrics. Falls back gracefully if price fetch fails (stale prices
    are still usable for metric computation).
    """
    if not asset_ids or not base_currency_id:
        return

    try:
        from backend.services.price_service import PriceService
        price_service = PriceService(session=session)

        base_asset = session.get(Asset, base_currency_id)
        base_symbol = base_asset.symbol if base_asset else "USD"

        now = datetime.now(timezone.utc)
        stale_assets = []
        failed_assets = []
        for aid in asset_ids:
            if aid == base_currency_id:
                continue
            try:
                result = price_service.get_price_with_fallback(
                    asset_id=aid,
                    dt=now,
                    price_quote=base_symbol,
                    use_fallback=True,
                    staleness_window_days=7,
                )
                if result.is_stale:
                    stale_assets.append((aid, result.staleness_days))
                elif result.is_fallback:
                    stale_assets.append((aid, result.staleness_days))
            except Exception as e:
                failed_assets.append(aid)
                log.warning("price_refresh_asset_failed", asset_id=aid, error=str(e))
        if stale_assets:
            log.warning(
                "stale_prices_detected",
                count=len(stale_assets),
                assets=[(aid, days) for aid, days in stale_assets[:10]],
            )
        if failed_assets:
            log.warning(
                "price_refresh_failures",
                count=len(failed_assets),
                asset_ids=failed_assets[:10],
            )
    except Exception:
        log.warning("price_refresh_failed", asset_count=len(asset_ids))


def _compute_fee_summary(
    session: Session,
    version_id: int,
) -> Tuple[float, int]:
    """Compute total fees and fee entry count for a version."""
    fee_summary = session.exec(
        select(
            func.coalesce(func.sum(FeeEntry.fee_value_in_base), 0).label("total_fees"),
            func.count(FeeEntry.id).label("fee_count"),
        )
        .where(FeeEntry.version_id == version_id)
    ).first()
    total_fees = float(fee_summary.total_fees) if fee_summary else 0.0
    fee_count = fee_summary.fee_count if fee_summary else 0
    return total_fees, fee_count


def _compute_fees_in_period(
    session: Session,
    version_id: int,
    start_dt: datetime,
    end_dt: datetime,
) -> float:
    """Compute total fees within a date range by joining FeeEntry → CalculationUnit."""
    result = session.exec(
        select(
            func.coalesce(func.sum(FeeEntry.fee_value_in_base), 0)
        )
        .join(CalculationUnit, FeeEntry.unit_id == CalculationUnit.id)
        .where(
            FeeEntry.version_id == version_id,
            CalculationUnit.timestamp >= start_dt,
            CalculationUnit.timestamp <= end_dt,
        )
    ).first()
    return float(result or 0)


def _get_fees_by_asset(
    session: Session,
    version_id: int,
) -> Dict[int, float]:
    """Aggregate total fees per asset (by related_asset_id)."""
    rows = session.exec(
        select(
            FeeEntry.related_asset_id,
            func.coalesce(func.sum(FeeEntry.fee_value_in_base), 0),
        )
        .where(
            FeeEntry.version_id == version_id,
            FeeEntry.related_asset_id.isnot(None),
        )
        .group_by(FeeEntry.related_asset_id)
    ).all()
    return {int(r[0]): float(r[1]) for r in rows}


# ---------------------------------------------------------------------------
# Performer ranking
# ---------------------------------------------------------------------------

def _rank_performers_by_asset(
    all_asset_ids: set,
    now_balances: Dict[int, float],
    now_costs: Dict[int, float],
    now_prices: Dict[int, float],
    now_rpnl_by_asset: Dict[int, float],
    start_balances: Dict[int, float],
    start_costs: Dict[int, float],
    start_prices: Dict[int, float],
    start_rpnl_by_asset: Dict[int, float],
    asset_symbols: Dict[int, str],
    asset_labels: Dict[int, Optional[str]],
    range_key: str,
    top_n: int,
    fees_by_asset: Optional[Dict[int, float]] = None,
) -> Tuple[List[PerformerItem], List[PerformerItem]]:
    """Rank performers at asset level."""
    if fees_by_asset is None:
        fees_by_asset = {}
    performances: List[PerformerItem] = []

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

        if abs(qty_now) < 1e-12 and abs(cost_now) < 1e-12 and abs(asset_total_return) < 0.01:
            continue

        asset_roi = (asset_total_return / asset_roi_base * 100) if asset_roi_base != 0 else 0.0
        asset_fees = fees_by_asset.get(aid, 0.0)
        asset_efficiency = (asset_total_return / max(cost_now, 1.0))

        performances.append(PerformerItem(
            id=aid,
            name=asset_symbols.get(aid, f"#{aid}"),
            label=asset_labels.get(aid),
            group_type="asset",
            total_return=round(asset_total_return, 2),
            roi_pct=round(asset_roi, 2),
            unrealized_pnl=round(asset_unrealized, 2),
            market_value=round(asset_value, 2),
            cost_basis=round(cost_now, 2),
            total_fees=round(asset_fees, 2),
            efficiency=round(asset_efficiency, 4),
        ))

    return _sort_top_flop(performances, top_n)


def _rank_performers_by_account(
    session: Session,
    version_id: int,
    all_asset_ids: set,
    now_prices: Dict[int, float],
    start_prices: Dict[int, float],
    now_ds: str,
    start_ds: str,
    range_key: str,
    top_n: int,
    asset_ids: Optional[List[int]],
    account_ids: Optional[List[int]],
    include_unsettled_negative: bool,
    fees_by_asset: Optional[Dict[int, float]] = None,
) -> Tuple[List[PerformerItem], List[PerformerItem]]:
    """Rank performers at account level with proper server-side aggregation."""
    # Get current balances/costs per account
    acct_now = _get_current_from_cost_lots_by_account(
        session, version_id, asset_ids, account_ids, include_unsettled_negative
    )

    # Get realized PnL by account at now and start
    now_dt = datetime.now(timezone.utc)
    rpnl_by_acct = _get_cumulative_realized_pnl_by_account(
        session, version_id, [now_dt], asset_ids, account_ids
    )
    now_rpnl_acct = rpnl_by_acct.get(now_ds, {})

    # For period start
    start_rpnl_acct: Dict[int, float] = {}
    if range_key != "all":
        start_dt = now_dt - timedelta(days=PERIOD_RANGES.get(range_key, 0) or 0)
        rpnl_start = _get_cumulative_realized_pnl_by_account(
            session, version_id, [start_dt], asset_ids, account_ids
        )
        start_rpnl_acct = rpnl_start.get(start_dt.strftime("%Y-%m-%d"), {})

    # Account names
    all_acct_ids = list(acct_now.keys())
    acct_names: Dict[int, str] = {}
    if all_acct_ids:
        accounts = session.exec(select(Account).where(Account.id.in_(all_acct_ids))).all()
        acct_names = {a.id: a.name for a in accounts}

    performances: List[PerformerItem] = []
    for acct_id, (balances, costs) in acct_now.items():
        # Current value for this account
        current_val = sum(
            balances.get(aid, 0.0) * now_prices.get(aid, 0.0) for aid in balances
        )
        cost_basis = sum(costs.values())
        unrealized = current_val - cost_basis
        rpnl_now = now_rpnl_acct.get(acct_id, 0.0)
        rpnl_start = start_rpnl_acct.get(acct_id, 0.0)
        realized_in_period = rpnl_now - rpnl_start

        if range_key == "all":
            total_return = unrealized + rpnl_now
            roi_base = cost_basis
        else:
            # Approximate: we don't have per-account historical snapshots
            # so use total_return = unrealized_change + realized_in_period
            # with unrealized_change approximated from current state
            total_return = unrealized + realized_in_period
            roi_base = cost_basis

        if abs(cost_basis) < 1e-12 and abs(total_return) < 0.01:
            continue

        roi_pct = (total_return / roi_base * 100) if roi_base != 0 else 0.0

        # Aggregate fees for assets in this account
        acct_fees = 0.0
        if fees_by_asset:
            for aid in balances:
                acct_fees += fees_by_asset.get(aid, 0.0)
        eff = total_return / max(cost_basis, 1.0)

        performances.append(PerformerItem(
            id=acct_id,
            name=acct_names.get(acct_id, f"Account #{acct_id}"),
            label=None,
            group_type="account",
            total_return=round(total_return, 2),
            roi_pct=round(roi_pct, 2),
            unrealized_pnl=round(unrealized, 2),
            market_value=round(current_val, 2),
            cost_basis=round(cost_basis, 2),
            total_fees=round(acct_fees, 2),
            efficiency=round(eff, 4),
        ))

    return _sort_top_flop(performances, top_n)


def _rank_performers_by_category(
    session: Session,
    all_asset_ids: set,
    now_balances: Dict[int, float],
    now_costs: Dict[int, float],
    now_prices: Dict[int, float],
    now_rpnl_by_asset: Dict[int, float],
    start_balances: Dict[int, float],
    start_costs: Dict[int, float],
    start_prices: Dict[int, float],
    start_rpnl_by_asset: Dict[int, float],
    range_key: str,
    top_n: int,
    dimension_id: Optional[int] = None,
    fees_by_asset: Optional[Dict[int, float]] = None,
) -> Tuple[List[PerformerItem], List[PerformerItem]]:
    """Rank performers at category level using proper cost basis aggregation."""
    # Load asset → category mapping (optionally filtered by dimension)
    cat_query = (
        select(AssetCategory.asset_id, AssetCategory.category_id)
        .where(AssetCategory.asset_id.in_(list(all_asset_ids)))
    )
    if dimension_id is not None:
        cat_query = cat_query.join(Category, AssetCategory.category_id == Category.id).where(
            Category.dimension_id == dimension_id
        )
    cat_rows = session.exec(cat_query).all()

    asset_to_cats: Dict[int, List[int]] = defaultdict(list)
    for row in cat_rows:
        asset_to_cats[row.asset_id].append(row.category_id)

    # Category labels
    all_cat_ids = set()
    for cats in asset_to_cats.values():
        all_cat_ids.update(cats)
    cat_labels: Dict[int, str] = {}
    if all_cat_ids:
        categories = session.exec(select(Category).where(Category.id.in_(list(all_cat_ids)))).all()
        cat_labels = {c.id: c.label for c in categories}

    # Aggregate per-asset metrics into categories
    # When an asset belongs to N categories, split proportionally (1/N)
    if fees_by_asset is None:
        fees_by_asset = {}
    cat_data: Dict[int, Dict[str, float]] = defaultdict(
        lambda: {"total_return": 0.0, "cost_basis": 0.0, "unrealized_pnl": 0.0, "market_value": 0.0, "total_fees": 0.0}
    )

    for aid in all_asset_ids:
        cats = asset_to_cats.get(aid, [])
        if not cats:
            continue
        share = 1.0 / len(cats)

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
            asset_cost = cost_now
        else:
            qty_start = start_balances.get(aid, 0.0)
            price_start = start_prices.get(aid, 0.0)
            cost_start = start_costs.get(aid, 0.0)
            asset_unrealized_start = qty_start * price_start - cost_start
            asset_unrealized_change = asset_unrealized - asset_unrealized_start
            asset_total_return = asset_unrealized_change + asset_realized_in_period
            asset_cost = cost_start if cost_start != 0 else cost_now

        for cat_id in cats:
            cat_data[cat_id]["total_return"] += asset_total_return * share
            cat_data[cat_id]["cost_basis"] += asset_cost * share
            cat_data[cat_id]["unrealized_pnl"] += asset_unrealized * share
            cat_data[cat_id]["market_value"] += asset_value * share
            cat_data[cat_id]["total_fees"] += fees_by_asset.get(aid, 0.0) * share

    performances: List[PerformerItem] = []
    for cat_id, data in cat_data.items():
        tr = data["total_return"]
        cb = data["cost_basis"]
        upnl = data["unrealized_pnl"]
        mv = data["market_value"]
        fees = data["total_fees"]
        if abs(cb) < 1e-12 and abs(tr) < 0.01:
            continue
        roi = (tr / cb * 100) if cb != 0 else 0.0
        eff = tr / max(cb, 1.0)
        performances.append(PerformerItem(
            id=cat_id,
            name=cat_labels.get(cat_id, f"Category #{cat_id}"),
            label=None,
            group_type="category",
            total_return=round(tr, 2),
            roi_pct=round(roi, 2),
            unrealized_pnl=round(upnl, 2),
            market_value=round(mv, 2),
            cost_basis=round(cb, 2),
            total_fees=round(fees, 2),
            efficiency=round(eff, 4),
        ))

    return _sort_top_flop(performances, top_n)


def _sort_top_flop(
    performances: List[PerformerItem],
    top_n: int,
) -> Tuple[List[PerformerItem], List[PerformerItem]]:
    """Sort performers and extract top + flop lists."""
    # Top: only non-negative returns, sorted best-first
    top = sorted(
        [p for p in performances if p.total_return >= 0],
        key=lambda a: a.total_return,
        reverse=True,
    )[:top_n]
    # Flop: only negative-return items, sorted worst-first, capped at top_n
    flop = sorted(
        [p for p in performances if p.total_return < 0],
        key=lambda a: a.total_return,
    )[:top_n]
    return top, flop


# ---------------------------------------------------------------------------
# Main public function
# ---------------------------------------------------------------------------

def compute_version_metrics(
    session: Session,
    version_id: int,
    periods: Optional[List[str]] = None,
    group_by: str = "asset",
    top_n: int = 5,
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    category_ids: Optional[List[int]] = None,
    dimension_id: Optional[int] = None,
    include_unsettled_negative: bool = False,
    refresh_prices: bool = True,
) -> Optional[VersionMetrics]:
    """
    Compute all PnL metrics for a version.

    This is the single entry point for all metric computation. It guarantees
    consistency across realized/unrealized P&L, market value, and performers.

    Args:
        periods: Which period ranges to compute. Default: all of them.
        group_by: How to rank performers: 'asset', 'account', 'category'.
        top_n: Number of top/flop performers to return.
        refresh_prices: If True, fetch fresh prices before computing.

    Returns:
        VersionMetrics with summary (all-time) + per-period range metrics,
        or None if version not found.
    """
    version = session.get(CalculationVersion, version_id)
    if not version:
        return None

    if periods is None:
        periods = list(PERIOD_RANGES.keys())

    # Resolve category filter to asset_ids
    if category_ids:
        resolved = _resolve_category_to_asset_ids(session, category_ids, asset_ids)
        if resolved is None:
            return VersionMetrics(
                version_id=version_id,
                summary=SummaryMetrics(0, 0, 0, 0, 0, 0, 0),
            )
        asset_ids = resolved

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
        total_fees, fee_count = _compute_fee_summary(session, version_id)
        return VersionMetrics(
            version_id=version_id,
            summary=SummaryMetrics(0, 0, 0, 0, 0, total_fees, fee_count),
        )

    now = datetime.now(timezone.utc)
    if min_date.tzinfo is None:
        min_date = min_date.replace(tzinfo=timezone.utc)
    if max_date.tzinfo is None:
        max_date = max_date.replace(tzinfo=timezone.utc)

    # Get authoritative current balances/costs from CostLot
    now_lot_balances, now_lot_costs = _get_current_from_cost_lots(
        session, version_id, asset_ids, account_ids,
        include_unsettled_negative=include_unsettled_negative,
    )

    # Collect all held asset IDs
    all_asset_ids = set(now_lot_balances.keys()) | set(now_lot_costs.keys())
    all_asset_ids_list = list(all_asset_ids)

    # Refresh prices for held assets
    if refresh_prices and all_asset_ids_list:
        _refresh_prices_for_assets(session, all_asset_ids_list, version.base_currency_id)

    # Build boundary dates
    boundary_dates = [now]
    range_starts: Dict[str, datetime] = {}
    for key in periods:
        days = PERIOD_RANGES.get(key)
        if days is None:
            range_starts[key] = min_date
        else:
            cutoff = now - timedelta(days=days)
            range_starts[key] = max(cutoff, min_date)
        boundary_dates.append(range_starts[key])

    unique_dates = sorted(set(boundary_dates))

    # Fetch historical snapshots at boundary dates
    balance_snapshots = _get_balance_snapshots_at_dates(
        session, version_id, unique_dates, asset_ids, account_ids,
        include_unsettled_negative=include_unsettled_negative,
    )
    cost_basis_snapshots = _get_cost_basis_snapshots_at_dates(
        session, version_id, unique_dates, asset_ids, account_ids,
        include_unsettled_negative=include_unsettled_negative,
    )

    # Override "now" bucket with authoritative CostLot data
    now_ds = now.strftime("%Y-%m-%d")
    balance_snapshots[now_ds] = now_lot_balances
    cost_basis_snapshots[now_ds] = now_lot_costs

    # Also include assets from historical snapshots
    for balances in balance_snapshots.values():
        all_asset_ids.update(balances.keys())
    all_asset_ids_list = list(all_asset_ids)

    # Prices and realized PnL
    price_snapshots = _get_price_at_dates(
        session, version.base_currency_id, all_asset_ids_list, unique_dates
    )

    # All realized (for portfolio performance)
    cumulative_rpnl = _get_cumulative_realized_pnl(
        session, version_id, unique_dates, asset_ids, account_ids,
        taxable_only=False,
    )
    # Taxable only (for separate field)
    cumulative_rpnl_taxable = _get_cumulative_realized_pnl(
        session, version_id, [now], asset_ids, account_ids,
        taxable_only=True,
    )

    asset_symbols = _get_asset_symbols(session, all_asset_ids_list)
    asset_labels = _get_asset_labels(session, all_asset_ids_list)
    fees_by_asset = _get_fees_by_asset(session, version_id)

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
    taxable_rpnl_total = cumulative_rpnl_taxable.get(now_ds, (0.0, {}))[0]

    # Compute portfolio-level "now" values (constant across periods)
    current_value = sum(
        now_balances.get(aid, 0.0) * now_prices.get(aid, 0.0)
        for aid in all_asset_ids
    )
    cost_basis = sum(now_costs.get(aid, 0.0) for aid in all_asset_ids)
    unrealized_pnl = current_value - cost_basis
    realized_pnl = now_rpnl_total

    # Fee summary
    total_fees, fee_count = _compute_fee_summary(session, version_id)

    summary = SummaryMetrics(
        current_value=round(current_value, 2),
        cost_basis=round(cost_basis, 2),
        unrealized_pnl=round(unrealized_pnl, 2),
        realized_pnl=round(realized_pnl, 2),
        taxable_realized_pnl=round(taxable_rpnl_total, 2),
        total_fees=round(total_fees, 2),
        fee_entry_count=fee_count,
    )

    # Compute per-period metrics
    ranges: Dict[str, RangeMetrics] = {}

    for range_key, start_dt in range_starts.items():
        start_balances, start_costs, start_prices, start_rpnl = _snapshot_at(start_dt)
        start_rpnl_total, start_rpnl_by_asset = start_rpnl

        realized_in_period = now_rpnl_total - start_rpnl_total

        if range_key == "all":
            total_return = unrealized_pnl + realized_pnl
            roi_base = cost_basis
            cost_basis_in_period = cost_basis
            unrealized_in_period = unrealized_pnl
            fees_in_period = total_fees
        else:
            start_value = sum(
                start_balances.get(aid, 0.0) * start_prices.get(aid, 0.0)
                for aid in all_asset_ids
            )
            start_cost = sum(start_costs.get(aid, 0.0) for aid in all_asset_ids)
            start_unrealized = start_value - start_cost
            unrealized_change = unrealized_pnl - start_unrealized
            total_return = unrealized_change + realized_in_period
            roi_base = start_cost if start_cost != 0 else cost_basis
            cost_basis_in_period = cost_basis - start_cost
            unrealized_in_period = unrealized_change
            fees_in_period = _compute_fees_in_period(session, version_id, start_dt, now)

        roi_pct = (total_return / roi_base * 100) if roi_base != 0 else 0.0

        # Rank performers based on group_by
        if group_by == "account":
            top, flop = _rank_performers_by_account(
                session, version_id, all_asset_ids, now_prices, start_prices,
                now_ds, start_dt.strftime("%Y-%m-%d"), range_key, top_n,
                asset_ids, account_ids, include_unsettled_negative,
            )
        elif group_by == "category":
            top, flop = _rank_performers_by_category(
                session, all_asset_ids,
                now_balances, now_costs, now_prices, now_rpnl_by_asset,
                start_balances, start_costs, start_prices, start_rpnl_by_asset,
                range_key, top_n, dimension_id, fees_by_asset,
            )
        else:  # "asset"
            top, flop = _rank_performers_by_asset(
                all_asset_ids,
                now_balances, now_costs, now_prices, now_rpnl_by_asset,
                start_balances, start_costs, start_prices, start_rpnl_by_asset,
                asset_symbols, asset_labels,
                range_key, top_n, fees_by_asset,
            )

        ranges[range_key] = RangeMetrics(
            total_return=round(total_return, 2),
            roi_pct=round(roi_pct, 2),
            current_value=round(current_value, 2),
            cost_basis=round(cost_basis, 2),
            unrealized_pnl=round(unrealized_pnl, 2),
            realized_pnl=round(realized_pnl, 2),
            taxable_realized_pnl=round(taxable_rpnl_total, 2),
            realized_in_period=round(realized_in_period, 2),
            cost_basis_in_period=round(cost_basis_in_period, 2),
            unrealized_in_period=round(unrealized_in_period, 2),
            fees_in_period=round(fees_in_period, 2),
            top_performers=top,
            flop_performers=flop,
        )

    log.info(
        "version_metrics_computed",
        version_id=version_id,
        ranges=list(ranges.keys()),
        group_by=group_by,
    )

    return VersionMetrics(
        version_id=version_id,
        summary=summary,
        ranges=ranges,
    )


# ---------------------------------------------------------------------------
# Settled metrics (no market prices needed)
# ---------------------------------------------------------------------------

def compute_settled_metrics(
    session: Session,
    version_id: int,
    periods: Optional[List[str]] = None,
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    category_ids: Optional[List[int]] = None,
    include_unsettled_negative: bool = False,
) -> Optional[SettledVersionMetrics]:
    """
    Compute cost-lot-based metrics that don't require market prices.
    Returns immediately without any price lookup — ideal for instant display.
    """
    version = session.get(CalculationVersion, version_id)
    if not version:
        return None

    if periods is None:
        periods = list(PERIOD_RANGES.keys())

    if category_ids:
        resolved = _resolve_category_to_asset_ids(session, category_ids, asset_ids)
        if resolved is None:
            return SettledVersionMetrics(
                version_id=version_id,
                summary=SettledSummary(0, 0, 0, 0, 0),
            )
        asset_ids = resolved

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

    total_fees, fee_count = _compute_fee_summary(session, version_id)

    if not min_date or not max_date:
        return SettledVersionMetrics(
            version_id=version_id,
            summary=SettledSummary(0, 0, 0, total_fees, fee_count),
        )

    now = datetime.now(timezone.utc)
    if min_date.tzinfo is None:
        min_date = min_date.replace(tzinfo=timezone.utc)

    # Current cost basis from CostLot (no prices needed)
    _, now_lot_costs = _get_current_from_cost_lots(
        session, version_id, asset_ids, account_ids,
        include_unsettled_negative=include_unsettled_negative,
    )
    all_asset_ids = set(now_lot_costs.keys())
    cost_basis = sum(now_lot_costs.values())

    # Build boundary dates
    boundary_dates = [now]
    range_starts: Dict[str, datetime] = {}
    for key in periods:
        days = PERIOD_RANGES.get(key)
        if days is None:
            range_starts[key] = min_date
        else:
            cutoff = now - timedelta(days=days)
            range_starts[key] = max(cutoff, min_date)
        boundary_dates.append(range_starts[key])

    unique_dates = sorted(set(boundary_dates))

    # Historical cost snapshots (no prices, no balance needed)
    cost_basis_snapshots = _get_cost_basis_snapshots_at_dates(
        session, version_id, unique_dates, asset_ids, account_ids,
        include_unsettled_negative=include_unsettled_negative,
    )
    now_ds = now.strftime("%Y-%m-%d")
    cost_basis_snapshots[now_ds] = now_lot_costs

    # Realized PnL
    cumulative_rpnl = _get_cumulative_realized_pnl(
        session, version_id, unique_dates, asset_ids, account_ids,
        taxable_only=False,
    )
    cumulative_rpnl_taxable = _get_cumulative_realized_pnl(
        session, version_id, [now], asset_ids, account_ids,
        taxable_only=True,
    )

    now_rpnl_total = cumulative_rpnl.get(now_ds, (0.0, {}))[0]
    taxable_rpnl_total = cumulative_rpnl_taxable.get(now_ds, (0.0, {}))[0]

    summary = SettledSummary(
        cost_basis=round(cost_basis, 2),
        realized_pnl=round(now_rpnl_total, 2),
        taxable_realized_pnl=round(taxable_rpnl_total, 2),
        total_fees=round(total_fees, 2),
        fee_entry_count=fee_count,
    )

    ranges: Dict[str, SettledRangeMetrics] = {}
    for range_key, start_dt in range_starts.items():
        start_ds = start_dt.strftime("%Y-%m-%d")
        start_costs = cost_basis_snapshots.get(start_ds, {})
        start_rpnl_total = cumulative_rpnl.get(start_ds, (0.0, {}))[0]

        realized_in_period = now_rpnl_total - start_rpnl_total

        if range_key == "all":
            cost_basis_in_period = cost_basis
            fees_in_period = total_fees
        else:
            start_cost = sum(start_costs.get(aid, 0.0) for aid in all_asset_ids)
            cost_basis_in_period = cost_basis - start_cost
            fees_in_period = _compute_fees_in_period(session, version_id, start_dt, now)

        ranges[range_key] = SettledRangeMetrics(
            cost_basis=round(cost_basis, 2),
            realized_pnl=round(now_rpnl_total, 2),
            taxable_realized_pnl=round(taxable_rpnl_total, 2),
            realized_in_period=round(realized_in_period, 2),
            cost_basis_in_period=round(cost_basis_in_period, 2),
            fees_in_period=round(fees_in_period, 2),
        )

    log.info("settled_metrics_computed", version_id=version_id, ranges=list(ranges.keys()))

    return SettledVersionMetrics(
        version_id=version_id,
        summary=summary,
        ranges=ranges,
    )


# ---------------------------------------------------------------------------
# Standalone performer ranking
# ---------------------------------------------------------------------------

def compute_performers(
    session: Session,
    version_id: int,
    period: str = "all",
    group_by: str = "asset",
    top_n: int = 5,
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    category_ids: Optional[List[int]] = None,
    dimension_id: Optional[int] = None,
    include_unsettled_negative: bool = False,
) -> Optional[PerformersResult]:
    """
    Compute top/flop performers for a single period and group_by dimension.
    Reads prices from PriceSnapshot (no refresh). Designed for isolated
    re-fetching when the user changes group_by without re-computing all metrics.
    """
    version = session.get(CalculationVersion, version_id)
    if not version:
        return None

    if category_ids:
        resolved = _resolve_category_to_asset_ids(session, category_ids, asset_ids)
        if resolved is None:
            return PerformersResult(version_id=version_id, period=period, group_type=group_by)
        asset_ids = resolved

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
        return PerformersResult(version_id=version_id, period=period, group_type=group_by)

    now = datetime.now(timezone.utc)
    if min_date.tzinfo is None:
        min_date = min_date.replace(tzinfo=timezone.utc)

    # Current balances/costs
    now_lot_balances, now_lot_costs = _get_current_from_cost_lots(
        session, version_id, asset_ids, account_ids,
        include_unsettled_negative=include_unsettled_negative,
    )
    all_asset_ids = set(now_lot_balances.keys()) | set(now_lot_costs.keys())

    # Compute start date for this period
    days = PERIOD_RANGES.get(period)
    if days is None:
        start_dt = min_date
    else:
        cutoff = now - timedelta(days=days)
        start_dt = max(cutoff, min_date)

    unique_dates = sorted(set([now, start_dt]))

    # Snapshots
    balance_snapshots = _get_balance_snapshots_at_dates(
        session, version_id, unique_dates, asset_ids, account_ids,
        include_unsettled_negative=include_unsettled_negative,
    )
    cost_basis_snapshots = _get_cost_basis_snapshots_at_dates(
        session, version_id, unique_dates, asset_ids, account_ids,
        include_unsettled_negative=include_unsettled_negative,
    )
    now_ds = now.strftime("%Y-%m-%d")
    balance_snapshots[now_ds] = now_lot_balances
    cost_basis_snapshots[now_ds] = now_lot_costs

    for balances in balance_snapshots.values():
        all_asset_ids.update(balances.keys())
    all_asset_ids_list = list(all_asset_ids)

    price_snapshots = _get_price_at_dates(
        session, version.base_currency_id, all_asset_ids_list, unique_dates
    )

    cumulative_rpnl = _get_cumulative_realized_pnl(
        session, version_id, unique_dates, asset_ids, account_ids,
        taxable_only=False,
    )

    asset_symbols = _get_asset_symbols(session, all_asset_ids_list)
    asset_labels = _get_asset_labels(session, all_asset_ids_list)
    fees_by_asset = _get_fees_by_asset(session, version_id)

    now_balances = balance_snapshots.get(now_ds, {})
    now_costs = cost_basis_snapshots.get(now_ds, {})
    now_prices = price_snapshots.get(now_ds, {})
    _, now_rpnl_by_asset = cumulative_rpnl.get(now_ds, (0.0, {}))

    start_ds = start_dt.strftime("%Y-%m-%d")
    start_balances = balance_snapshots.get(start_ds, {})
    start_costs = cost_basis_snapshots.get(start_ds, {})
    start_prices = price_snapshots.get(start_ds, {})
    _, start_rpnl_by_asset = cumulative_rpnl.get(start_ds, (0.0, {}))

    if group_by == "account":
        top, flop = _rank_performers_by_account(
            session, version_id, all_asset_ids, now_prices, start_prices,
            now_ds, start_ds, period, top_n,
            asset_ids, account_ids, include_unsettled_negative,
            fees_by_asset,
        )
    elif group_by == "category":
        top, flop = _rank_performers_by_category(
            session, all_asset_ids,
            now_balances, now_costs, now_prices, now_rpnl_by_asset,
            start_balances, start_costs, start_prices, start_rpnl_by_asset,
            period, top_n, dimension_id, fees_by_asset,
        )
    else:
        top, flop = _rank_performers_by_asset(
            all_asset_ids,
            now_balances, now_costs, now_prices, now_rpnl_by_asset,
            start_balances, start_costs, start_prices, start_rpnl_by_asset,
            asset_symbols, asset_labels,
            period, top_n, fees_by_asset,
        )

    log.info("performers_computed", version_id=version_id, period=period, group_by=group_by)

    return PerformersResult(
        version_id=version_id,
        period=period,
        group_type=group_by,
        top_performers=top,
        flop_performers=flop,
    )


# ---------------------------------------------------------------------------
# Market metrics (price-dependent, reads from PriceSnapshot)
# ---------------------------------------------------------------------------

def compute_market_metrics(
    session: Session,
    version_id: int,
    periods: Optional[List[str]] = None,
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    category_ids: Optional[List[int]] = None,
    include_unsettled_negative: bool = False,
) -> Optional[MarketVersionMetrics]:
    """
    Compute price-dependent metrics using prices already in PriceSnapshot.
    Does NOT refresh prices — trusts that frontend already updated them.
    Returns current_value, unrealized_pnl, and per-period total_return/roi_pct.
    """
    version = session.get(CalculationVersion, version_id)
    if not version:
        return None

    if periods is None:
        periods = list(PERIOD_RANGES.keys())

    if category_ids:
        resolved = _resolve_category_to_asset_ids(session, category_ids, asset_ids)
        if resolved is None:
            return MarketVersionMetrics(
                version_id=version_id,
                summary=MarketSummary(0, 0),
            )
        asset_ids = resolved

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
        return MarketVersionMetrics(
            version_id=version_id,
            summary=MarketSummary(0, 0),
        )

    now = datetime.now(timezone.utc)
    if min_date.tzinfo is None:
        min_date = min_date.replace(tzinfo=timezone.utc)

    # Current balances and costs from CostLot
    now_lot_balances, now_lot_costs = _get_current_from_cost_lots(
        session, version_id, asset_ids, account_ids,
        include_unsettled_negative=include_unsettled_negative,
    )
    all_asset_ids = set(now_lot_balances.keys()) | set(now_lot_costs.keys())

    # Build boundary dates
    boundary_dates = [now]
    range_starts: Dict[str, datetime] = {}
    for key in periods:
        days = PERIOD_RANGES.get(key)
        if days is None:
            range_starts[key] = min_date
        else:
            cutoff = now - timedelta(days=days)
            range_starts[key] = max(cutoff, min_date)
        boundary_dates.append(range_starts[key])

    unique_dates = sorted(set(boundary_dates))

    # Snapshots
    balance_snapshots = _get_balance_snapshots_at_dates(
        session, version_id, unique_dates, asset_ids, account_ids,
        include_unsettled_negative=include_unsettled_negative,
    )
    cost_basis_snapshots = _get_cost_basis_snapshots_at_dates(
        session, version_id, unique_dates, asset_ids, account_ids,
        include_unsettled_negative=include_unsettled_negative,
    )
    now_ds = now.strftime("%Y-%m-%d")
    balance_snapshots[now_ds] = now_lot_balances
    cost_basis_snapshots[now_ds] = now_lot_costs

    for balances in balance_snapshots.values():
        all_asset_ids.update(balances.keys())
    all_asset_ids_list = list(all_asset_ids)

    # Prices from PriceSnapshot (no refresh)
    price_snapshots = _get_price_at_dates(
        session, version.base_currency_id, all_asset_ids_list, unique_dates
    )

    # Realized PnL (needed for total_return = unrealized_change + realized_in_period)
    cumulative_rpnl = _get_cumulative_realized_pnl(
        session, version_id, unique_dates, asset_ids, account_ids,
        taxable_only=False,
    )

    now_balances = balance_snapshots.get(now_ds, {})
    now_costs = cost_basis_snapshots.get(now_ds, {})
    now_prices = price_snapshots.get(now_ds, {})
    now_rpnl_total = cumulative_rpnl.get(now_ds, (0.0, {}))[0]

    # Portfolio-level current values
    current_value = sum(
        now_balances.get(aid, 0.0) * now_prices.get(aid, 0.0)
        for aid in all_asset_ids
    )
    cost_basis = sum(now_costs.get(aid, 0.0) for aid in all_asset_ids)
    unrealized_pnl = current_value - cost_basis

    summary = MarketSummary(
        current_value=round(current_value, 2),
        unrealized_pnl=round(unrealized_pnl, 2),
    )

    # Per-period market metrics
    ranges: Dict[str, MarketRangeMetrics] = {}
    for range_key, start_dt in range_starts.items():
        start_ds = start_dt.strftime("%Y-%m-%d")
        start_balances = balance_snapshots.get(start_ds, {})
        start_costs = cost_basis_snapshots.get(start_ds, {})
        start_prices = price_snapshots.get(start_ds, {})
        start_rpnl_total = cumulative_rpnl.get(start_ds, (0.0, {}))[0]

        realized_in_period = now_rpnl_total - start_rpnl_total

        if range_key == "all":
            unrealized_in_period = unrealized_pnl
            total_return = unrealized_pnl + now_rpnl_total
            roi_base = cost_basis
        else:
            start_value = sum(
                start_balances.get(aid, 0.0) * start_prices.get(aid, 0.0)
                for aid in all_asset_ids
            )
            start_cost = sum(start_costs.get(aid, 0.0) for aid in all_asset_ids)
            start_unrealized = start_value - start_cost
            unrealized_in_period = unrealized_pnl - start_unrealized
            total_return = unrealized_in_period + realized_in_period
            roi_base = start_cost if start_cost != 0 else cost_basis

        roi_pct = (total_return / roi_base * 100) if roi_base != 0 else 0.0

        ranges[range_key] = MarketRangeMetrics(
            current_value=round(current_value, 2),
            unrealized_pnl=round(unrealized_pnl, 2),
            unrealized_in_period=round(unrealized_in_period, 2),
            total_return=round(total_return, 2),
            roi_pct=round(roi_pct, 2),
        )

    log.info("market_metrics_computed", version_id=version_id, ranges=list(ranges.keys()))

    return MarketVersionMetrics(
        version_id=version_id,
        summary=summary,
        ranges=ranges,
    )
