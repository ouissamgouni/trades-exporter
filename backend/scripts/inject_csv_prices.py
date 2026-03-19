#!/usr/bin/env python3
"""
Inject prices from assets-prices.csv into the price_snapshots table.

CSV format:
- Row 0: header with date column + asset names with symbols in parentheses
- Row 1+: MM/DD/YYYY, price1, price2, ... (European comma decimal format)
- Empty cells = no price for that date/asset

Usage:
    PYTHONPATH=/path/to/trades-exporter .venv/bin/python scripts/inject_csv_prices.py [--dry-run]
"""

import csv
import re
import sys
from datetime import datetime
from sqlalchemy import create_engine, text

DRY_RUN = "--dry-run" in sys.argv

DB_URL = "postgresql://trades_user:trades_password@localhost:5432/trades_db_dev"
CSV_PATH = "data/input/assets/assets-prices.csv"
SOURCE = "csv_import"

def parse_european_number(s):
    """Parse European format number: '55,065' -> 55.065, '1.234,56' -> 1234.56"""
    s = s.strip().strip('"')
    if not s:
        return None
    # Remove thousand separators (dots) and replace decimal comma with dot
    # European: 1.234,56 -> 1234.56
    # Simple: 55,065 -> 55.065
    if '.' in s and ',' in s:
        # Has both: dots are thousands, comma is decimal
        s = s.replace('.', '').replace(',', '.')
    elif ',' in s:
        # Only comma: it's the decimal separator
        s = s.replace(',', '.')
    try:
        return float(s)
    except ValueError:
        return None


def main():
    engine = create_engine(DB_URL)

    with engine.connect() as conn:
        # 1. Get price_snapshots columns
        r = conn.execute(text(
            "SELECT column_name, data_type FROM information_schema.columns "
            "WHERE table_name='price_snapshots' ORDER BY ordinal_position"
        ))
        print("price_snapshots columns:")
        for row in r:
            print(f"  {row[0]}: {row[1]}")
        print()

        # 2. Get existing count
        count = conn.execute(text("SELECT COUNT(*) FROM price_snapshots")).scalar()
        print(f"Existing price_snapshots rows: {count}")
        print()

        # 3. Load asset symbol -> asset_id mapping
        r = conn.execute(text("SELECT asset_id, symbol FROM assets ORDER BY symbol"))
        db_assets = {row[1]: row[0] for row in r}
        print(f"Total assets in DB: {len(db_assets)}")

        # 4. Get quote_asset_id for EUR (base currency)
        eur_id = db_assets.get("EUR")
        if not eur_id:
            # Try to find EUR
            r = conn.execute(text("SELECT asset_id FROM assets WHERE symbol='EUR'"))
            row = r.fetchone()
            eur_id = row[0] if row else None
        print(f"EUR asset_id: {eur_id}")

        # 5. Parse CSV header
        with open(CSV_PATH, "r") as f:
            reader = csv.reader(f)
            header = next(reader)

            symbols = []
            for col in header[1:]:
                matches = re.findall(r'\(([^)]+)\)', col)
                sym = matches[-1] if matches else col.strip()
                symbols.append(sym)

            print(f"\nCSV columns: {len(symbols)} assets")

            # Map symbols to asset_ids
            symbol_to_id = {}
            unmatched = []
            for sym in symbols:
                if sym in db_assets:
                    symbol_to_id[sym] = db_assets[sym]
                else:
                    unmatched.append(sym)

            print(f"Matched to DB: {len(symbol_to_id)}")
            if unmatched:
                print(f"Unmatched ({len(unmatched)}): {unmatched}")

            # 6. Parse data rows and collect inserts
            inserts = []
            dates_seen = set()
            row_count = 0

            for row in reader:
                if not row or not row[0].strip():
                    continue

                try:
                    date = datetime.strptime(row[0].strip(), "%m/%d/%Y")
                except ValueError:
                    print(f"  Skipping invalid date: {row[0]}")
                    continue

                dates_seen.add(date.date())
                row_count += 1

                for i, val_str in enumerate(row[1:]):
                    if i >= len(symbols):
                        break
                    sym = symbols[i]
                    if sym not in symbol_to_id:
                        continue
                    price = parse_european_number(val_str)
                    if price is None or price <= 0:
                        continue

                    inserts.append({
                        "asset_id": symbol_to_id[sym],
                        "quote_asset_id": eur_id,
                        "price": price,
                        "snapshot_time": date,
                        "source": SOURCE,
                    })

        print(f"\nData rows: {row_count}")
        print(f"Date range: {min(dates_seen)} to {max(dates_seen)}")
        print(f"Price records to insert: {len(inserts)}")

        # Count per asset
        from collections import Counter
        asset_counts = Counter(r["asset_id"] for r in inserts)
        print(f"Assets with prices: {len(asset_counts)}")

        # Show top 10
        id_to_sym = {v: k for k, v in symbol_to_id.items()}
        print("\nSample counts (top 10):")
        for aid, cnt in asset_counts.most_common(10):
            print(f"  {id_to_sym.get(aid, aid)}: {cnt} prices")

        if DRY_RUN:
            print("\n--- DRY RUN: No data inserted ---")
            return

        # 7. Insert using ON CONFLICT DO UPDATE (upsert)
        # First check if there's a unique constraint
        r = conn.execute(text("""
            SELECT conname, pg_get_constraintdef(oid) 
            FROM pg_constraint 
            WHERE conrelid = 'price_snapshots'::regclass 
            AND contype IN ('u', 'p')
        """))
        constraints = list(r)
        print(f"\nConstraints on price_snapshots: {constraints}")

        # Check for unique index on (asset_id, snapshot_time, source)
        r = conn.execute(text("""
            SELECT indexname, indexdef FROM pg_indexes 
            WHERE tablename = 'price_snapshots'
        """))
        indexes = list(r)
        print(f"Indexes: {[row[0] for row in indexes]}")

        # Use batch insert with proper upsert
        batch_size = 500
        inserted = 0
        skipped = 0

        for batch_start in range(0, len(inserts), batch_size):
            batch = inserts[batch_start:batch_start + batch_size]

            for record in batch:
                try:
                    # Check if exists
                    existing = conn.execute(text("""
                        SELECT snapshot_id FROM price_snapshots 
                        WHERE asset_id = :asset_id 
                        AND DATE(snapshot_time) = DATE(:snapshot_time)
                        AND source = :source
                    """), record).fetchone()

                    if existing:
                        # Update price
                        conn.execute(text("""
                            UPDATE price_snapshots 
                            SET price = :price, quote_asset_id = :quote_asset_id
                            WHERE asset_id = :asset_id 
                            AND DATE(snapshot_time) = DATE(:snapshot_time)
                            AND source = :source
                        """), record)
                        skipped += 1
                    else:
                        conn.execute(text("""
                            INSERT INTO price_snapshots (asset_id, quote_asset_id, price, snapshot_time, source, created_at)
                            VALUES (:asset_id, :quote_asset_id, :price, :snapshot_time, :source, NOW())
                        """), record)
                        inserted += 1
                except Exception as e:
                    conn.rollback()
                    print(f"  Error inserting {record}: {e}")

            conn.commit()
            if (batch_start // batch_size + 1) % 20 == 0 or batch_start + batch_size >= len(inserts):
                print(f"  Batch {batch_start // batch_size + 1}: "
                      f"{inserted} inserted, {skipped} updated so far")

        print(f"\n=== DONE ===")
        print(f"Inserted: {inserted}")
        print(f"Updated: {skipped}")
        print(f"Total price_snapshots now: "
              f"{conn.execute(text('SELECT COUNT(*) FROM price_snapshots')).scalar()}")


if __name__ == "__main__":
    main()
