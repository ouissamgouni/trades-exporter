"""empty message

Revision ID: 3b8f7b7864dd
Revises: f6dde796ad67, 034_add_unit_id_to_consumed_lot_slices
Create Date: 2026-01-09 16:51:10.899578

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '3b8f7b7864dd'
down_revision: Union[str, Sequence[str], None] = ('f6dde796ad67', '035_add_unit_id_to_slices')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
