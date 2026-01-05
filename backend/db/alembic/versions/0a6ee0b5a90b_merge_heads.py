"""merge_heads

Revision ID: 0a6ee0b5a90b
Revises: 027_normalize_dimensions, add_external_id
Create Date: 2026-01-05 01:56:19.584564

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0a6ee0b5a90b'
down_revision: Union[str, Sequence[str], None] = ('027_normalize_dimensions', 'add_external_id')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
