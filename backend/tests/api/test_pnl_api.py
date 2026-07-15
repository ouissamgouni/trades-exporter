"""
Tests for P&L API endpoints.

Tests cover:
- Draft commit and deletion
"""

import pytest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock


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
    """Create mock database session and override dependency."""
    from backend.db.database import get_session_dependency
    from backend.api.main import app
    
    session = MagicMock()
    
    app.dependency_overrides[get_session_dependency] = lambda: session
    yield session
    app.dependency_overrides.clear()


@pytest.fixture
def mock_version():
    """Create mock CalculationVersion."""
    version = MagicMock()
    version.version_id = 123
    version.status = "draft"
    version.expires_at = datetime.now(timezone.utc) + timedelta(hours=24)
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
