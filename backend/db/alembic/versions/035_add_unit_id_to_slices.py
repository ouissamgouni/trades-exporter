"""add_unit_id_to_consumed_lot_slices

Revision ID: 034_add_unit_id_to_consumed_lot_slices
Revises: 033_add_sync_job_tracking
Create Date: 2026-01-09

Adds unit_id FK to consumed_lot_slices for direct link to calculation units.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '035_add_unit_id_to_slices'
down_revision: Union[str, Sequence[str], None] = '033_add_sync_job_tracking'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.
    
    Adds unit_id FK to consumed_lot_slices for direct linking to calculation units.
    Populates existing records using the consumed_by_leg_id -> calculation_unit_legs -> calculation_units path.
    """
    # Add unit_id column
    op.add_column('consumed_lot_slices', sa.Column('unit_id', sa.Integer(), nullable=True))
    op.create_index(op.f('ix_consumed_lot_slices_unit_id'), 'consumed_lot_slices', ['unit_id'], unique=False)
    op.create_foreign_key(
        'consumed_lot_slices_unit_id_fkey',
        'consumed_lot_slices',
        'calculation_units',
        ['unit_id'],
        ['id']
    )
    
    # Populate unit_id for existing records using the leg path
    op.execute("""
        UPDATE consumed_lot_slices 
        SET unit_id = calculation_unit_legs.unit_id
        FROM calculation_unit_legs
        WHERE consumed_lot_slices.consumed_by_leg_id = calculation_unit_legs.id
        AND consumed_lot_slices.unit_id IS NULL
    """)


def downgrade() -> None:
    """Downgrade schema."""
    # Remove unit_id from consumed_lot_slices
    op.drop_constraint('consumed_lot_slices_unit_id_fkey', 'consumed_lot_slices', type_='foreignkey')
    op.drop_index(op.f('ix_consumed_lot_slices_unit_id'), table_name='consumed_lot_slices')
    op.drop_column('consumed_lot_slices', 'unit_id')