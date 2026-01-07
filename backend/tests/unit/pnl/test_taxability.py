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
        """Rule 2: Base currency is NOT taxable even with explicit flag."""
        tx = make_transaction(id=1, asset_id=1, quantity=Decimal("40000"), disposal_taxable=True)
        legs = [
            make_leg(asset_id=1, leg_type="outflow", quantity=Decimal("40000"), transaction=tx, tx_disposal_taxable=True),  # EUR with flag
            make_leg(asset_id=2, leg_type="inflow", quantity=Decimal("1")),
        ]
        unit = make_unit(legs=legs)
        
        calculator = TaxabilityCalculator(base_config)
        # Base currency rule (2) takes precedence over explicit flag (3)
        assert calculator.compute(unit.outflow_legs[0]) is False

    def test_rule3_explicit_flag_taxable(self, base_config):
        """Rule 3: Explicit tx_disposal_taxable=True → TAXABLE."""
        tx = make_transaction(id=1, asset_id=2, quantity=Decimal("1"), disposal_taxable=True)
        legs = [
            make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("1"), transaction=tx, tx_disposal_taxable=True),
            make_leg(asset_id=2, leg_type="inflow", quantity=Decimal("1")),
        ]
        unit = make_unit(legs=legs, pattern="transfer")  # Would normally be non-taxable
        
        calculator = TaxabilityCalculator(base_config)
        # Explicit flag (3) takes precedence over transfer pattern (5)
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
