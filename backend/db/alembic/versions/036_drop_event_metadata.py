"""Drop event_metadata from cost_lot_events

Revision ID: 036_drop_event_metadata
Revises: f8250e87ea8c
Create Date: 2026-01-11

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = '036_drop_event_metadata'
down_revision = 'f8250e87ea8c'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Drop event_metadata column."""
    op.drop_column('cost_lot_events', 'event_metadata')


def downgrade() -> None:
    """Restore event_metadata column."""
    op.add_column('cost_lot_events', 
        sa.Column('event_metadata', postgresql.JSON(), nullable=True))
