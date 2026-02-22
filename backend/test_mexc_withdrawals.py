#!/usr/bin/env python3
"""Test script for MEXC withdrawals file connector."""

from backend.connectors.cex.connector_mexc_withdrawals_file import MEXCWithdrawalsFileConnector
import sys

file_path = 'backend/data/input/mexc/new/mexc Withdrawal History-20250130-20260129_1769773652032.xlsx'
print(f'Testing connector with file: {file_path}')

try:
    # Create connector with file config
    connector = MEXCWithdrawalsFileConnector(
        account_id=1,
        connector_id=1,
        config={'file_path': file_path}
    )
    
    # Get first raw item
    raw_items = list(connector.yield_raws())
    print(f'\n✅ Got {len(raw_items)} raw items')
    
    if raw_items:
        # Test normalization
        first_item = raw_items[0]
        normalized = connector.raw_to_normalized(first_item)
        
        print(f'\n📝 First normalized transaction:')
        print(f'  Direction: {normalized.direction}')
        print(f'  Type: {normalized.transaction_type}')
        print(f'  Source Type: {normalized.source_transaction_type}')
        print(f'  Asset: {normalized.source_asset_symbol}')
        print(f'  Amount: {normalized.quantity}')
        print(f'  Fee: {normalized.fee}')
        print(f'  To Address: {normalized.source_to_account}')
        print(f'  Network: {normalized.network}')
        print(f'  TxID: {normalized.source_transaction_id}')
        print(f'  Blockchain Hash: {normalized.network_transaction_id}')
        print(f'  DateTime: {normalized.date_time}')
        
        # Verify key fields
        assert normalized.direction == 'outflow', 'Direction should be outflow'
        assert normalized.source_transaction_type == 'withdrawal', 'Source type should be withdrawal'
        assert normalized.transaction_type == 'transfer', 'Type should be transfer'
        assert normalized.source == 'mexc-withdrawals-file', 'Source should be mexc-withdrawals-file'
        
        print(f'\n✅ All assertions passed!')
        
except Exception as e:
    print(f'\n❌ Error: {e}')
    import traceback
    traceback.print_exc()
    sys.exit(1)
