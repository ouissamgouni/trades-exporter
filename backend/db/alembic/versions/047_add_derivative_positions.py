"""Add derivative_positions table for tracking perp position lifecycle.

Revision ID: 047_add_derivative_positions
Revises: 0f0a377e5588
Create Date: 2026-03-01

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


# revision identifiers, used by Alembic.
revision: str = "047_add_derivative_positions"
down_revision: Union[str, Sequence[str], None] = "0f0a377e5588"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "derivative_positions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("account_id", sa.Integer(), sa.ForeignKey("accounts.id"), nullable=False),
        sa.Column("exchange", sa.String(), nullable=False),
        sa.Column("coin", sa.String(), nullable=False),
        sa.Column("side", sa.String(), nullable=False, server_default="long"),
        sa.Column("status", sa.String(), nullable=False, server_default="open"),
        sa.Column("entry_price", sa.Numeric(36, 18), nullable=False, server_default="0"),
        sa.Column("exit_price", sa.Numeric(36, 18), nullable=True),
        sa.Column("size", sa.Numeric(36, 18), nullable=False, server_default="0"),
        sa.Column("remaining_size", sa.Numeric(36, 18), nullable=False, server_default="0"),
        sa.Column("margin_currency", sa.String(), nullable=False, server_default="USDC"),
        sa.Column("realized_pnl", sa.Numeric(36, 18), nullable=False, server_default="0"),
        sa.Column("total_fees", sa.Numeric(36, 18), nullable=False, server_default="0"),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "open_transaction_id",
            sa.Integer(),
            sa.ForeignKey("normalized_transactions.id"),
            nullable=True,
        ),
        sa.Column("close_transaction_ids", JSONB, server_default="[]"),
    )

    # Composite index for position lookups: find open position for a given account + coin
    op.create_index(
        "ix_derivative_positions_account_coin_status",
        "derivative_positions",
        ["account_id", "coin", "status"],
    )
    op.create_index(
        "ix_derivative_positions_exchange",
        "derivative_positions",
        ["exchange"],
    )
    op.create_index(
        "ix_derivative_positions_status",
        "derivative_positions",
        ["status"],
    )


def downgrade() -> None:
    op.drop_index("ix_derivative_positions_status")
    op.drop_index("ix_derivative_positions_exchange")
    op.drop_index("ix_derivative_positions_account_coin_status")
    op.drop_table("derivative_positions")
