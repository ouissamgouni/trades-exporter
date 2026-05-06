"""
Unit tests for corporate spin-off handling in the PnL engine.

Spin-off: Parent company spins off a subsidiary. No parent outflow — cost basis
is reallocated between parent and new company proportionally.

Uses consume-and-recreate pattern: each source lot is consumed, then two new lots
are created — one for the parent (reduced cost) and one for the new company (freed cost).

Test scenario — Aptiv PLC (asset 9) spins off Versigent PLC (asset 10):
- 100 Aptiv shares in 2 lots: 60@€50 + 40@€50 = €5,000 total cost
- Spin-off at 85/15 allocation → parent retains 85%, new company gets 15%
- Receive 20 Versigent shares (inflow)
- Result: 100 Aptiv lots (cost €4,250) + 20 Versigent lots (cost €750)
"""

from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from backend.services.pnl.group_handler import handle_unit
from backend.services.pnl.lot_manager import LotManager
from backend.services.pnl.config import PnLConfig, CostMethod, LotMode
from backend.services.pnl.fmv_service import FMVService
from backend.db.models import LegType

from tests.unit.pnl.conftest import (
    create_lot,
    seed_lot,
    make_unit,
    make_transaction,
    make_leg,
    make_asset,
    make_account,
)


# Asset IDs: 9=Aptiv (parent), 10=Versigent (new company)
APTV_ID = 9
VRSG_ID = 10
EUR_ID = 1
ACCOUNT_ID = 1


def _create_spinoff_unit(
    inflow_asset_id: int,
    inflow_qty: Decimal,
    account_id: int,
    date_time: datetime,
    source_asset_id: int,
    allocation_pct: float = None,
):
    """
    Create a spinoff CalculationUnit with a single inflow leg.
    Attaches bundle_metadata for the spinoff handler.
    """
    tx = make_transaction(
        id=100,
        asset_id=inflow_asset_id,
        quantity=inflow_qty,
        account_id=account_id,
        date_time=date_time,
    )
    # Ensure the transaction has proper asset/account for lot creation
    tx.asset = make_asset(inflow_asset_id, symbol={APTV_ID: "APTV", VRSG_ID: "VRSG"}.get(inflow_asset_id, f"ASSET{inflow_asset_id}"))
    tx.account_rel = make_account(account_id)

    inflow_leg = make_leg(
        asset_id=inflow_asset_id,
        leg_type=LegType.INFLOW,
        quantity=inflow_qty,
        transaction=tx,
    )

    unit = make_unit(legs=[inflow_leg], pattern="spinoff")

    # Attach bundle metadata
    meta = {"spinoff_source_asset_id": source_asset_id}
    if allocation_pct is not None:
        meta["spinoff_allocation_pct"] = allocation_pct
    unit.bundle_metadata = meta

    return unit


def _make_aptiv_lot(qty, unit_cost, acquired_at, account_id=ACCOUNT_ID):
    """Create an Aptiv lot with proper asset reference."""
    lot = create_lot(
        asset_id=APTV_ID,
        account_id=account_id,
        qty=qty,
        unit_cost=unit_cost,
        acquired_at=acquired_at,
    )
    lot.asset = make_asset(APTV_ID, symbol="APTV")
    lot.account = make_account(account_id)
    return lot


class TestSpinoffBasic:
    """Test basic spin-off cost basis reallocation."""

    def test_spinoff_two_lots_explicit_allocation(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        100 Aptiv in 2 lots (60@€50 + 40@€50) → 85/15 spinoff → Versigent.
        Receive 20 Versigent shares.

        Expected:
        - 2 new Aptiv lots: 60@€42.50 + 40@€42.50 (85% of €50)
        - 2 new Versigent lots: 12@€37.50 + 8@€37.50 (15% of €50 * original_qty / target_qty)
        - Total cost preserved: €5,000
        - No RealizedPnl records (non-taxable)
        - Holding period (acquired_at) inherited from source lots
        """
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Seed two Aptiv lots
        lot1_date = base_datetime - timedelta(days=365)
        lot2_date = base_datetime - timedelta(days=180)
        lot1 = _make_aptiv_lot(Decimal("60"), Decimal("50"), lot1_date)
        lot2 = _make_aptiv_lot(Decimal("40"), Decimal("50"), lot2_date)
        seed_lot(lot_manager, lot1)
        seed_lot(lot_manager, lot2)

        # Create spinoff unit: receive 20 Versigent shares at 15% allocation
        unit = _create_spinoff_unit(
            inflow_asset_id=VRSG_ID,
            inflow_qty=Decimal("20"),
            account_id=ACCOUNT_ID,
            date_time=base_datetime,
            source_asset_id=APTV_ID,
            allocation_pct=0.15,
        )

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        # No realized PnL (spin-off is non-taxable)
        assert len(result.realized_pnl_records) == 0

        # 4 lots created: 2 Aptiv (reduced cost) + 2 Versigent (freed cost)
        assert len(result.cost_lots) == 4

        # Separate lots by asset
        aptiv_lots = [l for l in result.cost_lots if l.asset_id == APTV_ID]
        vrsg_lots = [l for l in result.cost_lots if l.asset_id == VRSG_ID]
        assert len(aptiv_lots) == 2
        assert len(vrsg_lots) == 2

        # Aptiv lots: same qty, 85% cost
        aptiv_lots.sort(key=lambda l: l.qty_remaining, reverse=True)
        assert aptiv_lots[0].qty_remaining == Decimal("60")
        assert aptiv_lots[0].unit_cost_in_base == Decimal("42.5")  # 50 * 0.85
        assert aptiv_lots[1].qty_remaining == Decimal("40")
        assert aptiv_lots[1].unit_cost_in_base == Decimal("42.5")

        # Versigent lots: proportional qty, 15% cost
        # Lot1: (60/100)*20=12 shares, unit cost = (50*0.15*60)/12 = 37.5
        # Lot2: (40/100)*20=8 shares, unit cost = (50*0.15*40)/8 = 37.5
        vrsg_lots.sort(key=lambda l: l.qty_remaining, reverse=True)
        assert vrsg_lots[0].qty_remaining == Decimal("12")
        assert vrsg_lots[0].unit_cost_in_base == Decimal("37.5")
        assert vrsg_lots[1].qty_remaining == Decimal("8")
        assert vrsg_lots[1].unit_cost_in_base == Decimal("37.5")

        # Total cost basis preserved
        total_aptiv_cost = sum(l.qty_remaining * l.unit_cost_in_base for l in aptiv_lots)
        total_vrsg_cost = sum(l.qty_remaining * l.unit_cost_in_base for l in vrsg_lots)
        assert total_aptiv_cost + total_vrsg_cost == Decimal("5000")

        # Holding period preserved
        assert aptiv_lots[0].acquired_at == lot1_date
        assert aptiv_lots[1].acquired_at == lot2_date
        assert vrsg_lots[0].acquired_at == lot1_date  # inherited from lot1
        assert vrsg_lots[1].acquired_at == lot2_date  # inherited from lot2

        # Cost source is inherited
        for lot in result.cost_lots:
            assert lot.cost_source == "inherited"

    def test_spinoff_single_lot(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Single source lot → 1 new parent lot + 1 new target lot."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        lot_date = base_datetime - timedelta(days=100)
        lot = _make_aptiv_lot(Decimal("50"), Decimal("80"), lot_date)
        seed_lot(lot_manager, lot)

        unit = _create_spinoff_unit(
            inflow_asset_id=VRSG_ID,
            inflow_qty=Decimal("10"),
            account_id=ACCOUNT_ID,
            date_time=base_datetime,
            source_asset_id=APTV_ID,
            allocation_pct=0.20,
        )

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        assert len(result.realized_pnl_records) == 0
        assert len(result.cost_lots) == 2

        aptiv_lot = [l for l in result.cost_lots if l.asset_id == APTV_ID][0]
        vrsg_lot = [l for l in result.cost_lots if l.asset_id == VRSG_ID][0]

        # Aptiv: 50 shares @ €64 (80% of €80)
        assert aptiv_lot.qty_remaining == Decimal("50")
        assert aptiv_lot.unit_cost_in_base == Decimal("64")  # 80 * 0.80

        # Versigent: 10 shares, total freed cost = 80*0.20*50 = 800, unit = 800/10 = 80
        assert vrsg_lot.qty_remaining == Decimal("10")
        assert vrsg_lot.unit_cost_in_base == Decimal("80")  # (80*0.20*50)/10

        # Total preserved
        total = aptiv_lot.qty_remaining * aptiv_lot.unit_cost_in_base + vrsg_lot.qty_remaining * vrsg_lot.unit_cost_in_base
        assert total == Decimal("4000")  # original: 50*80 = 4000


class TestSpinoffAutoAllocation:
    """Test FMV-based auto-allocation when no allocation_pct is provided."""

    def test_auto_allocation_from_fmv(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Auto-compute allocation from FMV at spinoff date.
        Aptiv price=€85, Versigent price=€15 → allocation = 15/(85+15) = 15%
        """
        # Add prices for test assets
        mock_price_service.prices[APTV_ID] = Decimal("85")
        mock_price_service.prices[VRSG_ID] = Decimal("15")

        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        lot = _make_aptiv_lot(Decimal("100"), Decimal("50"), base_datetime - timedelta(days=365))
        seed_lot(lot_manager, lot)

        unit = _create_spinoff_unit(
            inflow_asset_id=VRSG_ID,
            inflow_qty=Decimal("20"),
            account_id=ACCOUNT_ID,
            date_time=base_datetime,
            source_asset_id=APTV_ID,
            allocation_pct=None,  # auto-compute
        )

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        assert len(result.realized_pnl_records) == 0
        assert len(result.cost_lots) == 2

        aptiv_lot = [l for l in result.cost_lots if l.asset_id == APTV_ID][0]
        vrsg_lot = [l for l in result.cost_lots if l.asset_id == VRSG_ID][0]

        # Allocation = 15/(85+15) = 15%
        # Aptiv: 100@(50*0.85)=42.5
        assert aptiv_lot.unit_cost_in_base == Decimal("42.5")
        # Versigent: 20 shares, total cost = 50*0.15*100 = 750, unit = 750/20 = 37.5
        assert vrsg_lot.unit_cost_in_base == Decimal("37.5")

    def test_missing_fmv_emits_warning(
        self, fifo_config, base_datetime
    ):
        """When FMV is unavailable and no allocation provided, emit warning and skip."""
        from unittest.mock import Mock

        # Price service returns None for test assets
        price_service = Mock()
        price_service.get_price = Mock(return_value=None)

        config = fifo_config
        lot_manager = LotManager(config)
        fmv_service = FMVService(price_service, config)

        lot = _make_aptiv_lot(Decimal("50"), Decimal("80"), base_datetime - timedelta(days=100))
        seed_lot(lot_manager, lot)

        unit = _create_spinoff_unit(
            inflow_asset_id=VRSG_ID,
            inflow_qty=Decimal("10"),
            account_id=ACCOUNT_ID,
            date_time=base_datetime,
            source_asset_id=APTV_ID,
            allocation_pct=None,  # no explicit allocation, FMV also unavailable
        )

        result = handle_unit(unit, lot_manager, fmv_service, config)

        # Should create no lots (aborted)
        assert len(result.cost_lots) == 0
        # Should have a warning
        assert len(result.warnings) > 0
        assert any("auto-compute" in w.message.lower() or "missing" in w.message.lower() for w in result.warnings)


class TestSpinoffEdgeCases:
    """Test edge cases and error handling."""

    def test_no_source_lots_emits_warning(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Spinoff with no source lots → warning, no lots created."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        unit = _create_spinoff_unit(
            inflow_asset_id=VRSG_ID,
            inflow_qty=Decimal("10"),
            account_id=ACCOUNT_ID,
            date_time=base_datetime,
            source_asset_id=APTV_ID,
            allocation_pct=0.15,
        )

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        assert len(result.cost_lots) == 0
        assert len(result.warnings) > 0

    def test_missing_source_asset_id_emits_warning(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Spinoff without source_asset_id in metadata → error warning."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        tx = make_transaction(
            id=100, asset_id=VRSG_ID, quantity=Decimal("10"),
            account_id=ACCOUNT_ID, date_time=base_datetime,
        )
        tx.asset = make_asset(VRSG_ID, symbol="VRSG")
        tx.account_rel = make_account(ACCOUNT_ID)
        inflow = make_leg(asset_id=VRSG_ID, leg_type=LegType.INFLOW, quantity=Decimal("10"), transaction=tx)

        unit = make_unit(legs=[inflow], pattern="spinoff")
        unit.bundle_metadata = {}  # Missing spinoff_source_asset_id

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        assert len(result.cost_lots) == 0
        assert len(result.warnings) > 0
        assert any("spinoff_source_asset_id" in w.message for w in result.warnings)

    def test_spinoff_different_cost_lots(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Lots with different unit costs allocate correctly."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Lot 1: 40 shares @ €30 (cheap lot)
        lot1 = _make_aptiv_lot(Decimal("40"), Decimal("30"), base_datetime - timedelta(days=500))
        # Lot 2: 60 shares @ €70 (expensive lot)
        lot2 = _make_aptiv_lot(Decimal("60"), Decimal("70"), base_datetime - timedelta(days=100))
        seed_lot(lot_manager, lot1)
        seed_lot(lot_manager, lot2)

        unit = _create_spinoff_unit(
            inflow_asset_id=VRSG_ID,
            inflow_qty=Decimal("10"),
            account_id=ACCOUNT_ID,
            date_time=base_datetime,
            source_asset_id=APTV_ID,
            allocation_pct=0.10,
        )

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        assert len(result.cost_lots) == 4

        aptiv_lots = sorted([l for l in result.cost_lots if l.asset_id == APTV_ID], key=lambda l: l.qty_remaining)
        vrsg_lots = sorted([l for l in result.cost_lots if l.asset_id == VRSG_ID], key=lambda l: l.qty_remaining)

        # Aptiv lot from cheap lot: 40@(30*0.90) = 40@27
        assert aptiv_lots[0].qty_remaining == Decimal("40")
        assert aptiv_lots[0].unit_cost_in_base == Decimal("27")

        # Aptiv lot from expensive lot: 60@(70*0.90) = 60@63
        assert aptiv_lots[1].qty_remaining == Decimal("60")
        assert aptiv_lots[1].unit_cost_in_base == Decimal("63")

        # Versigent lots proportional qty: 40/100*10=4, 60/100*10=6
        # Cheap lot: 4 shares, cost = 30*0.10*40 / 4 = 30
        assert vrsg_lots[0].qty_remaining == Decimal("4")
        assert vrsg_lots[0].unit_cost_in_base == Decimal("30")

        # Expensive lot: 6 shares, cost = 70*0.10*60 / 6 = 70
        assert vrsg_lots[1].qty_remaining == Decimal("6")
        assert vrsg_lots[1].unit_cost_in_base == Decimal("70")

        # Total cost preserved: 40*30 + 60*70 = 1200 + 4200 = 5400
        total = sum(l.qty_remaining * l.unit_cost_in_base for l in result.cost_lots)
        assert total == Decimal("5400")

    def test_spinoff_account_scoping(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Spinoff only affects lots in the inflow's account."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Lot in account 1 (should be affected)
        lot1 = _make_aptiv_lot(Decimal("50"), Decimal("60"), base_datetime - timedelta(days=200), account_id=1)
        seed_lot(lot_manager, lot1)

        # Lot in account 2 (should NOT be affected)
        lot2 = _make_aptiv_lot(Decimal("30"), Decimal("60"), base_datetime - timedelta(days=200), account_id=2)
        seed_lot(lot_manager, lot2)

        unit = _create_spinoff_unit(
            inflow_asset_id=VRSG_ID,
            inflow_qty=Decimal("10"),
            account_id=1,  # Only account 1
            date_time=base_datetime,
            source_asset_id=APTV_ID,
            allocation_pct=0.15,
        )

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        # Only 2 lots created (from account 1's single lot)
        assert len(result.cost_lots) == 2

        # Account 2's lot should still be untouched
        account2_lots = list(lot_manager.get_lots(2, APTV_ID))
        assert len(account2_lots) == 1
        assert account2_lots[0].qty_remaining == Decimal("30")
        assert account2_lots[0].unit_cost_in_base == Decimal("60")  # unchanged

    def test_spinoff_consumes_source_lots(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Source lots should be fully consumed (qty_remaining → 0)."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        lot = _make_aptiv_lot(Decimal("100"), Decimal("50"), base_datetime - timedelta(days=365))
        seed_lot(lot_manager, lot)

        unit = _create_spinoff_unit(
            inflow_asset_id=VRSG_ID,
            inflow_qty=Decimal("20"),
            account_id=ACCOUNT_ID,
            date_time=base_datetime,
            source_asset_id=APTV_ID,
            allocation_pct=0.15,
        )

        handle_unit(unit, lot_manager, fmv_service, fifo_config)

        # Original lot should be fully consumed
        assert lot.qty_remaining == Decimal("0")

        # New lots should be active in the lot manager
        all_aptiv_lots = list(lot_manager.get_lots(ACCOUNT_ID, APTV_ID))
        active_aptiv = [l for l in all_aptiv_lots if l.qty_remaining > 0]
        vrsg_lots = list(lot_manager.get_lots(ACCOUNT_ID, VRSG_ID))
        assert len(active_aptiv) == 1
        assert active_aptiv[0].qty_remaining == Decimal("100")
        assert len(vrsg_lots) == 1
        assert vrsg_lots[0].qty_remaining == Decimal("20")
