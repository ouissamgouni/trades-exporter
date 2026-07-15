#!/usr/bin/env python3
"""
Repair Polymarket fallback artifact asset links without re-running the connector.

Some legacy normalized close/redeem rows can point at fallback PM assets like
PM:...-0X9C1CEC instead of the canonical PM:{slug}-{outcome} asset. This script
relinks those rows by condition_id and updates matching raw_assets mappings.

Dry-run is the default. Use --apply to write changes.

Usage:
    cd backend
    PYTHONPATH=.. ../.venv/bin/python scripts/cleanup_polymarket_artifacts.py
    PYTHONPATH=.. ../.venv/bin/python scripts/cleanup_polymarket_artifacts.py --apply
"""

import argparse
import sys
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError

backend_dir = Path(__file__).parent.parent
repo_root = backend_dir.parent
sys.path.insert(0, str(repo_root))

from backend.config.loader import get_database_url


MATCH_SQL = """
WITH pm_rows AS (
    SELECT
        nt.id,
        nt.asset_id,
        a.symbol,
        nt.source_asset_symbol,
        nt.source_transaction_type,
        nt.tags,
        nt.tags->0->>'condition_id' AS condition_id,
        nt.tags->0->>'outcome' AS outcome
    FROM normalized_transactions nt
    JOIN assets a ON a.asset_id = nt.asset_id
    WHERE a.symbol LIKE 'PM:%'
),
canonical AS (
    SELECT DISTINCT ON (condition_id)
        condition_id,
        asset_id AS canonical_asset_id,
        symbol AS canonical_asset_symbol,
        source_asset_symbol AS canonical_source_symbol,
        outcome AS canonical_outcome
    FROM pm_rows
    WHERE condition_id IS NOT NULL
      AND outcome IS NOT NULL
      AND outcome <> ''
      AND source_transaction_type IN ('buy', 'sell', 'synthetic-close')
      AND symbol !~ '-0X[0-9A-F]{6,}$'
    ORDER BY condition_id, id
),
fallback_close AS (
    SELECT
        p.id,
        p.asset_id AS fallback_asset_id,
        p.symbol AS fallback_asset_symbol,
        p.source_asset_symbol AS fallback_source_symbol,
        p.condition_id,
        p.source_transaction_type,
        c.canonical_asset_id,
        c.canonical_asset_symbol,
        c.canonical_source_symbol,
        c.canonical_outcome
    FROM pm_rows p
    JOIN canonical c USING (condition_id)
    WHERE p.source_transaction_type IN ('redeem', 'synthetic-close')
      AND p.asset_id <> c.canonical_asset_id
      AND p.symbol ~ '-0X[0-9A-F]{6,}$'
)
SELECT * FROM fallback_close
ORDER BY condition_id, id
"""


def find_matches(conn) -> list[dict]:
    return [dict(row._mapping) for row in conn.execute(text(MATCH_SQL)).all()]


def apply_cleanup(conn) -> dict:
    matches = find_matches(conn)
    if not matches:
        return {
            "matched_transactions": 0,
            "updated_transactions": 0,
            "updated_raw_assets": 0,
        }

    update_transactions_sql = f"""
    WITH matches AS ({MATCH_SQL})
    UPDATE normalized_transactions nt
    SET
        asset_id = matches.canonical_asset_id,
        source_asset_symbol = matches.canonical_source_symbol,
        tags = jsonb_set(
            COALESCE(nt.tags, '[]'::jsonb),
            '{{0,outcome}}',
            to_jsonb(matches.canonical_outcome),
            true
        )
    FROM matches
    WHERE nt.id = matches.id
    """
    updated_transactions = conn.execute(text(update_transactions_sql)).rowcount

    update_raw_assets_sql = f"""
    WITH matches AS ({MATCH_SQL})
    UPDATE raw_assets ra
    SET asset_id = matches.canonical_asset_id
    FROM matches
    WHERE ra.source = 'polymarket'
      AND ra.symbol = matches.fallback_source_symbol
      AND ra.asset_id = matches.fallback_asset_id
    """
    updated_raw_assets = conn.execute(text(update_raw_assets_sql)).rowcount

    return {
        "matched_transactions": len(matches),
        "updated_transactions": updated_transactions,
        "updated_raw_assets": updated_raw_assets,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Repair Polymarket fallback artifact asset links"
    )
    parser.add_argument(
        "--apply", action="store_true", help="Apply updates. Default is dry-run only."
    )
    args = parser.parse_args()

    engine = create_engine(get_database_url())
    print(f"Database: {engine.url}")

    try:
        with engine.begin() as conn:
            matches = find_matches(conn)
            print(f"Matched artifact transaction rows: {len(matches)}")
            for row in matches:
                print(
                    "  tx={id} condition={condition_id} {fallback_asset_symbol} -> {canonical_asset_symbol}".format(
                        **row
                    )
                )

            if not args.apply:
                print("Dry run only. Re-run with --apply to write changes.")
                return

            stats = apply_cleanup(conn)
            print("Applied cleanup:")
            for key, value in stats.items():
                print(f"  {key}: {value}")
            print(
                "Recalculate PnL after this cleanup so derived lots, realized PnL, and warnings are rebuilt."
            )
    except OperationalError as exc:
        print(f"Could not connect to database: {exc.orig}")
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
