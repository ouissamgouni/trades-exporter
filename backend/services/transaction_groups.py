"""Date-grouped transaction recaps (month/day) for the grouped transaction tables."""

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import case, func, union
from sqlmodel import Session, select

from backend.api.schemas import (
    GroupAccountRecap,
    GroupAssetNet,
    GroupFacetValue,
    TransactionGroup,
    TransactionGroupFacets,
)
from backend.db.models import (
    Account,
    Asset,
    Direction,
    NormalizedTransaction,
    ReviewStatus,
)

GRANULARITIES = ("month", "day")
TOP_ASSETS_PER_ACCOUNT = 3


def resolve_timezone(tz_name: str) -> ZoneInfo:
    try:
        return ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError) as e:
        raise ValueError(f"Unknown timezone: {tz_name}") from e


def _next_period(start: date, granularity: str) -> date:
    if granularity == "day":
        return start + timedelta(days=1)
    if start.month == 12:
        return date(start.year + 1, 1, 1)
    return date(start.year, start.month + 1, 1)


def period_utc_bounds(
    start: date, granularity: str, tz: ZoneInfo
) -> Tuple[datetime, datetime]:
    """Inclusive naive-UTC bounds of a local period (matches naive-UTC date_time column)."""

    def to_utc(d: date) -> datetime:
        local = datetime(d.year, d.month, d.day, tzinfo=tz)
        return local.astimezone(timezone.utc).replace(tzinfo=None)

    lower = to_utc(start)
    upper = to_utc(_next_period(start, granularity)) - timedelta(microseconds=1)
    return lower, upper


def _issue_tx_ids(session: Session):
    from backend.services.data_health.detectors.linkage_detector import (
        LinkageIssueDetector,
    )
    from backend.services.data_health.detectors.missing_data_detector import (
        MissingDataDetector,
    )

    missing = MissingDataDetector(session)._build_issues_union()
    linkage = LinkageIssueDetector(session)._build_issues_union()
    return union(select(missing.c.tx_id), select(linkage.c.tx_id))


def compute_transaction_groups(
    session: Session,
    tx_ids_query,
    *,
    granularity: str,
    tz: ZoneInfo,
    sort_dir: str = "desc",
    limit: int = 24,
    offset: int = 0,
) -> Tuple[List[TransactionGroup], int]:
    """Aggregate the transactions selected by `tx_ids_query` (a SELECT of ids) per local period."""
    if granularity not in GRANULARITIES:
        raise ValueError(f"Unsupported granularity: {granularity}")

    nt = NormalizedTransaction
    local_dt = func.timezone(tz.key, func.timezone("UTC", nt.date_time))
    owned_ids = select(Account.id).where(Account.owned == True)  # noqa: E712
    is_internal = (
        nt.from_account_id.in_(owned_ids) & nt.to_account_id.in_(owned_ids)
    )
    has_issue = nt.id.in_(_issue_tx_ids(session))

    base = (
        select(
            nt.id.label("id"),
            func.date_trunc(granularity, local_dt).label("period"),
            nt.review_status.label("review_status"),
            nt.account_id.label("account_id"),
            nt.direction.label("direction"),
            nt.asset_id.label("asset_id"),
            nt.quantity.label("quantity"),
            nt.network.label("network"),
            nt.source.label("source"),
            case((is_internal, 1), else_=0).label("internal"),
            case((has_issue, 1), else_=0).label("has_issue"),
        )
        .where(nt.id.in_(tx_ids_query))
        .where(nt.date_time.isnot(None))
        .subquery()
    )
    not_invalid = base.c.review_status != ReviewStatus.INVALID.value

    total_groups = session.exec(
        select(func.count(func.distinct(base.c.period)))
    ).one()

    order = base.c.period.asc() if sort_dir == "asc" else base.c.period.desc()
    period_rows = session.exec(
        select(
            base.c.period,
            func.count().filter(not_invalid),
            func.count().filter(base.c.review_status == ReviewStatus.PENDING.value),
            func.count().filter(base.c.review_status == ReviewStatus.VALID.value),
            func.count().filter(base.c.review_status == ReviewStatus.INVALID.value),
            func.coalesce(func.sum(base.c.has_issue).filter(not_invalid), 0),
        )
        .group_by(base.c.period)
        .order_by(order)
        .offset(offset)
        .limit(limit)
    ).all()
    if not period_rows:
        return [], total_groups

    periods = [r[0] for r in period_rows]
    in_page = base.c.period.in_(periods)

    account_rows = session.exec(
        select(
            base.c.period,
            base.c.account_id,
            func.count().filter(base.c.direction == Direction.INFLOW.value),
            func.count().filter(base.c.direction == Direction.OUTFLOW.value),
            func.count().filter(
                base.c.direction.notin_(
                    [Direction.INFLOW.value, Direction.OUTFLOW.value]
                )
            ),
            func.coalesce(func.sum(base.c.internal), 0),
        )
        .where(in_page, not_invalid)
        .group_by(base.c.period, base.c.account_id)
    ).all()

    signed_qty = case(
        (base.c.direction == Direction.INFLOW.value, base.c.quantity),
        (base.c.direction == Direction.OUTFLOW.value, -base.c.quantity),
        else_=0,
    )
    asset_rows = session.exec(
        select(
            base.c.period,
            base.c.account_id,
            base.c.asset_id,
            func.sum(signed_qty),
            func.count(),
        )
        .where(in_page, not_invalid)
        .group_by(base.c.period, base.c.account_id, base.c.asset_id)
    ).all()

    def facet_rows(col):
        return session.exec(
            select(base.c.period, col, func.count())
            .where(in_page, not_invalid)
            .group_by(base.c.period, col)
        ).all()

    network_rows = facet_rows(base.c.network)
    source_rows = facet_rows(base.c.source)

    account_ids = {r[1] for r in account_rows if r[1] is not None}
    asset_ids = {r[2] for r in asset_rows if r[2] is not None}
    account_names: Dict[int, str] = (
        dict(session.exec(select(Account.id, Account.name).where(Account.id.in_(account_ids))).all())
        if account_ids
        else {}
    )
    asset_symbols: Dict[int, str] = (
        dict(session.exec(select(Asset.asset_id, Asset.symbol).where(Asset.asset_id.in_(asset_ids))).all())
        if asset_ids
        else {}
    )

    accounts_by_period: Dict[datetime, Dict[Optional[int], GroupAccountRecap]] = defaultdict(dict)
    for period, acc_id, inflow, outflow, neutral, internal in account_rows:
        accounts_by_period[period][acc_id] = GroupAccountRecap(
            account_id=acc_id,
            account_name=account_names.get(acc_id) if acc_id is not None else None,
            inflow_count=inflow,
            outflow_count=outflow,
            neutral_count=neutral,
            internal_transfer_count=int(internal),
        )

    assets_by_account: Dict[Tuple[datetime, Optional[int]], List[GroupAssetNet]] = defaultdict(list)
    asset_facets: Dict[datetime, Dict[Optional[int], int]] = defaultdict(lambda: defaultdict(int))
    for period, acc_id, asset_id, net, count in asset_rows:
        assets_by_account[(period, acc_id)].append(
            GroupAssetNet(
                asset_id=asset_id,
                symbol=asset_symbols.get(asset_id, "?") if asset_id is not None else "?",
                net_quantity=float(net or Decimal(0)),
                tx_count=count,
            )
        )
        asset_facets[period][asset_id] += count

    for (period, acc_id), assets in assets_by_account.items():
        recap = accounts_by_period[period].get(acc_id)
        if recap is None:
            continue
        assets.sort(key=lambda a: (-a.tx_count, a.symbol))
        recap.assets = assets[:TOP_ASSETS_PER_ACCOUNT]
        recap.more_assets_count = max(0, len(assets) - TOP_ASSETS_PER_ACCOUNT)

    def to_facets(rows) -> Dict[datetime, List[GroupFacetValue]]:
        out: Dict[datetime, List[GroupFacetValue]] = defaultdict(list)
        for period, value, count in rows:
            if value in (None, ""):
                continue
            out[period].append(GroupFacetValue(value=str(value), label=str(value), count=count))
        for values in out.values():
            values.sort(key=lambda v: -v.count)
        return out

    networks = to_facets(network_rows)
    sources = to_facets(source_rows)

    groups: List[TransactionGroup] = []
    for period, total, pending, valid, invalid, issues in period_rows:
        start = period.date()
        lower, upper = period_utc_bounds(start, granularity, tz)
        recaps = sorted(
            accounts_by_period.get(period, {}).values(),
            key=lambda r: -(r.inflow_count + r.outflow_count + r.neutral_count),
        )
        account_facets = [
            GroupFacetValue(
                value=str(r.account_id) if r.account_id is not None else "unmapped",
                label=r.account_name or "Unmapped",
                count=r.inflow_count + r.outflow_count + r.neutral_count,
            )
            for r in recaps
        ]
        asset_facet_values = sorted(
            (
                GroupFacetValue(
                    value=str(aid),
                    label=asset_symbols.get(aid, "?"),
                    count=c,
                )
                for aid, c in asset_facets.get(period, {}).items()
                if aid is not None
            ),
            key=lambda v: -v.count,
        )
        groups.append(
            TransactionGroup(
                period_start=start.isoformat(),
                date_from=lower.isoformat(),
                date_to=upper.isoformat(),
                total_count=total,
                pending_count=pending,
                valid_count=valid,
                invalid_count=invalid,
                health_issue_count=int(issues),
                accounts=recaps,
                facets=TransactionGroupFacets(
                    accounts=account_facets,
                    assets=asset_facet_values,
                    networks=networks.get(period, []),
                    sources=sources.get(period, []),
                ),
            )
        )
    return groups, total_groups
