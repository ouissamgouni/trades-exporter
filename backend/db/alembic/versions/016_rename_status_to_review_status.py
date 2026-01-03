"""rename status to review_status

Revision ID: 016_rename_status_to_review_status
Revises: 015_rename_bundle_id_to_calculation_unit_id
Create Date: 2025-12-25

Reverts to using review_status instead of status for normalized_transactions.
The frontend consistently uses review_status, so we align the DB with it.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text


# revision identifiers, used by Alembic.
revision: str = "016_rename_status_to_review_status"
down_revision: Union[str, None] = "015_rename_bundle_id_to_calculation_unit_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Rename status column to review_status."""
    connection = op.get_bind()
    
    # Check if status column exists (the one we want to rename)
    result = connection.execute(text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'normalized_transactions' AND column_name = 'status'
    """))
    
    if result.fetchone():
        # Check if review_status already exists
        result2 = connection.execute(text("""
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'normalized_transactions' AND column_name = 'review_status'
        """))
        
        if result2.fetchone():
            # Both exist - drop status, keep review_status
            print("Both status and review_status exist - dropping status column...")
            op.drop_index("idx_normalized_tx_status", table_name="normalized_transactions", if_exists=True)
            op.drop_column("normalized_transactions", "status")
        else:
            # Only status exists - rename it
            print("Renaming status -> review_status...")
            op.alter_column(
                "normalized_transactions",
                "status",
                new_column_name="review_status"
            )
            # Update index name
            op.drop_index("idx_normalized_tx_status", table_name="normalized_transactions", if_exists=True)
            op.create_index(
                "idx_normalized_tx_review_status",
                "normalized_transactions",
                ["review_status"],
            )
        
        # Map values: reviewed -> valid, excluded -> invalid
        print("Mapping status values: reviewed -> valid, excluded -> invalid...")
        connection.execute(text("""
            UPDATE normalized_transactions 
            SET review_status = CASE 
                WHEN review_status = 'reviewed' THEN 'valid'
                WHEN review_status = 'excluded' THEN 'invalid'
                ELSE review_status
            END
        """))
        print("  - Done")
    else:
        print("  - status column does not exist (skipped)")


def downgrade() -> None:
    """Rename review_status back to status."""
    connection = op.get_bind()
    
    result = connection.execute(text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'normalized_transactions' AND column_name = 'review_status'
    """))
    
    if result.fetchone():
        # Map values back: valid -> reviewed, invalid -> excluded
        connection.execute(text("""
            UPDATE normalized_transactions 
            SET review_status = CASE 
                WHEN review_status = 'valid' THEN 'reviewed'
                WHEN review_status = 'invalid' THEN 'excluded'
                ELSE review_status
            END
        """))
        
        op.alter_column(
            "normalized_transactions",
            "review_status",
            new_column_name="status"
        )
        op.drop_index("idx_normalized_tx_review_status", table_name="normalized_transactions", if_exists=True)
        op.create_index(
            "idx_normalized_tx_status",
            "normalized_transactions",
            ["status"],
        )
