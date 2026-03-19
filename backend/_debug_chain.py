"""Debug: check pnl_id population on consumed_lot_slices."""
from backend.db.database import get_engine
from sqlmodel import Session, select
from sqlalchemy import func
from backend.db.models import ConsumedLotSlice, CostLot, CalculationUnit

engine = get_engine()
with Session(engine) as s:
    # How many slices in v87 have pnl_id set vs NULL?
    v87_slices = s.exec(
        select(ConsumedLotSlice)
        .join(CostLot, ConsumedLotSlice.cost_lot_id == CostLot.cost_lot_id)
        .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == 87)
    ).all()

    with_pnl = [sl for sl in v87_slices if sl.pnl_id is not None]
    without_pnl = [sl for sl in v87_slices if sl.pnl_id is None]
    print(f"V87 slices total: {len(v87_slices)}")
    print(f"  with pnl_id: {len(with_pnl)}")
    print(f"  without pnl_id (NULL): {len(without_pnl)}")

    if with_pnl:
        print(f"  Sample with pnl_id: slice_id={with_pnl[0].slice_id}, pnl_id={with_pnl[0].pnl_id}")
    if without_pnl:
        sl = without_pnl[0]
        print(f"  Sample without pnl_id: slice_id={sl.slice_id}, cost_lot_id={sl.cost_lot_id}, unit_id={sl.unit_id}, consumed_by_leg_id={sl.consumed_by_leg_id}")
