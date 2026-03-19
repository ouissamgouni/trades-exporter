"""Add cost_source and FMV metadata columns to cost_lots.

Tracks provenance of each lot's cost basis (fmv, proceeds, inherited,
provisional, base_currency) and stores the FMV price metadata used when
cost_source is fmv or provisional.

Revision ID: 058_add_cost_source_and_fmv_metadata
Revises: 057_add_full_config_to_versions
Create Date: 2026-03-12
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "058_add_cost_source_fmv_meta"
down_revision: Union[str, Sequence[str], None] = "057_add_full_config_to_versions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add cost provenance and FMV metadata columns to cost_lots."""
    op.add_column(
        "cost_lots",
        sa.Column("cost_source", sa.String(), nullable=True),
    )
    op.add_column(
        "cost_lots",
        sa.Column("cost_fmv_price", sa.Numeric(36, 18), nullable=True),
    )
    op.add_column(
        "cost_lots",
        sa.Column("cost_fmv_source", sa.String(), nullable=True),
    )
    op.add_column(
        "cost_lots",
        sa.Column("cost_fmv_timestamp", sa.DateTime(), nullable=True),
    )
    op.add_column(
        "cost_lots",
        sa.Column("cost_fmv_stale", sa.Boolean(), nullable=True),
    )


def downgrade() -> None:
    """Remove cost provenance columns from cost_lots."""
    op.drop_column("cost_lots", "cost_fmv_stale")
    op.drop_column("cost_lots", "cost_fmv_timestamp")
    op.drop_column("cost_lots", "cost_fmv_source")
    op.drop_column("cost_lots", "cost_fmv_price")
    op.drop_column("cost_lots", "cost_source")
