"""Make FeeEntry.realized_pnl_id nullable

Revision ID: a1b2c3d4e5f6
Revises: 71cdb7fc8b41
Create Date: 2026-01-02 15:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = '71cdb7fc8b41'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Make realized_pnl_id nullable for base currency fees."""
    op.alter_column('fee_entries', 'realized_pnl_id',
                    existing_type=sa.Integer(),
                    nullable=True)


def downgrade() -> None:
    """Revert realized_pnl_id to NOT NULL."""
    op.alter_column('fee_entries', 'realized_pnl_id',
                    existing_type=sa.Integer(),
                    nullable=False)
