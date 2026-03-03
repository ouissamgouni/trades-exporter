"""drop_disposal_taxable_from_normalized_transactions

Revision ID: 0f0a377e5588
Revises: 046_add_color
Create Date: 2026-02-28 19:19:43.735806

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0f0a377e5588'
down_revision: Union[str, Sequence[str], None] = '046_add_color'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Drop the deprecated disposal_taxable column (replaced by taxability_status)."""
    op.drop_column('normalized_transactions', 'disposal_taxable')


def downgrade() -> None:
    """Re-add disposal_taxable column."""
    op.add_column('normalized_transactions', sa.Column('disposal_taxable', sa.Boolean(), nullable=True, server_default=sa.text('false')))
