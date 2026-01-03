"""
Negative Lot Settlement Strategy
================================

**Status: IMPLEMENTED** ✅

This document describes how to handle insufficient lots when allow_negative_balances=True.

## Problem Statement

When a disposal (sell/swap/payment) occurs but there are insufficient lots:

1. Current: Creates negative lot with unit_cost=0, P&L shows 100% profit (incorrect)
2. Later acquisitions don't "settle" the negative lot
3. No mechanism to correct the P&L when actual cost becomes known

## Solution: Settlement-Based Approach (IMPLEMENTED)

### Key Concepts

1. **Negative Lot**: Represents a "debt" of an asset
   - qty = -N (negative value indicates debt)
   - qty_remaining = N (positive amount owed, to be settled)
   - is_negative = True
   - is_settled = False (until filled by later acquisition)
   - provisional_cost = 0 (unknown until settled)

2. **Settlement**: When a later acquisition arrives, it "fills" negative lots first
   - The acquisition's cost basis is applied to the negative lot
   - Creates an adjustment P&L entry to correct the original (if taxable)

3. **Provisional P&L**: P&L entries from negative lot disposals are marked provisional
   - provisional = True
   - adjusted_by_pnl_id = None (until adjustment entry created)

### Flow Diagram

```
TIMELINE:
─────────────────────────────────────────────────────────────────────>
     │                              │
     │ DISPOSAL: Sell 10 BTC       │ ACQUISITION: Buy 10 BTC
     │ (no lots available)          │ (cost = $500,000)
     │                              │
     ▼                              ▼
┌─────────────────────┐       ┌─────────────────────────────────┐
│ Create negative lot │       │ 1. Find unsettled negative lot  │
│ qty_remaining = 10  │       │ 2. Apply cost to negative lot   │
│ is_negative = True  │       │ 3. Mark lot as settled          │
│ unit_cost = 0       │       │ 4. Create adjustment P&L        │
│ is_settled = False  │       │ 5. Remaining qty → new lot      │
└─────────────────────┘       └─────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────────┐       ┌─────────────────────────────────┐
│ P&L Entry:          │       │ Adjustment P&L Entry:           │
│ proceeds = $600,000 │       │ adjustment_type = COST_UPDATE   │
│ cost_basis = $0     │       │ original_pnl_id = <above>       │
│ pnl = +$600,000     │       │ cost_basis_delta = -$500,000    │
│ provisional = True  │       │ pnl_delta = -$500,000           │
└─────────────────────┘       │ (corrects to actual $100k gain) │
                              └─────────────────────────────────┘
```

### Model Changes

```python
# InMemoryLot additions
@dataclass
class InMemoryLot:
    # ... existing fields ...
    is_negative: bool = False
    is_settled: bool = False  # NEW: True when negative lot is filled
    settled_cost: Optional[Decimal] = None  # NEW: Cost applied during settlement
    settled_by_lot_uuid: Optional[UUID] = None  # NEW: Reference to settling lot

# RealizedPnLEntry additions
@dataclass
class RealizedPnLEntry:
    # ... existing fields ...
    is_provisional: bool = False  # NEW: True if from negative lot
    adjustment_type: Optional[str] = None  # NEW: "cost_update" for adjustments
    original_pnl_id: Optional[int] = None  # NEW: Reference to provisional entry
```

### Implementation Changes

#### 1. lot_manager.py - settle_negative_lots()

```python
def settle_negative_lots(
    self,
    account_id: Optional[int],
    asset_id: int,
    available_qty: Decimal,
    unit_cost: Decimal,
    source_lot_uuid: UUID,
) -> Tuple[Decimal, List[SettledLot]]:
    """
    Settle negative lots with a new acquisition's cost basis.
    
    Args:
        account_id: Account ID
        asset_id: Asset to settle
        available_qty: Quantity from new acquisition
        unit_cost: Unit cost of new acquisition
        source_lot_uuid: UUID of the settling lot
        
    Returns:
        (remaining_qty, list of settled lot info)
    """
    key = self._get_key(account_id, asset_id)
    negative_lots = self.negative_lots_map.get(key, [])
    settled: List[SettledLot] = []
    remaining_qty = available_qty
    
    for neg_lot in list(negative_lots):
        if remaining_qty <= 0:
            break
        if neg_lot.is_settled:
            continue
            
        settle_qty = min(remaining_qty, neg_lot.qty_remaining)
        
        # Update negative lot
        neg_lot.qty_remaining -= settle_qty
        neg_lot.settled_cost = (neg_lot.settled_cost or Decimal("0")) + settle_qty * unit_cost
        
        if neg_lot.qty_remaining <= 0:
            neg_lot.is_settled = True
            neg_lot.settled_by_lot_uuid = source_lot_uuid
            
        settled.append(SettledLot(
            negative_lot=neg_lot,
            qty_settled=settle_qty,
            cost_applied=settle_qty * unit_cost,
        ))
        
        remaining_qty -= settle_qty
    
    return remaining_qty, settled
```

#### 2. group_handler.py - Modified acquisition handling

```python
def _handle_acquisition(
    # ... existing params ...
):
    # First, check for and settle negative lots
    for inflow in inflows:
        inflow_qty = Decimal(str(inflow.quantity)) if inflow.quantity else Decimal("0")
        if inflow_qty <= 0:
            continue
            
        # Calculate unit cost for this acquisition
        unit_cost = _calculate_acquisition_cost(...)
        
        # Try to settle negative lots first
        remaining_qty, settled = lot_manager.settle_negative_lots(
            account_id=inflow.account_id,
            asset_id=inflow.asset_id,
            available_qty=inflow_qty,
            unit_cost=unit_cost,
            source_lot_uuid=uuid4(),
        )
        
        # Create adjustment entries for settled lots
        for settlement in settled:
            if settlement.negative_lot.origin_pnl_id:
                # Create adjustment P&L entry
                adjustment = RealizedPnLEntry(
                    adjustment_type="cost_update",
                    original_pnl_id=settlement.negative_lot.origin_pnl_id,
                    cost_basis_delta=settlement.cost_applied,
                    pnl_delta=-settlement.cost_applied,
                    # ... other fields ...
                )
                result.adjustment_entries.append(adjustment)
        
        # Create lot for remaining quantity
        if remaining_qty > 0:
            new_lot = InMemoryLot(
                qty=remaining_qty,
                qty_remaining=remaining_qty,
                unit_cost_in_base=unit_cost,
                # ...
            )
            lot_manager.add_lot(new_lot)
            result.created_lots.append(new_lot)
```

### Balance Calculation

```python
def get_balance(self, account_id: Optional[int], asset_id: int) -> Decimal:
    """
    Get current balance including negative lots.
    
    Returns:
        Net balance (positive lots - unsettled negative lots)
    """
    key = self._get_key(account_id, asset_id)
    
    # Positive balance from regular lots
    positive_lots = self.lots_map.get(key, deque())
    positive_balance = sum(lot.qty_remaining for lot in positive_lots if not lot.is_negative)
    
    # Negative balance from unsettled negative lots
    negative_lots = self.negative_lots_map.get(key, [])
    negative_balance = sum(lot.qty_remaining for lot in negative_lots if not lot.is_settled)
    
    return positive_balance - negative_balance
```

### P&L Report Implications

When displaying P&L:

1. **Provisional entries**: Show with warning indicator
2. **Settlement adjustments**: Can show:
   - Original entry (provisional)
   - Adjustment entry
   - OR: Merged final entry

```python
# Option: Show corrected P&L
def get_corrected_pnl_entry(original, adjustment):
    return RealizedPnLEntry(
        proceeds_in_base=original.proceeds_in_base,
        cost_basis_in_base=original.cost_basis_in_base + adjustment.cost_basis_delta,
        pnl_in_base=original.pnl_in_base + adjustment.pnl_delta,
        is_provisional=False,  # Now corrected
    )
```

### Migration Strategy

1. Add new fields to InMemoryLot and RealizedPnLEntry
2. Existing negative lots: Mark as is_settled=False
3. Re-run P&L calculation to generate settlements
4. OR: Manual review and settlement

### Configuration Options

```python
@dataclass
class PnLConfig:
    # ... existing ...
    allow_negative_balances: bool = False
    negative_lot_settlement_mode: str = "fifo"  # "fifo", "lifo", "manual"
    auto_create_adjustment_entries: bool = True
    mark_provisional_entries: bool = True
```

### Warnings and UI Considerations

1. **Provisional Warning**: "This P&L entry has unknown cost basis and may be adjusted"
2. **Unsettled Negative Lots**: Show in UI with option to manually assign cost
3. **Settlement Log**: Track what was settled and when

### Edge Cases

1. **Partial settlement**: Negative lot of 10, acquisition of 5
   - Settle 5 units, negative lot still has 5 remaining

2. **Multiple acquisitions**: Several small purchases fill one large negative lot
   - Weighted average cost or FIFO assignment

3. **Different accounts (LOT_TRAVEL mode)**:
   - Negative lot in Account A, acquisition in Account B
   - Option: Only settle within same account OR allow cross-account settlement

4. **Different base versions**:
   - Negative lot from version 1, acquisition in version 2
   - Should only settle within same version
"""

# This is a design document - no actual code implementation yet
