"""Restore bundles table and bundle_id column

Revision ID: 008_restore_bundles
Revises: 007_cleanup_legs_and_drop_groups
Create Date: 2025-12-24

Migration 007 incorrectly removed bundles. This migration restores them.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision = "008_restore_bundles"
down_revision = "007_cleanup_legs_and_drop_groups"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    
    print("Restoring bundles infrastructure...")
    
    # 1. Create bundles table if it doesn't exist
    result = connection.execute(text("""
        SELECT table_name FROM information_schema.tables 
        WHERE table_name = 'bundles' AND table_schema = 'public'
    """))
    if not result.fetchone():
        connection.execute(text("""
            CREATE TABLE bundles (
                id SERIAL PRIMARY KEY,
                label VARCHAR(255),
                pattern VARCHAR(50),
                notes TEXT,
                taxability_override VARCHAR(50),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        """))
        print("  - Created bundles table")
    else:
        print("  - bundles table already exists")
    
    # 2. Add bundle_id column to normalized_transactions if it doesn't exist
    result = connection.execute(text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'normalized_transactions' AND column_name = 'bundle_id'
    """))
    if not result.fetchone():
        connection.execute(text("""
            ALTER TABLE normalized_transactions 
            ADD COLUMN bundle_id INTEGER REFERENCES bundles(id)
        """))
        connection.execute(text("""
            CREATE INDEX IF NOT EXISTS ix_normalized_transactions_bundle_id 
            ON normalized_transactions(bundle_id)
        """))
        print("  - Added bundle_id column to normalized_transactions")
    else:
        print("  - bundle_id column already exists")
    
    print("Bundles infrastructure restored!")


def downgrade() -> None:
    connection = op.get_bind()
    
    # Remove bundle_id from normalized_transactions
    result = connection.execute(text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'normalized_transactions' AND column_name = 'bundle_id'
    """))
    if result.fetchone():
        connection.execute(text("ALTER TABLE normalized_transactions DROP COLUMN bundle_id"))
    
    # Drop bundles table
    connection.execute(text("DROP TABLE IF EXISTS bundles CASCADE"))
