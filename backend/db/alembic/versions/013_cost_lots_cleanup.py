"""Add is_negative to cost_lots, cleanup unused fields.

Revision ID: 013_cost_lots_cleanup
Revises: 012_add_dimension_label
Create Date: 2024-12-25

Changes:
- Add is_negative column to cost_lots (default False)
- Remove origin_group_id column (no longer used)
- Keep total_cost_in_base for backward compatibility (computed in code)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '013_cost_lots_cleanup'
down_revision: Union[str, None] = '012_add_dimension_label'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add is_negative column, remove origin_group_id."""
    # Add is_negative column with default False
    op.add_column(
        'cost_lots',
        sa.Column('is_negative', sa.Boolean(), nullable=False, server_default='false')
    )
    
    # Remove origin_group_id column (no longer used after groups removal)
    op.drop_column('cost_lots', 'origin_group_id')


def downgrade() -> None:
    """Revert changes."""
    # Remove is_negative column
    op.drop_column('cost_lots', 'is_negative')
    
    # Re-add origin_group_id column
    op.add_column(
        'cost_lots',
        sa.Column('origin_group_id', sa.Integer(), nullable=True)
    )
