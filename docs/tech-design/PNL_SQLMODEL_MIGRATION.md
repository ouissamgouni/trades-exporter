# Plan: Migrate P&L Engine to SQLModel

This plan migrates the P&L engine from using transient `dataclasses` to using the existing `SQLModel` database entities directly. This eliminates the need for manual mapping during persistence and unifies the data structures.

## Goals

1. **Eliminate Redundancy**: Remove `InMemoryLot`, `RealizedPnLEntry`, `ConsumedSlice`, `SettlementRecord`, and `PnLWarning` dataclasses.
2. **Direct Persistence**: Use `CostLot`, `RealizedPnl`, `ConsumedLotSlice`, `LotSettlement`, and `PnlWarning` (SQLModel) throughout the engine.
3. **Simplify Asset Handling**: Remove `AssetRef` and rely on `Asset` (SQLModel) or `asset_id`.

## Steps

### 1. Enhance DB Models

Update `CostLot` in [backend/db/models.py](backend/db/models.py) to include domain logic currently in `InMemoryLot`.

- Add `consume(qty)` method to `CostLot`.
- Ensure `CostLot` has necessary runtime properties (e.g., `is_settled`, `settled_cost_in_base` as private attributes if not persisted).

### 2. Refactor P&L Models

In [backend/services/pnl/models.py](backend/services/pnl/models.py):

- Remove `AssetRef` class.
- Remove `InMemoryLot`, `RealizedPnLEntry`, `ConsumedSlice`, `SettlementRecord`, `PnLWarning`.
- Import `CostLot`, `RealizedPnl`, `ConsumedLotSlice`, `LotSettlement`, `PnlWarning` from `backend.db.models`.
- Update `RuntimeCalculationUnit` and `ExpandedLeg` to use `Asset` (SQLModel) instead of `AssetRef`.
- Update `UnitExecutionResult` to use SQLModel types.

### 3. Update Leg Expander

In [backend/services/pnl/leg_expander.py](backend/services/pnl/leg_expander.py):

- Update `ExpandedLeg` definition to use `Asset` model.
- Update expansion logic to populate `asset` field from `NormalizedTransaction`.

### 4. Update Lot Manager

In [backend/services/pnl/lot_manager.py](backend/services/pnl/lot_manager.py):

- Update type hints to use `CostLot`.
- Update logic to instantiate `CostLot` instead of `InMemoryLot`.

### 5. Update Engine Logic

In [backend/services/pnl/engine.py](backend/services/pnl/engine.py):

- Update `process_unit` and sub-methods to work with SQLModel objects.
- Simplify `save_draft` to just add/flush the objects (since they are already SQLModel instances).
- Ensure `Asset` objects are properly attached/detached from session if needed (though keeping them attached is usually fine for a single request).

## Verification

- Run P&L tests to ensure calculation logic remains correct.
- Verify that `save_draft` correctly persists the data.
