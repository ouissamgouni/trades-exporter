"""Add related_asset_id to FeeEntry

Revision ID: 71cdb7fc8b41
Revises: ccd4718463f9
Create Date: 2026-01-02 14:04:43.646585

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '71cdb7fc8b41'
down_revision: Union[str, Sequence[str], None] = 'ccd4718463f9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add related_asset_id column to fee_entries table."""
    op.add_column('fee_entries', sa.Column('related_asset_id', sa.Integer(), nullable=True))
    op.create_index(op.f('ix_fee_entries_related_asset_id'), 'fee_entries', ['related_asset_id'], unique=False)
    op.create_foreign_key('fk_fee_entries_related_asset_id', 'fee_entries', 'assets', ['related_asset_id'], ['asset_id'])


def downgrade() -> None:
    """Remove related_asset_id column from fee_entries table."""
    op.drop_constraint('fk_fee_entries_related_asset_id', 'fee_entries', type_='foreignkey')
    op.drop_index(op.f('ix_fee_entries_related_asset_id'), table_name='fee_entries')
    op.drop_column('fee_entries', 'related_asset_id')
