"""merge_heads_taxability

Revision ID: ea875aa4ecfb
Revises: 028_rename_taxability_to_taxability_status, 0a6ee0b5a90b
Create Date: 2026-01-05 15:17:14.997023

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ea875aa4ecfb'
down_revision: Union[str, Sequence[str], None] = ('028_rename_taxability_to_taxability_status', '0a6ee0b5a90b')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
