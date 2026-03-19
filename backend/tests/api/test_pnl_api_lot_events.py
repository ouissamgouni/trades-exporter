"""
Tests for P&L Lot-Events API endpoint.

Covers the `related_asset_id` query parameter which returns events where the
asset is the primary lot asset OR the triggering unit has a leg involving
that asset (e.g. as price-quote or fee-quote).
"""

import pytest
from datetime import datetime
from decimal import Decimal
from unittest.mock import MagicMock, patch

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


@pytest.fixture
def mock_version():
    """Create mock CalculationVersion."""
    version = MagicMock()
    version.version_id = 1
    version.status = "committed"
    return version


def _make_event(event_id, event_type, asset_id, asset_symbol, account_id=1, account_name="Acc"):
    """Helper to build a mock CostLotEvent with nested lot + asset + account."""
    mock_asset = MagicMock()
    mock_asset.asset_id = asset_id
    mock_asset.symbol = asset_symbol

    mock_account = MagicMock()
    mock_account.name = account_name

    mock_lot = MagicMock()
    mock_lot.asset = mock_asset
    mock_lot.asset_id = asset_id
    mock_lot.account_id = account_id
    mock_lot.account = mock_account

    mock_unit = MagicMock()
    mock_unit.unit_label = f"unit-for-{event_id}"
    mock_unit.pattern = "swap"

    evt = MagicMock()
    evt.event_id = event_id
    evt.event_type = event_type
    evt.lot_id = event_id * 10
    evt.lot = mock_lot
    evt.quantity_delta = Decimal("1.0")
    evt.cost_basis_delta = Decimal("100.0")
    evt.qty_remaining_after = Decimal("5.0")
    evt.cost_basis_remaining_after = Decimal("500.0")
    evt.balance_after = Decimal("5.0")
    evt.account_balance_after = Decimal("5.0")
    evt.related_lot_id = None
    evt.related_lot = None
    evt.triggered_by_transaction_id = event_id * 100
    evt.triggered_by_unit_id = event_id
    evt.triggered_by_unit = mock_unit
    evt.timestamp = datetime(2025, 1, 1, 12, 0, 0)
    evt.sequence_num = 1
    return evt


def _setup_lot_events_exec(mock_session, events):
    """
    Set up session.exec() return values for the lot-events endpoint.

    Call order:
      1. _apply_unit_filter may call exec (no-op for empty tx_filters)
      2. count query → .one() → int
      3. paginated query → .all() → list[CostLotEvent]
    """
    count_result = MagicMock()
    count_result.one.return_value = len(events)

    events_result = MagicMock()
    events_result.all.return_value = events

    mock_session.exec.side_effect = [count_result, events_result]


# ============================================================================
# Tests
# ============================================================================


class TestLotEventsRelatedAssetId:
    """Tests for GET /pnl/versions/{version_id}/lot-events?related_asset_id=..."""

    def test_no_filter_returns_all(self, client, mock_session, mock_version):
        """Without related_asset_id the endpoint returns events normally."""
        mock_session.get.return_value = mock_version
        events = [_make_event(1, "created", 1, "BTC"), _make_event(2, "consumed", 2, "USDT")]
        _setup_lot_events_exec(mock_session, events)

        response = client.get("/pnl/versions/1/lot-events")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 2
        assert len(data["items"]) == 2

    def test_related_asset_id_accepted(self, client, mock_session, mock_version):
        """Endpoint accepts the related_asset_id query parameter."""
        mock_session.get.return_value = mock_version
        events = [_make_event(1, "created", 2, "USDT")]
        _setup_lot_events_exec(mock_session, events)

        response = client.get("/pnl/versions/1/lot-events?related_asset_id=2")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1

    def test_related_asset_id_comma_separated(self, client, mock_session, mock_version):
        """Endpoint parses comma-separated related_asset_id list."""
        mock_session.get.return_value = mock_version
        events = [_make_event(1, "created", 2, "USDT")]
        _setup_lot_events_exec(mock_session, events)

        response = client.get("/pnl/versions/1/lot-events?related_asset_id=2,3")
        assert response.status_code == 200
        assert response.json()["total"] == 1

    def test_related_asset_id_coexists_with_other_filters(self, client, mock_session, mock_version):
        """related_asset_id works alongside event_type and other params."""
        mock_session.get.return_value = mock_version
        events = [_make_event(1, "created", 2, "USDT")]
        _setup_lot_events_exec(mock_session, events)

        response = client.get(
            "/pnl/versions/1/lot-events?related_asset_id=2&event_type=created"
        )
        assert response.status_code == 200
        assert response.json()["total"] == 1

    def test_response_item_shape(self, client, mock_session, mock_version):
        """Verify the shape of returned items regardless of filter used."""
        mock_session.get.return_value = mock_version
        events = [_make_event(1, "created", 2, "USDT")]
        _setup_lot_events_exec(mock_session, events)

        response = client.get("/pnl/versions/1/lot-events?related_asset_id=2")
        item = response.json()["items"][0]

        assert "event_id" in item
        assert "event_type" in item
        assert item["event_type"] == "created"
        assert item["asset"]["id"] == 2
        assert item["asset"]["symbol"] == "USDT"
        assert "triggered_by_unit_id" in item
        assert "triggered_by_unit_label" in item

    def test_version_not_found(self, client, mock_session):
        """404 when version does not exist."""
        mock_session.get.return_value = None

        response = client.get("/pnl/versions/999/lot-events?related_asset_id=2")
        assert response.status_code == 404

    def test_pagination_with_related_asset_id(self, client, mock_session, mock_version):
        """Pagination params work with related_asset_id."""
        mock_session.get.return_value = mock_version
        events = [_make_event(i, "created", 2, "USDT") for i in range(5)]
        _setup_lot_events_exec(mock_session, events)

        response = client.get(
            "/pnl/versions/1/lot-events?related_asset_id=2&page=1&limit=3"
        )
        assert response.status_code == 200
        data = response.json()
        assert data["page"] == 1
        assert data["limit"] == 3
