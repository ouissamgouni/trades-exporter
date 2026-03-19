#!/usr/bin/env python3
"""
Inject hex colors into accounts and connectors that have NULL color.

Usage:
    PYTHONPATH=. python backend/scripts/inject_colors.py [--test] [--dry-run]

This script assigns a unique colour from a 30-colour Tableau-inspired palette
to every account and connector whose `color` column is currently NULL.
Colours are distributed round-robin, skipping colours already in use, so
existing assignments are preserved and duplicates are minimised.
"""

import sys
import argparse
from pathlib import Path

# Add project root to path
project_root = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(project_root))

from sqlmodel import Session, select
from backend.db.database import get_engine
from backend.db.models import Account, AccountConnector

# ---------------------------------------------------------------------------
# Entity colour palette – same as ENTITY_COLOR_PALETTE on the frontend
# ---------------------------------------------------------------------------

ENTITY_COLOR_PALETTE = [
    # Blues
    "#2B5C8A", "#1A4971", "#1F6F9F", "#1B4F72",
    # Teals & Cyans
    "#1E7A6D", "#1A6B60", "#1B7D72", "#217A6E",
    # Greens
    "#2E7D32", "#3A7D44", "#3B7A3E", "#2D6A30",
    # Yellows & Ochres
    "#A68B00", "#8B7A00", "#7D6608", "#9A7B00",
    # Oranges
    "#C56A00", "#B55A00", "#D46B08", "#A85A00",
    # Reds & Pinks
    "#C0392B", "#A93226", "#922B21", "#B03A2E",
    # Purples & Violets
    "#76448A", "#6C3483", "#5B2C6F", "#7D3C98",
    # Neutrals
    "#4A4543", "#4A5568",
]


def get_next_available_color(used: set[str], palette: list[str]) -> str:
    """Return the first palette colour not in *used*. Cycles if all used."""
    normalised = {c.lower() for c in used}
    for color in palette:
        if color.lower() not in normalised:
            return color
    # All colours exhausted → restart from beginning
    return palette[len(used) % len(palette)]


def main():
    parser = argparse.ArgumentParser(description="Inject colors into accounts & connectors")
    parser.add_argument("--test", action="store_true", help="Use test database")
    parser.add_argument("--dry-run", action="store_true", help="Show changes without committing")
    args = parser.parse_args()

    if args.test:
        import os
        os.environ["TEST_MODE"] = "1"

    engine = get_engine()

    with Session(engine) as session:
        # ---------------------------------------------------------------
        # 1. Accounts
        # ---------------------------------------------------------------
        accounts = session.exec(select(Account).order_by(Account.id)).all()
        used_account_colors: set[str] = set()

        # Collect already-assigned colours first
        for acct in accounts:
            if acct.color:
                used_account_colors.add(acct.color)

        account_updates = 0
        for acct in accounts:
            if not acct.color:
                color = get_next_available_color(used_account_colors, ENTITY_COLOR_PALETTE)
                acct.color = color
                used_account_colors.add(color)
                account_updates += 1
                print(f"  Account #{acct.id:>3} {acct.name:<25} → {color}")

        # ---------------------------------------------------------------
        # 2. Connectors
        # ---------------------------------------------------------------
        connectors = session.exec(select(AccountConnector).order_by(AccountConnector.id)).all()
        used_connector_colors: set[str] = set()

        # Collect already-assigned colours first
        for conn in connectors:
            if conn.color:
                used_connector_colors.add(conn.color)

        connector_updates = 0
        for conn in connectors:
            if not conn.color:
                color = get_next_available_color(used_connector_colors, ENTITY_COLOR_PALETTE)
                conn.color = color
                used_connector_colors.add(color)
                connector_updates += 1
                print(f"  Connector #{conn.id:>3} {conn.connector_type:<25} (acct {conn.account_id}) → {color}")

        # ---------------------------------------------------------------
        # Summary
        # ---------------------------------------------------------------
        print(f"\n{'[DRY RUN] ' if args.dry_run else ''}Updated {account_updates} account(s), {connector_updates} connector(s)")

        if args.dry_run:
            session.rollback()
            print("No changes committed (dry run).")
        else:
            session.commit()
            print("Changes committed successfully.")


if __name__ == "__main__":
    main()
