#!/usr/bin/env python3
"""
Script to import assets from a CSV file.

Usage:
    python -m backend.scripts.import_assets path/to/assets.csv [options]
    python scripts/import_assets.py path/to/assets.csv [options]

Options:
    --dry-run      Preview changes without committing
    --merge        Merge price getters instead of replacing

Examples:
    # Preview import
    python -m backend.scripts.import_assets data/input/assets.csv --dry-run
    
    # Import with default settings (replace price getters)
    python -m backend.scripts.import_assets data/input/assets.csv
    
    # Import with merge mode (keep existing price getters)
    python -m backend.scripts.import_assets data/input/assets.csv --merge
"""

import sys
import argparse
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

from backend.config.loader import configure_logging
from backend.db.database import get_session
from backend.file_loaders.asset_csv_loader import AssetCSVLoader
from backend.services.asset_import_service import AssetImportService

log = configure_logging("import_assets")


def main():
    parser = argparse.ArgumentParser(
        description="Import assets from a CSV file",
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
        "--merge",
        action="store_true",
        help="Merge price getters with existing (default: replace)"
    )
    
    args = parser.parse_args()
    
    # Validate file
    csv_path = args.csv_file
    if not csv_path.exists():
        print(f"❌ File not found: {csv_path}")
        sys.exit(1)
    
    if not csv_path.suffix.lower() == ".csv":
        print(f"❌ File must be a CSV: {csv_path}")
        sys.exit(1)
    
    print(f"📂 Loading: {csv_path}")
    
    # Parse CSV
    loader = AssetCSVLoader()
    load_result = loader.load(csv_path)
    
    # Show parse summary
    print(f"\n📊 Parse Results:")
    print(f"   Assets:     {len(load_result.assets)}")
    print(f"   Categories: {len(load_result.categories)}")
    print(f"   Errors:     {len(load_result.errors)}")
    print(f"   Warnings:   {len(load_result.warnings)}")
    
    if load_result.errors:
        print(f"\n⚠️  Parse Errors:")
        for err in load_result.errors[:5]:  # Show first 5
            print(f"   Row {err.get('row', '?')}: {err.get('error', 'Unknown error')}")
        if len(load_result.errors) > 5:
            print(f"   ... and {len(load_result.errors) - 5} more errors")
    
    if load_result.warnings:
        print(f"\n⚠️  Warnings:")
        for warn in load_result.warnings[:5]:
            print(f"   {warn}")
        if len(load_result.warnings) > 5:
            print(f"   ... and {len(load_result.warnings) - 5} more warnings")
    
    if not load_result.assets:
        print("\n❌ No assets to import")
        sys.exit(1)
    
    # Import
    mode = "DRY RUN" if args.dry_run else "IMPORT"
    replace_mode = "merge" if args.merge else "replace"
    
    print(f"\n🚀 Starting {mode} (price getters: {replace_mode})...")
    
    with get_session() as session:
        service = AssetImportService(session)
        result = service.import_from_load_result(
            load_result,
            dry_run=args.dry_run,
            replace_price_getters=not args.merge
        )
    
    # Show results
    print(f"\n✅ {mode} Complete:")
    print(f"\n   Assets:")
    print(f"      Created: {result.assets.created}")
    print(f"      Updated: {result.assets.updated}")
    print(f"      Skipped: {result.assets.skipped}")
    if result.assets.errors:
        print(f"      Errors:  {len(result.assets.errors)}")
    
    print(f"\n   Categories:")
    print(f"      Created: {result.categories.created}")
    print(f"      Updated: {result.categories.updated}")
    print(f"      Skipped: {result.categories.skipped}")
    
    print(f"\n   Price Getters:")
    print(f"      Created: {result.price_getters.created}")
    print(f"      Updated: {result.price_getters.updated}")
    
    print(f"\n   Asset-Category Links:")
    print(f"      Created: {result.asset_categories.created}")
    print(f"      Skipped: {result.asset_categories.skipped}")
    
    total_errors = (
        len(result.assets.errors) +
        len(result.categories.errors) +
        len(result.price_getters.errors) +
        len(result.parse_errors)
    )
    
    if total_errors > 0:
        print(f"\n⚠️  Total Errors: {total_errors}")
        sys.exit(1)
    
    if args.dry_run:
        print(f"\n💡 This was a dry run. Run without --dry-run to apply changes.")
    else:
        print(f"\n🎉 Import successful!")


if __name__ == "__main__":
    main()
