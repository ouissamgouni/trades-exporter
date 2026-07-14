#!/usr/bin/env python3
"""
Script to seed the database with default data.

Usage:
    python -m backend.scripts.seed
    python -m backend.scripts.seed --scenario fr_tax
    python -m backend.scripts.seed --seed-dir path/to/scenario/

This script will seed:
- Default assets from asset_map.yaml
- Accounts from settings.yaml
- Connectors from settings.yaml

With --scenario <name>, resolves to scenarios/<name>/ at the repo root.
With --seed-dir, seeds from a custom directory (layered on top of defaults).
"""

import argparse
import sys
from pathlib import Path
from ..config.loader import get_database_url

REPO_ROOT = Path(__file__).resolve().parents[2]
SCENARIOS_DIR = REPO_ROOT / "scenarios"


def main():
    parser = argparse.ArgumentParser(description="Seed the database")
    parser.add_argument(
        "--scenario",
        type=str,
        default=None,
        help="Scenario name (folder under scenarios/). Mutually exclusive with --seed-dir.",
    )
    parser.add_argument(
        "--seed-dir",
        type=str,
        default=None,
        help="Path to a directory containing YAML seed files (assets.yaml, accounts.yaml, bundles.yaml, transactions.yaml). Layered on top of default seed data.",
    )
    args = parser.parse_args()

    if args.scenario and args.seed_dir:
        print("❌ --scenario and --seed-dir are mutually exclusive")
        sys.exit(1)

    seed_dir_arg = args.seed_dir
    if args.scenario:
        candidate = SCENARIOS_DIR / args.scenario
        if not candidate.is_dir():
            print(f"❌ Scenario directory not found: {candidate}")
            sys.exit(1)
        # 'default' is the implicit baseline; only pass through when the
        # scenario adds extra fixtures.
        if args.scenario != "default":
            seed_dir_arg = str(candidate)

    # Get database URL
    db_url = get_database_url()
    safe_url = db_url.split("@")[-1] if "@" in db_url else db_url

    print("=" * 55)
    print("  DATABASE SEED")
    print("=" * 55)
    print()
    print(f"📦 Database: {safe_url}")
    if args.scenario:
        print(f"🎬 Scenario: {args.scenario}")
    if seed_dir_arg:
        seed_dir = Path(seed_dir_arg)
        if not seed_dir.is_dir():
            print(f"❌ Seed directory not found: {seed_dir}")
            sys.exit(1)
        print(f"📂 Seed dir: {seed_dir}")
    print()

    # Seed database
    print("🌱 Seeding database...")
    from backend.db.seed import seed_database

    result = seed_database(seed_data_dir=seed_dir_arg)
    prices_count = result.get("prices", 0)
    positions_count = result.get("positions", 0)
    print(
        f"   Seeded {result.get('accounts', 0)} accounts, "
        f"{result.get('connectors', 0)} connectors, "
        f"{result.get('assets', 0)} assets, "
        f"{result.get('bundles', 0)} bundles, "
        f"{result.get('transactions', 0)} transactions"
        + (f", {prices_count} prices" if prices_count else "")
        + (f", {positions_count} positions" if positions_count else "")
    )
    print()

    print("=" * 55)
    print("✅ Database seeded successfully!")
    print("=" * 55)


if __name__ == "__main__":
    main()
