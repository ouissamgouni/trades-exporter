"""Migrate old-format dismiss tags to new single-tag format.

Old format (accumulated separate objects):
  [{"sys_transfer_dismissed": "true"}, {"sys_dismissed_field": "source_from_account"}, 
   {"sys_dismissed_at": "..."}, {"sys_dismissed_reason": "..."}]

New format (single object per dismissed field):
  [{"sys_transfer_dismissed": "source_from_account"}]
"""
import sys, json
sys.path.insert(0, "/Users/ouissamgouni/Documents/it-workspace/trades-exporter")

from backend.db.database import get_engine
from sqlmodel import Session, text

engine = get_engine()
with Session(engine) as session:
    rows = session.exec(text(
        "SELECT id, tags FROM normalized_transactions "
        "WHERE tags IS NOT NULL "
        "AND tags::text LIKE '%sys_transfer_dismissed%'"
    )).all()

    migrated = 0
    for tx_id, old_tags in rows:
        dismissed_fields = set()
        other_tags = []
        for tag in old_tags:
            if isinstance(tag, dict):
                if "sys_dismissed_field" in tag:
                    dismissed_fields.add(tag["sys_dismissed_field"])
                elif "sys_transfer_dismissed" in tag:
                    pass
                elif "sys_dismissed_at" in tag:
                    pass
                elif "sys_dismissed_reason" in tag:
                    pass
                else:
                    other_tags.append(tag)
            else:
                other_tags.append(tag)

        new_tags = list(other_tags)
        for field in dismissed_fields:
            new_tags.append({"sys_transfer_dismissed": field})

        session.execute(
            text("UPDATE normalized_transactions SET tags = CAST(:tags AS jsonb) WHERE id = :id"),
            {"tags": json.dumps(new_tags), "id": tx_id},
        )
        migrated += 1
        print(f"  TX {tx_id}: {len(old_tags)} old tags -> {len(new_tags)} new (fields: {dismissed_fields})")

    session.commit()
    print(f"\nMigrated {migrated} transactions")
