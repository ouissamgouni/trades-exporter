"""Add is_settled column to cost_lots table

Revision ID: add_is_settled
Revises: <your_previous_revision>
Create Date: 2024-01-01
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers
revision = 'add_is_settled'
down_revision = None  # Update this to your latest revision ID
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('cost_lots', sa.Column('is_settled', sa.Boolean(), nullable=False, server_default='false'))
    op.create_index('ix_cost_lots_is_settled', 'cost_lots', ['is_settled'])


def downgrade() -> None:
    op.drop_index('ix_cost_lots_is_settled', table_name='cost_lots')
    op.drop_column('cost_lots', 'is_settled')
