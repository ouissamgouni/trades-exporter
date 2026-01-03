"""drop_groups_tables

Revision ID: 004_drop_groups_tables
Revises: 003_add_v2_architecture_fields
Create Date: 2024-12-23

Drop deprecated groups and group_members tables.
Data has been migrated to bundles via migrate_groups_to_bundles.py script.

IMPORTANT: Run `python scripts/migrate_groups_to_bundles.py --apply` before this migration!
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import TIMESTAMP, JSON


# revision identifiers, used by Alembic.
revision: str = "004_drop_groups_tables"
down_revision: Union[str, None] = "003_add_v2_architecture_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Drop groups and group_members tables."""

    # 1. Remove group_id foreign key from normalized_transactions
    op.drop_constraint(
        "normalized_transactions_group_id_fkey",
        "normalized_transactions",
        type_="foreignkey",
    )
    op.drop_column("normalized_transactions", "group_id")

    # 2. Remove origin_group_id foreign key from cost_lots
    op.drop_constraint(
        "cost_lots_origin_group_id_fkey",
        "cost_lots",
        type_="foreignkey",
    )
    op.drop_column("cost_lots", "origin_group_id")

    # 3. Remove group_id foreign key from realized_pnl
    op.drop_constraint(
        "realized_pnl_group_id_fkey",
        "realized_pnl",
        type_="foreignkey",
    )
    op.drop_column("realized_pnl", "group_id")

    # 4. Drop group_members junction table
    op.drop_table("group_members")

    # 5. Drop groups table
    op.drop_table("groups")


def downgrade() -> None:
    """Recreate groups and group_members tables."""

    # 1. Recreate groups table
    op.create_table(
        "groups",
        sa.Column("group_id", sa.Integer(), primary_key=True),
        sa.Column("group_label", sa.String(length=255), nullable=True),
        sa.Column("group_type", sa.String(length=50), nullable=True),
        sa.Column("transaction_ids", JSON, nullable=True),
        sa.Column(
            "created_at",
            TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
    )

    # 2. Recreate group_members junction table
    op.create_table(
        "group_members",
        sa.Column(
            "group_id", sa.Integer(), sa.ForeignKey("groups.group_id"), primary_key=True
        ),
        sa.Column(
            "normalized_tx_id",
            sa.Integer(),
            sa.ForeignKey("normalized_transactions.id"),
            primary_key=True,
        ),
    )

    # 3. Re-add group_id to realized_pnl
    op.add_column(
        "realized_pnl",
        sa.Column(
            "group_id", sa.Integer(), sa.ForeignKey("groups.group_id"), nullable=True
        ),
    )

    # 4. Re-add origin_group_id to cost_lots
    op.add_column(
        "cost_lots",
        sa.Column(
            "origin_group_id",
            sa.Integer(),
            sa.ForeignKey("groups.group_id"),
            nullable=True,
        ),
    )

    # 5. Re-add group_id to normalized_transactions
    op.add_column(
        "normalized_transactions",
        sa.Column(
            "group_id", sa.Integer(), sa.ForeignKey("groups.group_id"), nullable=True
        ),
    )
