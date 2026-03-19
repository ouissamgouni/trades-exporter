"""
Unit tests for TaxabilityCalculator.

Tests the taxability decision chain for all priority rules.
"""

import pytest
from decimal import Decimal
from datetime import datetime, timezone

from backend.services.pnl.taxability import TaxabilityCalculator
from backend.services.pnl.config import PnLConfig, CostMethod, LotMode
from tests.unit.pnl.conftest import make_leg, make_unit, make_transaction


@pytest.fixture
def base_config():
    """Base configuration with EUR as base currency."""
    return PnLConfig(
        lot_method=CostMethod.FIFO,
        lot_mode=LotMode.LOT_TRAVEL,
        base_currency_id=1,  # EUR
        base_currency_symbol="EUR",
        crypto_swap_taxable_by_default=False,
        fee_taxable_by_default=True,
    )


@pytest.fixture
def taxable_swap_config():
    """Configuration where crypto swaps ARE taxable."""
    return PnLConfig(
        lot_method=CostMethod.FIFO,
        lot_mode=LotMode.LOT_TRAVEL,
        base_currency_id=1,
        base_currency_symbol="EUR",
        crypto_swap_taxable_by_default=True,
        fee_taxable_by_default=True,
    )


class TestTaxabilityCalculator:
    """Test TaxabilityCalculator decision chain."""

    def test_rule1_bundle_override_taxable(self, base_config):
        """Rule 1: Bundle override 'taxable' → TAXABLE."""
        legs = [
            make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("1")),  # BTC
            make_leg(asset_id=3, leg_type="inflow", quantity=Decimal("10")),   # ETH
        ]
        unit = make_unit(legs=legs, bundle_taxability_override="taxable")
        
        calculator = TaxabilityCalculator(base_config)
        assert calculator.compute(unit.outflow_legs[0]) is True

    def test_rule1_bundle_override_non_taxable(self, base_config):
        """Rule 1: Bundle override 'non_taxable' → NOT TAXABLE."""
        legs = [
            make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("1")),  # BTC
            make_leg(asset_id=1, leg_type="inflow", quantity=Decimal("40000")),   # EUR
        ]
        unit = make_unit(legs=legs, bundle_taxability_override="non_taxable")
        
        calculator = TaxabilityCalculator(base_config)
        # Even though selling to EUR would normally be taxable, override wins
        assert calculator.compute(unit.outflow_legs[0]) is False

    def test_rule2_base_currency_never_taxable(self, base_config):
        """Rule 2: Disposing base currency → NEVER TAXABLE."""
        legs = [
            make_leg(asset_id=1, leg_type="outflow", quantity=Decimal("40000")),  # EUR (base)
            make_leg(asset_id=2, leg_type="inflow", quantity=Decimal("1")),   # BTC
        ]
        unit = make_unit(legs=legs)
        
        calculator = TaxabilityCalculator(base_config)
        assert calculator.compute(unit.outflow_legs[0]) is False

    def test_rule2_base_currency_overrides_explicit_flag(self, base_config):
        """Rule 2: Base currency is NOT taxable even with explicit taxability_status."""
        tx = make_transaction(id=1, asset_id=1, quantity=Decimal("40000"), taxability_status="taxable")
        legs = [
            make_leg(asset_id=1, leg_type="outflow", quantity=Decimal("40000"), transaction=tx),  # EUR with taxable status
            make_leg(asset_id=2, leg_type="inflow", quantity=Decimal("1")),
        ]
        unit = make_unit(legs=legs)
        
        calculator = TaxabilityCalculator(base_config)
        # Base currency rule (2) takes precedence over explicit taxability_status (3a)
        assert calculator.compute(unit.outflow_legs[0]) is False

    def test_rule3a_taxability_status_taxable(self, base_config):
        """Rule 3a: taxability_status='taxable' → TAXABLE (overrides pattern)."""
        tx = make_transaction(id=1, asset_id=2, quantity=Decimal("1"), taxability_status="taxable")
        legs = [
            make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("1"), transaction=tx),
            make_leg(asset_id=2, leg_type="inflow", quantity=Decimal("1")),
        ]
        unit = make_unit(legs=legs, pattern="transfer")  # Would normally be non-taxable
        
        calculator = TaxabilityCalculator(base_config)
        # taxability_status="taxable" (3a) takes precedence over transfer pattern (6)
        assert calculator.compute(unit.outflow_legs[0]) is True

    def test_rule3b_taxability_status_non_taxable(self, base_config):
        """Rule 3b: taxability_status='non_taxable' → NOT TAXABLE (overrides later rules)."""
        tx = make_transaction(id=1, asset_id=2, quantity=Decimal("1"), taxability_status="non_taxable")
        legs = [
            make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("1"), transaction=tx),
            make_leg(asset_id=1, leg_type="inflow", quantity=Decimal("40000")),  # EUR in
        ]
        unit = make_unit(legs=legs)
        
        calculator = TaxabilityCalculator(base_config)
        # taxability_status="non_taxable" (3b) blocks sell-to-base taxability (8)
        assert calculator.compute(unit.outflow_legs[0]) is False

    def test_rule3_unknown_status_falls_through(self, base_config):
        """Rules 3a/3b: taxability_status='unknown' → falls through to later rules."""
        tx = make_transaction(id=1, asset_id=2, quantity=Decimal("1"), taxability_status="unknown")
        legs = [
            make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("1"), transaction=tx),
            make_leg(asset_id=1, leg_type="inflow", quantity=Decimal("40000")),  # EUR in
        ]
        unit = make_unit(legs=legs)
        
        calculator = TaxabilityCalculator(base_config)
        # Unknown falls through → selling to base (8) → TAXABLE
        assert calculator.compute(unit.outflow_legs[0]) is True

    def test_rule4_inflows_never_taxable(self, base_config):
        """Rule 4: Inflows → NEVER TAXABLE."""
        legs = [
            make_leg(asset_id=1, leg_type="outflow", quantity=Decimal("40000")),
            make_leg(asset_id=2, leg_type="inflow", quantity=Decimal("1")),  # Inflow
        ]
        unit = make_unit(legs=legs)
        
        calculator = TaxabilityCalculator(base_config)
        assert calculator.compute(unit.inflow_legs[0]) is False

    def test_rule5_transfer_not_taxable(self, base_config):
        """Rule 5: Cost basis transfers → NOT TAXABLE."""
        legs = [
            make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("1")),  # BTC out
            make_leg(asset_id=2, leg_type="inflow", quantity=Decimal("1")),   # BTC in
        ]
        unit = make_unit(legs=legs, pattern="transfer")
        
        calculator = TaxabilityCalculator(base_config)
        assert calculator.compute(unit.outflow_legs[0]) is False

    def test_rule5_split_not_taxable(self, base_config):
        """Rule 5: Splits → NOT TAXABLE."""
        legs = [
            make_leg(asset_id=5, leg_type="outflow", quantity=Decimal("10")),
            make_leg(asset_id=5, leg_type="inflow", quantity=Decimal("20")),
        ]
        unit = make_unit(legs=legs, pattern="split")
        
        calculator = TaxabilityCalculator(base_config)
        assert calculator.compute(unit.outflow_legs[0]) is False

    def test_rule6_fee_uses_config_true(self, base_config):
        """Rule 6: Fees use config.fee_taxable_by_default (True)."""
        legs = [
            make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("1")),
            make_leg(asset_id=3, leg_type="inflow", quantity=Decimal("10")),
            make_leg(asset_id=2, leg_type="fee", quantity=Decimal("0.001")),
        ]
        unit = make_unit(legs=legs)
        
        calculator = TaxabilityCalculator(base_config)
        assert calculator.compute(unit.fee_legs[0]) is True

    def test_rule6_fee_uses_config_false(self):
        """Rule 6: Fees use config.fee_taxable_by_default (False)."""
        config = PnLConfig(
            lot_method=CostMethod.FIFO,
            lot_mode=LotMode.LOT_TRAVEL,
            base_currency_id=1,
            base_currency_symbol="EUR",
            fee_taxable_by_default=False,
        )
        
        legs = [
            make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("1")),
            make_leg(asset_id=3, leg_type="inflow", quantity=Decimal("10")),
            make_leg(asset_id=2, leg_type="fee", quantity=Decimal("0.001")),
        ]
        unit = make_unit(legs=legs)
        
        calculator = TaxabilityCalculator(config)
        assert calculator.compute(unit.fee_legs[0]) is False

    def test_rule7_outflow_only_taxable(self, base_config):
        """Rule 7: Outflow-only (payment) → TAXABLE."""
        legs = [
            make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("1")),  # Payment, no inflow
        ]
        unit = make_unit(legs=legs)
        
        calculator = TaxabilityCalculator(base_config)
        assert calculator.compute(unit.outflow_legs[0]) is True

    def test_rule8_sell_to_base_currency_taxable(self, base_config):
        """Rule 8: Selling to base currency → TAXABLE."""
        legs = [
            make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("1")),  # BTC out
            make_leg(asset_id=1, leg_type="inflow", quantity=Decimal("40000")),   # EUR in
        ]
        unit = make_unit(legs=legs)
        
        calculator = TaxabilityCalculator(base_config)
        assert calculator.compute(unit.outflow_legs[0]) is True

    def test_rule9_crypto_swap_default_not_taxable(self, base_config):
        """Rule 9: Crypto swap with crypto_swap_taxable=False → NOT TAXABLE."""
        legs = [
            make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("1")),  # BTC out
            make_leg(asset_id=3, leg_type="inflow", quantity=Decimal("10")),   # ETH in
        ]
        unit = make_unit(legs=legs)
        
        calculator = TaxabilityCalculator(base_config)
        assert calculator.compute(unit.outflow_legs[0]) is False

    def test_rule9_crypto_swap_taxable_when_configured(self, taxable_swap_config):
        """Rule 9: Crypto swap with crypto_swap_taxable=True → TAXABLE."""
        legs = [
            make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("1")),  # BTC out
            make_leg(asset_id=3, leg_type="inflow", quantity=Decimal("10")),   # ETH in
        ]
        unit = make_unit(legs=legs)
        
        calculator = TaxabilityCalculator(taxable_swap_config)
        assert calculator.compute(unit.outflow_legs[0]) is True

    def test_no_unit_returns_false(self, base_config):
        """Leg without unit reference returns False."""
        leg = make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("1"))
        leg.unit = None
        
        calculator = TaxabilityCalculator(base_config)
        assert calculator.compute(leg) is False

    def test_apply_to_legs_batch(self, base_config):
        """Test apply_to_legs convenience method."""
        legs = [
            make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("1")),  # BTC
            make_leg(asset_id=1, leg_type="inflow", quantity=Decimal("40000")),   # EUR
            make_leg(asset_id=2, leg_type="fee", quantity=Decimal("0.001")),
        ]
        unit = make_unit(legs=legs)
        
        calculator = TaxabilityCalculator(base_config)
        disposal_legs = unit.outflow_legs + unit.fee_legs
        calculator.apply_to_legs(disposal_legs)
        
        # BTC outflow to EUR → taxable
        assert unit.outflow_legs[0].disposal_taxable is True
        # Fee → taxable (config default)
        assert unit.fee_legs[0].disposal_taxable is True


class TestTaxabilityDerivativeSettlement:
    """Test Rule 6c: Derivative settlement types are non-taxable."""

    @pytest.fixture
    def base_config(self):
        return PnLConfig(
            lot_method=CostMethod.FIFO,
            lot_mode=LotMode.LOT_TRAVEL,
            base_currency_id=1,
            base_currency_symbol="EUR",
            crypto_swap_taxable_by_default=False,
            fee_taxable_by_default=True,
        )

    def test_funding_outflow_non_taxable(self, base_config):
        """Rule 6c: Funding payment outflow → non-taxable."""
        tx = make_transaction(
            id=1, asset_id=4, quantity=Decimal("10"),  # USDT (not base)
            source_transaction_type="funding",
        )
        legs = [
            make_leg(asset_id=4, leg_type="outflow", quantity=Decimal("10"), transaction=tx),
        ]
        unit = make_unit(legs=legs)
        
        calculator = TaxabilityCalculator(base_config)
        # Rule 6c: funding → non-taxable (before Rule 7 outflow-only check)
        assert calculator.compute(unit.outflow_legs[0]) is False

    def test_perp_open_outflow_non_taxable(self, base_config):
        """Rule 6c: Perp open outflow → non-taxable."""
        tx = make_transaction(
            id=1, asset_id=4, quantity=Decimal("3000"),  # USDT (not base but not USDC either)
            source_transaction_type="perp_open",
        )
        legs = [
            make_leg(asset_id=4, leg_type="outflow", quantity=Decimal("3000"), transaction=tx),
        ]
        unit = make_unit(legs=legs)
        
        calculator = TaxabilityCalculator(base_config)
        assert calculator.compute(unit.outflow_legs[0]) is False

    def test_perp_close_inflow_non_taxable_via_rule4(self, base_config):
        """Rule 4: Perp close inflow → non-taxable (inflows never taxable)."""
        tx = make_transaction(
            id=1, asset_id=4, quantity=Decimal("3500"),
            source_transaction_type="perp_close",
        )
        legs = [
            make_leg(asset_id=4, leg_type="inflow", quantity=Decimal("3500"), transaction=tx),
        ]
        unit = make_unit(legs=legs)
        
        calculator = TaxabilityCalculator(base_config)
        # Inflows are caught by Rule 4 before we even reach 6c
        assert calculator.compute(unit.inflow_legs[0]) is False

    def test_non_derivative_outflow_still_taxable(self, base_config):
        """Non-derivative outflows should still follow normal taxability rules."""
        tx = make_transaction(
            id=1, asset_id=2, quantity=Decimal("1"),  # BTC
            source_transaction_type="withdraw",
        )
        legs = [
            make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("1"), transaction=tx),
        ]
        unit = make_unit(legs=legs)
        
        calculator = TaxabilityCalculator(base_config)
        # Regular outflow → Rule 7 → taxable
        assert calculator.compute(unit.outflow_legs[0]) is True

    def test_taxability_status_overrides_derivative_rule(self, base_config):
        """Rule 3a: Explicit taxable status overrides Rule 6c derivative check."""
        tx = make_transaction(
            id=1, asset_id=4, quantity=Decimal("10"),
            source_transaction_type="funding",
            taxability_status="taxable",  # Explicit taxable override
        )
        legs = [
            make_leg(asset_id=4, leg_type="outflow", quantity=Decimal("10"), transaction=tx),
        ]
        unit = make_unit(legs=legs)
        
        calculator = TaxabilityCalculator(base_config)
        # Rule 3a (taxable override) takes precedence over Rule 6c (derivative)
        assert calculator.compute(unit.outflow_legs[0]) is True
