"""Rename bundle_id to calculation_unit_id

Revision ID: 015_rename_bundle_id_to_calculation_unit_id
Revises: 014_add_calculation_unit_suggestion_fields
Create Date: 2025-01-15

Renames bundle_id column to calculation_unit_id in normalized_transactions
to align with the unified CalculationUnit terminology.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision = "015_rename_bundle_id_to_calculation_unit_id"
down_revision = "014_add_calculation_unit_suggestion_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    
    print("Renaming bundle_id to calculation_unit_id in normalized_transactions...")
    
    # Check if bundle_id column exists
    result = connection.execute(text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'normalized_transactions' AND column_name = 'bundle_id'
    """))
    
    if result.fetchone():
        # Rename the column
        connection.execute(text("""
            ALTER TABLE normalized_transactions 
            RENAME COLUMN bundle_id TO calculation_unit_id
        """))
        print("  - Renamed bundle_id to calculation_unit_id")
        
        # Rename the index if it exists
        result = connection.execute(text("""
            SELECT indexname FROM pg_indexes 
            WHERE tablename = 'normalized_transactions' 
            AND indexname = 'ix_normalized_transactions_bundle_id'
        """))
        if result.fetchone():
            connection.execute(text("""
                ALTER INDEX ix_normalized_transactions_bundle_id 
                RENAME TO ix_normalized_transactions_calculation_unit_id
            """))
            print("  - Renamed index to ix_normalized_transactions_calculation_unit_id")
    else:
        # Check if calculation_unit_id already exists
        result = connection.execute(text("""
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'normalized_transactions' AND column_name = 'calculation_unit_id'
        """))
        if result.fetchone():
            print("  - calculation_unit_id column already exists")
        else:
            # Neither exists, create the column
            connection.execute(text("""
                ALTER TABLE normalized_transactions 
                ADD COLUMN calculation_unit_id INTEGER REFERENCES bundles(id)
            """))
            connection.execute(text("""
                CREATE INDEX IF NOT EXISTS ix_normalized_transactions_calculation_unit_id 
                ON normalized_transactions(calculation_unit_id)
            """))
            print("  - Created calculation_unit_id column")
    
    print("Column rename complete!")


def downgrade() -> None:
    connection = op.get_bind()
    
    print("Reverting calculation_unit_id back to bundle_id...")
    
    # Check if calculation_unit_id column exists
    result = connection.execute(text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'normalized_transactions' AND column_name = 'calculation_unit_id'
    """))
    
    if result.fetchone():
        # Rename the column back
        connection.execute(text("""
            ALTER TABLE normalized_transactions 
            RENAME COLUMN calculation_unit_id TO bundle_id
        """))
        print("  - Renamed calculation_unit_id back to bundle_id")
        
        # Rename the index back
        result = connection.execute(text("""
            SELECT indexname FROM pg_indexes 
            WHERE tablename = 'normalized_transactions' 
            AND indexname = 'ix_normalized_transactions_calculation_unit_id'
        """))
        if result.fetchone():
            connection.execute(text("""
                ALTER INDEX ix_normalized_transactions_calculation_unit_id 
                RENAME TO ix_normalized_transactions_bundle_id
            """))
            print("  - Renamed index back to ix_normalized_transactions_bundle_id")
    
    print("Column revert complete!")
