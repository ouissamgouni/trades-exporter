"""Add full P&L config columns to calculation_versions.

Stores crypto_swap_taxable, fee_taxable, use_price_fallback, and
price_staleness_window_days on each version for reproducibility and
display in calculation history.

Revision ID: 057_add_full_config_to_versions
Revises: 056_add_compute_residuals
Create Date: 2026-03-11
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "057_add_full_config_to_versions"
down_revision: Union[str, Sequence[str], None] = "056_add_compute_residuals"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add config columns to calculation_versions."""
    op.add_column(
        "calculation_versions",
        sa.Column("crypto_swap_taxable", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.add_column(
        "calculation_versions",
        sa.Column("fee_taxable", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.add_column(
        "calculation_versions",
        sa.Column("use_price_fallback", sa.Boolean(), nullable=False, server_default=sa.text("true")),
    )
    op.add_column(
        "calculation_versions",
        sa.Column("price_staleness_window_days", sa.Integer(), nullable=False, server_default=sa.text("7")),
    )


def downgrade() -> None:
    """Remove config columns from calculation_versions."""
    op.drop_column("calculation_versions", "price_staleness_window_days")
    op.drop_column("calculation_versions", "use_price_fallback")
    op.drop_column("calculation_versions", "fee_taxable")
    op.drop_column("calculation_versions", "crypto_swap_taxable")
