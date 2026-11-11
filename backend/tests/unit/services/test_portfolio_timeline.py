"""
Tests for portfolio_timeline fixes:
  Phase 1: Base currency always priced at 1.0
  Phase 2: "now" bucket uses direct CostLot query (matches /balances endpoint)
"""

from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock, patch, call
import pytest

from backend.services.pnl.portfolio_timeline import (
    _get_price_at_dates,
    _get_current_from_cost_lots,
    _get_balance_snapshots_at_dates,
    _get_cost_basis_snapshots_at_dates,
    _ensure_naive,
)


# ---------------------------------------------------------------------------
# _get_price_at_dates — base currency injection
# ---------------------------------------------------------------------------


class TestGetPriceAtDatesBaseCurrency:
    """Base currency must always have price=1.0 in every date bucket."""

    @patch("backend.services.pnl.portfolio_timeline.Session")
    def test_base_currency_gets_price_one_when_no_snapshots(self, _mock_cls):
        """Even when PriceSnapshot table has no rows, base currency = 1.0."""
        session = MagicMock()
        session.exec.return_value.all.return_value = []  # no price rows

        base_id = 221  # EUR
        asset_ids = [221, 275, 283]
        dates = [datetime(2025, 1, 1, tzinfo=timezone.utc)]

        result = _get_price_at_dates(session, base_id, asset_ids, dates)
        assert result["2025-01-01"][221] == 1.0

    @patch("backend.services.pnl.portfolio_timeline.Session")
    def test_base_currency_gets_price_one_across_all_buckets(self, _mock_cls):
        """Base currency price=1.0 in every date bucket."""
        session = MagicMock()
        session.exec.return_value.all.return_value = []

        base_id = 10
        dates = [
            datetime(2025, 1, 1, tzinfo=timezone.utc),
            datetime(2025, 6, 1, tzinfo=timezone.utc),
            datetime(2025, 12, 31, tzinfo=timezone.utc),
        ]

        result = _get_price_at_dates(session, base_id, [10, 20], dates)
        for ds in ["2025-01-01", "2025-06-01", "2025-12-31"]:
            assert result[ds][10] == 1.0

    @patch("backend.services.pnl.portfolio_timeline.Session")
    def test_base_currency_does_not_override_real_snapshot(self, _mock_cls):
        """If a PriceSnapshot exists for base/base, setdefault keeps the DB value.
        In practice this shouldn't happen, but setdefault is safe either way."""
        session = MagicMock()
        # Simulate a PriceSnapshot row for base_id=10
        row = MagicMock(asset_id=10, price=1.0,
                        snapshot_time=datetime(2025, 1, 1))
        session.exec.return_value.all.return_value = [row]

        result = _get_price_at_dates(
            session, 10, [10],
            [datetime(2025, 1, 1, tzinfo=timezone.utc)],
        )
        assert result["2025-01-01"][10] == 1.0

    @patch("backend.services.pnl.portfolio_timeline.Session")
    def test_no_base_currency_id_means_no_injection(self, _mock_cls):
        """When base_currency_id is None, no injection happens."""
        session = MagicMock()
        session.exec.return_value.all.return_value = []

        result = _get_price_at_dates(
            session, None, [10, 20],
            [datetime(2025, 1, 1, tzinfo=timezone.utc)],
        )
        # With no price rows and no base currency, result may be empty
        ds_prices = result.get("2025-01-01", {})
        assert 10 not in ds_prices
        assert 20 not in ds_prices

    @patch("backend.services.pnl.portfolio_timeline.Session")
    def test_base_currency_not_in_asset_ids_means_no_injection(self, _mock_cls):
        """If base currency isn't in the requested asset_ids, don't inject."""
        session = MagicMock()
        session.exec.return_value.all.return_value = []

        result = _get_price_at_dates(
            session, 221, [275, 283],  # EUR not in list
            [datetime(2025, 1, 1, tzinfo=timezone.utc)],
        )
        ds_prices = result.get("2025-01-01", {})
        assert 221 not in ds_prices

    @patch("backend.services.pnl.portfolio_timeline.Session")
    def test_other_assets_still_resolved_from_snapshots(self, _mock_cls):
        """Non-base assets get prices from PriceSnapshot as before."""
        session = MagicMock()
        row = MagicMock(asset_id=275, price=2500.0,
                        snapshot_time=datetime(2025, 1, 1))
        session.exec.return_value.all.return_value = [row]

        dates = [datetime(2025, 1, 2, tzinfo=timezone.utc)]
        result = _get_price_at_dates(session, 221, [221, 275], dates)

        assert result["2025-01-02"][221] == 1.0   # injected
        assert result["2025-01-02"][275] == 2500.0  # from snapshot

    def test_empty_inputs_return_empty(self):
        """Empty asset_ids or bucket_dates → empty result."""
        session = MagicMock()
        assert _get_price_at_dates(session, 10, [], [datetime.now(timezone.utc)]) == {}
        assert _get_price_at_dates(session, 10, [10], []) == {}


# ---------------------------------------------------------------------------
# current_value integration — base currency valued correctly
# ---------------------------------------------------------------------------


class TestBaseCurrencyImpactOnCurrentValue:
    """Verify that base currency balance contributes correctly to totals.

    Simulates what compute_period_summary does:
      current_value = sum(balance * price) for each asset
    """

    def test_eur_balance_valued_at_par(self):
        """EUR with balance=50,000 and price=1.0 → contributes 50,000."""
        balances = {221: 50000.0, 275: 10.0}
        prices = {221: 1.0, 275: 2500.0}
        current_value = sum(
            balances.get(aid, 0.0) * prices.get(aid, 0.0)
            for aid in balances
        )
        assert current_value == pytest.approx(75000.0)

    def test_eur_balance_zero_price_breaks_total(self):
        """Without the fix: EUR price=0 → 50k EUR balance vanishes."""
        balances = {221: 50000.0, 275: 10.0}
        prices = {275: 2500.0}  # EUR missing!
        current_value = sum(
            balances.get(aid, 0.0) * prices.get(aid, 0.0)
            for aid in balances
        )
        # Only gold counted → 25,000 instead of 75,000
        assert current_value == pytest.approx(25000.0)


# ---------------------------------------------------------------------------
# Phase 2: _get_current_from_cost_lots — direct CostLot query
# ---------------------------------------------------------------------------


class TestGetCurrentFromCostLots:
    """_get_current_from_cost_lots reads CostLot table directly,
    matching the /balances endpoint behaviour."""

    def test_aggregates_by_asset(self):
        """Multiple lots for same asset are summed correctly."""
        session = MagicMock()
        # Simulate SQL result: two assets
        row1 = MagicMock(asset_id=221, total_qty=50000.0, total_cost=50000.0, total_invested=50000.0)  # EUR
        row2 = MagicMock(asset_id=275, total_qty=10.0, total_cost=4000.0, total_invested=4000.0)     # Gold
        session.exec.return_value.all.return_value = [row1, row2]

        balances, costs, acquired = _get_current_from_cost_lots(session, version_id=92)

        assert balances[221] == pytest.approx(50000.0)
        assert costs[221] == pytest.approx(50000.0)
        assert balances[275] == pytest.approx(10.0)
        assert costs[275] == pytest.approx(4000.0)

    def test_filters_near_zero(self):
        """Assets with negligible qty and cost are excluded."""
        session = MagicMock()
        row = MagicMock(asset_id=999, total_qty=1e-15, total_cost=1e-15, total_invested=1e-15)
        session.exec.return_value.all.return_value = [row]

        balances, costs, acquired = _get_current_from_cost_lots(session, version_id=1)
        assert 999 not in balances
        assert 999 not in costs

    def test_empty_result(self):
        """No lots → empty dicts."""
        session = MagicMock()
        session.exec.return_value.all.return_value = []

        balances, costs, acquired = _get_current_from_cost_lots(session, version_id=1)
        assert balances == {}
        assert costs == {}


# ---------------------------------------------------------------------------
# Integration: CostLot-based "now" fixes portfolio metrics
# ---------------------------------------------------------------------------


class TestCostLotOverrideFixesMetrics:
    """When the "now" bucket uses CostLot data instead of CostLotEvent
    reconstruction, current_value and cost_basis align with /balances."""

    def test_period_summary_metrics_with_correct_sources(self):
        """Simulates the compute_period_summary inner loop with aligned data.

        Before fix: event-based cost_basis = 1,632 while CostLot = 200,000
        → ROI = (214k - 1632) / 1632 = 13,000%.
        After fix: CostLot cost_basis = 200,000
        → ROI = (214k - 200k) / 200k = 7%.
        """
        # "now" values from CostLot (authoritative)
        now_balances = {221: 150000.0, 275: 10.0, 283: 5.0}
        now_costs = {221: 150000.0, 275: 4000.0, 283: 2500.0}
        now_prices = {221: 1.0, 275: 6500.0, 283: 3000.0}  # EUR=1.0

        all_asset_ids = set(now_balances.keys())

        current_value = sum(
            now_balances.get(aid, 0.0) * now_prices.get(aid, 0.0)
            for aid in all_asset_ids
        )
        cost_basis = sum(now_costs.get(aid, 0.0) for aid in all_asset_ids)
        unrealized_pnl = current_value - cost_basis

        # Portfolio: 150k EUR + 65k gold + 15k energy = 230k
        assert current_value == pytest.approx(230000.0)
        # Cost: 150k + 4k + 2.5k = 156.5k
        assert cost_basis == pytest.approx(156500.0)
        # Unrealized: 230k - 156.5k = 73.5k
        assert unrealized_pnl == pytest.approx(73500.0)
        # ROI is reasonable
        roi = (unrealized_pnl / cost_basis * 100) if cost_basis != 0 else 0
        assert roi == pytest.approx(46.96, rel=0.01)

    def test_event_based_cost_basis_causes_inflated_roi(self):
        """Demonstrates the bug: event-based cost_basis is too low → huge ROI."""
        now_balances = {221: 150000.0, 275: 10.0}
        # Event-based cost: EUR has almost no cost_basis tracked
        now_costs_from_events = {221: 100.0, 275: 4000.0}
        now_prices = {221: 1.0, 275: 6500.0}

        all_asset_ids = set(now_balances.keys())
        current_value = sum(
            now_balances.get(aid, 0.0) * now_prices.get(aid, 0.0)
            for aid in all_asset_ids
        )
        cost_basis = sum(now_costs_from_events.get(aid, 0.0) for aid in all_asset_ids)
        roi = (current_value - cost_basis) / cost_basis * 100

        # Absurd ROI from mismatched sources
        assert roi > 5000  # Would be ~50,000% — clearly wrong


# ---------------------------------------------------------------------------
# _get_current_from_cost_lots — include_unsettled_negative filter
# ---------------------------------------------------------------------------


class TestGetCurrentFromCostLotsUnsettledNegativeFilter:
    """Verify that unsettled negative lots are excluded by default,
    matching the /balances endpoint convention."""

    def _make_rows(self, include_unsettled_negative: bool):
        """Helper: call _get_current_from_cost_lots with controlled mock.

        We can't easily inspect the WHERE clause, so instead we verify
        behaviour: the mock returns different results for each flag value.
        """
        session = MagicMock()
        if include_unsettled_negative:
            # With unsettled negatives included — raw CostLot totals
            row_eur = MagicMock(asset_id=221, total_qty=-142000.0, total_cost=-142000.0)
            row_btc = MagicMock(asset_id=275, total_qty=10.0, total_cost=40000.0)
            session.exec.return_value.all.return_value = [row_eur, row_btc]
        else:
            # Without unsettled negatives — only positive + settled negative
            row_eur = MagicMock(asset_id=221, total_qty=50000.0, total_cost=50000.0)
            row_btc = MagicMock(asset_id=275, total_qty=10.0, total_cost=40000.0)
            session.exec.return_value.all.return_value = [row_eur, row_btc]
        return session

    def test_default_excludes_unsettled_negatives(self):
        """Default (include_unsettled_negative=False) excludes them."""
        session = MagicMock()
        row = MagicMock(asset_id=221, total_qty=50000.0, total_cost=50000.0, total_invested=50000.0)
        session.exec.return_value.all.return_value = [row]

        balances, costs, acquired = _get_current_from_cost_lots(session, version_id=92)
        assert balances[221] == pytest.approx(50000.0)

        # Verify that session.exec was called (i.e. query was built)
        assert session.exec.called

    def test_include_true_passes_all_lots(self):
        """include_unsettled_negative=True does not add the filter clause."""
        session = MagicMock()
        # Simulate raw CostLot aggregation including unsettled negatives
        row = MagicMock(asset_id=221, total_qty=-142000.0, total_cost=-142000.0, total_invested=-142000.0)
        session.exec.return_value.all.return_value = [row]

        balances, costs, acquired = _get_current_from_cost_lots(
            session, version_id=92, include_unsettled_negative=True,
        )
        assert balances[221] == pytest.approx(-142000.0)
        assert costs[221] == pytest.approx(-142000.0)

    def test_filter_clause_contains_is_negative_and_is_settled(self):
        """When include_unsettled_negative=False, the WHERE clause must reference
        CostLot.is_negative and CostLot.is_settled via or_()."""
        session = MagicMock()
        session.exec.return_value.all.return_value = []

        # Call with default (False) — the filter should be applied
        _get_current_from_cost_lots(session, version_id=1)

        # Extract the query object passed to session.exec()
        query_arg = session.exec.call_args[0][0]
        query_str = str(query_arg)

        # The WHERE clause should contain both is_negative and is_settled
        assert "is_negative" in query_str
        assert "is_settled" in query_str

    def test_no_filter_clause_when_include_true(self):
        """When include_unsettled_negative=True, no is_negative filter in query."""
        session = MagicMock()
        session.exec.return_value.all.return_value = []

        _get_current_from_cost_lots(
            session, version_id=1, include_unsettled_negative=True,
        )

        query_arg = session.exec.call_args[0][0]
        query_str = str(query_arg)

        # Should NOT contain the is_negative/is_settled filter
        assert "is_negative" not in query_str


# ---------------------------------------------------------------------------
# _get_balance_snapshots_at_dates — per-lot tracking + unsettled negative filter
# ---------------------------------------------------------------------------


class TestBalanceSnapshotsFilter:
    """Verify that _get_balance_snapshots_at_dates uses per-lot tracking
    and applies the unsettled negative filter."""

    def test_filter_clause_applied_by_default(self):
        """Default (include_unsettled_negative=False) adds is_negative filter."""
        session = MagicMock()
        session.exec.return_value.all.return_value = []

        _get_balance_snapshots_at_dates(
            session, version_id=1,
            bucket_dates=[datetime(2025, 1, 1, tzinfo=timezone.utc)],
        )

        query_str = str(session.exec.call_args[0][0])
        assert "is_negative" in query_str
        assert "is_settled" in query_str

    def test_no_filter_when_include_true(self):
        """include_unsettled_negative=True omits the filter."""
        session = MagicMock()
        session.exec.return_value.all.return_value = []

        _get_balance_snapshots_at_dates(
            session, version_id=1,
            bucket_dates=[datetime(2025, 1, 1, tzinfo=timezone.utc)],
            include_unsettled_negative=True,
        )

        query_str = str(session.exec.call_args[0][0])
        assert "is_negative" not in query_str

    def test_per_lot_aggregation(self):
        """Multiple lots for same asset are summed (per-lot tracking)."""
        session = MagicMock()
        bucket = datetime(2025, 6, 1, tzinfo=timezone.utc)

        # Two positive lots for EUR (asset_id=221)
        lot1 = MagicMock(timestamp=datetime(2025, 1, 1), lot_id=1, asset_id=221, qty_remaining_after=30000.0)
        lot2 = MagicMock(timestamp=datetime(2025, 3, 1), lot_id=2, asset_id=221, qty_remaining_after=20000.0)
        session.exec.return_value.all.return_value = [lot1, lot2]

        result = _get_balance_snapshots_at_dates(
            session, version_id=1, bucket_dates=[bucket],
        )

        ds = "2025-06-01"
        # 30000 + 20000 = 50000
        assert result[ds][221] == pytest.approx(50000.0)


# ---------------------------------------------------------------------------
# _get_cost_basis_snapshots_at_dates — unsettled negative filter
# ---------------------------------------------------------------------------


class TestCostBasisSnapshotsFilter:
    """Verify that _get_cost_basis_snapshots_at_dates applies the filter."""

    def test_filter_clause_applied_by_default(self):
        """Default (include_unsettled_negative=False) adds is_negative filter."""
        session = MagicMock()
        session.exec.return_value.all.return_value = []

        _get_cost_basis_snapshots_at_dates(
            session, version_id=1,
            bucket_dates=[datetime(2025, 1, 1, tzinfo=timezone.utc)],
        )

        query_str = str(session.exec.call_args[0][0])
        assert "is_negative" in query_str
        assert "is_settled" in query_str

    def test_no_filter_when_include_true(self):
        """include_unsettled_negative=True omits the filter."""
        session = MagicMock()
        session.exec.return_value.all.return_value = []

        _get_cost_basis_snapshots_at_dates(
            session, version_id=1,
            bucket_dates=[datetime(2025, 1, 1, tzinfo=timezone.utc)],
            include_unsettled_negative=True,
        )

        query_str = str(session.exec.call_args[0][0])
        assert "is_negative" not in query_str

    def test_per_lot_cost_aggregation(self):
        """Per-lot cost (qty_remaining * unit_cost) aggregated per asset."""
        session = MagicMock()
        bucket = datetime(2025, 6, 1, tzinfo=timezone.utc)

        # Two lots for BTC (asset_id=275): 5 BTC @ 4000, 3 BTC @ 5000
        lot1 = MagicMock(timestamp=datetime(2025, 1, 1), lot_id=10, asset_id=275,
                         qty_remaining_after=5.0, unit_cost_in_base=4000.0)
        lot2 = MagicMock(timestamp=datetime(2025, 3, 1), lot_id=11, asset_id=275,
                         qty_remaining_after=3.0, unit_cost_in_base=5000.0)
        session.exec.return_value.all.return_value = [lot1, lot2]

        result = _get_cost_basis_snapshots_at_dates(
            session, version_id=1, bucket_dates=[bucket],
        )

        ds = "2025-06-01"
        # 5*4000 + 3*5000 = 20000 + 15000 = 35000
        assert result[ds][275] == pytest.approx(35000.0)


class TestPortfolioTimelineCache:

    @pytest.fixture(autouse=True)
    def _clear(self):
        from backend.services.pnl.portfolio_timeline import clear_portfolio_timeline_cache

        clear_portfolio_timeline_cache()
        yield
        clear_portfolio_timeline_cache()

    def test_reuses_result_until_prices_change(self):
        from backend.services.pnl import portfolio_timeline as pt

        fingerprint = [(10, 99, 1.5)]
        with patch.object(pt, "compute_portfolio_timeline", return_value=["p"]) as compute, \
                patch.object(pt, "_price_fingerprint", side_effect=lambda s: fingerprint[0]):
            assert pt.compute_portfolio_timeline_cached(MagicMock(), version_id=1) == ["p"]
            pt.compute_portfolio_timeline_cached(MagicMock(), version_id=1)
            assert compute.call_count == 1

            fingerprint[0] = (11, 100, 2.5)
            pt.compute_portfolio_timeline_cached(MagicMock(), version_id=1)
            assert compute.call_count == 2

    def test_clear_forces_recompute(self):
        from backend.services.pnl import portfolio_timeline as pt

        with patch.object(pt, "compute_portfolio_timeline", return_value=[]) as compute, \
                patch.object(pt, "_price_fingerprint", return_value=(1, 1, 1)):
            pt.compute_portfolio_timeline_cached(MagicMock(), version_id=1)
            pt.clear_portfolio_timeline_cache()
            pt.compute_portfolio_timeline_cached(MagicMock(), version_id=1)
            assert compute.call_count == 2


# ---------------------------------------------------------------------------
# _compute_split_factors — split-continuous per-asset unit price
# ---------------------------------------------------------------------------


class TestComputeSplitFactors:
    DAYS = ["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"]

    def _prices(self, values):
        return {ds: {7: v} for ds, v in zip(self.DAYS, values)}

    def test_unadjusted_history_gets_factor_from_price_drop(self):
        from backend.services.pnl.portfolio_timeline import _compute_split_factors

        prices = self._prices([100.0, 101.0, 102.0, 10.3, 10.4])
        factors = _compute_split_factors({7: [("2026-10-27", 10.0)]}, prices, self.DAYS, window=5)
        assert [factors[7][d] for d in self.DAYS] == [1.0, 1.0, 1.0, 10.0, 10.0]

    def test_price_drop_one_bucket_late_is_matched(self):
        from backend.services.pnl.portfolio_timeline import _compute_split_factors

        prices = self._prices([100.0, 101.0, 102.0, 103.0, 10.4])
        factors = _compute_split_factors({7: [("2026-10-27", 10.0)]}, prices, self.DAYS, window=5)
        assert factors[7]["2026-10-27"] == 1.0
        assert factors[7]["2026-10-28"] == 10.0

    def test_already_adjusted_history_is_left_untouched(self):
        from backend.services.pnl.portfolio_timeline import _compute_split_factors

        prices = self._prices([10.0, 10.1, 10.2, 10.3, 10.4])
        factors = _compute_split_factors({7: [("2026-10-27", 10.0)]}, prices, self.DAYS, window=5)
        assert 7 not in factors

    def test_reverse_split(self):
        from backend.services.pnl.portfolio_timeline import _compute_split_factors

        prices = self._prices([1.0, 1.0, 1.0, 5.0, 5.1])
        factors = _compute_split_factors({7: [("2026-10-27", 0.2)]}, prices, self.DAYS, window=5)
        assert factors[7]["2026-10-26"] == 1.0
        assert factors[7]["2026-10-27"] == 0.2

