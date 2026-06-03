"""
Unit tests for total invested vs remaining cost metrics.

Tests verify that:
- RangeMetrics and SummaryMetrics carry total_invested
- _VersionSnapshot stores now_lot_invested
- compute_version_metrics propagates total_invested correctly
- total_invested differs from cost_basis when lots are partially sold
- total_invested equals cost_basis when no sales have occurred
"""

import pytest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

from backend.services.pnl.metrics_service import (
    RangeMetrics,
    SummaryMetrics,
    VersionMetrics,
    _VersionSnapshot,
    PerformerItem,
)


MOCK_PREFIX = "backend.services.pnl.metrics_service"


def _utc(year, month, day):
    return datetime(year, month, day, tzinfo=timezone.utc)


# ============================================================================
# Dataclass field presence
# ============================================================================


class TestTotalInvestedField:
    """Verify total_invested field exists on metrics dataclasses."""

    def test_range_metrics_has_field(self):
        """RangeMetrics should carry total_invested."""
        m = RangeMetrics(
            total_return=100.0, roi_pct=10.0,
            current_value=1100.0, cost_basis=1000.0,
            unrealized_pnl=100.0, realized_pnl=0.0,
            taxable_realized_pnl=0.0, realized_in_period=0.0,
            cost_basis_in_period=0.0, fees_in_period=0.0,
            total_invested=2000.0,
        )
        assert m.total_invested == 2000.0

    def test_range_metrics_default_zero(self):
        """RangeMetrics.total_invested should default to 0.0."""
        m = RangeMetrics(
            total_return=0.0, roi_pct=0.0,
            current_value=0.0, cost_basis=0.0,
            unrealized_pnl=0.0, realized_pnl=0.0,
            taxable_realized_pnl=0.0, realized_in_period=0.0,
            cost_basis_in_period=0.0, fees_in_period=0.0,
        )
        assert m.total_invested == 0.0

    def test_summary_metrics_has_field(self):
        """SummaryMetrics should carry total_invested."""
        s = SummaryMetrics(
            current_value=500.0, cost_basis=384.0,
            unrealized_pnl=116.0, realized_pnl=50.0,
            taxable_realized_pnl=50.0, total_fees=5.0,
            fee_entry_count=1, total_invested=768.0,
        )
        assert s.total_invested == 768.0

    def test_summary_metrics_default_zero(self):
        """SummaryMetrics.total_invested should default to 0.0."""
        s = SummaryMetrics(
            current_value=500.0, cost_basis=384.0,
            unrealized_pnl=116.0, realized_pnl=50.0,
            taxable_realized_pnl=50.0, total_fees=5.0,
            fee_entry_count=1,
        )
        assert s.total_invested == 0.0


# ============================================================================
# _VersionSnapshot includes acquired costs
# ============================================================================


class TestVersionSnapshotInvested:
    """Verify _VersionSnapshot carries now_lot_invested."""

    def test_snapshot_carries_invested(self):
        """_VersionSnapshot should store now_lot_invested."""
        from backend.db.models import CalculationVersion

        version = MagicMock(spec=CalculationVersion)
        version.version_id = 1
        version.base_currency_id = 100
        now = datetime.now(timezone.utc)

        snap = _VersionSnapshot(
            version=version,
            base_currency_id=100,
            min_date=now - timedelta(days=365),
            now=now,
            now_ds=now.strftime("%Y-%m-%d"),
            now_lot_balances={10: 5.0, 20: 10.0},
            now_lot_remaining_costs={10: 384.0, 20: 200.0},
            now_lot_invested={10: 768.0, 20: 200.0},
            all_asset_ids={10, 20},
            range_starts={"all": now - timedelta(days=365)},
            unique_dates=[now],
            balance_snapshots={},
            cost_basis_snapshots={},
        )

        assert snap.now_lot_invested[10] == 768.0
        assert snap.now_lot_invested[20] == 200.0

    def test_invested_equals_remaining_when_no_sales(self):
        """When qty_remaining == qty (no sales), invested == remaining cost."""
        from backend.db.models import CalculationVersion

        version = MagicMock(spec=CalculationVersion)
        version.version_id = 1
        version.base_currency_id = 100
        now = datetime.now(timezone.utc)

        snap = _VersionSnapshot(
            version=version,
            base_currency_id=100,
            min_date=now - timedelta(days=365),
            now=now,
            now_ds=now.strftime("%Y-%m-%d"),
            now_lot_balances={10: 10.0},
            now_lot_remaining_costs={10: 500.0},
            now_lot_invested={10: 500.0},
            all_asset_ids={10},
            range_starts={},
            unique_dates=[now],
            balance_snapshots={},
            cost_basis_snapshots={},
        )

        assert snap.now_lot_remaining_costs[10] == snap.now_lot_invested[10]

    def test_invested_greater_than_remaining_after_partial_sale(self):
        """After partial sale, total invested > remaining cost."""
        from backend.db.models import CalculationVersion

        version = MagicMock(spec=CalculationVersion)
        version.version_id = 1
        version.base_currency_id = 100
        now = datetime.now(timezone.utc)

        # Bought 10 shares at $50 = $500 total, sold 5 → remaining cost = $250
        snap = _VersionSnapshot(
            version=version,
            base_currency_id=100,
            min_date=now - timedelta(days=365),
            now=now,
            now_ds=now.strftime("%Y-%m-%d"),
            now_lot_balances={10: 5.0},
            now_lot_remaining_costs={10: 250.0},
            now_lot_invested={10: 500.0},
            all_asset_ids={10},
            range_starts={},
            unique_dates=[now],
            balance_snapshots={},
            cost_basis_snapshots={},
        )

        assert snap.now_lot_invested[10] > snap.now_lot_remaining_costs[10]
        assert snap.now_lot_invested[10] == 500.0
        assert snap.now_lot_remaining_costs[10] == 250.0


# ============================================================================
# compute_version_metrics: total_invested propagation
# ============================================================================


class TestComputeVersionMetricsTotalInvested:
    """Integration-style tests (mocked DB) for total_invested in metrics."""

    @patch(f"{MOCK_PREFIX}._compute_fee_summary", return_value=(0.0, 0))
    @patch(f"{MOCK_PREFIX}._compute_fees_in_period", return_value=0.0)
    @patch(f"{MOCK_PREFIX}._build_price_snapshot")
    @patch(f"{MOCK_PREFIX}._build_realized_pnl_snapshots")
    @patch(f"{MOCK_PREFIX}._get_cumulative_realized_pnl")
    @patch(f"{MOCK_PREFIX}._build_version_snapshot")
    def test_spinoff_asset_acquired_vs_remaining(
        self,
        mock_build_snap,
        mock_cum_rpnl,
        mock_build_rpnl_snap,
        mock_build_prices,
        mock_compute_fees_period,
        mock_compute_fees,
    ):
        """
        Spinoff scenario: GEV bought for $768, half sold → remaining $384.
        total_invested should be 768, cost_basis should be 384.
        """
        from backend.services.pnl.metrics_service import compute_version_metrics

        now = datetime.now(timezone.utc)
        now_ds = now.strftime("%Y-%m-%d")
        all_start = now - timedelta(days=365)
        all_start_ds = all_start.strftime("%Y-%m-%d")

        version = MagicMock()
        version.version_id = 1
        version.base_currency_id = 100

        snap = _VersionSnapshot(
            version=version,
            base_currency_id=100,
            min_date=all_start,
            now=now,
            now_ds=now_ds,
            now_lot_balances={10: 5.0},     # 5 shares remaining
            now_lot_remaining_costs={10: 384.0},       # remaining cost
            now_lot_invested={10: 768.0},  # total invested
            all_asset_ids={10},
            range_starts={"all": all_start},
            unique_dates=[all_start, now],
            balance_snapshots={
                all_start_ds: {},
                now_ds: {10: 5.0},
            },
            cost_basis_snapshots={
                all_start_ds: {},
                now_ds: {10: 384.0},
            },
        )
        mock_build_snap.return_value = snap

        # Price snapshots: asset 10 at $100/share
        mock_build_prices.return_value = {
            all_start_ds: {},
            now_ds: {10: 100.0},
        }

        # Cumulative realized PnL snapshots
        mock_build_rpnl_snap.return_value = {
            all_start_ds: (0.0, {}),
            now_ds: (50.0, {10: 50.0}),
        }
        mock_cum_rpnl.return_value = {
            now_ds: (50.0, {10: 50.0}),
        }

        session = MagicMock()
        # Mock _get_asset_symbols, _get_asset_labels, _get_fees_by_asset
        session.exec.return_value.all.return_value = []

        result = compute_version_metrics(
            session=session,
            version_id=1,
            periods=["all"],
        )

        assert result is not None
        # Summary: remaining cost = 384, invested = 768
        assert result.summary.cost_basis == 384.0
        assert result.summary.total_invested == 768.0
        assert result.summary.total_invested > result.summary.cost_basis

        # Range: same values
        all_range = result.ranges["all"]
        assert all_range.cost_basis == 384.0
        assert all_range.total_invested == 768.0

    @patch(f"{MOCK_PREFIX}._compute_fee_summary", return_value=(0.0, 0))
    @patch(f"{MOCK_PREFIX}._compute_fees_in_period", return_value=0.0)
    @patch(f"{MOCK_PREFIX}._build_price_snapshot")
    @patch(f"{MOCK_PREFIX}._build_realized_pnl_snapshots")
    @patch(f"{MOCK_PREFIX}._get_cumulative_realized_pnl")
    @patch(f"{MOCK_PREFIX}._build_version_snapshot")
    def test_no_sales_acquired_equals_remaining(
        self,
        mock_build_snap,
        mock_cum_rpnl,
        mock_build_rpnl_snap,
        mock_build_prices,
        mock_compute_fees_period,
        mock_compute_fees,
    ):
        """When no lots are sold, total_invested == cost_basis."""
        from backend.services.pnl.metrics_service import compute_version_metrics

        now = datetime.now(timezone.utc)
        now_ds = now.strftime("%Y-%m-%d")
        all_start = now - timedelta(days=365)
        all_start_ds = all_start.strftime("%Y-%m-%d")

        version = MagicMock()
        version.version_id = 2
        version.base_currency_id = 100

        snap = _VersionSnapshot(
            version=version,
            base_currency_id=100,
            min_date=all_start,
            now=now,
            now_ds=now_ds,
            now_lot_balances={20: 10.0},
            now_lot_remaining_costs={20: 1000.0},
            now_lot_invested={20: 1000.0},  # same — no sales
            all_asset_ids={20},
            range_starts={"all": all_start},
            unique_dates=[all_start, now],
            balance_snapshots={
                all_start_ds: {},
                now_ds: {20: 10.0},
            },
            cost_basis_snapshots={
                all_start_ds: {},
                now_ds: {20: 1000.0},
            },
        )
        mock_build_snap.return_value = snap

        mock_build_prices.return_value = {
            all_start_ds: {},
            now_ds: {20: 120.0},
        }

        mock_build_rpnl_snap.return_value = {
            all_start_ds: (0.0, {}),
            now_ds: (0.0, {}),
        }
        mock_cum_rpnl.return_value = {
            now_ds: (0.0, {}),
        }

        session = MagicMock()
        session.exec.return_value.all.return_value = []

        result = compute_version_metrics(
            session=session,
            version_id=2,
            periods=["all"],
        )

        assert result is not None
        assert result.summary.cost_basis == result.summary.total_invested
        assert result.summary.total_invested == 1000.0
        assert result.ranges["all"].total_invested == 1000.0


# ============================================================================
# API serialization (metrics endpoint includes total_invested)
# ============================================================================


class TestMetricsApiTotalInvested:
    """Verify the /metrics API includes total_invested in response."""

    @pytest.fixture
    def client(self, mock_session):
        from fastapi.testclient import TestClient
        from backend.api.main import app
        return TestClient(app)

    @pytest.fixture
    def mock_session(self):
        from backend.api.main import app
        from backend.db.database import get_session_dependency
        from backend.api.routes.pnl_filter_depends import (
            get_pnl_transaction_filters,
            PnLTransactionFilters,
        )
        from backend.api.schemas import AppliedFilters

        session = MagicMock()
        app.dependency_overrides[get_session_dependency] = lambda: session
        app.dependency_overrides[get_pnl_transaction_filters] = lambda: PnLTransactionFilters(
            applied_filters=AppliedFilters(),
            non_owned=False,
            warnings=[],
        )
        yield session
        app.dependency_overrides.clear()

    @patch("backend.services.pnl.metrics_service.compute_version_metrics")
    def test_response_includes_total_invested(self, mock_compute, client):
        """API should serialize total_invested in summary and ranges."""
        mock_compute.return_value = VersionMetrics(
            version_id=1,
            summary=SummaryMetrics(
                current_value=500.0, cost_basis=384.0,
                unrealized_pnl=116.0, realized_pnl=50.0,
                taxable_realized_pnl=50.0, total_fees=0.0,
                fee_entry_count=0, total_invested=768.0,
            ),
            ranges={
                "all": RangeMetrics(
                    total_return=166.0, roi_pct=43.2,
                    current_value=500.0, cost_basis=384.0,
                    unrealized_pnl=116.0, realized_pnl=50.0,
                    taxable_realized_pnl=50.0, realized_in_period=50.0,
                    cost_basis_in_period=384.0, fees_in_period=0.0,
                    total_invested=768.0,
                ),
            },
        )

        resp = client.get("/pnl/versions/1/metrics")
        assert resp.status_code == 200
        data = resp.json()

        # Summary
        assert data["summary"]["total_invested"] == 768.0
        assert data["summary"]["cost_basis"] == 384.0

        # Range
        assert data["ranges"]["all"]["total_invested"] == 768.0
        assert data["ranges"]["all"]["cost_basis"] == 384.0
