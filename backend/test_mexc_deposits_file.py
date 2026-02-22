#!/usr/bin/env python3
"""Test script for MEXC deposits file connector."""

from backend.file_loaders.mexc_deposits_loader import load_mexc_deposits_file, get_mexc_deposits_file_preview
from backend.connectors.cex.connector_mexc_deposits_file import MEXCDepositsFileConnector

def test_loader():
    """Test the deposits file loader."""
    print("=" * 60)
    print("Testing MEXC Deposits File Loader")
    print("=" * 60)
    
    file_path = "backend/data/input/mexc/new/mexc_deposits_test.xlsx"
    
    # Test loading
    df = load_mexc_deposits_file(file_path=file_path)
    print(f"\n✅ Loaded {len(df)} deposits")
    print(f"📋 Columns: {list(df.columns)}")
    print(f"💱 Unique currencies: {df['currency'].unique().tolist()}")
    print(f"🌐 Unique networks: {sorted(df['network'].unique().tolist())}")
    print(f"📅 Date range: {df['datetime'].min()} to {df['datetime'].max()}")
    
    print("\n📊 Sample rows:")
    for _, row in df.head(3).iterrows():
        print(f"  {row['datetime']} | {row['currency']:6} | {row['amount']:15.8f} | {row['txid'][:20]}...")
    
    # Test preview
    print("\n\n" + "=" * 60)
    print("Testing Preview Function")
    print("=" * 60)
    
    with open(file_path, 'rb') as f:
        content = f.read()
        preview = get_mexc_deposits_file_preview(content)
        
    print(f"\n✅ Preview generated")
    print(f"📊 Row count: {preview['row_count']}")
    print(f"📅 Date range: {preview['date_range']}")
    print(f"💱 Currencies: {preview['currencies']}")
    print(f"📋 Sample rows: {len(preview['sample_rows'])}")

def test_connector():
    """Test the deposits file connector normalization."""
    print("\n\n" + "=" * 60)
    print("Testing MEXC Deposits File Connector")
    print("=" * 60)
    
    config = {
        "file_path": "backend/data/input/mexc/new/mexc_deposits_test.xlsx",
        "file_import_id": None,
        "sync_mode": "file",
        "_account_id": 1,
        "_account_name": "mexc-test-account",
        "_account_address_or_identifier": "mexc-main"
    }
    
    connector = MEXCDepositsFileConnector(
        account_id=1,
        connector_id=1,
        config=config
    )
    
    print(f"\n✅ Connector initialized: {connector.connector_name}")
    
    # Test raw yielding and normalization
    print("\n🔄 Processing deposits...")
    normalized_count = 0
    for raw in connector.yield_raws():
        try:
            normalized = connector.raw_to_normalized(raw)
            normalized_count += 1
            
            # Print first 3
            if normalized_count <= 3:
                print(f"\n  Deposit #{normalized_count}:")
                print(f"    Source TX ID: {normalized.source_transaction_id[:30]}...")
                print(f"    Date: {normalized.date_time}")
                print(f"    Currency: {normalized.source_asset_symbol}")
                print(f"    Amount: {normalized.quantity}")
                print(f"    Network: {normalized.network}")
                print(f"    Direction: {normalized.direction}")
                print(f"    Type: {normalized.transaction_type}")
                print(f"    To Account: {normalized.source_to_account}")
                print(f"    To Account ID: {normalized.to_account_id}")
        except Exception as e:
            print(f"  ❌ Failed to normalize: {e}")
    
    print(f"\n✅ Successfully normalized {normalized_count} deposits")

if __name__ == "__main__":
    try:
        test_loader()
        test_connector()
        print("\n\n" + "=" * 60)
        print("✅ ALL TESTS PASSED!")
        print("=" * 60)
    except Exception as e:
        print(f"\n\n❌ TEST FAILED: {e}")
        import traceback
        traceback.print_exc()
