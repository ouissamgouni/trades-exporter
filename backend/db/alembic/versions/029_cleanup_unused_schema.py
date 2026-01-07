"""cleanup unused db columns and tables

Revision ID: 029_cleanup_unused_schema
Revises: ea875aa4ecfb
Create Date: 2026-01-05

Removes columns and tables that exist in DB but are not used by models.
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text


revision: str = "029_cleanup_unused_schema"
down_revision: Union[str, None] = "ea875aa4ecfb"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def column_exists(table: str, column: str) -> bool:
    """Check if a column exists in a table."""
    conn = op.get_bind()
    result = conn.execute(text(f"""
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = '{table}' AND column_name = '{column}'
    """))
    return result.fetchone() is not None


def table_exists(table: str) -> bool:
    """Check if a table exists."""
    conn = op.get_bind()
    result = conn.execute(text(f"""
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = '{table}'
    """))
    return result.fetchone() is not None


def safe_drop_column(table: str, column: str) -> None:
    """Drop column if it exists."""
    if column_exists(table, column):
        op.drop_column(table, column)


def safe_drop_table(table: str) -> None:
    """Drop table if it exists."""
    if table_exists(table):
        op.drop_table(table)


def upgrade() -> None:
    """Drop unused tables and columns."""
    
    # Drop unused tables
    safe_drop_table("asset_prices")
    safe_drop_table("unrealized_pnl")
    
    # Drop unused columns from assets
    safe_drop_column("assets", "price_getter")
    safe_drop_column("assets", "price_getter_asset_id")
    
    # Drop unused columns from calculation_units
    for col in ["bundle_id", "consumed_slices_detail", "fee_asset_ids", "inflow_asset_ids",
                "is_cost_basis_transfer", "is_disposal_taxable", "lots_consumed_uuids",
                "lots_created_uuids", "outflow_asset_ids", "realized_entries_detail",
                "realized_pnl_in_base", "transaction_ids", "unit_type", "updated_at"]:
        safe_drop_column("calculation_units", col)
    
    # Drop unused columns from calculation_versions
    for col in ["is_active", "lots_consumed", "lots_created", "total_realized_pnl",
                "total_unrealized_pnl", "transaction_count", "units_processed", "warning_count"]:
        safe_drop_column("calculation_versions", col)
    
    # Drop unused columns from categories
    safe_drop_column("categories", "parent_id")
    
    # Drop unused columns from consumed_lot_slices
    safe_drop_column("consumed_lot_slices", "consumed_by_transaction_id")
    safe_drop_column("consumed_lot_slices", "version_id")
    
    # Drop unused columns from cost_lots
    safe_drop_column("cost_lots", "origin_version_id")
    safe_drop_column("cost_lots", "version_id")
    
    # Drop unused columns from normalized_transactions
    safe_drop_column("normalized_transactions", "account")
    safe_drop_column("normalized_transactions", "fee_asset_id")
    safe_drop_column("normalized_transactions", "fee_in_base")
    safe_drop_column("normalized_transactions", "price_in_base")
    safe_drop_column("normalized_transactions", "total_in_base")


def downgrade() -> None:
    """Recreate dropped tables and columns (minimal schema for rollback)."""
    
    # Recreate normalized_transactions columns
    op.add_column("normalized_transactions", sa.Column("total_in_base", sa.Numeric(36, 18)))
    op.add_column("normalized_transactions", sa.Column("price_in_base", sa.Numeric(36, 18)))
    op.add_column("normalized_transactions", sa.Column("fee_in_base", sa.Numeric(36, 18)))
    op.add_column("normalized_transactions", sa.Column("fee_asset_id", sa.Integer))
    op.add_column("normalized_transactions", sa.Column("account", sa.String))
    
    # Recreate cost_lots columns
    op.add_column("cost_lots", sa.Column("version_id", sa.Integer))
    op.add_column("cost_lots", sa.Column("origin_version_id", sa.Integer))
    
    # Recreate consumed_lot_slices columns
    op.add_column("consumed_lot_slices", sa.Column("version_id", sa.Integer))
    op.add_column("consumed_lot_slices", sa.Column("consumed_by_transaction_id", sa.Integer))
    
    # Recreate categories column
    op.add_column("categories", sa.Column("parent_id", sa.Integer))
    
    # Recreate calculation_versions columns
    for col in ["warning_count", "units_processed", "transaction_count", "total_unrealized_pnl",
                "total_realized_pnl", "lots_created", "lots_consumed", "is_active"]:
        op.add_column("calculation_versions", sa.Column(col, sa.Integer if col != "total_unrealized_pnl" and col != "total_realized_pnl" else sa.Numeric(36, 18)))
    
    # Recreate calculation_units columns
    op.add_column("calculation_units", sa.Column("updated_at", sa.DateTime))
    op.add_column("calculation_units", sa.Column("unit_type", sa.String(50)))
    op.add_column("calculation_units", sa.Column("transaction_ids", sa.JSON))
    op.add_column("calculation_units", sa.Column("realized_pnl_in_base", sa.Numeric(30, 18)))
    op.add_column("calculation_units", sa.Column("realized_entries_detail", sa.JSON))
    op.add_column("calculation_units", sa.Column("outflow_asset_ids", sa.JSON))
    op.add_column("calculation_units", sa.Column("lots_created_uuids", sa.JSON))
    op.add_column("calculation_units", sa.Column("lots_consumed_uuids", sa.JSON))
    op.add_column("calculation_units", sa.Column("is_disposal_taxable", sa.Boolean))
    op.add_column("calculation_units", sa.Column("is_cost_basis_transfer", sa.Boolean))
    op.add_column("calculation_units", sa.Column("inflow_asset_ids", sa.JSON))
    op.add_column("calculation_units", sa.Column("fee_asset_ids", sa.JSON))
    op.add_column("calculation_units", sa.Column("consumed_slices_detail", sa.JSON))
    op.add_column("calculation_units", sa.Column("bundle_id", sa.Integer))
    
    # Recreate assets columns
    op.add_column("assets", sa.Column("price_getter_asset_id", sa.String))
    op.add_column("assets", sa.Column("price_getter", sa.String))
    
    # Recreate tables
    op.create_table(
        "unrealized_pnl",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("asset_id", sa.Integer),
        sa.Column("account_id", sa.Integer),
        sa.Column("balance", sa.Numeric(36, 18)),
        sa.Column("cost_basis_in_base", sa.Numeric(36, 18)),
        sa.Column("market_price", sa.Numeric(36, 18)),
        sa.Column("market_value_in_base", sa.Numeric(36, 18)),
        sa.Column("unrealized_pnl_in_base", sa.Numeric(36, 18)),
        sa.Column("version_id", sa.Integer),
        sa.Column("calculated_at", sa.DateTime),
    )
    
    op.create_table(
        "asset_prices",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("asset_id", sa.Integer),
        sa.Column("price_date_time", sa.DateTime),
        sa.Column("price", sa.Numeric(36, 18)),
        sa.Column("price_quote", sa.String),
        sa.Column("source", sa.String),
        sa.Column("created_at", sa.DateTime),
    )
