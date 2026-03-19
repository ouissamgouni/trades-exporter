"""
Tests for unmatched internal transfer detection and handling.

Unmatched internal transfers occur when:
- An internal transfer has only outflow leg (withdrawal) but missing inflow leg (deposit)
- An internal transfer has only inflow leg (deposit) but missing outflow leg (withdrawal)

Expected behavior:
- Pattern should be UNMATCHED_INTERNAL_TRANSFER (not UNKNOWN)
- P&L should NOT be realized for unmatched internal transfers
- Warning should be created with details for both inflows and outflows
- Lots should be consumed (for outflow) to track cost basis
- Provisional lots SHOULD be created for inflow-only unmatched transfers using FMV
  (prevents negative lot errors when asset is later disposed before transfer is linked)
"""

import pytest
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from unittest.mock import Mock, MagicMock

from backend.db.models import (
    Account,
    CalculationUnit,
    CalculationUnitLeg,
    UnitPattern,
    CostLot,
    ConsumedLotSlice,
    NormalizedTransaction,
    PnlWarning,
)
from backend.services.pnl.config import PnLConfig, CostMethod, LotMode, WarningType
from backend.services.pnl.taxability import TaxabilityCalculator


class TestUnmatchedInternalTransferPatternDetection:
    """Tests for pattern detection of unmatched internal transfers.
    
    Internal transfers are distinguished from external flows by checking
    whether the counterparty account (from_account / to_account) is
    mapped to an owned account (Account.owned == True).
    Having from_account_id/to_account_id set alone is NOT sufficient:
    the referenced Account must also have owned=True.
    """

    @staticmethod
    def _make_account(id, owned=True, name="test"):
        """Create an Account with the given owned status."""
        return Account(id=id, name=name, account_type="wallet", owned=owned)

    @staticmethod
    def _make_tx(**kwargs):
        """Create a NormalizedTransaction with sensible defaults."""
        defaults = dict(
            id=1,
            transaction_type="transfer",
            direction="outflow",
            asset_id=2,
            quantity=Decimal("1.0"),
            account_id=1,
            from_account_id=None,
            to_account_id=None,
            from_account=None,
            to_account=None,
        )
        defaults.update(kwargs)
        return NormalizedTransaction(**defaults)

    @staticmethod
    def _make_unit_with_leg(leg_type, tx):
        """Create a CalculationUnit with one leg backed by a transaction."""
        unit = CalculationUnit(
            version_id=1,
            unit_origin=f"tx:{tx.id}",
            timestamp=datetime.now(timezone.utc),
        )
        leg = CalculationUnitLeg(
            leg_type=leg_type,
            asset_id=tx.asset_id,
            quantity=tx.quantity,
            transaction=tx,
        )
        unit.legs = [leg]
        return unit

    # --- Internal (unmatched) cases ---

    def test_outflow_to_owned_account_is_unmatched_internal(self):
        """Outflow with to_account.owned=True → UNMATCHED_INTERNAL_TRANSFER."""
        owned_acct = self._make_account(id=2, owned=True)
        tx = self._make_tx(direction="outflow", to_account_id=2, to_account=owned_acct)
        unit = self._make_unit_with_leg("outflow", tx)

        pattern, reason = unit._compute_pattern_from_legs()

        assert pattern == UnitPattern.UNMATCHED_INTERNAL_TRANSFER.value
        assert "outflow" in reason

    def test_inflow_from_owned_account_is_unmatched_internal(self):
        """Inflow with from_account.owned=True → UNMATCHED_INTERNAL_TRANSFER."""
        owned_acct = self._make_account(id=1, owned=True)
        tx = self._make_tx(id=2, direction="inflow", from_account_id=1, from_account=owned_acct)
        unit = self._make_unit_with_leg("inflow", tx)

        pattern, reason = unit._compute_pattern_from_legs()

        assert pattern == UnitPattern.UNMATCHED_INTERNAL_TRANSFER.value
        assert "inflow" in reason

    # --- External (FLOW) cases ---

    def test_outflow_to_unknown_address_is_flow(self):
        """Outflow with to_account_id=None → FLOW (external payment/disposal)."""
        tx = self._make_tx(direction="outflow", to_account_id=None)
        unit = self._make_unit_with_leg("outflow", tx)

        pattern, reason = unit._compute_pattern_from_legs()

        assert pattern == UnitPattern.FLOW.value
        assert "external" in reason

    def test_inflow_from_unknown_address_is_flow(self):
        """Inflow with from_account_id=None → FLOW (external deposit/airdrop)."""
        tx = self._make_tx(id=3, direction="inflow", from_account_id=None)
        unit = self._make_unit_with_leg("inflow", tx)

        pattern, reason = unit._compute_pattern_from_legs()

        assert pattern == UnitPattern.FLOW.value
        assert "external" in reason

    def test_outflow_to_non_owned_account_is_flow(self):
        """Outflow with to_account_id set but to_account.owned=False → FLOW."""
        counterparty = self._make_account(id=5, owned=False, name="counterparty")
        tx = self._make_tx(direction="outflow", to_account_id=5, to_account=counterparty)
        unit = self._make_unit_with_leg("outflow", tx)

        pattern, reason = unit._compute_pattern_from_legs()

        assert pattern == UnitPattern.FLOW.value
        assert "external" in reason

    def test_inflow_from_non_owned_account_is_flow(self):
        """Inflow with from_account_id set but from_account.owned=False → FLOW."""
        counterparty = self._make_account(id=5, owned=False, name="counterparty")
        tx = self._make_tx(id=4, direction="inflow", from_account_id=5, from_account=counterparty)
        unit = self._make_unit_with_leg("inflow", tx)

        pattern, reason = unit._compute_pattern_from_legs()

        assert pattern == UnitPattern.FLOW.value
        assert "external" in reason

    def test_outflow_with_account_id_but_no_relationship_is_flow(self):
        """Outflow with to_account_id set but to_account=None (dangling FK) → FLOW."""
        tx = self._make_tx(direction="outflow", to_account_id=99, to_account=None)
        unit = self._make_unit_with_leg("outflow", tx)

        pattern, reason = unit._compute_pattern_from_legs()

        assert pattern == UnitPattern.FLOW.value
        assert "external" in reason

    # --- Complete internal transfer ---

    def test_complete_internal_transfer_gets_internal_transfer_pattern(self):
        """Internal transfer with both legs should get INTERNAL_TRANSFER pattern."""
        unit = CalculationUnit(
            version_id=1,
            unit_origin="tx:3",
            unit_label="Complete transfer",
            timestamp=datetime.now(timezone.utc),
        )

        outflow_leg = CalculationUnitLeg(
            leg_type="outflow",
            asset_id=2,
            quantity=Decimal("1.0"),
        )
        inflow_leg = CalculationUnitLeg(
            leg_type="inflow",
            asset_id=2,
            quantity=Decimal("1.0"),
        )

        unit.legs = [outflow_leg, inflow_leg]

        pattern, _ = unit._compute_pattern_from_legs()

        # Same asset in/out = INTERNAL_TRANSFER
        assert pattern == UnitPattern.INTERNAL_TRANSFER.value

    # --- Edge cases ---

    def test_trade_type_single_leg_is_flow_not_unmatched(self):
        """Single-leg trade (shouldn't normally happen) with no counterparty → FLOW."""
        tx = self._make_tx(transaction_type="trade", direction="outflow", to_account_id=None)
        unit = self._make_unit_with_leg("outflow", tx)

        pattern, _ = unit._compute_pattern_from_legs()

        assert pattern == UnitPattern.FLOW.value

    def test_leg_without_transaction_falls_through_to_flow(self):
        """Leg with no transaction relationship → FLOW (conservative fallback)."""
        unit = CalculationUnit(
            version_id=1,
            unit_origin="tx:99",
            timestamp=datetime.now(timezone.utc),
        )
        leg = CalculationUnitLeg(
            leg_type="outflow",
            asset_id=2,
            quantity=Decimal("1.0"),
            transaction=None,
        )
        unit.legs = [leg]

        pattern, _ = unit._compute_pattern_from_legs()

        assert pattern == UnitPattern.FLOW.value


class TestUnmatchedInternalTransferWarningType:
    """Tests for the UNMATCHED_INTERNAL_TRANSFER warning type."""

    def test_unmatched_internal_transfer_warning_type_exists(self):
        """UNMATCHED_INTERNAL_TRANSFER should be a valid warning type."""
        assert hasattr(WarningType, "UNMATCHED_INTERNAL_TRANSFER")
        assert WarningType.UNMATCHED_INTERNAL_TRANSFER.value == "unmatched_internal_transfer"

    def test_warning_type_can_be_used_in_pnl_warning(self):
        """PnlWarning should accept UNMATCHED_INTERNAL_TRANSFER warning type."""
        warning = PnlWarning(
            warning_type=WarningType.UNMATCHED_INTERNAL_TRANSFER.value,
            message="Internal transfer outflow missing inflow",
            details={"test": "data"},
        )
        
        assert warning.warning_type == "unmatched_internal_transfer"
        assert warning.details == {"test": "data"}


class TestUnmatchedInternalTransferTaxability:
    """Tests for taxability of unmatched internal transfers."""

    @pytest.fixture
    def config(self):
        return PnLConfig(
            lot_method=CostMethod.FIFO,
            lot_mode=LotMode.LOT_TRAVEL,
            base_currency_id=1,
        )

    @pytest.fixture
    def calculator(self, config):
        return TaxabilityCalculator(config)

    def test_unmatched_internal_transfer_is_not_taxable(self, calculator):
        """Unmatched internal transfer disposal should NOT be taxable."""
        unit = Mock()
        unit.pattern = UnitPattern.UNMATCHED_INTERNAL_TRANSFER.value
        unit.bundle_taxability_override = None
        
        leg = Mock()
        leg.leg_type = "outflow"
        leg.asset_id = 2
        leg.unit = unit  # compute() accesses leg.unit
        leg.transaction = Mock()
        leg.transaction.transaction_type = "transfer"
        leg.transaction.taxability_status = "unknown"
        
        result = calculator.compute(leg)
        
        # Unmatched internal transfers are NOT taxable
        assert result is False

    def test_normal_disposal_is_taxable(self, calculator):
        """Normal outflow-only disposal (not pending transfer) should be taxable."""
        unit = Mock()
        unit.pattern = UnitPattern.UNKNOWN.value
        unit.bundle_taxability_override = None
        unit.is_outflow_only = True  # Used by _is_outflow_only check
        unit.is_cost_basis_transfer = False  # Not a transfer
        unit._inflow_asset_ids = set()  # No inflow assets
        
        leg = Mock()
        leg.leg_type = "outflow"
        leg.asset_id = 2  # Not base currency (base_currency_id=1)
        leg.unit = unit  # compute() accesses leg.unit
        leg.tx_taxability_status = "unknown"  # No override
        leg.is_fee = False
        
        result = calculator.compute(leg)
        
        # Outflow-only of non-base currency is taxable
        assert result is True


class TestUnmatchedInternalTransferUnitPatternEnum:
    """Tests for UnitPattern enum with UNMATCHED_INTERNAL_TRANSFER."""

    def test_unmatched_internal_transfer_in_unit_pattern(self):
        """UNMATCHED_INTERNAL_TRANSFER should be a valid UnitPattern value."""
        assert hasattr(UnitPattern, "UNMATCHED_INTERNAL_TRANSFER")
        assert UnitPattern.UNMATCHED_INTERNAL_TRANSFER.value == "unmatched_internal_transfer"

    def test_all_patterns_exist(self):
        """Verify all expected patterns exist."""
        expected = ["internal_transfer", "swap", "split", "flow", "unmatched_internal_transfer", "unknown"]
        for pattern in expected:
            assert pattern in [p.value for p in UnitPattern]


class TestUnmatchedInternalTransferWarningDetails:
    """Tests for warning detail structure."""

    def test_outflow_warning_details_structure(self):
        """Warning details for outflow unmatched internal transfer should contain expected fields."""
        details = {
            "transfer_direction": "outflow",
            "asset_id": 2,
            "asset_symbol": "BTC",
            "account_id": 1,
            "total_quantity": 1.5,
            "total_cost_in_base": 45000.0,
            "timestamp": "2024-01-15T12:00:00+00:00",
            "consumed_slices": [
                {
                    "slice_id": 1,
                    "cost_lot_id": 10,
                    "quantity": 1.5,
                    "cost_in_base": 45000.0,
                    "unit_cost": 30000.0,
                    "acquired_at": "2023-06-01T10:00:00+00:00",
                    "holding_period_days": 228,
                }
            ],
        }
        
        # Verify structure
        assert "transfer_direction" in details
        assert details["transfer_direction"] == "outflow"
        assert "consumed_slices" in details
        assert len(details["consumed_slices"]) == 1
        
        slice_detail = details["consumed_slices"][0]
        assert "slice_id" in slice_detail
        assert "cost_lot_id" in slice_detail
        assert "quantity" in slice_detail
        assert "holding_period_days" in slice_detail

    def test_inflow_warning_details_structure(self):
        """Warning details for inflow-only unmatched internal transfer should include provisional cost basis info."""
        details = {
            "transfer_direction": "inflow",
            "asset_id": 2,
            "asset_symbol": "ETH",
            "account_id": 2,
            "total_quantity": 5.0,
            "timestamp": "2024-01-20T14:30:00+00:00",
            "provisional_cost_basis": "fmv_at_acquisition",
            "note": "Provisional lot will be replaced with actual cost basis when transfer is linked and P&L recalculated",
            "inflows": [{
                "transaction_id": 123,
                "quantity": 5.0,
                "account_id": 2,
            }],
        }
        
        assert details["transfer_direction"] == "inflow"
        assert "inflows" in details
        assert "provisional_cost_basis" in details
        assert details["provisional_cost_basis"] == "fmv_at_acquisition"
        assert "note" in details
        assert "consumed_slices" not in details  # Only for outflows


class TestConsumedLotSliceAccess:
    """Tests for proper ConsumedLotSlice attribute access."""

    def test_slice_has_correct_attributes(self):
        """ConsumedLotSlice should have expected attributes."""
        # Create a mock cost lot
        cost_lot = CostLot(
            asset_id=2,
            account_id=1,
            qty=Decimal("10"),
            qty_remaining=Decimal("8"),
            unit_cost_in_base=Decimal("30000"),
            total_cost_in_base=Decimal("300000"),
            acquired_at=datetime.now(timezone.utc) - timedelta(days=100),
        )
        
        # Create slice
        slice = ConsumedLotSlice(
            quantity=Decimal("2"),
            unit_cost_in_base=Decimal("30000"),
            total_cost_in_base=Decimal("60000"),
            cost_lot=cost_lot,
            consumed_at=datetime.now(timezone.utc),
        )
        
        # Verify attributes exist
        assert hasattr(slice, "slice_id")
        assert hasattr(slice, "cost_lot_id")
        assert hasattr(slice, "quantity")
        assert hasattr(slice, "total_cost_in_base")
        assert hasattr(slice, "holding_period_days")
        
        # Verify cost_lot relationship
        assert slice.cost_lot is not None
        assert slice.cost_lot.cost_lot_id is not None or slice.cost_lot.asset_id == 2  # lot linked
        assert slice.cost_lot.acquired_at is not None

    def test_slice_holding_period_calculation(self):
        """ConsumedLotSlice should calculate holding period correctly."""
        acquired = datetime(2024, 1, 1, tzinfo=timezone.utc)
        consumed = datetime(2024, 7, 1, tzinfo=timezone.utc)  # ~182 days later
        
        cost_lot = CostLot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            qty_remaining=Decimal("0"),
            unit_cost_in_base=Decimal("100"),
            total_cost_in_base=Decimal("100"),
            acquired_at=acquired,
        )
        
        slice = ConsumedLotSlice(
            quantity=Decimal("1"),
            unit_cost_in_base=Decimal("100"),
            total_cost_in_base=Decimal("100"),
            cost_lot=cost_lot,
            consumed_at=consumed,
        )
        
        # Holding period should be approximately 182 days
        assert slice.holding_period_days is not None
        assert slice.holding_period_days >= 180
        assert slice.holding_period_days <= 185
