"""raw assets can be dismissed (ignored) like raw accounts

Revision ID: 070_raw_asset_dismiss
Revises: 069_raw_asset_contract
Create Date: 2026-11-10

"""

import sqlalchemy as sa
from alembic import op


revision = "070_raw_asset_dismiss"
down_revision = "069_raw_asset_contract"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "raw_assets",
        sa.Column("dismissed", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column("raw_assets", sa.Column("dismissed_at", sa.DateTime(), nullable=True))
    op.add_column(
        "raw_assets", sa.Column("dismissed_reason", sa.String(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("raw_assets", "dismissed_reason")
    op.drop_column("raw_assets", "dismissed_at")
    op.drop_column("raw_assets", "dismissed")
