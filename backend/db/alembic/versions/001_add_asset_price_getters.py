"""add_asset_price_getters_table

Revision ID: 001
Revises:
Create Date: 2024-12-10

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "001_add_asset_price_getters"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add asset_price_getters table for multi-getter support."""
    op.create_table(
        "asset_price_getters",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("asset_id", sa.Integer(), nullable=False),
        sa.Column("price_getter", sa.String(length=50), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("params", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.asset_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("asset_id", "price_getter", name="uq_asset_price_getter"),
    )
    op.create_index(
        "idx_asset_price_getters_asset_id", "asset_price_getters", ["asset_id"]
    )
    op.create_index(
        "idx_asset_price_getters_priority", "asset_price_getters", ["priority"]
    )
    op.create_index(
        "idx_asset_price_getters_enabled", "asset_price_getters", ["enabled"]
    )


def downgrade() -> None:
    """Remove asset_price_getters table."""
    op.drop_index("idx_asset_price_getters_enabled", "asset_price_getters")
    op.drop_index("idx_asset_price_getters_priority", "asset_price_getters")
    op.drop_index("idx_asset_price_getters_asset_id", "asset_price_getters")
    op.drop_table("asset_price_getters")
