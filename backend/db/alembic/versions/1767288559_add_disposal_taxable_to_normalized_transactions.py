"""Add disposal_taxable column to normalized_transactions table.

Revision ID: 1767288559
Revises: 20a109aaa160
Create Date: 2026-01-01

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '1767288559'
down_revision: Union[str, Sequence[str], None] = '20a109aaa160'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add disposal_taxable column to normalized_transactions."""
    op.add_column(
        'normalized_transactions',
        sa.Column('disposal_taxable', sa.Boolean(), nullable=False, server_default='false')
    )


def downgrade() -> None:
    """Remove disposal_taxable column from normalized_transactions."""
    op.drop_column('normalized_transactions', 'disposal_taxable')
