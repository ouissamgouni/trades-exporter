"""Add enabled field to accounts table.

Revision ID: 032_add_account_enabled
Revises: 031_add_staleness_window_days
Create Date: 2026-01-07

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '032_add_account_enabled'
down_revision = '031_add_staleness_window_days'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add enabled column to accounts table with default True
    op.add_column(
        'accounts',
        sa.Column('enabled', sa.Boolean(), nullable=False, server_default=sa.text('true'))
    )
    # Add index for filtering enabled accounts
    op.create_index('ix_accounts_enabled', 'accounts', ['enabled'])


def downgrade() -> None:
    op.drop_index('ix_accounts_enabled', table_name='accounts')
    op.drop_column('accounts', 'enabled')
