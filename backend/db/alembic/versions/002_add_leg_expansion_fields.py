"""add_leg_expansion_fields

Revision ID: 002_add_leg_expansion_fields
Revises: 001_add_asset_price_getters
Create Date: 2024-12-23

Add fields for leg expansion:
- parent_transaction_id: FK to parent transaction for expanded legs
- leg_type: Type of leg (cost, proceeds, acquired, disposed, fee)
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "002_add_leg_expansion_fields"
down_revision: Union[str, None] = "001_add_asset_price_getters"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add leg expansion fields to normalized_transactions."""
    # Add parent_transaction_id column with FK to self
    op.add_column(
        "normalized_transactions",
        sa.Column("parent_transaction_id", sa.Integer(), nullable=True),
    )

    # Add leg_type column
    op.add_column(
        "normalized_transactions",
        sa.Column("leg_type", sa.String(length=20), nullable=True),
    )

    # Add foreign key constraint
    op.create_foreign_key(
        "fk_normalized_tx_parent",
        "normalized_transactions",
        "normalized_transactions",
        ["parent_transaction_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # Add index for faster lookups of child legs
    op.create_index(
        "idx_normalized_tx_parent_id",
        "normalized_transactions",
        ["parent_transaction_id"],
    )

    # Add index for leg_type filtering
    op.create_index(
        "idx_normalized_tx_leg_type",
        "normalized_transactions",
        ["leg_type"],
    )


def downgrade() -> None:
    """Remove leg expansion fields."""
    op.drop_index("idx_normalized_tx_leg_type", table_name="normalized_transactions")
    op.drop_index("idx_normalized_tx_parent_id", table_name="normalized_transactions")
    op.drop_constraint(
        "fk_normalized_tx_parent", "normalized_transactions", type_="foreignkey"
    )
    op.drop_column("normalized_transactions", "leg_type")
    op.drop_column("normalized_transactions", "parent_transaction_id")
