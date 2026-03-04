"""Add dismissed_suggestions table for persisting suggestion dismissals.

Dismissed suggestions are identified by a fingerprint (hash of pattern + sorted tx IDs).
This allows users to dismiss a specific suggestion without affecting individual transactions.

Revision ID: 051_add_dismissed_suggestions
Revises: 050_polymarket_transfer_to_trade
Create Date: 2026-03-04
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "051_add_dismissed_suggestions"
down_revision: Union[str, Sequence[str], None] = "050_polymarket_transfer_to_trade"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "dismissed_suggestions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("fingerprint", sa.String(), nullable=False, unique=True, index=True),
        sa.Column("pattern", sa.String(), nullable=True),
        sa.Column("transaction_ids", sa.JSON(), nullable=True),
        sa.Column("label", sa.String(), nullable=True),
        sa.Column("reason", sa.String(), nullable=True),
        sa.Column(
            "dismissed_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_table("dismissed_suggestions")
