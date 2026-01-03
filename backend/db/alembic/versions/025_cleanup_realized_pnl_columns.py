"""Remove obsolete columns from realized_pnl table

Revision ID: 025_cleanup_realized_pnl_columns
Revises: 024_add_disposal_taxable_realized_pnl
Create Date: 2026-01-01

This migration removes obsolete columns from realized_pnl that are no longer 
in the model: taxable, consumed_cost_lot_ids, version_id, consumed_lot_details, 
consumed_slices.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '025_cleanup_realized_pnl_columns'
down_revision: Union[str, Sequence[str], None] = '024_add_disposal_taxable_realized_pnl'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Remove obsolete columns from realized_pnl."""
    op.drop_column('realized_pnl', 'taxable')
    op.drop_column('realized_pnl', 'consumed_cost_lot_ids')
    op.drop_column('realized_pnl', 'version_id')
    op.drop_column('realized_pnl', 'consumed_lot_details')
    op.drop_column('realized_pnl', 'consumed_slices')


def downgrade() -> None:
    """Restore obsolete columns to realized_pnl."""
    op.add_column('realized_pnl', sa.Column('consumed_slices', postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column('realized_pnl', sa.Column('consumed_lot_details', postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column('realized_pnl', sa.Column('version_id', sa.INTEGER(), nullable=True))
    op.add_column('realized_pnl', sa.Column('consumed_cost_lot_ids', postgresql.ARRAY(sa.INTEGER()), nullable=True))
    op.add_column('realized_pnl', sa.Column('taxable', sa.BOOLEAN(), nullable=False, server_default='true'))
