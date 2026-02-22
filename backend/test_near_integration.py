"""
Integration test for NEAR Protocol connector (NearBlocks API).
Tests real API calls with a live NEAR address.

Requires NEARBLOCKS_API_KEY environment variable to be set.
"""

import os
import pytest

from backend.connectors.onchain.near.connector_near_txns import ConnectorNearTxns
from backend.connectors.onchain.near.connector_near_hub import ConnectorNearHub


WALLET = "c12744ecf665963725e4a23ee5f6655d23e92db740826a7cd2e22266d2dee88f"


@pytest.mark.skipif(
    not os.getenv("NEARBLOCKS_API_KEY"),
    reason="NEARBLOCKS_API_KEY environment variable not set",
)
class TestNearIntegration:
    """Integration tests using real NearBlocks API."""

    @pytest.fixture
    def connector(self):
        return ConnectorNearTxns(
            wallet_address=WALLET,
            account_id=1,
            connector_id=1,
            config={"test_mode": False},
        )

    def test_real_api_fetch_and_normalize(self, connector):
        """Fetch real native transactions and verify normalization."""
        transactions = list(connector.yield_raws())
        assert len(transactions) >= 1

        tx = transactions[0]
        assert "transaction_hash" in tx
        assert "signer_account_id" in tx
        assert "block_timestamp" in tx

        normalized = list(connector.raw_to_normalized(tx))
        for norm in normalized:
            assert norm.source == "near_txns"
            assert norm.network == "near"
            assert norm.direction in ("inflow", "outflow", "neutral")
            assert norm.date_time is not None

    def test_hub_end_to_end(self):
        """Hub connector produces normalized results from real API."""
        hub = ConnectorNearHub(
            wallet_address=WALLET,
            account_id=1,
            connector_id=1,
            config={"test_mode": False},
        )

        results = list(hub.yield_normalized())
        assert len(results) >= 1

        for raw, normalized, error in results:
            if error:
                pytest.fail(f"Normalization error: {error}")
            assert normalized.network == "near"
