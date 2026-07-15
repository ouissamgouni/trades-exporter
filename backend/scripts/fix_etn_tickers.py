#!/usr/bin/env python3
"""Fix the 4 crypto ETN external_ids to use .HM (Hamburg) suffix for yahoo_direct."""

import psycopg2

DB_URL = "postgresql://trades_user:trades_password@localhost:5432/trades_db_dev"

FIXES = {
    "CSDA.DE": "CSDA.HM",
    "SLNC.DE": "SLNC.HM",
    "WBIT.DE": "WBIT.HM",
    "WETH.DE": "WETH.HM",
}

conn = psycopg2.connect(DB_URL)
cur = conn.cursor()

for symbol, new_ext_id in FIXES.items():
    cur.execute("""
        UPDATE asset_price_getters
        SET external_id = %s
        WHERE asset_id = (SELECT asset_id FROM assets WHERE symbol = %s)
          AND price_getter = 'yahoo_direct'
    """, (new_ext_id, symbol))
    print(f"  {symbol}: yahoo_direct external_id -> {new_ext_id} (rows: {cur.rowcount})")

conn.commit()
print("\nDone. Changes committed.")
conn.close()
