"""raw assets keyed by token contract (network, contract_address)

Revision ID: 069_raw_asset_contract
Revises: 068_economic_cost_basis
Create Date: 2026-11-10

"""

import sqlalchemy as sa
from alembic import op


revision = "069_raw_asset_contract"
down_revision = "068_economic_cost_basis"
branch_labels = None
depends_on = None

# One row per token contract already seen under a mapped (symbol, source). The mapping is kept
# only when the contract has a non-rejected tx on that asset, so spam reusing a ticker starts unmapped.
_SPLIT_SQL = r"""
WITH c AS (
    SELECT n.source,
           n.source_asset_symbol AS symbol,
           lower(coalesce(n.network, '')) AS network,
           CASE WHEN n.token_contract_address ~ '^0x[0-9a-fA-F]{40}$'
                THEN lower(n.token_contract_address)
                ELSE n.token_contract_address END AS contract,
           bool_or(n.review_status <> 'invalid' AND n.asset_id = r.asset_id) AS keep
    FROM normalized_transactions n
    JOIN raw_assets r
      ON r.symbol = n.source_asset_symbol AND r.source = n.source AND r.contract_address = ''
    WHERE n.token_contract_address IS NOT NULL AND n.token_contract_address <> ''
    GROUP BY 1, 2, 3, 4
)
INSERT INTO raw_assets (symbol, source, network, contract_address, asset_id)
SELECT c.symbol, c.source, c.network, c.contract, CASE WHEN c.keep THEN r.asset_id END
FROM c
JOIN raw_assets r
  ON r.symbol = c.symbol AND r.source = c.source AND r.contract_address = ''
ON CONFLICT ON CONSTRAINT uq_raw_asset DO NOTHING
"""


def upgrade():
    op.add_column(
        "raw_assets",
        sa.Column("network", sa.String(), nullable=False, server_default=""),
    )
    op.add_column(
        "raw_assets",
        sa.Column("contract_address", sa.String(), nullable=False, server_default=""),
    )
    op.drop_constraint("uq_raw_asset", "raw_assets", type_="unique")
    op.create_unique_constraint(
        "uq_raw_asset",
        "raw_assets",
        ["symbol", "source", "network", "contract_address"],
    )
    op.execute(_SPLIT_SQL)


def downgrade():
    op.execute("DELETE FROM raw_assets WHERE contract_address <> ''")
    op.drop_constraint("uq_raw_asset", "raw_assets", type_="unique")
    op.create_unique_constraint("uq_raw_asset", "raw_assets", ["symbol", "source"])
    op.drop_column("raw_assets", "contract_address")
    op.drop_column("raw_assets", "network")
