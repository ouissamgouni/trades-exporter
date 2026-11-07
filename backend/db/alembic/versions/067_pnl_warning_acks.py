"""add pnl warning acknowledgements

Revision ID: 067_pnl_warning_acks
Revises: 066_add_spam_token_rules
Create Date: 2026-11-07

"""

import sqlalchemy as sa
from alembic import op


revision = "067_pnl_warning_acks"
down_revision = "066_add_spam_token_rules"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "pnl_warning_acks",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("warning_type", sa.String(), nullable=False),
        sa.Column("transaction_id", sa.Integer(), nullable=True),
        sa.Column("asset_id", sa.Integer(), nullable=True),
        sa.Column("fingerprint", sa.String(), nullable=False, server_default=""),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "warning_type", "transaction_id", "asset_id", "fingerprint", name="uq_pnl_warning_ack"
        ),
    )
    op.create_index("ix_pnl_warning_acks_transaction_id", "pnl_warning_acks", ["transaction_id"])


def downgrade():
    op.drop_index("ix_pnl_warning_acks_transaction_id", table_name="pnl_warning_acks")
    op.drop_table("pnl_warning_acks")
