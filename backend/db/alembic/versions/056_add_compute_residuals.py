"""Add compute_residuals to calculation_versions and app_settings.

Stores the compute_residuals config flag per version for reproducibility,
and persists the user's preference in app_settings for refresh calculations.

Revision ID: 056_add_compute_residuals
Revises: 055_add_live_balance_eligible
Create Date: 2026-03-11
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "056_add_compute_residuals"
down_revision: Union[str, Sequence[str], None] = "055_add_live_balance_eligible"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add compute_residuals columns."""
    op.add_column(
        "calculation_versions",
        sa.Column("compute_residuals", sa.Boolean(), nullable=False, server_default=sa.text("true")),
    )
    op.add_column(
        "app_settings",
        sa.Column("pnl_compute_residuals", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )


def downgrade() -> None:
    """Remove compute_residuals columns."""
    op.drop_column("app_settings", "pnl_compute_residuals")
    op.drop_column("calculation_versions", "compute_residuals")
