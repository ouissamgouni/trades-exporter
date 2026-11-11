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
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Dict, List, Optional, Tuple

from sqlalchemy import case, func, or_
from sqlmodel import Session, select

from backend.db.models import (
    Account,
    Asset,
    AssetCategory,
    CalculationUnit,
    CalculationUnitLeg,
    CalculationVersion,
    Category,
    ConsumedLotSlice,
    CostLot,
    CostLotEvent,
    FeeEntry,
    IncomeEvent,
    NormalizedTransaction,
    PriceSnapshot,
    RealizedPnl,
    ECONOMIC_PNL,
    ECONOMIC_UNIT_COST,
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
    realized_pnl: float = 0.0  # all-time for "all", realized in period otherwise
    income: float = 0.0  # net income (all-time for "all", in period otherwise)
    roi_base: float = 0.0


# ---------------------------------------------------------------------------
# Book metrics (cost-lot-based, no market prices needed)
# ---------------------------------------------------------------------------


@dataclass
class BookSummary:
    """All-time book summary (cost-lot-based, no prices needed)."""

    cost_basis: float
    realized_pnl: float
    taxable_realized_pnl: float
    total_fees: float
    fee_entry_count: int
    total_invested: float = 0.0
    deferred_gain: float = 0.0
    net_deposits: float = 0.0
    unfunded_spend: float = 0.0
    total_income: float = 0.0
    total_withholding: float = 0.0
    income_event_count: int = 0


@dataclass
class BookRangeMetrics:
    """Per-period book metrics (no market prices needed)."""

    cost_basis: float
    realized_pnl: float
    taxable_realized_pnl: float
    realized_in_period: float
    cost_basis_in_period: float
    fees_in_period: float
    total_invested: float = 0.0
    deferred_gain: float = 0.0
    net_deposits: float = 0.0
    income_in_period: float = 0.0
    withholding_in_period: float = 0.0


@dataclass
class BookVersionMetrics:
    """Book metrics result (fast, no price lookup)."""

    version_id: int
    summary: BookSummary
    ranges: Dict[str, BookRangeMetrics] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Live metrics (price-dependent)
# ---------------------------------------------------------------------------


@dataclass
class LiveSummary:
    """All-time live summary (price-dependent)."""

    current_value: float
    unrealized_pnl: float


@dataclass
class LiveRangeMetrics:
    """Per-period live metrics (price-dependent)."""

    current_value: float
    unrealized_pnl: float
    unrealized_in_period: float
    total_return: float
    roi_pct: float


@dataclass
class LiveVersionMetrics:
    """Live metrics result (requires prices from PriceSnapshot)."""

    version_id: int
    summary: LiveSummary
    ranges: Dict[str, LiveRangeMetrics] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Combined metrics (book + live + performers)
# ---------------------------------------------------------------------------


@dataclass
class SummaryMetrics(BookSummary):
    """All-time portfolio summary. Extends BookSummary with live price fields."""

    current_value: float = 0.0
    unrealized_pnl: float = 0.0


@dataclass
class RangeMetrics(BookRangeMetrics):
    """Combined per-period metrics with live data and performers."""

    total_return: float = 0.0
    roi_pct: float = 0.0
    current_value: float = 0.0
    unrealized_pnl: float = 0.0
    unrealized_in_period: float = 0.0
    top_performers: List[PerformerItem] = field(default_factory=list)
    flop_performers: List[PerformerItem] = field(default_factory=list)


@dataclass
class VersionMetrics:
    """Complete metrics result returned by compute_version_metrics."""

    version_id: int
    summary: SummaryMetrics
    ranges: Dict[str, RangeMetrics] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Other result types
# ---------------------------------------------------------------------------


@dataclass
class PerformersResult:
    """Standalone performer ranking result."""

    version_id: int
    period: str
    group_type: str
    top_performers: List[PerformerItem] = field(default_factory=list)
    flop_performers: List[PerformerItem] = field(default_factory=list)
    total_count: int = 0
    # Asset-level totals, independent of group_type
    gains_total: float = 0.0
    losses_total: float = 0.0
    net_total: float = 0.0


@dataclass
class AssetPeriodDelta:
    """Per-asset period delta metrics."""

    asset_id: int
    symbol: str
    label: Optional[str]
    total_return: float
    roi_pct: float
    unrealized_change: float
    realized_in_period: float
    cost_change: float
    market_value_change: float
    income_in_period: float = 0.0


# ---------------------------------------------------------------------------
# Internal helpers (moved from portfolio_timeline.py)
# ---------------------------------------------------------------------------


def _ensure_naive(dt: datetime) -> datetime:
    """Strip timezone info so comparisons with DB-naive timestamps work."""
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


# Patterns that represent real cash expenditure (include in total_invested)
_INVESTMENT_PATTERNS = ["swap", "flow"]


def _get_current_from_cost_lots(
    session: Session,
    version_id: int,
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    include_unsettled_negative: bool = False,
) -> Tuple[Dict[int, float], Dict[int, float], Dict[int, float]]:
    """
    Get current balances and cost basis directly from CostLot records.

    This is the authoritative source used by the /balances endpoint.

    Returns:
        (balances, remaining_costs, total_invested) where each is { asset_id: value }
        - balances: current remaining qty per asset
        - remaining_costs: remaining cost basis (qty_remaining × unit_cost_in_base)
        - total_invested: cash actually spent (only swap/flow patterns)
    """
    # Only count lots from real acquisitions (swap/flow/unknown) toward total_invested.
    # Lots created by spinoff, internal_transfer, split, custom are cost
    # redistributions — not new cash expenditure.
    invested_expr = func.sum(
        case(
            (
                CalculationUnit.pattern.in_(_INVESTMENT_PATTERNS),
                CostLot.qty * ECONOMIC_UNIT_COST,
            ),
            (CalculationUnit.pattern.is_(None), CostLot.qty * ECONOMIC_UNIT_COST),
            else_=0,
        )
    ).label("total_invested")

    query = (
        select(
            CostLot.asset_id,
            func.sum(CostLot.qty_remaining).label("total_qty"),
            func.sum(CostLot.qty_remaining * ECONOMIC_UNIT_COST).label("total_cost"),
            invested_expr,
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
    remaining_costs: Dict[int, float] = {}
    total_invested: Dict[int, float] = {}
    for row in rows:
        aid = row.asset_id
        qty = float(row.total_qty or 0)
        cost = float(row.total_cost or 0)
        invested = float(row.total_invested or 0)
        if abs(qty) > 1e-12 or abs(cost) > 1e-12:
            balances[aid] = qty
            remaining_costs[aid] = cost
            total_invested[aid] = invested

    return balances, remaining_costs, total_invested


def _get_deferred_gain(
    session: Session,
    version_id: int,
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
) -> float:
    """Gain recognized economically but not yet taxed: economic minus tax cost of open lots."""
    query = (
        select(
            func.coalesce(
                func.sum(
                    CostLot.qty_remaining
                    * (CostLot.economic_unit_cost_in_base - CostLot.unit_cost_in_base)
                ),
                0,
            )
        )
        .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
        .where(CostLot.economic_unit_cost_in_base.isnot(None))
        .where(CostLot.is_negative == False)  # noqa: E712
    )
    if asset_ids:
        query = query.where(CostLot.asset_id.in_(asset_ids))
    if account_ids:
        query = query.where(CostLot.account_id.in_(account_ids))
    return float(session.exec(query).one() or 0)


def _get_net_deposits(
    session: Session,
    version_id: int,
    base_currency_id: Optional[int],
    account_ids: Optional[List[int]] = None,
    since: Optional[datetime] = None,
) -> float:
    """Money brought in from outside minus money taken out, valued when it moved.

    External flows (deposits, withdrawals, payments, airdrops) are FLOW units;
    income events are excluded. For an account scope, internal transfers in/out
    of the scope also count, at the economic cost they carry.
    """
    income_units = select(IncomeEvent.unit_id).where(IncomeEvent.unit_id.isnot(None))
    since_naive = _ensure_naive(since) if since else None

    def lots_in(pattern: str) -> float:
        q = (
            select(func.coalesce(func.sum(CostLot.qty * ECONOMIC_UNIT_COST), 0))
            .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
            .where(CalculationUnit.version_id == version_id)
            .where(CalculationUnit.pattern == pattern)
            .where(CalculationUnit.id.notin_(income_units))
            .where(CostLot.is_negative == False)  # noqa: E712
        )
        if account_ids:
            q = q.where(CostLot.account_id.in_(account_ids))
        if since_naive:
            q = q.where(CalculationUnit.timestamp >= since_naive)
        return float(session.exec(q).one() or 0)

    deposits = lots_in("flow")

    base_out = 0.0
    if base_currency_id:
        q = (
            select(func.coalesce(func.sum(CalculationUnitLeg.quantity), 0))
            .join(CalculationUnit, CalculationUnitLeg.unit_id == CalculationUnit.id)
            .join(
                NormalizedTransaction,
                NormalizedTransaction.id == CalculationUnitLeg.transaction_id,
            )
            .where(CalculationUnit.version_id == version_id)
            .where(CalculationUnit.pattern == "flow")
            .where(CalculationUnitLeg.leg_type == "outflow")
            .where(CalculationUnitLeg.asset_id == base_currency_id)
        )
        if account_ids:
            q = q.where(NormalizedTransaction.account_id.in_(account_ids))
        if since_naive:
            q = q.where(CalculationUnit.timestamp >= since_naive)
        base_out = float(session.exec(q).one() or 0)

    q = (
        select(func.coalesce(func.sum(RealizedPnl.proceeds_in_base), 0))
        .join(CalculationUnit, RealizedPnl.origin_unit_id == CalculationUnit.id)
        .join(
            NormalizedTransaction,
            NormalizedTransaction.id == RealizedPnl.transaction_id,
        )
        .where(CalculationUnit.version_id == version_id)
        .where(CalculationUnit.pattern == "flow")
        .where(
            RealizedPnl.pnl_id.notin_(
                select(FeeEntry.realized_pnl_id).where(
                    FeeEntry.realized_pnl_id.isnot(None)
                )
            )
        )
    )
    if base_currency_id:
        q = q.where(RealizedPnl.asset_id != base_currency_id)
    if account_ids:
        q = q.where(NormalizedTransaction.account_id.in_(account_ids))
    if since_naive:
        q = q.where(CalculationUnit.timestamp >= since_naive)
    other_out = float(session.exec(q).one() or 0)

    net = deposits - base_out - other_out

    if account_ids:
        transfers_in = lots_in("internal_transfer")
        q = (
            select(
                func.coalesce(
                    func.sum(
                        func.coalesce(
                            ConsumedLotSlice.economic_total_cost_in_base,
                            ConsumedLotSlice.total_cost_in_base,
                        )
                    ),
                    0,
                )
            )
            .join(CalculationUnit, ConsumedLotSlice.unit_id == CalculationUnit.id)
            .join(CostLot, CostLot.cost_lot_id == ConsumedLotSlice.cost_lot_id)
            .where(CalculationUnit.version_id == version_id)
            .where(CalculationUnit.pattern == "internal_transfer")
            .where(CostLot.account_id.in_(account_ids))
        )
        if since_naive:
            q = q.where(CalculationUnit.timestamp >= since_naive)
        net += transfers_in - float(session.exec(q).one() or 0)

    return net


def _get_unfunded_spend(
    session: Session,
    version_id: int,
    base_currency_id: Optional[int],
    account_ids: Optional[List[int]] = None,
) -> float:
    """Base currency spent before it was funded: negative lots, at the cost they were spent."""
    if not base_currency_id:
        return 0.0
    q = (
        select(func.coalesce(func.sum(-CostLot.qty * ECONOMIC_UNIT_COST), 0))
        .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
        .where(CostLot.is_negative == True)  # noqa: E712
        .where(CostLot.asset_id == base_currency_id)
    )
    if account_ids:
        q = q.where(CostLot.account_id.in_(account_ids))
    return float(session.execute(q).scalar_one() or 0)


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
            func.sum(CostLot.qty_remaining * ECONOMIC_UNIT_COST).label("total_cost"),
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
            ECONOMIC_UNIT_COST.label("unit_cost_in_base"),
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
        (
            _ensure_naive(e.timestamp),
            e.lot_id,
            e.asset_id,
            float(e.qty_remaining_after),
            float(e.unit_cost_in_base),
        )
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


def _get_invested_snapshots_at_dates(
    session: Session,
    version_id: int,
    bucket_dates: List[datetime],
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    include_unsettled_negative: bool = False,
) -> Dict[str, Dict[int, float]]:
    """
    For each date bucket, compute cumulative invested per asset.

    Uses CostLot.acquired_at for timing and current qty × unit_cost for the
    amount.  Only includes swap/flow/None patterns (real cash expenditure).

    Returns: { date_str: { asset_id: cumulative_invested } }
    """
    if not bucket_dates:
        return {}

    query = (
        select(
            CostLot.acquired_at,
            CostLot.asset_id,
            (CostLot.qty * ECONOMIC_UNIT_COST).label("invested"),
        )
        .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
        .where(
            or_(
                CalculationUnit.pattern.in_(_INVESTMENT_PATTERNS),
                CalculationUnit.pattern.is_(None),
            )
        )
        .order_by(CostLot.acquired_at)
    )

    if not include_unsettled_negative:
        query = query.where(
            or_(CostLot.is_negative == False, CostLot.is_settled == True)  # noqa: E712
        )
    if asset_ids:
        query = query.where(CostLot.asset_id.in_(asset_ids))
    if account_ids:
        query = query.where(CostLot.account_id.in_(account_ids))

    lots = session.exec(query).all()
    if not lots:
        return {bd.strftime("%Y-%m-%d"): {} for bd in bucket_dates}

    lots_list = [
        (_ensure_naive(l.acquired_at), l.asset_id, float(l.invested)) for l in lots
    ]

    result: Dict[str, Dict[int, float]] = {}
    lot_idx = 0
    cumulative: Dict[int, float] = defaultdict(float)

    for bucket_date in sorted(bucket_dates):
        bd = _ensure_naive(bucket_date)
        while lot_idx < len(lots_list) and lots_list[lot_idx][0] <= bd:
            _, asset_id, invested = lots_list[lot_idx]
            cumulative[asset_id] += invested
            lot_idx += 1

        result[bucket_date.strftime("%Y-%m-%d")] = dict(cumulative)

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
        price_query = price_query.where(
            PriceSnapshot.quote_asset_id == base_currency_id
        )

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
            select(
                PriceSnapshot.asset_id, PriceSnapshot.price, PriceSnapshot.snapshot_time
            )
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
        taxable_only: If True, only include disposal_taxable=True entries (tax view).
                     Defaults to False (all realized P&L, economic view).

    Returns: { date_str: (total_cumulative_pnl, { asset_id: cumulative_pnl }) }
    """
    if not bucket_dates:
        return {}

    rpnl_query = (
        select(
            func.coalesce(RealizedPnl.attributed_asset_id, RealizedPnl.asset_id).label(
                "effective_asset_id"
            ),
            (RealizedPnl.pnl_in_base if taxable_only else ECONOMIC_PNL).label(
                "pnl_in_base"
            ),
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
        # Filter on effective asset: entries where either asset_id or attributed_asset_id matches
        rpnl_query = rpnl_query.where(
            func.coalesce(RealizedPnl.attributed_asset_id, RealizedPnl.asset_id).in_(
                asset_ids
            )
        )

    if account_ids:
        from backend.db.models import NormalizedTransaction

        rpnl_query = rpnl_query.join(
            NormalizedTransaction,
            RealizedPnl.transaction_id == NormalizedTransaction.id,
            isouter=True,
        ).where(NormalizedTransaction.account_id.in_(account_ids))

    rpnl_rows = session.exec(rpnl_query).all()

    rpnl_list = [
        (_ensure_naive(r.realized_at), r.effective_asset_id, float(r.pnl_in_base))
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
            ECONOMIC_PNL.label("pnl_in_base"),
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
        rpnl_query = rpnl_query.where(
            func.coalesce(RealizedPnl.attributed_asset_id, RealizedPnl.asset_id).in_(
                asset_ids
            )
        )
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


def _get_asset_labels(
    session: Session, asset_ids: List[int]
) -> Dict[int, Optional[str]]:
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
        select(AssetCategory.asset_id).where(
            AssetCategory.category_id.in_(category_ids)
        )
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
    history_dates: Optional[List[datetime]] = None,
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

        base_asset = session.get(Asset, base_currency_id)
        base_symbol = base_asset.symbol if base_asset else "USD"
        price_service = PriceService(session=session, base_currency=base_symbol)

        priced_ids = [aid for aid in asset_ids if aid != base_currency_id]
        results = price_service.refresh_current_prices(
            priced_ids,
            price_quote=base_symbol,
            history_dates=[d.date() for d in history_dates or []],
            staleness_window_days=7,
        )
        stale_assets = [
            (aid, r.staleness_days)
            for aid, r in results.items()
            if r.is_stale or r.is_fallback
        ]
        failed_assets = [aid for aid in priced_ids if aid not in results]
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


def _scope_fees_to_accounts(query, account_ids: Optional[List[int]]):
    """Restrict a FeeEntry query to fees paid from the given accounts (via the fee leg's transaction)."""
    if not account_ids:
        return query
    return (
        query.join(CalculationUnitLeg, FeeEntry.fee_leg_id == CalculationUnitLeg.id)
        .join(
            NormalizedTransaction,
            CalculationUnitLeg.transaction_id == NormalizedTransaction.id,
        )
        .where(NormalizedTransaction.account_id.in_(account_ids))
    )


def _compute_fee_summary(
    session: Session,
    version_id: int,
    account_ids: Optional[List[int]] = None,
) -> Tuple[float, int]:
    """Compute total fees and fee entry count for a version."""
    query = select(
        func.coalesce(func.sum(FeeEntry.fee_value_in_base), 0).label("total_fees"),
        func.count(FeeEntry.id).label("fee_count"),
    ).where(FeeEntry.version_id == version_id)
    fee_summary = session.exec(_scope_fees_to_accounts(query, account_ids)).first()
    total_fees = float(fee_summary.total_fees) if fee_summary else 0.0
    fee_count = fee_summary.fee_count if fee_summary else 0
    return total_fees, fee_count


def _compute_fees_in_period(
    session: Session,
    version_id: int,
    start_dt: datetime,
    end_dt: datetime,
    account_ids: Optional[List[int]] = None,
) -> float:
    """Compute total fees within a date range by joining FeeEntry → CalculationUnit."""
    query = (
        select(func.coalesce(func.sum(FeeEntry.fee_value_in_base), 0))
        .join(CalculationUnit, FeeEntry.unit_id == CalculationUnit.id)
        .where(
            FeeEntry.version_id == version_id,
            CalculationUnit.timestamp >= start_dt,
            CalculationUnit.timestamp <= end_dt,
        )
    )
    result = session.exec(_scope_fees_to_accounts(query, account_ids)).first()
    return float(result or 0)


def _get_fees_by_asset(
    session: Session,
    version_id: int,
    account_ids: Optional[List[int]] = None,
) -> Dict[int, float]:
    """Aggregate total fees per asset (by related_asset_id)."""
    query = (
        select(
            FeeEntry.related_asset_id,
            func.coalesce(func.sum(FeeEntry.fee_value_in_base), 0),
        )
        .where(
            FeeEntry.version_id == version_id,
            FeeEntry.related_asset_id.isnot(None),
        )
        .group_by(FeeEntry.related_asset_id)
    )
    rows = session.exec(_scope_fees_to_accounts(query, account_ids)).all()
    return {int(r[0]): float(r[1]) for r in rows}


# ---------------------------------------------------------------------------
# Income aggregation helpers
# ---------------------------------------------------------------------------


def _compute_income_summary(
    session: Session,
    version_id: int,
) -> Tuple[float, float, int]:
    """Compute total income, withholding, and event count for a version."""
    try:
        result = session.exec(
            select(
                func.coalesce(func.sum(IncomeEvent.gross_amount_in_base), 0).label(
                    "total_income"
                ),
                func.coalesce(
                    func.sum(IncomeEvent.withholding_amount_in_base), 0
                ).label("total_withholding"),
                func.count(IncomeEvent.id).label("event_count"),
            ).where(IncomeEvent.version_id == version_id)
        ).first()
        if not result:
            return 0.0, 0.0, 0
        return (
            float(result.total_income),
            float(result.total_withholding),
            int(result.event_count),
        )
    except (TypeError, AttributeError):
        return 0.0, 0.0, 0


def _compute_income_in_period(
    session: Session,
    version_id: int,
    start_dt: datetime,
    end_dt: datetime,
) -> Tuple[float, float]:
    """Compute income and withholding within a date range."""
    try:
        result = session.exec(
            select(
                func.coalesce(func.sum(IncomeEvent.gross_amount_in_base), 0),
                func.coalesce(func.sum(IncomeEvent.withholding_amount_in_base), 0),
            ).where(
                IncomeEvent.version_id == version_id,
                IncomeEvent.income_at >= start_dt,
                IncomeEvent.income_at <= end_dt,
            )
        ).first()
        if not result:
            return 0.0, 0.0
        return float(result[0]), float(result[1])
    except (TypeError, AttributeError):
        return 0.0, 0.0


def _get_income_by_asset(
    session: Session,
    version_id: int,
    start_dt: Optional[datetime] = None,
    account_ids: Optional[List[int]] = None,
) -> Dict[int, float]:
    """Net income per position asset (attributed asset, else received asset), optionally since start_dt."""
    try:
        asset_col = func.coalesce(IncomeEvent.attributed_asset_id, IncomeEvent.asset_id)
        query = (
            select(asset_col, func.coalesce(func.sum(IncomeEvent.net_amount_in_base), 0))
            .where(IncomeEvent.version_id == version_id)
            .group_by(asset_col)
        )
        if start_dt is not None:
            query = query.where(IncomeEvent.income_at >= start_dt)
        if account_ids:
            query = query.join(
                NormalizedTransaction,
                IncomeEvent.transaction_id == NormalizedTransaction.id,
            ).where(NormalizedTransaction.account_id.in_(account_ids))
        return {
            int(r[0]): float(r[1]) for r in session.exec(query).all() if r[0] is not None
        }
    except (TypeError, AttributeError, ValueError):
        return {}


# ---------------------------------------------------------------------------
# Shared snapshot infrastructure
# ---------------------------------------------------------------------------


@dataclass
class _VersionSnapshot:
    """Pre-computed data shared by all metrics entry points."""

    version: CalculationVersion  # type: ignore[type-arg]
    base_currency_id: Optional[int]
    min_date: datetime
    now: datetime
    now_ds: str
    now_lot_balances: Dict[int, float]
    now_lot_remaining_costs: Dict[int, float]
    now_lot_invested: Dict[int, float]
    all_asset_ids: set
    range_starts: Dict[str, datetime]
    unique_dates: List[datetime]
    balance_snapshots: Dict[str, Dict[int, float]]
    cost_basis_snapshots: Dict[str, Dict[int, float]]
    invested_snapshots: Dict[str, Dict[int, float]] = field(default_factory=dict)


def _build_version_snapshot(
    session: Session,
    version_id: int,
    periods: List[str],
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    include_unsettled_negative: bool = False,
    need_balances: bool = True,
) -> Optional[_VersionSnapshot]:
    """
    Build the shared data snapshot used by all metrics entry points.

    Returns None if version not found or no event data exists.
    When need_balances=False (settled metrics), skips balance snapshots.
    """
    version = session.get(CalculationVersion, version_id)
    if not version:
        return None

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
        return None

    now = datetime.now(timezone.utc)
    if min_date.tzinfo is None:
        min_date = min_date.replace(tzinfo=timezone.utc)

    # Current lots
    now_lot_balances, now_lot_remaining_costs, now_lot_acquired = (
        _get_current_from_cost_lots(
            session,
            version_id,
            asset_ids,
            account_ids,
            include_unsettled_negative=include_unsettled_negative,
        )
    )

    if need_balances:
        all_asset_ids = set(now_lot_balances.keys()) | set(
            now_lot_remaining_costs.keys()
        )
    else:
        all_asset_ids = set(now_lot_remaining_costs.keys())

    # Build boundary dates
    boundary_dates: List[datetime] = [now]
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

    # Historical snapshots
    balance_snapshots: Dict[str, Dict[int, float]] = {}
    if need_balances:
        balance_snapshots = _get_balance_snapshots_at_dates(
            session,
            version_id,
            unique_dates,
            asset_ids,
            account_ids,
            include_unsettled_negative=include_unsettled_negative,
        )

    cost_basis_snapshots = _get_cost_basis_snapshots_at_dates(
        session,
        version_id,
        unique_dates,
        asset_ids,
        account_ids,
        include_unsettled_negative=include_unsettled_negative,
    )

    invested_snapshots = _get_invested_snapshots_at_dates(
        session,
        version_id,
        unique_dates,
        asset_ids,
        account_ids,
        include_unsettled_negative=include_unsettled_negative,
    )

    now_ds = now.strftime("%Y-%m-%d")
    if need_balances:
        balance_snapshots[now_ds] = now_lot_balances
    cost_basis_snapshots[now_ds] = now_lot_remaining_costs

    # Expand all_asset_ids from historical snapshots
    if need_balances:
        for balances in balance_snapshots.values():
            all_asset_ids.update(balances.keys())

    return _VersionSnapshot(
        version=version,
        base_currency_id=version.base_currency_id,
        min_date=min_date,
        now=now,
        now_ds=now_ds,
        now_lot_balances=now_lot_balances,
        now_lot_remaining_costs=now_lot_remaining_costs,
        now_lot_invested=now_lot_acquired,
        all_asset_ids=all_asset_ids,
        range_starts=range_starts,
        unique_dates=unique_dates,
        balance_snapshots=balance_snapshots,
        cost_basis_snapshots=cost_basis_snapshots,
        invested_snapshots=invested_snapshots,
    )


def _build_price_snapshot(
    session: Session,
    snap: _VersionSnapshot,
    refresh: bool = False,
) -> Dict[str, Dict[int, float]]:
    """Build price snapshots for all boundary dates. Optionally refreshes prices first."""
    all_asset_ids_list = list(snap.all_asset_ids)
    if refresh and all_asset_ids_list:
        _refresh_prices_for_assets(
            session, all_asset_ids_list, snap.base_currency_id, snap.unique_dates
        )
    return _get_price_at_dates(
        session,
        snap.base_currency_id,
        all_asset_ids_list,
        snap.unique_dates,
    )


def _build_realized_pnl_snapshots(
    session: Session,
    snap: _VersionSnapshot,
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    taxable_only: bool = False,
) -> Dict[str, Tuple[float, Dict[int, float]]]:
    """Build cumulative realized PnL snapshots at all boundary dates."""
    return _get_cumulative_realized_pnl(
        session,
        snap.version.version_id,
        snap.unique_dates,
        asset_ids,
        account_ids,
        taxable_only=taxable_only,
    )


def _snapshot_at(
    snap: _VersionSnapshot,
    price_snapshots: Dict[str, Dict[int, float]],
    cumulative_rpnl: Dict[str, Tuple[float, Dict[int, float]]],
    dt: datetime,
) -> Tuple[
    Dict[int, float], Dict[int, float], Dict[int, float], float, Dict[int, float]
]:
    """
    Extract (balances, costs, prices, rpnl_total, rpnl_by_asset) at a given date.
    """
    ds = dt.strftime("%Y-%m-%d")
    balances = snap.balance_snapshots.get(ds, {})
    costs = snap.cost_basis_snapshots.get(ds, {})
    prices = price_snapshots.get(ds, {})
    rpnl_total, rpnl_by_asset = cumulative_rpnl.get(ds, (0.0, {}))
    return balances, costs, prices, rpnl_total, rpnl_by_asset


def _compute_portfolio_range_metrics(
    all_asset_ids: set,
    range_key: str,
    now_balances: Dict[int, float],
    now_costs: Dict[int, float],
    now_prices: Dict[int, float],
    start_balances: Dict[int, float],
    start_costs: Dict[int, float],
    start_prices: Dict[int, float],
    now_rpnl_total: float,
    start_rpnl_total: float,
    unrealized_pnl: float,
    cost_basis: float,
    base_currency_id: Optional[int] = None,
) -> Tuple[float, float, float, float, float]:
    """
    Compute portfolio-level range metrics shared by compute_version_metrics
    and compute_live_metrics.

    Base currency is excluded from period aggregation to avoid inflated
    ROI from cash-flow movements.

    Returns: (total_return, roi_pct, unrealized_in_period, realized_in_period, start_cost)
    """
    # Exclude base currency from period aggregation
    eligible_ids = {aid for aid in all_asset_ids if aid != base_currency_id}

    realized_in_period = now_rpnl_total - start_rpnl_total

    if range_key == "all":
        unrealized_in_period = unrealized_pnl
        total_return = unrealized_pnl + now_rpnl_total
        roi_base = cost_basis
        start_cost = 0.0
    else:
        start_value = sum(
            start_balances.get(aid, 0.0) * start_prices.get(aid, 0.0)
            for aid in eligible_ids
        )
        start_cost = sum(start_costs.get(aid, 0.0) for aid in eligible_ids)
        start_unrealized = start_value - start_cost
        unrealized_in_period = unrealized_pnl - start_unrealized
        total_return = unrealized_in_period + realized_in_period
        roi_base = start_cost if start_cost != 0 else cost_basis

    roi_pct = (total_return / roi_base * 100) if roi_base != 0 else 0.0

    return total_return, roi_pct, unrealized_in_period, realized_in_period, start_cost


# ---------------------------------------------------------------------------
# Performer ranking
# ---------------------------------------------------------------------------


UNCATEGORIZED_CATEGORY_ID = -1


def _build_asset_items(
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
    fees_by_asset: Optional[Dict[int, float]] = None,
    base_currency_id: Optional[int] = None,
    income_by_asset: Optional[Dict[int, float]] = None,
) -> List[PerformerItem]:
    """Per-asset return items (the single formula every grouping aggregates from)."""
    fees_by_asset = fees_by_asset or {}
    income_by_asset = income_by_asset or {}
    items: List[PerformerItem] = []

    # Assets fully bought and sold between boundary dates only show up in realized PnL
    for aid in set(all_asset_ids) | set(now_rpnl_by_asset.keys()):
        if aid == base_currency_id:
            continue
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
            asset_realized = asset_rpnl_now
        else:
            qty_start = start_balances.get(aid, 0.0)
            price_start = start_prices.get(aid, 0.0)
            cost_start = start_costs.get(aid, 0.0)
            asset_unrealized_start = qty_start * price_start - cost_start
            asset_unrealized_change = asset_unrealized - asset_unrealized_start
            asset_total_return = asset_unrealized_change + asset_realized_in_period
            asset_roi_base = cost_start if cost_start != 0 else cost_now
            asset_realized = asset_realized_in_period

        if (
            abs(qty_now) < 1e-12
            and abs(cost_now) < 1e-12
            and abs(asset_total_return) < 0.01
        ):
            continue

        asset_roi = (
            (asset_total_return / asset_roi_base * 100) if asset_roi_base != 0 else 0.0
        )
        items.append(
            PerformerItem(
                id=aid,
                name=asset_symbols.get(aid, f"#{aid}"),
                label=asset_labels.get(aid),
                group_type="asset",
                total_return=round(asset_total_return, 2),
                roi_pct=round(asset_roi, 2),
                unrealized_pnl=round(asset_unrealized, 2),
                market_value=round(asset_value, 2),
                cost_basis=round(cost_now, 2),
                total_fees=round(fees_by_asset.get(aid, 0.0), 2),
                efficiency=round(asset_total_return / max(cost_now, 1.0), 4),
                realized_pnl=round(asset_realized, 2),
                income=round(income_by_asset.get(aid, 0.0), 2),
                roi_base=round(asset_roi_base, 2),
            )
        )
    return items


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
    base_currency_id: Optional[int] = None,
    income_by_asset: Optional[Dict[int, float]] = None,
) -> Tuple[List[PerformerItem], List[PerformerItem], int]:
    """Rank performers at asset level. Excludes base currency."""
    items = _build_asset_items(
        all_asset_ids,
        now_balances,
        now_costs,
        now_prices,
        now_rpnl_by_asset,
        start_balances,
        start_costs,
        start_prices,
        start_rpnl_by_asset,
        asset_symbols,
        asset_labels,
        range_key,
        fees_by_asset,
        base_currency_id,
        income_by_asset,
    )
    return _sort_top_flop(items, top_n)


def _list_version_account_ids(
    session: Session,
    version_id: int,
    asset_ids: Optional[List[int]],
    account_ids: Optional[List[int]],
) -> List[int]:
    """Accounts holding (or having held) lots in this version."""
    query = (
        select(CostLot.account_id)
        .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
        .distinct()
    )
    if asset_ids:
        query = query.where(CostLot.asset_id.in_(asset_ids))
    if account_ids:
        query = query.where(CostLot.account_id.in_(account_ids))
    return sorted({int(a) for a in session.exec(query).all() if a is not None})


def _account_performer(
    session: Session,
    version_id: int,
    account_id: int,
    range_key: str,
    asset_ids: Optional[List[int]],
    include_unsettled_negative: bool,
) -> Optional[PerformerItem]:
    """Aggregate one account from its own asset-level items (same formula as by-asset)."""
    snap = _build_version_snapshot(
        session,
        version_id,
        [range_key],
        asset_ids,
        [account_id],
        include_unsettled_negative=include_unsettled_negative,
    )
    if snap is None:
        return None
    price_snapshots = _build_price_snapshot(session, snap, refresh=False)
    cumulative_rpnl = _build_realized_pnl_snapshots(
        session, snap, asset_ids, [account_id], taxable_only=False
    )
    now_b, now_c, now_p, _, now_r = _snapshot_at(
        snap, price_snapshots, cumulative_rpnl, snap.now
    )
    start_dt = snap.range_starts[range_key]
    st_b, st_c, st_p, _, st_r = _snapshot_at(
        snap, price_snapshots, cumulative_rpnl, start_dt
    )
    fees = _get_fees_by_asset(session, version_id, [account_id])
    income = _get_income_by_asset(
        session, version_id, None if range_key == "all" else start_dt, [account_id]
    )
    items = _build_asset_items(
        snap.all_asset_ids,
        now_b,
        now_c,
        now_p,
        now_r,
        st_b,
        st_c,
        st_p,
        st_r,
        {},
        {},
        range_key,
        fees,
        snap.base_currency_id,
        income,
    )

    base = snap.base_currency_id
    cash_value = now_b.get(base, 0.0) * now_p.get(base, 1.0) if base is not None else 0.0
    cash_cost = now_c.get(base, 0.0) if base is not None else 0.0

    total_return = sum(i.total_return for i in items)
    roi_base = sum(i.roi_base for i in items)
    cost_basis = sum(i.cost_basis for i in items) + cash_cost
    market_value = sum(i.market_value for i in items) + cash_value
    if (
        abs(cost_basis) < 1e-12
        and abs(market_value) < 1e-12
        and abs(total_return) < 0.01
    ):
        return None

    return PerformerItem(
        id=account_id,
        name=f"Account #{account_id}",
        label=None,
        group_type="account",
        total_return=round(total_return, 2),
        roi_pct=round(total_return / roi_base * 100, 2) if roi_base != 0 else 0.0,
        unrealized_pnl=round(sum(i.unrealized_pnl for i in items), 2),
        market_value=round(market_value, 2),
        cost_basis=round(cost_basis, 2),
        total_fees=round(sum(fees.values()), 2),
        efficiency=round(total_return / max(cost_basis, 1.0), 4),
        realized_pnl=round(sum(i.realized_pnl for i in items), 2),
        income=round(sum(income.values()), 2),
        roi_base=round(roi_base, 2),
    )


def _rank_performers_by_account(
    session: Session,
    version_id: int,
    range_key: str,
    top_n: int,
    asset_ids: Optional[List[int]],
    account_ids: Optional[List[int]],
    include_unsettled_negative: bool,
) -> Tuple[List[PerformerItem], List[PerformerItem], int]:
    """Rank accounts; each account is built from a per-account snapshot so periods are exact."""
    acct_ids = _list_version_account_ids(session, version_id, asset_ids, account_ids)
    acct_names: Dict[int, str] = {}
    if acct_ids:
        accounts = session.exec(select(Account).where(Account.id.in_(acct_ids))).all()
        acct_names = {a.id: a.name for a in accounts}

    performances: List[PerformerItem] = []
    for acct_id in acct_ids:
        item = _account_performer(
            session,
            version_id,
            acct_id,
            range_key,
            asset_ids,
            include_unsettled_negative,
        )
        if item is None:
            continue
        item.name = acct_names.get(acct_id, item.name)
        performances.append(item)

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
    base_currency_id: Optional[int] = None,
    income_by_asset: Optional[Dict[int, float]] = None,
) -> Tuple[List[PerformerItem], List[PerformerItem], int]:
    """Rank categories from asset-level items; uncategorized assets go to an "Uncategorized" bucket."""
    items = _build_asset_items(
        all_asset_ids,
        now_balances,
        now_costs,
        now_prices,
        now_rpnl_by_asset,
        start_balances,
        start_costs,
        start_prices,
        start_rpnl_by_asset,
        {},
        {},
        range_key,
        fees_by_asset,
        None,
        income_by_asset,
    )
    item_ids = [i.id for i in items]

    cat_query = select(AssetCategory.asset_id, AssetCategory.category_id).where(
        AssetCategory.asset_id.in_(item_ids)
    )
    if dimension_id is not None:
        cat_query = cat_query.join(
            Category, AssetCategory.category_id == Category.id
        ).where(Category.dimension_id == dimension_id)
    cat_rows = session.exec(cat_query).all() if item_ids else []

    asset_to_cats: Dict[int, List[int]] = defaultdict(list)
    for row in cat_rows:
        asset_to_cats[row.asset_id].append(row.category_id)

    all_cat_ids = {c for cats in asset_to_cats.values() for c in cats}
    cat_labels: Dict[int, str] = {UNCATEGORIZED_CATEGORY_ID: "Uncategorized"}
    if all_cat_ids:
        categories = session.exec(
            select(Category).where(Category.id.in_(list(all_cat_ids)))
        ).all()
        cat_labels.update({c.id: c.label for c in categories})

    keys = (
        "total_return",
        "roi_base",
        "cost_basis",
        "unrealized_pnl",
        "market_value",
        "total_fees",
        "realized_pnl",
        "income",
    )
    cat_data: Dict[int, Dict[str, float]] = defaultdict(lambda: {k: 0.0 for k in keys})

    # An asset in N categories is split 1/N; base currency never lands in "Uncategorized"
    for item in items:
        cats = asset_to_cats.get(item.id)
        if not cats:
            if item.id == base_currency_id:
                continue
            cats = [UNCATEGORIZED_CATEGORY_ID]
        share = 1.0 / len(cats)
        for cat_id in cats:
            for k in keys:
                cat_data[cat_id][k] += getattr(item, k) * share

    performances: List[PerformerItem] = []
    for cat_id, data in cat_data.items():
        tr = data["total_return"]
        cb = data["cost_basis"]
        if abs(cb) < 1e-12 and abs(tr) < 0.01:
            continue
        rb = data["roi_base"]
        performances.append(
            PerformerItem(
                id=cat_id,
                name=cat_labels.get(cat_id, f"Category #{cat_id}"),
                label=None,
                group_type="category",
                total_return=round(tr, 2),
                roi_pct=round(tr / rb * 100, 2) if rb != 0 else 0.0,
                unrealized_pnl=round(data["unrealized_pnl"], 2),
                market_value=round(data["market_value"], 2),
                cost_basis=round(cb, 2),
                total_fees=round(data["total_fees"], 2),
                efficiency=round(tr / max(cb, 1.0), 4),
                realized_pnl=round(data["realized_pnl"], 2),
                income=round(data["income"], 2),
                roi_base=round(rb, 2),
            )
        )

    return _sort_top_flop(performances, top_n)


def _sort_top_flop(
    performances: List[PerformerItem],
    top_n: int,
) -> Tuple[List[PerformerItem], List[PerformerItem], int]:
    """Sort performers and extract top + flop lists. Returns (top, flop, total_count)."""
    total_count = len(performances)
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
    return top, flop, total_count


# ---------------------------------------------------------------------------
# Internal computation cores (shared by public functions)
# ---------------------------------------------------------------------------


def _compute_book_core(
    session: Session,
    snap: "_VersionSnapshot",
    version_id: int,
    asset_ids: Optional[List[int]],
    account_ids: Optional[List[int]],
) -> Tuple[
    BookSummary,
    Dict[str, BookRangeMetrics],
    float,  # total_fees
    int,  # fee_count
    Dict[str, Tuple[float, Dict[int, float]]],  # cumulative_rpnl
]:
    """
    Core book metrics computation shared by compute_book_metrics and compute_version_metrics.

    Returns:
        (summary, ranges, total_fees, fee_count, cumulative_rpnl)
    """
    all_asset_ids = snap.all_asset_ids
    cost_basis = sum(snap.now_lot_remaining_costs.values())
    total_invested = sum(snap.now_lot_invested.get(aid, 0.0) for aid in all_asset_ids)

    # Fee summary
    total_fees, fee_count = _compute_fee_summary(session, version_id, account_ids)

    # Realized PnL
    cumulative_rpnl = _build_realized_pnl_snapshots(
        session,
        snap,
        asset_ids,
        account_ids,
        taxable_only=False,
    )
    cumulative_rpnl_taxable = _get_cumulative_realized_pnl(
        session,
        snap.version.version_id,
        [snap.now],
        asset_ids,
        account_ids,
        taxable_only=True,
    )

    now_rpnl_total = cumulative_rpnl.get(snap.now_ds, (0.0, {}))[0]
    taxable_rpnl_total = cumulative_rpnl_taxable.get(snap.now_ds, (0.0, {}))[0]
    deferred_gain = _get_deferred_gain(session, version_id, asset_ids, account_ids)
    # Money isn't attached to an asset: net deposits only make sense unscoped by asset.
    net_deposits = (
        0.0
        if asset_ids
        else _get_net_deposits(
            session,
            version_id,
            snap.base_currency_id,
            account_ids,
        )
    )
    unfunded_spend = (
        0.0
        if asset_ids
        else _get_unfunded_spend(
            session,
            version_id,
            snap.base_currency_id,
            account_ids,
        )
    )

    # Income summary
    total_income, total_withholding, income_count = _compute_income_summary(
        session, version_id
    )

    summary = BookSummary(
        cost_basis=round(cost_basis, 2),
        realized_pnl=round(now_rpnl_total, 2),
        taxable_realized_pnl=round(taxable_rpnl_total, 2),
        total_fees=round(total_fees, 2),
        fee_entry_count=fee_count,
        total_invested=round(total_invested, 2),
        deferred_gain=round(deferred_gain, 2),
        net_deposits=round(net_deposits, 2),
        unfunded_spend=round(unfunded_spend, 2),
        total_income=round(total_income, 2),
        total_withholding=round(total_withholding, 2),
        income_event_count=income_count,
    )

    ranges: Dict[str, BookRangeMetrics] = {}
    for range_key, start_dt in snap.range_starts.items():
        start_ds = start_dt.strftime("%Y-%m-%d")
        start_costs = snap.cost_basis_snapshots.get(start_ds, {})
        start_rpnl_total = cumulative_rpnl.get(start_ds, (0.0, {}))[0]

        realized_in_period = now_rpnl_total - start_rpnl_total

        if range_key == "all":
            cost_basis_in_period = cost_basis
            fees_in_period = total_fees
            invested_in_period = total_invested
            deposits_in_period = net_deposits
            income_in_period = total_income
            withholding_in_period = total_withholding
        else:
            start_cost = sum(start_costs.get(aid, 0.0) for aid in all_asset_ids)
            cost_basis_in_period = cost_basis - start_cost
            fees_in_period = _compute_fees_in_period(
                session, version_id, start_dt, snap.now, account_ids
            )
            start_invested = snap.invested_snapshots.get(start_ds, {})
            invested_in_period = total_invested - sum(
                start_invested.get(aid, 0.0) for aid in all_asset_ids
            )
            income_in_period, withholding_in_period = _compute_income_in_period(
                session, version_id, start_dt, snap.now
            )
            deposits_in_period = (
                0.0
                if asset_ids
                else _get_net_deposits(
                    session,
                    version_id,
                    snap.base_currency_id,
                    account_ids,
                    since=start_dt,
                )
            )

        ranges[range_key] = BookRangeMetrics(
            cost_basis=round(cost_basis, 2),
            realized_pnl=round(now_rpnl_total, 2),
            taxable_realized_pnl=round(taxable_rpnl_total, 2),
            realized_in_period=round(realized_in_period, 2),
            cost_basis_in_period=round(cost_basis_in_period, 2),
            fees_in_period=round(fees_in_period, 2),
            total_invested=round(invested_in_period, 2),
            deferred_gain=round(deferred_gain, 2),
            net_deposits=round(deposits_in_period, 2),
            income_in_period=round(income_in_period, 2),
            withholding_in_period=round(withholding_in_period, 2),
        )

    return summary, ranges, total_fees, fee_count, cumulative_rpnl


def _compute_live_core(
    snap: "_VersionSnapshot",
    price_snapshots: Dict[str, Dict[int, float]],
    cumulative_rpnl: Dict[str, Tuple[float, Dict[int, float]]],
    cost_basis: float,
) -> Tuple[LiveSummary, Dict[str, LiveRangeMetrics]]:
    """
    Core live metrics computation shared by compute_live_metrics and compute_version_metrics.

    Returns:
        (summary, ranges)
    """
    all_asset_ids = snap.all_asset_ids

    now_balances, now_costs, now_prices, now_rpnl_total, _ = _snapshot_at(
        snap,
        price_snapshots,
        cumulative_rpnl,
        snap.now,
    )

    current_value = sum(
        now_balances.get(aid, 0.0) * now_prices.get(aid, 0.0) for aid in all_asset_ids
    )
    unrealized_pnl = current_value - cost_basis

    summary = LiveSummary(
        current_value=round(current_value, 2),
        unrealized_pnl=round(unrealized_pnl, 2),
    )

    ranges: Dict[str, LiveRangeMetrics] = {}
    for range_key, start_dt in snap.range_starts.items():
        start_balances, start_costs, start_prices, start_rpnl_total, _ = _snapshot_at(
            snap,
            price_snapshots,
            cumulative_rpnl,
            start_dt,
        )

        total_return, roi_pct, unrealized_in_period, _, _ = (
            _compute_portfolio_range_metrics(
                all_asset_ids,
                range_key,
                now_balances,
                now_costs,
                now_prices,
                start_balances,
                start_costs,
                start_prices,
                now_rpnl_total,
                start_rpnl_total,
                unrealized_pnl,
                cost_basis,
                base_currency_id=snap.base_currency_id,
            )
        )

        ranges[range_key] = LiveRangeMetrics(
            current_value=round(current_value, 2),
            unrealized_pnl=round(unrealized_pnl, 2),
            unrealized_in_period=round(unrealized_in_period, 2),
            total_return=round(total_return, 2),
            roi_pct=round(roi_pct, 2),
        )

    return summary, ranges


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
    include_unsettled_negative: bool = True,
    refresh_prices: bool = True,
) -> Optional[VersionMetrics]:
    """
    Compute all PnL metrics for a version.

    Composes book core (cost-lot-based) + live core (price-dependent) + performers.
    This is the single entry point for combined metric computation.

    Args:
        periods: Which period ranges to compute. Default: all of them.
        group_by: How to rank performers: 'asset', 'account', 'category'.
        top_n: Number of top/flop performers to return.
        refresh_prices: If True, fetch fresh prices before computing.

    Returns:
        VersionMetrics with summary (all-time) + per-period range metrics,
        or None if version not found.
    """
    if periods is None:
        periods = list(PERIOD_RANGES.keys())

    # Resolve category filter to asset_ids
    if category_ids:
        resolved = _resolve_category_to_asset_ids(session, category_ids, asset_ids)
        if resolved is None:
            return VersionMetrics(
                version_id=version_id,
                summary=SummaryMetrics(
                    cost_basis=0,
                    realized_pnl=0,
                    taxable_realized_pnl=0,
                    total_fees=0,
                    fee_entry_count=0,
                ),
            )
        asset_ids = resolved

    snap = _build_version_snapshot(
        session,
        version_id,
        periods,
        asset_ids,
        account_ids,
        include_unsettled_negative=include_unsettled_negative,
    )
    if snap is None:
        version = session.get(CalculationVersion, version_id)
        if not version:
            return None
        total_fees, fee_count = _compute_fee_summary(session, version_id, account_ids)
        return VersionMetrics(
            version_id=version_id,
            summary=SummaryMetrics(
                cost_basis=0,
                realized_pnl=0,
                taxable_realized_pnl=0,
                total_fees=total_fees,
                fee_entry_count=fee_count,
            ),
        )

    # ── Book core (cost-lot-based) ──
    book_summary, book_ranges, total_fees, fee_count, cumulative_rpnl = (
        _compute_book_core(
            session,
            snap,
            version_id,
            asset_ids,
            account_ids,
        )
    )

    # ── Live core (price-dependent) ──
    price_snapshots = _build_price_snapshot(session, snap, refresh=refresh_prices)
    live_summary, live_ranges = _compute_live_core(
        snap,
        price_snapshots,
        cumulative_rpnl,
        book_summary.cost_basis,
    )

    # ── Combined summary ──
    summary = SummaryMetrics(
        **asdict(book_summary),
        current_value=live_summary.current_value,
        unrealized_pnl=live_summary.unrealized_pnl,
    )

    # ── Per-period combined ranges (book + live + performers) ──
    all_asset_ids = snap.all_asset_ids
    all_asset_ids_list = list(all_asset_ids)
    asset_symbols = _get_asset_symbols(session, all_asset_ids_list)
    asset_labels = _get_asset_labels(session, all_asset_ids_list)
    fees_by_asset = _get_fees_by_asset(session, version_id, account_ids)

    now_balances, now_costs, now_prices, now_rpnl_total, now_rpnl_by_asset = (
        _snapshot_at(
            snap,
            price_snapshots,
            cumulative_rpnl,
            snap.now,
        )
    )

    ranges: Dict[str, RangeMetrics] = {}

    for range_key, start_dt in snap.range_starts.items():
        book_range = book_ranges[range_key]
        live_range = live_ranges[range_key]

        (
            start_balances,
            start_costs,
            start_prices,
            start_rpnl_total,
            start_rpnl_by_asset,
        ) = _snapshot_at(snap, price_snapshots, cumulative_rpnl, start_dt)

        # Rank performers based on group_by
        if group_by == "account":
            top, flop, _ = _rank_performers_by_account(
                session,
                version_id,
                range_key,
                top_n,
                asset_ids,
                account_ids,
                include_unsettled_negative,
            )
        elif group_by == "category":
            top, flop, _ = _rank_performers_by_category(
                session,
                all_asset_ids,
                now_balances,
                now_costs,
                now_prices,
                now_rpnl_by_asset,
                start_balances,
                start_costs,
                start_prices,
                start_rpnl_by_asset,
                range_key,
                top_n,
                dimension_id,
                fees_by_asset,
            )
        else:  # "asset"
            top, flop, _ = _rank_performers_by_asset(
                all_asset_ids,
                now_balances,
                now_costs,
                now_prices,
                now_rpnl_by_asset,
                start_balances,
                start_costs,
                start_prices,
                start_rpnl_by_asset,
                asset_symbols,
                asset_labels,
                range_key,
                top_n,
                fees_by_asset,
                base_currency_id=snap.base_currency_id,
            )

        ranges[range_key] = RangeMetrics(
            **asdict(book_range),
            total_return=live_range.total_return,
            roi_pct=live_range.roi_pct,
            current_value=live_range.current_value,
            unrealized_pnl=live_range.unrealized_pnl,
            unrealized_in_period=live_range.unrealized_in_period,
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
# Book metrics (cost-lot-based, no market prices needed)
# ---------------------------------------------------------------------------


def compute_book_metrics(
    session: Session,
    version_id: int,
    periods: Optional[List[str]] = None,
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    category_ids: Optional[List[int]] = None,
    include_unsettled_negative: bool = False,
) -> Optional[BookVersionMetrics]:
    """
    Compute cost-lot-based metrics that don't require market prices.
    Returns immediately without any price lookup — ideal for instant display.
    """
    if periods is None:
        periods = list(PERIOD_RANGES.keys())

    if category_ids:
        resolved = _resolve_category_to_asset_ids(session, category_ids, asset_ids)
        if resolved is None:
            return BookVersionMetrics(
                version_id=version_id,
                summary=BookSummary(
                    cost_basis=0,
                    realized_pnl=0,
                    taxable_realized_pnl=0,
                    total_fees=0,
                    fee_entry_count=0,
                    total_income=0,
                    total_withholding=0,
                    income_event_count=0,
                ),
            )
        asset_ids = resolved

    snap = _build_version_snapshot(
        session,
        version_id,
        periods,
        asset_ids,
        account_ids,
        include_unsettled_negative=include_unsettled_negative,
        need_balances=False,
    )
    if snap is None:
        version = session.get(CalculationVersion, version_id)
        if not version:
            return None
        total_fees, fee_count = _compute_fee_summary(session, version_id, account_ids)
        return BookVersionMetrics(
            version_id=version_id,
            summary=BookSummary(
                cost_basis=0,
                realized_pnl=0,
                taxable_realized_pnl=0,
                total_fees=total_fees,
                fee_entry_count=fee_count,
                total_income=0,
                total_withholding=0,
                income_event_count=0,
            ),
        )

    book_summary, book_ranges, _, _, _ = _compute_book_core(
        session,
        snap,
        version_id,
        asset_ids,
        account_ids,
    )

    log.info(
        "book_metrics_computed", version_id=version_id, ranges=list(book_ranges.keys())
    )

    return BookVersionMetrics(
        version_id=version_id,
        summary=book_summary,
        ranges=book_ranges,
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
    if category_ids:
        resolved = _resolve_category_to_asset_ids(session, category_ids, asset_ids)
        if resolved is None:
            return PerformersResult(
                version_id=version_id, period=period, group_type=group_by
            )
        asset_ids = resolved

    snap = _build_version_snapshot(
        session,
        version_id,
        [period],
        asset_ids,
        account_ids,
        include_unsettled_negative=include_unsettled_negative,
    )
    if snap is None:
        version = session.get(CalculationVersion, version_id)
        if not version:
            return None
        return PerformersResult(
            version_id=version_id, period=period, group_type=group_by
        )

    # Price and realized PnL snapshots (no refresh)
    price_snapshots = _build_price_snapshot(session, snap, refresh=False)
    cumulative_rpnl = _build_realized_pnl_snapshots(
        session,
        snap,
        asset_ids,
        account_ids,
        taxable_only=False,
    )

    fees_by_asset = _get_fees_by_asset(session, version_id, account_ids)

    now_balances, now_costs, now_prices, _, now_rpnl_by_asset = _snapshot_at(
        snap,
        price_snapshots,
        cumulative_rpnl,
        snap.now,
    )

    start_dt = snap.range_starts[period]
    start_balances, start_costs, start_prices, _, start_rpnl_by_asset = _snapshot_at(
        snap,
        price_snapshots,
        cumulative_rpnl,
        start_dt,
    )

    all_asset_ids = set(snap.all_asset_ids) | set(now_rpnl_by_asset.keys())
    all_asset_ids_list = list(all_asset_ids)
    asset_symbols = _get_asset_symbols(session, all_asset_ids_list)
    asset_labels = _get_asset_labels(session, all_asset_ids_list)
    income_by_asset = _get_income_by_asset(
        session, version_id, None if period == "all" else start_dt, account_ids
    )

    asset_items = _build_asset_items(
        all_asset_ids,
        now_balances,
        now_costs,
        now_prices,
        now_rpnl_by_asset,
        start_balances,
        start_costs,
        start_prices,
        start_rpnl_by_asset,
        asset_symbols,
        asset_labels,
        period,
        fees_by_asset,
        snap.base_currency_id,
        income_by_asset,
    )
    gains_total = sum(i.total_return for i in asset_items if i.total_return > 0)
    losses_total = sum(i.total_return for i in asset_items if i.total_return < 0)

    if group_by == "account":
        top, flop, total_count = _rank_performers_by_account(
            session,
            version_id,
            period,
            top_n,
            asset_ids,
            account_ids,
            include_unsettled_negative,
        )
    elif group_by == "category":
        top, flop, total_count = _rank_performers_by_category(
            session,
            all_asset_ids,
            now_balances,
            now_costs,
            now_prices,
            now_rpnl_by_asset,
            start_balances,
            start_costs,
            start_prices,
            start_rpnl_by_asset,
            period,
            top_n,
            dimension_id,
            fees_by_asset,
            base_currency_id=snap.base_currency_id,
            income_by_asset=income_by_asset,
        )
    else:
        top, flop, total_count = _sort_top_flop(asset_items, top_n)

    log.info(
        "performers_computed", version_id=version_id, period=period, group_by=group_by
    )

    return PerformersResult(
        version_id=version_id,
        period=period,
        group_type=group_by,
        top_performers=top,
        flop_performers=flop,
        total_count=total_count,
        gains_total=round(gains_total, 2),
        losses_total=round(losses_total, 2),
        net_total=round(gains_total + losses_total, 2),
    )


# ---------------------------------------------------------------------------
# Live metrics (price-dependent, reads from PriceSnapshot)
# ---------------------------------------------------------------------------


def compute_live_metrics(
    session: Session,
    version_id: int,
    periods: Optional[List[str]] = None,
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    category_ids: Optional[List[int]] = None,
    include_unsettled_negative: bool = False,
) -> Optional[LiveVersionMetrics]:
    """
    Compute price-dependent metrics using prices already in PriceSnapshot.
    Does NOT refresh prices — trusts that frontend already updated them.
    Returns current_value, unrealized_pnl, and per-period total_return/roi_pct.
    """
    if periods is None:
        periods = list(PERIOD_RANGES.keys())

    if category_ids:
        resolved = _resolve_category_to_asset_ids(session, category_ids, asset_ids)
        if resolved is None:
            return LiveVersionMetrics(
                version_id=version_id,
                summary=LiveSummary(current_value=0, unrealized_pnl=0),
            )
        asset_ids = resolved

    snap = _build_version_snapshot(
        session,
        version_id,
        periods,
        asset_ids,
        account_ids,
        include_unsettled_negative=include_unsettled_negative,
    )
    if snap is None:
        version = session.get(CalculationVersion, version_id)
        if not version:
            return None
        return LiveVersionMetrics(
            version_id=version_id,
            summary=LiveSummary(current_value=0, unrealized_pnl=0),
        )

    # Price and realized PnL snapshots (no refresh)
    price_snapshots = _build_price_snapshot(session, snap, refresh=False)
    cumulative_rpnl = _build_realized_pnl_snapshots(
        session,
        snap,
        asset_ids,
        account_ids,
        taxable_only=False,
    )

    cost_basis = sum(snap.now_lot_remaining_costs.values())
    live_summary, live_ranges = _compute_live_core(
        snap,
        price_snapshots,
        cumulative_rpnl,
        cost_basis,
    )

    log.info(
        "live_metrics_computed", version_id=version_id, ranges=list(live_ranges.keys())
    )

    return LiveVersionMetrics(
        version_id=version_id,
        summary=live_summary,
        ranges=live_ranges,
    )


# ---------------------------------------------------------------------------
# Asset period deltas (for period-aware asset cards)
# ---------------------------------------------------------------------------


def compute_asset_period_deltas(
    session: Session,
    version_id: int,
    period: str = "1m",
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    category_ids: Optional[List[int]] = None,
    include_unsettled_negative: bool = False,
) -> Optional[List[AssetPeriodDelta]]:
    """
    Compute per-asset period deltas for ALL assets (no top_n cap).

    Returns a list of AssetPeriodDelta for every asset that has activity,
    excluding the base currency. Designed for populating period-aware asset cards.
    """
    if category_ids:
        resolved = _resolve_category_to_asset_ids(session, category_ids, asset_ids)
        if resolved is None:
            return []
        asset_ids = resolved

    snap = _build_version_snapshot(
        session,
        version_id,
        [period],
        asset_ids,
        account_ids,
        include_unsettled_negative=include_unsettled_negative,
    )
    if snap is None:
        version = session.get(CalculationVersion, version_id)
        if not version:
            return None
        return []

    price_snapshots = _build_price_snapshot(session, snap, refresh=False)
    cumulative_rpnl = _build_realized_pnl_snapshots(
        session,
        snap,
        asset_ids,
        account_ids,
        taxable_only=False,
    )

    now_balances, now_costs, now_prices, _, now_rpnl_by_asset = _snapshot_at(
        snap,
        price_snapshots,
        cumulative_rpnl,
        snap.now,
    )

    start_dt = snap.range_starts[period]
    start_balances, start_costs, start_prices, _, start_rpnl_by_asset = _snapshot_at(
        snap,
        price_snapshots,
        cumulative_rpnl,
        start_dt,
    )

    all_asset_ids = set(snap.all_asset_ids) | set(now_rpnl_by_asset.keys())
    asset_symbols = _get_asset_symbols(session, list(all_asset_ids))
    asset_labels = _get_asset_labels(session, list(all_asset_ids))
    income_by_asset = _get_income_by_asset(
        session, version_id, None if period == "all" else start_dt, account_ids
    )

    base_cid = snap.base_currency_id
    deltas: List[AssetPeriodDelta] = []

    for aid in all_asset_ids:
        if aid == base_cid:
            continue

        qty_now = now_balances.get(aid, 0.0)
        price_now = now_prices.get(aid, 0.0)
        cost_now = now_costs.get(aid, 0.0)
        market_value_now = qty_now * price_now
        unrealized_now = market_value_now - cost_now

        rpnl_now = now_rpnl_by_asset.get(aid, 0.0)
        rpnl_start = start_rpnl_by_asset.get(aid, 0.0)
        realized_in_period = rpnl_now - rpnl_start

        if period == "all":
            total_return = unrealized_now + rpnl_now
            roi_base = cost_now
            unrealized_change = unrealized_now
            cost_change = cost_now
            mv_change = market_value_now
        else:
            qty_start = start_balances.get(aid, 0.0)
            price_start = start_prices.get(aid, 0.0)
            cost_start = start_costs.get(aid, 0.0)
            market_value_start = qty_start * price_start
            unrealized_start = market_value_start - cost_start
            unrealized_change = unrealized_now - unrealized_start
            total_return = unrealized_change + realized_in_period
            roi_base = cost_start if cost_start != 0 else cost_now
            cost_change = cost_now - cost_start
            mv_change = market_value_now - market_value_start

        # Skip assets with zero activity
        if abs(qty_now) < 1e-12 and abs(cost_now) < 1e-12 and abs(total_return) < 0.01:
            continue

        roi_pct = (total_return / roi_base * 100) if roi_base != 0 else 0.0

        deltas.append(
            AssetPeriodDelta(
                asset_id=aid,
                symbol=asset_symbols.get(aid, f"#{aid}"),
                label=asset_labels.get(aid),
                total_return=round(total_return, 2),
                roi_pct=round(roi_pct, 2),
                unrealized_change=round(unrealized_change, 2),
                realized_in_period=round(realized_in_period, 2),
                cost_change=round(cost_change, 2),
                market_value_change=round(mv_change, 2),
                income_in_period=round(income_by_asset.get(aid, 0.0), 2),
            )
        )

    log.info(
        "asset_period_deltas_computed",
        version_id=version_id,
        period=period,
        count=len(deltas),
    )
    return deltas
