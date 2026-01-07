"""rename taxability to taxability_status

Revision ID: 028_rename_taxability_to_taxability_status
Revises: 027_normalize_dimensions
Create Date: 2026-01-05

Fixes column naming: the app uses taxability_status but migration 009 created 'taxability'.
This migration renames or adds the correct column name.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text


# revision identifiers, used by Alembic.
revision: str = "028_rename_taxability_to_taxability_status"
down_revision: Union[str, None] = "027_normalize_dimensions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Rename taxability to taxability_status or add it if missing."""
    connection = op.get_bind()
    
    # Check if taxability column exists
    result_taxability = connection.execute(text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'normalized_transactions' AND column_name = 'taxability'
    """))
    has_taxability = result_taxability.fetchone() is not None
    
    # Check if taxability_status column exists
    result_taxability_status = connection.execute(text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'normalized_transactions' AND column_name = 'taxability_status'
    """))
    has_taxability_status = result_taxability_status.fetchone() is not None
    
    if has_taxability and not has_taxability_status:
        # Rename taxability -> taxability_status
        print("Renaming taxability -> taxability_status...")
        op.alter_column(
            "normalized_transactions",
            "taxability",
            new_column_name="taxability_status"
        )
        # Update index name
        try:
            op.drop_index("idx_normalized_tx_taxability", table_name="normalized_transactions")
        except Exception:
            pass  # Index might not exist
        op.create_index(
            "ix_normalized_transactions_taxability_status",
            "normalized_transactions",
            ["taxability_status"],
        )
        print("  - Done renaming")
    elif has_taxability and has_taxability_status:
        # Both exist - drop taxability, keep taxability_status
        print("Both taxability and taxability_status exist - dropping taxability...")
        try:
            op.drop_index("idx_normalized_tx_taxability", table_name="normalized_transactions")
        except Exception:
            pass
        op.drop_column("normalized_transactions", "taxability")
        print("  - Dropped taxability column")
    elif not has_taxability_status:
        # Neither exists - add taxability_status
        print("Adding taxability_status column...")
        op.add_column(
            "normalized_transactions",
            sa.Column(
                "taxability_status", sa.String(length=20), nullable=False, server_default="unknown"
            ),
        )
        op.create_index(
            "ix_normalized_transactions_taxability_status",
            "normalized_transactions",
            ["taxability_status"],
        )
        print("  - Added taxability_status column")
    else:
        print("  - taxability_status already exists (skipped)")
    
    print("\n✅ Migration complete!")


def downgrade() -> None:
    """Rename taxability_status back to taxability."""
    connection = op.get_bind()
    
    result = connection.execute(text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'normalized_transactions' AND column_name = 'taxability_status'
    """))
    
    if result.fetchone():
        op.alter_column(
            "normalized_transactions",
            "taxability_status",
            new_column_name="taxability"
        )
        try:
            op.drop_index("ix_normalized_transactions_taxability_status", table_name="normalized_transactions")
        except Exception:
            pass
        op.create_index(
            "idx_normalized_tx_taxability",
            "normalized_transactions",
            ["taxability"],
        )
