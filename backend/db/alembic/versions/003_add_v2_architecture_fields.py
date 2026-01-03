"""add_v2_architecture_fields

Revision ID: 003_add_v2_architecture_fields
Revises: 002_add_leg_expansion_fields
Create Date: 2024-12-23

Architecture V2 changes:
- Add 'status' column to transactions (pending/reviewed/excluded)
- Add 'taxability' column to transactions (taxable/non_taxable/unknown)
- Create 'bundles' table for user-created multi-transaction groupings
- Add 'bundle_id' FK to transactions
- Keep groups table for backwards compatibility (can archive later)
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import TIMESTAMP


# revision identifiers, used by Alembic.
revision: str = "003_add_v2_architecture_fields"
down_revision: Union[str, None] = "002_add_leg_expansion_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add v2 architecture fields."""

    # 1. Add status column to normalized_transactions
    # Values: 'pending', 'reviewed', 'excluded'
    op.add_column(
        "normalized_transactions",
        sa.Column(
            "status", sa.String(length=20), nullable=False, server_default="pending"
        ),
    )
    op.create_index(
        "idx_normalized_tx_status",
        "normalized_transactions",
        ["status"],
    )

    # 2. Add taxability column to normalized_transactions
    # Values: 'taxable', 'non_taxable', 'unknown'
    op.add_column(
        "normalized_transactions",
        sa.Column(
            "taxability", sa.String(length=20), nullable=False, server_default="unknown"
        ),
    )
    op.create_index(
        "idx_normalized_tx_taxability",
        "normalized_transactions",
        ["taxability"],
    )

    # 3. Create bundles table
    op.create_table(
        "bundles",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("label", sa.String(length=255), nullable=True),
        sa.Column(
            "pattern",
            sa.String(length=50),
            nullable=True,
            comment="Pattern type: transfer, swap, bridge, review, custom",
        ),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "taxability_override",
            sa.String(length=20),
            nullable=True,
            comment="Override taxability for all transactions in bundle",
        ),
        sa.Column(
            "created_at",
            TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
    )

    # 4. Add bundle_id FK to normalized_transactions
    op.add_column(
        "normalized_transactions",
        sa.Column("bundle_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_normalized_tx_bundle",
        "normalized_transactions",
        "bundles",
        ["bundle_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "idx_normalized_tx_bundle_id",
        "normalized_transactions",
        ["bundle_id"],
    )


def downgrade() -> None:
    """Remove v2 architecture fields."""
    # Remove bundle_id from transactions
    op.drop_index("idx_normalized_tx_bundle_id", table_name="normalized_transactions")
    op.drop_constraint(
        "fk_normalized_tx_bundle", "normalized_transactions", type_="foreignkey"
    )
    op.drop_column("normalized_transactions", "bundle_id")

    # Drop bundles table
    op.drop_table("bundles")

    # Remove taxability column
    op.drop_index("idx_normalized_tx_taxability", table_name="normalized_transactions")
    op.drop_column("normalized_transactions", "taxability")

    # Remove status column
    op.drop_index("idx_normalized_tx_status", table_name="normalized_transactions")
    op.drop_column("normalized_transactions", "status")
