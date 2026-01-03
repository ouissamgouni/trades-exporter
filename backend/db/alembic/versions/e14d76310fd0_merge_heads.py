"""merge_heads

Revision ID: e14d76310fd0
Revises: 023_move_taxability_to_leg, 1767288559
Create Date: 2026-01-01 18:50:29.997826

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e14d76310fd0'
down_revision: Union[str, Sequence[str], None] = ('023_move_taxability_to_leg', '1767288559')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
