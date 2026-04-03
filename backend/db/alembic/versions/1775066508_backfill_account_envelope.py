"""Backfill account.envelope for broker/investment accounts.

Sets envelope='cto' for existing broker and investment accounts
that currently have NULL envelope, since CTO (standard taxable)
is the default tax envelope in French tax law.

Revision ID: 1775066508
Revises: 1775066507
Create Date: 2026-04-02

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "1775066508"
down_revision: Union[str, None] = "1775066507"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "UPDATE accounts SET envelope = 'cto' "
        "WHERE account_type IN ('broker', 'investment') "
        "AND envelope IS NULL"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE accounts SET envelope = NULL "
        "WHERE account_type IN ('broker', 'investment') "
        "AND envelope = 'cto'"
    )
