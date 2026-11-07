"""add spam token rules

Revision ID: 066_add_spam_token_rules
Revises: 065_active_sync_job_guard
Create Date: 2026-11-07

"""

import sqlalchemy as sa
from alembic import op


revision = "066_add_spam_token_rules"
down_revision = "065_active_sync_job_guard"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "spam_token_rules",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("network", sa.String(), nullable=False),
        sa.Column("contract_address", sa.String(), nullable=False),
        sa.Column("verdict", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("network", "contract_address", name="uq_spam_token_rule"),
    )


def downgrade():
    op.drop_table("spam_token_rules")
