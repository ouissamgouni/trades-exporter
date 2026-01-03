"""Add version_id column to cost_lots table.

This migration adds the version_id FK to link cost lots to calculation versions.

Revision ID: 019
Revises: 018
Create Date: 2025-12-26

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '019'
down_revision = '018'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add version_id column to cost_lots
    op.add_column(
        'cost_lots',
        sa.Column('version_id', sa.Integer(), nullable=True)
    )
    op.create_foreign_key(
        'fk_cost_lots_version_id',
        'cost_lots',
        'calculation_versions',
        ['version_id'],
        ['version_id']
    )
    op.create_index('ix_cost_lots_version_id', 'cost_lots', ['version_id'])


def downgrade() -> None:
    op.drop_index('ix_cost_lots_version_id', 'cost_lots')
    op.drop_constraint('fk_cost_lots_version_id', 'cost_lots', type_='foreignkey')
    op.drop_column('cost_lots', 'version_id')
