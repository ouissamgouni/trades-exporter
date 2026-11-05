"""
Integration tests for Polymarket connector (live public Data API v2 + CLOB markets).

Requires a proxy wallet with activity (no credentials needed):
    POLYMARKET_TEST_WALLET=0x...   (Polygon child also needs ANKR_API_KEY)

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

WALLET = os.environ.get("POLYMARKET_TEST_WALLET", "")
MAX_RESULTS = 10

pytestmark = [
    pytest.mark.integration,
    pytest.mark.timeout(120),
    pytest.mark.skipif(
        not WALLET,
        reason="POLYMARKET_TEST_WALLET not set — skipping live Polymarket tests",
    ),
]


class TestPolymarketDataAPI:
    """Integration tests hitting the real Data API + market APIs."""

    def test_fetch_activity(self):
        """Test fetching real trades and redemptions from Data API v2 /activity."""
        connector = ConnectorPolymarket(
            wallet_address=WALLET,
            account_id=1,
            connector_id=1,
        )
        activity = connector._fetch_activity()
        trades = [a for a in activity if a["type"] == "TRADE"]
        assert len(trades) > 0, "Should have at least one trade"
        log.info(f"Fetched {len(activity)} activities ({len(trades)} trades)")

        # Verify raw trade structure
        trade = trades[0]
        assert trade["type"] == "TRADE"
        assert trade["side"] in ("BUY", "SELL")
        assert trade["size"] > 0
        assert trade["price"] > 0
        assert trade["conditionId"], "Should have a conditionId"
        assert trade["transactionHash"], "Should have a transaction hash"
        assert isinstance(trade["timestamp"], int)
        assert trade["slug"] and trade["outcome"], "Data API rows carry slug/outcome"

    def test_market_metadata_fetch(self):
        """Test fetching market metadata from CLOB /markets/{cid} for real conditionIds."""
        connector = ConnectorPolymarket(
            wallet_address=WALLET,
            account_id=1,
            connector_id=1,
        )
        # First get real conditionIds from the Data API
        trades = connector._fetch_activity()
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
    """Integration tests for the Polymarket Hub (Data API + Polygon transfers)."""

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


class TestPolymarketPolygonLive:
    """External USDC deposits/withdrawals via Ankr (Polymarket-internal transfers excluded)."""

    pytestmark = pytest.mark.skipif(not os.environ.get("ANKR_API_KEY"), reason="ANKR_API_KEY not set")

    def test_polygon_child_yields_only_external_usdc(self):
        from backend.connectors.onchain.connector_polymarket_polygon import (
            POLYMARKET_CONTRACTS,
            ConnectorPolymarketPolygon,
        )

        connector = ConnectorPolymarketPolygon(
            wallet_address=WALLET, account_id=1, connector_id=1,
            config={"test_mode": False, "disable_file_output": True},
        )
        raws = list(connector.yield_raws())
        for raw in raws:
            assert raw["fromAddress"].lower() not in POLYMARKET_CONTRACTS
            assert raw["toAddress"].lower() not in POLYMARKET_CONTRACTS
            nt = connector.raw_to_normalized(raw)
            assert nt.source == "polymarket_polygon"
            assert nt.source_transaction_type in ("deposit", "withdrawal")
