"""
Unit tests for compute_period_summary.

Tests cover:
- All-time metrics computation
- Period-specific delta computation (unrealized change + realized in period)
- Top/flop ranking
- ROI calculation
- Edge cases (empty data, single asset, zero cost basis)
"""

import pytest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch, Mock, MagicMock

from backend.services.pnl.portfolio_timeline import (
    compute_period_summary,
    PeriodMetrics,
    AssetPerformer,
    PERIOD_RANGES,
)


# ============================================================================
# Helpers
# ============================================================================


def _utc(year, month, day):
    return datetime(year, month, day, tzinfo=timezone.utc)


def _make_version(base_currency_id=1):
    v = Mock()
    v.base_currency_id = base_currency_id
    return v


def _make_mock_session(version, min_date, max_date):
    """Create a mock session that returns a version and date range."""
    session = MagicMock()
    session.get.return_value = version

    # The range_query returns (min_date, max_date)
    mock_result = Mock()
    mock_result.one.return_value = (min_date, max_date)
    session.exec.return_value = mock_result

    return session


# ============================================================================
# Tests
# ============================================================================


class TestPeriodSummaryAllTime:
    """Tests for the 'all' range computation."""

    @patch("backend.services.pnl.portfolio_timeline._get_asset_labels")
    @patch("backend.services.pnl.portfolio_timeline._get_asset_symbols")
    @patch("backend.services.pnl.portfolio_timeline._get_cumulative_realized_pnl")
    @patch("backend.services.pnl.portfolio_timeline._get_price_at_dates")
    @patch("backend.services.pnl.portfolio_timeline._get_cost_basis_snapshots_at_dates")
    @patch("backend.services.pnl.portfolio_timeline._get_balance_snapshots_at_dates")
    def test_all_time_basic_metrics(
        self, mock_balances, mock_costs, mock_prices, mock_rpnl,
        mock_symbols, mock_labels,
    ):
        """All-time: total_return = unrealized + realized, roi = tr / cost_basis."""
        version = _make_version()
        session = _make_mock_session(version, _utc(2024, 1, 1), _utc(2024, 6, 1))

        # Asset 10 = BTC: 2 BTC, cost $20000, current price $30000
        # Asset 20 = ETH: 10 ETH, cost $15000, current price $2000
        # Now: value = 60000 + 20000 = 80000, cost = 20000 + 15000 = 35000
        # Unrealized = 80000 - 35000 = 45000
        # Realized = 5000
        # Total return = 45000 + 5000 = 50000
        # ROI = 50000 / 35000 = 142.86%

        # Return consistent data for any date key
        def balance_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 2.0, 20: 10.0} for d in a[2]}

        def cost_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 20000.0, 20: 15000.0} for d in a[2]}

        def price_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 30000.0, 20: 2000.0} for d in a[3]}

        def rpnl_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): (5000.0, {10: 3000.0, 20: 2000.0}) for d in a[2]}

        mock_balances.side_effect = balance_data
        mock_costs.side_effect = cost_data
        mock_prices.side_effect = price_data
        mock_rpnl.side_effect = rpnl_data
        mock_symbols.return_value = {10: "BTC", 20: "ETH"}
        mock_labels.return_value = {10: "Bitcoin", 20: "Ethereum"}

        result = compute_period_summary(session, version_id=1, top_n=5)

        assert "all" in result
        m = result["all"]
        assert m.current_value == 80000.0
        assert m.cost_basis == 35000.0
        assert m.unrealized_pnl == 45000.0
        assert m.realized_pnl == 5000.0
        assert m.total_return == 50000.0
        assert abs(m.roi_pct - 142.86) < 0.1

    @patch("backend.services.pnl.portfolio_timeline._get_asset_labels")
    @patch("backend.services.pnl.portfolio_timeline._get_asset_symbols")
    @patch("backend.services.pnl.portfolio_timeline._get_cumulative_realized_pnl")
    @patch("backend.services.pnl.portfolio_timeline._get_price_at_dates")
    @patch("backend.services.pnl.portfolio_timeline._get_cost_basis_snapshots_at_dates")
    @patch("backend.services.pnl.portfolio_timeline._get_balance_snapshots_at_dates")
    def test_top_flop_ranking(
        self, mock_balances, mock_costs, mock_prices, mock_rpnl,
        mock_symbols, mock_labels,
    ):
        """Top/flop performers should be ranked by total return."""
        version = _make_version()
        session = _make_mock_session(version, _utc(2024, 1, 1), _utc(2024, 6, 1))

        # BTC: value=60k, cost=20k → unrealized=40k + realized=3k = 43k total
        # ETH: value=20k, cost=15k → unrealized=5k + realized=2k = 7k total
        # DOGE: value=100, cost=500 → unrealized=-400 + realized=-100 = -500 total

        def balance_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 2.0, 20: 10.0, 30: 100.0} for d in a[2]}

        def cost_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 20000.0, 20: 15000.0, 30: 500.0} for d in a[2]}

        def price_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 30000.0, 20: 2000.0, 30: 1.0} for d in a[3]}

        def rpnl_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): (4900.0, {10: 3000.0, 20: 2000.0, 30: -100.0}) for d in a[2]}

        mock_balances.side_effect = balance_data
        mock_costs.side_effect = cost_data
        mock_prices.side_effect = price_data
        mock_rpnl.side_effect = rpnl_data
        mock_symbols.return_value = {10: "BTC", 20: "ETH", 30: "DOGE"}
        mock_labels.return_value = {10: "Bitcoin", 20: "Ethereum", 30: "Dogecoin"}

        result = compute_period_summary(session, version_id=1, top_n=2)

        m = result["all"]
        # Top performers: BTC (43000), ETH (7000)
        assert len(m.top_performers) == 2
        assert m.top_performers[0].symbol == "BTC"
        assert m.top_performers[0].label == "Bitcoin"
        assert m.top_performers[0].total_return == 43000.0
        assert m.top_performers[1].symbol == "ETH"

        # Flop performers: DOGE (-500)
        assert len(m.flop_performers) == 1
        assert m.flop_performers[0].symbol == "DOGE"
        assert m.flop_performers[0].total_return == -500.0


class TestPeriodSummaryRanges:
    """Tests for specific period ranges (1m, 3m, etc.)."""

    @patch("backend.services.pnl.portfolio_timeline._get_asset_labels")
    @patch("backend.services.pnl.portfolio_timeline._get_asset_symbols")
    @patch("backend.services.pnl.portfolio_timeline._get_cumulative_realized_pnl")
    @patch("backend.services.pnl.portfolio_timeline._get_price_at_dates")
    @patch("backend.services.pnl.portfolio_timeline._get_cost_basis_snapshots_at_dates")
    @patch("backend.services.pnl.portfolio_timeline._get_balance_snapshots_at_dates")
    def test_period_delta_computation(
        self, mock_balances, mock_costs, mock_prices, mock_rpnl,
        mock_symbols, mock_labels,
    ):
        """Period return = unrealized_change + realized_in_period."""
        version = _make_version()
        now = datetime.now(timezone.utc)
        start_date = _utc(2023, 1, 1)
        session = _make_mock_session(version, start_date, now)

        now_str = now.strftime("%Y-%m-%d")
        # For 1m range, start is ~30 days ago
        one_month_ago = (now - timedelta(days=30))
        one_month_str = one_month_ago.strftime("%Y-%m-%d")

        # Now: BTC value=60k, cost=20k → unrealized=40k, cum_realized=8k
        # 1m ago: BTC value=50k, cost=18k → unrealized=32k, cum_realized=5k
        # Period delta: unrealized_change = 40k-32k = 8k, realized_in_period = 8k-5k = 3k
        # Total return = 8k + 3k = 11k
        # ROI base = start cost = 18k → ROI = 11000/18000 = 61.11%

        def balance_data(*a, **kw):
            result = {}
            for d in a[2]:
                ds = d.strftime("%Y-%m-%d")
                if ds == now_str:
                    result[ds] = {10: 2.0}
                else:
                    result[ds] = {10: 2.0}  # same qty
            return result

        def cost_data(*a, **kw):
            result = {}
            for d in a[2]:
                ds = d.strftime("%Y-%m-%d")
                if ds == now_str:
                    result[ds] = {10: 20000.0}
                else:
                    result[ds] = {10: 18000.0}
            return result

        def price_data(*a, **kw):
            result = {}
            for d in a[3]:
                ds = d.strftime("%Y-%m-%d")
                if ds == now_str:
                    result[ds] = {10: 30000.0}  # value = 60k
                else:
                    result[ds] = {10: 25000.0}  # value = 50k
            return result

        def rpnl_data(*a, **kw):
            result = {}
            for d in a[2]:
                ds = d.strftime("%Y-%m-%d")
                if ds == now_str:
                    result[ds] = (8000.0, {10: 8000.0})
                else:
                    result[ds] = (5000.0, {10: 5000.0})
            return result

        mock_balances.side_effect = balance_data
        mock_costs.side_effect = cost_data
        mock_prices.side_effect = price_data
        mock_rpnl.side_effect = rpnl_data
        mock_symbols.return_value = {10: "BTC"}
        mock_labels.return_value = {10: "Bitcoin"}

        result = compute_period_summary(session, version_id=1)

        # Check 1m range
        m = result["1m"]
        assert m.realized_in_period == 3000.0
        assert m.total_return == 11000.0
        assert abs(m.roi_pct - 61.11) < 0.1


class TestPeriodSummaryEdgeCases:
    """Edge case tests."""

    def test_version_not_found(self):
        """Should return empty dict if version doesn't exist."""
        session = MagicMock()
        session.get.return_value = None

        result = compute_period_summary(session, version_id=999)
        assert result == {}

    @patch("backend.services.pnl.portfolio_timeline._get_asset_labels")
    @patch("backend.services.pnl.portfolio_timeline._get_asset_symbols")
    @patch("backend.services.pnl.portfolio_timeline._get_cumulative_realized_pnl")
    @patch("backend.services.pnl.portfolio_timeline._get_price_at_dates")
    @patch("backend.services.pnl.portfolio_timeline._get_cost_basis_snapshots_at_dates")
    @patch("backend.services.pnl.portfolio_timeline._get_balance_snapshots_at_dates")
    def test_zero_cost_basis_no_division_error(
        self, mock_balances, mock_costs, mock_prices, mock_rpnl,
        mock_symbols, mock_labels,
    ):
        """Zero cost basis should yield 0% ROI, not a division error."""
        version = _make_version()
        session = _make_mock_session(version, _utc(2024, 1, 1), _utc(2024, 6, 1))

        def balance_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 1.0} for d in a[2]}

        def cost_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 0.0} for d in a[2]}

        def price_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 1000.0} for d in a[3]}

        def rpnl_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): (0.0, {}) for d in a[2]}

        mock_balances.side_effect = balance_data
        mock_costs.side_effect = cost_data
        mock_prices.side_effect = price_data
        mock_rpnl.side_effect = rpnl_data
        mock_symbols.return_value = {10: "AIRDROP"}
        mock_labels.return_value = {10: None}

        result = compute_period_summary(session, version_id=1)

        for key in PERIOD_RANGES:
            assert key in result
            assert result[key].roi_pct == 0.0

    @patch("backend.services.pnl.portfolio_timeline._get_asset_labels")
    @patch("backend.services.pnl.portfolio_timeline._get_asset_symbols")
    @patch("backend.services.pnl.portfolio_timeline._get_cumulative_realized_pnl")
    @patch("backend.services.pnl.portfolio_timeline._get_price_at_dates")
    @patch("backend.services.pnl.portfolio_timeline._get_cost_basis_snapshots_at_dates")
    @patch("backend.services.pnl.portfolio_timeline._get_balance_snapshots_at_dates")
    def test_all_ranges_present(
        self, mock_balances, mock_costs, mock_prices, mock_rpnl,
        mock_symbols, mock_labels,
    ):
        """All 5 standard ranges should be present in the result."""
        version = _make_version()
        session = _make_mock_session(version, _utc(2024, 1, 1), _utc(2024, 6, 1))

        def any_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {} for d in a[2]}

        def price_any_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {} for d in a[3]}

        def rpnl_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): (0.0, {}) for d in a[2]}

        mock_balances.side_effect = any_data
        mock_costs.side_effect = any_data
        mock_prices.side_effect = price_any_data
        mock_rpnl.side_effect = rpnl_data
        mock_symbols.return_value = {}
        mock_labels.return_value = {}

        result = compute_period_summary(session, version_id=1)

        assert set(result.keys()) == {"all", "1y", "6m", "3m", "1m"}

    @patch("backend.services.pnl.portfolio_timeline._get_asset_labels")
    @patch("backend.services.pnl.portfolio_timeline._get_asset_symbols")
    @patch("backend.services.pnl.portfolio_timeline._get_cumulative_realized_pnl")
    @patch("backend.services.pnl.portfolio_timeline._get_price_at_dates")
    @patch("backend.services.pnl.portfolio_timeline._get_cost_basis_snapshots_at_dates")
    @patch("backend.services.pnl.portfolio_timeline._get_balance_snapshots_at_dates")
    def test_flop_only_includes_negatives(
        self, mock_balances, mock_costs, mock_prices, mock_rpnl,
        mock_symbols, mock_labels,
    ):
        """Flop performers should only include assets with negative total return."""
        version = _make_version()
        session = _make_mock_session(version, _utc(2024, 1, 1), _utc(2024, 6, 1))

        # All assets with positive returns
        def balance_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 1.0, 20: 1.0} for d in a[2]}

        def cost_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 100.0, 20: 100.0} for d in a[2]}

        def price_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 200.0, 20: 150.0} for d in a[3]}

        def rpnl_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): (0.0, {}) for d in a[2]}

        mock_balances.side_effect = balance_data
        mock_costs.side_effect = cost_data
        mock_prices.side_effect = price_data
        mock_rpnl.side_effect = rpnl_data
        mock_symbols.return_value = {10: "BTC", 20: "ETH"}
        mock_labels.return_value = {10: "Bitcoin", 20: "Ethereum"}

        result = compute_period_summary(session, version_id=1, top_n=1)

        m = result["all"]
        assert len(m.top_performers) == 1
        assert m.top_performers[0].symbol == "BTC"  # higher return
        assert len(m.flop_performers) == 0  # no negatives
