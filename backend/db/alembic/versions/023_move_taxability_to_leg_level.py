"""Move taxability to leg level

Revision ID: 023_move_taxability_to_leg
Revises: 022_add_config_fields
Create Date: 2026-01-01

This migration:
1. Adds disposal_taxable column to calculation_unit_legs (computed during P&L)
2. Removes is_taxable column from calculation_units (was at wrong level)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '023_move_taxability_to_leg'
down_revision: Union[str, Sequence[str], None] = '022b_create_legs'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add disposal_taxable to legs, remove is_taxable from units."""
    # Add disposal_taxable column to calculation_unit_legs
    # This stores the computed taxability for each leg during P&L processing
    op.add_column(
        'calculation_unit_legs',
        sa.Column('disposal_taxable', sa.Boolean(), nullable=False, server_default='false')
    )
    
    # Remove is_taxable from calculation_units (taxability is per-leg, not per-unit)
    op.drop_column('calculation_units', 'is_taxable')


def downgrade() -> None:
    """Restore is_taxable to units, remove disposal_taxable from legs."""
    # Re-add is_taxable to calculation_units
    op.add_column(
        'calculation_units',
        sa.Column('is_taxable', sa.Boolean(), nullable=False, server_default='false')
    )
    
    # Remove disposal_taxable from calculation_unit_legs
    op.drop_column('calculation_unit_legs', 'disposal_taxable')
