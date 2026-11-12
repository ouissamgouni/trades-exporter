from backend.services.pnl.return_metrics import (
    SeriesPoint,
    compare_to_benchmark,
    compute_return_metrics,
    slice_period,
)


def _pts(rows):
    return [SeriesPoint(d, v, p) for d, v, p in rows]


def test_twr_equals_growth_without_flows():
    m = compute_return_metrics(
        _pts(
            [
                ("2025-01-01", 100, 0),
                ("2025-07-01", 110, 10),
                ("2026-01-01", 121, 21),
            ]
        )
    )
    assert m.twr_pct == 21.0
    assert m.irr_period_pct is not None and abs(m.irr_period_pct - 21.0) < 0.01


def test_twr_ignores_deposit_timing():
    # +10%, then a 100 deposit, then +10% on the larger base
    m = compute_return_metrics(
        _pts(
            [
                ("2025-01-01", 100, 0),
                ("2025-01-02", 110, 10),
                ("2025-01-03", 210, 10),
                ("2025-01-04", 231, 31),
            ]
        )
    )
    assert abs(m.twr_pct - 21.0) < 1e-6
    assert m.twr_annualized_pct is None


def test_irr_one_year_investment():
    m = compute_return_metrics(_pts([("2025-01-01", 100, 0), ("2026-01-01", 110, 10)]))
    assert abs(m.irr_pct - 10.0) < 0.01
    assert abs(m.twr_annualized_pct - 10.0) < 0.01


def test_pme_matches_actual_when_holding_the_benchmark():
    pts = _pts(
        [
            ("2025-01-01", 100, 0),
            ("2025-01-02", 110, 10),
            ("2025-01-03", 210, 10),
            ("2025-01-04", 231, 31),
        ]
    )
    bench = [
        ("2025-01-01", 10.0),
        ("2025-01-02", 11.0),
        ("2025-01-04", 12.1),
    ]  # 01-03 forward-filled
    cmp = compare_to_benchmark(pts, bench, compute_return_metrics(pts))
    assert abs(cmp.pme_value - 231.0) < 0.01
    assert abs(cmp.benchmark_return_pct - 21.0) < 1e-6
    assert abs(cmp.excess_pp) < 1e-6


def test_slice_period_keeps_baseline_point():
    pts = _pts([("2025-01-01", 1, 0), ("2025-02-01", 2, 0), ("2025-03-01", 3, 0)])
    assert [p.date for p in slice_period(pts, "2025-02-15")] == [
        "2025-02-01",
        "2025-03-01",
    ]
    assert len(slice_period(pts, None)) == 3


def test_not_enough_points_returns_none():
    m = compute_return_metrics(_pts([("2025-01-01", 100, 0)]))
    assert m.twr_pct is None and m.irr_pct is None
    cmp = compare_to_benchmark(_pts([("2025-01-01", 100, 0)]), [], m)
    assert cmp.pme_value is None
