#!/usr/bin/env python3
"""
Add missing price getters to assets in the DB.

1. Add yahoo_direct as fallback for crypto assets that only have CoinGecko
2. Add forex getter for fiat currencies (EUR, USD)
3. Add CoinGecko for crypto assets with no getter
4. Add yahoo_direct for stock assets with no getter
"""
import psycopg2

DB = "postgresql://trades_user:trades_password@localhost:5432/trades_db_dev"

# Yahoo ticker mapping for crypto assets
CRYPTO_YAHOO_TICKERS = {
    "AAVE": "AAVE-USD",
    "ALGO": "ALGO-USD",
    "ASTER": None,  # Too new for Yahoo
    "AVO": None,  # Not on Yahoo
    "BTC": "BTC-USD",
    "CCD": None,  # Not on Yahoo
    "CRO": "CRO-USD",
    "ETH": "ETH-USD",
    "GRT": "GRT-USD",
    "HYPE": "HYPE-USD",
    "IOTX": "IOTX-USD",
    "KITE": None,  # Not on Yahoo
    "LINK": "LINK-USD",
    "LMTS": None,  # Not on Yahoo
    "ODOS": None,  # Not on Yahoo
    "ONDO": "ONDO-USD",
    "PEAQ": None,  # Not on Yahoo
    "PLAY": None,  # Not on Yahoo
    "POL": "POL-USD",
    "PUMP": None,  # Not on Yahoo
    "RENDER": "RENDER-USD",
    "RINGFENCE": None,  # Not on Yahoo
    "TAO": "TAO-USD",
    "UNI": "UNI-USD",
    "USDT": "USDT-USD",
    "VIRTUAL": "VIRTUAL-USD",
    "VULT": None,  # Not on Yahoo
    "WLD": "WLD-USD",
    "XPL": None,  # Not on Yahoo
    "XRP": "XRP-USD",
    "ZEC": "ZEC-USD",
    # Assets that currently have NO getters:
    "KTA": "kite-ai",  # coingecko id
    "MORPHO": "morpho",  # coingecko id
    "PLUME": "plume-2",  # coingecko id
    "RING": "ring-financial",  # coingecko id
    "TEL": "telcoin",  # coingecko id
    "TRX": "tron",  # coingecko id
}

# CoinGecko IDs for crypto with no getters
CRYPTO_COINGECKO_IDS = {
    "KTA": "kite-ai",
    "MORPHO": "morpho",
    "PLUME": "plume-2",
    "RING": "ring-financial",
    "TEL": "telcoin",
    "TRX": "tron",
}

# Yahoo tickers for crypto with no getters
CRYPTO_YAHOO_DIRECT_IDS = {
    "KTA": None,
    "MORPHO": "MORPHO-USD",
    "PLUME": None,
    "RING": None,
    "TEL": "TEL-USD",
    "TRX": "TRX-USD",
}

# Stock assets with no getters -> yahoo_direct
STOCK_YAHOO_TICKERS = {
    "AAPL": "AAPL",
    "GOOGL": "GOOGL",
    "MSFT": "MSFT",
}


def main():
    conn = psycopg2.connect(DB)
    cur = conn.cursor()

    added = 0

    # 1. Get all assets with their current getters
    cur.execute("""
        SELECT a.asset_id, a.symbol, a.price_type,
               array_agg(apg.price_getter) FILTER (WHERE apg.enabled = true) as getters
        FROM assets a
        LEFT JOIN asset_price_getters apg ON a.asset_id = apg.asset_id
        GROUP BY a.asset_id, a.symbol, a.price_type
        ORDER BY a.symbol
    """)
    assets = {row[1]: {"id": row[0], "symbol": row[1], "type": row[2], "getters": row[3] or []} for row in cur.fetchall()}

    # 2. Add yahoo_direct for crypto assets with only coingecko
    print("=== Adding yahoo_direct fallback for crypto assets ===")
    for sym, info in sorted(assets.items()):
        if info["type"] == "crypto" and "yahoo_direct" not in info["getters"]:
            ticker = CRYPTO_YAHOO_TICKERS.get(sym)
            if ticker and ticker.endswith("-USD"):
                # Check if already exists (disabled)
                cur.execute(
                    "SELECT id FROM asset_price_getters WHERE asset_id = %s AND price_getter = 'yahoo_direct'",
                    (info["id"],)
                )
                if cur.fetchone():
                    cur.execute(
                        "UPDATE asset_price_getters SET enabled = true WHERE asset_id = %s AND price_getter = 'yahoo_direct'",
                        (info["id"],)
                    )
                    print(f"  {sym:20s} re-enabled yahoo_direct ({ticker})")
                else:
                    max_pri = max([1] + [g[1] for g in _get_priorities(cur, info["id"])])
                    cur.execute(
                        """INSERT INTO asset_price_getters (asset_id, price_getter, external_id, priority, enabled, params, created_at, updated_at)
                           VALUES (%s, 'yahoo_direct', %s, %s, true, '{}', NOW(), NOW())
                           ON CONFLICT (asset_id, price_getter) DO NOTHING""",
                        (info["id"], ticker, max_pri + 1)
                    )
                    if cur.rowcount > 0:
                        print(f"  {sym:20s} added yahoo_direct ({ticker}) at pri={max_pri + 1}")
                        added += 1

    # 3. Add coingecko for crypto assets with NO getters
    print("\n=== Adding coingecko for crypto assets with no getters ===")
    for sym, cg_id in CRYPTO_COINGECKO_IDS.items():
        if sym in assets and "coingecko" not in assets[sym]["getters"]:
            cur.execute(
                """INSERT INTO asset_price_getters (asset_id, price_getter, external_id, priority, enabled, params, created_at, updated_at)
                   VALUES (%s, 'coingecko', %s, 1, true, '{}', NOW(), NOW())
                   ON CONFLICT (asset_id, price_getter) DO NOTHING""",
                (assets[sym]["id"], cg_id)
            )
            if cur.rowcount > 0:
                print(f"  {sym:20s} added coingecko ({cg_id})")
                added += 1

    # 4. Add yahoo_direct for crypto assets with no getters that have Yahoo tickers
    print("\n=== Adding yahoo_direct for crypto assets with no getters ===")
    for sym, yd_ticker in CRYPTO_YAHOO_DIRECT_IDS.items():
        if yd_ticker and sym in assets and "yahoo_direct" not in assets[sym]["getters"]:
            cur.execute(
                """INSERT INTO asset_price_getters (asset_id, price_getter, external_id, priority, enabled, params, created_at, updated_at)
                   VALUES (%s, 'yahoo_direct', %s, 2, true, '{}', NOW(), NOW())
                   ON CONFLICT (asset_id, price_getter) DO NOTHING""",
                (assets[sym]["id"], yd_ticker)
            )
            if cur.rowcount > 0:
                print(f"  {sym:20s} added yahoo_direct ({yd_ticker})")
                added += 1

    # 5. Add yahoo_direct for stock assets with no getters
    print("\n=== Adding yahoo_direct for stocks with no getters ===")
    for sym, ticker in STOCK_YAHOO_TICKERS.items():
        if sym in assets and "yahoo_direct" not in assets[sym]["getters"]:
            cur.execute(
                """INSERT INTO asset_price_getters (asset_id, price_getter, external_id, priority, enabled, params, created_at, updated_at)
                   VALUES (%s, 'yahoo_direct', %s, 1, true, '{}', NOW(), NOW())
                   ON CONFLICT (asset_id, price_getter) DO NOTHING""",
                (assets[sym]["id"], ticker)
            )
            if cur.rowcount > 0:
                print(f"  {sym:20s} added yahoo_direct ({ticker})")
                added += 1

    # 6. Add forex getter for EUR and USD
    print("\n=== Adding forex getter for fiat currencies ===")
    for sym in ["EUR", "USD"]:
        if sym in assets and "forex" not in assets[sym]["getters"]:
            cur.execute(
                """INSERT INTO asset_price_getters (asset_id, price_getter, external_id, priority, enabled, params, created_at, updated_at)
                   VALUES (%s, 'forex', %s, 1, true, '{"to_currency": "EUR"}', NOW(), NOW())
                   ON CONFLICT (asset_id, price_getter) DO NOTHING""",
                (assets[sym]["id"], sym)
            )
            if cur.rowcount > 0:
                print(f"  {sym:20s} added forex")
                added += 1

    conn.commit()
    print(f"\n=== Done. Added {added} new getter assignments. ===")

    # Summary
    cur.execute("""
        SELECT a.symbol, a.price_type,
               array_agg(apg.price_getter ORDER BY apg.priority) FILTER (WHERE apg.enabled = true) as getters
        FROM assets a
        LEFT JOIN asset_price_getters apg ON a.asset_id = apg.asset_id
        GROUP BY a.symbol, a.price_type
        HAVING array_agg(apg.price_getter) FILTER (WHERE apg.enabled = true) IS NULL
        ORDER BY a.symbol
    """)
    still_no = cur.fetchall()
    print(f"\nAssets STILL with no getters ({len(still_no)}):")
    for sym, pt, _ in still_no:
        print(f"  {sym:20s} {pt} (manual/fees asset)")

    conn.close()


def _get_priorities(cur, asset_id):
    """Get current priorities for an asset."""
    cur.execute(
        "SELECT price_getter, priority FROM asset_price_getters WHERE asset_id = %s AND enabled = true",
        (asset_id,)
    )
    return cur.fetchall()


if __name__ == "__main__":
    main()
