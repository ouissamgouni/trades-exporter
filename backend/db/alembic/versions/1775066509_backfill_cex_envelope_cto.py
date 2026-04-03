"""Backfill account.envelope for CEX accounts.

Sets envelope='cto' for existing CEX accounts that currently have NULL
envelope, since CEX crypto trades are taxable under French tax law
(Art. 150 VH bis) and belong in a standard CTO envelope.

Revision ID: 1775066509
Revises: 1775066508
Create Date: 2026-04-02

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "1775066509"
down_revision: Union[str, None] = "1775066508"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "UPDATE accounts SET envelope = 'cto' "
        "WHERE account_type = 'cex' "
        "AND envelope IS NULL"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE accounts SET envelope = NULL "
        "WHERE account_type = 'cex' "
        "AND envelope = 'cto'"
    )
