"""Data models for data health checks."""

from dataclasses import dataclass
from typing import Dict


@dataclass
class IssueCounts:
    """Aggregate counts for all issue types."""
    
    missing_data_issues: int = 0
    linkage_issues: int = 0
    transfer_issues: int = 0
    duplicates: int = 0
    pending_reviews: int = 0
    bundle_suggestions: int = 0
    unmapped_accounts: int = 0
    
    @property
    def data_quality_total(self) -> int:
        """Total data quality issues (missing data + linkage + transfer + duplicates)."""
        return self.missing_data_issues + self.linkage_issues + self.transfer_issues + self.duplicates
    
    @property
    def workflow_total(self) -> int:
        """Total workflow items (pending + bundle suggestions)."""
        return self.pending_reviews + self.bundle_suggestions
    
    @property
    def total_issues(self) -> int:
        """Total of all issues including pending reviews."""
        return self.data_quality_total + self.pending_reviews


@dataclass
class HealthSummary:
    """Comprehensive health summary with categorized issue counts."""
    
    data_quality_issues: Dict[str, int]
    workflow_status: Dict[str, int]
    total_issues: int
    has_issues: bool
    
    @classmethod
    def from_counts(cls, counts: IssueCounts) -> "HealthSummary":
        """Create HealthSummary from IssueCounts."""
        return cls(
            data_quality_issues={
                "missing_data_issues": counts.missing_data_issues,
                "linkage_issues": counts.linkage_issues,
                "transfer_issues": counts.transfer_issues,
                "duplicates": counts.duplicates,
            },
            workflow_status={
                "pending_reviews": counts.pending_reviews,
                "bundle_suggestions": counts.bundle_suggestions,
            },
            total_issues=counts.total_issues,
            has_issues=counts.total_issues > 0 or counts.bundle_suggestions > 0,
        )
