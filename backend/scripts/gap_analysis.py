#!/usr/bin/env python3
"""
Gap analysis: For each asset, find the oldest transaction date,
compare with available daily prices, identify missing price days.

Usage:
    PYTHONPATH=/path/to/trades-exporter .venv/bin/python scripts/gap_analysis.py
"""

import os
import sys
from datetime import datetime, timedelta
from collections import defaultdict
from sqlalchemy import create_engine, text

DB_URL = os.environ.get("DATABASE_URL")
if not DB_URL:
    sys.exit("Error: DATABASE_URL environment variable is required.")
TODAY = datetime(2026, 3, 6).date()

def main():
    engine = create_engine(DB_URL)

    with engine.connect() as conn:
        # 1. Find oldest transaction per asset (from normalized_transactions)
        print("=" * 80)
        print("  PRICE GAP ANALYSIS")
        print("=" * 80)

        # Check which date column exists
        cols = conn.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name='normalized_transactions'"
        )).fetchall()
        col_names = [c[0] for c in cols]
        print(f"normalized_transactions columns: {col_names}")

        date_col = "executed_at" if "executed_at" in col_names else ("date_time" if "date_time" in col_names else "timestamp")
        print(f"Using date column: {date_col}")

        # Get oldest transaction per asset
        oldest_txs = conn.execute(text(f"""
            SELECT a.asset_id, a.symbol, a.price_type, 
                   MIN(nt.{date_col}) as oldest_tx,
                   MAX(nt.{date_col}) as latest_tx,
                   COUNT(*) as tx_count
            FROM normalized_transactions nt
            JOIN assets a ON a.asset_id = nt.asset_id
            GROUP BY a.asset_id, a.symbol, a.price_type
            ORDER BY a.symbol
        """)).fetchall()

        print(f"\nAssets with transactions: {len(oldest_txs)}")
        print()

        # 2. Get all price snapshot dates per asset
        price_dates = defaultdict(set)
        prices = conn.execute(text("""
            SELECT asset_id, DATE(snapshot_time) as price_date
            FROM price_snapshots
            ORDER BY asset_id, price_date
        """)).fetchall()
        for row in prices:
            price_dates[row[0]].add(row[1])
        
        print(f"Assets with price data: {len(price_dates)}")
        print()

        # 3. Business day check (skip weekends for stocks/ETFs)
        def is_business_day(d):
            return d.weekday() < 5  # Mon-Fri

        # 4. Analyze gaps per asset
        results = []
        
        for row in oldest_txs:
            asset_id, symbol, price_type, oldest_tx, latest_tx, tx_count = row
            
            if oldest_tx is None:
                continue

            start_date = oldest_tx.date() if hasattr(oldest_tx, 'date') else oldest_tx
            end_date = TODAY

            # Determine if asset needs business days only
            is_stock = price_type in ('stock', 'etf', 'fund', 'bond', None)
            is_crypto_asset = price_type == 'crypto'
            
            # Count expected price days
            available_dates = price_dates.get(asset_id, set())
            
            expected_days = []
            d = start_date
            while d <= end_date:
                if is_crypto_asset or is_business_day(d):
                    expected_days.append(d)
                d += timedelta(days=1)
            
            missing_days = [d for d in expected_days if d not in available_dates]
            covered_days = [d for d in expected_days if d in available_dates]
            
            # Find gap ranges (consecutive missing days)
            gap_ranges = []
            if missing_days:
                sorted_missing = sorted(missing_days)
                gap_start = sorted_missing[0]
                gap_end = sorted_missing[0]
                for d in sorted_missing[1:]:
                    if (d - gap_end).days <= (1 if is_crypto_asset else 3):  # Allow weekend gaps for stocks
                        gap_end = d
                    else:
                        gap_ranges.append((gap_start, gap_end))
                        gap_start = d
                        gap_end = d
                gap_ranges.append((gap_start, gap_end))

            coverage = len(covered_days) / len(expected_days) * 100 if expected_days else 0
            
            results.append({
                "asset_id": asset_id,
                "symbol": symbol,
                "price_type": price_type or "unknown",
                "oldest_tx": start_date,
                "tx_count": tx_count,
                "expected_days": len(expected_days),
                "covered_days": len(covered_days),
                "missing_days": len(missing_days),
                "coverage_pct": coverage,
                "gap_ranges": gap_ranges,
                "first_price": min(available_dates) if available_dates else None,
                "last_price": max(available_dates) if available_dates else None,
            })

        # 5. Print summary
        print("=" * 80)
        print("  COVERAGE SUMMARY")
        print("=" * 80)
        print()
        print(f"  {'Symbol':<20} {'Type':<8} {'OldestTx':<12} {'Expected':>8} "
              f"{'Covered':>8} {'Missing':>8} {'Coverage':>9} {'Gaps':>5}")
        print("  " + "─" * 95)
        
        # Sort by coverage ascending (worst first)
        results.sort(key=lambda r: r["coverage_pct"])
        
        total_expected = 0
        total_covered = 0
        total_missing = 0
        
        fully_covered = []
        partial = []
        no_prices = []
        
        for r in results:
            total_expected += r["expected_days"]
            total_covered += r["covered_days"]
            total_missing += r["missing_days"]
            
            if r["coverage_pct"] == 0:
                no_prices.append(r)
            elif r["coverage_pct"] >= 99:
                fully_covered.append(r)
            else:
                partial.append(r)
            
            # Show symbol with indicators
            indicator = "✗" if r["coverage_pct"] == 0 else ("✓" if r["coverage_pct"] >= 99 else "⚠")
            print(f"  {indicator} {r['symbol']:<18} {r['price_type']:<8} "
                  f"{str(r['oldest_tx']):<12} {r['expected_days']:>8} "
                  f"{r['covered_days']:>8} {r['missing_days']:>8} "
                  f"{r['coverage_pct']:>8.1f}% {len(r['gap_ranges']):>5}")

        print()
        print("=" * 80)
        print("  TOTALS")
        print("=" * 80)
        overall_pct = total_covered / total_expected * 100 if total_expected else 0
        print(f"  Expected price-days: {total_expected:,}")
        print(f"  Covered price-days:  {total_covered:,}")
        print(f"  Missing price-days:  {total_missing:,}")
        print(f"  Overall coverage:    {overall_pct:.1f}%")
        print()
        print(f"  Fully covered (≥99%): {len(fully_covered)} assets")
        print(f"  Partial coverage:     {len(partial)} assets")
        print(f"  No prices at all:     {len(no_prices)} assets")

        # 6. Detail the worst gaps
        print()
        print("=" * 80)
        print("  ASSETS WITH NO PRICES")
        print("=" * 80)
        for r in no_prices:
            print(f"  ✗ {r['symbol']:<20} type={r['price_type']:<8} "
                  f"oldest_tx={r['oldest_tx']}  needed={r['expected_days']} days  "
                  f"txs={r['tx_count']}")

        print()
        print("=" * 80)
        print("  LARGEST GAPS (partial coverage assets)")
        print("=" * 80)
        for r in partial:
            print(f"\n  ⚠ {r['symbol']} ({r['price_type']}) — "
                  f"{r['coverage_pct']:.1f}% coverage, "
                  f"{r['missing_days']} missing days, "
                  f"{len(r['gap_ranges'])} gap(s)")
            if r["first_price"] and r["oldest_tx"]:
                if r["first_price"] > r["oldest_tx"]:
                    print(f"    → Prices start {r['first_price']} but transactions start {r['oldest_tx']} "
                          f"(missing {(r['first_price'] - r['oldest_tx']).days} days before first price)")
            if r["last_price"]:
                if r["last_price"] < TODAY:
                    print(f"    → Last price {r['last_price']} — missing {(TODAY - r['last_price']).days} days at tail")
            # Show top 5 largest gaps
            sorted_gaps = sorted(r["gap_ranges"], key=lambda g: (g[1] - g[0]).days, reverse=True)
            for i, (gs, ge) in enumerate(sorted_gaps[:5]):
                gap_days = (ge - gs).days + 1
                print(f"    Gap {i+1}: {gs} → {ge} ({gap_days} days)")

        # 7. Write to file for reference
        output_file = "/tmp/gap_analysis.txt"
        with open(output_file, "w") as f:
            f.write(f"Gap Analysis Report - {datetime.now().strftime('%Y-%m-%d %H:%M')}\n")
            f.write(f"{'='*80}\n\n")
            f.write(f"Total assets analyzed: {len(results)}\n")
            f.write(f"Overall coverage: {overall_pct:.1f}%\n")
            f.write(f"Expected: {total_expected:,} | Covered: {total_covered:,} | Missing: {total_missing:,}\n\n")
            
            f.write(f"Fully covered (≥99%): {len(fully_covered)}\n")
            for r in sorted(fully_covered, key=lambda x: x['symbol']):
                f.write(f"  ✓ {r['symbol']}\n")
            
            f.write(f"\nPartial coverage: {len(partial)}\n")
            for r in partial:
                f.write(f"  ⚠ {r['symbol']}: {r['coverage_pct']:.1f}% ({r['missing_days']} missing)\n")
            
            f.write(f"\nNo prices: {len(no_prices)}\n")
            for r in no_prices:
                f.write(f"  ✗ {r['symbol']}: need {r['expected_days']} days from {r['oldest_tx']}\n")

        print(f"\n\nFull report saved to {output_file}")


if __name__ == "__main__":
    main()
