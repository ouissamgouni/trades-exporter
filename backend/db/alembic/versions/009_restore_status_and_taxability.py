"""restore status and taxability columns

Revision ID: 009_restore_status_and_taxability
Revises: 008_restore_bundles
Create Date: 2025-01-24

This migration restores the status and taxability columns that were
supposed to be added by migration 003 but are missing from the database.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text


# revision identifiers, used by Alembic.
revision: str = "009_restore_status_and_taxability"
down_revision: Union[str, None] = "008_restore_bundles"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add status and taxability columns if they don't exist."""
    connection = op.get_bind()
    
    # Check if status column exists
    result = connection.execute(text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'normalized_transactions' AND column_name = 'status'
    """))
    if not result.fetchone():
        print("Adding status column to normalized_transactions...")
        op.add_column(
            "normalized_transactions",
            sa.Column(
                "status", sa.String(length=20), nullable=False, server_default="pending"
            ),
        )
        op.create_index(
            "idx_normalized_tx_status",
            "normalized_transactions",
            ["status"],
        )
        print("  - Added status column with default 'pending'")
    else:
        print("  - status column already exists (skipped)")
    
    # Check if taxability column exists
    result = connection.execute(text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'normalized_transactions' AND column_name = 'taxability'
    """))
    if not result.fetchone():
        print("Adding taxability column to normalized_transactions...")
        op.add_column(
            "normalized_transactions",
            sa.Column(
                "taxability", sa.String(length=20), nullable=False, server_default="unknown"
            ),
        )
        op.create_index(
            "idx_normalized_tx_taxability",
            "normalized_transactions",
            ["taxability"],
        )
        print("  - Added taxability column with default 'unknown'")
    else:
        print("  - taxability column already exists (skipped)")
    
    print("\n✅ Migration complete!")


def downgrade() -> None:
    """Remove status and taxability columns."""
    # Remove taxability column
    op.drop_index("idx_normalized_tx_taxability", table_name="normalized_transactions")
    op.drop_column("normalized_transactions", "taxability")
    
    # Remove status column  
    op.drop_index("idx_normalized_tx_status", table_name="normalized_transactions")
    op.drop_column("normalized_transactions", "status")
