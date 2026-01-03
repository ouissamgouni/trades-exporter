"""add cost_lot_events table

Revision ID: 021_add_cost_lot_events
Revises: 20a109aaa160
Create Date: 2025-12-31
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers
revision = '021_add_cost_lot_events'
down_revision = 'f65e5c6f3845'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'cost_lot_events',
        sa.Column('event_id', sa.Integer(), primary_key=True),
        sa.Column('event_type', sa.String(), nullable=False),
        sa.Column('lot_id', sa.Integer(), sa.ForeignKey('cost_lots.cost_lot_id', ondelete='CASCADE'), nullable=False),
        sa.Column('related_lot_id', sa.Integer(), sa.ForeignKey('cost_lots.cost_lot_id', ondelete='SET NULL')),
        sa.Column('quantity_delta', sa.Numeric(36, 18), nullable=False),
        sa.Column('cost_basis_delta', sa.Numeric(36, 18)),
        sa.Column('qty_remaining_after', sa.Numeric(36, 18), nullable=False),
        sa.Column('cost_basis_remaining_after', sa.Numeric(36, 18)),
        sa.Column('triggered_by_transaction_id', sa.Integer(), sa.ForeignKey('normalized_transactions.id', ondelete='SET NULL')),
        sa.Column('triggered_by_unit_id', sa.Integer(), sa.ForeignKey('calculation_units.id', ondelete='SET NULL')),
        sa.Column('timestamp', sa.DateTime(), nullable=False),
        sa.Column('sequence_num', sa.Integer(), default=0),
        sa.Column('event_metadata', postgresql.JSON()),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    
    # Create indexes for common queries
    op.create_index('ix_cost_lot_events_event_type', 'cost_lot_events', ['event_type'])
    op.create_index('ix_cost_lot_events_lot_id', 'cost_lot_events', ['lot_id'])
    op.create_index('ix_cost_lot_events_related_lot_id', 'cost_lot_events', ['related_lot_id'])
    op.create_index('ix_cost_lot_events_timestamp', 'cost_lot_events', ['timestamp'])
    op.create_index('ix_cost_lot_events_triggered_by_transaction_id', 'cost_lot_events', ['triggered_by_transaction_id'])
    op.create_index('ix_cost_lot_events_triggered_by_unit_id', 'cost_lot_events', ['triggered_by_unit_id'])
    # Composite index for common query pattern (lot history)
    op.create_index('ix_cost_lot_events_lot_timestamp', 'cost_lot_events', ['lot_id', 'timestamp'])


def downgrade():
    op.drop_table('cost_lot_events')
