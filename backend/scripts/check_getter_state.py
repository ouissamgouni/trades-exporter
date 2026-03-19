#!/usr/bin/env python3
"""Check current getter assignments and assets with no getters."""
import psycopg2
from collections import defaultdict

DB = "postgresql://trades_user:trades_password@localhost:5432/trades_db_dev"

def main():
    conn = psycopg2.connect(DB)
    cur = conn.cursor()

    cur.execute("""
        SELECT a.symbol, a.price_type, 
               array_agg(apg.price_getter ORDER BY apg.priority) as getters,
               array_agg(apg.external_id ORDER BY apg.priority) as ext_ids
        FROM assets a
        JOIN asset_price_getters apg ON a.asset_id = apg.asset_id
        WHERE apg.enabled = true
        GROUP BY a.symbol, a.price_type
        ORDER BY a.symbol
    """)
    print("All assets with enabled getters:")
    for sym, pt, getters, ext_ids in cur.fetchall():
        print(f"  {sym:20s} {pt:8s} getters={getters} ext_ids={ext_ids}")

    print()
    cur.execute("""
        SELECT a.symbol, a.price_type
        FROM assets a
        LEFT JOIN asset_price_getters apg ON a.asset_id = apg.asset_id AND apg.enabled = true
        WHERE apg.id IS NULL
        ORDER BY a.symbol
    """)
    rows = cur.fetchall()
    print(f"Assets with NO enabled getters ({len(rows)}):")
    for sym, pt in rows:
        print(f"  {sym:20s} {pt}")

    # Check oldest transaction dates per asset
    print()
    cur.execute("""
        SELECT a.symbol, a.price_type, MIN(nt.date_time) as oldest, COUNT(*) as txn_count
        FROM normalized_transactions nt
        JOIN assets a ON a.asset_id = nt.asset_id
        GROUP BY a.symbol, a.price_type
        ORDER BY oldest
    """)
    rows = cur.fetchall()
    print(f"Oldest transaction per asset ({len(rows)} assets with transactions):")
    for sym, pt, oldest, cnt in rows:
        print(f"  {sym:20s} {pt:8s} oldest={oldest}  txns={cnt}")

    # Check existing price snapshots count
    print()
    cur.execute("""
        SELECT a.symbol, COUNT(*) as snap_count, MIN(ps.snapshot_time) as oldest_snap, MAX(ps.snapshot_time) as newest_snap
        FROM price_snapshots ps
        JOIN assets a ON a.asset_id = ps.asset_id
        GROUP BY a.symbol
        ORDER BY a.symbol
    """)
    rows = cur.fetchall()
    print(f"Existing price snapshots ({len(rows)} assets):")
    for sym, cnt, oldest, newest in rows:
        print(f"  {sym:20s} count={cnt:4d}  range={oldest} to {newest}")

    conn.close()

if __name__ == "__main__":
    main()
