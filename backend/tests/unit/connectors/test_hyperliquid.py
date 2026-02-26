"""
Tests for Hyperliquid connectors (perps, funding, transfers).

Uses real fixture data saved from the API for unit tests.
Integration tests hit the live API (marked with @pytest.mark.integration).
"""

import json
import os
import pytest
from datetime import datetime, timezone
from decimal import Decimal

from backend.connectors.cex.connector_hyperliquid_perps import HyperliquidPerpsConnector
from backend.connectors.cex.connector_hyperliquid_funding import HyperliquidFundingConnector
from backend.connectors.cex.connector_hyperliquid_transfers import HyperliquidTransfersConnector
from backend.db.models import NormalizedTransaction


FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "e2e", "fixtures")
WALLET = "0xaecc12ea31b1e0d70b046f19e74c2a95524eb8be"


# =========================================================================
# Helper to load fixtures
# =========================================================================

def _load_fixture(name: str):
    path = os.path.join(FIXTURES_DIR, name)
    with open(path) as f:
        return json.load(f)


# =========================================================================
# Perps connector — normalization tests
# =========================================================================

class TestHyperliquidPerpsNormalization:
    """Test perps fill normalization with real API fixture data."""

    @pytest.fixture
    def connector(self):
        return HyperliquidPerpsConnector(
            account_id=99,
            connector_id=1,
            config={"test_mode": True, "_account_address_or_identifier": WALLET},
        )

    @pytest.fixture
    def fills(self):
        return _load_fixture("hyperliquid_perps.json")

    def test_buy_fill_direction_is_inflow(self, connector, fills):
        """Buy fills should produce inflow direction."""
        buy_fill = next(f for f in fills if f["side"] == "B")
        tx = connector.raw_to_normalized(buy_fill)
        assert tx.direction == "inflow"
        assert tx.transaction_type == "trade"
        assert tx.source_transaction_type == "buy"

    def test_sell_fill_direction_is_outflow(self, connector, fills):
        """Sell fills should produce outflow direction."""
        sell_fill = next((f for f in fills if f["side"] == "A"), None)
        if sell_fill is None:
            pytest.skip("No sell fills in fixture data")
        tx = connector.raw_to_normalized(sell_fill)
        assert tx.direction == "outflow"
        assert tx.source_transaction_type == "sell"

    def test_fill_fields_mapped_correctly(self, connector, fills):
        """Core fields should map correctly from API response."""
        fill = fills[0]
        tx = connector.raw_to_normalized(fill)

        assert tx.source == "hyperliquid-perps"
        assert tx.account_id == 99
        assert tx.source_asset_symbol == fill["coin"]
        assert tx.quantity == float(fill["sz"])
        assert tx.price == float(fill["px"])
        assert tx.source_price_quote_asset_symbol == "USDC"
        assert tx.fee == abs(float(fill["fee"]))
        assert tx.source_fee_quote_asset_symbol == fill["feeToken"]
        # source_transaction_id now uses oid (order ID) instead of tid
        assert tx.source_transaction_id == str(fill["oid"])
        assert tx.network_transaction_id == fill["hash"]

    def test_closed_pnl_stored_in_tags(self, connector, fills):
        """closedPnl from API should be stored in transaction tags for P&L validation."""
        fill = fills[0]
        tx = connector.raw_to_normalized(fill)

        assert tx.tags is not None
        assert len(tx.tags) == 1
        assert "closed_pnl" in tx.tags[0]
        assert tx.tags[0]["closed_pnl"] == fill["closedPnl"]
        assert "dir" in tx.tags[0]
        assert "start_position" in tx.tags[0]

    def test_total_computed_correctly(self, connector, fills):
        """Total = price * quantity."""
        fill = fills[0]
        tx = connector.raw_to_normalized(fill)
        expected_total = float(Decimal(fill["px"]) * Decimal(fill["sz"]))
        assert abs(tx.total - expected_total) < 0.01

    def test_datetime_is_utc(self, connector, fills):
        """Timestamps should be converted to UTC datetime."""
        fill = fills[0]
        tx = connector.raw_to_normalized(fill)
        assert tx.date_time.tzinfo == timezone.utc
        assert tx.date_time.year >= 2025

    def test_all_fills_normalize_without_error(self, connector, fills):
        """Every fill in fixture data should normalize without exceptions."""
        for fill in fills:
            tx = connector.raw_to_normalized(fill)
            assert isinstance(tx, NormalizedTransaction)
            assert tx.source_transaction_id


# =========================================================================
# Perps connector — fill aggregation tests
# =========================================================================

class TestHyperliquidPerpsAggregation:
    """Test partial fill aggregation by order ID."""

    def test_single_fill_unchanged(self):
        """A single fill should pass through without modification."""
        fills = [
            {"coin": "ETH", "px": "3000.0", "sz": "1.0", "side": "B",
             "time": 1000, "oid": 100, "tid": 1, "fee": "1.35",
             "closedPnl": "0.0", "startPosition": "0.0", "dir": "Open Long",
             "hash": "0xabc", "feeToken": "USDC", "crossed": True, "twapId": None}
        ]
        result = HyperliquidPerpsConnector._aggregate_fills_by_oid(fills)
        assert len(result) == 1
        assert result[0]["sz"] == "1.0"
        assert result[0]["px"] == "3000.0"

    def test_same_price_fills_aggregated(self):
        """Fills with same oid and same price should sum qty and fees."""
        fills = [
            {"coin": "ETH", "px": "3000.0", "sz": "0.5", "side": "B",
             "time": 1000, "oid": 100, "tid": 1, "fee": "0.675",
             "closedPnl": "0.0", "startPosition": "1.0", "dir": "Open Long",
             "hash": "0xabc", "feeToken": "USDC", "crossed": True, "twapId": None},
            {"coin": "ETH", "px": "3000.0", "sz": "0.5", "side": "B",
             "time": 1000, "oid": 100, "tid": 2, "fee": "0.675",
             "closedPnl": "0.0", "startPosition": "0.5", "dir": "Open Long",
             "hash": "0xabc", "feeToken": "USDC", "crossed": True, "twapId": None},
        ]
        result = HyperliquidPerpsConnector._aggregate_fills_by_oid(fills)
        assert len(result) == 1
        assert Decimal(result[0]["sz"]) == Decimal("1.0")
        assert Decimal(result[0]["px"]) == Decimal("3000.0")  # VWAP = same price
        assert Decimal(result[0]["fee"]) == Decimal("1.350")
        assert result[0]["_aggregated_fills"] == 2

    def test_different_price_fills_use_vwap(self):
        """Fills with same oid but different prices should use VWAP."""
        fills = [
            {"coin": "ZEC", "px": "532.78", "sz": "1.25", "side": "A",
             "time": 2000, "oid": 200, "tid": 3, "fee": "0.30",
             "closedPnl": "-5.0", "startPosition": "2.50", "dir": "Close Long",
             "hash": "0xdef", "feeToken": "USDC", "crossed": True, "twapId": None},
            {"coin": "ZEC", "px": "532.72", "sz": "1.25", "side": "A",
             "time": 2000, "oid": 200, "tid": 4, "fee": "0.30",
             "closedPnl": "-3.0", "startPosition": "1.25", "dir": "Close Long",
             "hash": "0xdef", "feeToken": "USDC", "crossed": True, "twapId": None},
        ]
        result = HyperliquidPerpsConnector._aggregate_fills_by_oid(fills)
        assert len(result) == 1

        agg = result[0]
        total_qty = Decimal("2.50")
        total_notional = Decimal("532.78") * Decimal("1.25") + Decimal("532.72") * Decimal("1.25")
        expected_vwap = total_notional / total_qty

        assert Decimal(agg["sz"]) == total_qty
        assert abs(Decimal(agg["px"]) - expected_vwap) < Decimal("0.001")
        assert Decimal(agg["fee"]) == Decimal("0.60")
        assert Decimal(agg["closedPnl"]) == Decimal("-8.0")  # summed

    def test_aggregation_preserves_notional(self):
        """VWAP * total_qty must equal sum(px_i * qty_i) — P&L neutral."""
        fills = [
            {"coin": "BTC", "px": "88172.0", "sz": "0.00366", "side": "B",
             "time": 3000, "oid": 300, "tid": 5, "fee": "0.15",
             "closedPnl": "0.0", "startPosition": "0.0", "dir": "Open Long",
             "hash": "0xghi", "feeToken": "USDC", "crossed": True, "twapId": None},
            {"coin": "BTC", "px": "88172.0", "sz": "0.01", "side": "B",
             "time": 3000, "oid": 300, "tid": 6, "fee": "0.40",
             "closedPnl": "0.0", "startPosition": "0.00366", "dir": "Open Long",
             "hash": "0xghi", "feeToken": "USDC", "crossed": True, "twapId": None},
            {"coin": "BTC", "px": "88172.0", "sz": "0.00168", "side": "B",
             "time": 3000, "oid": 300, "tid": 7, "fee": "0.07",
             "closedPnl": "0.0", "startPosition": "0.01366", "dir": "Open Long",
             "hash": "0xghi", "feeToken": "USDC", "crossed": True, "twapId": None},
        ]
        result = HyperliquidPerpsConnector._aggregate_fills_by_oid(fills)
        agg = result[0]

        agg_total = Decimal(agg["px"]) * Decimal(agg["sz"])
        original_total = sum(Decimal(f["px"]) * Decimal(f["sz"]) for f in fills)
        assert abs(agg_total - original_total) < Decimal("0.0001")

    def test_different_oids_not_merged(self):
        """Fills with different oids should remain separate."""
        fills = [
            {"coin": "ETH", "px": "3000.0", "sz": "1.0", "side": "B",
             "time": 1000, "oid": 100, "tid": 1, "fee": "1.35",
             "closedPnl": "0.0", "startPosition": "0.0", "dir": "Open Long",
             "hash": "0xabc", "feeToken": "USDC", "crossed": True, "twapId": None},
            {"coin": "ETH", "px": "3100.0", "sz": "0.5", "side": "A",
             "time": 2000, "oid": 200, "tid": 2, "fee": "0.70",
             "closedPnl": "50.0", "startPosition": "1.0", "dir": "Close Long",
             "hash": "0xdef", "feeToken": "USDC", "crossed": True, "twapId": None},
        ]
        result = HyperliquidPerpsConnector._aggregate_fills_by_oid(fills)
        assert len(result) == 2

    def test_aggregated_fill_has_metadata(self):
        """Aggregated fills should include _aggregated_fills and _fill_tids."""
        fills = [
            {"coin": "ETH", "px": "3000.0", "sz": "0.3", "side": "B",
             "time": 1000, "oid": 100, "tid": 10, "fee": "0.40",
             "closedPnl": "0.0", "startPosition": "0.5", "dir": "Open Long",
             "hash": "0xabc", "feeToken": "USDC", "crossed": True, "twapId": None},
            {"coin": "ETH", "px": "3000.0", "sz": "0.2", "side": "B",
             "time": 1000, "oid": 100, "tid": 11, "fee": "0.27",
             "closedPnl": "0.0", "startPosition": "0.2", "dir": "Open Long",
             "hash": "0xabc", "feeToken": "USDC", "crossed": True, "twapId": None},
        ]
        result = HyperliquidPerpsConnector._aggregate_fills_by_oid(fills)
        agg = result[0]
        assert agg["_aggregated_fills"] == 2
        assert set(agg["_fill_tids"]) == {10, 11}

    def test_aggregated_tag_includes_count(self):
        """Normalized aggregated fill should have aggregated_fills in tags."""
        connector = HyperliquidPerpsConnector(
            account_id=99, connector_id=1,
            config={"test_mode": True, "_account_address_or_identifier": WALLET},
        )
        agg_fill = {
            "coin": "ETH", "px": "3000.0", "sz": "1.0", "side": "B",
            "time": 1000000000000, "oid": 100, "tid": 1, "fee": "1.35",
            "closedPnl": "-10.5", "startPosition": "2.0", "dir": "Close Short",
            "hash": "0xabc", "feeToken": "USDC", "crossed": True,
            "_aggregated_fills": 3, "_fill_tids": [1, 2, 3],
        }
        tx = connector.raw_to_normalized(agg_fill)
        assert tx.tags[0]["aggregated_fills"] == 3

    def test_real_fixture_aggregation(self):
        """Aggregating real fixture data should reduce fill count."""
        fills = _load_fixture("hyperliquid_perps.json")
        result = HyperliquidPerpsConnector._aggregate_fills_by_oid(fills)

        unique_oids = len(set(f["oid"] for f in fills))
        assert len(result) == unique_oids
        assert len(result) < len(fills)

        # Verify total notional is preserved
        original_notional = sum(Decimal(f["px"]) * Decimal(f["sz"]) for f in fills)
        agg_notional = sum(Decimal(f["px"]) * Decimal(f["sz"]) for f in result)
        assert abs(agg_notional - original_notional) < Decimal("0.01")

    def test_empty_fills_returns_empty(self):
        """Empty input should return empty list."""
        result = HyperliquidPerpsConnector._aggregate_fills_by_oid([])
        assert result == []


# =========================================================================
# Funding connector — normalization tests
# =========================================================================

class TestHyperliquidFundingNormalization:
    """Test funding rate payment normalization."""

    @pytest.fixture
    def connector(self):
        return HyperliquidFundingConnector(
            account_id=99,
            connector_id=2,
            config={"test_mode": True, "_account_address_or_identifier": WALLET},
        )

    @pytest.fixture
    def entries(self):
        return _load_fixture("hyperliquid_funding.json")

    def test_positive_funding_is_inflow(self, connector, entries):
        """Positive USDC funding → received → inflow."""
        pos = next((e for e in entries if float(e["delta"]["usdc"]) > 0), None)
        if pos is None:
            pytest.skip("No positive funding in fixtures")
        tx = connector.raw_to_normalized(pos)
        assert tx.direction == "inflow"
        assert tx.transaction_type == "transfer"
        assert tx.source_asset_symbol == "USDC"

    def test_negative_funding_is_outflow(self, connector, entries):
        """Negative USDC funding → paid → outflow."""
        neg = next((e for e in entries if float(e["delta"]["usdc"]) < 0), None)
        if neg is None:
            pytest.skip("No negative funding in fixtures")
        tx = connector.raw_to_normalized(neg)
        assert tx.direction == "outflow"
        assert tx.source_asset_symbol == "USDC"

    def test_funding_tags_contain_rate(self, connector, entries):
        """Tags should include funding rate and position info."""
        tx = connector.raw_to_normalized(entries[0])
        assert tx.tags is not None
        assert "funding_rate" in tx.tags[0]
        assert "coin" in tx.tags[0]
        assert "position_size" in tx.tags[0]

    def test_source_id_is_unique(self, connector, entries):
        """Each funding entry should get a unique source_transaction_id."""
        ids = set()
        for entry in entries:
            tx = connector.raw_to_normalized(entry)
            assert tx.source_transaction_id not in ids
            ids.add(tx.source_transaction_id)

    def test_all_entries_normalize_without_error(self, connector, entries):
        """Every funding entry should normalize without exceptions."""
        for entry in entries:
            tx = connector.raw_to_normalized(entry)
            assert isinstance(tx, NormalizedTransaction)


# =========================================================================
# Transfers connector — normalization tests
# =========================================================================

class TestHyperliquidTransfersNormalization:
    """Test deposit/withdrawal normalization."""

    @pytest.fixture
    def connector(self):
        return HyperliquidTransfersConnector(
            account_id=99,
            connector_id=3,
            config={"test_mode": True, "_account_address_or_identifier": WALLET},
        )

    @pytest.fixture
    def entries(self):
        return _load_fixture("hyperliquid_transfers.json")

    def test_deposit_is_inflow(self, connector, entries):
        """Deposit entries should be inflow transfers."""
        deposit = next((e for e in entries if e["delta"]["type"] == "deposit"), None)
        if deposit is None:
            pytest.skip("No deposits in fixtures")
        tx = connector.raw_to_normalized(deposit)
        assert tx.direction == "inflow"
        assert tx.transaction_type == "transfer"
        assert tx.source_asset_symbol == "USDC"
        assert tx.to_account_id == 99

    def test_withdrawal_is_outflow(self, connector, entries):
        """Withdrawal entries should be outflow transfers."""
        withdrawal = next((e for e in entries if e["delta"]["type"] == "withdraw"), None)
        if withdrawal is None:
            pytest.skip("No withdrawals in fixtures")
        tx = connector.raw_to_normalized(withdrawal)
        assert tx.direction == "outflow"
        assert tx.source_asset_symbol == "USDC"
        assert tx.from_account_id == 99

    def test_network_is_arbitrum(self, connector, entries):
        """Transfer network should be arbitrum (Hyperliquid bridges via Arbitrum)."""
        deposit = next((e for e in entries if e["delta"]["type"] == "deposit"), None)
        if deposit is None:
            pytest.skip("No deposits in fixtures")
        tx = connector.raw_to_normalized(deposit)
        assert tx.network == "arbitrum"

    def test_all_entries_normalize_without_error(self, connector, entries):
        """Every transfer entry should normalize without exceptions."""
        for entry in entries:
            delta_type = entry.get("delta", {}).get("type", "")
            if delta_type in ("deposit", "withdraw"):
                tx = connector.raw_to_normalized(entry)
                assert isinstance(tx, NormalizedTransaction)


# =========================================================================
# Registry tests
# =========================================================================

class TestHyperliquidRegistry:
    """Test that Hyperliquid connectors are properly registered."""

    def test_connectors_registered(self):
        """All 3 Hyperliquid connectors should be in the registry."""
        from backend.connectors.connector_registry import get_connector_registry
        registry = get_connector_registry()

        for ctype in ("hyperliquid-perps", "hyperliquid-funding", "hyperliquid-transfers"):
            info = registry.get(ctype)
            assert info is not None, f"{ctype} not registered"
            assert info.category == "cex"
            assert info.supports_incremental_sync is True
            assert info.connector_family == "hyperliquid"

    def test_perps_supports_balance(self):
        """Perps connector should support balance fetching."""
        from backend.connectors.connector_registry import get_connector_registry
        registry = get_connector_registry()
        info = registry.get("hyperliquid-perps")
        assert info.supports_balance is True

    def test_connector_classes_loadable(self):
        """Connector classes should be importable via registry."""
        from backend.connectors.connector_registry import get_connector_registry
        registry = get_connector_registry()

        for ctype in ("hyperliquid-perps", "hyperliquid-funding", "hyperliquid-transfers"):
            cls = registry.get_class(ctype)
            assert cls is not None, f"Class not found for {ctype}"


# =========================================================================
# Integration tests (live API — skipped in CI)
# =========================================================================

@pytest.mark.integration
class TestHyperliquidLiveAPI:
    """Integration tests hitting the real Hyperliquid API."""

    def test_perps_fetch_fills(self):
        """Test fetching real fills from the API."""
        connector = HyperliquidPerpsConnector(
            account_id=1,
            config={"_account_address_or_identifier": WALLET},
        )
        fills = list(connector.yield_raws())
        # Account has real history, so we expect fills
        assert len(fills) > 0
        # Verify first fill normalizes correctly
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
        # Should at least have USDC margin balance
        assert len(balance) >= 1
        usdc = next((b for b in balance if b.asset_symbol == "USDC"), None)
        assert usdc is not None
        assert usdc.total > 0
