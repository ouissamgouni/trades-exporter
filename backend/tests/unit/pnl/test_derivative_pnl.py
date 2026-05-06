"""
Unit tests for derivative settlement P&L handling.

Tests cover:
- Derivative gain: perp_close inflow creates RealizedPnl(proceeds=FMV, cost=0)
- Derivative loss: perp_close outflow overrides proceeds to 0
- attributed_asset_id extraction from transaction field
- Funding income creates gain entries
- Missing attributed_asset_id → None
"""

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import MagicMock, patch

from backend.services.pnl.group_handler import handle_unit
from backend.services.pnl.lot_manager import LotManager
from backend.services.pnl.fmv_service import FMVService
from backend.db.models import LegType

from tests.unit.pnl.conftest import (
    create_lot,
    seed_lot,
    make_leg,
    make_transaction,
    make_unit,
)


class TestDerivativeGain:
    """Derivative settlement gain: inflow-only perp_close/funding creates RealizedPnl."""

    def test_perp_close_gain_creates_realized_pnl(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """perp_close inflow should create RealizedPnl with proceeds=FMV, cost=0."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # USDT inflow from perp_close (margin returned + profit)
        tx = make_transaction(
            id=100, asset_id=4, quantity=Decimal("50"),
            date_time=base_datetime, source_transaction_type="perp_close",
        )
        tx.tags = [{"coin": "ETH", "closedPnl": "50.0"}]
        tx.attributed_asset_id = 3  # ETH

        leg = make_leg(asset_id=4, leg_type=LegType.INFLOW, quantity=Decimal("50"), transaction=tx)
        unit = make_unit(legs=[leg])

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        # Should create a derivative gain RealizedPnl entry
        deriv_entries = [e for e in (result.realized_pnl_records or [])
                         if e.proceeds_source == "derivative_settlement"]
        assert len(deriv_entries) == 1

        entry = deriv_entries[0]
        assert entry.proceeds_in_base == Decimal("50")  # FMV = 50 * 1 (USDT price)
        assert entry.cost_basis_in_base == Decimal("0")
        assert entry.pnl_in_base == Decimal("50")
        assert entry.disposal_taxable is False
        assert entry.attributed_asset_id == 3  # ETH
        assert entry.holding_period_days == 0

    def test_funding_gain_creates_realized_pnl(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Funding income should also create a derivative gain entry."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        tx = make_transaction(
            id=101, asset_id=4, quantity=Decimal("5"),
            date_time=base_datetime, source_transaction_type="funding",
        )
        tx.tags = [{"coin": "BTC"}]
        tx.attributed_asset_id = 2  # BTC

        leg = make_leg(asset_id=4, leg_type=LegType.INFLOW, quantity=Decimal("5"), transaction=tx)
        unit = make_unit(legs=[leg])

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        deriv_entries = [e for e in (result.realized_pnl_records or [])
                         if e.proceeds_source == "derivative_settlement"]
        assert len(deriv_entries) == 1
        assert deriv_entries[0].attributed_asset_id == 2  # BTC
        assert deriv_entries[0].pnl_in_base == Decimal("5")

    def test_gain_with_no_tags_has_none_related_asset(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Missing attributed_asset_id should result in None."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        tx = make_transaction(
            id=102, asset_id=4, quantity=Decimal("10"),
            date_time=base_datetime, source_transaction_type="perp_close",
        )
        # No tags set (defaults to None or [])

        leg = make_leg(asset_id=4, leg_type=LegType.INFLOW, quantity=Decimal("10"), transaction=tx)
        unit = make_unit(legs=[leg])

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        deriv_entries = [e for e in (result.realized_pnl_records or [])
                         if e.proceeds_source == "derivative_settlement"]
        assert len(deriv_entries) == 1
        assert deriv_entries[0].attributed_asset_id is None

    def test_non_derivative_inflow_no_gain_entry(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Regular airdrop (no source_transaction_type) should NOT create derivative entry."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        tx = make_transaction(
            id=103, asset_id=3, quantity=Decimal("1"),
            date_time=base_datetime,
        )

        leg = make_leg(asset_id=3, leg_type=LegType.INFLOW, quantity=Decimal("1"), transaction=tx)
        unit = make_unit(legs=[leg])

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        deriv_entries = [e for e in (result.realized_pnl_records or [])
                         if e.proceeds_source == "derivative_settlement"]
        assert len(deriv_entries) == 0


class TestDerivativeLoss:
    """Derivative settlement loss: outflow perp_close overrides proceeds to 0."""

    def test_perp_close_loss_overrides_proceeds_to_zero(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """perp_close outflow should have proceeds=0, pnl=-cost_basis."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Pre-fund USDT lot
        usdt_lot = create_lot(
            asset_id=4, account_id=1,
            qty=Decimal("100"), unit_cost=Decimal("1"),
            acquired_at=base_datetime - timedelta(days=10),
        )
        seed_lot(lot_manager, usdt_lot)

        # USDT outflow from perp_close (margin lost)
        tx = make_transaction(
            id=200, asset_id=4, quantity=Decimal("30"),
            date_time=base_datetime, source_transaction_type="perp_close",
        )
        tx.tags = [{"coin": "ETH", "closedPnl": "-30.0"}]
        tx.attributed_asset_id = 3  # ETH

        leg = make_leg(asset_id=4, leg_type=LegType.OUTFLOW, quantity=Decimal("30"), transaction=tx)
        unit = make_unit(legs=[leg])

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        assert len(result.realized_pnl_records) == 1
        entry = result.realized_pnl_records[0]
        assert entry.proceeds_in_base == Decimal("0")
        assert entry.cost_basis_in_base == Decimal("30")  # 30 * 1.0 unit cost
        assert entry.pnl_in_base == Decimal("-30")
        assert entry.disposal_taxable is False
        assert entry.attributed_asset_id == 3  # ETH
        assert entry.proceeds_source == "derivative_settlement"

    def test_loss_with_no_tags_has_none_related_asset(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Missing attributed_asset_id on derivative loss should be None."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        usdt_lot = create_lot(
            asset_id=4, account_id=1,
            qty=Decimal("100"), unit_cost=Decimal("1"),
            acquired_at=base_datetime - timedelta(days=10),
        )
        seed_lot(lot_manager, usdt_lot)

        tx = make_transaction(
            id=201, asset_id=4, quantity=Decimal("20"),
            date_time=base_datetime, source_transaction_type="perp_close",
        )
        # No tags

        leg = make_leg(asset_id=4, leg_type=LegType.OUTFLOW, quantity=Decimal("20"), transaction=tx)
        unit = make_unit(legs=[leg])

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        assert len(result.realized_pnl_records) == 1
        assert result.realized_pnl_records[0].attributed_asset_id is None

    def test_normal_payment_not_affected(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Non-derivative outflow should compute proceeds normally (from FMV)."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        aapl_lot = create_lot(
            asset_id=5, account_id=1,
            qty=Decimal("10"), unit_cost=Decimal("80"),
            acquired_at=base_datetime - timedelta(days=30),
        )
        seed_lot(lot_manager, aapl_lot)

        tx = make_transaction(
            id=202, asset_id=5, quantity=Decimal("5"),
            date_time=base_datetime,
        )

        leg = make_leg(asset_id=5, leg_type=LegType.OUTFLOW, quantity=Decimal("5"), transaction=tx)
        unit = make_unit(legs=[leg])

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        assert len(result.realized_pnl_records) == 1
        entry = result.realized_pnl_records[0]
        # Normal proceeds = FMV (AAPL price 100 * 5 = 500)
        assert entry.proceeds_in_base == Decimal("500")
        assert entry.proceeds_source != "derivative_settlement"
        assert entry.attributed_asset_id is None


class TestDerivativeGainAndLotCreation:
    """Verify derivative gain creates BOTH a RealizedPnl AND a cost lot."""

    def test_perp_close_gain_also_creates_lot(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Derivative gain inflow should still create a cost lot at FMV."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        tx = make_transaction(
            id=300, asset_id=4, quantity=Decimal("50"),
            date_time=base_datetime, source_transaction_type="perp_close",
        )
        tx.tags = [{"coin": "ETH"}]

        leg = make_leg(asset_id=4, leg_type=LegType.INFLOW, quantity=Decimal("50"), transaction=tx)
        unit = make_unit(legs=[leg])

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        # Cost lot should also be created (acquisition still happens)
        assert len(result.cost_lots) == 1
        lot = result.cost_lots[0]
        assert lot.asset_id == 4
        assert lot.qty == Decimal("50")
        assert lot.unit_cost_in_base == Decimal("1")  # USDT price

        # And derivative gain entry exists
        deriv_entries = [e for e in (result.realized_pnl_records or [])
                         if e.proceeds_source == "derivative_settlement"]
        assert len(deriv_entries) == 1


# ============================================================================
# Regression tests: derivative settlements WITH fees
# These reproduce the production bugs where fee slices in consumed_slices
# caused _handle_acquisition to take the "inherited" (near-zero cost) branch
# instead of the FMV branch, and suppressed derivative gain entry creation.
# ============================================================================


class TestDerivativeWithFees:
    """Derivative settlement units that include fee legs (the real Hyperliquid shape)."""

    def test_derivative_gain_with_fee_not_inherited(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        perp_close gain + fee: gain entry MUST exist, lot cost must be FMV-based.

        Production bug: fee slices made consumed_slices non-empty, routing
        _handle_acquisition to the 'elif consumed_slices:' (inherited) branch.
        This produced near-zero lot cost and prevented the derivative gain
        entry from being created (gain code lives in the 'else' / FMV block).
        """
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Pre-fund USDT for fee consumption
        usdt_lot = create_lot(
            asset_id=4, account_id=1,
            qty=Decimal("100"), unit_cost=Decimal("1"),
            acquired_at=base_datetime - timedelta(days=10),
        )
        seed_lot(lot_manager, usdt_lot)

        # Inflow: 30 USDT from perp_close gain
        gain_tx = make_transaction(
            id=400, asset_id=4, quantity=Decimal("30"),
            date_time=base_datetime, source_transaction_type="perp_close",
        )
        gain_tx.tags = [{"coin": "ETH", "closedPnl": "30.0"}]
        gain_tx.attributed_asset_id = 3  # ETH
        inflow_leg = make_leg(
            asset_id=4, leg_type=LegType.INFLOW, quantity=Decimal("30"),
            transaction=gain_tx,
        )

        # Fee: 0.5 USDT (same perp_close event)
        fee_tx = make_transaction(
            id=401, asset_id=4, quantity=Decimal("0.5"),
            date_time=base_datetime, source_transaction_type="perp_close",
        )
        fee_leg = make_leg(
            asset_id=4, leg_type=LegType.FEE, quantity=Decimal("0.5"),
            transaction=fee_tx,
        )

        unit = make_unit(legs=[inflow_leg, fee_leg], pattern="flow")

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        # --- Derivative gain entry MUST exist ---
        # Filter by cost_basis==0 to distinguish gain entries from fee entries
        # (fee PnL also gets proceeds_source="derivative_settlement" when the
        # fee tx has source_transaction_type="perp_close").
        gain_entries = [e for e in (result.realized_pnl_records or [])
                        if e.proceeds_source == "derivative_settlement"
                        and e.cost_basis_in_base == Decimal("0")]
        assert len(gain_entries) == 1, (
            f"Expected 1 derivative gain entry, got {len(gain_entries)}. "
            "Fee slices may have routed to inherited branch."
        )
        gain_entry = gain_entries[0]
        assert gain_entry.proceeds_in_base == Decimal("30")  # 30 * 1 (USDT price)
        assert gain_entry.pnl_in_base == Decimal("30")
        assert gain_entry.attributed_asset_id == 3  # ETH

        # --- Lot cost must be FMV-based, NOT inherited from fee slices ---
        assert len(result.cost_lots) == 1
        lot = result.cost_lots[0]
        assert lot.asset_id == 4
        assert lot.qty == Decimal("30")
        assert lot.unit_cost_in_base == Decimal("1")  # USDT FMV, not near-zero

        # --- Fee entry should also exist (with non-zero cost) ---
        fee_entries = [e for e in (result.realized_pnl_records or [])
                       if e.cost_basis_in_base > 0]
        assert len(fee_entries) == 1
        assert fee_entries[0].pnl_in_base < 0  # Fee is a cost

    def test_derivative_loss_with_fee_uses_lot_cost(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        perp_close loss + fee: loss cost_basis must come from consumed lot (FIFO).

        Outflow 25 USDT + fee 0.3 USDT, both perp_close. Pre-funded lot @ 0.85€.
        Loss pnl = 0 - (25 * 0.85) = -21.25€.
        """
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        usdt_lot = create_lot(
            asset_id=4, account_id=1,
            qty=Decimal("100"), unit_cost=Decimal("0.85"),
            acquired_at=base_datetime - timedelta(days=10),
        )
        seed_lot(lot_manager, usdt_lot)

        # Outflow: 25 USDT lost in perp_close
        loss_tx = make_transaction(
            id=410, asset_id=4, quantity=Decimal("25"),
            date_time=base_datetime, source_transaction_type="perp_close",
        )
        loss_tx.tags = [{"coin": "BTC", "closedPnl": "-25.0"}]
        loss_tx.attributed_asset_id = 2  # BTC
        outflow_leg = make_leg(
            asset_id=4, leg_type=LegType.OUTFLOW, quantity=Decimal("25"),
            transaction=loss_tx,
        )

        # Fee: 0.3 USDT
        fee_tx = make_transaction(
            id=411, asset_id=4, quantity=Decimal("0.3"),
            date_time=base_datetime, source_transaction_type="perp_close",
        )
        fee_leg = make_leg(
            asset_id=4, leg_type=LegType.FEE, quantity=Decimal("0.3"),
            transaction=fee_tx,
        )

        unit = make_unit(legs=[outflow_leg, fee_leg], pattern="flow")

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        # Loss entry: proceeds=0, cost_basis = 25 * 0.85 = 21.25
        loss_entries = [e for e in (result.realized_pnl_records or [])
                        if e.proceeds_source == "derivative_settlement"
                        and e.qty == Decimal("25")]
        assert len(loss_entries) == 1
        loss = loss_entries[0]
        assert loss.proceeds_in_base == Decimal("0")
        assert loss.cost_basis_in_base == Decimal("21.25")
        assert loss.pnl_in_base == Decimal("-21.25")
        assert loss.attributed_asset_id == 2  # BTC

        # Fee entry: proceeds=0 (derivative override), cost = 0.3 * 0.85 = 0.255
        fee_entries = [e for e in (result.realized_pnl_records or [])
                       if e.qty == Decimal("0.3")]
        assert len(fee_entries) == 1
        assert fee_entries[0].proceeds_in_base == Decimal("0")
        assert fee_entries[0].cost_basis_in_base == Decimal("0.255")
        assert fee_entries[0].pnl_in_base == Decimal("-0.255")

    def test_gain_then_loss_chain_with_fees(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Full chain: gain creates lot at FMV → subsequent loss consumes it correctly.

        Proves Bug C (cascading near-zero cost) is fixed transitively.
        Step 1: gain +30 USDT + fee 0.5 → lot at FMV (1.0€)
        Step 2: loss -20 USDT + fee 0.3 → FIFO consumes from seed lot @ 1.0€  
        """
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Pre-fund for fees
        seed_lot(lot_manager, create_lot(
            asset_id=4, account_id=1,
            qty=Decimal("100"), unit_cost=Decimal("1"),
            acquired_at=base_datetime - timedelta(days=10),
        ))

        # --- Step 1: Gain ---
        gain_tx = make_transaction(
            id=420, asset_id=4, quantity=Decimal("30"),
            date_time=base_datetime, source_transaction_type="perp_close",
        )
        gain_tx.tags = [{"coin": "ETH"}]
        fee_tx1 = make_transaction(
            id=421, asset_id=4, quantity=Decimal("0.5"),
            date_time=base_datetime, source_transaction_type="perp_close",
        )
        unit1 = make_unit(
            legs=[
                make_leg(asset_id=4, leg_type=LegType.INFLOW, quantity=Decimal("30"), transaction=gain_tx),
                make_leg(asset_id=4, leg_type=LegType.FEE, quantity=Decimal("0.5"), transaction=fee_tx1),
            ],
            pattern="flow",
        )
        result1 = handle_unit(unit1, lot_manager, fmv_service, fifo_config)

        # Gain lot must have FMV-based cost, not near-zero inherited from fee
        assert len(result1.cost_lots) == 1
        gain_lot = result1.cost_lots[0]
        assert gain_lot.unit_cost_in_base == Decimal("1")  # USDT FMV

        # --- Step 2: Loss ---
        loss_tx = make_transaction(
            id=422, asset_id=4, quantity=Decimal("20"),
            date_time=base_datetime + timedelta(hours=1),
            source_transaction_type="perp_close",
        )
        loss_tx.tags = [{"coin": "BTC", "closedPnl": "-20.0"}]
        fee_tx2 = make_transaction(
            id=423, asset_id=4, quantity=Decimal("0.3"),
            date_time=base_datetime + timedelta(hours=1),
            source_transaction_type="perp_close",
        )
        unit2 = make_unit(
            legs=[
                make_leg(asset_id=4, leg_type=LegType.OUTFLOW, quantity=Decimal("20"), transaction=loss_tx),
                make_leg(asset_id=4, leg_type=LegType.FEE, quantity=Decimal("0.3"), transaction=fee_tx2),
            ],
            pattern="flow",
        )
        result2 = handle_unit(unit2, lot_manager, fmv_service, fifo_config)

        # Loss should consume from seed lot @ 1.0€ (FIFO), NOT gain lot
        loss_entries = [e for e in (result2.realized_pnl_records or [])
                        if e.proceeds_source == "derivative_settlement"
                        and e.qty == Decimal("20")]
        assert len(loss_entries) == 1
        assert loss_entries[0].cost_basis_in_base == Decimal("20")  # 20 * 1.0
        assert loss_entries[0].pnl_in_base == Decimal("-20")


# ============================================================================
# Full lifecycle test matching the design spec table
# ============================================================================


class TestDerivativeLifecycle:
    """
    6-step derivative lifecycle with running balance verification.

    Step  Action                  Balance  Cost      Realized  
    1     Buy 120 USDC for 100€   120     100.00€    0.00€
    2     Transfer 70 to HL       120     100.00€    0.00€ (internal transfer, no P&L)
    3     Open perp               120     100.00€    0.00€ (no USDC movement)
    4     Close +30 gain @0.90€   150     127.00€   +27.00€
    5     Open perp               150     127.00€   +27.00€ (no USDC movement)
    6     Close -25 loss          125     106.17€    +6.17€
    """

    def test_full_derivative_lifecycle(
        self, fifo_config, mock_price_service, base_datetime
    ):
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Use USDC (asset_id=8, price=0.90€) for margin asset
        USDC = 8
        EUR = 1  # base currency

        # ─── Step 0: Seed EUR lot for the buy ───
        seed_lot(lot_manager, create_lot(
            asset_id=EUR, account_id=1,
            qty=Decimal("1000"), unit_cost=Decimal("1"),
            acquired_at=base_datetime - timedelta(days=30),
        ))

        # ─── Step 1: Buy 120 USDC for 100€ (swap) ───
        buy_eur_tx = make_transaction(
            id=500, asset_id=EUR, quantity=Decimal("100"),
            date_time=base_datetime,
        )
        buy_usdc_tx = make_transaction(
            id=501, asset_id=USDC, quantity=Decimal("120"),
            date_time=base_datetime,
        )
        unit_buy = make_unit(
            legs=[
                make_leg(asset_id=EUR, leg_type=LegType.OUTFLOW, quantity=Decimal("100"), transaction=buy_eur_tx),
                make_leg(asset_id=USDC, leg_type=LegType.INFLOW, quantity=Decimal("120"), transaction=buy_usdc_tx),
            ],
            pattern="swap",
        )
        result_buy = handle_unit(unit_buy, lot_manager, fmv_service, fifo_config)

        # Lot 1: 120 USDC, cost = 100€ (from EUR outflow proceeds)
        assert len(result_buy.cost_lots) == 1
        lot1 = result_buy.cost_lots[0]
        assert lot1.asset_id == USDC
        assert lot1.qty == Decimal("120")
        # unit_cost = 100 / 120 = 0.8333...
        expected_unit_cost = (Decimal("100") / Decimal("120")).quantize(Decimal("0.0001"))
        actual_unit_cost = lot1.unit_cost_in_base.quantize(Decimal("0.0001"))
        assert actual_unit_cost == expected_unit_cost

        # Steps 2-3: Transfer to HL + Open perp = no USDC balance change, skip

        # ─── Step 4: Close perp with +30 USDC gain @0.90€ ───
        gain_tx = make_transaction(
            id=504, asset_id=USDC, quantity=Decimal("30"),
            date_time=base_datetime + timedelta(days=5),
            source_transaction_type="perp_close",
        )
        gain_tx.tags = [{"coin": "ETH", "closedPnl": "30.0"}]
        unit_gain = make_unit(
            legs=[
                make_leg(asset_id=USDC, leg_type=LegType.INFLOW, quantity=Decimal("30"), transaction=gain_tx),
            ],
            pattern="flow",
        )
        result_gain = handle_unit(unit_gain, lot_manager, fmv_service, fifo_config)

        # Lot 2: 30 USDC @ 0.90€ (FMV)
        assert len(result_gain.cost_lots) == 1
        lot2 = result_gain.cost_lots[0]
        assert lot2.qty == Decimal("30")
        assert lot2.unit_cost_in_base == Decimal("0.90")

        # Realized gain: proceeds = 30 * 0.90 = 27€, cost = 0, pnl = +27€
        deriv_gains = [e for e in (result_gain.realized_pnl_records or [])
                       if e.proceeds_source == "derivative_settlement"]
        assert len(deriv_gains) == 1
        assert deriv_gains[0].proceeds_in_base == Decimal("27")
        assert deriv_gains[0].cost_basis_in_base == Decimal("0")
        assert deriv_gains[0].pnl_in_base == Decimal("27")

        # Step 5: Open perp = no USDC movement, skip

        # ─── Step 6: Close perp with -25 USDC loss ───
        loss_tx = make_transaction(
            id=506, asset_id=USDC, quantity=Decimal("25"),
            date_time=base_datetime + timedelta(days=10),
            source_transaction_type="perp_close",
        )
        loss_tx.tags = [{"coin": "BTC", "closedPnl": "-25.0"}]
        unit_loss = make_unit(
            legs=[
                make_leg(asset_id=USDC, leg_type=LegType.OUTFLOW, quantity=Decimal("25"), transaction=loss_tx),
            ],
            pattern="flow",
        )
        result_loss = handle_unit(unit_loss, lot_manager, fmv_service, fifo_config)

        # Loss consumes from Lot 1 (FIFO): 25 * 0.8333 = 20.83€
        deriv_losses = [e for e in (result_loss.realized_pnl_records or [])
                        if e.proceeds_source == "derivative_settlement"]
        assert len(deriv_losses) == 1
        loss_entry = deriv_losses[0]
        assert loss_entry.proceeds_in_base == Decimal("0")
        # cost_basis = 25 * (100/120) = 20.8333...
        expected_loss_cost = (Decimal("25") * Decimal("100") / Decimal("120")).quantize(Decimal("0.01"))
        actual_loss_cost = loss_entry.cost_basis_in_base.quantize(Decimal("0.01"))
        assert actual_loss_cost == expected_loss_cost
        # pnl = 0 - 20.83 = -20.83
        assert loss_entry.pnl_in_base.quantize(Decimal("0.01")) == -expected_loss_cost

        # ─── Post-assertions: verify running totals ───
        # Remaining USDC lots:
        #   Lot 1: 120 - 25 = 95 USDC @ 0.8333€  → cost = 79.17€
        #   Lot 2: 30 USDC @ 0.90€                → cost = 27.00€
        #   Total balance = 125, total cost = 106.17€
        remaining_qty = lot_manager.get_asset_balance(USDC)
        assert remaining_qty == Decimal("125")

        # Cumulative realized = +27 - 20.83 = +6.17€
        cumulative = deriv_gains[0].pnl_in_base + loss_entry.pnl_in_base
        assert cumulative.quantize(Decimal("0.01")) == Decimal("6.17")

    def test_lifecycle_gain_with_fee(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Variant of Step 4 with a fee: gain + fee in the same flow unit.

        This is the exact production shape (Hyperliquid perp_close events
        produce inflow + fee). The fee must NOT poison the lot cost.
        """
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        USDC = 8

        # Pre-fund: buy 120 USDC for 100€
        seed_lot(lot_manager, create_lot(
            asset_id=USDC, account_id=1,
            qty=Decimal("120"), unit_cost=Decimal("100") / Decimal("120"),
            acquired_at=base_datetime - timedelta(days=5),
        ))

        # Close +30 gain with 0.5 fee
        gain_tx = make_transaction(
            id=510, asset_id=USDC, quantity=Decimal("30"),
            date_time=base_datetime, source_transaction_type="perp_close",
        )
        gain_tx.tags = [{"coin": "ETH", "closedPnl": "30.0"}]
        fee_tx = make_transaction(
            id=511, asset_id=USDC, quantity=Decimal("0.5"),
            date_time=base_datetime, source_transaction_type="perp_close",
        )
        unit = make_unit(
            legs=[
                make_leg(asset_id=USDC, leg_type=LegType.INFLOW, quantity=Decimal("30"), transaction=gain_tx),
                make_leg(asset_id=USDC, leg_type=LegType.FEE, quantity=Decimal("0.5"), transaction=fee_tx),
            ],
            pattern="flow",
        )
        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        # Gain entry must exist (filter by cost_basis==0 to exclude fee entry)
        gain_entries = [e for e in (result.realized_pnl_records or [])
                        if e.proceeds_source == "derivative_settlement"
                        and e.cost_basis_in_base == Decimal("0")]
        assert len(gain_entries) == 1
        assert gain_entries[0].pnl_in_base == Decimal("27")  # 30 * 0.90

        # Lot must have FMV cost, NOT near-zero inherited from fee
        assert len(result.cost_lots) == 1
        assert result.cost_lots[0].unit_cost_in_base == Decimal("0.90")

        # Remaining USDC = 120 - 0.5 (fee) + 30 (gain) = 149.5
        assert lot_manager.get_asset_balance(USDC) == Decimal("149.5")

    def test_lifecycle_loss_with_fee(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Variant of Step 6 with a fee: loss + fee in the same flow unit.
        """
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        USDC = 8

        # Pre-fund: 120 USDC @ 0.8333€
        seed_lot(lot_manager, create_lot(
            asset_id=USDC, account_id=1,
            qty=Decimal("120"), unit_cost=Decimal("100") / Decimal("120"),
            acquired_at=base_datetime - timedelta(days=5),
        ))

        # Close -25 loss with 0.3 fee
        loss_tx = make_transaction(
            id=520, asset_id=USDC, quantity=Decimal("25"),
            date_time=base_datetime, source_transaction_type="perp_close",
        )
        loss_tx.tags = [{"coin": "BTC", "closedPnl": "-25.0"}]
        fee_tx = make_transaction(
            id=521, asset_id=USDC, quantity=Decimal("0.3"),
            date_time=base_datetime, source_transaction_type="perp_close",
        )
        unit = make_unit(
            legs=[
                make_leg(asset_id=USDC, leg_type=LegType.OUTFLOW, quantity=Decimal("25"), transaction=loss_tx),
                make_leg(asset_id=USDC, leg_type=LegType.FEE, quantity=Decimal("0.3"), transaction=fee_tx),
            ],
            pattern="flow",
        )
        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        # Loss entry
        loss_entries = [e for e in (result.realized_pnl_records or [])
                        if e.proceeds_source == "derivative_settlement"
                        and e.qty == Decimal("25")]
        assert len(loss_entries) == 1
        loss = loss_entries[0]
        assert loss.proceeds_in_base == Decimal("0")
        # cost_basis = 25 * (100/120) = 20.83€
        expected_cost = (Decimal("25") * Decimal("100") / Decimal("120")).quantize(Decimal("0.01"))
        assert loss.cost_basis_in_base.quantize(Decimal("0.01")) == expected_cost

        # Fee entry
        fee_entries = [e for e in (result.realized_pnl_records or [])
                       if e.qty == Decimal("0.3")]
        assert len(fee_entries) == 1

        # Remaining = 120 - 25 - 0.3 = 94.7
        assert lot_manager.get_asset_balance(USDC) == Decimal("94.7")


class TestDerivativeFMVFailure:
    """
    Bug B regression tests: derivative gain entry must always be created,
    even when FMV lookup fails. A MISSING_PRICE warning must be emitted.
    """

    def test_gain_entry_created_with_zero_on_fmv_failure(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        When FMV fails for a derivative settlement inflow, the gain entry
        should still be created with proceeds=0 and a MISSING_PRICE warning.
        """
        lot_manager = LotManager(fifo_config)

        # Make FMV service that fails for USDC (asset_id=8)
        mock_price_service.prices[8] = None  # Simulate missing price
        original_get_price = mock_price_service.get_price.side_effect

        def failing_get_price(asset_id, dt=None, price_quote=None):
            if asset_id == 8:
                raise ValueError("No price found for asset 8")
            return original_get_price(asset_id, dt, price_quote)

        mock_price_service.get_price.side_effect = failing_get_price

        original_fallback = mock_price_service.get_price_with_fallback.side_effect

        def failing_fallback(asset_id, dt=None, price_quote=None, use_fallback=True, staleness_window_days=7):
            if asset_id == 8:
                raise ValueError("No price found for asset 8")
            return original_fallback(asset_id, dt, price_quote, use_fallback, staleness_window_days)

        mock_price_service.get_price_with_fallback.side_effect = failing_fallback

        fmv_service = FMVService(mock_price_service, fifo_config)

        USDC = 8

        tx = make_transaction(
            id=600, asset_id=USDC, quantity=Decimal("17.22"),
            date_time=base_datetime, source_transaction_type="perp_close",
        )
        tx.tags = [{"coin": "ETH", "closedPnl": "17.22"}]
        tx.attributed_asset_id = 3  # ETH
        leg = make_leg(
            asset_id=USDC, leg_type=LegType.INFLOW,
            quantity=Decimal("17.22"), transaction=tx,
        )
        unit = make_unit(legs=[leg])

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        # Derivative gain entry MUST exist with zero proceeds
        deriv_entries = [
            e for e in (result.realized_pnl_records or [])
            if e.proceeds_source == "derivative_settlement"
        ]
        assert len(deriv_entries) == 1, (
            f"Expected 1 derivative gain entry, got {len(deriv_entries)}"
        )
        entry = deriv_entries[0]
        assert entry.proceeds_in_base == Decimal("0")
        assert entry.cost_basis_in_base == Decimal("0")
        assert entry.pnl_in_base == Decimal("0")
        assert entry.attributed_asset_id == 3  # ETH
        assert entry.proceeds_price_source == "missing"

        # MISSING_PRICE warning must be emitted
        warnings = result.warnings or []
        missing_price_warnings = [
            w for w in warnings
            if w.warning_type == "missing_price"
            and w.asset_id == USDC
            and "derivative settlement" in w.message
        ]
        assert len(missing_price_warnings) >= 1, (
            f"Expected MISSING_PRICE warning for derivative settlement, "
            f"got warnings: {[w.warning_type for w in warnings]}"
        )

        # Cost lot still created (with zero cost)
        assert len(result.cost_lots) == 1

    def test_gain_entry_has_fmv_when_price_available(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        When FMV succeeds, the gain entry should have correct FMV proceeds
        and no MISSING_PRICE warning for the derivative settlement.
        """
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        USDC = 8  # Price = 0.90€ in mock

        tx = make_transaction(
            id=601, asset_id=USDC, quantity=Decimal("17.22"),
            date_time=base_datetime, source_transaction_type="perp_close",
        )
        tx.tags = [{"coin": "ETH", "closedPnl": "17.22"}]
        tx.attributed_asset_id = 3  # ETH
        leg = make_leg(
            asset_id=USDC, leg_type=LegType.INFLOW,
            quantity=Decimal("17.22"), transaction=tx,
        )
        unit = make_unit(legs=[leg])

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        # Gain entry with correct FMV
        deriv_entries = [
            e for e in (result.realized_pnl_records or [])
            if e.proceeds_source == "derivative_settlement"
        ]
        assert len(deriv_entries) == 1
        entry = deriv_entries[0]
        expected_proceeds = Decimal("17.22") * Decimal("0.90")
        assert entry.proceeds_in_base == expected_proceeds
        assert entry.pnl_in_base == expected_proceeds
        assert entry.attributed_asset_id == 3  # ETH
        assert entry.proceeds_price_source != "missing"

        # No MISSING_PRICE warning for the derivative gain
        warnings = result.warnings or []
        deriv_missing_warnings = [
            w for w in warnings
            if w.warning_type == "missing_price"
            and "derivative settlement" in w.message
        ]
        assert len(deriv_missing_warnings) == 0, (
            f"Unexpected MISSING_PRICE warning for derivative settlement: "
            f"{[w.message for w in deriv_missing_warnings]}"
        )


# ============================================================================
# Regression test: derivative gain entry is explicitly added to the DB session.
#
# Root cause (fixed): unit.realized_pnl_records was replaced with a plain
# Python list (= []), breaking SQLAlchemy's InstrumentedList cascade.
# Fee entries persisted via an alternate path (ConsumedLotSlice.pnl),
# but derivative gain entries — which have no slices — were silently
# dropped on commit because they were never registered with the session.
# The fix calls object_session(unit).add(deriv_entry) explicitly.
# ============================================================================


class TestDerivativeGainSessionPersistence:
    """Verify derivative gain entries are explicitly added to the SQLAlchemy session."""

    @patch("backend.services.pnl.group_handler.object_session")
    def test_derivative_gain_entry_added_to_session(
        self, mock_object_session, fifo_config, mock_price_service, base_datetime
    ):
        """
        Regression: derivative gain entry must be session.add()-ed so it persists.

        Without the explicit session.add(), the entry stays transient when
        unit.realized_pnl_records is a plain list (not InstrumentedList).
        """
        mock_session = MagicMock()
        mock_object_session.return_value = mock_session

        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        tx = make_transaction(
            id=700, asset_id=4, quantity=Decimal("50"),
            date_time=base_datetime, source_transaction_type="perp_close",
        )
        tx.tags = [{"coin": "ETH", "closedPnl": "50.0"}]

        leg = make_leg(asset_id=4, leg_type=LegType.INFLOW, quantity=Decimal("50"), transaction=tx)
        unit = make_unit(legs=[leg])

        handle_unit(unit, lot_manager, fmv_service, fifo_config)

        # object_session must have been called to get the session
        mock_object_session.assert_called()

        # session.add must have been called with the derivative entry
        add_calls = mock_session.add.call_args_list
        assert len(add_calls) >= 1, "session.add() was not called for derivative gain entry"

        added_obj = add_calls[0][0][0]  # first call, positional args, first arg
        assert added_obj.proceeds_source == "derivative_settlement"
        assert added_obj.qty == Decimal("50")
        assert added_obj.pnl_in_base == Decimal("50")  # 50 * 1 (USDT price)

    @patch("backend.services.pnl.group_handler.object_session")
    def test_derivative_gain_with_fee_both_session_tracked(
        self, mock_object_session, fifo_config, mock_price_service, base_datetime
    ):
        """
        Regression: in a perp_close with fee, the gain entry must be session.add()-ed.

        The fee entry reaches the session via ConsumedLotSlice.pnl, but the
        derivative gain entry has no slices — it needs explicit session.add().
        """
        mock_session = MagicMock()
        mock_object_session.return_value = mock_session

        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Pre-fund USDT lot for fee disposal
        usdt_lot = create_lot(
            asset_id=4, account_id=1,
            qty=Decimal("1000"), unit_cost=Decimal("1"),
            acquired_at=base_datetime - timedelta(days=10),
        )
        seed_lot(lot_manager, usdt_lot)

        tx = make_transaction(
            id=701, asset_id=4, quantity=Decimal("17.22"),
            date_time=base_datetime, source_transaction_type="perp_close",
        )
        tx.tags = [{"coin": "ETH", "closedPnl": "17.22"}]

        inflow_leg = make_leg(
            asset_id=4, leg_type=LegType.INFLOW,
            quantity=Decimal("17.22"), transaction=tx,
        )
        fee_leg = make_leg(
            asset_id=4, leg_type=LegType.FEE,
            quantity=Decimal("0.77"), transaction=tx,
        )
        unit = make_unit(legs=[inflow_leg, fee_leg])

        handle_unit(unit, lot_manager, fmv_service, fifo_config)

        # Derivative gain entry must have been added to session
        add_calls = mock_session.add.call_args_list
        deriv_adds = [
            call[0][0] for call in add_calls
            if hasattr(call[0][0], 'proceeds_source')
            and call[0][0].proceeds_source == "derivative_settlement"
        ]
        assert len(deriv_adds) >= 1, (
            "session.add() was not called for the derivative gain entry"
        )

        # Both entries should exist in realized_pnl_records
        rpnl = unit.realized_pnl_records or []
        assert len(rpnl) == 2, f"Expected 2 realized PnL entries (fee + gain), got {len(rpnl)}"

        sources = {r.proceeds_source for r in rpnl}
        assert "derivative_settlement" in sources, "Missing derivative_settlement entry"
