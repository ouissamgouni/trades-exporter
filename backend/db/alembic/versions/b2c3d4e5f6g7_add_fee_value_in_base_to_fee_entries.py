"""Add fee_value_in_base to fee_entries

Revision ID: b2c3d4e5f6g7
Revises: a1b2c3d4e5f6
Create Date: 2026-01-02 16:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'b2c3d4e5f6g7'
down_revision: Union[str, Sequence[str], None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add fee_value_in_base column to fee_entries table."""
    op.add_column('fee_entries', sa.Column('fee_value_in_base', sa.Numeric(precision=28, scale=18), nullable=False, server_default='0'))


def downgrade() -> None:
    """Remove fee_value_in_base column from fee_entries table."""
    op.drop_column('fee_entries', 'fee_value_in_base')
