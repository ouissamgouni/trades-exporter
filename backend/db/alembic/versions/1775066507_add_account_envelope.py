"""Add envelope column to accounts table.

Tax envelope classification for French tax law (PEA, AV, CTO).
Nullable — None means standard taxable (equivalent to CTO).

Revision ID: 1775066507
Revises: 1775066506
Create Date: 2026-04-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "1775066507"
down_revision: Union[str, None] = "1775066506"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("accounts", sa.Column("envelope", sa.String(), nullable=True))
    op.create_index("ix_accounts_envelope", "accounts", ["envelope"])


def downgrade() -> None:
    op.drop_index("ix_accounts_envelope", table_name="accounts")
    op.drop_column("accounts", "envelope")
