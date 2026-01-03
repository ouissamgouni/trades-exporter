"""
Tests for P&L API endpoints.

Tests cover:
- Draft calculation and persistence
- Version query endpoints (lots, realized, units, warnings)
- Draft commit and deletion
- Expired draft cleanup
"""

import pytest
from datetime import datetime, timedelta
from decimal import Decimal
from unittest.mock import patch, MagicMock


# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture
def client():
    """Create test client."""
    from fastapi.testclient import TestClient
    from backend.api.main import app

    return TestClient(app)


@pytest.fixture
def mock_session():
    """Create mock database session."""
    with patch("backend.api.routes.pnl.get_session_dependency") as mock:
        session = MagicMock()
        mock.return_value = session
        yield session


@pytest.fixture
def mock_version():
    """Create mock CalculationVersion."""
    version = MagicMock()
    version.version_id = 123
    version.status = "draft"
    version.expires_at = datetime.utcnow() + timedelta(hours=24)
    return version


@pytest.fixture
def mock_asset():
    """Create mock Asset."""
    asset = MagicMock()
    asset.asset_id = 1
    asset.symbol = "USD"
    asset.type = "FIAT"
    return asset


# ============================================================================
# Commit Version
# ============================================================================


class TestCommitVersion:
    """Tests for POST /pnl/versions/{version_id}/commit endpoint."""

    def test_commit_success(self, client, mock_session, mock_version):
        """Test successful commit."""
        mock_version.status = "draft"
        mock_session.get.return_value = mock_version
        
        response = client.post("/pnl/versions/123/commit")
        assert response.status_code == 200
        data = response.json()
        assert data["version_id"] == 123
        assert mock_version.status == "committed"
        assert mock_version.expires_at is None


class TestDeleteVersion:
    """Tests for DELETE /pnl/versions/{version_id} endpoint."""

    def test_delete_version_not_found(self, client, mock_session):
        """Test 404 when version not found."""
        mock_session.get.return_value = None
        
        response = client.delete("/pnl/versions/999")
        assert response.status_code == 404

    def test_delete_committed_fails(self, client, mock_session, mock_version):
        """Test cannot delete committed version."""
        mock_version.status = "committed"
        mock_session.get.return_value = mock_version
        
        response = client.delete("/pnl/versions/123")
        assert response.status_code == 400
        assert "cannot delete" in response.json()["detail"].lower()

    def test_delete_success(self, client, mock_session, mock_version):
        """Test successful deletion."""
        mock_version.status = "draft"
        mock_session.get.return_value = mock_version
        mock_session.exec.return_value.all.return_value = []  # No related records
        
        response = client.delete("/pnl/versions/123")
        assert response.status_code == 200
        mock_session.delete.assert_called()


# ============================================================================
# Expired Draft Cleanup
# ============================================================================


class TestCleanupExpiredDrafts:
    """Tests for POST /pnl/cleanup/expired-drafts endpoint."""

    def test_cleanup_no_expired(self, client, mock_session):
        """Test cleanup when no expired drafts."""
        mock_session.exec.return_value.all.return_value = []
        
        response = client.post("/pnl/cleanup/expired-drafts")
        assert response.status_code == 200
        data = response.json()
        assert data["deleted_count"] == 0

    def test_cleanup_deletes_expired(self, client, mock_session):
        """Test cleanup deletes expired drafts."""
        expired_version = MagicMock()
        expired_version.version_id = 100
        expired_version.status = "draft"
        expired_version.expires_at = datetime.utcnow() - timedelta(hours=1)
        
        # First call returns expired versions, subsequent calls return empty lists
        mock_session.exec.return_value.all.side_effect = [
            [expired_version],  # Expired versions
            [],  # Warnings
            [],  # Units
            [],  # PnL
            [],  # Slices
            [],  # Lots
        ]
        
        response = client.post("/pnl/cleanup/expired-drafts")
        assert response.status_code == 200
        data = response.json()
        assert data["deleted_count"] == 1


# ============================================================================
# Preview Endpoint (Legacy)
# ============================================================================


class TestCalculatePreview:
    """Tests for POST /pnl/calculate/preview endpoint (legacy)."""

    def test_preview_requires_base_currency(self, client, mock_session):
        """Test that preview calculation requires base currency."""
        response = client.post(
            "/pnl/calculate/preview",
            json={
                "lot_method": "FIFO",
                "lot_mode": "LOT_TRAVEL",
            },
        )
        assert response.status_code == 400
        assert "base_currency" in response.json()["detail"].lower()

    @patch("backend.api.routes.pnl.PnLEngine")
    @patch("backend.api.routes.pnl.PriceService")
    def test_preview_returns_full_response(
        self, mock_price_service_cls, mock_engine_cls, client, mock_session, mock_asset
    ):
        """Test successful preview returns full P&L response."""
        mock_session.get.return_value = mock_asset
        
        mock_result = MagicMock()
        mock_result.total_realized_pnl = Decimal("1000.00")
        mock_result.units_processed = 10
        mock_result.transactions_processed = 20
        mock_result.created_lots = []
        mock_result.consumed_slices = []
        mock_result.warnings = []
        mock_result.realized_pnl_entries = []
        mock_result.processed_units = []
        
        mock_engine = MagicMock()
        mock_engine.calculate.return_value = mock_result
        mock_engine.get_all_lots.return_value = []
        mock_engine.collect_asset_ids.return_value = set()
        mock_engine.build_asset_map.return_value = {}
        mock_engine_cls.return_value = mock_engine
        
        response = client.post(
            "/pnl/calculate/preview",
            json={
                "lot_method": "FIFO",
                "lot_mode": "LOT_TRAVEL",
                "base_currency_id": 1,
            },
        )
        
        assert response.status_code == 200
        data = response.json()
        assert "total_realized_pnl" in data
        assert "realized_pnl" in data
        assert "cost_lots" in data
        assert "warnings" in data
        assert "calculation_units" in data
