#!/usr/bin/env python3
"""
Script to seed the database with default data.

Usage:
    python scripts/seed.py

This script will seed:
- Default assets from asset_map.yaml
- Accounts from settings.yaml
- Connectors from settings.yaml
"""

import sys
from backend.config.loader import get_database_url


def main():
    # Get database URL
    db_url = get_database_url()
    safe_url = db_url.split("@")[-1] if "@" in db_url else db_url

    print("=" * 55)
    print("  DATABASE SEED")
    print("=" * 55)
    print()
    print(f"📦 Database: {safe_url}")
    print()

    # Seed database
    print("🌱 Seeding database...")
    from backend.db.seed import seed_database

    result = seed_database()
    print(
        f"   Seeded {result.get('accounts', 0)} accounts, "
        f"{result.get('connectors', 0)} connectors, "
        f"{result.get('assets', 0)} assets"
    )
    print()

    print("=" * 55)
    print("✅ Database seeded successfully!")
    print("=" * 55)


if __name__ == "__main__":
    main()
