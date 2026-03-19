"""
Tests for Cost Basis Chain API endpoints.

Covers:
- GET /versions/{version_id}/lots/{lot_id}/chain
- GET /versions/{version_id}/realized-pnl/{pnl_id}/chain
- GET /versions/{version_id}/events/{event_id}/chain
- _walk_lot_chain recursive walker logic
"""

import pytest
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import MagicMock, patch, PropertyMock

from backend.db.database import get_session_dependency
from backend.api.routes.pnl_filter_depends import (
    get_pnl_transaction_filters,
    PnLTransactionFilters,
)
from backend.api.schemas import AppliedFilters


# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture
def client(mock_session):
    """Create test client — depends on mock_session so overrides are active."""
    from fastapi.testclient import TestClient
    from backend.api.main import app
    return TestClient(app)


@pytest.fixture
def mock_session():
    """Override FastAPI dependencies with a mock session."""
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


def _make_lot(lot_id, asset_symbol="ETH", cost_source="fmv", source_lot_id=None,
              origin_pnl_id=None, notes=None, unit_id=1, version_id=1):
    """Create a mock CostLot with all fields the chain walker needs."""
    lot = MagicMock()
    lot.cost_lot_id = lot_id
    lot.asset_id = 10
    lot.asset.symbol = asset_symbol
    lot.account_id = 1
    lot.account.name = "Main"
    lot.origin_transaction_id = lot_id * 100
    lot.unit_id = unit_id
    lot.cost_source = cost_source
    lot.source_lot_id = source_lot_id
    lot.origin_pnl_id = origin_pnl_id
    lot.notes = notes
    lot.qty = Decimal("1.5")
    lot.unit_cost_in_base = Decimal("2000.0")
    lot.acquired_at = datetime(2025, 1, 1, tzinfo=timezone.utc)
    return lot


def _make_tx(tx_id, tx_type="buy"):
    """Create a mock NormalizedTransaction."""
    tx = MagicMock()
    tx.transaction_id = tx_id
    tx.transaction_type = tx_type
    tx.source_transaction_type = "manual"
    tx.date_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
    return tx


def _make_unit(unit_id=1, version_id=1, pattern="flow"):
    """Create a mock CalculationUnit."""
    unit = MagicMock()
    unit.unit_id = unit_id
    unit.version_id = version_id
    unit.pattern = pattern
    return unit


# ============================================================================
# GET /versions/{version_id}/lots/{lot_id}/chain
# ============================================================================


class TestGetLotChain:
    """Tests for the lot chain endpoint."""

    def test_lot_not_found_returns_404(self, client, mock_session):
        """Returns 404 when lot doesn't exist."""
        mock_session.exec.return_value.first.return_value = None

        response = client.get("/pnl/versions/1/lots/999/chain")
        assert response.status_code == 404

    def test_lot_wrong_version_returns_404(self, client, mock_session):
        """Returns 404 when lot exists but belongs to different version."""
        lot = _make_lot(1)
        mock_session.exec.return_value.first.return_value = lot

        unit = _make_unit(unit_id=1, version_id=99)  # Different version
        mock_session.get.return_value = unit

        response = client.get("/pnl/versions/1/lots/1/chain")
        assert response.status_code == 404

    def test_terminal_lot_returns_single_node(self, client, mock_session):
        """FMV lot (origin) returns a chain with depth 0 and no children."""
        lot = _make_lot(1, cost_source="fmv")
        tx = _make_tx(100, "buy")
        unit = _make_unit(version_id=1)

        mock_session.exec.return_value.first.return_value = lot
        mock_session.get.side_effect = lambda model, id: {
            (type(unit), 1): unit,
            (type(tx), 100): tx,
        }.get((model, id), tx if id == 100 else unit)

        response = client.get("/pnl/versions/1/lots/1/chain")
        assert response.status_code == 200

        data = response.json()
        assert data["depth"] == 0
        assert len(data["chain"]) == 1
        assert data["chain"][0]["lot_id"] == 1
        assert data["chain"][0]["cost_source"] == "fmv"
        assert data["chain"][0]["children"] == []

    def test_inherited_lot_follows_source_lot_id(self, client, mock_session):
        """Inherited lot with source_lot_id walks backward to origin."""
        origin_lot = _make_lot(10, cost_source="fmv")
        child_lot = _make_lot(20, cost_source="inherited", source_lot_id=10)
        tx_origin = _make_tx(1000, "buy")
        tx_child = _make_tx(2000, "transfer")
        unit = _make_unit(version_id=1)

        # session.exec().first() is called multiple times:
        # 1) find child lot by id, 2) find origin lot by source_lot_id
        exec_results = [child_lot, origin_lot]
        call_count = [0]

        def mock_exec(stmt):
            result = MagicMock()
            idx = min(call_count[0], len(exec_results) - 1)
            result.first.return_value = exec_results[idx]
            call_count[0] += 1
            return result

        mock_session.exec.side_effect = mock_exec
        mock_session.get.side_effect = lambda model, id: {
            1000: tx_origin, 2000: tx_child,
        }.get(id, unit)

        response = client.get("/pnl/versions/1/lots/20/chain")
        assert response.status_code == 200

        data = response.json()
        assert data["depth"] == 1
        root = data["chain"][0]
        assert root["lot_id"] == 20
        assert root["cost_source"] == "inherited"
        assert len(root["children"]) == 1
        assert root["children"][0]["lot_id"] == 10
        assert root["children"][0]["cost_source"] == "fmv"

    def test_inherited_note_fallback(self, client, mock_session):
        """Inherited lot without source_lot_id falls back to notes parsing."""
        origin_lot = _make_lot(42, cost_source="fmv")
        child_lot = _make_lot(50, cost_source="inherited", source_lot_id=None,
                              notes="Transfer (from lot 42)")
        tx = _make_tx(100, "buy")
        unit = _make_unit(version_id=1)

        exec_results = [child_lot, origin_lot]
        call_count = [0]

        def mock_exec(stmt):
            result = MagicMock()
            idx = min(call_count[0], len(exec_results) - 1)
            result.first.return_value = exec_results[idx]
            call_count[0] += 1
            return result

        mock_session.exec.side_effect = mock_exec
        mock_session.get.side_effect = lambda model, id: {}.get(id, tx if isinstance(id, int) and id > 50 else unit)

        response = client.get("/pnl/versions/1/lots/50/chain")
        assert response.status_code == 200

        data = response.json()
        root = data["chain"][0]
        assert root["lot_id"] == 50
        assert len(root["children"]) == 1
        assert root["children"][0]["lot_id"] == 42


# ============================================================================
# GET /versions/{version_id}/realized-pnl/{pnl_id}/chain
# ============================================================================


class TestGetRealizedPnlChain:
    """Tests for the realized P&L chain endpoint."""

    def test_pnl_not_found_returns_404(self, client, mock_session):
        """Returns 404 when P&L entry doesn't exist."""
        mock_session.exec.return_value.first.return_value = None

        response = client.get("/pnl/versions/1/realized-pnl/999/chain")
        assert response.status_code == 404

    def test_pnl_wrong_version_returns_404(self, client, mock_session):
        """Returns 404 when P&L exists but unit belongs to different version."""
        rpnl = MagicMock()
        rpnl.pnl_id = 1
        rpnl.origin_unit_id = 1
        mock_session.exec.return_value.first.return_value = rpnl

        unit = _make_unit(version_id=99)
        mock_session.get.return_value = unit

        response = client.get("/pnl/versions/1/realized-pnl/1/chain")
        assert response.status_code == 404

    def test_pnl_chain_returns_consumed_lots(self, client, mock_session):
        """P&L chain walks each consumed lot slice."""
        rpnl = MagicMock()
        rpnl.pnl_id = 1
        rpnl.origin_unit_id = 1
        unit = _make_unit(version_id=1)
        lot = _make_lot(5, cost_source="fmv")
        tx = _make_tx(500, "buy")

        slice_mock = MagicMock()
        slice_mock.cost_lot = lot
        slice_mock.cost_lot.cost_lot_id = 5

        # exec calls: 1) find rpnl, 2) find consumed slices
        call_count = [0]

        def mock_exec(stmt):
            result = MagicMock()
            if call_count[0] == 0:
                result.first.return_value = rpnl
            else:
                result.all.return_value = [slice_mock]
            call_count[0] += 1
            return result

        mock_session.exec.side_effect = mock_exec
        mock_session.get.side_effect = lambda model, id: {
            500: tx,
        }.get(id, unit)

        response = client.get("/pnl/versions/1/realized-pnl/1/chain")
        assert response.status_code == 200

        data = response.json()
        assert len(data["chain"]) == 1
        assert data["chain"][0]["lot_id"] == 5


# ============================================================================
# GET /versions/{version_id}/events/{event_id}/chain
# ============================================================================


class TestGetEventChain:
    """Tests for the event chain endpoint."""

    def test_event_not_found_returns_404(self, client, mock_session):
        """Returns 404 when event doesn't exist."""
        mock_session.get.return_value = None

        response = client.get("/pnl/versions/1/events/999/chain")
        assert response.status_code == 404

    def test_event_chain_walks_lot(self, client, mock_session):
        """Event chain resolves the lot_id and walks."""
        from backend.db.models import CostLotEvent, NormalizedTransaction, CalculationUnit

        event = MagicMock()
        event.event_id = 1
        event.lot_id = 5

        lot = _make_lot(5, cost_source="fmv")
        tx = _make_tx(500, "buy")
        unit = _make_unit(version_id=1)

        mock_session.exec.return_value.first.return_value = lot

        def _get(model, id):
            if model is CostLotEvent:
                return event if id == 1 else None
            if model is NormalizedTransaction:
                return tx
            if model is CalculationUnit:
                return unit
            return unit

        mock_session.get.side_effect = _get

        response = client.get("/pnl/versions/1/events/1/chain")
        assert response.status_code == 200

        data = response.json()
        assert len(data["chain"]) == 1
        assert data["chain"][0]["lot_id"] == 5
        assert data["chain"][0]["cost_source"] == "fmv"


# ============================================================================
# _walk_lot_chain unit tests (no HTTP, test logic directly)
# ============================================================================


class TestWalkLotChain:
    """Direct unit tests for the recursive chain walker."""

    def test_cycle_detection_stops_recursion(self):
        """Visited set prevents infinite loops."""
        from backend.api.routes.pnl import _walk_lot_chain

        session = MagicMock()
        # Lot A (inherited, source=B), Lot B (inherited, source=A) — circular
        lot_a = _make_lot(1, cost_source="inherited", source_lot_id=2)
        lot_b = _make_lot(2, cost_source="inherited", source_lot_id=1)

        tx = _make_tx(100, "transfer")
        unit = _make_unit()
        session.get.side_effect = lambda model, id: tx if id in (100, 200) else unit

        # First call returns lot_b, second would try lot_a but it's already visited
        session.exec.return_value.first.return_value = lot_b

        visited = set()
        node = _walk_lot_chain(lot_a, session, visited, max_depth=100, current_depth=0)

        assert node.lot_id == 1
        assert len(node.children) == 1
        assert node.children[0].lot_id == 2
        # lot_b's child would be lot_a (id=1), but 1 is already visited → no grandchildren
        assert node.children[0].children == []

    def test_max_depth_stops_recursion(self):
        """Recursion stops at max_depth."""
        from backend.api.routes.pnl import _walk_lot_chain

        session = MagicMock()
        lot = _make_lot(1, cost_source="inherited", source_lot_id=2)
        tx = _make_tx(100, "transfer")
        unit = _make_unit()
        session.get.side_effect = lambda model, id: tx if id == 100 else unit

        visited = set()
        # Already at max depth → no children traversal
        node = _walk_lot_chain(lot, session, visited, max_depth=5, current_depth=5)

        assert node.lot_id == 1
        assert node.children == []

    def test_proceeds_follows_origin_pnl(self):
        """Proceeds cost_source follows origin_pnl_id → consumed slices."""
        from backend.api.routes.pnl import _walk_lot_chain

        session = MagicMock()
        swap_lot = _make_lot(1, cost_source="proceeds", origin_pnl_id=10)
        origin_lot = _make_lot(2, cost_source="fmv")
        tx = _make_tx(100, "swap")
        tx_origin = _make_tx(200, "buy")
        unit = _make_unit()

        session.get.side_effect = lambda model, id: {
            100: tx, 200: tx_origin,
        }.get(id, unit)

        slice_mock = MagicMock()
        slice_mock.cost_lot = origin_lot
        slice_mock.cost_lot.cost_lot_id = 2

        call_count = [0]

        def mock_exec(stmt):
            result = MagicMock()
            if call_count[0] == 0:
                # First exec: consumed slices for origin_pnl_id
                result.all.return_value = [slice_mock]
            else:
                result.first.return_value = None
            call_count[0] += 1
            return result

        session.exec.side_effect = mock_exec

        visited = set()
        node = _walk_lot_chain(swap_lot, session, visited, max_depth=100, current_depth=0)

        assert node.lot_id == 1
        assert node.cost_source == "proceeds"
        assert len(node.children) == 1
        assert node.children[0].lot_id == 2
        assert node.children[0].cost_source == "fmv"

    def test_base_currency_is_terminal(self):
        """base_currency cost_source is terminal — no children."""
        from backend.api.routes.pnl import _walk_lot_chain

        session = MagicMock()
        lot = _make_lot(1, cost_source="base_currency")
        tx = _make_tx(100, "buy")
        unit = _make_unit()
        session.get.side_effect = lambda model, id: tx if id == 100 else unit

        visited = set()
        node = _walk_lot_chain(lot, session, visited, max_depth=100, current_depth=0)

        assert node.lot_id == 1
        assert node.cost_source == "base_currency"
        assert node.children == []


# ============================================================================
# _compute_chain_depth
# ============================================================================


class TestComputeChainDepth:
    """Tests for chain depth calculation."""

    def test_single_node_depth_zero(self):
        from backend.api.routes.pnl import _compute_chain_depth, CostBasisChainNode
        node = CostBasisChainNode(lot_id=1, children=[])
        assert _compute_chain_depth(node) == 0

    def test_depth_two_chain(self):
        from backend.api.routes.pnl import _compute_chain_depth, CostBasisChainNode
        grandchild = CostBasisChainNode(lot_id=3, children=[])
        child = CostBasisChainNode(lot_id=2, children=[grandchild])
        root = CostBasisChainNode(lot_id=1, children=[child])
        assert _compute_chain_depth(root) == 2

    def test_branching_takes_max_depth(self):
        from backend.api.routes.pnl import _compute_chain_depth, CostBasisChainNode
        deep_child = CostBasisChainNode(lot_id=3, children=[
            CostBasisChainNode(lot_id=4, children=[])
        ])
        shallow_child = CostBasisChainNode(lot_id=2, children=[])
        root = CostBasisChainNode(lot_id=1, children=[deep_child, shallow_child])
        assert _compute_chain_depth(root) == 2
