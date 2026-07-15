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
WALLET = "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead"
HL_BRIDGE_ADDRESS = "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef"


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
    """Test perps fill normalization with USDC-only flow model."""

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

    def test_open_fill_direction_is_neutral(self, connector, fills):
        """Opening a position should produce neutral direction with qty=0 (no cash flow)."""
        open_fill = next(f for f in fills if f.get("dir", "").startswith("Open"))
        tx = connector.raw_to_normalized(open_fill)
        assert tx.direction == "neutral"
        assert tx.quantity == 0.0
        assert tx.transaction_type == "margin"
        assert tx.source_transaction_type == "perp_open"

    def test_close_fill_direction_from_pnl(self, connector, fills):
        """Close direction is based on closedPnl sign: positive→inflow, negative→outflow."""
        # Grab a close with negative closedPnl (loss)
        loss_close = next(
            (f for f in fills if f.get("dir", "").startswith("Close") and float(f["closedPnl"]) < 0),
            None,
        )
        if loss_close is not None:
            tx = connector.raw_to_normalized(loss_close)
            assert tx.direction == "outflow"
            assert tx.quantity == abs(float(loss_close["closedPnl"]))
            assert tx.source_transaction_type == "perp_close"

        # Grab a close with positive closedPnl (profit)
        profit_close = next(
            (f for f in fills if f.get("dir", "").startswith("Close") and float(f["closedPnl"]) > 0),
            None,
        )
        if profit_close is not None:
            tx = connector.raw_to_normalized(profit_close)
            assert tx.direction == "inflow"
            assert tx.quantity == abs(float(profit_close["closedPnl"]))
            assert tx.source_transaction_type == "perp_close"

        # Grab a close with zero closedPnl (break-even)
        zero_close = next(
            (f for f in fills if f.get("dir", "").startswith("Close") and float(f["closedPnl"]) == 0),
            None,
        )
        if zero_close is not None:
            tx = connector.raw_to_normalized(zero_close)
            assert tx.direction == "neutral"
            assert tx.quantity == 0.0

    def test_fill_fields_mapped_correctly(self, connector, fills):
        """Core fields should map correctly in closedPnl-based flow model."""
        fill = fills[0]  # First fill is an Open Long with closedPnl=0
        tx = connector.raw_to_normalized(fill)

        assert tx.source == "hyperliquid-perps"
        assert tx.account_id == 99
        # Asset is the margin/settlement currency (from feeToken)
        assert tx.source_asset_symbol == fill["feeToken"]
        # Open fills: direction=neutral, qty=0 (no USDC cash flow)
        assert tx.direction == "neutral"
        assert tx.quantity == 0.0
        assert tx.fee == abs(float(fill["fee"]))
        assert tx.source_fee_quote_asset_symbol == fill["feeToken"]
        # source_transaction_id uses oid (order ID)
        assert tx.source_transaction_id == str(fill["oid"])
        assert tx.network_transaction_id == fill["hash"]

    def test_taxability_status_is_non_taxable(self, connector, fills):
        """Perp fills should have taxability_status=non_taxable."""
        fill = fills[0]
        tx = connector.raw_to_normalized(fill)
        assert tx.taxability_status == "non_taxable"

    def test_tags_contain_coin_and_pnl(self, connector, fills):
        """Tags should include coin, closedPnl, dir, price, size, and _position_data."""
        fill = fills[0]
        tx = connector.raw_to_normalized(fill)

        assert tx.tags is not None
        assert len(tx.tags) == 1
        tag = tx.tags[0]
        assert "closed_pnl" in tag
        assert tag["closed_pnl"] == fill["closedPnl"]
        assert "dir" in tag
        assert "coin" in tag
        assert tag["coin"] == fill["coin"]
        assert "px" in tag
        assert "sz" in tag
        assert "start_position" in tag

        # _position_data should be present for the DerivativePositionStage
        assert "_position_data" in tag
        pd = tag["_position_data"]
        assert pd["coin"] == fill["coin"]
        assert pd["side"] in ("long", "short")
        assert pd["execution_price"] == str(fill["px"])  # to_dict() converts Decimals to str
        assert pd["size"] == str(fill["sz"])
        assert pd["realized_pnl"] == str(fill["closedPnl"])
        assert pd["action"] in ("open", "close")
        assert isinstance(pd["is_new_position"], bool)

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
            assert tx.source_asset_symbol == fill["feeToken"]  # Margin currency from fill
            assert tx.transaction_type == "margin"


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
        # Close Short with closedPnl=-10.5 → outflow (loss)
        assert tx.direction == "outflow"
        assert tx.quantity == 10.5  # abs(closedPnl)
        assert tx.source_transaction_type == "perp_close"

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

    def test_multi_fill_open_preserves_zero_start_position(self):
        """
        Regression: multi-fill open orders must pick the fill with the
        smallest startPosition (the chronologically first one).

        Previously the sort was always descending, which picked the *last*
        partial fill for open orders — making startPosition non-zero and
        is_new_position=False.  This caused the DerivativePositionStage
        to never create a position, leaving the derivatives table empty.
        """
        fills = [
            {"coin": "BTC", "px": "88172.0", "sz": "0.00366", "side": "B",
             "time": 3000, "oid": 300, "tid": 5, "fee": "0.15",
             "closedPnl": "0.0", "startPosition": "0.0", "dir": "Open Long",
             "hash": "0xabc", "feeToken": "USDC", "crossed": True, "twapId": None},
            {"coin": "BTC", "px": "88172.0", "sz": "0.01", "side": "B",
             "time": 3000, "oid": 300, "tid": 6, "fee": "0.40",
             "closedPnl": "0.0", "startPosition": "0.00366", "dir": "Open Long",
             "hash": "0xabc", "feeToken": "USDC", "crossed": True, "twapId": None},
            {"coin": "BTC", "px": "88172.0", "sz": "0.00168", "side": "B",
             "time": 3000, "oid": 300, "tid": 7, "fee": "0.07",
             "closedPnl": "0.0", "startPosition": "0.01366", "dir": "Open Long",
             "hash": "0xabc", "feeToken": "USDC", "crossed": True, "twapId": None},
        ]
        result = HyperliquidPerpsConnector._aggregate_fills_by_oid(fills)
        assert len(result) == 1
        # The aggregated fill must have startPosition from the first partial
        # fill (the one that truly opened from zero)
        assert result[0]["startPosition"] == "0.0"

    def test_multi_fill_open_produces_is_new_position_true(self):
        """
        After aggregation, normalizing a multi-fill open order that starts
        from position 0 must set is_new_position=True in the PositionIntent.
        """
        fills = [
            {"coin": "BTC", "px": "88000.0", "sz": "0.01", "side": "B",
             "time": 4000, "oid": 400, "tid": 10, "fee": "0.40",
             "closedPnl": "0.0", "startPosition": "0.0", "dir": "Open Long",
             "hash": "0xdef", "feeToken": "USDC", "crossed": True, "twapId": None},
            {"coin": "BTC", "px": "88001.0", "sz": "0.02", "side": "B",
             "time": 4000, "oid": 400, "tid": 11, "fee": "0.80",
             "closedPnl": "0.0", "startPosition": "0.01", "dir": "Open Long",
             "hash": "0xdef", "feeToken": "USDC", "crossed": True, "twapId": None},
        ]
        aggregated = HyperliquidPerpsConnector._aggregate_fills_by_oid(fills)
        connector = HyperliquidPerpsConnector(
            account_id=99, connector_id=1,
            config={"test_mode": True, "_account_address_or_identifier": WALLET},
        )
        tx = connector.raw_to_normalized(aggregated[0])

        pd = tx.tags[0]["_position_data"]
        assert pd["is_new_position"] is True
        assert pd["action"] == "open"

    def test_multi_fill_close_preserves_largest_start_position(self):
        """Close orders must pick the fill with the largest startPosition."""
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
        assert result[0]["startPosition"] == "2.50"

    def test_is_new_position_with_varied_zero_formats(self):
        """
        is_new_position must be True for any string representation of zero
        (e.g. '0', '0.0', '0.00', '0.000').
        """
        connector = HyperliquidPerpsConnector(
            account_id=99, connector_id=1,
            config={"test_mode": True, "_account_address_or_identifier": WALLET},
        )
        for zero_str in ("0", "0.0", "0.00", "0.000", "0.0000"):
            fill = {
                "coin": "ETH", "px": "3000.0", "sz": "1.0", "side": "B",
                "time": 5000, "oid": 500, "tid": 20, "fee": "1.35",
                "closedPnl": "0.0", "startPosition": zero_str, "dir": "Open Long",
                "hash": "0xabc", "feeToken": "USDC", "crossed": True, "twapId": None,
            }
            tx = connector.raw_to_normalized(fill)
            pd = tx.tags[0]["_position_data"]
            assert pd["is_new_position"] is True, (
                f"is_new_position should be True for startPosition='{zero_str}'"
            )


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
        assert tx.transaction_type == "margin"
        assert tx.source_asset_symbol == "USDC"
        assert tx.taxability_status == "non_taxable"

    def test_negative_funding_is_outflow(self, connector, entries):
        """Negative USDC funding → paid → outflow."""
        neg = next((e for e in entries if float(e["delta"]["usdc"]) < 0), None)
        if neg is None:
            pytest.skip("No negative funding in fixtures")
        tx = connector.raw_to_normalized(neg)
        assert tx.direction == "outflow"
        assert tx.source_asset_symbol == "USDC"
        assert tx.taxability_status == "non_taxable"

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
            config={
                "test_mode": True,
                "_account_address_or_identifier": HL_BRIDGE_ADDRESS,
                "wallet_address": WALLET,
            },
        )

    @pytest.fixture
    def entries(self):
        return _load_fixture("hyperliquid_transfers.json")

    def test_deposit_is_inflow(self, connector, entries):
        """Deposit entries should be inflow transfers with known to (account identifier)."""
        deposit = next((e for e in entries if e["delta"]["type"] == "deposit"), None)
        if deposit is None:
            pytest.skip("No deposits in fixtures")
        tx = connector.raw_to_normalized(deposit)
        assert tx.direction == "inflow"
        assert tx.transaction_type == "transfer"
        assert tx.source_asset_symbol == "USDC"
        # Known side: to is the account identifier (HL bridge address)
        assert tx.source_to_account == HL_BRIDGE_ADDRESS
        # from side left empty for OnChainAddressEnrichmentStage
        assert tx.source_from_account is None
        # Account ID is set for the destination
        assert tx.to_account_id is not None
        assert tx.from_account_id is None

    def test_withdrawal_is_outflow(self, connector, entries):
        """Withdrawal entries should be outflow transfers with known from (account identifier)."""
        withdrawal = next((e for e in entries if e["delta"]["type"] == "withdraw"), None)
        if withdrawal is None:
            pytest.skip("No withdrawals in fixtures")
        tx = connector.raw_to_normalized(withdrawal)
        assert tx.direction == "outflow"
        assert tx.source_asset_symbol == "USDC"
        # Known side: from is the account identifier (HL bridge address)
        assert tx.source_from_account == HL_BRIDGE_ADDRESS
        # to side left empty for OnChainAddressEnrichmentStage
        assert tx.source_to_account is None
        # Account ID is set for the source
        assert tx.from_account_id is not None
        assert tx.to_account_id is None

    def test_network_is_arbitrum(self, connector, entries):
        """Transfer network should be arbitrum (Hyperliquid bridges via Arbitrum)."""
        deposit = next((e for e in entries if e["delta"]["type"] == "deposit"), None)
        if deposit is None:
            pytest.skip("No deposits in fixtures")
        tx = connector.raw_to_normalized(deposit)
        assert tx.network == "arbitrum"

    def test_source_transaction_id_is_tx_hash(self, connector, entries):
        """source_transaction_id should be the raw tx hash (no prefix, no timestamp)."""
        entry = next(
            (e for e in entries if e["delta"]["type"] in ("deposit", "withdraw")),
            None,
        )
        if entry is None:
            pytest.skip("No deposit/withdraw in fixtures")
        tx = connector.raw_to_normalized(entry)
        expected_hash = entry.get("hash", "")
        assert tx.source_transaction_id == expected_hash
        # Must NOT contain type prefix or timestamp suffix
        assert "deposit_" not in tx.source_transaction_id
        assert "withdraw_" not in tx.source_transaction_id

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
