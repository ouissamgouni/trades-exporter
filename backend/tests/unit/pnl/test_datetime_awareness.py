"""
Regression tests for datetime timezone awareness in the PnL pipeline.

These tests ensure that mixing timezone-naive and timezone-aware datetimes
never causes "can't compare offset-naive and offset-aware datetimes" errors.

Root cause: Some connectors store aware datetimes, some store naive datetimes,
and fallback code used datetime.utcnow() (naive). All code must now use
utc_now() (aware) and ensure_utc() before comparing.
"""

from datetime import datetime, timezone, timedelta
from decimal import Decimal

import pytest

from backend.db.models import (
    CalculationUnit,
    CalculationUnitLeg,
    NormalizedTransaction,
    CostLot,
    LegType,
    ensure_utc,
    utc_now,
)
from backend.services.pnl.config import PnLConfig, CostMethod, LotMode
from backend.services.pnl.engine import PnLEngine
from backend.services.pnl.lot_manager import LotManager
from backend.services.pnl.fmv_service import FMVService
from backend.services.pnl.group_handler import handle_unit

from tests.unit.pnl.conftest import (
    make_asset,
    make_account,
    make_transaction,
    make_leg,
    make_unit,
    create_lot,
    create_buy_group,
    create_sell_group,
    seed_lot,
)


# ============================================================================
# Helpers
# ============================================================================

NAIVE_DT = datetime(2024, 6, 15, 12, 0, 0)  # No tzinfo
AWARE_DT = datetime(2024, 6, 15, 12, 0, 0, tzinfo=timezone.utc)

NAIVE_DT_LATER = datetime(2024, 6, 16, 12, 0, 0)
AWARE_DT_LATER = datetime(2024, 6, 16, 12, 0, 0, tzinfo=timezone.utc)


def _make_config() -> PnLConfig:
    return PnLConfig(
        lot_method=CostMethod.FIFO,
        lot_mode=LotMode.LOT_TRAVEL,
        base_currency_id=1,
        base_currency_symbol="EUR",
        allow_negative_balances=True,
    )


# ============================================================================
# Test: ensure_utc utility
# ============================================================================

class TestEnsureUtc:
    """Sanity checks for the ensure_utc helper."""

    def test_naive_becomes_aware(self):
        result = ensure_utc(NAIVE_DT)
        assert result.tzinfo is not None
        assert result.tzinfo == timezone.utc

    def test_aware_unchanged(self):
        result = ensure_utc(AWARE_DT)
        assert result is AWARE_DT

    def test_none_returns_none(self):
        assert ensure_utc(None) is None

    def test_mixed_comparison_after_ensure(self):
        """The core bug scenario: comparing naive vs aware after ensure_utc."""
        a = ensure_utc(NAIVE_DT)
        b = ensure_utc(AWARE_DT)
        # Must not raise
        assert a == b


# ============================================================================
# Test: Engine timestamp helpers with mixed datetimes
# ============================================================================

class TestEngineTimestampMixedAwareness:
    """Ensure engine timestamp operations handle mixed naive/aware datetimes."""

    def test_get_earliest_timestamp_with_naive_legs(self):
        """_get_earliest_timestamp must not crash when legs have naive datetimes."""
        config = _make_config()
        engine = PnLEngine.__new__(PnLEngine)
        engine.config = config

        tx1 = make_transaction(id=1, asset_id=2, quantity=Decimal("1"), date_time=NAIVE_DT)
        tx2 = make_transaction(id=2, asset_id=2, quantity=Decimal("1"), date_time=AWARE_DT_LATER)

        legs = [
            make_leg(asset_id=2, leg_type=LegType.OUTFLOW, quantity=Decimal("1"), transaction=tx1),
            make_leg(asset_id=2, leg_type=LegType.INFLOW, quantity=Decimal("1"), transaction=tx2),
        ]
        unit = make_unit(legs=legs)

        # Must not raise "can't compare offset-naive and offset-aware datetimes"
        result = engine._get_earliest_timestamp(unit)
        assert result is not None
        assert result.tzinfo is not None  # Should be aware

    def test_get_earliest_timestamp_with_aware_legs(self):
        """_get_earliest_timestamp works normally with all-aware legs."""
        config = _make_config()
        engine = PnLEngine.__new__(PnLEngine)
        engine.config = config

        tx1 = make_transaction(id=1, asset_id=2, quantity=Decimal("1"), date_time=AWARE_DT)
        tx2 = make_transaction(id=2, asset_id=2, quantity=Decimal("1"), date_time=AWARE_DT_LATER)

        legs = [
            make_leg(asset_id=2, leg_type=LegType.OUTFLOW, quantity=Decimal("1"), transaction=tx1),
            make_leg(asset_id=2, leg_type=LegType.INFLOW, quantity=Decimal("1"), transaction=tx2),
        ]
        unit = make_unit(legs=legs)

        result = engine._get_earliest_timestamp(unit)
        assert result == AWARE_DT

    def test_sorting_units_with_mixed_datetimes(self):
        """sorted(units, key=_get_earliest_timestamp) must work with mixed awareness."""
        config = _make_config()
        engine = PnLEngine.__new__(PnLEngine)
        engine.config = config

        # Unit 1: naive datetime
        tx1 = make_transaction(id=1, asset_id=2, quantity=Decimal("1"), date_time=NAIVE_DT_LATER)
        unit1 = make_unit(legs=[
            make_leg(asset_id=2, leg_type=LegType.INFLOW, quantity=Decimal("1"), transaction=tx1),
        ])

        # Unit 2: aware datetime (earlier)
        tx2 = make_transaction(id=2, asset_id=2, quantity=Decimal("1"), date_time=AWARE_DT)
        unit2 = make_unit(legs=[
            make_leg(asset_id=2, leg_type=LegType.INFLOW, quantity=Decimal("1"), transaction=tx2),
        ])

        # Must not raise
        sorted_units = sorted([unit1, unit2], key=engine._get_earliest_timestamp)
        assert len(sorted_units) == 2
        # Earlier one should come first
        earliest = engine._get_earliest_timestamp(sorted_units[0])
        assert earliest == AWARE_DT


# ============================================================================
# Test: aggregate_legs_to_units with mixed datetimes
# ============================================================================

class TestAggregateLegsTimezoneHandling:
    """Ensure aggregate_legs_to_units handles mixed naive/aware timestamps."""

    def test_aggregate_with_mixed_naive_aware_legs(self):
        """aggregate_legs_to_units must not crash with mixed-awareness leg datetimes."""
        config = _make_config()
        engine = PnLEngine.__new__(PnLEngine)
        engine.config = config

        # Create legs with mixed timezone awareness
        tx_naive = make_transaction(id=100, asset_id=2, quantity=Decimal("1"), date_time=NAIVE_DT)
        tx_aware = make_transaction(id=100, asset_id=2, quantity=Decimal("1"), date_time=AWARE_DT_LATER)

        leg1 = make_leg(asset_id=2, leg_type=LegType.OUTFLOW, quantity=Decimal("1"), transaction=tx_naive)
        leg2 = make_leg(asset_id=2, leg_type=LegType.INFLOW, quantity=Decimal("1"), transaction=tx_aware)

        # Must not raise
        units = engine.aggregate_legs_to_units([leg1, leg2])
        assert len(units) >= 1
        # Timestamp should be timezone-aware
        assert units[0].timestamp.tzinfo is not None


# ============================================================================
# Test: LotManager with mixed datetimes
# ============================================================================

class TestLotManagerTimezoneHandling:
    """Ensure LotManager operations produce aware datetimes."""

    def test_consume_lots_creates_aware_negative_lot(self):
        """When negative lot is created without a transaction, acquired_at must be aware."""
        config = _make_config()
        lot_manager = LotManager(config)

        # No pre-existing lots — consumption will create a negative lot
        slices, negative_lot = lot_manager.consume_lots(
            account_id=1,
            asset_id=2,
            asset_symbol="BTC",
            qty=Decimal("1"),
            allow_negative=True,
            triggered_by_transaction=None,
            triggered_by_unit=None,
            emit_event=False,
        )
        assert negative_lot is not None
        assert negative_lot.acquired_at.tzinfo is not None, (
            "Negative lot acquired_at must be timezone-aware"
        )

    def test_settle_negative_lots_aware_settled_at(self):
        """LotSettlement.settled_at must be timezone-aware."""
        config = _make_config()
        lot_manager = LotManager(config)

        # Create a negative lot
        slices, neg_lot = lot_manager.consume_lots(
            account_id=1,
            asset_id=2,
            asset_symbol="BTC",
            qty=Decimal("1"),
            allow_negative=True,
            emit_event=False,
        )
        assert neg_lot is not None

        # Create a settling lot
        settling_lot = CostLot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            qty_remaining=Decimal("1"),
            unit_cost=Decimal("40000"),
            acquired_at=utc_now(),
        )
        lot_manager.add_lot(settling_lot, emit_event=False)

        # Settle
        remaining, settlement_info = lot_manager.settle_negative_lots(
            account=make_account(1),
            asset=make_asset(2),
            available_qty=Decimal("1"),
            unit_cost=Decimal("40000"),
            settling_lot=settling_lot,
            emit_event=False,
        )

        assert len(settlement_info) == 1
        settlement, _prov_cost = settlement_info[0]
        assert settlement.settled_at.tzinfo is not None, (
            "LotSettlement.settled_at must be timezone-aware"
        )


# ============================================================================
# Test: handle_unit with mixed naive/aware datetimes (end-to-end)
# ============================================================================

class TestHandleUnitTimezoneHandling:
    """
    End-to-end: handle_unit must not crash when transactions have mixed
    naive/aware datetimes.
    """

    def test_sell_with_naive_acquisition_and_aware_disposal(self):
        """
        Sell scenario: lot acquired with naive datetime, disposal has aware datetime.
        This is the exact reproduction of the TX #5302 bug.
        """
        config = _make_config()
        lot_manager = LotManager(config)
        from unittest.mock import Mock
        fmv_service = FMVService(Mock(), config)

        # Lot acquired with NAIVE datetime (legacy data)
        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("30000"),
            acquired_at=NAIVE_DT,  # NAIVE
        )
        seed_lot(lot_manager, lot)

        # Sell with AWARE datetime
        sell_unit = create_sell_group(
            base_dt=AWARE_DT_LATER,  # AWARE
            asset_id=2,
            qty=Decimal("1"),
            proceeds_in_base=Decimal("40000"),
        )

        # Must not raise "can't compare offset-naive and offset-aware datetimes"
        handle_unit(
            unit=sell_unit,
            lot_manager=lot_manager,
            fmv_service=fmv_service,
            config=config,
        )

        # Verify P&L was calculated
        assert sell_unit.realized_pnl_records is not None
        assert len(sell_unit.realized_pnl_records) > 0

    def test_sell_with_aware_acquisition_and_naive_disposal(self):
        """
        Reverse scenario: lot acquired with aware datetime, disposal has naive datetime.
        """
        config = _make_config()
        lot_manager = LotManager(config)
        from unittest.mock import Mock
        fmv_service = FMVService(Mock(), config)

        # Lot acquired with AWARE datetime
        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("30000"),
            acquired_at=AWARE_DT,  # AWARE
        )
        seed_lot(lot_manager, lot)

        # Sell with NAIVE datetime
        sell_unit = create_sell_group(
            base_dt=NAIVE_DT_LATER,  # NAIVE
            asset_id=2,
            qty=Decimal("1"),
            proceeds_in_base=Decimal("40000"),
        )

        # Must not raise
        handle_unit(
            unit=sell_unit,
            lot_manager=lot_manager,
            fmv_service=fmv_service,
            config=config,
        )

        assert sell_unit.realized_pnl_records is not None
        assert len(sell_unit.realized_pnl_records) > 0


# ============================================================================
# Test: No datetime.utcnow() in PnL source files (static check)
# ============================================================================

class TestNoNaiveDatetimeInSource:
    """
    Static analysis guard: ensure no datetime.utcnow() or datetime.now()
    appears in the PnL pipeline source files.
    """

    PNL_SOURCE_FILES = [
        "backend/services/pnl/engine.py",
        "backend/services/pnl/group_handler.py",
        "backend/services/pnl/lot_manager.py",
        "backend/services/pnl/fmv_service.py",
        "backend/services/pnl/leg_expander.py",
    ]

    @pytest.mark.parametrize("filepath", PNL_SOURCE_FILES)
    def test_no_utcnow_in_source(self, filepath):
        """PnL source files must not use datetime.utcnow() — use utc_now() instead."""
        import os
        # Resolve relative to project root
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))))
        full_path = os.path.join(root, filepath)
        if not os.path.exists(full_path):
            pytest.skip(f"File not found: {full_path}")
        
        with open(full_path) as f:
            content = f.read()
        
        assert "datetime.utcnow()" not in content, (
            f"{filepath} still contains datetime.utcnow() — "
            "use utc_now() from backend.db.models instead"
        )
