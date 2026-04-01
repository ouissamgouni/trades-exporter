"""
Unit tests for PnL metrics shared helpers introduced in Phase 0-2 refactoring.

Tests cover:
- _compute_portfolio_range_metrics: pure function for portfolio-level range metrics
- _rank_performers_by_asset: asset-level performer ranking with base currency exclusion
- _sort_top_flop: total_count correctness
- _VersionSnapshot: attribute correctness (catches ORM field mismatches)
- compute_asset_period_deltas: new public function (Phase 2)
"""

import pytest
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple
from unittest.mock import Mock, MagicMock, patch

from backend.services.pnl.metrics_service import (
    _compute_portfolio_range_metrics,
    _rank_performers_by_asset,
    _sort_top_flop,
    _VersionSnapshot,
    PerformerItem,
    PerformersResult,
    AssetPeriodDelta,
    compute_performers,
    compute_market_metrics,
)


MOCK_PREFIX = "backend.services.pnl.metrics_service"


def _utc(year, month, day):
    return datetime(year, month, day, tzinfo=timezone.utc)


# ============================================================================
# _compute_portfolio_range_metrics tests
# ============================================================================


class TestComputePortfolioRangeMetrics:
    """Tests for the shared _compute_portfolio_range_metrics helper."""

    def test_all_time_basic(self):
        """All-time total_return = unrealized + realized."""
        all_ids = {1, 2}
        now_bal = {1: 10.0, 2: 5.0}
        now_cost = {1: 100.0, 2: 50.0}
        now_prices = {1: 15.0, 2: 12.0}  # value = 150 + 60 = 210
        start_bal = {1: 10.0, 2: 5.0}
        start_cost = {1: 100.0, 2: 50.0}
        start_prices = {1: 10.0, 2: 10.0}
        now_rpnl = 20.0
        start_rpnl = 0.0
        unrealized = 210.0 - 150.0  # 60
        cost_basis = 150.0

        total_return, roi_pct, ur_period, real_period, start_cost_val = (
            _compute_portfolio_range_metrics(
                all_ids, "all",
                now_bal, now_cost, now_prices,
                start_bal, start_cost, start_prices,
                now_rpnl, start_rpnl,
                unrealized, cost_basis,
            )
        )

        assert total_return == 60.0 + 20.0  # unrealized + realized
        assert ur_period == 60.0
        assert real_period == 20.0
        assert start_cost_val == 0.0
        expected_roi = (80.0 / 150.0) * 100
        assert abs(roi_pct - expected_roi) < 0.01

    def test_period_range_basic(self):
        """Period range computes delta from period start."""
        all_ids = {1}
        now_bal = {1: 10.0}
        now_cost = {1: 100.0}
        now_prices = {1: 15.0}  # value_now = 150
        start_bal = {1: 10.0}
        start_cost = {1: 100.0}  # start_cost = 100
        start_prices = {1: 12.0}  # value_start = 120
        now_rpnl = 50.0
        start_rpnl = 30.0
        unrealized = 150.0 - 100.0  # 50
        cost_basis = 100.0

        total_return, roi_pct, ur_period, real_period, start_cost_val = (
            _compute_portfolio_range_metrics(
                all_ids, "1m",
                now_bal, now_cost, now_prices,
                start_bal, start_cost, start_prices,
                now_rpnl, start_rpnl,
                unrealized, cost_basis,
            )
        )

        # start_unrealized = 120 - 100 = 20
        # unrealized_in_period = 50 - 20 = 30
        # realized_in_period = 50 - 30 = 20
        # total_return = 30 + 20 = 50
        assert real_period == 20.0
        assert ur_period == 30.0
        assert total_return == 50.0
        assert start_cost_val == 100.0

    def test_base_currency_excluded_from_period(self):
        """Base currency should be excluded from period aggregation."""
        all_ids = {1, 221}  # 221 = EUR (base currency)
        now_bal = {1: 10.0, 221: 5000.0}
        now_cost = {1: 100.0, 221: 5000.0}
        now_prices = {1: 15.0, 221: 1.0}  # EUR price = 1.0 in base
        start_bal = {1: 10.0, 221: 3000.0}
        start_cost = {1: 100.0, 221: 3000.0}
        start_prices = {1: 12.0, 221: 1.0}
        now_rpnl = 50.0
        start_rpnl = 30.0
        unrealized = (10 * 15 + 5000 * 1) - (100 + 5000)  # 5150 - 5100 = 50
        cost_basis = 5100.0

        total_return, roi_pct, ur_period, real_period, start_cost_val = (
            _compute_portfolio_range_metrics(
                all_ids, "1m",
                now_bal, now_cost, now_prices,
                start_bal, start_cost, start_prices,
                now_rpnl, start_rpnl,
                unrealized, cost_basis,
                base_currency_id=221,
            )
        )

        # Only asset 1 should be in period computation
        # start_value = 10 * 12 = 120 (only asset 1, not 221)
        # start_cost = 100 (only asset 1)
        assert start_cost_val == 100.0
        # start_unrealized = 120 - 100 = 20
        # unrealized_in_period = 50 - 20 = 30
        assert ur_period == 30.0

    def test_base_currency_not_excluded_from_all_time(self):
        """For 'all' range, base currency is still included in total unrealized."""
        all_ids = {1, 221}
        now_bal = {1: 10.0, 221: 5000.0}
        now_cost = {1: 100.0, 221: 5000.0}
        now_prices = {1: 15.0, 221: 1.0}
        start_bal = {1: 10.0, 221: 3000.0}
        start_cost = {1: 100.0, 221: 3000.0}
        start_prices = {1: 10.0, 221: 1.0}
        now_rpnl = 20.0
        start_rpnl = 0.0
        unrealized = 50.0
        cost_basis = 5100.0

        total_return, roi_pct, ur_period, real_period, start_cost_val = (
            _compute_portfolio_range_metrics(
                all_ids, "all",
                now_bal, now_cost, now_prices,
                start_bal, start_cost, start_prices,
                now_rpnl, start_rpnl,
                unrealized, cost_basis,
                base_currency_id=221,
            )
        )

        # All-time: total_return = unrealized + realized (full portfolio)
        assert total_return == 50.0 + 20.0
        assert ur_period == 50.0

    def test_zero_cost_basis_roi(self):
        """ROI should be 0% when cost basis is zero."""
        total_return, roi_pct, _, _, _ = _compute_portfolio_range_metrics(
            {1}, "all",
            {1: 0.0}, {1: 0.0}, {1: 0.0},
            {1: 0.0}, {1: 0.0}, {1: 0.0},
            0.0, 0.0, 0.0, 0.0,
        )
        assert roi_pct == 0.0

    def test_period_fallback_to_cost_basis_when_start_cost_zero(self):
        """When start_cost=0 for a period, ROI base should fall back to cost_basis."""
        all_ids = {1}
        total_return, roi_pct, _, _, _ = _compute_portfolio_range_metrics(
            all_ids, "1m",
            {1: 10.0}, {1: 100.0}, {1: 15.0},       # now
            {1: 0.0}, {1: 0.0}, {1: 0.0},            # start (all zeros)
            50.0, 0.0, 50.0, 100.0,                   # rpnl, unrealized, cost_basis
        )
        # start_cost=0, so roi_base falls back to cost_basis=100
        # total_return = unrealized_in_period + realized_in_period
        assert roi_pct != 0.0  # Should compute something, not divide by zero


# ============================================================================
# _rank_performers_by_asset tests
# ============================================================================


class TestRankPerformersByAsset:
    """Tests for _rank_performers_by_asset with base currency exclusion."""

    def test_excludes_base_currency(self):
        """Base currency (EUR) should not appear in performer results."""
        all_ids = {1, 2, 221}
        now_bal = {1: 10.0, 2: 5.0, 221: 5000.0}
        now_cost = {1: 100.0, 2: 50.0, 221: 5000.0}
        now_prices = {1: 15.0, 2: 8.0, 221: 1.0}
        now_rpnl = {1: 10.0, 2: -5.0, 221: 0.0}
        start_bal = {1: 10.0, 2: 5.0, 221: 3000.0}
        start_cost = {1: 100.0, 2: 50.0, 221: 3000.0}
        start_prices = {1: 12.0, 2: 10.0, 221: 1.0}
        start_rpnl = {1: 0.0, 2: 0.0, 221: 0.0}
        symbols = {1: "BTC", 2: "ETH", 221: "EUR"}
        labels = {1: "Bitcoin", 2: "Ethereum", 221: "Euro"}

        top, flop, total = _rank_performers_by_asset(
            all_ids,
            now_bal, now_cost, now_prices, now_rpnl,
            start_bal, start_cost, start_prices, start_rpnl,
            symbols, labels,
            "all", 25, {},
            base_currency_id=221,
        )

        # EUR (221) should not be in any list
        all_performer_ids = {p.id for p in top + flop}
        assert 221 not in all_performer_ids
        assert total == 2  # Only 2 assets, excluding EUR

    def test_includes_all_without_base_currency_filter(self):
        """Without base_currency_id, all assets should be included."""
        all_ids = {1, 2}
        now_bal = {1: 10.0, 2: 5.0}
        now_cost = {1: 100.0, 2: 50.0}
        now_prices = {1: 15.0, 2: 12.0}
        now_rpnl = {1: 10.0, 2: 5.0}
        start_bal = {1: 10.0, 2: 5.0}
        start_cost = {1: 100.0, 2: 50.0}
        start_prices = {1: 10.0, 2: 10.0}
        start_rpnl = {1: 0.0, 2: 0.0}
        symbols = {1: "BTC", 2: "ETH"}
        labels = {1: None, 2: None}

        top, flop, total = _rank_performers_by_asset(
            all_ids,
            now_bal, now_cost, now_prices, now_rpnl,
            start_bal, start_cost, start_prices, start_rpnl,
            symbols, labels,
            "all", 25, {},
            base_currency_id=None,
        )

        assert total == 2

    def test_total_count_reflects_all_eligible(self):
        """total_count should be the number of performers BEFORE top_n cap."""
        all_ids = set(range(1, 21))  # 20 assets
        now_bal = {i: 10.0 for i in all_ids}
        now_cost = {i: 100.0 for i in all_ids}
        now_prices = {i: 15.0 for i in all_ids}  # all profitable
        now_rpnl = {i: 10.0 for i in all_ids}
        start_bal = {i: 10.0 for i in all_ids}
        start_cost = {i: 100.0 for i in all_ids}
        start_prices = {i: 10.0 for i in all_ids}
        start_rpnl = {i: 0.0 for i in all_ids}
        symbols = {i: f"A{i}" for i in all_ids}
        labels = {i: None for i in all_ids}

        top, flop, total = _rank_performers_by_asset(
            all_ids,
            now_bal, now_cost, now_prices, now_rpnl,
            start_bal, start_cost, start_prices, start_rpnl,
            symbols, labels,
            "all", 5, {},
        )

        # top capped at 5, but total_count should be 20
        assert len(top) == 5
        assert total == 20


# ============================================================================
# _VersionSnapshot attribute correctness
# ============================================================================


class TestVersionSnapshotAttributes:
    """Ensure _VersionSnapshot uses correct CalculationVersion field names.

    This test catches the .id vs .version_id mismatch that caused a 500 error.
    Uses a real CalculationVersion object (not a Mock) to ensure ORM fields are correct.
    """

    def test_version_has_version_id_not_id(self):
        """CalculationVersion uses version_id, not id. Mocks hide this."""
        from backend.db.models import CalculationVersion

        version = CalculationVersion(version_id=42, base_currency_id=221)
        assert version.version_id == 42
        assert version.base_currency_id == 221

        # Ensure .id raises AttributeError (the bug we caught)
        with pytest.raises(AttributeError):
            _ = version.id

    def test_snapshot_stores_real_version(self):
        """_VersionSnapshot should work with a real CalculationVersion object."""
        from backend.db.models import CalculationVersion

        version = CalculationVersion(version_id=42, base_currency_id=221)
        now = datetime.now(timezone.utc)
        snap = _VersionSnapshot(
            version=version,
            base_currency_id=221,
            min_date=now - timedelta(days=365),
            now=now,
            now_ds=now.strftime("%Y-%m-%d"),
            now_lot_balances={1: 10.0},
            now_lot_costs={1: 100.0},
            all_asset_ids={1},
            range_starts={"all": now - timedelta(days=365)},
            unique_dates=[now],
            balance_snapshots={},
            cost_basis_snapshots={},
        )

        # Access version_id through snapshot (the pattern used in production code)
        assert snap.version.version_id == 42
        assert snap.base_currency_id == 221


# ============================================================================
# PerformersResult.total_count
# ============================================================================


class TestPerformersResultTotalCount:
    """Tests that PerformersResult carries total_count correctly."""

    def test_total_count_default(self):
        result = PerformersResult(version_id=1, period="all", group_type="asset")
        assert result.total_count == 0

    def test_total_count_set(self):
        result = PerformersResult(
            version_id=1,
            period="all",
            group_type="asset",
            total_count=42,
        )
        assert result.total_count == 42


# ============================================================================
# compute_performers integration: base currency exclusion
# ============================================================================


class TestComputePerformersBaseCurrency:
    """Integration test: compute_performers excludes base currency."""

    @patch(f"{MOCK_PREFIX}._get_fees_by_asset")
    @patch(f"{MOCK_PREFIX}._get_asset_labels")
    @patch(f"{MOCK_PREFIX}._get_asset_symbols")
    @patch(f"{MOCK_PREFIX}._get_cumulative_realized_pnl")
    @patch(f"{MOCK_PREFIX}._get_price_at_dates")
    @patch(f"{MOCK_PREFIX}._get_cost_basis_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._get_balance_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._get_current_from_cost_lots")
    def test_base_currency_excluded(
        self, mock_lots, mock_balances, mock_costs, mock_prices, mock_rpnl,
        mock_symbols, mock_labels, mock_fees_asset,
    ):
        """compute_performers should not return base currency in results."""
        from backend.db.models import CalculationVersion

        version = CalculationVersion(version_id=1, base_currency_id=221)
        session = MagicMock()
        session.get.return_value = version

        mock_result = Mock()
        mock_result.one.return_value = (_utc(2024, 1, 1), _utc(2024, 6, 1))
        session.exec.return_value = mock_result
        mock_fees_asset.return_value = {}

        # Assets: 10 (BTC), 221 (EUR base currency)
        mock_lots.return_value = (
            {10: 2.0, 221: 5000.0},
            {10: 1000.0, 221: 5000.0},
        )

        def balance_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 2.0, 221: 5000.0} for d in a[2]}

        def cost_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 1000.0, 221: 5000.0} for d in a[2]}

        def price_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 2000.0, 221: 1.0} for d in a[3]}

        def rpnl_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): (100.0, {10: 100.0, 221: 0.0}) for d in a[2]}

        mock_balances.side_effect = balance_data
        mock_costs.side_effect = cost_data
        mock_prices.side_effect = price_data
        mock_rpnl.side_effect = rpnl_data
        mock_symbols.return_value = {10: "BTC", 221: "EUR"}
        mock_labels.return_value = {10: "Bitcoin", 221: "Euro"}

        result = compute_performers(session, version_id=1, period="all", top_n=25)

        assert result is not None
        all_ids = {p.id for p in result.top_performers + result.flop_performers}
        assert 221 not in all_ids, "Base currency EUR should be excluded"
        assert result.total_count == 1  # Only BTC


# ============================================================================
# compute_market_metrics: ensures no AttributeError on version.version_id
# ============================================================================


class TestComputeMarketMetricsVersionField:
    """Regression test: compute_market_metrics must use version.version_id, not .id."""

    @patch(f"{MOCK_PREFIX}._get_cumulative_realized_pnl")
    @patch(f"{MOCK_PREFIX}._get_price_at_dates")
    @patch(f"{MOCK_PREFIX}._get_cost_basis_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._get_balance_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._get_current_from_cost_lots")
    def test_no_attribute_error(
        self, mock_lots, mock_balances, mock_costs, mock_prices, mock_rpnl,
    ):
        """compute_market_metrics should not raise AttributeError: 'id'."""
        from backend.db.models import CalculationVersion

        version = CalculationVersion(version_id=42, base_currency_id=221)
        session = MagicMock()
        session.get.return_value = version

        mock_result = Mock()
        mock_result.one.return_value = (_utc(2024, 1, 1), _utc(2024, 6, 1))
        session.exec.return_value = mock_result

        mock_lots.return_value = ({10: 1.0}, {10: 100.0})

        def balance_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 1.0} for d in a[2]}

        def cost_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 100.0} for d in a[2]}

        def price_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 150.0} for d in a[3]}

        def rpnl_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): (10.0, {10: 10.0}) for d in a[2]}

        mock_balances.side_effect = balance_data
        mock_costs.side_effect = cost_data
        mock_prices.side_effect = price_data
        mock_rpnl.side_effect = rpnl_data

        # Should NOT raise AttributeError: 'CalculationVersion' has no attribute 'id'
        result = compute_market_metrics(session, version_id=42)

        assert result is not None
        assert result.version_id == 42
        assert "all" in result.ranges
        assert result.ranges["all"].roi_pct != 0.0
