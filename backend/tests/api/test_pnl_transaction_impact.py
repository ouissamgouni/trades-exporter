"""Transaction impact endpoint, swap-aware cost chain and net deposits."""

from datetime import datetime
from decimal import Decimal
from unittest.mock import MagicMock

import pytest

from backend.db.database import get_session_dependency
from backend.db.models import CalculationUnit, CalculationVersion, NormalizedTransaction


@pytest.fixture
def mock_session():
    from backend.api.main import app

    session = MagicMock()
    app.dependency_overrides[get_session_dependency] = lambda: session
    yield session
    app.dependency_overrides.clear()


@pytest.fixture
def client(mock_session):
    from fastapi.testclient import TestClient
    from backend.api.main import app

    return TestClient(app)


def _version(created=datetime(2026, 1, 1)):
    v = MagicMock(spec=CalculationVersion)
    v.created_at = created
    return v


def _tx(
    status="valid", date_time=datetime(2025, 6, 1), updated_at=datetime(2025, 6, 1)
):
    tx = MagicMock(spec=NormalizedTransaction)
    tx.review_status = status
    tx.date_time = date_time
    tx.updated_at = updated_at
    return tx


class TestTransactionImpact:
    def test_unknown_version_returns_404(self, client, mock_session):
        mock_session.get.return_value = None
        assert client.get("/pnl/versions/9/transactions/1/impact").status_code == 404

    def test_unknown_transaction_returns_404(self, client, mock_session):
        mock_session.get.side_effect = lambda model, _id: (
            _version() if model is CalculationVersion else None
        )
        assert client.get("/pnl/versions/1/transactions/9/impact").status_code == 404

    @pytest.mark.parametrize(
        "tx, reason",
        [
            (_tx(status="pending"), "pending"),
            (_tx(status="invalid"), "invalid"),
            (_tx(date_time=datetime(2026, 2, 1)), "after_calculation"),
            (_tx(), "not_processed"),
        ],
    )
    def test_transaction_without_legs_is_excluded_with_reason(
        self, client, mock_session, tx, reason
    ):
        version = _version()
        mock_session.get.side_effect = lambda model, _id: (
            version if model is CalculationVersion else tx
        )
        mock_session.exec.return_value.all.return_value = []

        data = client.get("/pnl/versions/1/transactions/1/impact").json()

        assert data["included"] is False
        assert data["excluded_reason"] == reason
        assert data["realized_entries"] == []

    def test_edit_after_calculation_is_flagged_stale(self, client, mock_session):
        version = _version(created=datetime(2026, 1, 1))
        tx = _tx(updated_at=datetime(2026, 3, 1))
        mock_session.get.side_effect = lambda model, _id: (
            version if model is CalculationVersion else tx
        )
        mock_session.exec.return_value.all.return_value = []

        assert (
            client.get("/pnl/versions/1/transactions/1/impact").json()["stale"] is True
        )


def _lot(lot_id, asset_id, cost_source, unit_id, unit_cost, economic_unit_cost):
    lot = MagicMock()
    lot.cost_lot_id = lot_id
    lot.asset_id = asset_id
    lot.asset.symbol = f"A{asset_id}"
    lot.account_id = 1
    lot.account.name = "Main"
    lot.origin_transaction_id = lot_id * 10
    lot.unit_id = unit_id
    lot.cost_source = cost_source
    lot.source_lot_id = None
    lot.origin_pnl_id = None
    lot.notes = None
    lot.qty = Decimal("8")
    lot.unit_cost_in_base = Decimal(unit_cost)
    lot.economic_unit_cost = Decimal(economic_unit_cost)
    lot.acquired_at = datetime(2024, 3, 1)
    return lot


class TestSwapChain:
    def test_tax_deferred_swap_walks_to_the_asset_given_up(self):
        from backend.api.routes.pnl import _walk_lot_chain

        eth = _lot(
            4,
            asset_id=3,
            cost_source="inherited",
            unit_id=5,
            unit_cost="1875",
            economic_unit_cost="2500",
        )
        btc = _lot(
            2,
            asset_id=2,
            cost_source="fmv",
            unit_id=2,
            unit_cost="30000",
            economic_unit_cost="30000",
        )
        swap_unit = MagicMock(spec=CalculationUnit)
        swap_unit.id = 5
        swap_unit.pattern = "swap"
        buy_unit = MagicMock(spec=CalculationUnit)
        buy_unit.id = 2
        buy_unit.pattern = "flow"

        tx = MagicMock(
            date_time=datetime(2024, 3, 1),
            transaction_type="trade",
            source_transaction_type="buy",
        )
        session = MagicMock()
        session.get.side_effect = lambda model, _id: (
            {5: swap_unit, 2: buy_unit}.get(_id) if model is CalculationUnit else tx
        )
        given_up = MagicMock(cost_lot=btc)
        received = MagicMock(cost_lot=eth)
        session.exec.return_value.all.return_value = [given_up, received]

        node = _walk_lot_chain(eth, session, visited=set())

        assert node.unit_cost == 1875.0
        assert node.economic_unit_cost == 2500.0
        assert [c.lot_id for c in node.children] == [2]
        assert node.children[0].children == []


class TestNetDeposits:
    def _session(self, values):
        session = MagicMock()
        session.exec.return_value.one.side_effect = values
        return session

    def test_portfolio_counts_external_flows_only(self):
        from backend.services.pnl.metrics_service import _get_net_deposits

        # deposits in, base currency withdrawn, other assets withdrawn
        session = self._session([31000, 1000, 500])
        assert _get_net_deposits(session, 1, base_currency_id=1) == 29500

    def test_account_scope_adds_internal_transfers(self):
        from backend.services.pnl.metrics_service import _get_net_deposits

        # flows: 0 in / 0 out; transfers: 20 000 received, 0 sent
        session = self._session([0, 0, 0, 20000, 0])
        assert (
            _get_net_deposits(session, 1, base_currency_id=1, account_ids=[2]) == 20000
        )
