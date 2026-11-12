"""
Integration tests for GET /pnl/versions/{version_id}/metrics endpoint.

Verifies:
- /metrics summary matches /versions/{id} fields (single source of truth)
- current_value/cost_basis/unrealized_pnl are constant across period ranges
- total_return/roi_pct/realized_in_period change per period when data differs
- group_by=asset vs account vs category returns different performer group_types
- Version not found → 404
"""

import pytest
from unittest.mock import MagicMock, patch

from backend.db.database import get_session_dependency
from backend.api.routes.pnl_filter_depends import (
    get_pnl_transaction_filters,
    PnLTransactionFilters,
)
from backend.api.schemas import AppliedFilters
from backend.services.pnl.metrics_service import (
    VersionMetrics,
    SummaryMetrics,
    RangeMetrics,
    PerformerItem,
)


# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture
def client(mock_session):
    from fastapi.testclient import TestClient
    from backend.api.main import app
    return TestClient(app)


@pytest.fixture
def mock_session():
    from backend.api.main import app

    session = MagicMock()
    app.dependency_overrides[get_session_dependency] = lambda: session
    app.dependency_overrides[get_pnl_transaction_filters] = lambda: PnLTransactionFilters(
        applied_filters=AppliedFilters(),
        non_owned=False,
        warnings=[],
    )
    yield session
    app.dependency_overrides.clear()


def _make_metrics(
    version_id=1,
    current_value=80000.0,
    cost_basis=35000.0,
    unrealized_pnl=45000.0,
    realized_pnl=5000.0,
    taxable_realized_pnl=4000.0,
    total_fees=120.0,
    fee_entry_count=3,
    group_type="asset",
) -> VersionMetrics:
    """Build a VersionMetrics with 'all' and '1m' ranges."""
    summary = SummaryMetrics(
        current_value=current_value,
        cost_basis=cost_basis,
        unrealized_pnl=unrealized_pnl,
        realized_pnl=realized_pnl,
        taxable_realized_pnl=taxable_realized_pnl,
        total_fees=total_fees,
        fee_entry_count=fee_entry_count,
    )

    top_btc = PerformerItem(
        id=10, name="BTC", label="Bitcoin",
        group_type=group_type, total_return=43000.0, roi_pct=215.0,
    )
    flop_doge = PerformerItem(
        id=30, name="DOGE", label="Dogecoin",
        group_type=group_type, total_return=-500.0, roi_pct=-100.0,
    )

    all_range = RangeMetrics(
        cost_basis=cost_basis, realized_pnl=realized_pnl,
        taxable_realized_pnl=taxable_realized_pnl,
        realized_in_period=realized_pnl,
        cost_basis_in_period=cost_basis, fees_in_period=total_fees,
        total_return=50000.0, roi_pct=142.86,
        current_value=current_value,
        unrealized_pnl=unrealized_pnl,
        top_performers=[top_btc], flop_performers=[flop_doge],
    )

    one_month_range = RangeMetrics(
        cost_basis=cost_basis, realized_pnl=realized_pnl,
        taxable_realized_pnl=taxable_realized_pnl,
        realized_in_period=3000.0,
        cost_basis_in_period=0.0, fees_in_period=0.0,
        total_return=11000.0, roi_pct=61.11,
        current_value=current_value,
        unrealized_pnl=unrealized_pnl,
        top_performers=[top_btc], flop_performers=[],
    )

    return VersionMetrics(
        version_id=version_id,
        summary=summary,
        ranges={"all": all_range, "1m": one_month_range},
    )


# ============================================================================
# GET /pnl/versions/{version_id}/metrics
# ============================================================================


MOCK_COMPUTE = "backend.services.pnl.metrics_service.compute_version_metrics"


class TestMetricsEndpoint:
    """Tests for the /metrics endpoint."""

    @patch(MOCK_COMPUTE)
    def test_returns_summary_and_ranges(self, mock_compute, client):
        """Should return summary and range metrics."""
        mock_compute.return_value = _make_metrics()

        resp = client.get("/pnl/versions/1/metrics")
        assert resp.status_code == 200
        data = resp.json()

        assert data["version_id"] == 1
        assert "summary" in data
        assert "ranges" in data
        assert set(data["ranges"].keys()) == {"all", "1m"}

    @patch(MOCK_COMPUTE)
    def test_summary_fields(self, mock_compute, client):
        """Summary should contain all expected fields."""
        mock_compute.return_value = _make_metrics()

        data = client.get("/pnl/versions/1/metrics").json()
        s = data["summary"]

        assert s["current_value"] == 80000.0
        assert s["cost_basis"] == 35000.0
        assert s["unrealized_pnl"] == 45000.0
        assert s["realized_pnl"] == 5000.0
        assert s["taxable_realized_pnl"] == 4000.0
        assert s["total_fees"] == 120.0
        assert s["fee_entry_count"] == 3

    @patch(MOCK_COMPUTE)
    def test_current_value_constant_across_ranges(self, mock_compute, client):
        """current_value, cost_basis, unrealized_pnl should be identical in all ranges."""
        mock_compute.return_value = _make_metrics()

        data = client.get("/pnl/versions/1/metrics").json()
        all_r = data["ranges"]["all"]
        one_m = data["ranges"]["1m"]

        assert all_r["current_value"] == one_m["current_value"] == 80000.0
        assert all_r["cost_basis"] == one_m["cost_basis"] == 35000.0
        assert all_r["unrealized_pnl"] == one_m["unrealized_pnl"] == 45000.0

    @patch(MOCK_COMPUTE)
    def test_total_return_differs_by_period(self, mock_compute, client):
        """total_return and roi_pct should differ between 'all' and '1m'."""
        mock_compute.return_value = _make_metrics()

        data = client.get("/pnl/versions/1/metrics").json()

        assert data["ranges"]["all"]["total_return"] == 50000.0
        assert data["ranges"]["1m"]["total_return"] == 11000.0
        assert data["ranges"]["all"]["roi_pct"] != data["ranges"]["1m"]["roi_pct"]

    @patch(MOCK_COMPUTE)
    def test_realized_in_period_differs(self, mock_compute, client):
        """realized_in_period should differ: all-time = total realized, 1m = recent only."""
        mock_compute.return_value = _make_metrics()

        data = client.get("/pnl/versions/1/metrics").json()

        assert data["ranges"]["all"]["realized_in_period"] == 5000.0  # all realized
        assert data["ranges"]["1m"]["realized_in_period"] == 3000.0  # recent subset

    @patch(MOCK_COMPUTE)
    def test_performers_have_group_type_asset(self, mock_compute, client):
        """Default group_by=asset: performers should have group_type='asset'."""
        mock_compute.return_value = _make_metrics(group_type="asset")

        data = client.get("/pnl/versions/1/metrics").json()
        top = data["ranges"]["all"]["top_performers"]
        flop = data["ranges"]["all"]["flop_performers"]

        assert len(top) == 1
        assert top[0]["group_type"] == "asset"
        assert top[0]["name"] == "BTC"
        assert top[0]["label"] == "Bitcoin"
        assert len(flop) == 1
        assert flop[0]["group_type"] == "asset"

    @patch(MOCK_COMPUTE)
    def test_group_by_account(self, mock_compute, client):
        """group_by=account → compute_version_metrics called with group_by='account'."""
        mock_compute.return_value = _make_metrics(group_type="account")

        resp = client.get("/pnl/versions/1/metrics?group_by=account")
        assert resp.status_code == 200

        mock_compute.assert_called_once()
        call_kwargs = mock_compute.call_args[1]
        assert call_kwargs["group_by"] == "account"

    @patch(MOCK_COMPUTE)
    def test_group_by_category(self, mock_compute, client):
        """group_by=category → compute_version_metrics called with group_by='category'."""
        mock_compute.return_value = _make_metrics(group_type="category")

        resp = client.get("/pnl/versions/1/metrics?group_by=category")
        assert resp.status_code == 200

        call_kwargs = mock_compute.call_args[1]
        assert call_kwargs["group_by"] == "category"

    @patch(MOCK_COMPUTE)
    def test_version_not_found_returns_404(self, mock_compute, client):
        """Non-existent version → 404."""
        mock_compute.return_value = None

        resp = client.get("/pnl/versions/999/metrics")
        assert resp.status_code == 404

    @patch(MOCK_COMPUTE)
    def test_top_n_param_passed(self, mock_compute, client):
        """top_n query param should be forwarded to compute_version_metrics."""
        mock_compute.return_value = _make_metrics()

        client.get("/pnl/versions/1/metrics?top_n=10")
        call_kwargs = mock_compute.call_args[1]
        assert call_kwargs["top_n"] == 10

    @patch(MOCK_COMPUTE)
    def test_invalid_group_by_rejected(self, mock_compute, client):
        """Invalid group_by value → 422."""
        resp = client.get("/pnl/versions/1/metrics?group_by=invalid")
        assert resp.status_code == 422


class TestMetricsVersionConsistency:
    """Verify /metrics summary and /versions/{id} return consistent data.

    Note: /versions/{id} runs lightweight DB aggregates (realized P&L, fees)
    and does NOT compute price-dependent fields (current_value, unrealized_pnl,
    cost_basis) — those default to 0.0.  Only /metrics calls
    compute_version_metrics.  This test verifies the DB-sourced fields match.
    """

    @patch(MOCK_COMPUTE)
    @patch("backend.api.routes.pnl.fetch_version_entity_ids")
    def test_summary_matches_version_response(
        self, mock_entity_ids, mock_compute, client, mock_session,
    ):
        """
        DB-sourced fields (realized_pnl, taxable_realized_pnl, fees) from
        /versions/{id} should agree with the same fields in /metrics summary.
        """
        # Values we expect both endpoints to agree on
        realized = 5000.0
        taxable_realized = 4000.0
        total_fees = 120.0
        fee_count = 3

        metrics = _make_metrics(
            realized_pnl=realized,
            taxable_realized_pnl=taxable_realized,
            total_fees=total_fees,
            fee_entry_count=fee_count,
        )
        mock_compute.return_value = metrics

        # Mock version object for get_version()
        version = MagicMock()
        version.version_id = 1
        version.description = "Test"
        version.created_at = None
        version.expires_at = None
        version.status = "active"
        version.trigger = "manual"
        version.method = "fifo"
        version.lot_mode = "automatic"
        version.base_currency_id = 1
        version.allow_negative_balances = False
        version.residual_tolerance_pct = 1.0
        version.compute_residuals = True
        version.crypto_swap_taxable = True
        version.fee_taxable = True
        version.use_price_fallback = True
        version.price_staleness_window_days = 7
        version.account_ids = None

        # Mock base currency asset
        asset_mock = MagicMock()
        asset_mock.symbol = "EUR"

        from backend.db.models import CalculationVersion, Asset
        def mock_get(model, id_):
            if model is CalculationVersion:
                return version
            if model is Asset:
                return asset_mock
            return None
        mock_session.get.side_effect = mock_get

        # Mock SQL aggregates that get_version() executes
        # session.exec(rpnl_query).one() is called twice:
        #   1) total realized → realized
        #   2) taxable realized → taxable_realized
        # session.exec(fee_query).first() returns (total_fees, fee_count)
        fee_row = MagicMock()
        fee_row.total_fees = total_fees
        fee_row.fee_count = fee_count

        exec_results = iter([
            MagicMock(one=MagicMock(return_value=realized)),        # rpnl total
            MagicMock(one=MagicMock(return_value=taxable_realized)),  # rpnl taxable
            MagicMock(first=MagicMock(return_value=fee_row)),        # fee summary
        ])
        mock_session.exec.side_effect = lambda q: next(exec_results)

        mock_entity_ids.return_value = {
            "calculation_unit_ids": [],
            "warning_ids": [],
            "cost_lot_ids": [],
            "realized_pnl_ids": [],
            "fee_ids": [],
            "cost_lot_event_ids": [],
        }

        # GET /metrics
        metrics_resp = client.get("/pnl/versions/1/metrics").json()
        ms = metrics_resp["summary"]

        # GET /versions/1
        version_resp = client.get("/pnl/versions/1").json()

        # DB-sourced fields should match
        assert version_resp["total_realized_pnl"] == ms["realized_pnl"]
        assert version_resp["taxable_realized_pnl"] == ms["taxable_realized_pnl"]
        assert version_resp["total_fees_in_base"] == ms["total_fees"]
        assert version_resp["fee_entry_count"] == ms["fee_entry_count"]

        # Price-dependent fields: /versions/{id} doesn't compute these,
        # so they default to 0.0.  Just verify they're present.
        assert version_resp["current_value"] == 0.0
        assert version_resp["unrealized_pnl"] == 0.0
        assert version_resp["cost_basis"] == 0.0


class TestReturnAndBenchmarkEndpoints:
    TIMELINE = "backend.services.pnl.portfolio_timeline.compute_portfolio_timeline_cached"

    @staticmethod
    def _timeline():
        from backend.services.pnl.portfolio_timeline import TimelinePoint

        return [
            TimelinePoint(date="2025-01-01", total_value_in_base=100.0, cost_basis_in_base=100.0,
                          unrealized_pnl=0.0, cumulative_realized_pnl=0.0),
            TimelinePoint(date="2026-01-01", total_value_in_base=110.0, cost_basis_in_base=100.0,
                          unrealized_pnl=10.0, cumulative_realized_pnl=0.0),
        ]

    def test_return_metrics_per_range(self, client, mock_session):
        with patch(self.TIMELINE, return_value=self._timeline()):
            resp = client.get("/pnl/versions/1/return-metrics")
        assert resp.status_code == 200
        assert abs(resp.json()["ranges"]["all"]["twr_pct"] - 10.0) < 1e-6

    def test_return_metrics_unknown_version(self, client, mock_session):
        mock_session.get.return_value = None
        assert client.get("/pnl/versions/999/return-metrics").status_code == 404

    def test_benchmark_comparison(self, client, mock_session):
        bench = [{"date": "2025-01-01", "close": 50.0}, {"date": "2026-01-01", "close": 52.5}]
        with patch(self.TIMELINE, return_value=self._timeline()), \
                patch("backend.api.routes.pnl._load_benchmark_points", return_value=bench):
            resp = client.get("/pnl/versions/1/benchmark-comparison?ticker=^STOXX50E&base_currency=EUR")
        assert resp.status_code == 200
        data = resp.json()
        assert data["converted"] is True
        assert abs(data["benchmark_return_pct"] - 5.0) < 1e-6
        assert abs(data["excess_pp"] - 5.0) < 1e-6

    def test_benchmark_comparison_rejects_unknown_ticker(self, client, mock_session):
        assert client.get("/pnl/versions/1/benchmark-comparison?ticker=EVIL").status_code == 400
