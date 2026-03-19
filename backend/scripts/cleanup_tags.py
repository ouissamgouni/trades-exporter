"""
Clean up transaction tags in the database.

This script provides flexible tag cleanup with options to:
- Preserve system tags (dup_* keys) used for duplicate detection
- Selectively remove tags by key
- Filter by account ID
- Backup tags before cleanup
- Dry-run mode to preview changes

Usage:
    # Remove all user tags, preserve system tags (default)
    python -m backend.scripts.cleanup_tags

    # Remove all tags including system tags
    python -m backend.scripts.cleanup_tags --no-preserve-system

    # Remove specific tag key
    python -m backend.scripts.cleanup_tags --tag-key category

    # Remove tags for specific account
    python -m backend.scripts.cleanup_tags --account-id 1

    # Dry run (preview only)
    python -m backend.scripts.cleanup_tags --dry-run

    # Backup tags before cleanup
    python -m backend.scripts.cleanup_tags --backup
"""

import sys
import json
import argparse
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Any, Optional

# Add backend to path
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir.parent))

from sqlmodel import Session, select
from sqlalchemy.orm import attributes
from backend.db.database import get_engine
from backend.db.models import NormalizedTransaction


SYSTEM_TAG_PREFIXES = ["dup_"]
SYSTEM_TAG_KEYS = [
    # Duplicate detection system tags (new format with dup_ prefix)
    "dup_resolution", "dup_group", "dup_resolved_at", "dup_kept_ids",
    # Legacy duplicate detection tags (old format without prefix)
    "type", "resolution", "group_hash", "kept_tx_ids", "resolved_at",
]
BATCH_SIZE = 100


def is_system_tag(tag: Dict[str, Any]) -> bool:
    """Check if a tag is a system tag (used for duplicate detection)."""
    if not isinstance(tag, dict):
        return False
    
    for key in tag.keys():
        # Check if key starts with system prefix
        if any(key.startswith(prefix) for prefix in SYSTEM_TAG_PREFIXES):
            return True
        # Check if key is in known system tag keys
        if key in SYSTEM_TAG_KEYS:
            return True
    return False


def filter_tags(
    tags: Optional[List[Dict[str, Any]]],
    preserve_system: bool = True,
    tag_key: Optional[str] = None,
) -> Optional[List[Dict[str, Any]]]:
    """
    Filter tags based on criteria.
    
    Args:
        tags: List of tag dictionaries
        preserve_system: If True, keep system tags (dup_*)
        tag_key: If specified, only remove tags with this key
    
    Returns:
        Filtered list of tags or None if empty
    """
    if not tags:
        return None
    
    filtered = []
    
    for tag in tags:
        if not isinstance(tag, dict):
            continue
        
        # Check if it's a system tag
        is_sys = is_system_tag(tag)
        
        # If preserving system tags and this is one, keep it
        if preserve_system and is_sys:
            filtered.append(tag)
            continue
        
        # If filtering by specific key
        if tag_key:
            # Keep tag if it doesn't have the specified key
            if tag_key not in tag:
                filtered.append(tag)
        # Otherwise, don't keep the tag (it will be removed)
    
    return filtered if filtered else None


def backup_tags(
    transactions: List[NormalizedTransaction],
    output_dir: Path,
) -> Path:
    """
    Backup current tags to a JSON file.
    
    Args:
        transactions: List of transactions with tags
        output_dir: Directory to save backup file
    
    Returns:
        Path to backup file
    """
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_file = output_dir / f"tags_backup_{timestamp}.json"
    
    backup_data = []
    for tx in transactions:
        if tx.tags:
            backup_data.append({
                "id": tx.id,
                "account_id": tx.account_id,
                "source": tx.source,
                "source_transaction_id": tx.source_transaction_id,
                "date_time": tx.date_time.isoformat() if tx.date_time else None,
                "tags": tx.tags,
            })
    
    backup_file.parent.mkdir(parents=True, exist_ok=True)
    with open(backup_file, "w") as f:
        json.dump(backup_data, f, indent=2)
    
    return backup_file


def cleanup_tags(
    session: Session,
    account_id: Optional[int] = None,
    preserve_system: bool = True,
    tag_key: Optional[str] = None,
    dry_run: bool = False,
    backup: bool = False,
) -> Dict[str, Any]:
    """
    Clean up transaction tags based on criteria.
    
    Args:
        session: Database session
        account_id: Filter by account ID (None = all accounts)
        preserve_system: Preserve system tags (dup_*)
        tag_key: Only remove tags with this key
        dry_run: Preview changes without committing
        backup: Backup tags before cleanup
    
    Returns:
        Summary dictionary with stats
    """
    # Build query
    statement = select(NormalizedTransaction).where(
        NormalizedTransaction.tags.isnot(None)
    )
    
    if account_id is not None:
        statement = statement.where(NormalizedTransaction.account_id == account_id)
    
    transactions = session.exec(statement).all()
    
    total = len(transactions)
    
    if total == 0:
        return {
            "total_transactions": 0,
            "affected_transactions": 0,
            "user_tags_removed": 0,
            "system_tags_removed": 0,
            "backup_file": None,
        }
    
    # Backup if requested
    backup_file = None
    if backup and not dry_run:
        output_dir = backend_dir / "data" / "output"
        backup_file = backup_tags(transactions, output_dir)
        print(f"💾 Backup saved to: {backup_file}")
        print()
    
    # Process transactions
    affected_count = 0
    user_tags_removed = 0
    system_tags_removed = 0
    unchanged_count = 0
    affected_tx_ids = []
    sample_changes = []
    
    for i, tx in enumerate(transactions, 1):
        if i % BATCH_SIZE == 0:
            print(f"  Processing {i}/{total}...")
        
        original_tags = tx.tags
        filtered_tags = filter_tags(original_tags, preserve_system, tag_key)
        
        # Count removed tags
        original_count = len(original_tags) if original_tags else 0
        filtered_count = len(filtered_tags) if filtered_tags else 0
        tags_removed = original_count - filtered_count
        
        if filtered_tags != original_tags:
            affected_count += 1
            affected_tx_ids.append(tx.id)
            
            # Count user vs system tags removed
            for tag in (original_tags or []):
                if tag not in (filtered_tags or []):
                    if is_system_tag(tag):
                        system_tags_removed += 1
                    else:
                        user_tags_removed += 1
            
            # Save sample for first few changes
            if len(sample_changes) < 5:
                sample_changes.append({
                    "id": tx.id,
                    "account_id": tx.account_id,
                    "before": original_tags,
                    "after": filtered_tags,
                    "removed_count": tags_removed,
                })
            
            if not dry_run:
                tx.tags = filtered_tags
                # Mark JSONB field as modified for SQLAlchemy to detect change
                attributes.flag_modified(tx, "tags")
                session.add(tx)
        else:
            unchanged_count += 1
    
    # Commit in batches if not dry run
    if not dry_run and affected_count > 0:
        print(f"\n💾 Committing {affected_count} changes...")
        session.commit()
    
    return {
        "total_transactions": total,
        "affected_transactions": affected_count,
        "unchanged_transactions": unchanged_count,
        "user_tags_removed": user_tags_removed,
        "system_tags_removed": system_tags_removed,
        "affected_tx_ids": affected_tx_ids,
        "sample_changes": sample_changes,
        "backup_file": str(backup_file) if backup_file else None,
    }


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Clean up transaction tags in the database",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    
    parser.add_argument(
        "--account-id",
        type=int,
        help="Only clean tags for this account ID",
    )
    
    parser.add_argument(
        "--no-preserve-system",
        action="store_true",
        help="Remove system tags (dup_*) as well (default: preserve them)",
    )
    
    parser.add_argument(
        "--tag-key",
        type=str,
        help="Only remove tags with this key (e.g., 'category')",
    )
    
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview changes without committing",
    )
    
    parser.add_argument(
        "--backup",
        action="store_true",
        help="Backup tags to JSON file before cleanup",
    )
    
    args = parser.parse_args()
    
    # Print configuration
    print("🧹 Transaction Tag Cleanup")
    print("=" * 60)
    print()
    print("Configuration:")
    print(f"  Account ID: {args.account_id or 'All accounts'}")
    print(f"  Preserve system tags: {not args.no_preserve_system}")
    print(f"  Tag key filter: {args.tag_key or 'None (all tags)'}")
    print(f"  Dry run: {args.dry_run}")
    print(f"  Backup: {args.backup}")
    print()
    
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be committed")
        print()
    
    if not args.no_preserve_system:
        print("ℹ️  System tags (dup_*) will be preserved")
        print()
    
    # Run cleanup
    engine = get_engine()
    with Session(engine) as session:
        result = cleanup_tags(
            session=session,
            account_id=args.account_id,
            preserve_system=not args.no_preserve_system,
            tag_key=args.tag_key,
            dry_run=args.dry_run,
            backup=args.backup,
        )
    
    # Print results
    print()
    print("=" * 60)
    print("📊 Summary")
    print("=" * 60)
    print(f"Total transactions with tags: {result['total_transactions']}")
    print(f"Affected transactions: {result['affected_transactions']}")
    print(f"Unchanged transactions: {result['unchanged_transactions']}")
    print()
    print(f"User tags removed: {result['user_tags_removed']}")
    print(f"System tags removed: {result['system_tags_removed']}")
    print()
    
    if result['sample_changes']:
        print("📝 Sample Changes (first 5):")
        print()
        for i, change in enumerate(result['sample_changes'], 1):
            print(f"  {i}. Transaction ID: {change['id']} (Account: {change['account_id']})")
            print(f"     Before: {json.dumps(change['before'], indent=8)}")
            print(f"     After:  {json.dumps(change['after'], indent=8)}")
            print(f"     Removed: {change['removed_count']} tag(s)")
            print()
    
    if result['backup_file']:
        print(f"💾 Backup: {result['backup_file']}")
        print()
    
    if args.dry_run:
        print("⚠️  DRY RUN - No changes were committed")
        print("   Run without --dry-run to apply changes")
    elif result['affected_transactions'] > 0:
        print("✅ Tags cleaned up successfully")
        print()
        print(f"Affected transaction IDs: {result['affected_tx_ids'][:20]}")
        if len(result['affected_tx_ids']) > 20:
            print(f"   ... and {len(result['affected_tx_ids']) - 20} more")
    else:
        print("✅ No tags to clean up")


if __name__ == "__main__":
    main()
