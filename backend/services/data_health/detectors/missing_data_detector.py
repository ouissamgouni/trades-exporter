"""Missing data detector for transactions with missing required source fields."""

from typing import List, Optional, Tuple
from sqlmodel import Session, select
from sqlalchemy import func, union_all, literal

from backend.db.models import NormalizedTransaction, ReviewStatus, Asset, Account
from backend.api.schemas import TransactionIssue, IssueType, SuggestionInfo
from .base import IssueDetector


class MissingDataDetector(IssueDetector):
    """Detector for missing required source data (source, source_asset_symbol, source_account)."""
    
    def count(
        self,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
    ) -> int:
        """Count all missing data issues.
        
        Args:
            account_ids: Filter by specific account IDs
            include_dismissed: Not applicable for missing data issues (no dismissal mechanism)
            
        Returns:
            Total count of missing data issues
        """
        issues_union = self._build_issues_union(account_ids)
        total_query = select(func.count()).select_from(issues_union)
        return self.session.exec(total_query).one()
    
    def fetch(
        self,
        page: int = 1,
        per_page: int = 50,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
    ) -> Tuple[List[TransactionIssue], int]:
        """Fetch paginated missing data issues.
        
        Args:
            page: Page number (1-indexed)
            per_page: Items per page
            account_ids: Filter by specific account IDs
            include_dismissed: Not applicable for missing data issues
            
        Returns:
            Tuple of (issues_list, total_count)
        """
        # Get total count
        total_count = self.count(account_ids, include_dismissed)
        
        # Build issues union
        issues_union = self._build_issues_union(account_ids)
        
        # Fetch paginated issues with transaction details
        offset = (page - 1) * per_page
        issues_query = (
            select(
                NormalizedTransaction.id,
                NormalizedTransaction.date_time,
                NormalizedTransaction.direction,
                NormalizedTransaction.quantity,
                NormalizedTransaction.source_asset_symbol,
                NormalizedTransaction.source,
                NormalizedTransaction.network,
                issues_union.c.issue_type,
                issues_union.c.raw_value,
                NormalizedTransaction.account_id,
                NormalizedTransaction.source_account,
            )
            .join(issues_union, NormalizedTransaction.id == issues_union.c.tx_id)
            .order_by(NormalizedTransaction.date_time.desc())
            .offset(offset)
            .limit(per_page)
        )
        issues_rows = self.session.exec(issues_query).all()
        
        # Build TransactionIssue objects (no suggestions for missing data)
        issues_list = []
        for row in issues_rows:
            (
                tx_id, date_time, direction, quantity, source_asset_symbol, source,
                network, issue_type, raw_value, account_id, source_account
            ) = row
            
            # Resolve account name if account_id is present
            account_name = None
            if account_id:
                account = self.session.get(Account, account_id)
                account_name = account.name if account else None
            
            issues_list.append(TransactionIssue(
                transaction_id=tx_id,
                date_time=date_time.isoformat() if date_time else "",
                direction=direction or "unknown",
                quantity=float(quantity) if quantity else 0.0,
                source_asset_symbol=source_asset_symbol or "",
                source=source or "",
                network=network,
                issue_type=IssueType(issue_type),
                raw_value=raw_value or "",
                suggestion=None,  # No fuzzy matching for missing data
                account_id=account_id,
                account_name=account_name,
                source_account=source_account,
            ))
        
        return issues_list, total_count
    
    def _build_issues_union(self, account_ids: Optional[List[int]] = None):
        """Build the SQL UNION query for all missing data issue types.
        
        Args:
            account_ids: Optional account ID filter
            
        Returns:
            SQLAlchemy subquery with union of all missing data issues
        """
        # Subquery for missing source
        missing_source_subq = (
            select(
                NormalizedTransaction.id.label('tx_id'),
                literal(IssueType.MISSING_SOURCE.value).label('issue_type'),
                NormalizedTransaction.source.label('raw_value'),
            )
            .where(
                NormalizedTransaction.source.is_(None) | 
                (NormalizedTransaction.source == '')
            )
            .where(NormalizedTransaction.review_status != ReviewStatus.INVALID)
        )
        if account_ids:
            missing_source_subq = missing_source_subq.where(
                NormalizedTransaction.account_id.in_(account_ids)
            )
        
        # Subquery for missing source asset (no source_asset_symbol and no asset_id)
        missing_source_asset_subq = (
            select(
                NormalizedTransaction.id.label('tx_id'),
                literal(IssueType.MISSING_SOURCE_ASSET.value).label('issue_type'),
                NormalizedTransaction.source_asset_symbol.label('raw_value'),
            )
            .where(NormalizedTransaction.asset_id.is_(None))
            .where(
                NormalizedTransaction.source_asset_symbol.is_(None) | 
                (NormalizedTransaction.source_asset_symbol == '')
            )
            .where(NormalizedTransaction.review_status != ReviewStatus.INVALID)
        )
        if account_ids:
            missing_source_asset_subq = missing_source_asset_subq.where(
                NormalizedTransaction.account_id.in_(account_ids)
            )
        
        # Subquery for missing source account (no source_account and no account_id)
        missing_source_account_subq = (
            select(
                NormalizedTransaction.id.label('tx_id'),
                literal(IssueType.MISSING_SOURCE_ACCOUNT.value).label('issue_type'),
                NormalizedTransaction.source_account.label('raw_value'),
            )
            .where(NormalizedTransaction.account_id.is_(None))
            .where(
                NormalizedTransaction.source_account.is_(None) | 
                (NormalizedTransaction.source_account == '')
            )
            .where(NormalizedTransaction.review_status != ReviewStatus.INVALID)
        )
        # Note: account filter not applicable when account_id is None
        
        # Union all missing data issues
        return union_all(
            missing_source_subq,
            missing_source_asset_subq,
            missing_source_account_subq,
        ).subquery()
