"""
Unit tests for compute_version_metrics (metrics_service).

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

from backend.services.pnl.metrics_service import (
    compute_version_metrics,
    VersionMetrics,
    SummaryMetrics,
    RangeMetrics,
    PerformerItem,
    PERIOD_RANGES,
)


# ============================================================================
# Helpers
# ============================================================================

MOCK_PREFIX = "backend.services.pnl.metrics_service"


@pytest.fixture(autouse=True)
def _no_deferred_gain_query():
    # Sessions are mocked here; these DB aggregates are covered elsewhere.
    with patch(f"{MOCK_PREFIX}._get_deferred_gain", return_value=0.0), \
            patch(f"{MOCK_PREFIX}._get_net_deposits", return_value=0.0):
        yield


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


class TestVersionMetricsAllTime:
    """Tests for the 'all' range computation."""

    @patch(f"{MOCK_PREFIX}._get_invested_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._refresh_prices_for_assets")
    @patch(f"{MOCK_PREFIX}._get_fees_by_asset")
    @patch(f"{MOCK_PREFIX}._compute_fees_in_period")
    @patch(f"{MOCK_PREFIX}._compute_fee_summary")
    @patch(f"{MOCK_PREFIX}._get_asset_labels")
    @patch(f"{MOCK_PREFIX}._get_asset_symbols")
    @patch(f"{MOCK_PREFIX}._get_cumulative_realized_pnl")
    @patch(f"{MOCK_PREFIX}._get_price_at_dates")
    @patch(f"{MOCK_PREFIX}._get_cost_basis_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._get_balance_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._get_current_from_cost_lots")
    def test_all_time_basic_metrics(
        self, mock_lot_current, mock_balances, mock_costs, mock_prices, mock_rpnl,
        mock_symbols, mock_labels, mock_fees, mock_fees_period, mock_fees_asset, mock_refresh, mock_invested,
    ):
        """All-time: total_return = unrealized + realized, roi = tr / cost_basis."""
        version = _make_version()
        session = _make_mock_session(version, _utc(2024, 1, 1), _utc(2024, 6, 1))
        mock_fees_asset.return_value = {}

        mock_lot_current.return_value = ({10: 2.0, 20: 10.0}, {10: 20000.0, 20: 15000.0}, {10: 20000.0, 20: 15000.0})

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
        mock_fees.return_value = (0.0, 0)
        mock_fees_period.return_value = 0.0
        mock_refresh.return_value = None

        result = compute_version_metrics(session, version_id=1, top_n=5)

        assert result is not None
        assert "all" in result.ranges
        m = result.ranges["all"]
        assert m.current_value == 80000.0
        assert m.cost_basis == 35000.0
        assert m.unrealized_pnl == 45000.0
        assert m.realized_pnl == 5000.0
        assert m.total_return == 50000.0
        assert abs(m.roi_pct - 142.86) < 0.1

    @patch(f"{MOCK_PREFIX}._get_invested_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._refresh_prices_for_assets")
    @patch(f"{MOCK_PREFIX}._get_fees_by_asset")
    @patch(f"{MOCK_PREFIX}._compute_fees_in_period")
    @patch(f"{MOCK_PREFIX}._compute_fee_summary")
    @patch(f"{MOCK_PREFIX}._get_asset_labels")
    @patch(f"{MOCK_PREFIX}._get_asset_symbols")
    @patch(f"{MOCK_PREFIX}._get_cumulative_realized_pnl")
    @patch(f"{MOCK_PREFIX}._get_price_at_dates")
    @patch(f"{MOCK_PREFIX}._get_cost_basis_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._get_balance_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._get_current_from_cost_lots")
    def test_top_flop_ranking(
        self, mock_lot_current, mock_balances, mock_costs, mock_prices, mock_rpnl,
        mock_symbols, mock_labels, mock_fees, mock_fees_period, mock_fees_asset, mock_refresh, mock_invested,
    ):
        """Top/flop performers should be ranked by total return."""
        version = _make_version()
        session = _make_mock_session(version, _utc(2024, 1, 1), _utc(2024, 6, 1))
        mock_fees_asset.return_value = {}

        mock_lot_current.return_value = (
            {10: 2.0, 20: 10.0, 30: 100.0},
            {10: 20000.0, 20: 15000.0, 30: 500.0},
            {10: 20000.0, 20: 15000.0, 30: 500.0},
        )

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
        mock_fees.return_value = (0.0, 0)
        mock_fees_period.return_value = 0.0
        mock_refresh.return_value = None

        result = compute_version_metrics(session, version_id=1, top_n=2)

        assert result is not None
        m = result.ranges["all"]
        # Top performers: BTC (43000), ETH (7000)
        assert len(m.top_performers) == 2
        assert m.top_performers[0].name == "BTC"
        assert m.top_performers[0].label == "Bitcoin"
        assert m.top_performers[0].total_return == 43000.0
        assert m.top_performers[1].name == "ETH"

        # Flop performers: DOGE (-500)
        assert len(m.flop_performers) == 1
        assert m.flop_performers[0].name == "DOGE"
        assert m.flop_performers[0].total_return == -500.0


class TestVersionMetricsRanges:
    """Tests for specific period ranges (1m, 3m, etc.)."""

    @patch(f"{MOCK_PREFIX}._get_invested_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._refresh_prices_for_assets")
    @patch(f"{MOCK_PREFIX}._get_fees_by_asset")
    @patch(f"{MOCK_PREFIX}._compute_fees_in_period")
    @patch(f"{MOCK_PREFIX}._compute_fee_summary")
    @patch(f"{MOCK_PREFIX}._get_asset_labels")
    @patch(f"{MOCK_PREFIX}._get_asset_symbols")
    @patch(f"{MOCK_PREFIX}._get_cumulative_realized_pnl")
    @patch(f"{MOCK_PREFIX}._get_price_at_dates")
    @patch(f"{MOCK_PREFIX}._get_cost_basis_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._get_balance_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._get_current_from_cost_lots")
    def test_period_delta_computation(
        self, mock_lot_current, mock_balances, mock_costs, mock_prices, mock_rpnl,
        mock_symbols, mock_labels, mock_fees, mock_fees_period, mock_fees_asset, mock_refresh, mock_invested,
    ):
        """Period return = unrealized_change + realized_in_period."""
        version = _make_version()
        now = datetime.now(timezone.utc)
        start_date = _utc(2023, 1, 1)
        session = _make_mock_session(version, start_date, now)
        mock_fees_asset.return_value = {}

        now_str = now.strftime("%Y-%m-%d")

        mock_lot_current.return_value = ({10: 2.0}, {10: 20000.0}, {10: 20000.0})

        def balance_data(*a, **kw):
            result = {}
            for d in a[2]:
                ds = d.strftime("%Y-%m-%d")
                result[ds] = {10: 2.0}
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
                    result[ds] = {10: 30000.0}
                else:
                    result[ds] = {10: 25000.0}
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
        mock_fees.return_value = (0.0, 0)
        mock_fees_period.return_value = 0.0
        mock_refresh.return_value = None

        result = compute_version_metrics(session, version_id=1)

        assert result is not None
        # Check 1m range
        m = result.ranges["1m"]
        assert m.realized_in_period == 3000.0
        assert m.total_return == 11000.0
        assert abs(m.roi_pct - 61.11) < 0.1


class TestVersionMetricsEdgeCases:
    """Edge case tests."""

    def test_version_not_found(self):
        """Should return None if version doesn't exist."""
        session = MagicMock()
        session.get.return_value = None

        result = compute_version_metrics(session, version_id=999)
        assert result is None

    @patch(f"{MOCK_PREFIX}._get_invested_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._refresh_prices_for_assets")
    @patch(f"{MOCK_PREFIX}._get_fees_by_asset")
    @patch(f"{MOCK_PREFIX}._compute_fees_in_period")
    @patch(f"{MOCK_PREFIX}._compute_fee_summary")
    @patch(f"{MOCK_PREFIX}._get_asset_labels")
    @patch(f"{MOCK_PREFIX}._get_asset_symbols")
    @patch(f"{MOCK_PREFIX}._get_cumulative_realized_pnl")
    @patch(f"{MOCK_PREFIX}._get_price_at_dates")
    @patch(f"{MOCK_PREFIX}._get_cost_basis_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._get_balance_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._get_current_from_cost_lots")
    def test_zero_cost_basis_no_division_error(
        self, mock_lot_current, mock_balances, mock_costs, mock_prices, mock_rpnl,
        mock_symbols, mock_labels, mock_fees, mock_fees_period, mock_fees_asset, mock_refresh, mock_invested,
    ):
        """Zero cost basis should yield 0% ROI, not a division error."""
        version = _make_version()
        session = _make_mock_session(version, _utc(2024, 1, 1), _utc(2024, 6, 1))
        mock_fees_asset.return_value = {}

        mock_lot_current.return_value = ({10: 1.0}, {10: 0.0}, {10: 0.0})

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
        mock_fees.return_value = (0.0, 0)
        mock_fees_period.return_value = 0.0
        mock_refresh.return_value = None

        result = compute_version_metrics(session, version_id=1)

        assert result is not None
        for key in PERIOD_RANGES:
            assert key in result.ranges
            assert result.ranges[key].roi_pct == 0.0

    @patch(f"{MOCK_PREFIX}._get_invested_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._refresh_prices_for_assets")
    @patch(f"{MOCK_PREFIX}._get_fees_by_asset")
    @patch(f"{MOCK_PREFIX}._compute_fees_in_period")
    @patch(f"{MOCK_PREFIX}._compute_fee_summary")
    @patch(f"{MOCK_PREFIX}._get_asset_labels")
    @patch(f"{MOCK_PREFIX}._get_asset_symbols")
    @patch(f"{MOCK_PREFIX}._get_cumulative_realized_pnl")
    @patch(f"{MOCK_PREFIX}._get_price_at_dates")
    @patch(f"{MOCK_PREFIX}._get_cost_basis_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._get_balance_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._get_current_from_cost_lots")
    def test_all_ranges_present(
        self, mock_lot_current, mock_balances, mock_costs, mock_prices, mock_rpnl,
        mock_symbols, mock_labels, mock_fees, mock_fees_period, mock_fees_asset, mock_refresh, mock_invested,
    ):
        """All 5 standard ranges should be present in the result."""
        version = _make_version()
        session = _make_mock_session(version, _utc(2024, 1, 1), _utc(2024, 6, 1))
        mock_fees_asset.return_value = {}

        mock_lot_current.return_value = ({}, {}, {})

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
        mock_fees.return_value = (0.0, 0)
        mock_fees_period.return_value = 0.0
        mock_refresh.return_value = None

        result = compute_version_metrics(session, version_id=1)

        assert result is not None
        assert set(result.ranges.keys()) == {"all", "3y", "1y", "6m", "3m", "1m", "1w"}

    @patch(f"{MOCK_PREFIX}._get_invested_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._refresh_prices_for_assets")
    @patch(f"{MOCK_PREFIX}._get_fees_by_asset")
    @patch(f"{MOCK_PREFIX}._compute_fees_in_period")
    @patch(f"{MOCK_PREFIX}._compute_fee_summary")
    @patch(f"{MOCK_PREFIX}._get_asset_labels")
    @patch(f"{MOCK_PREFIX}._get_asset_symbols")
    @patch(f"{MOCK_PREFIX}._get_cumulative_realized_pnl")
    @patch(f"{MOCK_PREFIX}._get_price_at_dates")
    @patch(f"{MOCK_PREFIX}._get_cost_basis_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._get_balance_snapshots_at_dates")
    @patch(f"{MOCK_PREFIX}._get_current_from_cost_lots")
    def test_flop_only_includes_negatives(
        self, mock_lot_current, mock_balances, mock_costs, mock_prices, mock_rpnl,
        mock_symbols, mock_labels, mock_fees, mock_fees_period, mock_fees_asset, mock_refresh, mock_invested,
    ):
        """Flop performers should only include assets with negative total return."""
        version = _make_version()
        session = _make_mock_session(version, _utc(2024, 1, 1), _utc(2024, 6, 1))
        mock_fees_asset.return_value = {}

        mock_lot_current.return_value = ({10: 1.0, 20: 1.0}, {10: 100.0, 20: 100.0}, {10: 100.0, 20: 100.0})

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
        mock_fees.return_value = (0.0, 0)
        mock_fees_period.return_value = 0.0
        mock_refresh.return_value = None

        result = compute_version_metrics(session, version_id=1, top_n=1)

        assert result is not None
        m = result.ranges["all"]
        assert len(m.top_performers) == 1
        assert m.top_performers[0].name == "BTC"  # higher return
        assert len(m.flop_performers) == 0  # no negatives
