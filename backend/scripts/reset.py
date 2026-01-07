#!/usr/bin/env python3
"""
Script to reset (truncate) all database tables.

Usage:
    python scripts/reset.py [--force]

This script will empty all tables using TRUNCATE CASCADE.

Options:
    --force  Skip confirmation prompt
"""

import sys
import argparse
from sqlalchemy import text, create_engine
from backend.config.loader import get_database_url


# Tables to truncate in order (respecting foreign key constraints)
# Order: dependent tables first, then parent tables
TABLES_TO_TRUNCATE = [
    # P&L tables
    "consumed_lot_slices",
    "realized_pnl",
    "unrealized_pnl",
    "cost_lots",
    "calculation_versions",
    # Transaction tables
    "normalized_transactions",
    "raw_transactions",
    # Reference tables
    "price_snapshots",
    "raw_assets",
    "raw_accounts",
    "groups",
    # Account/connector tables
    "account_connectors",
    "accounts",
    # Asset table (last)
    "assets",
]


def empty_database(engine) -> int:
    """
    Empty all tables in the database.

    Returns:
        Number of tables truncated
    """
    truncated = 0

    with engine.connect() as conn:
        # Disable foreign key checks temporarily
        conn.execute(text("SET session_replication_role = 'replica';"))

        for table in TABLES_TO_TRUNCATE:
            try:
                # Check if table exists
                result = conn.execute(
                    text(
                        f"SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = '{table}')"
                    )
                )
                exists = result.scalar()

                if exists:
                    conn.execute(text(f"TRUNCATE TABLE {table} CASCADE;"))
                    truncated += 1
                    print(f"   ✅ Truncated: {table}")
            except Exception as e:
                print(f"   ❌ Error truncating {table}: {e}")

        # Re-enable foreign key checks
        conn.execute(text("SET session_replication_role = 'origin';"))
        conn.commit()

    return truncated


def main():
    parser = argparse.ArgumentParser(description="Reset (truncate) all database tables.")
    parser.add_argument(
        "--force",
        "-f",
        action="store_true",
        help="Skip confirmation prompt",
    )
    args = parser.parse_args()

    # Get database URL
    db_url = get_database_url()
    safe_url = db_url.split("@")[-1] if "@" in db_url else db_url

    print("=" * 55)
    print("  DATABASE RESET")
    print("=" * 55)
    print()
    print(f"📦 Database: {safe_url}")
    print()

    # Confirm before proceeding
    if not args.force:
        confirm = input("⚠️  This will DELETE ALL DATA. Continue? [y/N]: ")
        if confirm.strip().lower() != "y":
            print("Aborted.")
            sys.exit(0)
        print()

    # Empty database
    print("🗑️  Emptying database...")
    engine = create_engine(db_url)
    truncated = empty_database(engine)
    print(f"   Truncated {truncated} tables")
    print()

    print("=" * 55)
    print("✅ Database reset successfully!")
    print("=" * 55)


if __name__ == "__main__":
    main()
