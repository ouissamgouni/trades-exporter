#!/usr/bin/env python3
"""
Script to import trades from a CSV file.

Usage (from project root):
    backend/.venv/bin/python -m backend.scripts.import_trades_csv backend/data/input/trades.csv [options]

Options:
    --dry-run      Preview changes without committing
    --test         Use test database

Examples:
    # Preview import
    backend/.venv/bin/python -m backend.scripts.import_trades_csv backend/data/input/trades.csv --dry-run
    
    # Import to production database
    backend/.venv/bin/python -m backend.scripts.import_trades_csv backend/data/input/trades.csv
    
    # Import to test database
    backend/.venv/bin/python -m backend.scripts.import_trades_csv backend/data/input/trades.csv --test
"""

import sys
import argparse
from pathlib import Path

from backend.config.loader import set_test_mode, configure_logging
from backend.db.database import get_session
from backend.file_loaders.trades_csv_loader import TradesCSVLoader
from backend.services.trade_import_service import TradeImportService

log = configure_logging("import_trades_csv")


def print_header(text: str):
    """Print a formatted header."""
    print(f"\n{'='*60}")
    print(f"  {text}")
    print(f"{'='*60}")


def print_stats(label: str, stats: dict):
    """Print statistics in a formatted way."""
    print(f"\n📊 {label}:")
    print(f"   Created: {stats.get('created', 0)}")
    print(f"   Skipped: {stats.get('skipped', 0)}")
    if stats.get('errors'):
        print(f"   Errors:  {len(stats['errors'])}")


def main():
    parser = argparse.ArgumentParser(
        description="Import trades from a CSV file",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument(
        "csv_file",
        type=Path,
        help="Path to the CSV file to import"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview changes without committing to database"
    )
    parser.add_argument(
        "--test",
        action="store_true",
        help="Use test database"
    )
    
    args = parser.parse_args()
    
    # Set test mode if requested
    if args.test:
        set_test_mode(True)
        print("🧪 Using TEST database")
    
    # Validate file
    csv_path = args.csv_file
    if not csv_path.exists():
        print(f"❌ File not found: {csv_path}")
        sys.exit(1)
    
    if not csv_path.suffix.lower() == ".csv":
        print(f"❌ File must be a CSV: {csv_path}")
        sys.exit(1)
    
    print_header("TRADES CSV IMPORT")
    print(f"📂 Loading: {csv_path}")
    
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be committed")
    
    # Parse CSV
    loader = TradesCSVLoader()
    load_result = loader.load(csv_path)
    
    # Show parse summary
    stats = load_result.stats
    print(f"\n📊 Parse Results:")
    print(f"   Transactions:   {stats['total_transactions']}")
    print(f"   Unique Accounts: {stats['unique_accounts']}")
    print(f"   Unique Assets:   {stats['unique_assets']}")
    print(f"   Fee Transactions: {stats['fee_transactions']}")
    print(f"   Parse Errors:    {stats['errors']}")
    print(f"   Warnings:        {stats['warnings']}")
    
    if load_result.errors:
        print(f"\n⚠️  Parse Errors:")
        for err in load_result.errors[:5]:  # Show first 5
            print(f"   Row {err.get('row', '?')}: {err.get('error', 'Unknown error')}")
        if len(load_result.errors) > 5:
            print(f"   ... and {len(load_result.errors) - 5} more errors")
    
    if load_result.warnings:
        print(f"\n⚠️  Warnings:")
        for warning in load_result.warnings[:10]:  # Show first 10
            print(f"   {warning}")
        if len(load_result.warnings) > 10:
            print(f"   ... and {len(load_result.warnings) - 10} more warnings")
    
    # Show sample transactions
    if load_result.transactions:
        print(f"\n📋 Sample Transactions (first 5):")
        for tx in load_result.transactions[:5]:
            fee_indicator = " [FEE]" if tx.is_fee_transaction else ""
            print(f"   {tx.date_time} | {tx.transaction_type:4} | {tx.asset_ticker:20} | {tx.quantity or 0:>12} | {tx.account_code}{fee_indicator}")
    
    # Import to database
    print_header("IMPORTING TO DATABASE")
    
    with get_session() as session:
        service = TradeImportService(session)
        result = service.import_from_load_result(load_result, dry_run=args.dry_run)
    
    # Show import results
    result_dict = result.to_dict()
    
    print_stats("Raw Accounts", result_dict["raw_accounts"])
    print_stats("Raw Assets", result_dict["raw_assets"])
    print_stats("Transactions", result_dict["transactions"])
    
    print(f"\n📝 Pending Review: {result_dict['pending_review_count']} transactions")
    
    # Show errors
    all_errors = (
        result_dict["transactions"]["errors"] +
        result_dict["raw_accounts"]["errors"] +
        result_dict["raw_assets"]["errors"]
    )
    
    if all_errors:
        print(f"\n❌ Import Errors:")
        for err in all_errors[:10]:
            print(f"   {err}")
        if len(all_errors) > 10:
            print(f"   ... and {len(all_errors) - 10} more errors")
    
    # Summary
    print_header("SUMMARY")
    summary = result_dict["summary"]
    print(f"   Transactions Imported: {summary['total_transactions']}")
    print(f"   Raw Accounts Created:  {summary['total_raw_accounts']}")
    print(f"   Raw Assets Created:    {summary['total_raw_assets']}")
    print(f"   Total Errors:          {summary['total_errors']}")
    
    if args.dry_run:
        print(f"\n🔍 DRY RUN COMPLETE - No changes were committed")
        print(f"   Run without --dry-run to apply changes")
    else:
        print(f"\n✅ IMPORT COMPLETE")
        if result_dict['pending_review_count'] > 0:
            print(f"   ⚠️  {result_dict['pending_review_count']} transactions need review (unmapped accounts/assets)")
            print(f"   Use the Raw Accounts and Raw Assets editors to map them")
    
    # Return exit code based on errors
    if summary['total_errors'] > 0:
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
