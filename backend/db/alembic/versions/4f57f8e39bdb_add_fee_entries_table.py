"""add_fee_entries_table

Revision ID: 4f57f8e39bdb
Revises: fcf7f48445d6
Create Date: 2026-01-01 23:11:35.068509

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4f57f8e39bdb'
down_revision: Union[str, Sequence[str], None] = 'fcf7f48445d6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema - create simplified fee_entries index table."""
    op.create_table(
        'fee_entries',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('fee_leg_id', sa.Integer(), nullable=False),
        sa.Column('realized_pnl_id', sa.Integer(), nullable=False),
        sa.Column('unit_id', sa.Integer(), nullable=False),
        sa.Column('version_id', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['fee_leg_id'], ['calculation_unit_legs.id'], ),
        sa.ForeignKeyConstraint(['realized_pnl_id'], ['realized_pnl.pnl_id'], ),
        sa.ForeignKeyConstraint(['unit_id'], ['calculation_units.id'], ),
        sa.ForeignKeyConstraint(['version_id'], ['calculation_versions.version_id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_fee_entries_fee_leg_id'), 'fee_entries', ['fee_leg_id'], unique=False)
    op.create_index(op.f('ix_fee_entries_realized_pnl_id'), 'fee_entries', ['realized_pnl_id'], unique=False)
    op.create_index(op.f('ix_fee_entries_unit_id'), 'fee_entries', ['unit_id'], unique=False)
    op.create_index(op.f('ix_fee_entries_version_id'), 'fee_entries', ['version_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_fee_entries_version_id'), table_name='fee_entries')
    op.drop_index(op.f('ix_fee_entries_unit_id'), table_name='fee_entries')
    op.drop_index(op.f('ix_fee_entries_realized_pnl_id'), table_name='fee_entries')
    op.drop_index(op.f('ix_fee_entries_fee_leg_id'), table_name='fee_entries')
    op.drop_table('fee_entries')
