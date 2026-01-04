"""Drop UUID columns from CostLot and LotSettlement.

Revision ID: drop_uuid_columns
Revises: simplify_tx_type
Create Date: 2026-01-04

Migration removes:
- cost_lots.lot_uuid
- cost_lots.settled_by_lot_uuid (replaced by settled_by_lot_id FK)
- lot_settlements.settlement_uuid
- lot_settlements.negative_lot_uuid
- lot_settlements.settling_lot_uuid

Integer IDs are simpler and more efficient for this single-database application.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = 'drop_uuid_columns'
down_revision = 'simplify_tx_type'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """
    Remove UUID columns and add settled_by_lot_id FK.
    """
    # Add settled_by_lot_id FK to cost_lots (before dropping settled_by_lot_uuid)
    op.add_column('cost_lots', sa.Column('settled_by_lot_id', sa.Integer(), nullable=True))
    op.create_index('ix_cost_lots_settled_by_lot_id', 'cost_lots', ['settled_by_lot_id'], unique=False)
    op.create_foreign_key(
        'fk_cost_lots_settled_by_lot_id',
        'cost_lots', 'cost_lots',
        ['settled_by_lot_id'], ['cost_lot_id']
    )
    
    # Migrate data: set settled_by_lot_id from settled_by_lot_uuid lookup
    # This SQL looks up the cost_lot_id for the corresponding lot_uuid
    op.execute("""
        UPDATE cost_lots 
        SET settled_by_lot_id = settling.cost_lot_id
        FROM cost_lots settling
        WHERE cost_lots.settled_by_lot_uuid = settling.lot_uuid
        AND cost_lots.settled_by_lot_uuid IS NOT NULL
    """)
    
    # Drop UUID columns from cost_lots
    op.drop_constraint('cost_lots_lot_uuid_key', 'cost_lots', type_='unique')
    op.drop_column('cost_lots', 'lot_uuid')
    op.drop_column('cost_lots', 'settled_by_lot_uuid')
    
    # Drop UUID columns from lot_settlements
    op.drop_constraint('lot_settlements_settlement_uuid_key', 'lot_settlements', type_='unique')
    op.drop_index('ix_lot_settlements_negative_lot_uuid', 'lot_settlements')
    op.drop_index('ix_lot_settlements_settling_lot_uuid', 'lot_settlements')
    op.drop_column('lot_settlements', 'settlement_uuid')
    op.drop_column('lot_settlements', 'negative_lot_uuid')
    op.drop_column('lot_settlements', 'settling_lot_uuid')


def downgrade() -> None:
    """
    Restore UUID columns.
    Note: Data migration is lossy - UUIDs cannot be recovered.
    """
    # Restore lot_settlements UUID columns
    op.add_column('lot_settlements', sa.Column('settling_lot_uuid', postgresql.UUID(), nullable=True))
    op.add_column('lot_settlements', sa.Column('negative_lot_uuid', postgresql.UUID(), nullable=True))
    op.add_column('lot_settlements', sa.Column('settlement_uuid', postgresql.UUID(), nullable=True))
    op.create_index('ix_lot_settlements_settling_lot_uuid', 'lot_settlements', ['settling_lot_uuid'], unique=False)
    op.create_index('ix_lot_settlements_negative_lot_uuid', 'lot_settlements', ['negative_lot_uuid'], unique=False)
    op.create_unique_constraint('lot_settlements_settlement_uuid_key', 'lot_settlements', ['settlement_uuid'])
    
    # Restore cost_lots UUID columns
    op.add_column('cost_lots', sa.Column('settled_by_lot_uuid', postgresql.UUID(), nullable=True))
    op.add_column('cost_lots', sa.Column('lot_uuid', postgresql.UUID(), nullable=True))
    op.create_unique_constraint('cost_lots_lot_uuid_key', 'cost_lots', ['lot_uuid'])
    
    # Generate new UUIDs for restored columns
    op.execute("""
        UPDATE cost_lots SET lot_uuid = gen_random_uuid() WHERE lot_uuid IS NULL
    """)
    op.execute("""
        UPDATE lot_settlements SET settlement_uuid = gen_random_uuid() WHERE settlement_uuid IS NULL
    """)
    
    # Drop settled_by_lot_id FK
    op.drop_constraint('fk_cost_lots_settled_by_lot_id', 'cost_lots', type_='foreignkey')
    op.drop_index('ix_cost_lots_settled_by_lot_id', 'cost_lots')
    op.drop_column('cost_lots', 'settled_by_lot_id')
