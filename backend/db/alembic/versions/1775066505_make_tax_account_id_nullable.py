"""Make account_id nullable on French tax tables.

Account_id cannot be required when a calculation spans all accounts
(version.account_ids is NULL).

Revision ID: 1775066505
Revises: 1775066504
Create Date: 2026-04-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '1775066505'
down_revision: Union[str, Sequence[str], None] = '1775066504'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    tables = [
        "french_crypto_tax_entries",
        "french_crypto_tax_annual_summaries",
        "french_securities_tax_entries",
        "french_securities_tax_annual_summaries",
    ]
    inspector = sa.inspect(op.get_bind())
    existing_tables = inspector.get_table_names()
    for table in tables:
        if table in existing_tables:
            op.alter_column(table, "account_id", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    tables = [
        "french_crypto_tax_entries",
        "french_crypto_tax_annual_summaries",
        "french_securities_tax_entries",
        "french_securities_tax_annual_summaries",
    ]
    for table in tables:
        op.alter_column(table, "account_id", existing_type=sa.Integer(), nullable=False)
