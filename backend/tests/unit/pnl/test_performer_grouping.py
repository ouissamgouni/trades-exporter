"""
Performer grouping consistency:
- every grouping aggregates the same per-asset items (net is grouping-invariant)
- by-account uses a per-account snapshot (exact period return, scoped fees)
- uncategorized assets land in an "Uncategorized" bucket
- gains/losses totals are asset-level
"""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

from backend.db.models import CalculationVersion
from backend.services.pnl.metrics_service import (
    UNCATEGORIZED_CATEGORY_ID,
    _account_performer,
    _build_asset_items,
    _rank_performers_by_category,
    _VersionSnapshot,
    compute_performers,
)

MOCK_PREFIX = "backend.services.pnl.metrics_service"

# BTC +50 unrealized +10 realized, ETH -30 unrealized, SOL closed with realized -5, EUR base
NOW_BAL = {1: 1.0, 2: 1.0, 221: 500.0}
NOW_COST = {1: 100.0, 2: 100.0, 221: 500.0}
NOW_PRICES = {1: 150.0, 2: 70.0, 221: 1.0}
NOW_RPNL = {1: 10.0, 3: -5.0}


def _items(range_key="all", base=221):
    return _build_asset_items(
        {1, 2, 221},
        NOW_BAL,
        NOW_COST,
        NOW_PRICES,
        NOW_RPNL,
        {},
        {},
        {},
        {},
        {1: "BTC", 2: "ETH", 3: "SOL"},
        {},
        range_key,
        {1: 2.0, 2: 1.0},
        base,
        {1: 4.0},
    )


class TestBuildAssetItems:
    def test_realized_only_asset_is_included(self):
        ids = {i.id for i in _items()}
        assert ids == {1, 2, 3}

    def test_fields(self):
        btc = next(i for i in _items() if i.id == 1)
        assert btc.total_return == 60.0
        assert btc.realized_pnl == 10.0
        assert btc.income == 4.0
        assert btc.total_fees == 2.0
        assert btc.roi_base == 100.0


class TestCategoryGrouping:
    def _session(self, cat_rows, categories):
        session = MagicMock()
        r1, r2 = Mock(), Mock()
        r1.all.return_value = cat_rows
        r2.all.return_value = categories
        session.exec.side_effect = [r1, r2]
        return session

    def test_uncategorized_bucket_and_net_invariant(self):
        session = self._session(
            [SimpleNamespace(asset_id=1, category_id=7)],
            [SimpleNamespace(id=7, label="Crypto L1")],
        )
        top, flop, total = _rank_performers_by_category(
            session,
            {1, 2, 221},
            NOW_BAL,
            NOW_COST,
            NOW_PRICES,
            NOW_RPNL,
            {},
            {},
            {},
            {},
            "all",
            50,
            fees_by_asset={1: 2.0, 2: 1.0},
            base_currency_id=221,
        )
        by_id = {p.id: p for p in top + flop}
        assert set(by_id) == {7, UNCATEGORIZED_CATEGORY_ID}
        assert by_id[UNCATEGORIZED_CATEGORY_ID].name == "Uncategorized"
        assert by_id[UNCATEGORIZED_CATEGORY_ID].total_return == -35.0
        net_categories = sum(p.total_return for p in top + flop)
        net_assets = sum(i.total_return for i in _items())
        assert round(net_categories, 2) == round(net_assets, 2)


def _snap(now, start):
    return _VersionSnapshot(
        version=CalculationVersion(version_id=1, base_currency_id=221),
        base_currency_id=221,
        min_date=now - timedelta(days=800),
        now=now,
        now_ds=now.strftime("%Y-%m-%d"),
        now_lot_balances={},
        now_lot_remaining_costs={},
        now_lot_invested={},
        all_asset_ids={1, 221},
        range_starts={"1y": start},
        unique_dates=[start, now],
        balance_snapshots={
            now.strftime("%Y-%m-%d"): {1: 2.0, 221: 300.0},
            start.strftime("%Y-%m-%d"): {1: 2.0, 221: 300.0},
        },
        cost_basis_snapshots={
            now.strftime("%Y-%m-%d"): {1: 200.0, 221: 300.0},
            start.strftime("%Y-%m-%d"): {1: 200.0, 221: 300.0},
        },
    )


class TestAccountPerformer:
    @patch(f"{MOCK_PREFIX}._get_income_by_asset", return_value={1: 3.0})
    @patch(f"{MOCK_PREFIX}._get_fees_by_asset", return_value={1: 7.0})
    @patch(f"{MOCK_PREFIX}._build_realized_pnl_snapshots")
    @patch(f"{MOCK_PREFIX}._build_price_snapshot")
    @patch(f"{MOCK_PREFIX}._build_version_snapshot")
    def test_period_return_is_unrealized_change_plus_realized(
        self, mock_snap, mock_prices, mock_rpnl, mock_fees, mock_income
    ):
        now = datetime(2026, 11, 10, tzinfo=timezone.utc)
        start = now - timedelta(days=365)
        mock_snap.return_value = _snap(now, start)
        mock_prices.return_value = {
            now.strftime("%Y-%m-%d"): {1: 130.0, 221: 1.0},
            start.strftime("%Y-%m-%d"): {1: 120.0, 221: 1.0},
        }
        mock_rpnl.return_value = {
            now.strftime("%Y-%m-%d"): (15.0, {1: 15.0}),
            start.strftime("%Y-%m-%d"): (5.0, {1: 5.0}),
        }

        item = _account_performer(MagicMock(), 1, 9, "1y", None, False)

        # unrealized 60 -> 40 = +20 change, realized in period +10
        assert item.total_return == 30.0
        assert item.unrealized_pnl == 60.0
        assert item.realized_pnl == 10.0
        assert item.market_value == 260.0 + 300.0  # cash included
        assert item.cost_basis == 200.0 + 300.0
        assert item.roi_pct == 15.0  # 30 / start cost 200
        assert item.total_fees == 7.0
        assert item.income == 3.0
        assert mock_fees.call_args[0][1:] == (1, [9])


class TestAccountSparklines:
    def test_series_shape(self):
        from backend.services.pnl import portfolio_timeline as pt

        point = pt.TimelinePoint(
            date="2026-11-02",
            total_value_in_base=120.0,
            cost_basis_in_base=100.0,
            unrealized_pnl=20.0,
            cumulative_realized_pnl=5.0,
        )
        empty = pt.TimelinePoint(
            date="2026-11-02",
            total_value_in_base=0.0,
            cost_basis_in_base=0.0,
            unrealized_pnl=0.0,
            cumulative_realized_pnl=0.0,
        )
        with patch.object(
            pt, "compute_portfolio_timeline_cached", side_effect=[[point], [empty]]
        ) as compute:
            out = pt.compute_account_sparklines(MagicMock(), 1, [4, 5])
        assert out[4] == [
            {"date": "2026-11-02", "value": 120.0, "roi": 25.0, "pnl": 25.0}
        ]
        assert out[5][0]["roi"] is None
        assert compute.call_args_list[0].kwargs["account_ids"] == [4]
        assert compute.call_args_list[0].kwargs["granularity"] == "weekly"


class TestComputePerformersTotals:
    @patch(f"{MOCK_PREFIX}._get_income_by_asset", return_value={})
    @patch(f"{MOCK_PREFIX}._get_invested_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._get_fees_by_asset", return_value={})
    @patch(f"{MOCK_PREFIX}._get_asset_labels", return_value={})
    @patch(f"{MOCK_PREFIX}._get_asset_symbols", return_value={10: "BTC", 11: "ETH"})
    @patch(f"{MOCK_PREFIX}._get_cumulative_realized_pnl")
    @patch(f"{MOCK_PREFIX}._get_price_at_dates")
    @patch(f"{MOCK_PREFIX}._get_cost_basis_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._get_balance_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._get_current_from_cost_lots")
    def test_gains_losses_net(
        self,
        mock_lots,
        mock_balances,
        mock_costs,
        mock_prices,
        mock_rpnl,
        _symbols,
        _labels,
        _fees,
        _invested,
        _income,
    ):
        session = MagicMock()
        session.get.return_value = CalculationVersion(
            version_id=1, base_currency_id=221
        )
        result = Mock()
        result.one.return_value = (
            datetime(2024, 1, 1, tzinfo=timezone.utc),
            datetime(2024, 6, 1, tzinfo=timezone.utc),
        )
        session.exec.return_value = result

        mock_lots.return_value = ({10: 1.0, 11: 1.0}, {10: 100.0, 11: 100.0}, {})
        mock_balances.side_effect = lambda *a, **k: {
            d.strftime("%Y-%m-%d"): {10: 1.0, 11: 1.0} for d in a[2]
        }
        mock_costs.side_effect = lambda *a, **k: {
            d.strftime("%Y-%m-%d"): {10: 100.0, 11: 100.0} for d in a[2]
        }
        mock_prices.side_effect = lambda *a, **k: {
            d.strftime("%Y-%m-%d"): {10: 180.0, 11: 70.0} for d in a[3]
        }
        mock_rpnl.side_effect = lambda *a, **k: {
            d.strftime("%Y-%m-%d"): (0.0, {}) for d in a[2]
        }

        res = compute_performers(session, version_id=1, period="all", top_n=50)

        assert res.gains_total == 80.0
        assert res.losses_total == -30.0
        assert res.net_total == 50.0
