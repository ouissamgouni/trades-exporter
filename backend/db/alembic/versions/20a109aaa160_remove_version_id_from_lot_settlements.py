"""remove_version_id_from_lot_settlements

Revision ID: 20a109aaa160
Revises: 0dee19a61116
Create Date: 2025-12-28 23:19:58.975020

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '20a109aaa160'
down_revision: Union[str, Sequence[str], None] = '0dee19a61116'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Drop index first
    op.drop_index('ix_lot_settlements_version_id', table_name='lot_settlements')
    
    # Drop foreign key constraint
    op.drop_constraint('lot_settlements_version_id_fkey', 'lot_settlements', type_='foreignkey')
    
    # Drop column
    op.drop_column('lot_settlements', 'version_id')


def downgrade() -> None:
    """Downgrade schema."""
    # Add column back
    op.add_column('lot_settlements', 
        sa.Column('version_id', sa.Integer(), nullable=True)
    )
    
    # Recreate foreign key constraint
    op.create_foreign_key(
        'lot_settlements_version_id_fkey',
        'lot_settlements', 
        'calculation_versions',
        ['version_id'], 
        ['version_id']
    )
    
    # Recreate index
    op.create_index('ix_lot_settlements_version_id', 'lot_settlements', ['version_id'])
