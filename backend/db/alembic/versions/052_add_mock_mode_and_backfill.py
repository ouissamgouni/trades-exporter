"""Add mock_mode_enabled to app_settings and backfill mock getters for all assets.

- Adds mock_mode_enabled boolean column to app_settings (default False)
- Creates a disabled mock price getter row for every existing asset that
  doesn't already have one, with priority=0 and type-based default ranges.

Revision ID: 052_add_mock_mode_and_backfill
Revises: 051_add_dismissed_suggestions
Create Date: 2026-03-05
"""
import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "052_add_mock_mode_and_backfill"
down_revision: Union[str, Sequence[str], None] = "051_add_dismissed_suggestions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Default mock price ranges by asset type
MOCK_RANGES = {
    "crypto": {"min_price": 100.0, "max_price": 50000.0},
    "stock": {"min_price": 10.0, "max_price": 500.0},
    "fiat": {"min_price": 0.5, "max_price": 2.0},
}
DEFAULT_RANGE = {"min_price": 1.0, "max_price": 1000.0}


def upgrade() -> None:
    # 1. Add mock_mode_enabled column to app_settings
    op.add_column(
        "app_settings",
        sa.Column(
            "mock_mode_enabled",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )

    # 2. Backfill mock price getter rows for all existing assets
    conn = op.get_bind()

    # Get all assets that don't already have a mock getter
    assets_without_mock = conn.execute(
        sa.text("""
            SELECT a.asset_id, a.price_type
            FROM assets a
            LEFT JOIN asset_price_getters apg
                ON a.asset_id = apg.asset_id AND apg.price_getter = 'mock'
            WHERE apg.id IS NULL
        """)
    ).fetchall()

    if assets_without_mock:
        for asset_id, price_type in assets_without_mock:
            pt = (price_type or "crypto").lower()
            params = json.dumps(MOCK_RANGES.get(pt, DEFAULT_RANGE))
            conn.execute(
                sa.text("""
                    INSERT INTO asset_price_getters
                        (asset_id, price_getter, priority, enabled, params, created_at, updated_at)
                    VALUES
                        (:asset_id, 'mock', 0, false, :params, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """),
                {"asset_id": asset_id, "params": params},
            )


def downgrade() -> None:
    # Remove all mock getter rows
    op.execute("DELETE FROM asset_price_getters WHERE price_getter = 'mock'")
    # Remove column
    op.drop_column("app_settings", "mock_mode_enabled")
