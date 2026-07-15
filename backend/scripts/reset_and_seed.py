#!/usr/bin/env python3
"""
Script to reset and seed the database.

Usage:
    python scripts/reset_and_seed.py [--test] [--force] [--scenario NAME]

This script will:
1. Empty all tables (TRUNCATE CASCADE)
2. Seed default data (assets, accounts, connectors from config)

Options:
    --test      Use test database (default: production)
    --force     Skip confirmation prompt
    --scenario  Load a specific scenario from seed_data/scenarios/<NAME>/
"""

import sys
import argparse
from pathlib import Path
from sqlalchemy import text, create_engine
from backend.config.loader import get_database_url

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))


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
    parser = argparse.ArgumentParser(description="Reset and seed the database.")
    parser.add_argument(
        "--force",
        "-f",
        action="store_true",
        help="Skip confirmation prompt",
    )
    parser.add_argument(
        "--test",
        "-t",
        action="store_true",
        help="Use test database",
    )
    parser.add_argument(
        "--scenario",
        "-s",
        type=str,
        default=None,
        help="Scenario name from seed_data/scenarios/ (e.g. polymarket_pnl, derivative_pnl)",
    )
    args = parser.parse_args()

    # Resolve scenario directory
    seed_data_dir = None
    if args.scenario:
        from backend.db.seed import SEED_DATA_DIR
        seed_data_dir = SEED_DATA_DIR / "scenarios" / args.scenario
        if not seed_data_dir.exists():
            print(f"❌ Scenario not found: {seed_data_dir}")
            sys.exit(1)

    # Get database URL
    db_url = get_database_url()
    safe_url = db_url.split("@")[-1] if "@" in db_url else db_url
    mode_label = f"scenario: {args.scenario}" if args.scenario else "default"

    print("=" * 55)
    print(f"  DATABASE RESET & SEED ({mode_label})")
    print("=" * 55)
    print()
    print(f"📦 Database: {safe_url}")
    print()

    # Safety check for production
    if not args.test and "test" not in db_url.lower():
        print("⚠️  WARNING: You are about to reset the PRODUCTION database!")
        print()

    # Confirm before proceeding
    if not args.force:
        confirm = input("⚠️  This will DELETE ALL DATA. Continue? [y/N]: ")
        if confirm.strip().lower() != "y":
            print("Aborted.")
            sys.exit(0)
        print()

    # Step 1: Empty database
    print("🗑️  Step 1: Emptying database...")
    engine = create_engine(db_url)
    truncated = empty_database(engine)
    print(f"   Truncated {truncated} tables")
    print()

    # Step 2: Seed database
    print("🌱 Step 2: Seeding database...")
    from backend.db.seed import seed_database

    result = seed_database(seed_data_dir=seed_data_dir)
    print(
        f"   Seeded {result.get('accounts', 0)} accounts, "
        f"{result.get('connectors', 0)} connectors, "
        f"{result.get('assets', 0)} assets, "
        f"{result.get('transactions', 0)} transactions"
    )
    print()

    print("=" * 55)
    print("✅ Database reset and seeded successfully!")
    print("=" * 55)


if __name__ == "__main__":
    main()
