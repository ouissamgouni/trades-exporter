"""add economic cost basis columns (economic vs tax view)

Revision ID: 068_economic_cost_basis
Revises: 067_pnl_warning_acks
Create Date: 2026-11-07

"""

import sqlalchemy as sa
from alembic import op


revision = "068_economic_cost_basis"
down_revision = "067_pnl_warning_acks"
branch_labels = None
depends_on = None

_COLUMNS = [
    ("cost_lots", "economic_unit_cost_in_base"),
    ("consumed_lot_slices", "economic_unit_cost_in_base"),
    ("consumed_lot_slices", "economic_total_cost_in_base"),
    ("realized_pnl", "economic_cost_basis_in_base"),
    ("realized_pnl", "economic_pnl_in_base"),
]


def upgrade():
    for table, column in _COLUMNS:
        op.add_column(table, sa.Column(column, sa.Numeric(36, 18), nullable=True))


def downgrade():
    for table, column in reversed(_COLUMNS):
        op.drop_column(table, column)
