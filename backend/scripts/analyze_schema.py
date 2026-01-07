"""Script to analyze database schema vs model definitions."""
from dotenv import load_dotenv
load_dotenv()
import os
from sqlalchemy import create_engine, inspect

db_url = f'postgresql://{os.getenv("POSTGRES_USER")}:{os.getenv("POSTGRES_PASSWORD")}@{os.getenv("POSTGRES_HOST")}:{os.getenv("POSTGRES_PORT")}/{os.getenv("POSTGRES_DB")}'
engine = create_engine(db_url)
inspector = inspect(engine)

# Get DB tables and columns
db_tables = {}
for table in inspector.get_table_names():
    columns = inspector.get_columns(table)
    db_tables[table] = {col['name'] for col in columns}

# Define model tables and their columns from models.py
model_tables = {
    'app_settings': {'id', 'base_currency', 'created_at', 'updated_at'},
    'accounts': {'id', 'name', 'account_type', 'address_or_identifier', 'tags', 'owned', 'created_at'},
    'account_connectors': {'id', 'account_id', 'connector_type', 'enabled', 'config', 'credentials_ref', 'sync_priority', 'last_sync_at', 'last_sync_status', 'last_error', 'created_at', 'updated_at'},
    'assets': {'asset_id', 'symbol', 'label', 'price_type', 'tags', 'created_at', 'status'},
    'asset_price_getters': {'id', 'asset_id', 'price_getter', 'external_id', 'priority', 'enabled', 'params', 'created_at', 'updated_at'},
    'price_snapshots': {'snapshot_id', 'asset_id', 'quote_asset_id', 'price', 'source', 'snapshot_time', 'created_at'},
    'raw_assets': {'id', 'symbol', 'source', 'asset_id'},
    'dimensions': {'id', 'label', 'ordinal', 'created_at'},
    'categories': {'id', 'dimension_id', 'label', 'color', 'ordinal', 'created_at'},
    'asset_categories': {'asset_id', 'category_id', 'created_at'},
    'raw_transactions': {'id', 'source', 'source_transaction_id', 'raw_data', 'ingestion_time'},
    'normalized_transactions': {'id', 'raw_transaction_id', 'source', 'source_asset_symbol', 'source_transaction_type', 'source_transaction_id', 
        'account_id', 'date_time', 'direction', 'transaction_type', 'asset_id', 'quantity', 'price', 'price_snapshot_id', 
        'source_price_quote_asset_symbol', 'price_quote_asset_id', 'fee', 'source_fee_quote_asset_symbol', 'fee_quote_asset_id', 
        'include_fee', 'disposal_taxable', 'from_account_id', 'to_account_id', 'source_from_account', 'source_to_account', 
        'network', 'network_transaction_id', 'token_contract_address', 'tags', 'synced_at', 'review_status', 'taxability_status',
        'user_calculation_unit_id', 'total', 'review_notes', 'created_at', 'updated_at'},
    'raw_accounts': {'id', 'source', 'label', 'account_id', 'created_at'},
    'bundles': {'id', 'label', 'pattern', 'notes', 'taxability_override', 'confidence', 'reason', 'created_at', 'updated_at'},
    'calculation_versions': {'version_id', 'description', 'created_at', 'expires_at', 'method', 'lot_mode', 'base_currency_id', 
        'allow_negative_balances', 'residual_tolerance_pct', 'status', 'account_ids'},
    'cost_lots': {'cost_lot_id', 'asset_id', 'account_id', 'qty', 'qty_remaining', 'unit_cost_in_base', 'acquired_at', 
        'origin_transaction_id', 'unit_id', 'notes', 'is_negative', 'is_zero_cost', 'is_settled', 'settled_by_lot_id',
        'settled_cost_in_base', 'origin_pnl_id', 'created_at'},
    'consumed_lot_slices': {'slice_id', 'pnl_id', 'cost_lot_id', 'consumed_by_leg_id', 'quantity', 'unit_cost_in_base', 
        'total_cost_in_base', 'created_at', 'consumed_at'},
    'realized_pnl': {'pnl_id', 'asset_id', 'qty', 'proceeds_in_base', 'cost_basis_in_base', 'pnl_in_base', 'disposal_taxable',
        'transaction_id', 'origin_unit_id', 'realized_at', 'holding_period_days', 'notes', 'proceeds_source', 'proceeds_price',
        'proceeds_price_source', 'proceeds_price_timestamp'},
    'fee_entries': {'id', 'fee_leg_id', 'realized_pnl_id', 'unit_id', 'version_id', 'related_asset_id', 'fee_value_in_base', 'created_at'},
    'calculation_unit_legs': {'id', 'unit_id', 'transaction_id', 'asset_id', 'leg_type', 'quantity', 'disposal_taxable', 'created_at'},
    'calculation_units': {'id', 'version_id', 'unit_origin', 'unit_label', 'pattern', 'timestamp', 'created_at'},
    'lot_settlements': {'settlement_id', 'negative_lot_id', 'settling_lot_id', 'settling_transaction_id', 'qty_settled', 
        'cost_basis_applied', 'settled_at', 'created_at'},
    'pnl_warnings': {'id', 'warning_type', 'message', 'transaction_id', 'unit_id', 'asset_id', 'details', 'created_at'},
    'cost_lot_events': {'event_id', 'event_type', 'lot_id', 'related_lot_id', 'quantity_delta', 'cost_basis_delta', 
        'qty_remaining_after', 'cost_basis_remaining_after', 'triggered_by_transaction_id', 'triggered_by_unit_id', 
        'timestamp', 'sequence_num', 'event_metadata', 'created_at'},
    'alembic_version': {'version_num'},  # Internal alembic table
}

# Analyze differences and write to file
with open('scripts/schema_analysis.txt', 'w') as f:
    f.write('=== UNUSED TABLES (in DB but not in models) ===\n')
    unused_tables = set(db_tables.keys()) - set(model_tables.keys())
    for t in sorted(unused_tables):
        f.write(f'  {t}\n')

    f.write('\n=== UNUSED COLUMNS PER TABLE ===\n')
    for table in sorted(set(db_tables.keys()) & set(model_tables.keys())):
        db_cols = db_tables[table]
        model_cols = model_tables[table]
        unused_cols = db_cols - model_cols
        if unused_cols:
            f.write(f'\n{table}:\n')
            for col in sorted(unused_cols):
                f.write(f'  {col}\n')

print('Done. Results in scripts/schema_analysis.txt')
