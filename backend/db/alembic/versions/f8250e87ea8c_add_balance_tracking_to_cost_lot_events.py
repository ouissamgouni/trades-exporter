"""Add balance tracking to cost lot events

Revision ID: f8250e87ea8c
Revises: 3b8f7b7864dd
Create Date: 2026-01-10 02:08:11.232132

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'f8250e87ea8c'
down_revision: Union[str, Sequence[str], None] = '3b8f7b7864dd'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Only add balance columns - skip other auto-generated changes
    op.add_column('cost_lot_events', sa.Column('balance_after', sa.Numeric(precision=36, scale=18), nullable=True))
    op.add_column('cost_lot_events', sa.Column('account_balance_after', sa.Numeric(precision=36, scale=18), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    # Only drop balance columns
    op.drop_column('cost_lot_events', 'account_balance_after')
    op.drop_column('cost_lot_events', 'balance_after')
    # ### end Alembic commands ###
