"""Add staleness_window_days to asset_price_getters table

Revision ID: 031_add_staleness_window_days
Revises: 030_add_source_account
Create Date: 2026-01-06

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '031_add_staleness_window_days'
down_revision: Union[str, Sequence[str], None] = '030_add_source_account'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add staleness_window_days column to asset_price_getters table."""
    op.add_column(
        'asset_price_getters',
        sa.Column('staleness_window_days', sa.Integer(), nullable=True)
    )


def downgrade() -> None:
    """Remove staleness_window_days column from asset_price_getters table."""
    op.drop_column('asset_price_getters', 'staleness_window_days')
