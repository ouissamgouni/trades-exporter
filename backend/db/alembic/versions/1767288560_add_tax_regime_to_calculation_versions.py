"""Add tax_regime column to calculation_versions table.

Revision ID: 1767288560
Revises: 1767288559
Create Date: 2026-04-01

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '1767288560'
down_revision: Union[str, Sequence[str], None] = '1767288559'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'calculation_versions',
        sa.Column('tax_regime', sa.String(), nullable=True, server_default='none')
    )


def downgrade() -> None:
    op.drop_column('calculation_versions', 'tax_regime')
