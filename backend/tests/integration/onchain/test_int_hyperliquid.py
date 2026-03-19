"""
Integration tests for Hyperliquid connectors (live API).
Moved from tests/unit/connectors/test_hyperliquid.py.
"""

import pytest
from backend.connectors.cex.connector_hyperliquid_perps import HyperliquidPerpsConnector
from backend.db.models import NormalizedTransaction

WALLET = "0xaecc12ea31b1e0d70b046f19e74c2a95524eb8be"


@pytest.mark.integration
@pytest.mark.timeout(30)
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
        """Test fetching balance from Hyperliquid."""
        connector = HyperliquidPerpsConnector(
            account_id=1,
            config={"_account_address_or_identifier": WALLET},
        )
        balance = connector.get_balance()
        assert len(balance) >= 1
        usdc = next((b for b in balance if b.asset_symbol == "USDC"), None)
        assert usdc is not None
        assert usdc.total > 0
