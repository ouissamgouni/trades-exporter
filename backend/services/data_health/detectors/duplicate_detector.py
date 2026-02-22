"""Duplicate issue detector wrapping duplicate detection functions."""

from typing import List, Optional, Tuple
from sqlmodel import Session

from backend.services.duplicate_detection_service import detect_duplicate_groups, DuplicateGroup
from .base import IssueDetector


class DuplicateDetector(IssueDetector):
    """Detector for duplicate transactions."""
    
    def count(
        self,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
    ) -> int:
        """Count unresolved duplicate transactions.
        
        Note: Duplicate detection doesn't support include_dismissed parameter.
        Dismissed duplicates are automatically excluded via resolution tags.
        
        Args:
            account_ids: Filter by specific account ID (only first ID used)
            include_dismissed: Not supported - dismissed duplicates always excluded
            
        Returns:
            Total count of unresolved duplicate transactions
        """
        # Get duplicate groups using the service function
        groups = detect_duplicate_groups(
            session=self.session,
            account_id=account_ids[0] if account_ids else None,
        )
        
        # Count total unresolved transactions across all groups
        total_count = sum(group.transaction_count for group in groups)
        return total_count
    
    def fetch(
        self,
        page: int = 1,
        per_page: int = 50,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
    ) -> Tuple[List[DuplicateGroup], int]:
        """Fetch paginated duplicate groups.
        
        Note: Returns groups, not individual transactions. Pagination applies to groups.
        
        Args:
            page: Page number (1-indexed) 
            per_page: Groups per page
            account_ids: Filter by specific account ID (only first ID used)
            include_dismissed: Not supported - dismissed duplicates always excluded
            
        Returns:
            Tuple of (duplicate_groups_list, total_group_count)
        """
        # Get all duplicate groups using the service function
        all_groups = detect_duplicate_groups(
            session=self.session,
            account_id=account_ids[0] if account_ids else None,
        )
        
        # Manual pagination of groups
        total_group_count = len(all_groups)
        start_idx = (page - 1) * per_page
        end_idx = start_idx + per_page
        paginated_groups = all_groups[start_idx:end_idx]
        
        return paginated_groups, total_group_count
