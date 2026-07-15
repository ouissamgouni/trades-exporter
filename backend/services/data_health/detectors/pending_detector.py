"""Pending transaction detector for review status tracking."""

from typing import List, Optional, Tuple
from sqlmodel import Session, select
from sqlalchemy import func

from backend.db.models import NormalizedTransaction, ReviewStatus
from backend.api.schemas import TransactionIssue, IssueType
from .base import IssueDetector


class PendingDetector(IssueDetector):
    """Detector for transactions with pending review status."""
    
    def count(
        self,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
    ) -> int:
        """Count pending transactions.
        
        Args:
            account_ids: Filter by specific account IDs
            include_dismissed: Not applicable for pending reviews
            
        Returns:
            Total count of pending transactions
        """
        query = select(func.count(NormalizedTransaction.id)).where(
            NormalizedTransaction.review_status == ReviewStatus.PENDING
        )
        
        if account_ids:
            query = query.where(NormalizedTransaction.account_id.in_(account_ids))
        
        return self.session.exec(query).one()
    
    def fetch(
        self,
        page: int = 1,
        per_page: int = 50,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
    ) -> Tuple[List[TransactionIssue], int]:
        """Fetch paginated pending transactions.
        
        Args:
            page: Page number (1-indexed)
            per_page: Items per page
            account_ids: Filter by specific account IDs
            include_dismissed: Not applicable for pending reviews
            
        Returns:
            Tuple of (issues_list, total_count)
        """
        # Get total count
        total_count = self.count(account_ids, include_dismissed)
        
        # Build query for pending transactions
        offset = (page - 1) * per_page
        query = (
            select(NormalizedTransaction)
            .where(NormalizedTransaction.review_status == ReviewStatus.PENDING)
            .order_by(NormalizedTransaction.date_time.desc())
            .offset(offset)
            .limit(per_page)
        )
        
        if account_ids:
            query = query.where(NormalizedTransaction.account_id.in_(account_ids))
        
        transactions = self.session.exec(query).all()
        
        # Convert to TransactionIssue format
        issues_list = []
        for tx in transactions:
            issues_list.append(TransactionIssue(
                transaction_id=tx.id,
                date_time=tx.date_time.isoformat() if tx.date_time else "",
                direction=tx.direction or "unknown",
                quantity=float(tx.quantity) if tx.quantity else 0.0,
                source_asset_symbol=tx.source_asset_symbol or "",
                source=tx.source or "",
                issue_type=IssueType.PENDING_REVIEW,
                raw_value="",
                suggestion=None,
                account_id=tx.account_id,
                account_name=None,  # Would require join to populate
                source_account=tx.source_account,
            ))
        
        return issues_list, total_count
