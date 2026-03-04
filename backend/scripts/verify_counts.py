"""Verify IssueService counts after refactor."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from backend.db.database import get_engine
from sqlmodel import Session
from backend.services.data_health import IssueService

engine = get_engine()
with Session(engine) as session:
    svc = IssueService(session)
    counts = svc.get_counts(include_dismissed=False)
    print(f"unmapped_accounts: {counts.unmapped_accounts}")
    print(f"transfer_issues: {counts.transfer_issues}")
    print(f"linkage_issues: {counts.linkage_issues}")
    print(f"total_issues: {counts.total_issues}")
