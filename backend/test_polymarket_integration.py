"""
Integration test for Polymarket connector (Data API).
Tests both test mode (fixture) and live API calls.

Usage:
    # Test mode (no API calls):
    TEST_MODE=1 pytest test_polymarket_integration.py -v

    # Live mode (real API calls):
    pytest test_polymarket_integration.py -v
"""

import os
import pytest
from decimal import Decimal

from backend.connectors.onchain.connector_polymarket import ConnectorPolymarket


WALLET = "0x6f5E6579Cd9F9eaB734674e33dE4f41A33ae27DE"


class TestPolymarketTestMode:
    """Tests using fixture data (no API calls)."""

    @pytest.fixture
    def connector(self):
        return ConnectorPolymarket(
            wallet_address=WALLET,
            account_id=1,
            connector_id=1,
            config={"test_mode": True},
        )

    def test_yield_raws_from_fixture(self, connector):
        """Load raw activities from test fixture."""
        raws = list(connector._yield_raws())
        assert len(raws) == 10
        # 8 TRADE + 2 REDEEM
        trades = [r for r in raws if r["type"] == "TRADE"]
        redeems = [r for r in raws if r["type"] == "REDEEM"]
        assert len(trades) == 8
        assert len(redeems) == 2

    def test_normalize_trade_buy(self, connector):
        """BUY trade should be an outflow of USDC."""
        buy_item = {
            "proxyWallet": WALLET.lower(),
            "timestamp": 1762301363,
            "conditionId": "0xebddfcf7b4401dade8b4031770a1ab942b01854f3bed453d5df9425cd9f211a9",
            "type": "TRADE",
            "size": 625,
            "usdcSize": 25,
            "transactionHash": "0xd521fd67a30d11b4c2c582215611dba12143e2bb54a1403be49220214c4200d4",
            "price": 0.04,
            "asset": "105832362350788616148612362642992403996714020918558917275151746177525518770551",
            "side": "BUY",
            "outcomeIndex": 1,
            "title": "Will Zohran Mamdani win the 2025 NYC mayoral election?",
            "slug": "will-zohran-mamdani-win-the-2025-nyc-mayoral-election",
            "eventSlug": "new-york-city-mayoral-election",
            "outcome": "No",
        }

        normalized = connector.raw_to_normalized(buy_item)

        assert normalized.source == "polymarket"
        assert normalized.direction == "outflow"
        assert normalized.transaction_type == "transfer"
        assert normalized.source_transaction_type == "buy"
        assert normalized.source_asset_symbol == "USDC"
        assert normalized.quantity == 25.0
        assert normalized.network == "polygon"
        assert normalized.fee == 0
        assert normalized.include_fee is False
        assert normalized.tags[0]["polymarket_type"] == "TRADE"
        assert normalized.tags[0]["side"] == "BUY"
        assert normalized.tags[0]["market_title"] == "Will Zohran Mamdani win the 2025 NYC mayoral election?"
        assert normalized.tags[0]["outcome"] == "No"
        assert normalized.tags[0]["shares"] == 625.0
        assert normalized.tags[0]["price_per_share"] == 0.04
        assert normalized.date_time is not None

    def test_normalize_trade_sell(self, connector):
        """SELL trade should be an inflow of USDC."""
        sell_item = {
            "proxyWallet": WALLET.lower(),
            "timestamp": 1762301363,
            "conditionId": "0xabc123",
            "type": "TRADE",
            "size": 100,
            "usdcSize": 50,
            "transactionHash": "0xdef456",
            "price": 0.5,
            "asset": "12345",
            "side": "SELL",
            "outcomeIndex": 0,
            "title": "Test market",
            "slug": "test-market",
            "eventSlug": "test-event",
            "outcome": "Yes",
        }

        normalized = connector.raw_to_normalized(sell_item)

        assert normalized.direction == "inflow"
        assert normalized.transaction_type == "transfer"
        assert normalized.source_asset_symbol == "USDC"
        assert normalized.quantity == 50.0
        assert normalized.tags[0]["side"] == "SELL"

    def test_normalize_redeem(self, connector):
        """REDEEM should be an inflow of USDC (transfer type)."""
        redeem_item = {
            "proxyWallet": WALLET.lower(),
            "timestamp": 1772452383,
            "conditionId": "0x9c1cec6513c50887d5c4d38cb53dc27b34c87b93afe68e2db9be5db5167eadf0",
            "type": "REDEEM",
            "size": 58.823528,
            "usdcSize": 58.823528,
            "transactionHash": "0xb6c096f6cd1029d0a2235b4295866cd2163231bcede2b44d76a635906c6f1ff5",
            "price": 0,
            "asset": "",
            "side": "",
            "outcomeIndex": 999,
            "title": "Will Israel strike Gaza on November 8?",
            "slug": "will-israel-strike-gaza-on-november-8",
            "eventSlug": "will-israel-strike-gaza-on-379",
            "outcome": "",
        }

        normalized = connector.raw_to_normalized(redeem_item)

        assert normalized.direction == "inflow"
        assert normalized.transaction_type == "transfer"
        assert normalized.source_transaction_type == "redeem"
        assert normalized.source_asset_symbol == "USDC"
        assert normalized.quantity == 58.823528
        assert normalized.tags[0]["polymarket_type"] == "REDEEM"

    def test_source_transaction_id_uniqueness(self, connector):
        """Two redemptions in the same tx should have different source_transaction_ids."""
        item1 = {
            "type": "REDEEM", "transactionHash": "0xabc", "conditionId": "0x111",
            "timestamp": 1772452383, "size": 10, "usdcSize": 10, "price": 0,
            "asset": "", "side": "", "outcomeIndex": 999, "title": "Market A",
            "slug": "a", "eventSlug": "a", "outcome": "",
        }
        item2 = {
            "type": "REDEEM", "transactionHash": "0xabc", "conditionId": "0x222",
            "timestamp": 1772452383, "size": 20, "usdcSize": 20, "price": 0,
            "asset": "", "side": "", "outcomeIndex": 999, "title": "Market B",
            "slug": "b", "eventSlug": "b", "outcome": "",
        }

        n1 = connector.raw_to_normalized(item1)
        n2 = connector.raw_to_normalized(item2)

        assert n1.source_transaction_id != n2.source_transaction_id
        assert n1.network_transaction_id == n2.network_transaction_id  # Same tx hash

    def test_end_to_end_fixture(self, connector):
        """Full pipeline: load fixture -> normalize all items."""
        results = list(connector.yield_normalized())
        assert len(results) == 10

        errors = [e for _, _, e in results if e is not None]
        assert len(errors) == 0, f"Normalization errors: {errors}"

        for raw, normalized, error in results:
            assert normalized.source == "polymarket"
            assert normalized.network == "polygon"
            assert normalized.source_asset_symbol == "USDC"
            assert normalized.direction in ("inflow", "outflow", "neutral")
            assert normalized.date_time is not None


class TestPolymarketLive:
    """Live API integration tests (skipped if TEST_MODE is set)."""

    @pytest.mark.skipif(
        os.getenv("TEST_MODE") == "1",
        reason="Skipping live API tests in TEST_MODE",
    )
    def test_live_fetch_and_normalize(self):
        """Fetch real activities from Polymarket Data API."""
        connector = ConnectorPolymarket(
            wallet_address=WALLET,
            account_id=1,
            connector_id=1,
            config={"test_mode": False},
        )

        results = list(connector.yield_normalized())
        assert len(results) >= 1

        for raw, normalized, error in results:
            if error:
                pytest.fail(f"Normalization error: {error}")
            assert normalized.source == "polymarket"
            assert normalized.network == "polygon"
            assert normalized.source_asset_symbol == "USDC"

    @pytest.mark.skipif(
        os.getenv("TEST_MODE") == "1",
        reason="Skipping live API tests in TEST_MODE",
    )
    def test_live_balance(self):
        """Fetch live balance from Polymarket positions API."""
        connector = ConnectorPolymarket(
            wallet_address=WALLET,
            account_id=1,
            connector_id=1,
            config={"test_mode": False},
        )

        assert connector.supports_balance is True
        entries = connector.get_balance()

        # This wallet has positions (possibly $0 value if all resolved)
        # Just verify the structure is correct
        for entry in entries:
            assert entry.asset_symbol == "USDC"
            assert entry.chain == "polygon"
            assert isinstance(entry.total, Decimal)
            assert "positions_count" in entry.raw
            assert "positions" in entry.raw


class TestPolymarketRegistry:
    """Test connector registry integration."""

    def test_registered_in_registry(self):
        """Polymarket connector is properly registered."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()
        info = registry.get("polymarket")

        assert info is not None
        assert info.type == "polymarket"
        assert info.category == "onchain"
        assert info.display_name == "Polymarket"
        assert "polygon" in info.supported_chains
        assert "address" in info.required_config
        assert info.supports_balance is True
        assert info.supports_incremental_sync is True

    def test_class_loading(self):
        """Connector class can be loaded from registry."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()
        cls = registry.get_class("polymarket")

        assert cls is not None
        assert cls.__name__ == "ConnectorPolymarketHub"

    def test_chain_config(self):
        """Chain config is registered for polymarket."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()
        chain_config = registry.get_chain_config("polymarket", "polygon")

        assert chain_config is not None
        assert chain_config.base_url == "https://data-api.polymarket.com"
        assert chain_config.chain_id == 137
        assert chain_config.native_currency == "USDC"
