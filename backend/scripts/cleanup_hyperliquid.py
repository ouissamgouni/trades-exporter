#!/usr/bin/env python3
"""
Delete all Hyperliquid connector data so you can resync with the new connector logic.

Deletes:
- calculation_unit_legs linked to HL normalized_transactions
- normalized_transactions with source IN ('hyperliquid-perps', 'hyperliquid-funding', 'hyperliquid-transfers')
- raw_transactions linked to hyperliquid connector runs
- raw_accounts with source IN ('hyperliquid-perps', 'hyperliquid-funding', 'hyperliquid-transfers')
- raw_assets with source IN ('hyperliquid-perps', 'hyperliquid-funding', 'hyperliquid-transfers')
- sync_job_connector_runs for hyperliquid connectors
- Resets last_sync_at / last_sync_status on hyperliquid account_connectors

Does NOT delete accounts or account_connectors themselves.

Usage:
    cd backend
    PYTHONPATH=.. ../.venv/bin/python scripts/cleanup_hyperliquid.py [--force]
"""

import sys
import argparse
from pathlib import Path
from sqlalchemy import text, create_engine

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from backend.config.loader import get_database_url

HYPERLIQUID_SOURCES = (
    "hyperliquid-perps",
    "hyperliquid-funding",
    "hyperliquid-transfers",
)

HYPERLIQUID_CONNECTOR_TYPES = (
    "hyperliquid-perps",
    "hyperliquid-funding",
    "hyperliquid-transfers",
)


def cleanup_hyperliquid(engine, dry_run: bool = False) -> dict:
    """Delete all Hyperliquid data. Returns stats dict."""
    stats = {}

    with engine.begin() as conn:
        # 1. Count normalized transactions
        result = conn.execute(
            text(
                "SELECT source, COUNT(*) FROM normalized_transactions "
                "WHERE source IN :sources GROUP BY source"
            ),
            {"sources": HYPERLIQUID_SOURCES},
        )
        for row in result:
            stats[f"normalized_{row[0]}"] = row[1]

        # 2. Find hyperliquid connector IDs
        result = conn.execute(
            text(
                "SELECT id, connector_type FROM account_connectors "
                "WHERE connector_type IN :types"
            ),
            {"types": HYPERLIQUID_CONNECTOR_TYPES},
        )
        connector_ids = [(row[0], row[1]) for row in result]
        stats["connector_ids"] = connector_ids

        if dry_run:
            return stats

        # 3. Delete P&L data linked to these transactions
        # (calculation_unit_legs → calculation_units → cost_lots etc. via CASCADE)
        deleted = conn.execute(
            text(
                "DELETE FROM calculation_unit_legs WHERE transaction_id IN "
                "(SELECT id FROM normalized_transactions WHERE source IN :sources)"
            ),
            {"sources": HYPERLIQUID_SOURCES},
        ).rowcount
        stats["deleted_calculation_unit_legs"] = deleted

        # 3b. Delete derivative positions linked to HL accounts
        # (must happen before normalized_transactions due to FK on open_transaction_id)
        result = conn.execute(
            text(
                "SELECT DISTINCT account_id FROM account_connectors "
                "WHERE connector_type IN :types"
            ),
            {"types": HYPERLIQUID_CONNECTOR_TYPES},
        )
        hl_account_ids = tuple(row[0] for row in result)
        if hl_account_ids:
            deleted = conn.execute(
                text("DELETE FROM derivative_positions WHERE account_id IN :aids"),
                {"aids": hl_account_ids},
            ).rowcount
            stats["deleted_derivative_positions"] = deleted

        # 4. Delete normalized transactions
        deleted = conn.execute(
            text("DELETE FROM normalized_transactions WHERE source IN :sources"),
            {"sources": HYPERLIQUID_SOURCES},
        ).rowcount
        stats["deleted_normalized_transactions"] = deleted

        # 5. Delete raw accounts linked to hyperliquid sources
        deleted = conn.execute(
            text("DELETE FROM raw_accounts WHERE source IN :sources"),
            {"sources": HYPERLIQUID_SOURCES},
        ).rowcount
        stats["deleted_raw_accounts"] = deleted

        # 6. Delete raw assets linked to hyperliquid sources
        deleted = conn.execute(
            text("DELETE FROM raw_assets WHERE source IN :sources"),
            {"sources": HYPERLIQUID_SOURCES},
        ).rowcount
        stats["deleted_raw_assets"] = deleted

        # 7. Delete raw transactions linked to hyperliquid connectors
        if connector_ids:
            cids = tuple(c[0] for c in connector_ids)
            deleted = conn.execute(
                text("DELETE FROM raw_transactions WHERE connector_id IN :cids"),
                {"cids": cids},
            ).rowcount
            stats["deleted_raw_transactions"] = deleted

            # 8. Nullify sync_connector_run_id on any remaining normalized_transactions
            #    that reference HL connector runs (handles data inconsistencies)
            updated = conn.execute(
                text(
                    "UPDATE normalized_transactions SET sync_connector_run_id = NULL "
                    "WHERE sync_connector_run_id IN "
                    "(SELECT id FROM sync_job_connector_runs WHERE connector_id IN :cids)"
                ),
                {"cids": cids},
            ).rowcount
            if updated:
                stats["nullified_stale_fk_refs"] = updated

            # 9. Delete connector runs
            deleted = conn.execute(
                text("DELETE FROM sync_job_connector_runs WHERE connector_id IN :cids"),
                {"cids": cids},
            ).rowcount
            stats["deleted_connector_runs"] = deleted

            # 10. Reset connector sync state
            conn.execute(
                text(
                    "UPDATE account_connectors SET last_sync_at = NULL, "
                    "last_sync_status = 'pending', last_error = NULL "
                    "WHERE id IN :cids"
                ),
                {"cids": cids},
            )
            stats["reset_connectors"] = len(cids)

    return stats


def main():
    parser = argparse.ArgumentParser(description="Delete Hyperliquid data for resync")
    parser.add_argument("--force", action="store_true", help="Skip confirmation")
    parser.add_argument(
        "--dry-run", action="store_true", help="Show what would be deleted"
    )
    args = parser.parse_args()

    engine = create_engine(get_database_url())
    print(f"🗄️  Database: {engine.url}")

    if args.dry_run:
        stats = cleanup_hyperliquid(engine, dry_run=True)
        print("\n📊 Would delete:")
        for k, v in stats.items():
            print(f"   {k}: {v}")
        return

    if not args.force:
        confirm = input("⚠️  This will DELETE all Hyperliquid data. Continue? [y/N]: ")
        if confirm.lower() != "y":
            print("Aborted.")
            return

    stats = cleanup_hyperliquid(engine)
    print("\n✅ Cleanup complete:")
    for k, v in stats.items():
        print(f"   {k}: {v}")
    print("\nYou can now resync the Hyperliquid connectors.")


if __name__ == "__main__":
    main()
