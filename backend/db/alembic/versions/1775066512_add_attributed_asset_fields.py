"""Add attributed asset fields to NT and RealizedPnl, drop related_asset_symbol.

Adds source_attributed_asset_symbol + attributed_asset_id to normalized_transactions,
attributed_asset_id to realized_pnl.  Backfills from tags[0].coin (NT) and
related_asset_symbol (RealizedPnl), then drops related_asset_symbol.

Revision ID: 1775066512
Revises: 1775066511
Create Date: 2026-04-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "1775066512"
down_revision: Union[str, None] = "1775066511"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- NormalizedTransaction ---
    op.add_column(
        "normalized_transactions",
        sa.Column("source_attributed_asset_symbol", sa.String(), nullable=True),
    )
    op.add_column(
        "normalized_transactions",
        sa.Column("attributed_asset_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_nt_attributed_asset",
        "normalized_transactions",
        "assets",
        ["attributed_asset_id"],
        ["asset_id"],
    )

    # --- RealizedPnl ---
    op.add_column(
        "realized_pnl",
        sa.Column("attributed_asset_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_realized_pnl_attributed_asset_id",
        "realized_pnl",
        ["attributed_asset_id"],
    )
    op.create_foreign_key(
        "fk_rpnl_attributed_asset",
        "realized_pnl",
        "assets",
        ["attributed_asset_id"],
        ["asset_id"],
    )

    # --- Backfill NT: extract coin from tags[0] for derivative transactions ---
    op.execute("""
        UPDATE normalized_transactions
        SET source_attributed_asset_symbol = tags->0->>'coin'
        WHERE tags IS NOT NULL
          AND jsonb_typeof(tags) = 'array'
          AND (tags->0->>'coin') IS NOT NULL
          AND source_attributed_asset_symbol IS NULL
    """)

    # --- Backfill NT attributed_asset_id: resolve via assets table ---
    op.execute("""
        UPDATE normalized_transactions nt
        SET attributed_asset_id = a.asset_id
        FROM assets a
        WHERE nt.source_attributed_asset_symbol IS NOT NULL
          AND nt.attributed_asset_id IS NULL
          AND LOWER(a.symbol) = LOWER(nt.source_attributed_asset_symbol)
    """)

    # --- Backfill RealizedPnl: resolve related_asset_symbol via assets table ---
    op.execute("""
        UPDATE realized_pnl rp
        SET attributed_asset_id = a.asset_id
        FROM assets a
        WHERE rp.related_asset_symbol IS NOT NULL
          AND rp.attributed_asset_id IS NULL
          AND LOWER(a.symbol) = LOWER(rp.related_asset_symbol)
    """)

    # --- Drop related_asset_symbol ---
    op.drop_index("ix_realized_pnl_related_asset_symbol", table_name="realized_pnl")
    op.drop_column("realized_pnl", "related_asset_symbol")


def downgrade() -> None:
    # Re-add related_asset_symbol
    op.add_column(
        "realized_pnl",
        sa.Column("related_asset_symbol", sa.String(), nullable=True),
    )
    op.create_index(
        "ix_realized_pnl_related_asset_symbol",
        "realized_pnl",
        ["related_asset_symbol"],
    )

    # Backfill related_asset_symbol from attributed_asset
    op.execute("""
        UPDATE realized_pnl rp
        SET related_asset_symbol = a.symbol
        FROM assets a
        WHERE rp.attributed_asset_id IS NOT NULL
          AND a.asset_id = rp.attributed_asset_id
    """)

    # Drop new columns
    op.drop_constraint("fk_rpnl_attributed_asset", "realized_pnl", type_="foreignkey")
    op.drop_index("ix_realized_pnl_attributed_asset_id", table_name="realized_pnl")
    op.drop_column("realized_pnl", "attributed_asset_id")
    op.drop_constraint("fk_nt_attributed_asset", "normalized_transactions", type_="foreignkey")
    op.drop_column("normalized_transactions", "attributed_asset_id")
    op.drop_column("normalized_transactions", "source_attributed_asset_symbol")
