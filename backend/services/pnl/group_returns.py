"""Per-group (asset / account / category) TWR and MWR over a period, from the daily timeline."""

from collections import defaultdict
from datetime import date, datetime, timezone
from typing import Dict, List, Optional

from sqlmodel import Session, select

from backend.db.models import AssetCategory, CalculationVersion, Category
from backend.services.pnl.metrics_service import (
    PERIOD_RANGES,
    UNCATEGORIZED_CATEGORY_ID,
    _get_cumulative_realized_pnl,
    _list_version_account_ids,
    _resolve_category_to_asset_ids,
)
from backend.services.pnl.portfolio_timeline import (
    TimelinePoint,
    compute_portfolio_timeline_cached,
)
from backend.services.pnl.return_metrics import (
    ReturnMetrics,
    SeriesPoint,
    compute_return_metrics,
    range_start_dates,
    slice_period,
    timeline_to_series,
)

MAX_ACCOUNTS = 100


def _asset_series(
    session: Session,
    version_id: int,
    points: List[TimelinePoint],
    asset_ids: Optional[List[int]],
    account_ids: Optional[List[int]],
) -> Dict[int, List[SeriesPoint]]:
    """Per-asset {value, pnl} series; realized P&L is kept after a position closes."""
    buckets = [
        datetime.fromisoformat(p.date).replace(tzinfo=timezone.utc) for p in points
    ]
    rpnl = _get_cumulative_realized_pnl(
        session, version_id, buckets, asset_ids, account_ids
    )
    ids = {b.asset_id for p in points for b in p.breakdown}
    ids |= {aid for _, by_asset in rpnl.values() for aid in by_asset}

    out: Dict[int, List[SeriesPoint]] = {aid: [] for aid in ids}
    for p in points:
        realized = rpnl.get(p.date, (0.0, {}))[1]
        items = {b.asset_id: b for b in p.breakdown}
        for aid in ids:
            b = items.get(aid)
            cost = b.cost_basis_in_base if b else 0.0
            # Unpriced holdings are carried at cost.
            value = (b.value_in_base if b.priced else cost) if b else 0.0
            out[aid].append(
                SeriesPoint(p.date, value, value - cost + realized.get(aid, 0.0))
            )
    return out


def _sum_series(parts: List[tuple]) -> List[SeriesPoint]:
    """Weighted sum of aligned series: parts = [(weight, series), ...]."""
    if not parts:
        return []
    n = len(parts[0][1])
    return [
        SeriesPoint(
            parts[0][1][i].date,
            sum(w * s[i].value for w, s in parts),
            sum(w * s[i].pnl for w, s in parts),
        )
        for i in range(n)
    ]


def _category_series(
    session: Session,
    by_asset: Dict[int, List[SeriesPoint]],
    dimension_id: Optional[int],
    base_currency_id: Optional[int],
) -> Dict[int, List[SeriesPoint]]:
    """Category series from asset series; an asset in N categories counts 1/N (as in rankings)."""
    asset_ids = [a for a in by_asset if a != base_currency_id]
    query = select(AssetCategory.asset_id, AssetCategory.category_id).where(
        AssetCategory.asset_id.in_(asset_ids)
    )
    if dimension_id is not None:
        query = query.join(Category, AssetCategory.category_id == Category.id).where(
            Category.dimension_id == dimension_id
        )
    asset_to_cats: Dict[int, List[int]] = defaultdict(list)
    for row in session.exec(query).all() if asset_ids else []:
        asset_to_cats[row.asset_id].append(row.category_id)

    parts: Dict[int, List[tuple]] = defaultdict(list)
    for aid in asset_ids:
        cats = asset_to_cats.get(aid) or [UNCATEGORIZED_CATEGORY_ID]
        for cid in cats:
            parts[cid].append((1 / len(cats), by_asset[aid]))
    return {cid: _sum_series(p) for cid, p in parts.items()}


def compute_group_return_metrics(
    session: Session,
    version_id: int,
    group_by: str,
    period: str = "all",
    asset_ids: Optional[List[int]] = None,
    account_ids: Optional[List[int]] = None,
    category_ids: Optional[List[int]] = None,
    dimension_id: Optional[int] = None,
    include_unsettled_negative: bool = False,
) -> Optional[Dict[int, ReturnMetrics]]:
    version = session.get(CalculationVersion, version_id)
    if version is None:
        return None
    if category_ids:
        asset_ids = _resolve_category_to_asset_ids(session, category_ids, asset_ids)
        if asset_ids is None:
            return {}
    start = range_start_dates(date.today(), PERIOD_RANGES).get(period)

    def timeline(accounts: Optional[List[int]]) -> List[TimelinePoint]:
        return compute_portfolio_timeline_cached(
            session=session,
            version_id=version_id,
            granularity="daily",
            asset_ids=asset_ids,
            account_ids=accounts,
            include_unsettled_negative=include_unsettled_negative,
        )

    if group_by == "account":
        ids = _list_version_account_ids(session, version_id, asset_ids, account_ids)
        series = {
            aid: timeline_to_series(timeline([aid])) for aid in ids[:MAX_ACCOUNTS]
        }
    else:
        points = timeline(account_ids)
        if not points:
            return {}
        by_asset = _asset_series(session, version_id, points, asset_ids, account_ids)
        if group_by == "category":
            series = _category_series(
                session, by_asset, dimension_id, version.base_currency_id
            )
        else:
            by_asset.pop(version.base_currency_id, None)
            series = by_asset

    return {
        gid: compute_return_metrics(slice_period(s, start))
        for gid, s in series.items()
        if s
    }
