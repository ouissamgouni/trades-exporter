"""Add config fields to calculation_versions

Revision ID: 022_add_config_fields
Revises: 021_add_cost_lot_events
Create Date: 2025-12-31

"""
from typing import Sequence, Union
from decimal import Decimal

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '022_add_config_fields'
down_revision: Union[str, Sequence[str], None] = '021_add_cost_lot_events'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add allow_negative_balances and residual_tolerance_pct to calculation_versions."""
    # Add allow_negative_balances column with default False
    op.add_column(
        'calculation_versions',
        sa.Column('allow_negative_balances', sa.Boolean(), nullable=False, server_default='false')
    )
    
    # Add residual_tolerance_pct column with default 0.05
    op.add_column(
        'calculation_versions',
        sa.Column('residual_tolerance_pct', sa.Numeric(precision=10, scale=4), nullable=False, server_default='0.05')
    )


def downgrade() -> None:
    """Remove config fields from calculation_versions."""
    op.drop_column('calculation_versions', 'residual_tolerance_pct')
    op.drop_column('calculation_versions', 'allow_negative_balances')
