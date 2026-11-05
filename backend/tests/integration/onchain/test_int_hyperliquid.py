"""
Integration tests for Hyperliquid connectors (live API).
Moved from tests/unit/connectors/test_hyperliquid.py.

Requires a Hyperliquid account with trading history in environment:
    HYPERLIQUID_TEST_WALLET=0x...  (address of an account with at least one perps fill)

Run:
    HYPERLIQUID_TEST_WALLET=0x... .venv/bin/python -m pytest tests/integration/onchain/test_int_hyperliquid.py -v
"""

import os
import pytest
from backend.connectors.cex.connector_hyperliquid_perps import HyperliquidPerpsConnector
from backend.db.models import NormalizedTransaction

WALLET = os.environ.get("HYPERLIQUID_TEST_WALLET")


@pytest.mark.integration
@pytest.mark.timeout(30)
@pytest.mark.skipif(
    not WALLET,
    reason="HYPERLIQUID_TEST_WALLET not set — skipping live Hyperliquid tests",
)
class TestHyperliquidLiveAPI:
    """Integration tests hitting the real Hyperliquid API."""

    def test_perps_fetch_fills(self):
        """Test fetching real fills from the API."""
        connector = HyperliquidPerpsConnector(
            account_id=1,
            config={"_account_address_or_identifier": WALLET},
        )
        fills = list(connector.yield_raws())
        assert len(fills) > 0
        tx = connector.raw_to_normalized(fills[0])
        assert isinstance(tx, NormalizedTransaction)
        assert tx.source == "hyperliquid-perps"

    def test_perps_balance(self):
        """Balance call succeeds and returns well-formed entries (an emptied account is valid)."""
        connector = HyperliquidPerpsConnector(
            account_id=1,
            config={"_account_address_or_identifier": WALLET},
        )
        balance = connector.get_balance()
        assert isinstance(balance, list)
        for entry in balance:
            assert entry.asset_symbol
            assert entry.total >= 0
