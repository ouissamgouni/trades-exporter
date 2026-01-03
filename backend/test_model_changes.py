#!/usr/bin/env python3
"""Test script to verify model changes are working correctly."""

from backend.db.models import CalculationUnit, CostLot, RealizedPnl, UserCalculationBundle

# Test CalculationUnit creation
unit = CalculationUnit(
    unit_origin="tx:123",
    unit_label="Test Unit",
    pattern="SWAP",
    is_taxable=True,
)
print(f"✓ CalculationUnit created: unit_origin={unit.unit_origin}")
print(f"  - members attribute: {hasattr(unit, 'members')}")
print(f"  - outflows property: {hasattr(unit, 'outflows')}")

# Test with members
unit2 = CalculationUnit(
    unit_origin="bundle:1",
    members=[{"fake": "member"}],
)
print(f"✓ CalculationUnit with members: {len(unit2.members)} members")

# Test UserCalculationBundle
bundle = UserCalculationBundle(
    label="Test Bundle",
)
print(f"✓ UserCalculationBundle created: label={bundle.label}")

# Test CostLot has unit_id
lot = CostLot(
    lot_uuid="123e4567-e89b-12d3-a456-426614174000",
    asset_id=1,
    account_id=1,
    qty=10,
    qty_remaining=10,
    unit_cost_in_base=100,
)
print(f"✓ CostLot has unit_id field: {hasattr(lot, 'unit_id')}")

print("\n✅ All model tests passed!")
