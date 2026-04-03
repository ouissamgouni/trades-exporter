"""Add fr_tax_override to realized_pnl.

Adds a nullable column for French tax jurisdiction override.
NULL = use computed disposal_taxable, "taxable"/"non_taxable" = user override.

Revision ID: 1775066510
Revises: 1775066509
Create Date: 2026-04-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "1775066510"
down_revision: Union[str, None] = "1775066509"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "realized_pnl",
        sa.Column("fr_tax_override", sa.String(), nullable=True),
    )
    op.create_index("ix_realized_pnl_fr_tax_override", "realized_pnl", ["fr_tax_override"])


def downgrade() -> None:
    op.drop_index("ix_realized_pnl_fr_tax_override", table_name="realized_pnl")
    op.drop_column("realized_pnl", "fr_tax_override")
