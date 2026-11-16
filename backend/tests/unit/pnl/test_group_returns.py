from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from backend.services.pnl import group_returns as gr
from backend.services.pnl.portfolio_timeline import BreakdownItem, TimelinePoint
from backend.services.pnl.return_metrics import timeline_to_series


def _item(aid, value, cost, priced=True):
    return BreakdownItem(
        asset_id=aid,
        symbol=f"A{aid}",
        label=None,
        value_in_base=value,
        qty=1.0,
        cost_basis_in_base=cost,
        realized_pnl_to_date=0.0,
        priced=priced,
    )


def _point(day, items, unpriced_cost=0.0):
    value = sum(b.value_in_base for b in items)
    cost = sum(b.cost_basis_in_base for b in items)
    return TimelinePoint(
        date=day,
        total_value_in_base=value,
        cost_basis_in_base=cost,
        unrealized_pnl=value - cost,
        cumulative_realized_pnl=0.0,
        breakdown=items,
        unpriced_cost_in_base=unpriced_cost,
    )


def _run(points, rpnl, group_by="asset"):
    session = MagicMock()
    session.get.return_value = SimpleNamespace(base_currency_id=99)
    with (
        patch.object(gr, "compute_portfolio_timeline_cached", return_value=points),
        patch.object(gr, "_get_cumulative_realized_pnl", return_value=rpnl),
    ):
        return gr.compute_group_return_metrics(session, 1, group_by, "all")


class TestAssetReturnMetrics:
    def test_closed_position_keeps_its_realized_gain(self):
        points = [
            _point("2024-01-01", [_item(1, 100.0, 100.0)]),
            _point("2024-01-02", [_item(1, 110.0, 100.0)]),
            _point("2024-01-03", []),
        ]
        rpnl = {
            "2024-01-01": (0.0, {}),
            "2024-01-02": (0.0, {}),
            "2024-01-03": (10.0, {1: 10.0}),
        }

        metrics = _run(points, rpnl)

        assert metrics[1].twr_pct == pytest.approx(10.0)

    def test_realized_only_asset_has_no_twr(self):
        points = [_point("2024-01-01", []), _point("2024-01-02", [])]
        rpnl = {"2024-01-01": (0.0, {}), "2024-01-02": (25.0, {7: 25.0})}

        metrics = _run(points, rpnl)

        assert metrics[7].twr_pct is None

    def test_unpriced_holding_is_carried_at_cost(self):
        points = [
            _point("2024-01-01", [_item(1, 100.0, 100.0)]),
            _point(
                "2024-01-02",
                [_item(1, 100.0, 100.0), _item(2, 0.0, 50.0, priced=False)],
            ),
        ]
        rpnl = {"2024-01-01": (0.0, {}), "2024-01-02": (0.0, {})}

        metrics = _run(points, rpnl)

        assert metrics[2].twr_pct == pytest.approx(0.0)
        assert 99 not in metrics

    def test_unknown_version_returns_none(self):
        session = MagicMock()
        session.get.return_value = None

        assert gr.compute_group_return_metrics(session, 1, "asset") is None


def test_timeline_series_carries_unpriced_cost():
    point = _point(
        "2024-01-02", [_item(2, 0.0, 50.0, priced=False)], unpriced_cost=50.0
    )

    s = timeline_to_series([point])[0]

    assert s.value == pytest.approx(50.0)
    assert s.pnl == pytest.approx(0.0)
