"""
Unit tests for spinoff bundle creation via POST /bundles.

Tests cover:
- Creating a spinoff bundle with valid metadata (source asset + allocation %)
- Creating a spinoff bundle without allocation % (auto-compute)
- Spinoff metadata is stored in bundle_data
- Validation: missing transaction → 404
- Validation: transaction already in another bundle → 400
- Non-spinoff bundle creation still works (regression guard)
"""

import pytest
from datetime import datetime, timezone
from unittest.mock import MagicMock

from backend.db.models import (
    NormalizedTransaction,
    UserCalculationBundle,
    UnitPattern,
    TaxabilityStatus,
    Direction,
    Asset,
    Account,
)
from backend.db.database import get_db


# ============================================================================
# Helpers
# ============================================================================

def _make_asset(asset_id, symbol, label=None):
    a = MagicMock(spec=Asset)
    a.asset_id = asset_id
    a.symbol = symbol
    a.label = label
    return a


def _make_account(account_id, name):
    acc = MagicMock(spec=Account)
    acc.id = account_id
    acc.name = name
    return acc


def _make_tx(tx_id, asset_symbol="GEV", direction=Direction.INFLOW, bundle_id=None):
    tx = MagicMock(spec=NormalizedTransaction)
    tx.id = tx_id
    tx.source_asset_symbol = asset_symbol
    tx.direction = direction.value if hasattr(direction, 'value') else direction
    tx.user_calculation_unit_id = bundle_id
    tx.account_id = 1
    tx.from_account_id = None
    tx.to_account_id = None
    tx.asset_id = tx_id * 10
    tx.linked_asset_id = tx_id * 10
    tx.quantity = 10.0
    tx.price = 50.0
    tx.total = 500.0
    tx.fee = 0.0
    tx.fee_quote_asset_id = None
    tx.price_quote_asset_id = None
    tx.date_time = datetime(2024, 7, 3, tzinfo=timezone.utc)
    tx.source = "manual"
    tx.transaction_type = "trade"
    tx.source_transaction_type = "trade"
    tx.source_transaction_id = f"tx-{tx_id}"
    tx.source_from_account = None
    tx.source_to_account = None
    tx.network = None
    tx.network_transaction_id = None
    return tx


def _setup_session(mock_session, tx_map):
    """Wire up mock_session.get / add / flush / exec for bundle creation."""
    asset_map = {}
    account_map = {1: _make_account(1, "TestAccount")}

    for tx in tx_map.values():
        aid = tx.asset_id
        if aid and aid not in asset_map:
            asset_map[aid] = _make_asset(aid, tx.source_asset_symbol)

    def mock_get(model, pk):
        if model == NormalizedTransaction:
            return tx_map.get(pk)
        if model == Asset:
            return asset_map.get(pk)
        if model == Account:
            return account_map.get(pk)
        return None

    mock_session.get.side_effect = mock_get
    mock_session.flush.side_effect = lambda: None
    mock_session.refresh.side_effect = lambda obj: None

    created_bundles = []
    _next_id = [42]

    def mock_add(obj):
        if isinstance(obj, UserCalculationBundle) and obj.id is None:
            obj.id = _next_id[0]
            _next_id[0] += 1
            created_bundles.append(obj)

    mock_session.add.side_effect = mock_add

    def mock_exec(query):
        result = MagicMock()
        result.all.return_value = list(tx_map.values())
        return result

    mock_session.exec.side_effect = mock_exec
    return created_bundles


# ============================================================================
# Fixtures
# ============================================================================

@pytest.fixture
def mock_session():
    from backend.api.main import app
    session = MagicMock()
    app.dependency_overrides[get_db] = lambda: session
    yield session
    app.dependency_overrides.clear()


@pytest.fixture
def client(mock_session):
    from fastapi.testclient import TestClient
    from backend.api.main import app
    return TestClient(app)


# ============================================================================
# Spinoff bundle creation — happy paths
# ============================================================================


class TestSpinoffBundleCreation:
    """Tests for POST /bundles with pattern=spinoff."""

    def test_create_spinoff_bundle_with_allocation(self, client, mock_session):
        """Create spinoff bundle with source asset and explicit allocation %."""
        tx1 = _make_tx(1, "APTV", Direction.OUTFLOW)
        tx2 = _make_tx(2, "VRSG", Direction.INFLOW)
        _setup_session(mock_session, {1: tx1, 2: tx2})

        resp = client.post("/bundles", json={
            "transaction_ids": [1, 2],
            "label": "APTV \u2192 VRSG Spin-off 2024-07-03",
            "pattern": "spinoff",
            "taxability_override": "non_taxable",
            "metadata": {
                "spinoff_source_asset_id": 100,
                "spinoff_allocation_pct": 0.15,
            },
        })

        assert resp.status_code == 200
        data = resp.json()
        assert data["pattern"] == "spinoff"
        assert data["label"] == "APTV \u2192 VRSG Spin-off 2024-07-03"
        assert data["taxability_override"] == "non_taxable"
        assert data["metadata"]["spinoff_source_asset_id"] == 100
        assert data["metadata"]["spinoff_allocation_pct"] == 0.15

    def test_create_spinoff_bundle_without_allocation(self, client, mock_session):
        """Create spinoff bundle without allocation % (will auto-compute from FMV)."""
        tx1 = _make_tx(1, "GE", Direction.OUTFLOW)
        tx2 = _make_tx(2, "GEV", Direction.INFLOW)
        _setup_session(mock_session, {1: tx1, 2: tx2})

        resp = client.post("/bundles", json={
            "transaction_ids": [1, 2],
            "label": "GE \u2192 GEV Spin-off",
            "pattern": "spinoff",
            "metadata": {
                "spinoff_source_asset_id": 200,
            },
        })

        assert resp.status_code == 200
        data = resp.json()
        assert data["pattern"] == "spinoff"
        assert data["metadata"]["spinoff_source_asset_id"] == 200
        assert "spinoff_allocation_pct" not in data["metadata"]

    def test_spinoff_metadata_stored_in_bundle_data(self, client, mock_session):
        """Spinoff metadata should be persisted in bundle_data column."""
        tx1 = _make_tx(1, "APTV", Direction.OUTFLOW)
        created = _setup_session(mock_session, {1: tx1})

        resp = client.post("/bundles", json={
            "transaction_ids": [1],
            "pattern": "spinoff",
            "metadata": {
                "spinoff_source_asset_id": 300,
                "spinoff_allocation_pct": 0.25,
            },
        })

        assert resp.status_code == 200
        assert len(created) == 1
        bundle = created[0]
        assert bundle.bundle_data == {
            "spinoff_source_asset_id": 300,
            "spinoff_allocation_pct": 0.25,
        }
        assert bundle.pattern == UnitPattern.SPINOFF


# ============================================================================
# Error paths
# ============================================================================


class TestBundleCreationErrors:
    """Tests for bundle creation error handling."""

    def test_missing_transaction_returns_404(self, client, mock_session):
        """Unknown transaction ID should return 404."""
        mock_session.get.return_value = None

        resp = client.post("/bundles", json={
            "transaction_ids": [999],
            "pattern": "spinoff",
        })

        assert resp.status_code == 404
        assert "999" in resp.json()["detail"]

    def test_transaction_already_bundled_returns_400(self, client, mock_session):
        """Transaction already in another bundle should return 400."""
        tx = _make_tx(1, "APTV")
        tx.user_calculation_unit_id = 99  # already in bundle #99
        mock_session.get.return_value = tx

        resp = client.post("/bundles", json={
            "transaction_ids": [1],
            "pattern": "spinoff",
            "metadata": {"spinoff_source_asset_id": 100},
        })

        assert resp.status_code == 400
        assert "already in bundle" in resp.json()["detail"]


# ============================================================================
# Non-spinoff regression guard
# ============================================================================


class TestNonSpinoffBundleCreation:
    """Ensure non-spinoff patterns still work (regression guard)."""

    def test_create_swap_bundle(self, client, mock_session):
        """Creating a swap bundle should work without metadata."""
        tx1 = _make_tx(1, "BTC", Direction.OUTFLOW)
        tx2 = _make_tx(2, "ETH", Direction.INFLOW)
        _setup_session(mock_session, {1: tx1, 2: tx2})

        resp = client.post("/bundles", json={
            "transaction_ids": [1, 2],
            "label": "BTC \u2192 ETH Swap",
            "pattern": "swap",
        })

        assert resp.status_code == 200
        data = resp.json()
        assert data["pattern"] == "swap"
        assert data["metadata"] is None

    def test_create_internal_transfer_bundle(self, client, mock_session):
        """Creating an internal transfer bundle should work."""
        tx1 = _make_tx(1, "USDC", Direction.OUTFLOW)
        tx2 = _make_tx(2, "USDC", Direction.INFLOW)
        _setup_session(mock_session, {1: tx1, 2: tx2})

        resp = client.post("/bundles", json={
            "transaction_ids": [1, 2],
            "label": "USDC Transfer",
            "pattern": "internal_transfer",
            "taxability_override": "non_taxable",
        })

        assert resp.status_code == 200
        data = resp.json()
        assert data["pattern"] == "internal_transfer"
        assert data["taxability_override"] == "non_taxable"
