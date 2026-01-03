#!/usr/bin/env python
"""
Fix test database schema - adds missing columns from migrations 018/019.
Run with: TEST_MODE=1 PYTHONPATH=.. .venv/bin/python scripts/fix_test_db_schema.py
"""

from sqlalchemy import create_engine, text
from backend.db.database import get_database_url

def main():
    db_url = get_database_url()
    print(f"Connecting to: {db_url}")
    
    engine = create_engine(db_url)
    
    # All columns to add (table, column, type)
    columns_to_add = [
        # cost_lots
        ("cost_lots", "version_id", "INTEGER"),
        ("cost_lots", "origin_unit_id", "INTEGER"),
        # consumed_lot_slices
        ("consumed_lot_slices", "version_id", "INTEGER"),
        # realized_pnl
        ("realized_pnl", "origin_unit_id", "INTEGER"),
        ("realized_pnl", "version_id", "INTEGER"),
        # processed_units
        ("processed_units", "version_id", "INTEGER"),
        ("processed_units", "unit_label", "TEXT"),
    ]
    
    # Indexes to create
    indexes_to_create = [
        ("ix_cost_lots_version_id", "cost_lots", "version_id"),
        ("ix_cost_lots_origin_unit_id", "cost_lots", "origin_unit_id"),
        ("ix_consumed_lot_slices_version_id", "consumed_lot_slices", "version_id"),
        ("ix_realized_pnl_origin_unit_id", "realized_pnl", "origin_unit_id"),
        ("ix_realized_pnl_version_id", "realized_pnl", "version_id"),
        ("ix_processed_units_version_id", "processed_units", "version_id"),
    ]
    
    with engine.connect() as conn:
        # Add columns
        for table, column, col_type in columns_to_add:
            try:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {col_type}"))
                print(f"✓ Added {table}.{column}")
            except Exception as e:
                print(f"✗ {table}.{column}: {e}")
        
        # Create indexes
        for idx_name, table, column in indexes_to_create:
            try:
                conn.execute(text(f"CREATE INDEX IF NOT EXISTS {idx_name} ON {table} ({column})"))
                print(f"✓ Created index {idx_name}")
            except Exception as e:
                print(f"✗ Index {idx_name}: {e}")
        
        conn.commit()
        print("\nDone!")

if __name__ == "__main__":
    main()
