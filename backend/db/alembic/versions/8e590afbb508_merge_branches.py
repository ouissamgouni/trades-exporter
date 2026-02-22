"""merge_branches

Revision ID: 8e590afbb508
Revises: 033_connector_id, 036_drop_event_metadata
Create Date: 2026-01-14 15:24:35.405450

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8e590afbb508'
down_revision: Union[str, Sequence[str], None] = ('033_connector_id', '036_drop_event_metadata')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
