"""Add calculation_unit_legs junction table

Revision ID: add_calculation_unit_legs
Revises: add_is_settled
Create Date: 2024-12-29
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers
revision = 'add_calculation_unit_legs'
down_revision = 'add_is_settled'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'calculation_unit_legs',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('unit_id', sa.Integer(), sa.ForeignKey('calculation_units.id'), nullable=False, index=True),
        sa.Column('transaction_id', sa.Integer(), sa.ForeignKey('normalized_transactions.id'), nullable=False, index=True),
        sa.Column('asset_id', sa.Integer(), sa.ForeignKey('assets.asset_id'), nullable=False, index=True),
        sa.Column('leg_type', sa.String(), nullable=False, index=True),
        sa.Column('quantity', sa.Numeric(36, 18), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    # Composite index for efficient queries by unit + leg_type
    op.create_index('ix_calculation_unit_legs_unit_type', 'calculation_unit_legs', ['unit_id', 'leg_type'])


def downgrade() -> None:
    op.drop_index('ix_calculation_unit_legs_unit_type', table_name='calculation_unit_legs')
    op.drop_table('calculation_unit_legs')
