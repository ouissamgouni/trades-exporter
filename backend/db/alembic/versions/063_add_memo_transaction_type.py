"""Add 'memo' value to transactiontype enum.

Revision ID: 063_add_memo_tx_type
Revises: 062_add_income_tracking
Create Date: 2026-04-13

Memo is an audit-only record (e.g. Polymarket REDEEM cash settlement)
with no PnL impact and no cost lot changes.
"""
from alembic import op
import sqlalchemy as sa


revision = '063_add_memo_tx_type'
down_revision = '062_add_income_tracking'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Skip if column uses varchar instead of a PG enum.
    conn = op.get_bind()
    has_enum = conn.execute(
        sa.text("SELECT 1 FROM pg_type WHERE typname = 'transactiontype'")
    ).scalar()
    if has_enum:
        op.execute("ALTER TYPE transactiontype ADD VALUE IF NOT EXISTS 'memo'")


def downgrade() -> None:
    # PostgreSQL doesn't support removing enum values.
    # Reclassify any memo transactions as cost (closest semantic match).
    op.execute("""
        UPDATE normalized_transactions
        SET transaction_type = 'cost'
        WHERE transaction_type = 'memo'
    """)
