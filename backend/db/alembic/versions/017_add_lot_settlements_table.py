"""Add lot_settlements table for tracking negative lot settlement audit trail.

Revision ID: 017
Revises: 016_rename_status_to_review_status
Create Date: 2025-12-26

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '017'
down_revision = '016_rename_status_to_review_status'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create lot_settlements table
    op.create_table(
        'lot_settlements',
        sa.Column('settlement_id', sa.Integer(), nullable=False),
        sa.Column('settlement_uuid', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('version_id', sa.Integer(), nullable=False),
        sa.Column('negative_lot_id', sa.Integer(), nullable=True),
        sa.Column('negative_lot_uuid', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('settling_lot_id', sa.Integer(), nullable=True),
        sa.Column('settling_lot_uuid', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('settling_transaction_id', sa.Integer(), nullable=True),
        sa.Column('qty_settled', sa.Numeric(precision=36, scale=18), nullable=False),
        sa.Column('cost_basis_applied', sa.Numeric(precision=36, scale=18), nullable=True),
        sa.Column('settled_at', sa.DateTime(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint('settlement_id'),
        sa.ForeignKeyConstraint(['version_id'], ['calculation_versions.version_id']),
        sa.ForeignKeyConstraint(['negative_lot_id'], ['cost_lots.cost_lot_id']),
        sa.ForeignKeyConstraint(['settling_lot_id'], ['cost_lots.cost_lot_id']),
        sa.ForeignKeyConstraint(['settling_transaction_id'], ['normalized_transactions.id']),
        sa.UniqueConstraint('settlement_uuid')
    )
    
    # Create indexes
    op.create_index('ix_lot_settlements_version_id', 'lot_settlements', ['version_id'])
    op.create_index('ix_lot_settlements_negative_lot_id', 'lot_settlements', ['negative_lot_id'])
    op.create_index('ix_lot_settlements_settling_lot_id', 'lot_settlements', ['settling_lot_id'])
    op.create_index('ix_lot_settlements_negative_lot_uuid', 'lot_settlements', ['negative_lot_uuid'])
    op.create_index('ix_lot_settlements_settling_lot_uuid', 'lot_settlements', ['settling_lot_uuid'])
    op.create_index('ix_lot_settlements_settled_at', 'lot_settlements', ['settled_at'])


def downgrade() -> None:
    # Drop indexes
    op.drop_index('ix_lot_settlements_settled_at', 'lot_settlements')
    op.drop_index('ix_lot_settlements_settling_lot_uuid', 'lot_settlements')
    op.drop_index('ix_lot_settlements_negative_lot_uuid', 'lot_settlements')
    op.drop_index('ix_lot_settlements_settling_lot_id', 'lot_settlements')
    op.drop_index('ix_lot_settlements_negative_lot_id', 'lot_settlements')
    op.drop_index('ix_lot_settlements_version_id', 'lot_settlements')
    
    # Drop table
    op.drop_table('lot_settlements')
