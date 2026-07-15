"""
Unit tests for NEAR Protocol connector — critical normalization logic.
Uses fixture data (no API key needed).
"""

import pytest
from decimal import Decimal

from backend.connectors.onchain.near.connector_near_txns import ConnectorNearTxns
from backend.connectors.onchain.near.connector_near_ft_txns import ConnectorNearFtTxns
from backend.connectors.onchain.near.connector_near_hub import ConnectorNearHub


WALLET = "beefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef"


def _make_txns(wallet=WALLET):
    return ConnectorNearTxns(
        wallet_address=wallet, account_id=1, connector_id=1, config={"test_mode": True}
    )


def _make_ft(wallet=WALLET):
    return ConnectorNearFtTxns(
        wallet_address=wallet, account_id=1, connector_id=1, config={"test_mode": True}
    )


# ── Native transactions ─────────────────────────────────────────────


class TestNearNativeTxns:
    """Critical normalization tests for native NEAR transfers."""

    def test_inflow_direction_and_amount(self):
        """Inflow: wallet is receiver → direction=inflow, correct NEAR amount, no fee."""
        c = _make_txns()
        raws = list(c.yield_raws())
        norm = list(c.raw_to_normalized(raws[0]))  # alice.near → wallet, 5 NEAR

        transfers = [t for t in norm if t.transaction_type == "transfer"]
        fees = [t for t in norm if t.transaction_type == "cost"]

        assert len(transfers) == 1
        assert transfers[0].direction == "inflow"
        assert transfers[0].quantity == Decimal(5)
        assert transfers[0].source_asset_symbol == "NEAR"
        assert transfers[0].network == "near"
        assert len(fees) == 0  # wallet didn't sign

    def test_outflow_with_fee(self):
        """Outflow: wallet is signer → direction=outflow, separate fee tx."""
        c = _make_txns()
        raws = list(c.yield_raws())
        norm = list(c.raw_to_normalized(raws[1]))  # wallet → bob.near, 2 NEAR

        transfers = [t for t in norm if t.transaction_type == "transfer"]
        fees = [t for t in norm if t.transaction_type == "cost"]

        assert len(transfers) == 1
        assert transfers[0].direction == "outflow"
        assert transfers[0].quantity == Decimal(2)
        assert len(fees) == 1
        assert fees[0].quantity > 0  # New COST format: fee amount in qty
        assert fees[0].price == Decimal(1)
        assert fees[0].include_fee is False

    def test_failed_tx_skipped(self):
        """Failed transactions must produce zero normalized output."""
        c = _make_txns()
        raws = list(c.yield_raws())
        norm = list(c.raw_to_normalized(raws[3]))  # status=false

        assert len(norm) == 0

    def test_function_call_deposit_fallback(self):
        """Non-TRANSFER action with deposit uses actions_agg fallback."""
        c = _make_txns()
        raws = list(c.yield_raws())
        norm = list(c.raw_to_normalized(raws[4]))  # FUNCTION_CALL, 10 NEAR deposit

        transfers = [t for t in norm if t.transaction_type == "transfer"]
        assert len(transfers) == 1
        assert transfers[0].quantity == Decimal(10)
        assert transfers[0].direction == "outflow"


# ── FT transfers ─────────────────────────────────────────────────────


class TestNearFtTxns:
    """Critical normalization tests for NEAR FT (NEP-141) transfers."""

    def test_ft_inflow(self):
        """Positive delta_amount → inflow with correct decimals and contract."""
        c = _make_ft()
        raws = list(c.yield_raws())
        norm = list(c.raw_to_normalized(raws[0]))  # USDT inflow

        assert len(norm) == 1
        assert norm[0].direction == "inflow"
        assert norm[0].source_asset_symbol == "USDT"
        assert norm[0].token_contract_address == "usdt.tether-token.near"
        assert norm[0].quantity == Decimal("5000000000000000000") / Decimal(10**6)

    def test_ft_outflow(self):
        """Negative delta_amount → outflow with absolute quantity."""
        c = _make_ft()
        raws = list(c.yield_raws())
        norm = list(c.raw_to_normalized(raws[1]))  # USDT outflow

        assert len(norm) == 1
        assert norm[0].direction == "outflow"
        assert norm[0].quantity == Decimal("2000000000000000000") / Decimal(10**6)

    def test_zero_delta_skipped(self):
        """Zero delta_amount transfers must be skipped."""
        c = _make_ft()
        raws = list(c.yield_raws())
        norm = list(c.raw_to_normalized(raws[3]))  # delta_amount=0

        assert len(norm) == 0


# ── Hub ──────────────────────────────────────────────────────────────


class TestNearHub:
    """Critical hub connector tests."""

    def test_hub_creates_two_children(self):
        hub = ConnectorNearHub(
            wallet_address=WALLET,
            account_id=1,
            connector_id=1,
            config={"test_mode": True},
        )
        assert len(hub.child_connectors) == 2

    def test_missing_wallet_raises(self):
        with pytest.raises(ValueError, match="Missing wallet address"):
            ConnectorNearHub(wallet_address="", config={"test_mode": True})
