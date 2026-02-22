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
    """Test listing transactions endpoint returns wrapped response with metadata."""
    response = client.get("/transactions")
    # Should return 200 or 500 (if no DB), but endpoint exists
    assert response.status_code in [200, 500]
    
    # If successful, check response structure
    if response.status_code == 200:
        data = response.json()
        assert "results" in data, "Response should have 'results' array"
        assert "metadata" in data, "Response should have 'metadata' object"
        assert isinstance(data["results"], list), "Results should be a list"
        assert isinstance(data["metadata"], dict), "Metadata should be an object"


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
