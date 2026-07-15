"""merge_heads

Revision ID: 1a07528b699a
Revises: 032_add_dismissed_fields, 041_update_enum_values
Create Date: 2026-02-05 04:04:01.015777

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '1a07528b699a'
down_revision: Union[str, Sequence[str], None] = ('032_add_dismissed_fields', '041_update_enum_values')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
