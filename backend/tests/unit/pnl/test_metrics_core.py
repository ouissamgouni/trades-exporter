"""
Unit tests for metrics core functions and dataclass composition.

Tests cover:
- BookSummary / BookRangeMetrics / BookVersionMetrics dataclasses
- LiveSummary / LiveRangeMetrics / LiveVersionMetrics dataclasses
- SummaryMetrics / RangeMetrics inheritance from Book* parents
- asdict composition pattern used by compute_version_metrics
- compute_book_metrics returns BookVersionMetrics
- compute_live_metrics returns LiveVersionMetrics
- compute_version_metrics returns VersionMetrics
"""

import pytest
from dataclasses import asdict
from unittest.mock import MagicMock, patch

from backend.services.pnl.metrics_service import (
    BookSummary,
    BookRangeMetrics,
    BookVersionMetrics,
    LiveSummary,
    LiveRangeMetrics,
    LiveVersionMetrics,
    SummaryMetrics,
    RangeMetrics,
    VersionMetrics,
)


# ============================================================================
# Dataclass hierarchy tests
# ============================================================================


class TestBookDataclasses:
    """BookSummary, BookRangeMetrics, BookVersionMetrics dataclass tests."""

    def test_book_summary_construction(self):
        s = BookSummary(
            cost_basis=1000.0, realized_pnl=200.0,
            taxable_realized_pnl=150.0, total_fees=10.0, fee_entry_count=2,
        )
        assert s.cost_basis == 1000.0
        assert s.realized_pnl == 200.0
        assert s.total_invested == 0.0  # default

    def test_book_summary_total_invested(self):
        s = BookSummary(
            cost_basis=1000.0, realized_pnl=200.0,
            taxable_realized_pnl=150.0, total_fees=10.0, fee_entry_count=2,
            total_invested=5000.0,
        )
        assert s.total_invested == 5000.0

    def test_book_range_metrics_construction(self):
        r = BookRangeMetrics(
            cost_basis=1000.0, realized_pnl=200.0,
            taxable_realized_pnl=150.0, realized_in_period=50.0,
            cost_basis_in_period=300.0, fees_in_period=5.0,
        )
        assert r.cost_basis_in_period == 300.0
        assert r.fees_in_period == 5.0
        assert r.total_invested == 0.0  # default

    def test_book_version_metrics_construction(self):
        s = BookSummary(
            cost_basis=1000.0, realized_pnl=200.0,
            taxable_realized_pnl=150.0, total_fees=10.0, fee_entry_count=2,
        )
        m = BookVersionMetrics(version_id=1, summary=s)
        assert m.version_id == 1
        assert m.ranges == {}

    def test_book_version_metrics_with_ranges(self):
        s = BookSummary(
            cost_basis=1000.0, realized_pnl=200.0,
            taxable_realized_pnl=150.0, total_fees=10.0, fee_entry_count=2,
        )
        r = BookRangeMetrics(
            cost_basis=1000.0, realized_pnl=200.0,
            taxable_realized_pnl=150.0, realized_in_period=200.0,
            cost_basis_in_period=1000.0, fees_in_period=10.0,
        )
        m = BookVersionMetrics(version_id=1, summary=s, ranges={"all": r})
        assert "all" in m.ranges
        assert m.ranges["all"].realized_in_period == 200.0


class TestLiveDataclasses:
    """LiveSummary, LiveRangeMetrics, LiveVersionMetrics dataclass tests."""

    def test_live_summary_construction(self):
        s = LiveSummary(current_value=5000.0, unrealized_pnl=1000.0)
        assert s.current_value == 5000.0
        assert s.unrealized_pnl == 1000.0

    def test_live_range_metrics_construction(self):
        r = LiveRangeMetrics(
            current_value=5000.0, unrealized_pnl=1000.0,
            unrealized_in_period=200.0, total_return=1200.0, roi_pct=30.0,
        )
        assert r.total_return == 1200.0
        assert r.roi_pct == 30.0

    def test_live_version_metrics_construction(self):
        s = LiveSummary(current_value=5000.0, unrealized_pnl=1000.0)
        m = LiveVersionMetrics(version_id=1, summary=s)
        assert m.version_id == 1
        assert m.ranges == {}


class TestCombinedDataclasses:
    """SummaryMetrics (inherits BookSummary) and RangeMetrics (inherits BookRangeMetrics)."""

    def test_summary_metrics_inherits_book_summary(self):
        s = SummaryMetrics(
            cost_basis=1000.0, realized_pnl=200.0,
            taxable_realized_pnl=150.0, total_fees=10.0, fee_entry_count=2,
            current_value=5000.0, unrealized_pnl=4000.0,
        )
        assert isinstance(s, BookSummary)
        assert s.cost_basis == 1000.0
        assert s.current_value == 5000.0
        assert s.unrealized_pnl == 4000.0

    def test_summary_metrics_live_defaults(self):
        """Live fields default to 0.0 when not provided."""
        s = SummaryMetrics(
            cost_basis=1000.0, realized_pnl=200.0,
            taxable_realized_pnl=150.0, total_fees=10.0, fee_entry_count=2,
        )
        assert s.current_value == 0.0
        assert s.unrealized_pnl == 0.0

    def test_range_metrics_inherits_book_range(self):
        r = RangeMetrics(
            cost_basis=1000.0, realized_pnl=200.0,
            taxable_realized_pnl=150.0, realized_in_period=50.0,
            cost_basis_in_period=300.0, fees_in_period=5.0,
            total_return=1200.0, roi_pct=30.0,
            current_value=5000.0, unrealized_pnl=4000.0,
        )
        assert isinstance(r, BookRangeMetrics)
        assert r.cost_basis_in_period == 300.0
        assert r.total_return == 1200.0

    def test_range_metrics_live_defaults(self):
        """Live fields default to 0.0 / [] when not provided."""
        r = RangeMetrics(
            cost_basis=1000.0, realized_pnl=200.0,
            taxable_realized_pnl=150.0, realized_in_period=50.0,
            cost_basis_in_period=300.0, fees_in_period=5.0,
        )
        assert r.total_return == 0.0
        assert r.roi_pct == 0.0
        assert r.current_value == 0.0
        assert r.unrealized_pnl == 0.0
        assert r.unrealized_in_period == 0.0
        assert r.top_performers == []
        assert r.flop_performers == []

    def test_version_metrics_construction(self):
        s = SummaryMetrics(
            cost_basis=1000.0, realized_pnl=200.0,
            taxable_realized_pnl=150.0, total_fees=10.0, fee_entry_count=2,
            current_value=5000.0, unrealized_pnl=4000.0,
        )
        m = VersionMetrics(version_id=1, summary=s)
        assert m.version_id == 1
        assert m.summary.current_value == 5000.0


# ============================================================================
# asdict composition pattern tests
# ============================================================================


class TestAsDictComposition:
    """Verify asdict() spread pattern used by compute_version_metrics."""

    def test_book_summary_to_summary_metrics(self):
        """BookSummary + live fields → SummaryMetrics via asdict spread."""
        book = BookSummary(
            cost_basis=1000.0, realized_pnl=200.0,
            taxable_realized_pnl=150.0, total_fees=10.0, fee_entry_count=2,
            total_invested=3000.0,
        )
        combined = SummaryMetrics(
            **asdict(book),
            current_value=5000.0,
            unrealized_pnl=4000.0,
        )
        # Book fields preserved
        assert combined.cost_basis == 1000.0
        assert combined.realized_pnl == 200.0
        assert combined.total_invested == 3000.0
        assert combined.total_fees == 10.0
        assert combined.fee_entry_count == 2
        # Live fields added
        assert combined.current_value == 5000.0
        assert combined.unrealized_pnl == 4000.0

    def test_book_range_to_range_metrics(self):
        """BookRangeMetrics + live fields → RangeMetrics via asdict spread."""
        book_range = BookRangeMetrics(
            cost_basis=1000.0, realized_pnl=200.0,
            taxable_realized_pnl=150.0, realized_in_period=50.0,
            cost_basis_in_period=300.0, fees_in_period=5.0,
            total_invested=3000.0,
        )
        combined = RangeMetrics(
            **asdict(book_range),
            total_return=1200.0,
            roi_pct=30.0,
            current_value=5000.0,
            unrealized_pnl=4000.0,
            unrealized_in_period=200.0,
        )
        # Book fields preserved
        assert combined.cost_basis == 1000.0
        assert combined.cost_basis_in_period == 300.0
        assert combined.fees_in_period == 5.0
        assert combined.total_invested == 3000.0
        # Live fields added
        assert combined.total_return == 1200.0
        assert combined.roi_pct == 30.0
        assert combined.unrealized_in_period == 200.0

    def test_asdict_round_trip_preserves_all_fields(self):
        """asdict on BookSummary → dict has exactly the expected keys."""
        book = BookSummary(
            cost_basis=1.0, realized_pnl=2.0,
            taxable_realized_pnl=3.0, total_fees=4.0, fee_entry_count=5,
            total_invested=6.0,
        )
        d = asdict(book)
        expected_keys = {
            "cost_basis", "realized_pnl", "taxable_realized_pnl",
            "total_fees", "fee_entry_count", "total_invested",
            "total_income", "total_withholding", "income_event_count",
        }
        assert set(d.keys()) == expected_keys


# ============================================================================
# Public function return type tests
# ============================================================================


MOCK_BASE = "backend.services.pnl.metrics_service"


class TestComputeBookMetricsReturnType:
    """compute_book_metrics should return BookVersionMetrics."""

    @patch(f"{MOCK_BASE}._compute_book_core")
    @patch(f"{MOCK_BASE}._build_version_snapshot")
    def test_returns_book_version_metrics(self, mock_snap, mock_core):
        from backend.services.pnl.metrics_service import compute_book_metrics

        mock_snap.return_value = MagicMock(
            all_asset_ids={1, 2},
            now_lot_remaining_costs={1: 500.0, 2: 500.0},
            now_lot_invested={1: 600.0, 2: 600.0},
            range_starts={"all": MagicMock()},
        )
        summary = BookSummary(
            cost_basis=1000.0, realized_pnl=200.0,
            taxable_realized_pnl=150.0, total_fees=10.0, fee_entry_count=2,
        )
        ranges = {
            "all": BookRangeMetrics(
                cost_basis=1000.0, realized_pnl=200.0,
                taxable_realized_pnl=150.0, realized_in_period=200.0,
                cost_basis_in_period=1000.0, fees_in_period=10.0,
            ),
        }
        mock_core.return_value = (summary, ranges, 10.0, 2, {})

        session = MagicMock()
        result = compute_book_metrics(session, version_id=1)

        assert isinstance(result, BookVersionMetrics)
        assert result.version_id == 1
        assert isinstance(result.summary, BookSummary)
        assert "all" in result.ranges
        assert isinstance(result.ranges["all"], BookRangeMetrics)

    @patch(f"{MOCK_BASE}._build_version_snapshot")
    def test_returns_none_for_missing_version(self, mock_snap):
        from backend.services.pnl.metrics_service import compute_book_metrics

        mock_snap.return_value = None
        session = MagicMock()
        session.get.return_value = None  # version not found

        result = compute_book_metrics(session, version_id=999)
        assert result is None


class TestComputeLiveMetricsReturnType:
    """compute_live_metrics should return LiveVersionMetrics."""

    @patch(f"{MOCK_BASE}._compute_live_core")
    @patch(f"{MOCK_BASE}._build_realized_pnl_snapshots")
    @patch(f"{MOCK_BASE}._build_price_snapshot")
    @patch(f"{MOCK_BASE}._build_version_snapshot")
    def test_returns_live_version_metrics(
        self, mock_snap, mock_prices, mock_rpnl, mock_core,
    ):
        from backend.services.pnl.metrics_service import compute_live_metrics

        mock_snap.return_value = MagicMock(
            all_asset_ids={1},
            now_lot_remaining_costs={1: 500.0},
        )
        mock_prices.return_value = {}
        mock_rpnl.return_value = {}
        summary = LiveSummary(current_value=5000.0, unrealized_pnl=4500.0)
        ranges = {
            "all": LiveRangeMetrics(
                current_value=5000.0, unrealized_pnl=4500.0,
                unrealized_in_period=200.0, total_return=4700.0, roi_pct=940.0,
            ),
        }
        mock_core.return_value = (summary, ranges)

        session = MagicMock()
        result = compute_live_metrics(session, version_id=1)

        assert isinstance(result, LiveVersionMetrics)
        assert result.version_id == 1
        assert isinstance(result.summary, LiveSummary)
        assert result.summary.current_value == 5000.0
        assert "all" in result.ranges
        assert isinstance(result.ranges["all"], LiveRangeMetrics)

    @patch(f"{MOCK_BASE}._build_version_snapshot")
    def test_returns_none_for_missing_version(self, mock_snap):
        from backend.services.pnl.metrics_service import compute_live_metrics

        mock_snap.return_value = None
        session = MagicMock()
        session.get.return_value = None

        result = compute_live_metrics(session, version_id=999)
        assert result is None


class TestComputeVersionMetricsComposition:
    """compute_version_metrics should compose book + live + performers."""

    @patch(f"{MOCK_BASE}._rank_performers_by_asset")
    @patch(f"{MOCK_BASE}._snapshot_at")
    @patch(f"{MOCK_BASE}._get_fees_by_asset")
    @patch(f"{MOCK_BASE}._get_asset_labels")
    @patch(f"{MOCK_BASE}._get_asset_symbols")
    @patch(f"{MOCK_BASE}._compute_live_core")
    @patch(f"{MOCK_BASE}._compute_book_core")
    @patch(f"{MOCK_BASE}._build_price_snapshot")
    @patch(f"{MOCK_BASE}._build_version_snapshot")
    def test_combines_book_and_live(
        self, mock_snap, mock_prices, mock_book, mock_live,
        mock_symbols, mock_labels, mock_fees, mock_snapshot_at, mock_rank,
    ):
        from backend.services.pnl.metrics_service import compute_version_metrics

        # Mock snapshot
        mock_snap.return_value = MagicMock(
            all_asset_ids={1},
            now_lot_remaining_costs={1: 1000.0},
            base_currency_id=None,
            range_starts={"all": MagicMock()},
            version=MagicMock(version_id=1),
            now=MagicMock(),
            now_ds="2024-01-01",
        )
        mock_prices.return_value = {}

        # Book core returns
        book_summary = BookSummary(
            cost_basis=1000.0, realized_pnl=200.0,
            taxable_realized_pnl=150.0, total_fees=10.0, fee_entry_count=2,
            total_invested=3000.0,
        )
        book_range = BookRangeMetrics(
            cost_basis=1000.0, realized_pnl=200.0,
            taxable_realized_pnl=150.0, realized_in_period=200.0,
            cost_basis_in_period=1000.0, fees_in_period=10.0,
            total_invested=3000.0,
        )
        cumulative_rpnl = {"2024-01-01": (200.0, {1: 200.0})}
        mock_book.return_value = (book_summary, {"all": book_range}, 10.0, 2, cumulative_rpnl)

        # Live core returns
        live_summary = LiveSummary(current_value=5000.0, unrealized_pnl=4000.0)
        live_range = LiveRangeMetrics(
            current_value=5000.0, unrealized_pnl=4000.0,
            unrealized_in_period=500.0, total_return=4200.0, roi_pct=420.0,
        )
        mock_live.return_value = (live_summary, {"all": live_range})

        # Helper stubs
        mock_symbols.return_value = {1: "BTC"}
        mock_labels.return_value = {1: "Bitcoin"}
        mock_fees.return_value = {}
        mock_snapshot_at.return_value = ({1: 1.0}, {1: 1000.0}, {1: 5000.0}, 200.0, {1: 200.0})
        mock_rank.return_value = ([], [], 0)

        session = MagicMock()
        result = compute_version_metrics(session, version_id=1)

        # Should be VersionMetrics
        assert isinstance(result, VersionMetrics)
        assert result.version_id == 1

        # Summary should combine book + live
        s = result.summary
        assert isinstance(s, SummaryMetrics)
        assert s.cost_basis == 1000.0        # from book
        assert s.realized_pnl == 200.0       # from book
        assert s.total_fees == 10.0          # from book
        assert s.total_invested == 3000.0    # from book
        assert s.current_value == 5000.0     # from live
        assert s.unrealized_pnl == 4000.0    # from live

        # Range should combine book + live
        r = result.ranges["all"]
        assert isinstance(r, RangeMetrics)
        assert r.cost_basis == 1000.0              # from book
        assert r.cost_basis_in_period == 1000.0    # from book
        assert r.fees_in_period == 10.0            # from book
        assert r.total_return == 4200.0            # from live
        assert r.roi_pct == 420.0                  # from live
        assert r.unrealized_in_period == 500.0     # from live

    @patch(f"{MOCK_BASE}._build_version_snapshot")
    def test_returns_none_for_missing_version(self, mock_snap):
        from backend.services.pnl.metrics_service import compute_version_metrics

        mock_snap.return_value = None
        session = MagicMock()
        session.get.return_value = None

        result = compute_version_metrics(session, version_id=999)
        assert result is None
