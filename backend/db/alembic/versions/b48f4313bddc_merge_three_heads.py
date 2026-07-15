"""merge_three_heads

Revision ID: b48f4313bddc
Revises: 061_add_related_asset_symbol, 1767288560, 1775066503
Create Date: 2026-04-01 20:25:46.201742

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b48f4313bddc'
down_revision: Union[str, Sequence[str], None] = ('061_add_related_asset_symbol', '1767288560', '1775066503')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
