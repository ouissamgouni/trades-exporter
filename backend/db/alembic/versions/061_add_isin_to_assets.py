"""add isin to assets

Revision ID: 061_add_isin
Revises: 6a0e23eccd6b
Create Date: 2026-04-08

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect as sa_inspect


revision: str = '061_add_isin'
down_revision: Union[str, None] = '6a0e23eccd6b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa_inspect(conn)

    def _has_column(table: str, col: str) -> bool:
        return any(c["name"] == col for c in insp.get_columns(table))

    if not _has_column('assets', 'isin'):
        op.add_column('assets', sa.Column('isin', sa.String(), nullable=True))
        op.create_index(op.f('ix_assets_isin'), 'assets', ['isin'], unique=True)


def downgrade() -> None:
    op.drop_index(op.f('ix_assets_isin'), table_name='assets')
    op.drop_column('assets', 'isin')
