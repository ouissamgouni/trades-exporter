"""Drop tax_jurisdiction columns from app_settings and calculation_versions.

Tax computation is now decoupled from PnL — triggered on-demand via
POST /pnl/versions/{id}/compute-tax instead of being embedded in the
PnL engine config.

Revision ID: 1775066506
Revises: 1775066505
Create Date: 2026-04-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "1775066506"
down_revision: Union[str, None] = "1775066505"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Drop pnl_tax_jurisdiction from app_settings
    op.drop_column("app_settings", "pnl_tax_jurisdiction")
    # Drop tax_jurisdiction from calculation_versions
    op.drop_column("calculation_versions", "tax_jurisdiction")


def downgrade() -> None:
    # Re-add tax_jurisdiction to calculation_versions
    op.add_column(
        "calculation_versions",
        sa.Column("tax_jurisdiction", sa.String(), nullable=True, server_default="standard"),
    )
    # Re-add pnl_tax_jurisdiction to app_settings
    op.add_column(
        "app_settings",
        sa.Column("pnl_tax_jurisdiction", sa.String(), nullable=False, server_default="standard"),
    )
