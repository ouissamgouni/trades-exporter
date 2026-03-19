"""
Normalize all tags in the database to uniform format.

This script converts all tag formats to: [{"key": "value"}, {"key2": "value2"}]
Handles:
- Multi-key dicts: {"a": 1, "b": 2} -> [{"a": 1}, {"b": 2}]
- Arrays with multi-key dicts: [{"a": 1, "b": 2}] -> [{"a": 1}, {"b": 2}]
- Corrupted format: {"0": [{...}]} -> [{...}]
- Already correct format: [{"a": 1}] -> [{"a": 1}]
"""

import sys
from pathlib import Path

# Add backend to path
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir.parent))

from sqlmodel import Session, select
from sqlalchemy.orm import Session as AlchemySession
from backend.db.database import get_engine
from backend.db.models import NormalizedTransaction


def normalize_tags(tags):
    """Normalize tags to uniform format: [{"key": "value"}, ...]"""
    if not tags:
        return None
    
    normalized = []
    
    if isinstance(tags, dict):
        # Check if it's a corrupted format with numeric keys
        if all(k.isdigit() for k in tags.keys()):
            # Extract values and recursively normalize
            sorted_keys = sorted(tags.keys(), key=int)
            for k in sorted_keys:
                val = tags[k]
                if isinstance(val, list):
                    # Flatten and recursively normalize each item
                    for item in val:
                        if isinstance(item, dict):
                            # Split multi-key dict
                            for key, value in item.items():
                                normalized.append({key: value})
                        else:
                            normalized.append({"value": str(item)})
                elif isinstance(val, dict):
                    # Split multi-key dict
                    for key, value in val.items():
                        normalized.append({key: value})
                else:
                    normalized.append({"value": str(val)})
        else:
            # Regular dict - split into separate single-key dicts
            for key, value in tags.items():
                normalized.append({key: value})
    
    elif isinstance(tags, list):
        for tag in tags:
            if isinstance(tag, dict):
                # If multi-key dict, split it
                if len(tag) > 1:
                    for key, value in tag.items():
                        normalized.append({key: value})
                else:
                    # Single-key dict, keep as-is
                    normalized.append(tag)
            elif isinstance(tag, str):
                # Legacy string format
                normalized.append({"tag": tag})
            else:
                normalized.append({"value": str(tag)})
    else:
        # Unknown format - wrap it
        normalized.append({"value": str(tags)})
    
    return normalized if normalized else None


def main():
    """Normalize all tags in the database."""
    print("🔄 Starting tags normalization...")
    
    engine = get_engine()
    with Session(engine) as session:
        # Get all transactions with tags
        statement = select(NormalizedTransaction).where(
            NormalizedTransaction.tags.isnot(None)
        )
        transactions = session.exec(statement).all()
        
        total = len(transactions)
        print(f"📊 Found {total} transactions with tags")
        
        if total == 0:
            print("✅ No tags to normalize")
            return
        
        updated = 0
        unchanged = 0
        
        for i, tx in enumerate(transactions, 1):
            if i % 100 == 0:
                print(f"  Processing {i}/{total}...")
            
            original_tags = tx.tags
            normalized = normalize_tags(original_tags)
            
            # Check if normalization changed anything
            if normalized != original_tags:
                tx.tags = normalized
                session.add(tx)
                updated += 1
                
                # Show example of first few changes
                if updated <= 3:
                    print(f"\n📝 Example {updated}:")
                    print(f"  Before: {original_tags}")
                    print(f"  After:  {normalized}")
            else:
                unchanged += 1
        
        # Commit all changes
        if updated > 0:
            print(f"\n💾 Committing {updated} changes...")
            session.commit()
            print("✅ Successfully normalized all tags")
        else:
            print("✅ All tags already in correct format")
        
        print(f"\n📈 Summary:")
        print(f"  Total: {total}")
        print(f"  Updated: {updated}")
        print(f"  Unchanged: {unchanged}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n⚠️  Interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
