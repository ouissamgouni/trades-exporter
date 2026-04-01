#!/usr/bin/env python3
"""
Fix include_fee for existing trades where fee is denominated in the inflow asset.

When a CEX deducts the fee from the received quantity (e.g. BTC buy with BTC fee),
include_fee should be False — the exchange already subtracted it. Including it as a
separate disposal double-counts the fee and creates spurious negative lots.

Rules:
  - trade + inflow: if source_fee_quote_asset_symbol == source_asset_symbol → False
  - trade + outflow: if source_fee_quote_asset_symbol == source_price_quote_asset_symbol → False

Only updates transactions with review_status in (None, 'pending') to respect manual edits.

Usage:
    # Dry-run (default):
    PYTHONPATH=.. .venv/bin/python scripts/fix_include_fee_auto_detect.py

    # Apply changes:
    PYTHONPATH=.. .venv/bin/python scripts/fix_include_fee_auto_detect.py --apply
"""
import argparse
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from sqlmodel import Session, select, col
from backend.db.database import get_engine
from backend.db.models import NormalizedTransaction


def should_disable_include_fee(tx: NormalizedTransaction) -> bool:
    """Return True if include_fee should be set to False for this trade."""
    if tx.transaction_type != "trade":
        return False
    if not tx.include_fee:
        return False

    fee_sym = (tx.source_fee_quote_asset_symbol or "").upper().strip()
    if not fee_sym:
        return False

    if tx.direction == "inflow":
        # Buy: fee in same asset as received → already deducted
        asset_sym = (tx.source_asset_symbol or "").upper().strip()
        return fee_sym == asset_sym and bool(asset_sym)
    elif tx.direction == "outflow":
        # Sell: fee in quote currency → already deducted from proceeds
        quote_sym = (tx.source_price_quote_asset_symbol or "").upper().strip()
        return fee_sym == quote_sym and bool(quote_sym)

    return False


def main():
    parser = argparse.ArgumentParser(description="Fix include_fee auto-detection for trades")
    parser.add_argument("--apply", action="store_true", help="Actually write changes (default: dry-run)")
    args = parser.parse_args()

    engine = get_engine()

    with Session(engine) as session:
        stmt = (
            select(NormalizedTransaction)
            .where(NormalizedTransaction.transaction_type == "trade")
            .where(NormalizedTransaction.include_fee == True)  # noqa: E712
            .where(
                col(NormalizedTransaction.review_status).in_([None, "pending"])
                | col(NormalizedTransaction.review_status).is_(None)
            )
        )
        transactions = session.exec(stmt).all()
        print(f"Found {len(transactions)} trades with include_fee=True and unreviewed status\n")

        stats: dict[str, int] = defaultdict(int)
        to_update: list[NormalizedTransaction] = []

        for tx in transactions:
            if should_disable_include_fee(tx):
                key = (
                    f"{tx.source} | {tx.direction}: "
                    f"fee={tx.source_fee_quote_asset_symbol} == "
                    f"{'asset=' + (tx.source_asset_symbol or '?') if tx.direction == 'inflow' else 'quote=' + (tx.source_price_quote_asset_symbol or '?')}"
                )
                stats[key] += 1
                to_update.append(tx)
            else:
                stats["no change needed"] += 1

        print("-" * 70)
        print(f"{'Category':<60} {'Count':>6}")
        print("-" * 70)
        for key in sorted(stats.keys()):
            print(f"{key:<60} {stats[key]:>6}")
        print("-" * 70)
        print(f"{'Total to update':<60} {len(to_update):>6}")
        print()

        if not to_update:
            print("Nothing to update.")
            return

        if not args.apply:
            print("Dry-run mode. Use --apply to write changes.")
            return

        for tx in to_update:
            tx.include_fee = False
            session.add(tx)

        session.commit()
        print(f"Updated {len(to_update)} transactions (include_fee -> False).")


if __name__ == "__main__":
    main()
