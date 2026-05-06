"""
Integration tests for Polymarket connector (live CLOB + Gamma APIs).

Requires CLOB credentials in environment:
    POLYMARKET_CLOB_API_KEY, POLYMARKET_CLOB_SECRET, POLYMARKET_CLOB_PASSPHRASE

Run:
    .venv/bin/python -m pytest tests/integration/onchain/test_int_polymarket.py -v
"""

import os
import pytest
import logging

from backend.connectors.onchain.connector_polymarket import ConnectorPolymarket
from backend.connectors.onchain.connector_polymarket_hub import ConnectorPolymarketHub
from backend.db.models import NormalizedTransaction

log = logging.getLogger(__name__)

WALLET = "0x6f5E6579Cd9F9eaB734674e33dE4f41A33ae27DE"
MAX_RESULTS = 10

# Skip entire module if CLOB credentials are not set
pytestmark = [
    pytest.mark.integration,
    pytest.mark.timeout(120),
    pytest.mark.skipif(
        not os.environ.get("POLYMARKET_CLOB_API_KEY"),
        reason="POLYMARKET_CLOB_API_KEY not set — skipping live Polymarket tests",
    ),
]


class TestPolymarketClobAPI:
    """Integration tests hitting the real CLOB + market APIs."""

    def test_fetch_clob_trades(self):
        """Test fetching real trades from CLOB /data/trades."""
        connector = ConnectorPolymarket(
            wallet_address=WALLET,
            account_id=1,
            connector_id=1,
        )
        trades = connector._fetch_clob_trades()
        assert len(trades) > 0, "Should have at least one trade"
        log.info(f"Fetched {len(trades)} CLOB trades")

        # Verify raw trade structure
        trade = trades[0]
        assert trade["type"] == "TRADE"
        assert trade["side"] in ("BUY", "SELL")
        assert trade["size"] > 0
        assert trade["price"] > 0
        assert trade["conditionId"], "Should have a conditionId"
        assert trade["transactionHash"], "Should have a transaction hash"
        assert isinstance(trade["timestamp"], int), "match_time should be parsed to int"

    def test_market_metadata_fetch(self):
        """Test fetching market metadata from CLOB /markets/{cid} for real conditionIds."""
        connector = ConnectorPolymarket(
            wallet_address=WALLET,
            account_id=1,
            connector_id=1,
        )
        # First get real conditionIds from CLOB
        trades = connector._fetch_clob_trades()
        condition_ids = {t["conditionId"] for t in trades if t.get("conditionId")}
        assert len(condition_ids) > 0

        # Fetch market data
        connector._fetch_gamma_markets(condition_ids)
        assert len(connector._gamma_cache) > 0, "Should have cached market data"
        log.info(f"Market cache: {len(connector._gamma_cache)} markets")

        # Verify market structure
        market = next(iter(connector._gamma_cache.values()))
        assert "slug" in market
        assert "outcomes" in market
        assert "outcomePrices" in market
        assert "question" in market

        # Verify token mapping was built
        assert len(connector._token_outcome_map) > 0, "Should have token→outcome mappings"

    def test_yield_raws_live(self):
        """Test full yield_raws pipeline with real data."""
        connector = ConnectorPolymarket(
            wallet_address=WALLET,
            account_id=1,
            connector_id=1,
        )

        raws = []
        for item in connector.yield_raws():
            raws.append(item)
            if len(raws) >= MAX_RESULTS:
                break

        assert len(raws) > 0, "Should yield raw items"
        log.info(f"yield_raws produced {len(raws)} items")

        # Check enrichment from CLOB market metadata
        trades = [r for r in raws if r.get("type") == "TRADE"]
        if trades:
            trade = trades[0]
            assert trade.get("slug"), "Trade should be enriched with slug from market data"
            assert trade.get("outcome"), "Trade should be enriched with outcome from market data"
            assert trade.get("timestamp"), "Trade should have a parsed timestamp"

    def test_normalize_live_trade(self):
        """Test normalization of a real trade into NormalizedTransaction."""
        connector = ConnectorPolymarket(
            wallet_address=WALLET,
            account_id=1,
            connector_id=1,
        )

        for raw_item, normalized_item, error in connector.yield_normalized():
            if normalized_item:
                assert isinstance(normalized_item, NormalizedTransaction)
                assert normalized_item.source == "polymarket"
                assert normalized_item.network is not None
                assert normalized_item.source_asset_symbol.startswith("PM:")
                log.info(
                    f"Normalized: {normalized_item.transaction_type} "
                    f"{normalized_item.quantity} {normalized_item.source_asset_symbol}"
                )
                break
        else:
            pytest.fail("Should produce at least one normalized item")


class TestPolymarketHubLive:
    """Integration tests for the Polymarket Hub (CLOB + Polygon transfers)."""

    def test_hub_yield_raws(self):
        """Test hub aggregates child connectors with real data."""
        hub = ConnectorPolymarketHub(
            wallet_address=WALLET,
            account_id=1,
            connector_id=1,
        )

        items = []
        for item in hub.yield_raws():
            items.append(item)
            if len(items) >= MAX_RESULTS:
                break

        assert len(items) > 0, "Hub should yield items from at least one child"
        sources = {i.get("connector_name") or i.get("_master_source") for i in items}
        log.info(f"Hub yielded {len(items)} items from sources: {sources}")
