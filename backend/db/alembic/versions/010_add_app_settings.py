"""Add app_settings table.

Revision ID: 010_add_app_settings
Revises: 009_restore_status_and_taxability
Create Date: 2024-12-24

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '010_add_app_settings'
down_revision: Union[str, None] = '009_restore_status_and_taxability'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create app_settings table."""
    op.create_table(
        'app_settings',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('base_currency', sa.String(), nullable=False, server_default='EUR'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint('id')
    )
    
    # Insert default settings row
    op.execute(
        "INSERT INTO app_settings (id, base_currency) VALUES (1, 'EUR') "
        "ON CONFLICT (id) DO NOTHING"
    )


def downgrade() -> None:
    """Drop app_settings table."""
    op.drop_table('app_settings')
