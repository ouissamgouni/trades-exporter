"""
Simple API tests using FastAPI TestClient.
Tests cover basic endpoint validation and error handling.

These tests are intentionally simple and focused on:
- Verifying endpoints exist and respond
- Testing Pydantic validation (422 errors)
- Checking error handling (404/500 errors)
"""

import pytest
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient
from backend.api.main import app
from backend.db.database import get_db, get_session_dependency


@pytest.fixture
def client():
    """Create a test client with mocked DB session."""
    session = MagicMock()
    mock_result = MagicMock()
    mock_result.all.return_value = []
    mock_result.one.return_value = 0
    mock_result.first.return_value = None
    session.exec.return_value = mock_result
    session.get.return_value = None

    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_session_dependency] = lambda: session
    with (
        patch("backend.api.main.init_db"),
        patch(
            "backend.api.main.get_database_url",
            return_value="postgresql://test@localhost/test",
        ),
    ):
        yield TestClient(app)
    app.dependency_overrides.clear()


# ============================================================================
# Root Endpoint Tests
# ============================================================================


def test_root_endpoint(client):
    """Test root endpoint returns API info."""
    response = client.get("/")
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "TradeTrail API"
    assert data["version"] == "1.0.0"
    assert "docs" in data


# ============================================================================
# Transaction Endpoint Tests
# ============================================================================


def test_list_transactions(client):
    """Test listing transactions endpoint returns wrapped response with metadata."""
    response = client.get("/transactions")
    assert response.status_code == 200

    data = response.json()
    assert "results" in data, "Response should have 'results' array"
    assert "metadata" in data, "Response should have 'metadata' object"
    assert isinstance(data["results"], list), "Results should be a list"
    assert isinstance(data["metadata"], dict), "Metadata should be an object"


def test_get_transaction_not_found(client):
    """Test getting non-existent transaction."""
    response = client.get("/transactions/99999")
    assert response.status_code == 404


def test_transaction_groups_empty(client):
    response = client.get("/transactions/groups?granularity=day&tz=Europe/Paris")
    assert response.status_code == 200
    data = response.json()
    assert data["groups"] == []
    assert data["timezone"] == "Europe/Paris"


def test_transaction_groups_hide_invalid(client):
    response = client.get("/transactions/groups?hide_invalid=true")
    assert response.status_code == 200
    assert response.json()["excluded_invalid_count"] == 0


def test_transaction_groups_rejects_unknown_timezone(client):
    response = client.get("/transactions/groups?tz=Mars/Olympus")
    assert response.status_code == 400


def test_transaction_ids_endpoint(client):
    response = client.get("/transactions/ids?review_status=pending")
    assert response.status_code == 200
    assert response.json() == {"ids": [], "total": 0, "truncated": False}


def test_locate_transaction_not_found(client):
    response = client.get("/transactions/locate/99999?review_status=pending")
    assert response.status_code == 404


def test_pnl_transaction_groups_unknown_version(client):
    response = client.get("/pnl/versions/999/enriched-transactions/groups")
    assert response.status_code == 404


def test_get_asset_includes_contracts():
    from backend.db.models import Asset

    session = MagicMock()
    session.get.return_value = Asset(asset_id=7, symbol="USDC")
    categories, contracts = MagicMock(), MagicMock()
    categories.all.return_value = []
    contracts.all.return_value = [("base", "0x8335", 5), ("solana", "EPjF", 3)]
    session.exec.side_effect = [categories, contracts]
    app.dependency_overrides[get_db] = lambda: session
    try:
        with patch("backend.api.main.init_db"):
            response = TestClient(app).get("/assets/7")
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 200
    assert response.json()["contracts"] == [
        {"network": "base", "contract_address": "0x8335", "tx_count": 5},
        {"network": "solana", "contract_address": "EPjF", "tx_count": 3},
    ]


def test_update_transaction_validation(client):
    """Test transaction update validates fields."""
    # Invalid review_status should fail validation - use a value not in the enum
    response = client.patch(
        "/transactions/1", json={"review_status": "not_a_valid_status"}
    )
    # Should be 422 (validation error) regardless of DB
    assert response.status_code == 422
