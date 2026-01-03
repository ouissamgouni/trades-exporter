"""drop taxable column (disposal_taxable already exists)

Revision ID: c1d2e3f4g5h6
Revises: b2c3d4e5f6g7
Create Date: 2026-01-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'c1d2e3f4g5h6'
down_revision: Union[str, Sequence[str], None] = 'b2c3d4e5f6g7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Drop the deprecated 'taxable' column - disposal_taxable already exists."""
    # First copy any True values from taxable to disposal_taxable (if not already set)
    op.execute("""
        UPDATE normalized_transactions 
        SET disposal_taxable = taxable 
        WHERE taxable = true AND disposal_taxable = false
    """)
    # Drop the old taxable column
    op.drop_column('normalized_transactions', 'taxable')


def downgrade() -> None:
    """Re-add the taxable column."""
    op.add_column(
        'normalized_transactions',
        sa.Column('taxable', sa.Boolean(), nullable=False, server_default='false')
    )
    # Copy disposal_taxable values back to taxable
    op.execute("""
        UPDATE normalized_transactions 
        SET taxable = disposal_taxable
    """)
