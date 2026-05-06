"""Suggest ISIN-to-Asset mappings from a DeGiro Transactions.csv.

Matches each unique ISIN in the CSV to existing assets in the DB using:
1. Field matching: (date, quantity, price) tuples from CSV matched against
   existing normalized_transactions for account_id=314 (DeGiro).
2. Label similarity: case-insensitive substring match of asset.label vs CSV product name.

Outputs:
- Console table with suggestions
- CSV file at data/output/isin_mapping_suggestions.csv for user review

Usage:
    PYTHONPATH=/path/to/trades-exporter .venv/bin/python scripts/suggest_isin_mapping.py \
        --transactions-csv data/input/brokers-exports/degiro/Transactions.csv
"""
import sys
import csv
import argparse
from decimal import Decimal
from datetime import datetime
from pathlib import Path
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.db.database import get_engine
from backend.file_loaders.trades_csv_loader import parse_european_number
from sqlmodel import Session, text

DEGIRO_ACCOUNT_ID = 314
SOURCE = "csv-trades"


def parse_degiro_csv(csv_path: str) -> list[dict]:
    """Parse DeGiro Transactions.csv and return list of row dicts."""
    rows = []
    with open(csv_path, "r", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader)
        # DeGiro CSV has unnamed currency columns after Price and Local value
        # Headers: Date,Time,Product,ISIN,Reference exchange,Venue,Quantity,Price,,Local value,,Value EUR,...
        for line in reader:
            if not line or not line[0].strip():
                continue
            row = {}
            row["date_str"] = line[0].strip()
            row["time_str"] = line[1].strip()
            row["product"] = line[2].strip()
            row["isin"] = line[3].strip()
            row["quantity"] = parse_european_number(line[6]) if len(line) > 6 else None
            row["price"] = parse_european_number(line[7]) if len(line) > 7 else None
            row["price_currency"] = line[8].strip() if len(line) > 8 else ""
            # Parse date
            try:
                row["date"] = datetime.strptime(row["date_str"], "%d-%m-%Y").date()
            except ValueError:
                continue
            if row["isin"] and row["quantity"] is not None and row["price"] is not None:
                rows.append(row)
    return rows


def main():
    parser = argparse.ArgumentParser(description="Suggest ISIN→Asset mappings from DeGiro CSV")
    parser.add_argument(
        "--transactions-csv",
        required=True,
        help="Path to DeGiro Transactions.csv",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output CSV path (default: data/output/isin_mapping_suggestions.csv)",
    )
    args = parser.parse_args()

    if args.output is None:
        output_dir = Path(__file__).resolve().parents[1] / "data" / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / "isin_mapping_suggestions.csv"
    else:
        output_path = Path(args.output)

    # 1. Parse CSV
    print(f"\n📄 Parsing {args.transactions_csv}...")
    csv_rows = parse_degiro_csv(args.transactions_csv)
    print(f"   Found {len(csv_rows)} transaction rows")

    # Group by ISIN
    isin_groups: dict[str, list[dict]] = defaultdict(list)
    for row in csv_rows:
        isin_groups[row["isin"]].append(row)
    print(f"   {len(isin_groups)} unique ISINs")

    # 2. Load DB data
    engine = get_engine()
    with Session(engine) as session:
        # Load existing transactions for DeGiro account
        db_rows = session.exec(text(
            "SELECT nt.id, nt.source_asset_symbol, nt.date_time, nt.quantity, nt.price, a.asset_id, a.label "
            "FROM normalized_transactions nt "
            "LEFT JOIN assets a ON a.asset_id = nt.asset_id "
            "WHERE nt.account_id = :account_id AND nt.source = :source "
            "ORDER BY nt.date_time"
        ), params={"account_id": DEGIRO_ACCOUNT_ID, "source": SOURCE}).all()

        print(f"\n🗄️  Loaded {len(db_rows)} existing transactions from DB")

        # Index DB rows by (date, quantity, price) for field matching
        db_index: dict[tuple, list] = defaultdict(list)
        for row in db_rows:
            tx_id, symbol, dt, qty, price, asset_id, label = row
            day = dt.date() if dt else None
            # Normalize quantity/price for comparison
            key = (day, qty, price)
            db_index[key].append({
                "tx_id": tx_id,
                "symbol": symbol,
                "asset_id": asset_id,
                "label": label or "",
            })

        # Load all assets for label matching fallback
        all_assets = session.exec(text(
            "SELECT asset_id, symbol, label FROM assets WHERE label IS NOT NULL AND label != ''"
        )).all()
        assets_by_id: dict[int, dict] = {}
        for aid, sym, lbl in all_assets:
            assets_by_id[aid] = {"symbol": sym, "label": lbl}

    # 3. Match each ISIN
    suggestions = []
    for isin, rows in sorted(isin_groups.items()):
        product_name = rows[0]["product"]

        # Field matching: try (date, qty, price) lookups
        symbol_votes: dict[str, int] = defaultdict(int)
        matched_asset_id = None
        matched_label = ""

        for row in rows:
            key = (row["date"], row["quantity"], row["price"])
            if key in db_index:
                for match in db_index[key]:
                    symbol_votes[match["symbol"]] += 1
                    matched_asset_id = match["asset_id"]
                    matched_label = match["label"]

        if symbol_votes:
            # Pick symbol with most votes
            best_symbol = max(symbol_votes, key=symbol_votes.get)
            match_count = symbol_votes[best_symbol]
            # Get asset_id for best symbol from any match
            for row in rows:
                key = (row["date"], row["quantity"], row["price"])
                if key in db_index:
                    for match in db_index[key]:
                        if match["symbol"] == best_symbol:
                            matched_asset_id = match["asset_id"]
                            matched_label = match["label"]
                            break
            confidence = "high"
        else:
            # Fallback: label similarity
            best_symbol = ""
            match_count = 0
            matched_asset_id = None
            matched_label = ""
            confidence = "none"

            product_lower = product_name.lower()
            for aid, info in assets_by_id.items():
                label_lower = info["label"].lower()
                # Check substring match in both directions
                if label_lower in product_lower or product_lower in label_lower:
                    best_symbol = info["symbol"]
                    matched_asset_id = aid
                    matched_label = info["label"]
                    confidence = "medium"
                    break

        suggestions.append({
            "isin": isin,
            "csv_product": product_name,
            "suggested_symbol": best_symbol,
            "suggested_asset_id": matched_asset_id or "",
            "match_count": match_count,
            "csv_rows": len(rows),
            "confidence": confidence,
            "label_match": matched_label,
        })

    # 4. Display results
    print(f"\n{'='*120}")
    print(f"{'ISIN':<15} {'CSV Product':<45} {'Symbol':<12} {'ID':<6} {'Matches':<9} {'Conf.':<8} {'Label'}")
    print(f"{'='*120}")
    for s in suggestions:
        conf_icon = {"high": "✅", "medium": "⚠️ ", "none": "❌"}.get(s["confidence"], "?")
        print(
            f"{s['isin']:<15} {s['csv_product'][:44]:<45} {s['suggested_symbol']:<12} "
            f"{str(s['suggested_asset_id']):<6} {s['match_count']}/{s['csv_rows']:<7} "
            f"{conf_icon:<8} {s['label_match']}"
        )

    # Summary
    high = sum(1 for s in suggestions if s["confidence"] == "high")
    medium = sum(1 for s in suggestions if s["confidence"] == "medium")
    none_ = sum(1 for s in suggestions if s["confidence"] == "none")
    print(f"\n📊 Summary: {high} high, {medium} medium, {none_} unmatched out of {len(suggestions)} ISINs")

    # 5. Write CSV
    with open(output_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "isin", "csv_product", "suggested_symbol", "suggested_asset_id",
            "match_count", "confidence", "confirmed",
        ])
        writer.writeheader()
        for s in suggestions:
            writer.writerow({
                "isin": s["isin"],
                "csv_product": s["csv_product"],
                "suggested_symbol": s["suggested_symbol"],
                "suggested_asset_id": s["suggested_asset_id"],
                "match_count": s["match_count"],
                "confidence": s["confidence"],
                "confirmed": "yes" if s["confidence"] == "high" else "",
            })

    print(f"\n💾 Suggestions written to: {output_path}")
    print("   Edit the 'confirmed' column and 'suggested_symbol' as needed, then run apply_isin_mapping.py")


if __name__ == "__main__":
    main()
