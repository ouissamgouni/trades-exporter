"""add_denomination_currency_to_asset

Revision ID: 04d1e66919a2
Revises: 438ad8371b2b
Create Date: 2026-04-05 16:28:54.513989

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect as sa_inspect

# revision identifiers, used by Alembic.
revision: str = '04d1e66919a2'
down_revision: Union[str, Sequence[str], None] = '438ad8371b2b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    conn = op.get_bind()
    insp = sa_inspect(conn)

    has_col = any(c["name"] == "denomination_currency_id" for c in insp.get_columns("assets"))
    has_idx = any(i["name"] == "ix_assets_denomination_currency_id" for i in insp.get_indexes("assets"))
    has_fk = any(fk.get("name") == "fk_assets_denomination_currency" for fk in insp.get_foreign_keys("assets"))

    if not has_col:
        op.add_column('assets', sa.Column('denomination_currency_id', sa.Integer(), nullable=True))
    if not has_idx:
        op.create_index(op.f('ix_assets_denomination_currency_id'), 'assets', ['denomination_currency_id'], unique=False)
    if not has_fk:
        op.create_foreign_key('fk_assets_denomination_currency', 'assets', 'assets', ['denomination_currency_id'], ['asset_id'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('fk_assets_denomination_currency', 'assets', type_='foreignkey')
    op.drop_index(op.f('ix_assets_denomination_currency_id'), table_name='assets')
    op.drop_column('assets', 'denomination_currency_id')
