"""add bundle_data to bundles table

Revision ID: 6a0e23eccd6b
Revises: 04d1e66919a2
Create Date: 2025-06-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '6a0e23eccd6b'
down_revision: Union[str, None] = '04d1e66919a2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('bundles', sa.Column('bundle_data', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('bundles', 'bundle_data')
