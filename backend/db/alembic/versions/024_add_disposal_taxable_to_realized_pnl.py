"""Add disposal_taxable column to realized_pnl table

Revision ID: 024_add_disposal_taxable_realized_pnl
Revises: e14d76310fd0
Create Date: 2026-01-01

This migration adds the disposal_taxable column to the realized_pnl table
to track whether each realized P&L entry is a taxable disposal event.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '024_add_disposal_taxable_realized_pnl'
down_revision: Union[str, Sequence[str], None] = 'e14d76310fd0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add disposal_taxable column to realized_pnl."""
    op.add_column(
        'realized_pnl',
        sa.Column('disposal_taxable', sa.Boolean(), nullable=False, server_default='false')
    )


def downgrade() -> None:
    """Remove disposal_taxable column from realized_pnl."""
    op.drop_column('realized_pnl', 'disposal_taxable')
