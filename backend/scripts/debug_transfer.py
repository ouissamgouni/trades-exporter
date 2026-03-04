"""Debug script to investigate transfer unit 1829."""
import sys
sys.path.insert(0, "/Users/ouissamgouni/Documents/it-workspace/trades-exporter")

from backend.db.database import get_engine
from sqlmodel import Session, text

engine = get_engine()
with Session(engine) as session:
    # 1. Consumed slices for unit 1829
    result = session.exec(text(
        "SELECT s.slice_id, s.cost_lot_id, s.consumed_by_leg_id, s.unit_id, "
        "s.quantity, s.unit_cost_in_base, s.total_cost_in_base "
        "FROM consumed_lot_slices s WHERE s.unit_id = 1829 ORDER BY s.slice_id"
    )).all()
    print(f"=== Consumed slices for unit 1829: {len(result)} ===")
    for r in result:
        print(f"  slice={r[0]} lot={r[1]} leg={r[2]} unit={r[3]} qty={r[4]} cost={r[6]}")

    # 2. All lot events for PLAY (asset_id=254)
    result2 = session.exec(text(
        "SELECT e.event_id, e.event_type, e.lot_id, e.quantity_delta, e.triggered_by_unit_id "
        "FROM cost_lot_events e JOIN cost_lots l ON e.lot_id = l.cost_lot_id "
        "WHERE l.asset_id = 254 ORDER BY e.timestamp"
    )).all()
    print(f"\n=== All lot events for PLAY: {len(result2)} ===")
    for r in result2:
        print(f"  event={r[0]} type={r[1]} lot={r[2]} qty_delta={r[3]} unit={r[4]}")

    # 3. Cost lots for unit 1829
    result3 = session.exec(text(
        "SELECT cost_lot_id, asset_id, account_id, qty, qty_remaining, notes "
        "FROM cost_lots WHERE unit_id = 1829 ORDER BY cost_lot_id"
    )).all()
    print(f"\n=== Cost lots created by unit 1829: {len(result3)} ===")
    for r in result3:
        print(f"  lot={r[0]} asset={r[1]} account={r[2]} qty={r[3]} remaining={r[4]} notes={r[5]}")

    # 4. Calculation unit legs for unit 1829
    result4 = session.exec(text(
        "SELECT l.id, l.transaction_id, l.asset_id, l.leg_type, l.quantity "
        "FROM calculation_unit_legs l WHERE l.unit_id = 1829 ORDER BY l.id"
    )).all()
    print(f"\n=== Legs for unit 1829: {len(result4)} ===")
    for r in result4:
        print(f"  leg={r[0]} tx={r[1]} asset={r[2]} type={r[3]} qty={r[4]}")

    # 5. Check warnings for unit 1829
    result5 = session.exec(text(
        "SELECT warning_id, warning_type, message "
        "FROM pnl_warnings WHERE unit_id = 1829"
    )).all()
    print(f"\n=== Warnings for unit 1829: {len(result5)} ===")
    for r in result5:
        print(f"  warning={r[0]} type={r[1]} msg={r[2]}")
