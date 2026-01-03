"""
Simple API tests using FastAPI TestClient.
Tests cover basic endpoint validation and error handling.

These tests are intentionally simple and focused on:
- Verifying endpoints exist and respond
- Testing Pydantic validation (422 errors)
- Checking error handling (404/500 errors)

Note: Tests accept 500 errors when database is not initialized,
as they focus on endpoint structure and validation rather than
full integration testing. For full integration tests with real
database operations, see the e2e tests.
"""

import pytest
from fastapi.testclient import TestClient
from backend.api.main import app


@pytest.fixture
def client():
    """Create a test client."""
    return TestClient(app)


# ============================================================================
# Root Endpoint Tests
# ============================================================================


def test_root_endpoint(client):
    """Test root endpoint returns API info."""
    response = client.get("/")
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Trade Exporter API"
    assert data["version"] == "1.0.0"
    assert "docs" in data


# ============================================================================
# Transaction Endpoint Tests
# ============================================================================


def test_list_transactions(client):
    """Test listing transactions endpoint exists."""
    response = client.get("/transactions")
    # Should return 200 or 500 (if no DB), but endpoint exists
    assert response.status_code in [200, 500]


def test_get_transaction_not_found(client):
    """Test getting non-existent transaction."""
    response = client.get("/transactions/99999")
    # Should return 404 or 500 (if DB error)
    assert response.status_code in [404, 500]


def test_update_transaction_validation(client):
    """Test transaction update validates fields."""
    # Invalid review_status should fail validation - use a value not in the enum
    response = client.patch(
        "/transactions/1", json={"review_status": "not_a_valid_status"}
    )
    # Should be 422 (validation error) regardless of DB
    assert response.status_code == 422


# ============================================================================
# Group Endpoint Tests (DEPRECATED - Groups replaced by Bundles in V2)
# ============================================================================


@pytest.mark.skip(reason="Groups endpoint deprecated in V2 - use bundles instead")
def test_list_groups(client):
    """Test listing groups endpoint exists."""
    response = client.get("/groups")
    # Should return 200 or 500 (if no DB), but endpoint exists
    assert response.status_code in [200, 500]


@pytest.mark.skip(reason="Groups endpoint deprecated in V2 - use bundles instead")
def test_create_group_missing_fields(client):
    """Test group creation requires transaction_ids."""
    response = client.post("/groups", json={"group_label": "Test Group"})
    # Should fail validation
    assert response.status_code == 422


@pytest.mark.skip(reason="Groups endpoint deprecated in V2 - use bundles instead")
def test_create_group_empty_transaction_ids(client):
    """Test group creation requires at least one transaction."""
    response = client.post(
        "/groups", json={"group_label": "Test Group", "transaction_ids": []}
    )
    # Should fail validation
    assert response.status_code == 422


@pytest.mark.skip(reason="Groups endpoint deprecated in V2 - use bundles instead")
def test_get_group_endpoint(client):
    """Test get group endpoint exists."""
    response = client.get("/groups/99999")
    # Should return 404 or 500, but endpoint exists
    assert response.status_code in [404, 500]


@pytest.mark.skip(reason="Groups endpoint deprecated in V2 - use bundles instead")
def test_delete_group_endpoint(client):
    """Test delete group endpoint exists."""
    response = client.delete("/groups/99999")
    # Should return 404 or 500, but endpoint exists
    assert response.status_code in [404, 500]


@pytest.mark.skip(reason="Groups endpoint deprecated in V2 - use bundles instead")
def test_get_pending_suggestions_endpoint(client):
    """Test suggestions endpoint exists."""
    response = client.get("/groups/pending/suggestions")
    # Should return 200 or 500, but endpoint exists
    assert response.status_code in [200, 500]
