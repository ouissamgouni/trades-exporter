"""Add connector_id to derivative_positions for first-class connector scoping.

Allows derivative positions to be directly associated with the connector that
produced them, enabling simple cleanup (DELETE WHERE connector_id IN :ids)
and scoped resyncs.

Revision ID: 048_add_connector_id_to_dp
Revises: 047_add_derivative_positions
Create Date: 2026-03-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "048_add_connector_id_to_dp"
down_revision: Union[str, Sequence[str], None] = "047_add_derivative_positions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add nullable connector_id column with FK
    op.add_column(
        "derivative_positions",
        sa.Column(
            "connector_id",
            sa.Integer(),
            sa.ForeignKey("account_connectors.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    # Backfill from the opening transaction's connector_id
    op.execute(
        """
        UPDATE derivative_positions dp
        SET connector_id = nt.connector_id
        FROM normalized_transactions nt
        WHERE dp.open_transaction_id = nt.id
          AND dp.connector_id IS NULL
        """
    )

    # Index for cleanup/query performance
    op.create_index(
        "ix_derivative_positions_connector_id",
        "derivative_positions",
        ["connector_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_derivative_positions_connector_id")
    op.drop_column("derivative_positions", "connector_id")
