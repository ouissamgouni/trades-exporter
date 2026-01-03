"""add_realized_pnl_id_to_fee_entries

Revision ID: ccd4718463f9
Revises: 4f57f8e39bdb
Create Date: 2026-01-01 23:21:52.569093

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ccd4718463f9'
down_revision: Union[str, Sequence[str], None] = '4f57f8e39bdb'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Add realized_pnl_id column and FK constraint to fee_entries
    op.add_column('fee_entries', sa.Column('realized_pnl_id', sa.Integer(), nullable=True))
    op.create_index(op.f('ix_fee_entries_realized_pnl_id'), 'fee_entries', ['realized_pnl_id'], unique=False)
    op.create_foreign_key('fk_fee_entries_realized_pnl_id', 'fee_entries', 'realized_pnl', ['realized_pnl_id'], ['pnl_id'])


def downgrade() -> None:
    """Downgrade schema."""
    # Remove FK constraint, index, and column
    op.drop_constraint('fk_fee_entries_realized_pnl_id', 'fee_entries', type_='foreignkey')
    op.drop_index(op.f('ix_fee_entries_realized_pnl_id'), table_name='fee_entries')
    op.drop_column('fee_entries', 'realized_pnl_id')
