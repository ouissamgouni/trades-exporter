"""merge_heads

Revision ID: 07d1751fb1e6
Revises: 039_change_tags_to_jsonb, 8aad73aba262
Create Date: 2026-01-26 18:27:34.775976

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '07d1751fb1e6'
down_revision: Union[str, Sequence[str], None] = ('039_change_tags_to_jsonb', '8aad73aba262')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
