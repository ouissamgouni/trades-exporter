"""Create calculation_unit_legs table

Revision ID: 022b_create_legs
Revises: 022_add_config_fields
Create Date: 2026-01-01

Creates the calculation_unit_legs table to store leg details for each calculation unit.
This table stores the individual transaction legs (inflows, outflows, fees) that make up
each calculation unit.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '022b_create_legs'
down_revision: Union[str, Sequence[str], None] = '022_add_config_fields'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create calculation_unit_legs table."""
    op.create_table(
        'calculation_unit_legs',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('unit_id', sa.Integer(), sa.ForeignKey('calculation_units.id', ondelete='CASCADE'), nullable=False),
        sa.Column('transaction_id', sa.Integer(), sa.ForeignKey('normalized_transactions.id', ondelete='CASCADE'), nullable=False),
        sa.Column('asset_id', sa.Integer(), sa.ForeignKey('assets.asset_id', ondelete='CASCADE'), nullable=False),
        sa.Column('leg_type', sa.String(20), nullable=False),  # 'inflow', 'outflow', 'fee'
        sa.Column('quantity', sa.Numeric(precision=36, scale=18), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    
    # Create indexes for efficient queries
    op.create_index('ix_calculation_unit_legs_unit_id', 'calculation_unit_legs', ['unit_id'])
    op.create_index('ix_calculation_unit_legs_transaction_id', 'calculation_unit_legs', ['transaction_id'])
    op.create_index('ix_calculation_unit_legs_asset_id', 'calculation_unit_legs', ['asset_id'])
    op.create_index('ix_calculation_unit_legs_leg_type', 'calculation_unit_legs', ['leg_type'])


def downgrade() -> None:
    """Drop calculation_unit_legs table."""
    op.drop_index('ix_calculation_unit_legs_leg_type', table_name='calculation_unit_legs')
    op.drop_index('ix_calculation_unit_legs_asset_id', table_name='calculation_unit_legs')
    op.drop_index('ix_calculation_unit_legs_transaction_id', table_name='calculation_unit_legs')
    op.drop_index('ix_calculation_unit_legs_unit_id', table_name='calculation_unit_legs')
    op.drop_table('calculation_unit_legs')
