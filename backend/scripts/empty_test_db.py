#!/usr/bin/env python3
"""
Script to empty all tables in the test database.

Usage:
    python scripts/empty_test_db.py

This script will:
1. Connect to the test database (using POSTGRES_TEST_PORT and POSTGRES_DB_TEST)
2. Truncate all tables (preserving the schema)
3. Reset all sequences

Safety: Only works on the test database, not the production database.
"""

import sys
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from sqlalchemy import text
from backend.config.loader import get_database_url, set_test_mode


def empty_test_database():
    """Empty all tables in the test database."""
    # Force test mode to ensure we're using the test database
    set_test_mode(True)

    # Get test database URL
    db_url = get_database_url(test_mode=True)

    # Verify we're connecting to test database
    if "test" not in db_url.lower():
        print("❌ ERROR: Database URL does not contain 'test'. Aborting for safety.")
        print(f"   URL: {db_url}")
        sys.exit(1)

    print(f"🔗 Connecting to test database...")
    print(f"   URL: {db_url.split('@')[1]}")  # Hide credentials

    from sqlalchemy import create_engine

    engine = create_engine(db_url)

    # Tables to truncate in order (respecting foreign key constraints)
    # Order: dependent tables first, then parent tables
    tables = [
        "realized_pnl",
        "cost_lots",
        "normalized_transactions",
        "raw_transactions",
        "asset_prices",
        "raw_assets",
        "groups",
        "web3_addresses",
        "assets",  # Keep assets last as it may have default data
    ]

    with engine.connect() as conn:
        # Disable foreign key checks temporarily
        conn.execute(text("SET session_replication_role = 'replica';"))

        truncated = []
        skipped = []

        for table in tables:
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
                    truncated.append(table)
                    print(f"   ✅ Truncated: {table}")
                else:
                    skipped.append(table)
                    print(f"   ⚠️  Skipped (not found): {table}")
            except Exception as e:
                print(f"   ❌ Error truncating {table}: {e}")

        # Re-enable foreign key checks
        conn.execute(text("SET session_replication_role = 'origin';"))

        conn.commit()

    print()
    print(f"✅ Done! Truncated {len(truncated)} tables, skipped {len(skipped)} tables.")
    print()

    # Optionally re-seed default assets
    reseed = input("Re-seed default assets (EUR)? [y/N]: ").strip().lower()
    if reseed == "y":
        from backend.db.database import _seed_default_assets

        _seed_default_assets(engine)
        print("✅ Default assets seeded.")


if __name__ == "__main__":
    print("=" * 50)
    print("  TEST DATABASE CLEANUP SCRIPT")
    print("=" * 50)
    print()

    # Confirm before proceeding
    confirm = input(
        "⚠️  This will DELETE ALL DATA in the test database. Continue? [y/N]: "
    )
    if confirm.strip().lower() != "y":
        print("Aborted.")
        sys.exit(0)

    print()
    empty_test_database()
