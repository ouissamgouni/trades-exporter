"""
Unit tests for cash-in-lieu and fee attribution fallback in group_handler.

Tests cover:
- _handle_cash_in_lieu: forced disposal of fractional shares + cash cost lot
- _determine_related_asset_for_fee: fallback to attributed_asset_id
"""

from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import Mock, patch

import pytest

from backend.services.pnl.group_handler import (
    _determine_related_asset_for_fee,
    _handle_cash_in_lieu,
    handle_unit,
)
from backend.services.pnl.lot_manager import LotManager
from backend.services.pnl.fmv_service import FMVService
from backend.services.pnl.config import PnLConfig, CostMethod, LotMode
from backend.db.models import LegType

from tests.unit.pnl.conftest import (
    make_transaction,
    make_leg,
    make_unit,
    create_lot,
    seed_lot,
    ASSET_SYMBOL_MAP,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

BASE_DT = datetime(2025, 1, 15, 10, 0, 0, tzinfo=timezone.utc)
APTIV_ASSET_ID = 9  # not in default price map — added per test


def _make_config():
    return PnLConfig(
        lot_method=CostMethod.FIFO,
        lot_mode=LotMode.LOT_TRAVEL,
        base_currency_id=1,
        base_currency_symbol="EUR",
        residual_tolerance_pct=Decimal("0.05"),
        allow_negative_balances=False,
    )


def _make_fmv_service(prices: dict):
    """Build FMVService with a mock price service using the given prices dict."""
    service = Mock()

    def get_price(asset_id, dt=None, price_quote=None):
        return prices.get(asset_id, Decimal("10"))

    def get_price_with_fallback(asset_id, dt=None, price_quote=None, **kwargs):
        from types import SimpleNamespace
        price = prices.get(asset_id, Decimal("10"))
        return SimpleNamespace(
            price=price, source="price_service", actual_price_date=dt,
            is_fallback=False, is_stale=False, staleness_days=0,
        )

    service.get_price = Mock(side_effect=get_price)
    service.get_price_with_fallback = Mock(side_effect=get_price_with_fallback)

    config = _make_config()
    return FMVService(service, config)


def _make_cash_in_lieu_unit(
    cash_amount: Decimal,
    parent_asset_id: int,
    account_id: int = 1,
    dt: datetime = None,
):
    """Create a CalculationUnit representing a cash-in-lieu corporate action."""
    dt = dt or BASE_DT

    tx = make_transaction(
        id=100,
        asset_id=1,  # EUR (cash received)
        quantity=cash_amount,
        account_id=account_id,
        date_time=dt,
    )
    tx.source_transaction_type = "cash_in_lieu"
    tx.transaction_type = "trade"
    tx.attributed_asset_id = parent_asset_id

    leg = make_leg(
        asset_id=1,
        leg_type=LegType.INFLOW,
        quantity=cash_amount,
        transaction=tx,
    )

    unit = make_unit(
        legs=[leg],
        pattern="flow",
        unit_label=f"Cash-in-lieu {cash_amount} EUR",
    )
    unit.version_id = 1
    return unit


# ---------------------------------------------------------------------------
# Tests: _determine_related_asset_for_fee — attributed_asset_id fallback
# ---------------------------------------------------------------------------


class TestFeeAttributionFallback:
    """Test that standalone fee units use attributed_asset_id as related_asset."""

    def test_fallback_to_attributed_asset_id(self):
        """ADR custody fee with no non-fee legs → related_asset_id = attributed_asset_id."""
        tx = make_transaction(id=50, asset_id=1, quantity=Decimal("0"))
        tx.attributed_asset_id = 5  # AAPL

        fee_leg = make_leg(
            asset_id=1,  # EUR fee
            leg_type=LegType.FEE,
            quantity=Decimal("2.50"),
            transaction=tx,
        )
        unit = make_unit(legs=[fee_leg], pattern="flow")

        result = _determine_related_asset_for_fee(
            unit=unit, base_currency_id=1, fee_asset_id=1,
        )
        assert result == 5

    def test_fallback_returns_none_when_no_attributed(self):
        """Standalone fee with no attributed_asset_id → None."""
        tx = make_transaction(id=51, asset_id=1, quantity=Decimal("0"))

        fee_leg = make_leg(
            asset_id=1,
            leg_type=LegType.FEE,
            quantity=Decimal("1.00"),
            transaction=tx,
        )
        unit = make_unit(legs=[fee_leg], pattern="flow")

        result = _determine_related_asset_for_fee(
            unit=unit, base_currency_id=1, fee_asset_id=1,
        )
        assert result is None

    def test_non_fee_legs_still_preferred(self):
        """When non-fee, non-base legs exist, use them (not the fallback)."""
        tx = make_transaction(id=52, asset_id=5, quantity=Decimal("10"))
        tx.attributed_asset_id = 99  # should NOT be used

        outflow_leg = make_leg(
            asset_id=5,  # AAPL outflow
            leg_type=LegType.OUTFLOW,
            quantity=Decimal("10"),
            transaction=tx,
        )
        fee_leg = make_leg(
            asset_id=1,
            leg_type=LegType.FEE,
            quantity=Decimal("1.00"),
            transaction=tx,
        )
        unit = make_unit(legs=[outflow_leg, fee_leg], pattern="swap")

        result = _determine_related_asset_for_fee(
            unit=unit, base_currency_id=1, fee_asset_id=1,
        )
        assert result == 5  # AAPL from the outflow, NOT 99

    def test_multiple_fee_legs_first_attributed_wins(self):
        """Multiple fee legs — first with attributed_asset_id is used."""
        tx1 = make_transaction(id=60, asset_id=1, quantity=Decimal("0"))
        # no attributed_asset_id on tx1

        tx2 = make_transaction(id=61, asset_id=1, quantity=Decimal("0"))
        tx2.attributed_asset_id = 5

        fee1 = make_leg(asset_id=1, leg_type=LegType.FEE, quantity=Decimal("1"), transaction=tx1)
        fee2 = make_leg(asset_id=1, leg_type=LegType.FEE, quantity=Decimal("2"), transaction=tx2)
        unit = make_unit(legs=[fee1, fee2], pattern="flow")

        result = _determine_related_asset_for_fee(unit=unit, base_currency_id=1, fee_asset_id=1)
        assert result == 5


# ---------------------------------------------------------------------------
# Tests: _handle_cash_in_lieu
# ---------------------------------------------------------------------------


class TestHandleCashInLieu:
    """Test the cash-in-lieu PnL handler."""

    @patch("backend.services.pnl.group_handler._handle_acquisition")
    def test_basic_cash_in_lieu_disposal(self, mock_acq):
        """Cash-in-lieu consumes parent lots and creates RealizedPnl."""
        prices = {1: Decimal("1"), APTIV_ASSET_ID: Decimal("150")}
        config = _make_config()
        lot_manager = LotManager(config)
        fmv_service = _make_fmv_service(prices)

        # Seed an APTIV lot (10 shares @ 120 EUR)
        from tests.unit.pnl.conftest import make_asset
        aptiv_lot = create_lot(
            asset_id=APTIV_ASSET_ID,
            account_id=1,
            qty=Decimal("10"),
            unit_cost=Decimal("120"),
            acquired_at=datetime(2024, 6, 1, tzinfo=timezone.utc),
        )
        aptiv_lot.asset = make_asset(APTIV_ASSET_ID, "APTIV")
        seed_lot(lot_manager, aptiv_lot)

        unit = _make_cash_in_lieu_unit(
            cash_amount=Decimal("6.14"),
            parent_asset_id=APTIV_ASSET_ID,
        )

        _handle_cash_in_lieu(unit, lot_manager, fmv_service, config)

        # Should create one RealizedPnl
        assert unit.realized_pnl_records is not None
        assert len(unit.realized_pnl_records) == 1

        rpnl = unit.realized_pnl_records[0]
        assert rpnl.asset_id == APTIV_ASSET_ID
        assert rpnl.disposal_taxable is True

        # Fractional qty = 6.14 / 150 ≈ 0.04093...
        expected_qty = Decimal("6.14") / Decimal("150")
        assert abs(rpnl.qty - expected_qty) < Decimal("0.0001")

        # Proceeds = cash in base = 6.14
        assert rpnl.proceeds_in_base == Decimal("6.14")

        # Cost basis = fractional_qty * 120 (unit cost of lot)
        expected_cost = expected_qty * Decimal("120")
        assert abs(rpnl.cost_basis_in_base - expected_cost) < Decimal("0.01")

        # Gain = proceeds - cost
        assert abs(rpnl.pnl_in_base - (Decimal("6.14") - expected_cost)) < Decimal("0.01")

        # _handle_acquisition called for cash cost lot
        mock_acq.assert_called_once()

    @patch("backend.services.pnl.group_handler._handle_acquisition")
    def test_cash_in_lieu_holding_period(self, mock_acq):
        """RealizedPnl.acquired_at should match the parent lot's acquired_at."""
        original_acquired = datetime(2023, 3, 15, tzinfo=timezone.utc)
        prices = {1: Decimal("1"), APTIV_ASSET_ID: Decimal("100")}
        config = _make_config()
        lot_manager = LotManager(config)
        fmv_service = _make_fmv_service(prices)

        from tests.unit.pnl.conftest import make_asset
        lot = create_lot(
            asset_id=APTIV_ASSET_ID, account_id=1,
            qty=Decimal("5"), unit_cost=Decimal("80"),
            acquired_at=original_acquired,
        )
        lot.asset = make_asset(APTIV_ASSET_ID, "APTIV")
        seed_lot(lot_manager, lot)

        unit = _make_cash_in_lieu_unit(
            cash_amount=Decimal("3.00"),
            parent_asset_id=APTIV_ASSET_ID,
        )
        _handle_cash_in_lieu(unit, lot_manager, fmv_service, config)

        rpnl = unit.realized_pnl_records[0]
        # Holding period = days between lot acquired_at and disposal date
        expected_days = (BASE_DT - original_acquired).days
        assert rpnl.holding_period_days == expected_days

    @patch("backend.services.pnl.group_handler._handle_acquisition")
    def test_cash_in_lieu_no_parent_attribute_warns(self, mock_acq):
        """Missing attributed_asset_id should produce a warning, no crash."""
        prices = {1: Decimal("1")}
        config = _make_config()
        lot_manager = LotManager(config)
        fmv_service = _make_fmv_service(prices)

        unit = _make_cash_in_lieu_unit(cash_amount=Decimal("5"), parent_asset_id=APTIV_ASSET_ID)
        # Remove attributed_asset_id
        unit.legs[0].transaction.attributed_asset_id = None

        _handle_cash_in_lieu(unit, lot_manager, fmv_service, config)

        assert unit.realized_pnl_records is None or len(unit.realized_pnl_records) == 0
        assert any("attributed_asset_id" in w.message for w in unit.warnings)

    @patch("backend.services.pnl.group_handler._handle_acquisition")
    def test_cash_in_lieu_missing_parent_fmv_warns(self, mock_acq):
        """No parent FMV → warning, no RealizedPnl."""
        # Price for EUR but NOT for parent asset
        prices = {1: Decimal("1")}
        config = _make_config()
        lot_manager = LotManager(config)

        # Override get_price_in_base to return None for parent
        service = Mock()
        service.get_price = Mock(side_effect=lambda aid, **kw: prices.get(aid))
        service.get_price_with_fallback = Mock(side_effect=lambda aid, **kw: Mock(
            price=prices.get(aid), source="mock", actual_price_date=None,
            is_fallback=False, is_stale=False, staleness_days=0,
        ))
        fmv_service = FMVService(service, config)

        unit = _make_cash_in_lieu_unit(cash_amount=Decimal("6"), parent_asset_id=APTIV_ASSET_ID)

        _handle_cash_in_lieu(unit, lot_manager, fmv_service, config)

        assert unit.realized_pnl_records is None or len(unit.realized_pnl_records) == 0
        assert any("FMV" in w.message or "fmv" in w.message.lower() for w in unit.warnings)

    @patch("backend.services.pnl.group_handler._handle_acquisition")
    def test_cash_in_lieu_lot_consumption(self, mock_acq):
        """Parent lot qty_remaining should decrease by fractional qty."""
        prices = {1: Decimal("1"), APTIV_ASSET_ID: Decimal("200")}
        config = _make_config()
        lot_manager = LotManager(config)
        fmv_service = _make_fmv_service(prices)

        from tests.unit.pnl.conftest import make_asset
        lot = create_lot(
            asset_id=APTIV_ASSET_ID, account_id=1,
            qty=Decimal("10"), unit_cost=Decimal("150"),
            acquired_at=datetime(2024, 1, 1, tzinfo=timezone.utc),
        )
        lot.asset = make_asset(APTIV_ASSET_ID, "APTIV")
        seed_lot(lot_manager, lot)

        unit = _make_cash_in_lieu_unit(
            cash_amount=Decimal("8.00"),
            parent_asset_id=APTIV_ASSET_ID,
        )
        _handle_cash_in_lieu(unit, lot_manager, fmv_service, config)

        # Fractional qty = 8 / 200 = 0.04
        expected_remaining = Decimal("10") - Decimal("8") / Decimal("200")
        assert abs(lot.qty_remaining - expected_remaining) < Decimal("0.0001")


# ---------------------------------------------------------------------------
# Tests: is_cash_in_lieu property
# ---------------------------------------------------------------------------


class TestIsCashInLieu:
    """Test the CalculationUnit.is_cash_in_lieu property."""

    def test_true_for_cash_in_lieu(self):
        unit = _make_cash_in_lieu_unit(
            cash_amount=Decimal("6"), parent_asset_id=APTIV_ASSET_ID,
        )
        assert unit.is_cash_in_lieu is True

    def test_false_for_regular_trade(self):
        tx = make_transaction(id=200, asset_id=5, quantity=Decimal("10"))
        tx.source_transaction_type = None
        leg = make_leg(asset_id=5, leg_type=LegType.OUTFLOW, quantity=Decimal("10"), transaction=tx)
        unit = make_unit(legs=[leg], pattern="swap")
        assert unit.is_cash_in_lieu is False

    def test_false_for_dividend(self):
        tx = make_transaction(id=201, asset_id=1, quantity=Decimal("3"))
        tx.transaction_type = "dividend"
        tx.source_transaction_type = "dividend"
        leg = make_leg(asset_id=1, leg_type=LegType.INFLOW, quantity=Decimal("3"), transaction=tx)
        unit = make_unit(legs=[leg], pattern="flow")
        assert unit.is_cash_in_lieu is False

    def test_false_for_empty_unit(self):
        unit = make_unit(legs=[], pattern="flow")
        assert unit.is_cash_in_lieu is False


# ---------------------------------------------------------------------------
# Tests: handle_unit routing for cash-in-lieu
# ---------------------------------------------------------------------------


class TestHandleUnitCashInLieuRouting:
    """Test that handle_unit routes cash-in-lieu to _handle_cash_in_lieu."""

    @patch("backend.services.pnl.group_handler._handle_cash_in_lieu")
    @patch("backend.services.pnl.group_handler._compute_residuals")
    def test_routes_to_cash_in_lieu_handler(self, mock_residuals, mock_handler):
        """Cash-in-lieu unit should invoke _handle_cash_in_lieu, not standard flow."""
        config = _make_config()
        lot_manager = LotManager(config)
        fmv_service = _make_fmv_service({1: Decimal("1")})

        unit = _make_cash_in_lieu_unit(
            cash_amount=Decimal("5"), parent_asset_id=APTIV_ASSET_ID,
        )

        handle_unit(unit, lot_manager, fmv_service, config)

        mock_handler.assert_called_once_with(
            unit=unit,
            lot_manager=lot_manager,
            fmv_service=fmv_service,
            config=config,
        )
