"""Base interface for issue detectors."""

from abc import ABC, abstractmethod
from typing import List, Optional
from sqlmodel import Session


class IssueDetector(ABC):
    """Abstract base class for issue detectors."""
    
    def __init__(self, session: Session):
        """Initialize detector with database session.
        
        Args:
            session: SQLModel database session
        """
        self.session = session
    
    @abstractmethod
    def count(
        self,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
    ) -> int:
        """Count issues matching the given filters.
        
        Args:
            account_ids: Filter by specific account IDs (None = all accounts)
            include_dismissed: Include dismissed/resolved issues
            
        Returns:
            Total count of issues
        """
        pass
    
    @abstractmethod
    def fetch(
        self,
        page: int = 1,
        per_page: int = 50,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
    ) -> tuple:
        """Fetch paginated issues with details.
        
        Args:
            page: Page number (1-indexed)
            per_page: Items per page
            account_ids: Filter by specific account IDs
            include_dismissed: Include dismissed/resolved issues
            
        Returns:
            Tuple of (issues_list, total_count)
        """
        pass
