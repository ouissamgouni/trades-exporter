"""Add color column to accounts and account_connectors.

Stores a Chakra UI color palette name (e.g. 'purple', 'blue', 'green')
for badge display in the frontend.

Revision ID: 046_add_color_to_accounts_and_connectors
Revises: 045_add_network_to_raw_account
Create Date: 2025-07-23

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '046_add_color'
down_revision: Union[str, Sequence[str], None] = '045_add_network_to_raw_account'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _column_exists(table: str, column: str) -> bool:
    conn = op.get_bind()
    result = conn.execute(
        sa.text(
            "SELECT EXISTS ("
            "  SELECT 1 FROM information_schema.columns "
            "  WHERE table_name = :table AND column_name = :column"
            ")"
        ),
        {"table": table, "column": column},
    )
    return result.scalar()


def upgrade() -> None:
    if not _column_exists("accounts", "color"):
        op.add_column("accounts", sa.Column("color", sa.String(), nullable=True))

    if not _column_exists("account_connectors", "color"):
        op.add_column("account_connectors", sa.Column("color", sa.String(), nullable=True))


def downgrade() -> None:
    if _column_exists("account_connectors", "color"):
        op.drop_column("account_connectors", "color")

    if _column_exists("accounts", "color"):
        op.drop_column("accounts", "color")
