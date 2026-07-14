"""Apply confirmed ISIN mappings to the assets table.

Reads the user-edited suggestions CSV (from suggest_isin_mapping.py),
and for each confirmed row:
1. Sets assets.isin for the matched asset
2. Pre-seeds a RawAsset(source="degiro-csv", symbol=ISIN, asset_id=...) for future connector use
3. If --transactions-csv provided, sets denomination_currency based on the price currency

Usage:
    PYTHONPATH=/path/to/trades-exporter ../.venv/bin/python scripts/apply_isin_mapping.py \
        --csv data/output/isin_mapping_suggestions.csv \
        --transactions-csv data/input/brokers-exports/degiro/Transactions.csv \
        [--dry-run | --commit]
"""

import sys
import csv
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.db.database import get_engine
from sqlmodel import Session, text

DEGIRO_SOURCE = "degiro-csv"


def main():
    parser = argparse.ArgumentParser(description="Apply ISIN mappings to assets table")
    parser.add_argument(
        "--csv", required=True, help="Path to the edited suggestions CSV"
    )
    parser.add_argument(
        "--transactions-csv",
        required=False,
        help="Path to DeGiro Transactions.csv (for denomination currency)",
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--dry-run", action="store_true", default=True, help="Preview changes (default)"
    )
    group.add_argument("--commit", action="store_true", help="Apply changes to DB")
    args = parser.parse_args()

    is_commit = args.commit

    # Read confirmed mappings
    confirmed = []
    with open(args.csv, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("confirmed", "").strip().lower() == "yes":
                confirmed.append(row)

    if not confirmed:
        print(
            "❌ No confirmed mappings found. Edit the CSV and set 'confirmed' to 'yes'."
        )
        return

    print(f"\n📋 Found {len(confirmed)} confirmed mappings")
    print(f"   Mode: {'COMMIT' if is_commit else 'DRY RUN'}\n")

    engine = get_engine()
    with Session(engine) as session:
        applied = 0
        skipped = 0
        raw_assets_created = 0
        errors = []

        for row in confirmed:
            isin = row["isin"].strip()
            symbol = row["suggested_symbol"].strip()

            if not isin or not symbol:
                errors.append(f"  ⚠️  Empty ISIN or symbol: {row}")
                skipped += 1
                continue

            # Check symbol exists
            asset = session.exec(
                text(
                    "SELECT asset_id, symbol, isin FROM assets WHERE symbol = :symbol"
                ),
                params={"symbol": symbol},
            ).first()

            if not asset:
                errors.append(f"  ❌ Symbol '{symbol}' not found in assets table")
                skipped += 1
                continue

            asset_id, _, existing_isin = asset

            # Check ISIN not already assigned to another asset
            if existing_isin and existing_isin != isin:
                errors.append(
                    f"  ⚠️  Asset '{symbol}' already has ISIN '{existing_isin}', "
                    f"skipping assignment of '{isin}'"
                )
                skipped += 1
                continue

            conflict = session.exec(
                text(
                    "SELECT symbol FROM assets WHERE isin = :isin AND symbol != :symbol"
                ),
                params={"isin": isin, "symbol": symbol},
            ).first()
            if conflict:
                errors.append(
                    f"  ❌ ISIN '{isin}' already assigned to '{conflict[0]}', "
                    f"cannot assign to '{symbol}'"
                )
                skipped += 1
                continue

            # Apply
            if existing_isin == isin:
                print(f"  ⏩ {symbol:<12} already has ISIN {isin}")
            else:
                print(f"  {'✏️ ' if is_commit else '👁️ '} {symbol:<12} ← ISIN {isin}")
                if is_commit:
                    session.execute(
                        text("UPDATE assets SET isin = :isin WHERE symbol = :symbol"),
                        params={"isin": isin, "symbol": symbol},
                    )
                applied += 1

            # Pre-seed RawAsset for future connector use
            existing_raw = session.exec(
                text(
                    "SELECT id FROM raw_assets WHERE symbol = :symbol AND source = :source"
                ),
                params={"symbol": isin, "source": DEGIRO_SOURCE},
            ).first()

            if not existing_raw:
                print(f"       + RawAsset(degiro-csv, {isin}) → asset_id={asset_id}")
                if is_commit:
                    session.execute(
                        text(
                            "INSERT INTO raw_assets (symbol, source, asset_id) VALUES (:symbol, :source, :asset_id)"
                        ),
                        params={
                            "symbol": isin,
                            "source": DEGIRO_SOURCE,
                            "asset_id": asset_id,
                        },
                    )
                raw_assets_created += 1

        if is_commit:
            session.commit()

        # Report
        print(f"\n{'=' * 60}")
        if errors:
            print("\n⚠️  Issues:")
            for e in errors:
                print(e)
        print(f"\n📊 Results ({'COMMITTED' if is_commit else 'DRY RUN'}):")
        print(f"   ISINs applied: {applied}")
        print(f"   RawAssets created: {raw_assets_created}")
        print(f"   Skipped: {skipped}")

        # -----------------------------------------------------------
        # Denomination currency from Transactions.csv
        # -----------------------------------------------------------
        denom_updated = 0
        if args.transactions_csv:
            print(
                f"\n💱 Updating denomination currencies from {args.transactions_csv}..."
            )

            # Parse ISIN → price currency from transactions CSV
            isin_to_currency: dict[str, str] = {}
            with open(args.transactions_csv, "r", encoding="utf-8-sig") as f:
                reader = csv.reader(f)
                next(reader)  # skip header
                for line in reader:
                    if not line or not line[0].strip():
                        continue
                    isin = line[3].strip()
                    price_currency = line[8].strip() if len(line) > 8 else ""
                    if isin and price_currency:
                        isin_to_currency[isin] = price_currency

            # Resolve currency symbols to fiat asset IDs
            fiat_rows = session.exec(
                text("SELECT asset_id, symbol FROM assets WHERE price_type = 'fiat'")
            ).all()
            currency_to_id = {r[1]: r[0] for r in fiat_rows}

            # Update denomination for all assets with ISIN
            for isin, currency in sorted(isin_to_currency.items()):
                if currency not in currency_to_id:
                    print(
                        f"  ⚠️  Currency '{currency}' not found in fiat assets, skipping ISIN {isin}"
                    )
                    continue

                denom_id = currency_to_id[currency]
                asset_row = session.exec(
                    text(
                        "SELECT asset_id, symbol, denomination_currency_id FROM assets WHERE isin = :isin"
                    ),
                    params={"isin": isin},
                ).first()

                if not asset_row:
                    continue

                asset_id, symbol, current_denom = asset_row
                if current_denom == denom_id:
                    print(f"  ⏩ {symbol:<12} already has denomination {currency}")
                    continue

                current_label = f"id={current_denom}" if current_denom else "NOT SET"
                print(
                    f"  {'✏️ ' if is_commit else '👁️ '} {symbol:<12} denomination: {current_label} → {currency} (id={denom_id})"
                )
                if is_commit:
                    session.execute(
                        text(
                            "UPDATE assets SET denomination_currency_id = :denom_id WHERE asset_id = :asset_id"
                        ),
                        params={"denom_id": denom_id, "asset_id": asset_id},
                    )
                denom_updated += 1

            if is_commit and denom_updated > 0:
                session.commit()

            print(f"   Denominations updated: {denom_updated}")

        if not is_commit and (applied > 0 or denom_updated > 0):
            print(f"\n💡 Run with --commit to apply these changes")


if __name__ == "__main__":
    main()
