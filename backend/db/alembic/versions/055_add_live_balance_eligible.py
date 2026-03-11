"""Add live_balance_eligible flag to accounts table.

Allows users to exclude specific accounts from live balance comparison
(e.g., manual wallets without API, counterparty wallets).

Revision ID: 055_add_live_balance_eligible
Revises: 054_cleanup_fees_convention
Create Date: 2026-03-10
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "055_add_live_balance_eligible"
down_revision: Union[str, Sequence[str], None] = "054_cleanup_fees_convention"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "accounts",
        sa.Column(
            "live_balance_eligible",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )


def downgrade() -> None:
    op.drop_column("accounts", "live_balance_eligible")
