"""Rename user_calculation_unit_id to calculation_unit_id

Revision ID: f65e5c6f3845
Revises: 20a109aaa160
Create Date: 2025-12-30 13:02:20.894970

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f65e5c6f3845'
down_revision: Union[str, Sequence[str], None] = '20a109aaa160'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade():
    # Rename calculation_unit_id → user_calculation_unit_id to match model field name
    op.alter_column('normalized_transactions', 'calculation_unit_id', new_column_name='user_calculation_unit_id')

def downgrade():
    # Revert: user_calculation_unit_id → calculation_unit_id
    op.alter_column('normalized_transactions', 'user_calculation_unit_id', new_column_name='calculation_unit_id')