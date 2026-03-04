"""Main service orchestrator for data health checks and issue detection."""

from typing import List, Optional
from sqlmodel import Session, select
from sqlalchemy import func

from backend.db.models import NormalizedTransaction
from backend.services.suggestion_service import SuggestionService
from .models import IssueCounts, HealthSummary
from .detectors import (
    LinkageIssueDetector,
    TransferIssueDetector,
    DuplicateDetector,
    PendingDetector,
    MissingDataDetector,
    UnmappedAccountDetector,
)


class IssueService:
    """Main service for data health issue detection and reporting."""
    
    def __init__(self, session: Session):
        """Initialize service with database session.
        
        Args:
            session: SQLModel database session
        """
        self.session = session
        self.missing_data_detector = MissingDataDetector(session)
        self.linkage_detector = LinkageIssueDetector(session)
        self.transfer_detector = TransferIssueDetector(session)
        self.duplicate_detector = DuplicateDetector(session)
        self.pending_detector = PendingDetector(session)
        self.unmapped_account_detector = UnmappedAccountDetector(session)
        self.suggestion_service = SuggestionService(session)
    
    def get_counts(
        self,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
    ) -> IssueCounts:
        """Get all issue counts in a single call (single source of truth).
        
        Args:
            account_ids: Filter by specific account IDs
            include_dismissed: Include dismissed issues (applies to transfers and duplicates)
            
        Returns:
            IssueCounts with all issue type counts
        """
        return IssueCounts(
            missing_data_issues=self.missing_data_detector.count(account_ids, include_dismissed),
            linkage_issues=self.linkage_detector.count(
                account_ids, include_dismissed,
                issue_types=self.linkage_detector.ASSET_ISSUE_TYPES,
            ),
            transfer_issues=self.transfer_detector.count(account_ids, include_dismissed),
            duplicates=self.duplicate_detector.count(account_ids, include_dismissed),
            pending_reviews=self.pending_detector.count(account_ids, include_dismissed),
            bundle_suggestions=self._count_bundle_suggestions(account_ids),
            unmapped_accounts=self.unmapped_account_detector.count(account_ids, include_dismissed),
        )
    
    def get_health_summary(
        self,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
    ) -> HealthSummary:
        """Get comprehensive health summary with categorized counts.
        
        Args:
            account_ids: Filter by specific account IDs
            include_dismissed: Include dismissed issues
            
        Returns:
            HealthSummary with data quality vs workflow categorization
        """
        counts = self.get_counts(account_ids, include_dismissed)
        return HealthSummary.from_counts(counts)
    
    def get_missing_data_issues(
        self,
        page: int = 1,
        per_page: int = 50,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
    ):
        """Get paginated missing data issues.
        
        Args:
            page: Page number (1-indexed)
            per_page: Items per page
            account_ids: Filter by specific account IDs
            include_dismissed: Not applicable for missing data issues
            
        Returns:
            Tuple of (issues_list, total_count)
        """
        return self.missing_data_detector.fetch(page, per_page, account_ids, include_dismissed)
    
    def get_linkage_issues(
        self,
        page: int = 1,
        per_page: int = 50,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
        issue_types: Optional[List[str]] = None,
    ):
        """Get paginated linkage issues with fuzzy match suggestions.
        
        Args:
            page: Page number (1-indexed)
            per_page: Items per page
            account_ids: Filter by specific account IDs
            include_dismissed: Not applicable for linkage issues
            issue_types: Optional list of issue type values to filter by.
            
        Returns:
            Tuple of (issues_list, total_count)
        """
        return self.linkage_detector.fetch(page, per_page, account_ids, include_dismissed, issue_types=issue_types)
    
    def get_transfer_issues(
        self,
        page: int = 1,
        per_page: int = 50,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
    ):
        """Get paginated transfer issues with account/connector info.
        
        Args:
            page: Page number (1-indexed)
            per_page: Items per page
            account_ids: Filter by specific account IDs
            include_dismissed: Include dismissed transfer issues
            
        Returns:
            Tuple of (issues_list, total_count)
        """
        return self.transfer_detector.fetch(page, per_page, account_ids, include_dismissed)
    
    def get_duplicate_groups(
        self,
        page: int = 1,
        per_page: int = 50,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
    ):
        """Get paginated duplicate groups.
        
        Args:
            page: Page number (1-indexed)
            per_page: Groups per page
            account_ids: Filter by specific account ID (only first used)
            include_dismissed: Not supported - dismissed always excluded
            
        Returns:
            Tuple of (duplicate_groups_list, total_group_count)
        """
        return self.duplicate_detector.fetch(page, per_page, account_ids, include_dismissed)
    
    def get_pending_reviews(
        self,
        page: int = 1,
        per_page: int = 50,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
    ):
        """Get paginated pending transactions.
        
        Args:
            page: Page number (1-indexed)
            per_page: Items per page
            account_ids: Filter by specific account IDs
            include_dismissed: Not applicable for pending reviews
            
        Returns:
            Tuple of (issues_list, total_count)
        """
        return self.pending_detector.fetch(page, per_page, account_ids, include_dismissed)
    
    def _count_bundle_suggestions(
        self,
        account_ids: Optional[List[int]] = None,
    ) -> int:
        """Count bundle suggestions using SuggestionService.
        
        Args:
            account_ids: Filter by specific account IDs
            
        Returns:
            Count of bundle suggestions
        """
        # Get transactions for the specified accounts
        if account_ids:
            from backend.db.models import NormalizedTransaction
            from sqlalchemy import select
            
            stmt = select(NormalizedTransaction).where(
                NormalizedTransaction.account_id.in_(account_ids)
            )
            result = self.session.execute(stmt)
            transactions = result.scalars().all()
        else:
            transactions = None  # get_suggestions will fetch standalone transactions
        
        # Get suggestions with a reasonable max limit
        suggestions = self.suggestion_service.get_suggestions(
            transactions=transactions,
            max_suggestions=1000,  # High limit to get accurate count
            include_unknown=False,
        )
        return len(suggestions)
