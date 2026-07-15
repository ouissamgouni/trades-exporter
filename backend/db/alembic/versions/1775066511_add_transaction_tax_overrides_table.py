"""Add transaction_tax_overrides table and drop fr_tax_override.

Creates a durable TransactionTaxOverride table (PK: transaction_id, jurisdiction)
so that user overrides survive PnL recalculations.  Backfills from the old
fr_tax_override column on realized_pnl, then drops that column.

Revision ID: 1775066511
Revises: 1775066510
Create Date: 2026-04-03

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "1775066511"
down_revision: Union[str, None] = "1775066510"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Create the new override table
    op.create_table(
        "transaction_tax_overrides",
        sa.Column("transaction_id", sa.Integer(), sa.ForeignKey("normalized_transactions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("jurisdiction", sa.String(length=10), nullable=False),
        sa.Column("is_taxable", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("transaction_id", "jurisdiction"),
    )

    # 2. Backfill from fr_tax_override on realized_pnl
    #    For each distinct transaction_id with an override, insert into the new table.
    #    Use the most recent override value per transaction (in case multiple realized_pnl
    #    rows exist for the same transaction with different overrides, pick any — they should agree).
    op.execute("""
        INSERT INTO transaction_tax_overrides (transaction_id, jurisdiction, is_taxable)
        SELECT DISTINCT ON (transaction_id)
            transaction_id,
            'fr',
            CASE WHEN fr_tax_override = 'taxable' THEN true ELSE false END
        FROM realized_pnl
        WHERE fr_tax_override IN ('taxable', 'non_taxable')
          AND transaction_id IS NOT NULL
        ORDER BY transaction_id, pnl_id DESC
        ON CONFLICT DO NOTHING
    """)

    # 3. Drop the old column + its index
    op.drop_index("ix_realized_pnl_fr_tax_override", table_name="realized_pnl")
    op.drop_column("realized_pnl", "fr_tax_override")


def downgrade() -> None:
    # Restore fr_tax_override column
    op.add_column(
        "realized_pnl",
        sa.Column("fr_tax_override", sa.String(), nullable=True),
    )
    op.create_index("ix_realized_pnl_fr_tax_override", "realized_pnl", ["fr_tax_override"])

    # Backfill from override table back to realized_pnl
    op.execute("""
        UPDATE realized_pnl r
        SET fr_tax_override = CASE WHEN tto.is_taxable THEN 'taxable' ELSE 'non_taxable' END
        FROM transaction_tax_overrides tto
        WHERE r.transaction_id = tto.transaction_id
          AND tto.jurisdiction = 'fr'
    """)

    # Drop the override table
    op.drop_table("transaction_tax_overrides")
