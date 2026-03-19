"""
Test bulk update operations using FastAPI TestClient.
Tests the full request → handler → session → commit → read-back cycle.
"""
import os
import sys

# Ensure test mode
os.environ["TEST_MODE"] = "1"

import pytest
from decimal import Decimal
from datetime import datetime, timezone
from fastapi.testclient import TestClient
from sqlmodel import Session

# Add parent to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.api.main import app
from backend.db.database import get_engine
from backend.db.models import NormalizedTransaction, ReviewStatus


pytestmark = pytest.mark.integration


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def test_transactions():
    """Create test transactions with 'pending' status and return their IDs."""
    engine = get_engine()
    ids = []
    with Session(engine) as session:
        for i in range(3):
            tx = NormalizedTransaction(
                source="test_bulk",
                source_asset_symbol="BTC",
                date_time=datetime.now(timezone.utc),
                direction="inflow",
                transaction_type="deposit",
                quantity=Decimal("1.0"),
                review_status="pending",
            )
            session.add(tx)
            session.flush()
            ids.append(tx.id)
        session.commit()
    yield ids
    # Cleanup
    with Session(engine) as session:
        for tx_id in ids:
            tx = session.get(NormalizedTransaction, tx_id)
            if tx:
                session.delete(tx)
        session.commit()


class TestBulkUpdateStatus:
    """Test that bulk status update persists correctly."""

    def test_bulk_update_review_status_persists(self, client, test_transactions):
        """The core bug: bulk status update should persist after re-read."""
        tx_ids = test_transactions

        # Verify initial status is 'pending'
        engine = get_engine()
        with Session(engine) as session:
            for tx_id in tx_ids:
                tx = session.get(NormalizedTransaction, tx_id)
                assert tx.review_status == "pending", f"Expected 'pending', got '{tx.review_status}'"

        # Call the bulk update endpoint
        response = client.post(
            "/transactions/bulk/update",
            json={
                "transaction_ids": tx_ids,
                "review_status": "valid",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["affected_count"] == len(tx_ids)

        # Read back in a NEW session — the critical check
        with Session(engine) as session:
            for tx_id in tx_ids:
                tx = session.get(NormalizedTransaction, tx_id)
                assert tx is not None, f"Transaction {tx_id} not found"
                assert tx.review_status == "valid", (
                    f"TX {tx_id}: expected 'valid', got '{tx.review_status}' "
                    f"(type={type(tx.review_status).__name__})"
                )

    def test_bulk_update_transaction_type_persists(self, client, test_transactions):
        """Bulk type update should also persist."""
        tx_ids = test_transactions

        response = client.post(
            "/transactions/bulk/update",
            json={
                "transaction_ids": tx_ids,
                "transaction_type": "trade",
            },
        )
        assert response.status_code == 200

        engine = get_engine()
        with Session(engine) as session:
            for tx_id in tx_ids:
                tx = session.get(NormalizedTransaction, tx_id)
                assert tx.transaction_type == "trade", (
                    f"TX {tx_id}: expected 'trade', got '{tx.transaction_type}'"
                )

    def test_bulk_delete_persists(self, client, test_transactions):
        """Bulk delete should actually remove transactions."""
        tx_ids = test_transactions

        response = client.post(
            "/transactions/bulk/delete",
            json={"transaction_ids": tx_ids},
        )
        assert response.status_code == 200

        engine = get_engine()
        with Session(engine) as session:
            for tx_id in tx_ids:
                tx = session.get(NormalizedTransaction, tx_id)
                assert tx is None, f"Transaction {tx_id} should be deleted but still exists"

    def test_single_patch_review_status_persists(self, client, test_transactions):
        """Verify single PATCH works for comparison."""
        tx_id = test_transactions[0]

        response = client.patch(
            f"/transactions/{tx_id}",
            json={"review_status": "valid"},
        )
        assert response.status_code == 200

        engine = get_engine()
        with Session(engine) as session:
            tx = session.get(NormalizedTransaction, tx_id)
            assert tx.review_status == "valid", (
                f"TX {tx_id}: expected 'valid', got '{tx.review_status}'"
            )


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
