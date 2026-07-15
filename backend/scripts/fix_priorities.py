#!/usr/bin/env python3
"""Fix priority ordering: promote yahoo_direct over datareader for stocks.
Also try alternative Yahoo tickers for the 4 failed crypto ETNs."""

import psycopg2
from collections import defaultdict

DB_URL = "postgresql://trades_user:trades_password@localhost:5432/trades_db_dev"

def main():
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()

    # Get all enabled getter assignments
    cur.execute("""
        SELECT a.asset_id, a.symbol, a.price_type, apg.id as apg_id,
               apg.price_getter, apg.external_id, apg.priority
        FROM assets a
        JOIN asset_price_getters apg ON a.asset_id = apg.asset_id
        WHERE apg.enabled = true
        ORDER BY a.symbol, apg.priority
    """)
    rows = cur.fetchall()
    print(f"Total getter assignments: {len(rows)}")

    by_asset = defaultdict(list)
    for aid, sym, ptype, apg_id, getter, ext_id, pri in rows:
        by_asset[sym].append({
            "asset_id": aid, "symbol": sym, "price_type": ptype,
            "apg_id": apg_id, "getter": getter, "ext_id": ext_id or "", "priority": pri
        })

    # --- Reorder: swap datareader and yahoo_direct where datareader has higher priority ---
    swaps = 0
    print("\n=== Priority Swaps (datareader <-> yahoo_direct) ===")
    for sym, getters in sorted(by_asset.items()):
        getter_map = {g["getter"]: g for g in getters}
        if "datareader" in getter_map and "yahoo_direct" in getter_map:
            dr = getter_map["datareader"]
            yd = getter_map["yahoo_direct"]
            if dr["priority"] < yd["priority"]:
                # Swap priorities
                print(f"  {sym:20s} datareader pri {dr['priority']} -> {yd['priority']}, "
                      f"yahoo_direct pri {yd['priority']} -> {dr['priority']}")
                cur.execute("UPDATE asset_price_getters SET priority = %s WHERE id = %s",
                            (yd["priority"], dr["apg_id"]))
                cur.execute("UPDATE asset_price_getters SET priority = %s WHERE id = %s",
                            (dr["priority"], yd["apg_id"]))
                swaps += 1

    print(f"\nTotal swaps: {swaps}")

    # --- Also for crypto assets: ensure coingecko is priority 1 if it exists ---
    cg_swaps = 0
    print("\n=== CoinGecko Priority Fixes (crypto assets) ===")
    for sym, getters in sorted(by_asset.items()):
        getter_map = {g["getter"]: g for g in getters}
        if "coingecko" in getter_map:
            cg = getter_map["coingecko"]
            if cg["priority"] != 1:
                # Find what's at priority 1 and swap
                pri1 = [g for g in getters if g["priority"] == 1]
                if pri1:
                    other = pri1[0]
                    print(f"  {sym:20s} coingecko pri {cg['priority']} -> 1, "
                          f"{other['getter']} pri 1 -> {cg['priority']}")
                    cur.execute("UPDATE asset_price_getters SET priority = 1 WHERE id = %s",
                                (cg["apg_id"],))
                    cur.execute("UPDATE asset_price_getters SET priority = %s WHERE id = %s",
                                (cg["priority"], other["apg_id"]))
                    cg_swaps += 1
                else:
                    print(f"  {sym:20s} coingecko pri {cg['priority']} -> 1 (no conflict)")
                    cur.execute("UPDATE asset_price_getters SET priority = 1 WHERE id = %s",
                                (cg["apg_id"],))
                    cg_swaps += 1

    print(f"\nTotal CoinGecko fixes: {cg_swaps}")

    # --- Show the 4 failed crypto ETNs ---
    print("\n=== 4 Failed Crypto ETNs (current config) ===")
    for sym in ["CSDA.DE", "SLNC.DE", "WBIT.DE", "WETH.DE"]:
        if sym in by_asset:
            for g in by_asset[sym]:
                print(f"  {sym:12s} {g['getter']:15s} pri={g['priority']} ext_id={g['ext_id']}")
        else:
            print(f"  {sym:12s} NOT FOUND")

    conn.commit()
    print("\n=== Done. Changes committed. ===")
    conn.close()


if __name__ == "__main__":
    main()
