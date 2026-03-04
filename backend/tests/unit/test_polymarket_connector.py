"""
Unit tests for Polymarket connector — critical normalization, balance, and hub logic.
"""

import pytest
from decimal import Decimal
from unittest.mock import patch

from backend.connectors.onchain.connector_polymarket import ConnectorPolymarket


WALLET = "0x6f5E6579Cd9F9eaB734674e33dE4f41A33ae27DE"


def _make_connector(wallet=WALLET):
    return ConnectorPolymarket(
        wallet_address=wallet, account_id=1, connector_id=1, config={}
    )


def _trade_buy(usdc=10, shares=100, price=0.10, condition_id="0xabc", tx_hash="0x111"):
    return {
        "type": "TRADE", "side": "BUY", "usdcSize": usdc, "size": shares,
        "price": price, "transactionHash": tx_hash, "conditionId": condition_id,
        "timestamp": 1762301363, "title": "Will BTC hit 200k?", "outcome": "Yes",
        "outcomeIndex": 0, "slug": "will-btc-hit-200k", "eventSlug": "btc-200k",
        "asset": "12345",
    }


def _trade_sell(usdc=15, shares=100, price=0.15, condition_id="0xdef", tx_hash="0x222"):
    item = _trade_buy(usdc=usdc, shares=shares, price=price, condition_id=condition_id, tx_hash=tx_hash)
    item["side"] = "SELL"
    return item


def _redeem(usdc=50, shares=50, condition_id="0xghi", tx_hash="0x333"):
    return {
        "type": "REDEEM", "side": "", "usdcSize": usdc, "size": shares,
        "price": 0, "transactionHash": tx_hash, "conditionId": condition_id,
        "timestamp": 1772452383, "title": "Will Israel strike Gaza on November 8?",
        "outcome": "", "outcomeIndex": 999,
        "slug": "will-israel-strike-gaza-on-november-8",
        "eventSlug": "will-israel-strike-gaza-on-379", "asset": "",
    }


# ── Normalization ────────────────────────────────────────────────────


class TestNormalization:
    """All activity types produce trade-type single-leg USDC movements."""

    def test_buy_is_trade_outflow(self):
        norm = _make_connector().raw_to_normalized(_trade_buy())
        assert norm.transaction_type == "trade"
        assert norm.direction == "outflow"
        assert norm.source_transaction_type == "buy"
        assert norm.source_asset_symbol == "USDC"

    def test_sell_is_trade_inflow(self):
        norm = _make_connector().raw_to_normalized(_trade_sell())
        assert norm.transaction_type == "trade"
        assert norm.direction == "inflow"
        assert norm.source_transaction_type == "sell"

    def test_redeem_is_trade_inflow(self):
        norm = _make_connector().raw_to_normalized(_redeem())
        assert norm.transaction_type == "trade"
        assert norm.direction == "inflow"
        assert norm.source_transaction_type == "redeem"

    def test_buy_quantity(self):
        norm = _make_connector().raw_to_normalized(_trade_buy(usdc=19.999999))
        assert norm.quantity == float(Decimal("19.999999"))

    def test_buy_from_to(self):
        """Outflow: from=wallet, to=polymarket."""
        norm = _make_connector().raw_to_normalized(_trade_buy())
        assert norm.source_from_account == WALLET
        assert norm.source_to_account == "polymarket"

    def test_sell_from_to(self):
        """Inflow: from=polymarket, to=wallet."""
        norm = _make_connector().raw_to_normalized(_trade_sell())
        assert norm.source_from_account == "polymarket"
        assert norm.source_to_account == WALLET

    def test_redeem_from_to(self):
        """Inflow: from=polymarket, to=wallet."""
        norm = _make_connector().raw_to_normalized(_redeem())
        assert norm.source_from_account == "polymarket"
        assert norm.source_to_account == WALLET

    def test_source_transaction_id_includes_condition(self):
        norm = _make_connector().raw_to_normalized(_trade_buy(tx_hash="0xAAA", condition_id="0xBBB"))
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


# ── Constructor ──────────────────────────────────────────────────────


class TestConstructor:

    def test_missing_wallet_raises(self):
        with pytest.raises(ValueError, match="Missing wallet address"):
            ConnectorPolymarket(wallet_address="", config={})


# ── Balance ──────────────────────────────────────────────────────────


class TestBalance:

    @patch.object(ConnectorPolymarket, "_safe_request")
    def test_positions_summed(self, mock_req):
        mock_req.return_value = [
            {"size": 50, "currentValue": 40, "avgPrice": 0.5, "curPrice": 0.8,
             "cashPnl": 0, "percentPnl": 0, "redeemable": False,
             "title": "A", "outcome": "Yes", "endDate": "", "conditionId": "0x1"},
            {"size": 30, "currentValue": 60, "avgPrice": 0.3, "curPrice": 2.0,
             "cashPnl": 0, "percentPnl": 0, "redeemable": False,
             "title": "B", "outcome": "No", "endDate": "", "conditionId": "0x2"},
        ]
        entries = _make_connector().get_balance()
        assert len(entries) == 1
        assert entries[0].asset_symbol == "USDC"
        assert entries[0].total == Decimal("100")
        assert entries[0].chain == "polygon"

    @patch.object(ConnectorPolymarket, "_safe_request")
    def test_empty_positions(self, mock_req):
        mock_req.return_value = []
        assert _make_connector().get_balance() == []


# ── Hub ──────────────────────────────────────────────────────────────


class TestHub:

    def test_hub_creates_children(self):
        from backend.connectors.onchain.connector_polymarket_hub import ConnectorPolymarketHub
        hub = ConnectorPolymarketHub(
            wallet_address=WALLET, account_id=1, connector_id=1,
            config={"test_mode": True},
        )
        assert len(hub.child_connectors) == 2
        names = [name for name, _ in hub.child_connectors]
        assert "polymarket activity" in names
        assert "polymarket polygon transfers" in names

    def test_hub_missing_wallet_raises(self):
        from backend.connectors.onchain.connector_polymarket_hub import ConnectorPolymarketHub
        with pytest.raises(ValueError, match="Missing wallet address"):
            ConnectorPolymarketHub(wallet_address="", config={"test_mode": True})
