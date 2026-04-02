#!/usr/bin/env python3
"""
Script to seed the database with default data.

Usage:
    python -m backend.scripts.seed
    python -m backend.scripts.seed --seed-dir path/to/scenario/

This script will seed:
- Default assets from asset_map.yaml
- Accounts from settings.yaml
- Connectors from settings.yaml

With --seed-dir, seeds from a custom directory (layered on top of defaults).
"""

import argparse
import sys
from pathlib import Path
from ..config.loader import get_database_url


def main():
    parser = argparse.ArgumentParser(description="Seed the database")
    parser.add_argument(
        "--seed-dir",
        type=str,
        default=None,
        help="Path to a directory containing YAML seed files (assets.yaml, accounts.yaml, bundles.yaml, transactions.yaml). Layered on top of default seed data.",
    )
    args = parser.parse_args()

    # Get database URL
    db_url = get_database_url()
    safe_url = db_url.split("@")[-1] if "@" in db_url else db_url

    print("=" * 55)
    print("  DATABASE SEED")
    print("=" * 55)
    print()
    print(f"📦 Database: {safe_url}")
    if args.seed_dir:
        seed_dir = Path(args.seed_dir)
        if not seed_dir.is_dir():
            print(f"❌ Seed directory not found: {seed_dir}")
            sys.exit(1)
        print(f"📂 Seed dir: {seed_dir}")
    print()

    # Seed database
    print("🌱 Seeding database...")
    from backend.db.seed import seed_database

    result = seed_database(seed_data_dir=args.seed_dir)
    prices_count = result.get('prices', 0)
    print(
        f"   Seeded {result.get('accounts', 0)} accounts, "
        f"{result.get('connectors', 0)} connectors, "
        f"{result.get('assets', 0)} assets, "
        f"{result.get('bundles', 0)} bundles, "
        f"{result.get('transactions', 0)} transactions"
        + (f", {prices_count} prices" if prices_count else "")
    )
    print()

    print("=" * 55)
    print("✅ Database seeded successfully!")
    print("=" * 55)


if __name__ == "__main__":
    main()
