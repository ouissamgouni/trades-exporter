"""
Tests for transaction filter validation and response metadata.

These tests verify that the GET /transactions endpoint:
1. Returns wrapped responses with metadata structure
2. Validates filter parameters and returns warnings
3. Echoes applied filters back to the client
4. Provides accurate transaction counts
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
    # session.exec() is called for the transactions query and count
    # Return empty results so the endpoint can respond with 200
    mock_result = MagicMock()
    mock_result.all.return_value = []
    mock_result.one.return_value = 0
    mock_result.first.return_value = None
    session.exec.return_value = mock_result

    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_session_dependency] = lambda: session
    with patch("backend.api.main.init_db"), \
         patch("backend.api.main.get_database_url", return_value="postgresql://test@localhost/test"):
        yield TestClient(app)
    app.dependency_overrides.clear()


# ============================================================================
# Response Structure Tests
# ============================================================================


def test_transactions_response_has_metadata_wrapper(client):
    """Test that /transactions endpoint returns wrapped response with metadata."""
    response = client.get("/transactions")

    assert response.status_code == 200
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

    assert response.status_code == 200
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

    assert response.status_code == 200
    data = response.json()
    applied = data["metadata"]["applied_filters"]

    # Valid filters should be echoed (field is review_statuses, a list)
    assert "pending" in applied.get("review_statuses", [])


# ============================================================================
# Validation Warning Tests
# ============================================================================


def test_invalid_enum_generates_warning(client):
    """Test that invalid enum values generate validation warnings."""
    response = client.get("/transactions?review_status=INVALID_STATUS")

    assert response.status_code == 200
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

    assert response.status_code == 200
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

    assert response.status_code == 200
    data = response.json()
    applied = data["metadata"]["applied_filters"]
    assert "networks" in applied
    assert set(applied["networks"]) == {"ethereum", "solana"}


def test_filter_options_include_networks(client):
    """Test that /transactions/filter-options includes a networks list."""
    response = client.get("/transactions/filter-options")

    assert response.status_code == 200
    data = response.json()
    assert "networks" in data
    assert isinstance(data["networks"], list)


# ============================================================================
# Backward Compatibility Tests
# ============================================================================


def test_results_is_list(client):
    """Test that 'results' field is always a list."""
    response = client.get("/transactions")

    assert response.status_code == 200
    data = response.json()
    assert isinstance(data["results"], list)


# ============================================================================
# Connector Run Outcome Tests
# ============================================================================


def test_connector_run_outcome_all_unions_run_ids():
    from sqlmodel import select
    from backend.api.routes.transactions import TxListQuery, apply_tx_list_filters
    from backend.db.models import NormalizedTransaction, SyncJobConnectorRun

    session = MagicMock()
    session.get.return_value = SyncJobConnectorRun(
        id=7,
        job_id=1,
        connector_id=1,
        synced_ids=["a", "b"],
        updated_ids=["b", "c"],
        skipped_ids=["d"],
    )
    q = TxListQuery(connector_run_id="7", connector_run_outcome="all")

    statement, _, _ = apply_tx_list_filters(session, select(NormalizedTransaction), q)

    params = statement.compile().params
    in_values = next(v for v in params.values() if isinstance(v, list))
    assert in_values == ["a", "b", "c", "d"]


def test_connector_run_detail_reports_invalid_count():
    from fastapi import FastAPI
    from backend.api.routes.sync_job import router
    from backend.db.models import SyncJobConnectorRun

    run = SyncJobConnectorRun(
        id=7,
        job_id=1,
        connector_id=1,
        status="completed",
        synced_ids=["a"],
        updated_ids=["b"],
        skipped_ids=["a"],
    )
    session = MagicMock()
    session.exec.return_value.one.return_value = 2
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_session_dependency] = lambda: session

    with patch(
        "backend.db.repositories.sync_job_repository.SyncJobRepository.get_connector_run",
        return_value=run,
    ), patch("backend.api.routes.sync_job.get_sync_job_service", return_value=None):
        response = TestClient(app).get("/sync-job/connector-runs/7")

    assert response.status_code == 200
    assert response.json()["invalid_count"] == 2
