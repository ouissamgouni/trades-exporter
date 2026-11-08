"""
Unit tests for PnL metrics bug fixes.

Tests cover:
- _sort_top_flop: worst performers when count <= top_n
- _get_price_at_dates: fallback to unfiltered when no quoted prices
- PerformerItem: unrealized_pnl field
- PriceService._get_quote_asset_id: returns correct asset_id
"""

import pytest
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import patch, Mock, MagicMock

from backend.services.pnl.metrics_service import (
    _sort_top_flop,
    _get_price_at_dates,
    PerformerItem,
    compute_version_metrics,
    PERIOD_RANGES,
)


MOCK_PREFIX = "backend.services.pnl.metrics_service"


@pytest.fixture(autouse=True)
def _no_deferred_gain_query():
    # Sessions are mocked here; these DB aggregates are covered elsewhere.
    with patch(f"{MOCK_PREFIX}._get_deferred_gain", return_value=0.0), \
            patch(f"{MOCK_PREFIX}._get_net_deposits", return_value=0.0):
        yield


def _utc(year, month, day):
    return datetime(year, month, day, tzinfo=timezone.utc)


def _make_performer(id, name, total_return, unrealized_pnl=0.0):
    return PerformerItem(
        id=id,
        name=name,
        label=None,
        group_type="asset",
        total_return=total_return,
        roi_pct=0.0,
        unrealized_pnl=unrealized_pnl,
    )


# ============================================================================
# _sort_top_flop tests
# ============================================================================


class TestSortTopFlop:
    """Tests for the top/flop performer sorting logic."""

    def test_flop_includes_negatives_when_count_lte_top_n(self):
        """Flop should include negative items even when total count <= top_n."""
        performers = [
            _make_performer(1, "A", 100.0),
            _make_performer(2, "B", 50.0),
            _make_performer(3, "C", -20.0),
            _make_performer(4, "D", -50.0),
        ]
        top, flop, total = _sort_top_flop(performers, top_n=25)

        # Top only includes non-negative returns
        assert len(top) == 2
        assert top[0].name == "A"
        assert top[0].total_return == 100.0
        assert top[1].name == "B"

        # Flop must contain the negative items
        assert len(flop) == 2
        assert flop[0].name == "D"  # worst first
        assert flop[0].total_return == -50.0
        assert flop[1].name == "C"
        assert flop[1].total_return == -20.0
        assert total == 4

    def test_flop_empty_when_all_positive(self):
        """No flop performers when all returns are positive."""
        performers = [
            _make_performer(1, "A", 100.0),
            _make_performer(2, "B", 50.0),
        ]
        top, flop, total = _sort_top_flop(performers, top_n=5)

        assert len(top) == 2
        assert len(flop) == 0
        assert total == 2

    def test_flop_capped_at_top_n(self):
        """Flop list should be capped at top_n items."""
        performers = [_make_performer(i, f"X{i}", -i * 10.0) for i in range(1, 20)]
        top, flop, total = _sort_top_flop(performers, top_n=5)

        # All performers are negative, so top is empty
        assert len(top) == 0
        assert len(flop) == 5
        assert total == 19
        # Worst first
        assert flop[0].total_return == -190.0

    def test_top_sorted_descending(self):
        """Top performers sorted by total_return descending, only non-negative."""
        performers = [
            _make_performer(1, "A", -10.0),
            _make_performer(2, "B", 500.0),
            _make_performer(3, "C", 200.0),
        ]
        top, flop, total = _sort_top_flop(performers, top_n=3)

        # Only non-negative in top
        assert len(top) == 2
        assert top[0].name == "B"
        assert top[1].name == "C"
        # Negative goes to flop
        assert len(flop) == 1
        assert flop[0].name == "A"

    def test_single_negative_performer(self):
        """Single performer with negative return should only appear in flop, not top."""
        performers = [_make_performer(1, "A", -100.0)]
        top, flop, total = _sort_top_flop(performers, top_n=5)

        assert len(top) == 0
        assert len(flop) == 1
        assert flop[0].total_return == -100.0
        assert total == 1

    def test_empty_performers(self):
        """Empty list should return empty top and flop."""
        top, flop, total = _sort_top_flop([], top_n=5)
        assert top == []
        assert flop == []
        assert total == 0


# ============================================================================
# PerformerItem tests
# ============================================================================


class TestPerformerItem:
    """Tests for PerformerItem dataclass."""

    def test_has_unrealized_pnl_field(self):
        """PerformerItem should have unrealized_pnl field."""
        p = PerformerItem(
            id=1,
            name="BTC",
            label="Bitcoin",
            group_type="asset",
            total_return=1000.0,
            roi_pct=50.0,
            unrealized_pnl=800.0,
        )
        assert p.unrealized_pnl == 800.0

    def test_unrealized_pnl_default_zero(self):
        """unrealized_pnl should default to 0.0."""
        p = PerformerItem(
            id=1,
            name="BTC",
            label="Bitcoin",
            group_type="asset",
            total_return=1000.0,
            roi_pct=50.0,
        )
        assert p.unrealized_pnl == 0.0


# ============================================================================
# _get_price_at_dates fallback tests
# ============================================================================


class TestGetPriceAtDatesFallback:
    """Tests for _get_price_at_dates with quote_asset_id fallback."""

    def _make_price_row(self, asset_id, price, snapshot_time):
        row = Mock()
        row.asset_id = asset_id
        row.price = Decimal(str(price))
        row.snapshot_time = snapshot_time
        return row

    def test_fallback_when_no_quoted_prices(self):
        """Should fall back to unfiltered query when no prices match quote_asset_id."""
        session = MagicMock()
        base_currency_id = 221  # EUR
        asset_ids = [1, 2]
        bucket_dates = [_utc(2024, 6, 1)]

        now_time = _utc(2024, 6, 1)
        # First call (filtered by quote_asset_id=221) returns empty
        # Second call (fallback, no filter) returns prices
        fallback_prices = [
            self._make_price_row(1, 100.0, _utc(2024, 5, 30)),
            self._make_price_row(2, 50.0, _utc(2024, 5, 30)),
        ]
        session.exec.side_effect = [
            Mock(all=Mock(return_value=[])),           # filtered query: empty
            Mock(all=Mock(return_value=fallback_prices)),  # fallback: has data
        ]

        result = _get_price_at_dates(session, base_currency_id, asset_ids, bucket_dates)

        date_str = "2024-06-01"
        assert date_str in result
        assert result[date_str][1] == 100.0
        assert result[date_str][2] == 50.0
        # Should have made 2 exec calls (filtered + fallback)
        assert session.exec.call_count == 2

    def test_no_fallback_when_quoted_prices_exist(self):
        """Should NOT fall back when prices with quote_asset_id exist."""
        session = MagicMock()
        base_currency_id = 221
        asset_ids = [1]
        bucket_dates = [_utc(2024, 6, 1)]

        quoted_prices = [
            self._make_price_row(1, 100.0, _utc(2024, 5, 30)),
        ]
        session.exec.return_value = Mock(all=Mock(return_value=quoted_prices))

        result = _get_price_at_dates(session, base_currency_id, asset_ids, bucket_dates)

        assert "2024-06-01" in result
        assert result["2024-06-01"][1] == 100.0
        # Should have made only 1 exec call
        assert session.exec.call_count == 1

    def test_no_fallback_when_no_base_currency(self):
        """Should not fallback when base_currency_id is None."""
        session = MagicMock()
        asset_ids = [1]
        bucket_dates = [_utc(2024, 6, 1)]

        prices = [self._make_price_row(1, 100.0, _utc(2024, 5, 30))]
        session.exec.return_value = Mock(all=Mock(return_value=prices))

        result = _get_price_at_dates(session, None, asset_ids, bucket_dates)
        # Only 1 call (no filter applied, no fallback needed)
        assert session.exec.call_count == 1


# ============================================================================
# PriceService._get_quote_asset_id tests
# ============================================================================


class TestGetQuoteAssetId:
    """Tests that _get_quote_asset_id returns the correct asset_id."""

    def test_returns_asset_id_for_valid_symbol(self):
        """Should return the asset_id when quote currency exists."""
        from backend.services.price_service import PriceService

        session = MagicMock()
        mock_asset = Mock()
        mock_asset.asset_id = 221
        session.exec.return_value = Mock(first=Mock(return_value=mock_asset))

        service = PriceService(session=session)
        result = service._get_quote_asset_id(session, "EUR")

        assert result == 221

    def test_returns_none_for_unknown_symbol(self):
        """Should return None when quote currency doesn't exist."""
        from backend.services.price_service import PriceService

        session = MagicMock()
        session.exec.return_value = Mock(first=Mock(return_value=None))

        service = PriceService(session=session)
        result = service._get_quote_asset_id(session, "NONEXISTENT")

        assert result is None

    def test_case_insensitive(self):
        """Should match symbols case-insensitively."""
        from backend.services.price_service import PriceService

        session = MagicMock()
        mock_asset = Mock()
        mock_asset.asset_id = 222
        session.exec.return_value = Mock(first=Mock(return_value=mock_asset))

        service = PriceService(session=session)
        result = service._get_quote_asset_id(session, "usd")

        assert result == 222


# ============================================================================
# Integration: compute_version_metrics with unrealized_pnl in performers
# ============================================================================


class TestMetricsPerformerUnrealized:
    """Tests that compute_version_metrics populates unrealized_pnl in performers."""

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
    def test_performer_has_unrealized_pnl(
        self, mock_lot_current, mock_balances, mock_costs, mock_prices, mock_rpnl,
        mock_symbols, mock_labels, mock_fees, mock_fees_period, mock_fees_asset, mock_refresh, mock_invested,
    ):
        """Performers should include unrealized_pnl field."""
        version = Mock()
        version.base_currency_id = 1
        session = MagicMock()
        session.get.return_value = version

        mock_result = Mock()
        mock_result.one.return_value = (_utc(2024, 1, 1), _utc(2024, 6, 1))
        session.exec.return_value = mock_result
        mock_fees_asset.return_value = {}

        # Asset 10: qty=2, cost=20000, price=30000 → unrealized = 60000 - 20000 = 40000
        mock_lot_current.return_value = ({10: 2.0}, {10: 20000.0}, {10: 20000.0})

        def balance_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 2.0} for d in a[2]}

        def cost_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 20000.0} for d in a[2]}

        def price_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 30000.0} for d in a[3]}

        def rpnl_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): (5000.0, {10: 5000.0}) for d in a[2]}

        mock_balances.side_effect = balance_data
        mock_costs.side_effect = cost_data
        mock_prices.side_effect = price_data
        mock_rpnl.side_effect = rpnl_data
        mock_symbols.return_value = {10: "BTC"}
        mock_labels.return_value = {10: "Bitcoin"}
        mock_fees.return_value = (0.0, 0)
        mock_fees_period.return_value = 0.0
        mock_refresh.return_value = None

        result = compute_version_metrics(session, version_id=1, top_n=5)

        assert result is not None
        m = result.ranges["all"]
        assert len(m.top_performers) == 1
        p = m.top_performers[0]
        assert p.unrealized_pnl == 40000.0
        assert p.total_return == 45000.0  # unrealized + realized

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
    def test_flop_includes_negatives_in_full_metrics(
        self, mock_lot_current, mock_balances, mock_costs, mock_prices, mock_rpnl,
        mock_symbols, mock_labels, mock_fees, mock_fees_period, mock_fees_asset, mock_refresh, mock_invested,
    ):
        """Flop performers should include negatives even when count <= top_n."""
        version = Mock()
        version.base_currency_id = 1
        session = MagicMock()
        session.get.return_value = version

        mock_result = Mock()
        mock_result.one.return_value = (_utc(2024, 1, 1), _utc(2024, 6, 1))
        session.exec.return_value = mock_result
        mock_fees_asset.return_value = {}

        # Asset 10: profitable, Asset 20: loss
        mock_lot_current.return_value = (
            {10: 1.0, 20: 1.0},
            {10: 1000.0, 20: 1000.0},
            {10: 1000.0, 20: 1000.0},
        )

        def balance_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 1.0, 20: 1.0} for d in a[2]}

        def cost_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 1000.0, 20: 1000.0} for d in a[2]}

        def price_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): {10: 2000.0, 20: 500.0} for d in a[3]}

        def rpnl_data(*a, **kw):
            return {d.strftime("%Y-%m-%d"): (0.0, {}) for d in a[2]}

        mock_balances.side_effect = balance_data
        mock_costs.side_effect = cost_data
        mock_prices.side_effect = price_data
        mock_rpnl.side_effect = rpnl_data
        mock_symbols.return_value = {10: "WINNER", 20: "LOSER"}
        mock_labels.return_value = {10: None, 20: None}
        mock_fees.return_value = (0.0, 0)
        mock_fees_period.return_value = 0.0
        mock_refresh.return_value = None

        result = compute_version_metrics(session, version_id=1, top_n=25)

        assert result is not None
        m = result.ranges["all"]
        # Only WINNER (positive return) in top
        assert len(m.top_performers) == 1
        assert m.top_performers[0].name == "WINNER"
        # LOSER should be in flop (negative return)
        assert len(m.flop_performers) == 1
        assert m.flop_performers[0].name == "LOSER"
        assert m.flop_performers[0].total_return == -500.0
        assert m.flop_performers[0].unrealized_pnl == -500.0
