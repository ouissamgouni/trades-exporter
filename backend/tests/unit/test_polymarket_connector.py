"""
Unit tests for Polymarket connector — critical normalization, balance, and hub logic.
"""

import pytest
import os
from decimal import Decimal
from unittest.mock import patch, MagicMock

from backend.connectors.onchain.connector_polymarket import (
    ConnectorPolymarket,
    _parse_closed_time,
)

CLOSED_2025_11_08 = 1762560000  # 2025-11-08T00:00:00Z


WALLET = "0x2222222222222222222222222222222222222222"


def _make_connector(wallet=WALLET, **extra_config):
    config = dict(extra_config)
    return ConnectorPolymarket(
        wallet_address=wallet, account_id=1, connector_id=1, config=config
    )


def _trade_buy(usdc=10, shares=100, price=0.10, condition_id="0xabc", tx_hash="0x111"):
    return {
        "type": "TRADE",
        "side": "BUY",
        "usdcSize": usdc,
        "size": shares,
        "price": price,
        "transactionHash": tx_hash,
        "conditionId": condition_id,
        "timestamp": 1762301363,
        "title": "Will BTC hit 200k?",
        "outcome": "Yes",
        "outcomeIndex": 0,
        "slug": "will-btc-hit-200k",
        "eventSlug": "btc-200k",
        "asset": "12345",
    }


def _trade_sell(usdc=15, shares=100, price=0.15, condition_id="0xdef", tx_hash="0x222"):
    item = _trade_buy(
        usdc=usdc,
        shares=shares,
        price=price,
        condition_id=condition_id,
        tx_hash=tx_hash,
    )
    item["side"] = "SELL"
    return item


def _redeem(usdc=50, shares=50, condition_id="0xghi", tx_hash="0x333"):
    return {
        "type": "REDEEM",
        "side": "",
        "usdcSize": usdc,
        "size": shares,
        "price": 0,
        "transactionHash": tx_hash,
        "conditionId": condition_id,
        "timestamp": 1772452383,
        "title": "Will Israel strike Gaza on November 8?",
        "outcome": "",
        "outcomeIndex": 999,
        "slug": "will-israel-strike-gaza-on-november-8",
        "eventSlug": "will-israel-strike-gaza-on-379",
        "asset": "",
    }


# ── Normalization ────────────────────────────────────────────────────


class TestNormalization:
    """Stock model: outcome shares are the traded asset, USDC is the quote."""

    def test_buy_normalizes_as_inflow_of_shares(self):
        norm = _make_connector().raw_to_normalized(_trade_buy())
        assert norm.transaction_type == "trade"
        assert norm.direction == "inflow"
        assert norm.source_transaction_type == "buy"
        assert norm.source_asset_symbol == "PM:will-btc-hit-200k-Yes"
        assert norm.source_price_quote_asset_symbol == "USDC"

    def test_sell_normalizes_as_outflow_of_shares(self):
        norm = _make_connector().raw_to_normalized(_trade_sell())
        assert norm.transaction_type == "trade"
        assert norm.direction == "outflow"
        assert norm.source_transaction_type == "sell"
        assert norm.source_asset_symbol == "PM:will-btc-hit-200k-Yes"
        assert norm.source_price_quote_asset_symbol == "USDC"

    def test_redeem_normalizes_as_memo(self):
        """REDEEM is audit-only (memo) — no PnL impact. Resolution is handled by synthetic."""
        norm = _make_connector().raw_to_normalized(_redeem())
        assert norm.transaction_type == "memo"
        assert norm.direction == "neutral"
        assert norm.source_transaction_type == "redeem"
        assert norm.source_price_quote_asset_symbol == "USDC"

    def test_redeem_win_price_is_one(self):
        """REDEEM with usdcSize=100, size=100 → price_per_share = 1.0."""
        norm = _make_connector().raw_to_normalized(_redeem(usdc=100, shares=100))
        assert norm.price == 1.0

    def test_buy_quantity_is_shares(self):
        """Quantity is in shares (asset units), not USDC."""
        norm = _make_connector().raw_to_normalized(_trade_buy(usdc=10, shares=100))
        assert norm.quantity == 100.0

    def test_buy_price_per_share(self):
        norm = _make_connector().raw_to_normalized(_trade_buy(price=0.10))
        assert norm.price == 0.10

    def test_buy_from_to(self):
        """PM trades don't set from/to accounts."""
        norm = _make_connector().raw_to_normalized(_trade_buy())
        assert norm.source_from_account is None
        assert norm.source_to_account is None

    def test_sell_from_to(self):
        """PM trades don't set from/to accounts."""
        norm = _make_connector().raw_to_normalized(_trade_sell())
        assert norm.source_from_account is None
        assert norm.source_to_account is None

    def test_redeem_from_to(self):
        """PM trades don't set from/to accounts."""
        norm = _make_connector().raw_to_normalized(_redeem())
        assert norm.source_from_account is None
        assert norm.source_to_account is None

    def test_asset_symbol_format(self):
        """BUY with slug + outcome → PM:{slug}-{outcome}."""
        norm = _make_connector().raw_to_normalized(_trade_buy())
        assert norm.source_asset_symbol == "PM:will-btc-hit-200k-Yes"

    def test_asset_symbol_fallback_no_outcome(self):
        """If outcome missing, fallback to conditionId prefix."""
        item = _trade_buy()
        item["outcome"] = ""
        norm = _make_connector().raw_to_normalized(item)
        assert norm.source_asset_symbol == "PM:will-btc-hit-200k-0xabc"

    def test_no_taxability_override(self):
        """Stock model uses default taxability — no non_taxable override."""
        norm = _make_connector().raw_to_normalized(_trade_buy())
        assert norm.taxability_status is None or norm.taxability_status != "non_taxable"

    def test_redeem_maps_outcome_from_condition_map(self):
        """REDEEM has outcome='', resolved via _condition_outcome_map."""
        c = _make_connector()
        c._condition_outcome_map = {"0xghi": "Yes"}
        norm = c.raw_to_normalized(_redeem())
        assert "Yes" in norm.source_asset_symbol
        assert (
            norm.source_asset_symbol == "PM:will-israel-strike-gaza-on-november-8-Yes"
        )

    def test_source_transaction_id_includes_condition(self):
        norm = _make_connector().raw_to_normalized(
            _trade_buy(tx_hash="0xAAA", condition_id="0xBBB")
        )
        assert norm.source_transaction_id == "0xAAA_0xBBB"

    def test_same_tx_different_conditions_unique(self):
        c = _make_connector()
        n1 = c.raw_to_normalized(_redeem(tx_hash="0xSAME", condition_id="0xC1"))
        n2 = c.raw_to_normalized(_redeem(tx_hash="0xSAME", condition_id="0xC2"))
        assert n1.source_transaction_id != n2.source_transaction_id

    def test_common_fields(self):
        norm = _make_connector().raw_to_normalized(_trade_buy())
        assert norm.network == "polygon"
        assert norm.source == "polymarket"
        assert norm.fee == 0
        assert norm.include_fee is False
        assert norm.date_time is not None

    def test_tags_market_context(self):
        norm = _make_connector().raw_to_normalized(_trade_buy())
        assert isinstance(norm.tags, list)
        assert norm.tags[0]["market_title"] == "Will BTC hit 200k?"
        assert norm.tags[0]["side"] == "BUY"
        assert norm.tags[0]["shares"] == 100.0

    def test_transaction_type_trade_for_buy_sell_synthetic(self):
        """BUY, SELL, SYNTHETIC_CLOSE produce transaction_type='trade'."""
        c = _make_connector()
        assert c.raw_to_normalized(_trade_buy()).transaction_type == "trade"
        assert c.raw_to_normalized(_trade_sell()).transaction_type == "trade"
        # Synthetic close
        synthetic = _trade_buy()
        synthetic["type"] = "SYNTHETIC_CLOSE"
        synthetic["side"] = "CLOSE"
        synthetic["_synthetic"] = True
        assert c.raw_to_normalized(synthetic).transaction_type == "trade"
        assert (
            c.raw_to_normalized(synthetic).source_transaction_type == "synthetic-close"
        )

    def test_redeem_transaction_type_is_memo(self):
        """REDEEM produces transaction_type='memo' — audit-only, no PnL."""
        c = _make_connector()
        assert c.raw_to_normalized(_redeem()).transaction_type == "memo"


# ── Synthetic Closes ─────────────────────────────────────────────────


class TestSyntheticCloses:
    """Losing positions with no REDEEM get synthetic SELL at price=0 (via Gamma resolution)."""

    def _setup_gamma(
        self,
        connector,
        condition_id,
        is_winner,
        outcome="Yes",
        slug="will-btc-hit-200k",
        closed_time="2025-11-08T00:00:00Z",
    ):
        """Set up Gamma cache for a resolved market."""
        if is_winner:
            outcome_prices = '["1","0"]' if outcome == "Yes" else '["0","1"]'
        else:
            outcome_prices = '["0","1"]' if outcome == "Yes" else '["1","0"]'

        connector._gamma_cache[condition_id] = {
            "closed": True,
            "outcomePrices": outcome_prices,
            "outcomes": '["Yes","No"]',
            "slug": slug,
            "question": f"Market {slug}",
            "closedTime": closed_time,
            "condition_id": condition_id,
        }

    @patch.object(ConnectorPolymarket, "_fetch_gamma_markets")
    @patch.object(ConnectorPolymarket, "_fetch_activity")
    def test_synthetic_close_for_losing_position(self, mock_fetch, mock_gamma):
        """Resolved loser (Gamma closed, outcomePrices=["0","1"]) → synthetic CLOSE at $0."""
        trades = [_trade_buy(usdc=50, shares=100, price=0.50, condition_id="0xabc")]

        def gamma_side_effect(condition_ids):
            self._setup_gamma(c, "0xabc", is_winner=False)

        mock_fetch.return_value = trades
        mock_gamma.side_effect = gamma_side_effect

        c = _make_connector()
        raws = list(c.yield_raws())
        assert len(raws) == 2
        synthetic = raws[1]
        assert synthetic["_synthetic"] is True
        assert synthetic["type"] == "SYNTHETIC_CLOSE"
        assert synthetic["side"] == "CLOSE"
        assert synthetic["price"] == 0
        assert synthetic["size"] == 100.0
        assert synthetic["usdcSize"] == 0

    @patch.object(ConnectorPolymarket, "_fetch_gamma_markets")
    @patch.object(ConnectorPolymarket, "_fetch_activity")
    def test_unredeemed_winner_stays_open(self, mock_fetch, mock_gamma):
        """Resolved winner not yet redeemed → no close; the REDEEM will close it."""
        trades = [_trade_buy()]

        def gamma_side_effect(condition_ids):
            self._setup_gamma(c, "0xabc", is_winner=True)

        mock_fetch.return_value = trades
        mock_gamma.side_effect = gamma_side_effect

        c = _make_connector()
        raws = list(c.yield_raws())
        assert [r["type"] for r in raws] == ["TRADE"]

    @patch.object(ConnectorPolymarket, "_fetch_gamma_markets")
    @patch.object(ConnectorPolymarket, "_fetch_activity")
    def test_no_synthetic_when_redeem_exists(self, mock_fetch, mock_gamma):
        """If REDEEM already yielded for conditionId, Gamma doesn't add another synthetic."""
        mock_fetch.return_value = [
            _trade_buy(condition_id="0xabc"),
            _redeem(condition_id="0xabc"),
        ]
        mock_gamma.return_value = None  # No Gamma needed, REDEEM covers it

        raws = list(_make_connector().yield_raws())
        # BUY + resolution synthetic (from REDEEM) + REDEEM = 3 items
        assert len(raws) == 3
        assert raws[1]["type"] == "SYNTHETIC_CLOSE"  # resolution from REDEEM
        assert raws[2]["type"] == "REDEEM"

    @patch.object(ConnectorPolymarket, "_fetch_gamma_markets")
    @patch.object(ConnectorPolymarket, "_fetch_activity")
    def test_no_synthetic_for_open_position(self, mock_fetch, mock_gamma):
        """Unresolved market (Gamma closed=false) → no synthetic."""
        mock_fetch.return_value = [_trade_buy()]

        def gamma_side_effect(condition_ids):
            c._gamma_cache["0xabc"] = {
                "closed": False,
                "outcomePrices": '["0.5","0.5"]',
                "outcomes": '["Yes","No"]',
                "slug": "will-btc-hit-200k",
                "condition_id": "0xabc",
            }

        mock_gamma.side_effect = gamma_side_effect

        c = _make_connector()
        raws = list(c.yield_raws())
        assert len(raws) == 1

    @patch.object(ConnectorPolymarket, "_fetch_gamma_markets")
    @patch.object(ConnectorPolymarket, "_fetch_activity")
    def test_loser_closed_at_resolution_time(self, mock_fetch, mock_gamma):
        """Losing close is dated at Gamma closedTime, not right after the last trade."""
        mock_fetch.return_value = [
            _trade_buy(condition_id="0xabc")
        ]  # timestamp=1762301363

        def gamma_side_effect(condition_ids):
            self._setup_gamma(
                c, "0xabc", is_winner=False, closed_time="2025-11-08T00:00:00Z"
            )

        mock_gamma.side_effect = gamma_side_effect

        c = _make_connector()
        raws = list(c.yield_raws())
        synthetic = raws[1]
        assert synthetic["timestamp"] == CLOSED_2025_11_08

    @patch.object(ConnectorPolymarket, "_fetch_gamma_markets")
    @patch.object(ConnectorPolymarket, "_fetch_activity")
    def test_loser_without_resolution_time_falls_back_to_last_trade(self, mock_fetch, mock_gamma):
        """No Gamma closedTime → close 1s after the last trade."""
        mock_fetch.return_value = [_trade_buy(condition_id="0xother")]

        def gamma_side_effect(condition_ids):
            c._gamma_cache["0xother"] = {
                "closed": True,
                "outcomePrices": '["0","1"]',
                "outcomes": '["Yes","No"]',
                "slug": "will-btc-hit-200k",
                "question": "Will BTC hit 200k?",
                "condition_id": "0xother",
            }

        mock_gamma.side_effect = gamma_side_effect

        c = _make_connector()
        raws = list(c.yield_raws())
        synthetics = [r for r in raws if r.get("_synthetic")]
        assert len(synthetics) == 1
        assert synthetics[0]["timestamp"] == 1762301363 + 1

    @patch.object(ConnectorPolymarket, "_fetch_gamma_markets")
    @patch.object(ConnectorPolymarket, "_fetch_activity")
    def test_losing_redeem_is_memo_and_close_stays_at_resolution(self, mock_fetch, mock_gamma):
        """A 0-USDC REDEEM months later must not move the loss out of the resolution date."""
        mock_fetch.return_value = [
            _trade_buy(condition_id="0xabc"),
            dict(_redeem(usdc=0, shares=100, condition_id="0xabc"), timestamp=1776084057),
        ]

        def gamma_side_effect(condition_ids):
            self._setup_gamma(c, "0xabc", is_winner=False)

        mock_gamma.side_effect = gamma_side_effect

        c = _make_connector()
        raws = list(c.yield_raws())
        assert [r["type"] for r in raws] == ["TRADE", "REDEEM", "SYNTHETIC_CLOSE"]
        assert raws[2]["timestamp"] == CLOSED_2025_11_08
        assert raws[2]["price"] == 0


# ── Normalization Flow ─────────────────────────────────────────────


class TestNormalizationFlow:
    """End-to-end: yield_raws → raw_to_normalized produces correct NTs."""

    def _setup_gamma(
        self,
        connector,
        condition_id,
        is_winner,
        outcome="Yes",
        slug="will-btc-hit-200k",
        closed_time="2025-11-08T00:00:00Z",
    ):
        if is_winner:
            outcome_prices = '["1","0"]' if outcome == "Yes" else '["0","1"]'
        else:
            outcome_prices = '["0","1"]' if outcome == "Yes" else '["1","0"]'
        connector._gamma_cache[condition_id] = {
            "closed": True,
            "outcomePrices": outcome_prices,
            "outcomes": '["Yes","No"]',
            "slug": slug,
            "question": f"Market {slug}",
            "closedTime": closed_time,
            "condition_id": condition_id,
        }

    @patch.object(ConnectorPolymarket, "_fetch_gamma_markets")
    @patch.object(ConnectorPolymarket, "_fetch_activity")
    def test_buy_then_redeem_win_flow(self, mock_fetch, mock_gamma):
        """BUY 100 @ 0.60 → REDEEM 100 (win): resolution synthetic + memo REDEEM."""
        mock_fetch.return_value = [
            _trade_buy(usdc=60, shares=100, price=0.60, condition_id="0xabc"),
            {
                "type": "REDEEM",
                "side": "",
                "usdcSize": 100,
                "size": 100,
                "price": 0,
                "transactionHash": "0x333",
                "conditionId": "0xabc",
                "timestamp": 1772452383,
                "title": "Will BTC hit 200k?",
                "outcome": "",
                "outcomeIndex": 999,
                "slug": "will-btc-hit-200k",
                "eventSlug": "btc-200k",
                "asset": "",
            },
        ]
        mock_gamma.return_value = None

        c = _make_connector()
        raws = list(c.yield_raws())
        nts = [c.raw_to_normalized(r) for r in raws]

        assert len(nts) == 3  # BUY + resolution synthetic + REDEEM memo
        assert nts[0].direction == "inflow"
        assert nts[0].quantity == 100.0
        assert nts[0].price == 0.60
        assert nts[0].source_asset_symbol == "PM:will-btc-hit-200k-Yes"
        assert nts[1].direction == "outflow"
        assert nts[1].transaction_type == "trade"
        assert nts[1].source_transaction_type == "synthetic-close"
        assert nts[1].quantity == 100.0
        assert nts[1].price == 1.0
        assert nts[1].source_asset_symbol == "PM:will-btc-hit-200k-Yes"
        assert nts[2].direction == "neutral"
        assert nts[2].transaction_type == "memo"
        assert nts[2].source_transaction_type == "redeem"
        assert nts[2].quantity == 100.0
        assert nts[2].price == 1.0
        assert nts[2].source_asset_symbol == "PM:will-btc-hit-200k-Yes"

    @patch.object(ConnectorPolymarket, "_fetch_gamma_markets")
    @patch.object(ConnectorPolymarket, "_fetch_activity")
    def test_redeem_before_buy_keeps_close_on_outcome_asset(
        self, mock_fetch, mock_gamma
    ):
        """CLOB can return newest first; REDEEM close must still target the bought outcome asset."""
        mock_fetch.return_value = [
            _make_redeem_item(
                100,
                100,
                "0xabc",
                "0xredeem",
                "will-btc-hit-200k",
                ts=1772452383,
            ),
            _trade_buy(usdc=60, shares=100, price=0.60, condition_id="0xabc"),
        ]
        mock_gamma.return_value = None

        c = _make_connector()
        raws = list(c.yield_raws())
        nts = [c.raw_to_normalized(r) for r in raws]

        assert len(nts) == 3
        assert nts[0].source_transaction_type == "synthetic-close"
        assert nts[0].source_asset_symbol == "PM:will-btc-hit-200k-Yes"
        assert nts[1].source_transaction_type == "redeem"
        assert nts[1].source_asset_symbol == "PM:will-btc-hit-200k-Yes"
        assert nts[2].source_transaction_type == "buy"
        assert nts[2].source_asset_symbol == "PM:will-btc-hit-200k-Yes"

    @patch.object(ConnectorPolymarket, "_fetch_gamma_markets")
    @patch.object(ConnectorPolymarket, "_fetch_activity")
    def test_buy_then_synthetic_loss_flow(self, mock_fetch, mock_gamma):
        """BUY 100 @ 0.50 → synthetic close at price=0 (loss via Gamma)."""
        mock_fetch.return_value = [
            _trade_buy(usdc=50, shares=100, price=0.50, condition_id="0xdef"),
        ]

        def gamma_side_effect(condition_ids):
            self._setup_gamma(c, "0xdef", is_winner=False)

        mock_gamma.side_effect = gamma_side_effect

        c = _make_connector()
        raws = list(c.yield_raws())
        nts = [c.raw_to_normalized(r) for r in raws]

        assert len(nts) == 2
        assert nts[0].direction == "inflow"
        assert nts[0].price == 0.50
        assert nts[0].source_asset_symbol == "PM:will-btc-hit-200k-Yes"
        assert nts[1].direction == "outflow"
        assert nts[1].price == 0.0
        assert nts[1].quantity == 100.0
        assert nts[1].source_asset_symbol == "PM:will-btc-hit-200k-Yes"
        assert nts[1].source_transaction_type == "synthetic-close"

    @patch.object(ConnectorPolymarket, "_fetch_gamma_markets")
    @patch.object(ConnectorPolymarket, "_fetch_activity")
    def test_multiple_markets_independent(self, mock_fetch, mock_gamma):
        """Two markets: different asset symbols, synthetic only for loser."""
        buy_a = _trade_buy(
            usdc=60, shares=100, price=0.60, condition_id="0xA", tx_hash="0x1"
        )
        buy_a["slug"] = "market-a"
        buy_a["outcome"] = "Yes"

        buy_b = _trade_buy(
            usdc=50, shares=100, price=0.50, condition_id="0xB", tx_hash="0x2"
        )
        buy_b["slug"] = "market-b"
        buy_b["outcome"] = "No"

        mock_fetch.return_value = [buy_a, buy_b]

        def gamma_side_effect(condition_ids):
            # Only market-b lost (No outcome lost when Yes wins)
            c._gamma_cache["0xB"] = {
                "closed": True,
                "outcomePrices": '["1","0"]',
                "outcomes": '["Yes","No"]',
                "slug": "market-b",
                "question": "Market B",
                "closedTime": "2025-12-01T00:00:00Z",
                "condition_id": "0xB",
            }

        mock_gamma.side_effect = gamma_side_effect

        c = _make_connector()
        raws = list(c.yield_raws())
        nts = [c.raw_to_normalized(r) for r in raws]

        assert len(nts) == 3  # 2 buys + 1 synthetic
        assert nts[0].source_asset_symbol == "PM:market-a-Yes"
        assert nts[1].source_asset_symbol == "PM:market-b-No"
        assert nts[2].source_asset_symbol == "PM:market-b-No"
        assert nts[2].direction == "outflow"
        assert nts[2].price == 0.0


# ── Spec Test Matrix (Cases 3-7) ────────────────────────────────────


def _make_trade(
    side, usdc, shares, price, condition_id, tx_hash, slug, outcome, ts=1762301363
):
    """Helper to build trade items for spec test cases."""
    return {
        "type": "TRADE",
        "side": side,
        "usdcSize": usdc,
        "size": shares,
        "price": price,
        "transactionHash": tx_hash,
        "conditionId": condition_id,
        "timestamp": ts,
        "title": f"Market {slug}",
        "outcome": outcome,
        "outcomeIndex": 0,
        "slug": slug,
        "eventSlug": f"{slug}-event",
        "asset": "",
    }


def _make_redeem_item(usdc, shares, condition_id, tx_hash, slug, ts):
    return {
        "type": "REDEEM",
        "side": "",
        "usdcSize": usdc,
        "size": shares,
        "price": 0,
        "transactionHash": tx_hash,
        "conditionId": condition_id,
        "timestamp": ts,
        "title": f"Market {slug}",
        "outcome": "",
        "outcomeIndex": 999,
        "slug": slug,
        "eventSlug": f"{slug}-event",
        "asset": "",
    }


class TestSpecCases:
    """Spec test matrix: Cases 3-7 covering partial sell, full exit, and re-entry."""

    def _setup_gamma(
        self,
        connector,
        condition_id,
        is_winner,
        outcome="Yes",
        slug=None,
        closed_time="2025-11-08T00:00:00Z",
    ):
        if slug is None:
            slug = condition_id.replace("0x", "")
        if is_winner:
            outcome_prices = '["1","0"]' if outcome == "Yes" else '["0","1"]'
        else:
            outcome_prices = '["0","1"]' if outcome == "Yes" else '["1","0"]'
        connector._gamma_cache[condition_id] = {
            "closed": True,
            "outcomePrices": outcome_prices,
            "outcomes": '["Yes","No"]',
            "slug": slug,
            "question": f"Market {slug}",
            "closedTime": closed_time,
            "condition_id": condition_id,
        }

    @patch.object(ConnectorPolymarket, "_fetch_gamma_markets")
    @patch.object(ConnectorPolymarket, "_fetch_activity")
    def test_case3_partial_sell_plus_win(self, mock_fetch, mock_gamma):
        """BUY 100@0.40, SELL 40@0.70, RESOLVE YES, REDEEM 60 → RPnL = +48."""
        cid = "0xcase3"
        mock_fetch.return_value = [
            _make_trade("BUY", 40, 100, 0.40, cid, "0xb1", "case3", "Yes", ts=1000),
            _make_trade("SELL", 28, 40, 0.70, cid, "0xs1", "case3", "Yes", ts=2000),
            _make_redeem_item(60, 60, cid, "0xr1", "case3", ts=5000),
        ]

        def gamma_side_effect(condition_ids):
            self._setup_gamma(c, cid, is_winner=True, slug="case3")

        mock_gamma.side_effect = gamma_side_effect

        c = _make_connector()
        raws = list(c.yield_raws())
        nts = [c.raw_to_normalized(r) for r in raws]

        assert len(nts) == 4  # BUY + SELL + synthetic close + REDEEM memo
        assert nts[0].direction == "inflow"
        assert nts[0].quantity == 100.0
        assert nts[0].price == 0.40
        assert nts[1].direction == "outflow"
        assert nts[1].quantity == 40.0
        assert nts[1].price == 0.70
        assert nts[2].direction == "outflow"
        assert nts[2].source_transaction_type == "synthetic-close"
        assert nts[2].quantity == 60.0
        assert nts[2].price == 1.0
        assert raws[2]["timestamp"] == 5000 - 1
        assert nts[3].transaction_type == "memo"

    @patch.object(ConnectorPolymarket, "_fetch_gamma_markets")
    @patch.object(ConnectorPolymarket, "_fetch_activity")
    def test_case4_partial_sell_plus_loss(self, mock_fetch, mock_gamma):
        """BUY 100@0.40, SELL 40@0.70, RESOLVE NO → RPnL = -12."""
        cid = "0xcase4"
        mock_fetch.return_value = [
            _make_trade("BUY", 40, 100, 0.40, cid, "0xb2", "case4", "Yes", ts=1000),
            _make_trade("SELL", 28, 40, 0.70, cid, "0xs2", "case4", "Yes", ts=2000),
        ]

        def gamma_side_effect(condition_ids):
            self._setup_gamma(c, cid, is_winner=False, slug="case4")

        mock_gamma.side_effect = gamma_side_effect

        c = _make_connector()
        raws = list(c.yield_raws())
        nts = [c.raw_to_normalized(r) for r in raws]

        assert len(nts) == 3  # BUY + SELL + synthetic close at $0
        assert nts[2].direction == "outflow"
        assert nts[2].source_transaction_type == "synthetic-close"
        assert nts[2].quantity == 60.0
        assert nts[2].price == 0.0

    @patch.object(ConnectorPolymarket, "_fetch_gamma_markets")
    @patch.object(ConnectorPolymarket, "_fetch_activity")
    def test_case5_full_exit_no_synthetic(self, mock_fetch, mock_gamma):
        """BUY 100@0.40, SELL 100@0.60, RESOLVE YES → RPnL = +20, no synthetic (size=0)."""
        cid = "0xcase5"
        mock_fetch.return_value = [
            _make_trade("BUY", 40, 100, 0.40, cid, "0xb3", "case5", "Yes", ts=1000),
            _make_trade("SELL", 60, 100, 0.60, cid, "0xs3", "case5", "Yes", ts=2000),
        ]

        def gamma_side_effect(condition_ids):
            self._setup_gamma(c, cid, is_winner=True, slug="case5")

        mock_gamma.side_effect = gamma_side_effect

        c = _make_connector()
        raws = list(c.yield_raws())
        nts = [c.raw_to_normalized(r) for r in raws]

        # Net shares = 100 - 100 = 0 → synthetic has size=0. But we still generate it.
        # The PnL engine handles 0-quantity trades as no-ops.
        buys_sells = [n for n in nts if n.source_transaction_type in ("buy", "sell")]
        assert len(buys_sells) == 2
        assert buys_sells[0].direction == "inflow"
        assert buys_sells[1].direction == "outflow"
        assert buys_sells[1].quantity == 100.0
        assert buys_sells[1].price == 0.60

    @patch.object(ConnectorPolymarket, "_fetch_gamma_markets")
    @patch.object(ConnectorPolymarket, "_fetch_activity")
    def test_case6_reentry_after_full_exit(self, mock_fetch, mock_gamma):
        """BUY 100@0.40, SELL 100@0.60, BUY 100@0.70, RESOLVE YES, REDEEM → RPnL = +50."""
        cid = "0xcase6"
        mock_fetch.return_value = [
            _make_trade("BUY", 40, 100, 0.40, cid, "0xb4", "case6", "Yes", ts=1000),
            _make_trade("SELL", 60, 100, 0.60, cid, "0xs4", "case6", "Yes", ts=2000),
            _make_trade("BUY", 70, 100, 0.70, cid, "0xb5", "case6", "Yes", ts=3000),
            _make_redeem_item(100, 100, cid, "0xr5", "case6", ts=4000),
        ]

        def gamma_side_effect(condition_ids):
            self._setup_gamma(c, cid, is_winner=True, slug="case6")

        mock_gamma.side_effect = gamma_side_effect

        c = _make_connector()
        raws = list(c.yield_raws())
        nts = [c.raw_to_normalized(r) for r in raws]

        assert len(nts) == 5  # BUY + SELL + BUY + synthetic close at $1 + REDEEM memo
        assert nts[0].direction == "inflow"
        assert nts[0].price == 0.40
        assert nts[1].direction == "outflow"
        assert nts[1].price == 0.60
        assert nts[2].direction == "inflow"
        assert nts[2].price == 0.70
        assert nts[3].direction == "outflow"
        assert nts[3].source_transaction_type == "synthetic-close"
        assert nts[3].quantity == 100.0
        assert nts[3].price == 1.0

    @patch.object(ConnectorPolymarket, "_fetch_gamma_markets")
    @patch.object(ConnectorPolymarket, "_fetch_activity")
    def test_case7_redeem_no_pnl_impact(self, mock_fetch, mock_gamma):
        """BUY 100@0.40, RESOLVE YES, REDEEM → REDEEM is memo with $0 PnL impact."""
        cid = "0xcase7"
        mock_fetch.return_value = [
            _make_trade("BUY", 40, 100, 0.40, cid, "0xb6", "case7", "Yes", ts=1000),
            _make_redeem_item(100, 100, cid, "0xr6", "case7", ts=3000),
        ]
        mock_gamma.return_value = None  # REDEEM covers resolution

        c = _make_connector()
        raws = list(c.yield_raws())
        nts = [c.raw_to_normalized(r) for r in raws]

        # BUY + resolution synthetic + REDEEM memo
        assert len(nts) == 3
        assert nts[1].transaction_type == "trade"
        assert nts[1].direction == "outflow"
        assert nts[1].source_transaction_type == "synthetic-close"
        assert nts[1].price == 1.0
        assert nts[2].transaction_type == "memo"
        assert nts[2].direction == "neutral"
        assert nts[2].source_transaction_type == "redeem"


# ── Constructor ──────────────────────────────────────────────────────


class TestConstructor:
    def test_missing_wallet_raises(self):
        with pytest.raises(ValueError, match="Missing wallet address"):
            ConnectorPolymarket(wallet_address="", config={})


# ── Balance ──────────────────────────────────────────────────────────


class TestBalance:
    def test_balance_not_supported(self):
        """Position balances are not reported by the activity child."""
        c = _make_connector()
        assert c.supports_balance is False
        assert c.get_balance() == []


# ── Hub ──────────────────────────────────────────────────────────────


class TestHub:
    def test_hub_creates_children(self):
        from backend.connectors.onchain.connector_polymarket_hub import (
            ConnectorPolymarketHub,
        )

        hub = ConnectorPolymarketHub(
            wallet_address=WALLET,
            account_id=1,
            connector_id=1,
            config={"test_mode": True},
        )
        assert len(hub.child_connectors) == 2
        names = [name for name, _ in hub.child_connectors]
        assert "polymarket activity" in names
        assert "polymarket polygon transfers" in names

    def test_hub_missing_wallet_raises(self):
        from backend.connectors.onchain.connector_polymarket_hub import (
            ConnectorPolymarketHub,
        )

        with pytest.raises(ValueError, match="Missing wallet address"):
            ConnectorPolymarketHub(wallet_address="", config={"test_mode": True})

    def test_hub_propagates_test_file_path_to_activity_child(self):
        """Hub must pass test_file_path only to the activity child (not polygon)."""
        from backend.connectors.onchain.connector_polymarket_hub import (
            ConnectorPolymarketHub,
        )

        hub = ConnectorPolymarketHub(
            wallet_address=WALLET,
            account_id=1,
            connector_id=1,
            config={"test_mode": True, "test_file_path": "data/input/fixtures/42.json"},
        )
        activity_child = hub.child_connectors[0][1]  # polymarket activity
        polygon_child = hub.child_connectors[1][1]  # polymarket polygon transfers

        assert activity_child.config.get("test_mode") is True
        assert (
            activity_child.config.get("test_file_path") == "data/input/fixtures/42.json"
        )
        assert polygon_child.config.get("test_mode") is True
        assert polygon_child.config.get("test_file_path") is None

    def _hub_with_ankr_balance(self, assets):
        from backend.connectors.onchain.connector_polymarket_hub import (
            ConnectorPolymarketHub,
        )

        hub = ConnectorPolymarketHub(
            wallet_address=WALLET,
            account_id=1,
            connector_id=1,
            config={"test_mode": True},
        )
        polygon_child = hub.child_connectors[1][1]
        polygon_child.api_key = "k"
        return hub, patch.object(polygon_child, "_rpc", return_value={"assets": assets})

    def test_hub_balance_includes_wallet_cash(self):
        """Hub balance includes on-chain USDC.e cash from the Ankr Polygon child; other tokens ignored."""
        hub, rpc = self._hub_with_ankr_balance(
            [
                {
                    "tokenSymbol": "USDC",
                    "balance": "150.49",
                    "contractAddress": "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
                },
                {"tokenSymbol": "POL", "balance": "0.001", "contractAddress": ""},
            ]
        )
        with rpc:
            entries = hub.get_balance()

        assert len(entries) == 1
        assert entries[0].asset_symbol == "USDC"
        assert entries[0].total == Decimal("150.49")
        assert entries[0].chain == "polygon"
        assert entries[0].raw["source"] == "wallet_cash"

    def test_hub_balance_survives_child_error(self):
        hub, _ = self._hub_with_ankr_balance([])
        with patch.object(hub.child_connectors[1][1], "_rpc", side_effect=RuntimeError("down")):
            assert hub.get_balance() == []


# ── Test Mode (Fixture Loading) ─────────────────────────────────────


class TestTestMode:
    """Test mode: yield_raws loads fixture JSON, builds condition→outcome map,
    and _yield_raws delegates properly — no live API calls."""

    FIXTURE_DATA = [
        {
            "type": "TRADE",
            "side": "BUY",
            "usdcSize": 60,
            "size": 100,
            "price": 0.60,
            "transactionHash": "0xbuy1",
            "conditionId": "0xcond_a",
            "timestamp": 1728993600,
            "title": "Rain Friday?",
            "outcome": "Yes",
            "outcomeIndex": 0,
            "slug": "rain-friday",
            "eventSlug": "rain-friday-event",
            "asset": "tok_a",
        },
        {
            "type": "TRADE",
            "side": "BUY",
            "usdcSize": 100,
            "size": 200,
            "price": 0.50,
            "transactionHash": "0xbuy2",
            "conditionId": "0xcond_b",
            "timestamp": 1728993600,
            "title": "ETH 5k?",
            "outcome": "Yes",
            "outcomeIndex": 0,
            "slug": "eth-5k",
            "eventSlug": "eth-5k-event",
            "asset": "tok_b",
        },
        {
            "type": "REDEEM",
            "side": "",
            "usdcSize": 100,
            "size": 100,
            "price": 0,
            "transactionHash": "0xredeem1",
            "conditionId": "0xcond_a",
            "timestamp": 1731024000,
            "title": "Rain Friday?",
            "outcome": "",
            "outcomeIndex": 999,
            "slug": "rain-friday",
            "eventSlug": "rain-friday-event",
            "asset": "",
        },
        {
            "type": "SYNTHETIC_CLOSE",
            "side": "CLOSE",
            "usdcSize": 0,
            "size": 200,
            "price": 0,
            "transactionHash": "synthetic_0xcond_b",
            "conditionId": "0xcond_b",
            "timestamp": 1731024000,
            "title": "ETH 5k?",
            "outcome": "Yes",
            "outcomeIndex": 0,
            "slug": "eth-5k",
            "eventSlug": "eth-5k-event",
            "asset": "",
            "_synthetic": True,
        },
    ]

    def _make_test_connector(self, tmp_path):
        """Create connector in test mode with fixture written to tmp_path."""
        import json

        fixture_file = tmp_path / "polymarket.json"
        fixture_file.write_text(json.dumps(self.FIXTURE_DATA))
        return ConnectorPolymarket(
            wallet_address=WALLET,
            account_id=1,
            connector_id=1,
            config={"test_mode": True, "test_file_path": str(fixture_file)},
        )

    def test_yield_raws_loads_fixture(self, tmp_path):
        """yield_raws with test_mode=True loads JSON fixture instead of calling API."""
        c = self._make_test_connector(tmp_path)
        raws = list(c.yield_raws())
        # 4 fixture items + 1 resolution synthetic generated before the REDEEM
        assert len(raws) == 5

    def test_no_api_calls_in_test_mode(self, tmp_path):
        """Ensure Data API/Gamma APIs are never called when test_mode=True."""
        c = self._make_test_connector(tmp_path)
        with (
            patch.object(c, "_data_api_request") as mock_data_api,
            patch.object(c, "_gamma_request") as mock_gamma,
        ):
            list(c.yield_raws())
            mock_data_api.assert_not_called()
            mock_gamma.assert_not_called()

    def test_condition_outcome_map_built(self, tmp_path):
        """Fixture loading must build _condition_outcome_map from BUY items."""
        c = self._make_test_connector(tmp_path)
        list(c.yield_raws())
        assert c._condition_outcome_map == {
            "0xcond_a": "Yes",
            "0xcond_b": "Yes",
        }

    def test_redeemed_conditions_tracked(self, tmp_path):
        """Fixture loading must track which conditionIds had a REDEEM."""
        c = self._make_test_connector(tmp_path)
        list(c.yield_raws())
        assert "0xcond_a" in c._redeemed_conditions

    def test_redeem_outcome_resolved_from_map(self, tmp_path):
        """REDEEM items (outcome='') get resolved via condition_outcome_map."""
        c = self._make_test_connector(tmp_path)
        raws = list(c.yield_raws())
        # Index 3 is the REDEEM (index 2 is the resolution synthetic)
        redeem_raw = raws[3]
        assert redeem_raw["type"] == "REDEEM"
        assert redeem_raw["outcome"] == ""  # Raw fixture has empty outcome
        nt = c.raw_to_normalized(redeem_raw)
        assert nt.source_asset_symbol == "PM:rain-friday-Yes"  # Resolved!

    def test_all_items_normalize_correctly(self, tmp_path):
        """Full fixture → normalize pipeline: correct symbols, directions, prices."""
        c = self._make_test_connector(tmp_path)
        raws = list(c.yield_raws())
        nts = [c.raw_to_normalized(r) for r in raws]

        # 5 items: BUY, BUY, resolution synthetic, REDEEM memo, SYNTHETIC_CLOSE
        assert len(nts) == 5

        # BUY → inflow
        assert nts[0].source_asset_symbol == "PM:rain-friday-Yes"
        assert nts[0].direction == "inflow"
        assert nts[0].quantity == 100.0
        assert nts[0].price == 0.60

        # BUY → inflow
        assert nts[1].source_asset_symbol == "PM:eth-5k-Yes"
        assert nts[1].direction == "inflow"
        assert nts[1].quantity == 200.0

        # Resolution synthetic (generated from REDEEM) → outflow at $1.00
        assert nts[2].source_asset_symbol == "PM:rain-friday-Yes"
        assert nts[2].direction == "outflow"
        assert nts[2].transaction_type == "trade"
        assert nts[2].source_transaction_type == "synthetic-close"
        assert nts[2].price == 1.0

        # REDEEM → memo (audit-only)
        assert nts[3].source_asset_symbol == "PM:rain-friday-Yes"
        assert nts[3].direction == "neutral"
        assert nts[3].transaction_type == "memo"
        assert nts[3].price == 1.0

        # Synthetic CLOSE (loser) → outflow at $0
        assert nts[4].source_asset_symbol == "PM:eth-5k-Yes"
        assert nts[4].direction == "outflow"
        assert nts[4].price == 0.0
        assert nts[4].source_transaction_type == "synthetic-close"

    def test_yield_raws_via_yield_raws_wrapper(self, tmp_path):
        """_yield_raws() in test mode must also go through yield_raws() (not base class shortcut)."""
        c = self._make_test_connector(tmp_path)
        raws = list(c._yield_raws())
        # 4 fixture items + 1 resolution synthetic = 5
        assert len(raws) == 5
        # Condition map must be populated (proves yield_raws() was called, not base shortcut)
        assert len(c._condition_outcome_map) == 2

    def test_missing_fixture_yields_nothing(self, tmp_path):
        """If fixture file doesn't exist, yield_raws returns empty."""
        c = ConnectorPolymarket(
            wallet_address=WALLET,
            account_id=1,
            connector_id=1,
            config={
                "test_mode": True,
                "test_file_path": str(tmp_path / "missing.json"),
            },
        )
        raws = list(c.yield_raws())
        assert raws == []


# ── Data API v2 ─────────────────────────────────────────────────────


class TestDataApi:
    """Data API v2 activity → connector raw format, pagination and filtering."""

    V2_TRADE = {
        "proxy_wallet": WALLET,
        "timestamp": 1762301363,
        "condition_id": "0xcond_abc",
        "type": "TRADE",
        "size": 625.0,
        "usdc_size": 25.0,
        "transaction_hash": "0xd521",
        "price": 0.04,
        "token_id": "93079906",
        "side": "BUY",
        "outcome_index": 1,
        "title": "Will X win?",
        "slug": "will-x-win",
        "event_slug": "x-event",
        "outcome": "No",
    }

    def test_activity_to_raw_trade(self):
        raw = ConnectorPolymarket._activity_to_raw(self.V2_TRADE)
        assert raw == {
            "type": "TRADE",
            "side": "BUY",
            "size": 625.0,
            "price": 0.04,
            "usdcSize": 25.0,
            "transactionHash": "0xd521",
            "conditionId": "0xcond_abc",
            "timestamp": 1762301363,
            "title": "Will X win?",
            "outcome": "No",
            "outcomeIndex": 1,
            "slug": "will-x-win",
            "eventSlug": "x-event",
            "asset": "93079906",
        }

    def test_trade_source_transaction_id_is_tx_hash_and_condition(self):
        nt = _make_connector().raw_to_normalized(
            ConnectorPolymarket._activity_to_raw(self.V2_TRADE)
        )
        assert nt.source_transaction_id == "0xd521_0xcond_abc"
        assert nt.source_asset_symbol == "PM:will-x-win-No"

    def test_fetch_activity_paginates_filters_and_sorts(self):
        redeem = dict(self.V2_TRADE, type="REDEEM", side="", timestamp=1762400000, transaction_hash="0xr")
        reward = dict(self.V2_TRADE, type="REWARD", timestamp=1762300000)
        pages = [
            {"data": [redeem, reward], "pagination": {"has_more": True, "next_cursor": "c1"}},
            {"data": [self.V2_TRADE], "pagination": {"has_more": False, "next_cursor": None}},
        ]
        c = _make_connector()
        with patch.object(c, "_data_api_request", side_effect=pages) as req:
            items = c._fetch_activity()

        assert [i["type"] for i in items] == ["TRADE", "REDEEM"]
        assert req.call_args_list[0].args == ("/activity", {"user": WALLET, "limit": 500})
        assert req.call_args_list[1].args[1]["cursor"] == "c1"

    @patch.object(ConnectorPolymarket, "_fetch_gamma_markets")
    @patch.object(ConnectorPolymarket, "_fetch_activity")
    def test_winning_close_dated_just_before_redeem(self, mock_fetch, mock_gamma):
        """Winning shares are realized when exchanged for USDC (the paid REDEEM)."""
        mock_fetch.return_value = [
            _trade_buy(condition_id="0xabc"),  # timestamp=1762301363
            dict(_redeem(condition_id="0xabc"), timestamp=1776084057),
        ]
        raws = list(_make_connector().yield_raws())
        synthetic = next(r for r in raws if r.get("_synthetic"))
        assert synthetic["timestamp"] == 1776084057 - 1

    def test_parse_closed_time_formats(self):
        assert _parse_closed_time("2025-11-08 00:00:00+00") == CLOSED_2025_11_08
        assert _parse_closed_time("2025-11-08T00:00:00Z") == CLOSED_2025_11_08
        assert _parse_closed_time("") is None
        assert _parse_closed_time("not a date") is None

    def test_fetch_resolution_times_batches_gamma(self):
        c = _make_connector()
        c._gamma_cache = {f"0x{i}": {"closed": True} for i in range(25)}
        responses = [
            [{"conditionId": "0x1", "closedTime": "2025-11-08 00:00:00+00"}],
            [{"conditionId": "0x24", "closedTime": "2025-12-01 07:23:00+00"}],
        ]
        with patch.object(c, "_gamma_request", side_effect=responses) as req:
            c._fetch_resolution_times(list(c._gamma_cache))
        assert req.call_count == 2
        assert len(req.call_args_list[0].args[1]["condition_ids"]) == 20
        assert req.call_args_list[0].args[1]["closed"] == "true"
        assert c._gamma_cache["0x1"]["closedTime"] == "2025-11-08 00:00:00+00"
        assert c._gamma_cache["0x24"]["closedTime"] == "2025-12-01 07:23:00+00"
        assert "closedTime" not in c._gamma_cache["0x2"]

    def test_no_credentials_needed(self):
        c = ConnectorPolymarket(wallet_address=WALLET, account_id=1, connector_id=1, config={})
        assert not hasattr(c, "clob_api_key")


# ── Gamma Token Mapping ─────────────────────────────────────────────


class TestGammaTokenMapping:
    """Gamma market data → token_id → (slug, outcome) mapping."""

    def test_build_token_map_from_market(self):
        c = _make_connector()
        market = {
            "slug": "rain-friday",
            "clobTokenIds": '["token_yes_123", "token_no_456"]',
            "outcomes": '["Yes", "No"]',
        }
        c._build_token_map(market)
        assert c._token_outcome_map["token_yes_123"] == ("rain-friday", "Yes")
        assert c._token_outcome_map["token_no_456"] == ("rain-friday", "No")

    def test_build_token_map_list_format(self):
        """Gamma sometimes returns lists instead of JSON strings."""
        c = _make_connector()
        market = {
            "slug": "eth-5k",
            "clobTokenIds": ["tok_a", "tok_b"],
            "outcomes": ["Yes", "No"],
        }
        c._build_token_map(market)
        assert c._token_outcome_map["tok_a"] == ("eth-5k", "Yes")

    def test_build_token_map_empty_gracefully(self):
        c = _make_connector()
        c._build_token_map({"slug": "x", "clobTokenIds": "", "outcomes": ""})
        assert len(c._token_outcome_map) == 0

    def test_enrich_with_gamma(self):
        """Token in _token_outcome_map → slug and outcome injected into raw item."""
        c = _make_connector()
        c._token_outcome_map = {"tok_abc": ("rain-friday", "Yes")}
        c._gamma_cache = {
            "0xcond": {
                "question": "Will it rain?",
                "slug": "rain-friday",
            }
        }
        item = {
            "asset": "tok_abc",
            "conditionId": "0xcond",
            "slug": "",
            "outcome": "",
            "title": "",
            "eventSlug": "",
        }
        c._enrich_with_gamma(item)
        assert item["slug"] == "rain-friday"
        assert item["outcome"] == "Yes"
        assert item["title"] == "Will it rain?"

    def test_enrich_without_gamma_data_preserves_existing(self):
        """If no Gamma data, existing slug/outcome untouched."""
        c = _make_connector()
        item = {
            "asset": "unknown",
            "conditionId": "missing",
            "slug": "original",
            "outcome": "No",
            "title": "Orig",
            "eventSlug": "e",
        }
        c._enrich_with_gamma(item)
        assert item["slug"] == "original"
        assert item["outcome"] == "No"
