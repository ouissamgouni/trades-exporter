#!/usr/bin/env python3
"""
Backfill include_fee on existing normalized_transactions.

Rules (matching connector defaults):
  - trade     → include_fee = True  (if fee > 0 and fee_quote_asset_id set)
  - margin    → include_fee = True  (if fee > 0 and fee_quote_asset_id set)
  - transfer  → outflow: True, inflow: False  (if fee > 0 and fee_quote_asset_id set)
  - cost      → unchanged (already handled by onchain connectors)

Only touches CEX / file / hub sources. On-chain connectors already set
include_fee correctly during sync.

Usage:
    # Dry-run (default):
    PYTHONPATH=.. .venv/bin/python scripts/backfill_include_fee.py

    # Apply changes:
    PYTHONPATH=.. .venv/bin/python scripts/backfill_include_fee.py --apply
"""
import argparse
import sys
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from sqlmodel import Session, select, col
from backend.db.database import get_engine
from backend.db.models import NormalizedTransaction


# Sources set by on-chain connectors — these already manage include_fee correctly.
ONCHAIN_SOURCES = {
    # Etherscan / Blockscout (underscored names as stored in DB)
    "blockscout_base_normal_tx",
    "blockscout_ethereum_normal_tx",
    "blockscout_hyperevm_normal_tx",
    "blockscout_token_transfers_base",
    "blockscout_token_transfers_ethereum",
    # Bitcoin / Cardano / alt-L1
    "bitcoin_esplora",
    "cardano_scan",
    "bittensor",
    "xrp_ledger",
    # EVM via Moralis
    "moralis_wallet_history_arbitrum",
    "moralis_wallet_history_bsc",
    # NEAR / Solana / SUI
    "near_txns",
    "near_ft_transfers",
    "solana_helius",
    "sui",
    # Polymarket
    "polymarket",
    "polymarket_polygon",
}


def compute_include_fee(tx: NormalizedTransaction) -> bool | None:
    """Return the new include_fee value, or None if no change needed."""
    has_real_fee = (
        tx.fee is not None
        and tx.fee > 0
        and tx.fee_quote_asset_id is not None
    )

    if tx.transaction_type in ("trade", "margin"):
        return True if has_real_fee else False

    if tx.transaction_type == "transfer":
        if tx.direction == "outflow":
            return True if has_real_fee else False
        else:
            # inflow / neutral — deposit fees already deducted before receipt
            return False

    # cost, unknown, etc. — leave unchanged
    return None


def main():
    parser = argparse.ArgumentParser(description="Backfill include_fee on normalized_transactions")
    parser.add_argument("--apply", action="store_true", help="Actually write changes (default: dry-run)")
    args = parser.parse_args()

    engine = get_engine()

    with Session(engine) as session:
        # Fetch all non-onchain transactions
        stmt = (
            select(NormalizedTransaction)
            .where(col(NormalizedTransaction.source).notin_(ONCHAIN_SOURCES))
        )
        transactions = session.exec(stmt).all()
        print(f"Found {len(transactions)} non-onchain transactions to evaluate\n")

        # Track changes per (source, transaction_type, direction, old→new)
        stats: dict[str, int] = defaultdict(int)
        to_update: list[tuple[NormalizedTransaction, bool]] = []

        for tx in transactions:
            new_value = compute_include_fee(tx)
            if new_value is None:
                stats["skipped (cost/unknown type)"] += 1
                continue
            if tx.include_fee == new_value:
                stats["already correct"] += 1
                continue

            key = f"{tx.source} | {tx.transaction_type}/{tx.direction}: {tx.include_fee}→{new_value}"
            stats[key] += 1
            to_update.append((tx, new_value))

        # Print summary
        print("─" * 70)
        print(f"{'Category':<60} {'Count':>6}")
        print("─" * 70)
        for key in sorted(stats.keys()):
            print(f"{key:<60} {stats[key]:>6}")
        print("─" * 70)
        print(f"{'Total to update':<60} {len(to_update):>6}")
        print()

        if not to_update:
            print("Nothing to update.")
            return

        if not args.apply:
            print("🔍 Dry-run mode. Use --apply to write changes.")
            return

        # Apply
        for tx, new_value in to_update:
            tx.include_fee = new_value
            session.add(tx)

        session.commit()
        print(f"✅ Updated {len(to_update)} transactions.")


if __name__ == "__main__":
    main()
