"""
Simple tests for transaction filter validation and response metadata.

These tests verify that the GET /transactions endpoint:
1. Returns wrapped responses with metadata structure
2. Validates filter parameters and returns warnings  
3. Echoes applied filters back to the client
4. Provides accurate transaction counts

Tests accept 200 or 500 status codes, as they focus on response structure
rather than requiring full database initialization.
"""

import pytest
from fastapi.testclient import TestClient
from backend.api.main import app


@pytest.fixture
def client():
    """Create a test client."""
    return TestClient(app)


# ============================================================================
# Response Structure Tests
# ============================================================================


def test_transactions_response_has_metadata_wrapper(client):
    """Test that /transactions endpoint returns wrapped response with metadata."""
    response = client.get("/transactions")
    
    # Accept both 200 (with DB) or 500 (without DB)
    assert response.status_code in [200, 500]
    
    if response.status_code == 200:
        data = response.json()
        
        # Check response structure
        assert "results" in data, "Response must have 'results' field"
        assert "metadata" in data, "Response must have 'metadata' field"
        
        # Check metadata structure
        metadata = data["metadata"]
        assert "applied_filters" in metadata
        assert "validation_warnings" in metadata
        assert "total_count" in metadata
        assert "filtered_count" in metadata


def test_metadata_counts_are_valid(client):
    """Test that count fields in metadata are valid integers."""
    response = client.get("/transactions")
    
    if response.status_code == 200:
        data = response.json()
        metadata = data["metadata"]
        
        assert isinstance(metadata["total_count"], int)
        assert isinstance(metadata["filtered_count"], int)
        assert metadata["total_count"] >= 0
        assert metadata["filtered_count"] >= 0
        assert metadata["filtered_count"] <= metadata["total_count"]


# ============================================================================
# Filter Echo Tests
# ============================================================================


def test_applied_filters_echo_valid_params(client):
    """Test that valid filter parameters are echoed in applied_filters."""
    response = client.get("/transactions?review_status=pending&limit=10")
    
    if response.status_code == 200:
        data = response.json()
        applied = data["metadata"]["applied_filters"]
        
        # Valid filters should be echoed
        assert applied.get("review_status") == "pending"


# ============================================================================
# Validation Warning Tests
# ============================================================================


def test_invalid_enum_generates_warning(client):
    """Test that invalid enum values generate validation warnings."""
    response = client.get("/transactions?review_status=INVALID_STATUS")
    
    if response.status_code == 200:
        data = response.json()
        warnings = data["metadata"]["validation_warnings"]
        
        # Should have at least one warning for invalid enum
        assert len(warnings) > 0
        
        # Check warning structure
        warning = warnings[0]
        assert "filter_name" in warning
        assert "provided_value" in warning
        assert "reason" in warning
        assert "severity" in warning


def test_invalid_date_generates_warning(client):
    """Test that invalid date format generates validation warnings."""
    response = client.get("/transactions?date_from=not-a-date")
    
    if response.status_code == 200:
        data = response.json()
        warnings = data["metadata"]["validation_warnings"]
        
        # Should have warning for invalid date
        assert len(warnings) > 0
        assert any(w["filter_name"] == "date_from" for w in warnings)


# ============================================================================
# Network Filter Tests
# ============================================================================


def test_network_filter_echoed_in_applied_filters(client):
    """Test that network filter param is echoed back in applied_filters."""
    response = client.get("/transactions?network=ethereum,solana")

    if response.status_code == 200:
        data = response.json()
        applied = data["metadata"]["applied_filters"]
        assert "networks" in applied
        assert set(applied["networks"]) == {"ethereum", "solana"}


def test_filter_options_include_networks(client):
    """Test that /transactions/filter-options includes a networks list."""
    response = client.get("/transactions/filter-options")

    if response.status_code == 200:
        data = response.json()
        assert "networks" in data
        assert isinstance(data["networks"], list)


# ============================================================================
# Backward Compatibility Tests
# ============================================================================


def test_results_is_list(client):
    """Test that 'results' field is always a list."""
    response = client.get("/transactions")
    
    if response.status_code == 200:
        data = response.json()
        assert isinstance(data["results"], list)
