"""Time-weighted (TWR) and money-weighted (IRR) returns, plus benchmark comparison.

External flows are derived from the value series: flow = ΔValue − Δ(unrealized + realized),
i.e. net capital put into (or taken out of) the positions. This works without recorded
deposits and stays consistent with Total return.
"""

from dataclasses import dataclass, field
from datetime import date
from typing import Dict, List, Optional, Sequence, Tuple


@dataclass
class SeriesPoint:
    date: str  # ISO date
    value: float
    pnl: float  # unrealized + cumulative realized


@dataclass
class ReturnMetrics:
    days: int
    twr_pct: Optional[float]
    twr_annualized_pct: Optional[float]
    irr_pct: Optional[float]  # annualized
    irr_period_pct: Optional[float]
    series: List[Tuple[str, float]] = field(
        default_factory=list
    )  # cumulative TWR % per date


@dataclass
class BenchmarkComparison:
    benchmark_return_pct: Optional[float]
    benchmark_annualized_pct: Optional[float]
    excess_pp: Optional[float]
    excess_annualized_pp: Optional[float]
    pme_value: Optional[float]
    actual_value: float
    series: List[Tuple[str, float]] = field(
        default_factory=list
    )  # rebased benchmark % per date


def _days_between(a: str, b: str) -> int:
    return (date.fromisoformat(b[:10]) - date.fromisoformat(a[:10])).days


def slice_period(
    points: Sequence[SeriesPoint], start: Optional[str]
) -> List[SeriesPoint]:
    """Points from the last one at/before `start` (the baseline) to the end."""
    if start is None:
        return list(points)
    base_idx = 0
    for i, p in enumerate(points):
        if p.date[:10] <= start[:10]:
            base_idx = i
        else:
            break
    return list(points[base_idx:])


def _flows(points: Sequence[SeriesPoint]) -> List[float]:
    return [
        (points[i].value - points[i - 1].value) - (points[i].pnl - points[i - 1].pnl)
        for i in range(1, len(points))
    ]


def _annualize(ret: float, days: int) -> Optional[float]:
    if days < 365 or ret <= -1:
        return None
    return (1 + ret) ** (365 / days) - 1


def _xirr(cashflows: List[Tuple[float, float]]) -> Optional[float]:
    """Annual rate r with sum(cf / (1+r)^years) = 0; None without a sign change."""
    if not any(cf > 0 for _, cf in cashflows) or not any(cf < 0 for _, cf in cashflows):
        return None

    def npv(r: float) -> float:
        return sum(cf / (1 + r) ** t for t, cf in cashflows)

    lo, hi = -0.9999, 10.0
    f_lo, f_hi = npv(lo), npv(hi)
    while f_lo * f_hi > 0 and hi < 1e6:
        hi *= 10
        f_hi = npv(hi)
    if f_lo * f_hi > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        f_mid = npv(mid)
        if abs(f_mid) < 1e-9:
            break
        if f_lo * f_mid < 0:
            hi = mid
        else:
            lo, f_lo = mid, f_mid
    return (lo + hi) / 2


def compute_return_metrics(points: Sequence[SeriesPoint]) -> ReturnMetrics:
    if len(points) < 2:
        return ReturnMetrics(0, None, None, None, None, [])
    days = _days_between(points[0].date, points[-1].date)
    flows = _flows(points)

    growth = 1.0
    series: List[Tuple[str, float]] = [(points[0].date, 0.0)]
    for i in range(1, len(points)):
        # Flows land at the start of the day; skip days with no capital at work.
        denom = points[i - 1].value + flows[i - 1]
        if denom > 1e-9:
            growth *= 1 + (points[i].pnl - points[i - 1].pnl) / denom
        series.append((points[i].date, round((growth - 1) * 100, 4)))
    twr = growth - 1
    has_capital = points[0].value > 1e-9 or any(f > 1e-9 for f in flows)

    cashflows: List[Tuple[float, float]] = []
    if points[0].value:
        cashflows.append((0.0, -points[0].value))
    for i, f in enumerate(flows, start=1):
        if f:
            cashflows.append((_days_between(points[0].date, points[i].date) / 365, -f))
    cashflows.append((days / 365, points[-1].value))
    irr = _xirr(cashflows) if days > 0 else None

    ann = _annualize(twr, days)
    return ReturnMetrics(
        days=days,
        twr_pct=round(twr * 100, 4) if has_capital else None,
        twr_annualized_pct=round(ann * 100, 4)
        if ann is not None and has_capital
        else None,
        irr_pct=round(irr * 100, 4) if irr is not None else None,
        irr_period_pct=(
            round(((1 + irr) ** (days / 365) - 1) * 100, 4) if irr is not None else None
        ),
        series=series if has_capital else [],
    )


def _price_on(
    prices: List[Tuple[str, float]], day: str, start_idx: int
) -> Tuple[Optional[float], int]:
    """Last price at/before `day` (forward-fill); returns (price, next search index)."""
    idx = start_idx
    last: Optional[float] = prices[idx - 1][1] if idx > 0 else None
    while idx < len(prices) and prices[idx][0][:10] <= day[:10]:
        last = prices[idx][1]
        idx += 1
    return last, idx


def compare_to_benchmark(
    points: Sequence[SeriesPoint],
    benchmark: Sequence[Tuple[str, float]],
    portfolio: ReturnMetrics,
) -> BenchmarkComparison:
    actual = points[-1].value if points else 0.0
    prices = sorted((d, c) for d, c in benchmark if c and c > 0)
    if len(points) < 2 or not prices:
        return BenchmarkComparison(None, None, None, None, None, actual, [])

    flows = _flows(points)
    aligned: List[Optional[float]] = []
    idx = 0
    for p in points:
        price, idx = _price_on(prices, p.date, idx)
        aligned.append(price)
    # Benchmark history may start after the portfolio: begin at its first quote.
    first = next((i for i, v in enumerate(aligned) if v), None)
    if first is None or first >= len(points) - 1:
        return BenchmarkComparison(None, None, None, None, None, actual, [])

    b0, b_end = aligned[first], aligned[-1]
    assert b0 is not None and b_end is not None
    bench_ret = b_end / b0 - 1
    series = [
        (points[i].date, round((aligned[i] / b0 - 1) * 100, 4))
        for i in range(first, len(points))
        if aligned[i]
    ]

    units = points[first].value / b0
    for i in range(first + 1, len(points)):
        units += flows[i - 1] / aligned[i]  # type: ignore[operator]
    pme = units * b_end

    days = _days_between(points[first].date, points[-1].date)
    bench_ann = _annualize(bench_ret, days)
    excess = (
        portfolio.twr_pct - bench_ret * 100 if portfolio.twr_pct is not None else None
    )
    excess_ann = (
        portfolio.twr_annualized_pct - bench_ann * 100
        if portfolio.twr_annualized_pct is not None and bench_ann is not None
        else None
    )
    return BenchmarkComparison(
        benchmark_return_pct=round(bench_ret * 100, 4),
        benchmark_annualized_pct=round(bench_ann * 100, 4)
        if bench_ann is not None
        else None,
        excess_pp=round(excess, 4) if excess is not None else None,
        excess_annualized_pp=round(excess_ann, 4) if excess_ann is not None else None,
        pme_value=round(pme, 2),
        actual_value=round(actual, 2),
        series=series,
    )


def timeline_to_series(timeline_points) -> List[SeriesPoint]:
    return [
        SeriesPoint(
            date=p.date,
            value=p.total_value_in_base,
            pnl=p.unrealized_pnl + p.cumulative_realized_pnl,
        )
        for p in timeline_points
    ]


def range_start_dates(
    today: date, period_days: Dict[str, Optional[int]]
) -> Dict[str, Optional[str]]:
    from datetime import timedelta

    return {
        key: (today - timedelta(days=d)).isoformat() if d else None
        for key, d in period_days.items()
    }
