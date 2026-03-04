"""
Unit tests for data health issue detection service and detectors.

These are PROPER UNIT TESTS - they use mocked database sessions and do not
touch any real database. All detector dependencies are mocked.

Tests the refactored issue detection architecture:
- IssueService orchestration and aggregation
- Detector integration with mocked dependencies
- Proper filtering by account_ids and include_dismissed
"""

import pytest
from unittest.mock import MagicMock, patch
from sqlmodel import Session

from backend.services.data_health import IssueService
from backend.services.data_health.models import IssueCounts, HealthSummary
from backend.services.data_health.detectors import (
    LinkageIssueDetector,
    TransferIssueDetector,
    DuplicateDetector,
    PendingDetector,
    UnmappedAccountDetector,
)


# Always patch MissingDataDetector and UnmappedAccountDetector to avoid real DB calls during tests
@pytest.fixture(autouse=True)
def _patch_detectors_with_defaults():
    """Auto-patch detectors that need special DB objects (RawAccount, etc.)."""
    with patch('backend.services.data_health.issue_service.MissingDataDetector') as mock_missing, \
         patch('backend.services.data_health.issue_service.UnmappedAccountDetector') as mock_unmapped:
        mock_missing.return_value.count.return_value = 0
        mock_missing.return_value.fetch.return_value = ([], 0)
        mock_unmapped.return_value.count.return_value = 0
        mock_unmapped.return_value.fetch.return_value = ([], 0)
        yield mock_missing, mock_unmapped


# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def mock_session():
    """Create a mock database session for unit tests."""
    return MagicMock(spec=Session)


@pytest.fixture
def mock_linkage_detector():
    """Create a mock LinkageIssueDetector."""
    detector = MagicMock(spec=LinkageIssueDetector)
    detector.count.return_value = 5
    detector.fetch.return_value = ([], 5)
    return detector


@pytest.fixture
def mock_transfer_detector():
    """Create a mock TransferIssueDetector."""
    detector = MagicMock(spec=TransferIssueDetector)
    detector.count.return_value = 3
    detector.fetch.return_value = ([], 3)
    return detector


@pytest.fixture
def mock_duplicate_detector():
    """Create a mock DuplicateDetector."""
    detector = MagicMock(spec=DuplicateDetector)
    detector.count.return_value = 2
    detector.fetch.return_value = ([], 2)
    return detector


@pytest.fixture
def mock_pending_detector():
    """Create a mock PendingDetector."""
    detector = MagicMock(spec=PendingDetector)
    detector.count.return_value = 7
    detector.fetch.return_value = ([], 7)
    return detector


# =============================================================================
# IssueService Tests
# =============================================================================


@pytest.mark.unit
class TestIssueServiceGetCounts:
    """Test IssueService.get_counts() method with mocked detectors."""
    
    def test_get_counts_aggregates_all_detectors(
        self,
        mock_session,
        mock_linkage_detector,
        mock_transfer_detector,
        mock_duplicate_detector,
        mock_pending_detector,
    ):
        """Test that get_counts() calls all detectors and aggregates results."""
        # Create IssueService with mocked detectors
        with patch('backend.services.data_health.issue_service.LinkageIssueDetector', return_value=mock_linkage_detector), \
             patch('backend.services.data_health.issue_service.TransferIssueDetector', return_value=mock_transfer_detector), \
             patch('backend.services.data_health.issue_service.DuplicateDetector', return_value=mock_duplicate_detector), \
             patch('backend.services.data_health.issue_service.PendingDetector', return_value=mock_pending_detector), \
             patch('backend.services.data_health.issue_service.SuggestionService'):
            
            service = IssueService(mock_session)
            counts = service.get_counts()
            
            # Verify all detectors were called
            mock_linkage_detector.count.assert_called_once_with(
                None, False,
                issue_types=mock_linkage_detector.ASSET_ISSUE_TYPES,
            )
            mock_transfer_detector.count.assert_called_once_with(None, False)
            mock_duplicate_detector.count.assert_called_once_with(None, False)
            mock_pending_detector.count.assert_called_once_with(None, False)
            
            # Verify aggregated results
            assert isinstance(counts, IssueCounts)
            assert counts.linkage_issues == 5
            assert counts.transfer_issues == 3
            assert counts.duplicates == 2
            assert counts.pending_reviews == 7
    
    def test_get_counts_with_account_filter(
        self,
        mock_session,
        mock_linkage_detector,
        mock_transfer_detector,
        mock_duplicate_detector,
        mock_pending_detector,
    ):
        """Test get_counts() with account_ids filter."""
        with patch('backend.services.data_health.issue_service.LinkageIssueDetector', return_value=mock_linkage_detector), \
             patch('backend.services.data_health.issue_service.TransferIssueDetector', return_value=mock_transfer_detector), \
             patch('backend.services.data_health.issue_service.DuplicateDetector', return_value=mock_duplicate_detector), \
             patch('backend.services.data_health.issue_service.PendingDetector', return_value=mock_pending_detector), \
             patch('backend.services.data_health.issue_service.SuggestionService'):
            
            service = IssueService(mock_session)
            account_ids = [1, 2, 3]
            counts = service.get_counts(account_ids=account_ids)
            
            # Verify detectors were called with account filter
            mock_linkage_detector.count.assert_called_once_with(
                account_ids, False,
                issue_types=mock_linkage_detector.ASSET_ISSUE_TYPES,
            )
            mock_transfer_detector.count.assert_called_once_with(account_ids, False)
            mock_duplicate_detector.count.assert_called_once_with(account_ids, False)
            mock_pending_detector.count.assert_called_once_with(account_ids, False)
    
    def test_get_counts_with_include_dismissed(
        self,
        mock_session,
        mock_linkage_detector,
        mock_transfer_detector,
        mock_duplicate_detector,
        mock_pending_detector,
    ):
        """Test get_counts() with include_dismissed=True."""
        with patch('backend.services.data_health.issue_service.LinkageIssueDetector', return_value=mock_linkage_detector), \
             patch('backend.services.data_health.issue_service.TransferIssueDetector', return_value=mock_transfer_detector), \
             patch('backend.services.data_health.issue_service.DuplicateDetector', return_value=mock_duplicate_detector), \
             patch('backend.services.data_health.issue_service.PendingDetector', return_value=mock_pending_detector), \
             patch('backend.services.data_health.issue_service.SuggestionService'):
            
            service = IssueService(mock_session)
            counts = service.get_counts(include_dismissed=True)
            
            # Verify detectors were called with include_dismissed=True
            mock_linkage_detector.count.assert_called_once_with(
                None, True,
                issue_types=mock_linkage_detector.ASSET_ISSUE_TYPES,
            )
            mock_transfer_detector.count.assert_called_once_with(None, True)
            mock_duplicate_detector.count.assert_called_once_with(None, True)
            mock_pending_detector.count.assert_called_once_with(None, True)


@pytest.mark.unit
class TestIssueServiceGetHealthSummary:
    """Test IssueService.get_health_summary() method."""
    
    def test_get_health_summary_calculates_total_issues(
        self,
        mock_session,
        mock_linkage_detector,
        mock_transfer_detector,
        mock_duplicate_detector,
        mock_pending_detector,
    ):
        """Test that get_health_summary() calculates total_issues correctly."""
        with patch('backend.services.data_health.issue_service.LinkageIssueDetector', return_value=mock_linkage_detector), \
             patch('backend.services.data_health.issue_service.TransferIssueDetector', return_value=mock_transfer_detector), \
             patch('backend.services.data_health.issue_service.DuplicateDetector', return_value=mock_duplicate_detector), \
             patch('backend.services.data_health.issue_service.PendingDetector', return_value=mock_pending_detector), \
             patch('backend.services.data_health.issue_service.SuggestionService'):
            
            service = IssueService(mock_session)
            summary = service.get_health_summary()
            
            assert isinstance(summary, HealthSummary)
            # Total = linkage(5) + transfer(3) + duplicates(2) + pending(7) + bundle_suggestions(0)
            assert summary.total_issues == 17
            assert summary.data_quality_issues["linkage_issues"] == 5
            assert summary.data_quality_issues["transfer_issues"] == 3
            assert summary.data_quality_issues["duplicates"] == 2
            assert summary.workflow_status["pending_reviews"] == 7
    
    def test_get_health_summary_includes_pending_in_total(
        self,
        mock_session,
        mock_linkage_detector,
        mock_transfer_detector,
        mock_duplicate_detector,
        mock_pending_detector,
    ):
        """Test that get_health_summary() includes pending_count in total_issues."""
        # Set pending count to non-zero
        mock_pending_detector.count.return_value = 45
        
        with patch('backend.services.data_health.issue_service.LinkageIssueDetector', return_value=mock_linkage_detector), \
             patch('backend.services.data_health.issue_service.TransferIssueDetector', return_value=mock_transfer_detector), \
             patch('backend.services.data_health.issue_service.DuplicateDetector', return_value=mock_duplicate_detector), \
             patch('backend.services.data_health.issue_service.PendingDetector', return_value=mock_pending_detector), \
             patch('backend.services.data_health.issue_service.SuggestionService'):
            
            service = IssueService(mock_session)
            summary = service.get_health_summary()
            
            # Verify pending is included in total
            assert summary.workflow_status["pending_reviews"] == 45
            # Total = linkage(5) + transfer(3) + duplicates(2) + pending(45) + bundle_suggestions(0)
            assert summary.total_issues == 55


@pytest.mark.unit
class TestIssueServiceBundleSuggestions:
    """Test IssueService bundle suggestion counting."""
    
    def test_count_bundle_suggestions_queries_transactions_and_calls_service(
        self,
        mock_session,
    ):
        """Test that _count_bundle_suggestions() queries transactions then calls SuggestionService."""
        # Mock session.exec() for transaction query
        mock_result = MagicMock()
        mock_result.all.return_value = [MagicMock(id=1), MagicMock(id=2), MagicMock(id=3)]
        mock_session.exec.return_value = mock_result
        
        # Mock SuggestionService
        mock_suggestion_service = MagicMock()
        mock_suggestion_service.get_suggestions.return_value = [
            {"label": "Bundle 1"},
            {"label": "Bundle 2"},
        ]
        
        with patch('backend.services.data_health.issue_service.LinkageIssueDetector'), \
             patch('backend.services.data_health.issue_service.TransferIssueDetector'), \
             patch('backend.services.data_health.issue_service.DuplicateDetector'), \
             patch('backend.services.data_health.issue_service.PendingDetector'), \
             patch('backend.services.data_health.issue_service.SuggestionService', return_value=mock_suggestion_service):
            
            service = IssueService(mock_session)
            counts = service.get_counts()
            
            # Verify SuggestionService.get_suggestions() was called
            mock_suggestion_service.get_suggestions.assert_called_once()
            assert counts.bundle_suggestions == 2


@pytest.mark.unit
class TestDetectorInitialization:
    """Test that detectors are properly initialized."""
    
    def test_issue_service_creates_all_detectors(self, mock_session):
        """Test that IssueService creates all required detectors."""
        with patch('backend.services.data_health.issue_service.LinkageIssueDetector') as mock_linkage, \
             patch('backend.services.data_health.issue_service.TransferIssueDetector') as mock_transfer, \
             patch('backend.services.data_health.issue_service.DuplicateDetector') as mock_duplicate, \
             patch('backend.services.data_health.issue_service.PendingDetector') as mock_pending, \
             patch('backend.services.data_health.issue_service.SuggestionService') as mock_suggestion:
            
            service = IssueService(mock_session)
            
            # Verify all detectors were instantiated with session
            mock_linkage.assert_called_once_with(mock_session)
            mock_transfer.assert_called_once_with(mock_session)
            mock_duplicate.assert_called_once_with(mock_session)
            mock_pending.assert_called_once_with(mock_session)
            mock_suggestion.assert_called_once_with(mock_session)
    
    def test_detectors_receive_session(self, mock_session):
        """Test that all detectors receive the session in their constructor."""
        with patch('backend.services.data_health.issue_service.LinkageIssueDetector') as mock_linkage, \
             patch('backend.services.data_health.issue_service.TransferIssueDetector') as mock_transfer, \
             patch('backend.services.data_health.issue_service.DuplicateDetector') as mock_duplicate, \
             patch('backend.services.data_health.issue_service.PendingDetector') as mock_pending, \
             patch('backend.services.data_health.issue_service.SuggestionService'):
            
            IssueService(mock_session)
            
            # Verify session was passed to each detector
            for mock_detector_class in [mock_linkage, mock_transfer, mock_duplicate, mock_pending]:
                call_args = mock_detector_class.call_args
                assert call_args[0][0] is mock_session


@pytest.mark.unit
class TestIssueServiceEdgeCases:
    """Test edge cases and error handling."""
    
    def test_get_counts_with_zero_results(self, mock_session):
        """Test get_counts() when all detectors return 0."""
        mock_linkage = MagicMock(spec=LinkageIssueDetector)
        mock_linkage.count.return_value = 0
        
        mock_transfer = MagicMock(spec=TransferIssueDetector)
        mock_transfer.count.return_value = 0
        
        mock_duplicate = MagicMock(spec=DuplicateDetector)
        mock_duplicate.count.return_value = 0
        
        mock_pending = MagicMock(spec=PendingDetector)
        mock_pending.count.return_value = 0
        
        with patch('backend.services.data_health.issue_service.LinkageIssueDetector', return_value=mock_linkage), \
             patch('backend.services.data_health.issue_service.TransferIssueDetector', return_value=mock_transfer), \
             patch('backend.services.data_health.issue_service.DuplicateDetector', return_value=mock_duplicate), \
             patch('backend.services.data_health.issue_service.PendingDetector', return_value=mock_pending), \
             patch('backend.services.data_health.issue_service.SuggestionService'):
            
            service = IssueService(mock_session)
            counts = service.get_counts()
            
            assert counts.linkage_issues == 0
            assert counts.transfer_issues == 0
            assert counts.duplicates == 0
            assert counts.pending_reviews == 0
    
    def test_get_counts_with_empty_account_list(self, mock_session):
        """Test get_counts() with empty account_ids list."""
        mock_linkage = MagicMock(spec=LinkageIssueDetector)
        mock_linkage.count.return_value = 0
        
        with patch('backend.services.data_health.issue_service.LinkageIssueDetector', return_value=mock_linkage), \
             patch('backend.services.data_health.issue_service.TransferIssueDetector'), \
             patch('backend.services.data_health.issue_service.DuplicateDetector'), \
             patch('backend.services.data_health.issue_service.PendingDetector'), \
             patch('backend.services.data_health.issue_service.SuggestionService'):
            
            service = IssueService(mock_session)
            counts = service.get_counts(account_ids=[])
            
            # Verify empty list was passed to detector
            mock_linkage.count.assert_called_once_with(
                [], False,
                issue_types=mock_linkage.ASSET_ISSUE_TYPES,
            )
    
    def test_get_health_summary_with_mixed_filters(self, mock_session):
        """Test get_health_summary() with both account_ids and include_dismissed."""
        mock_linkage = MagicMock(spec=LinkageIssueDetector)
        mock_linkage.count.return_value = 10
        
        mock_transfer = MagicMock(spec=TransferIssueDetector)
        mock_transfer.count.return_value = 5
        
        mock_duplicate = MagicMock(spec=DuplicateDetector)
        mock_duplicate.count.return_value = 3
        
        mock_pending = MagicMock(spec=PendingDetector)
        mock_pending.count.return_value = 2
        
        with patch('backend.services.data_health.issue_service.LinkageIssueDetector', return_value=mock_linkage), \
             patch('backend.services.data_health.issue_service.TransferIssueDetector', return_value=mock_transfer), \
             patch('backend.services.data_health.issue_service.DuplicateDetector', return_value=mock_duplicate), \
             patch('backend.services.data_health.issue_service.PendingDetector', return_value=mock_pending), \
             patch('backend.services.data_health.issue_service.SuggestionService'):
            
            service = IssueService(mock_session)
            account_ids = [1, 2]
            summary = service.get_health_summary(account_ids=account_ids, include_dismissed=True)
            
            # Verify filters were applied
            mock_linkage.count.assert_called_once_with(
                account_ids, True,
                issue_types=mock_linkage.ASSET_ISSUE_TYPES,
            )
            mock_transfer.count.assert_called_once_with(account_ids, True)
            mock_duplicate.count.assert_called_once_with(account_ids, True)
            mock_pending.count.assert_called_once_with(account_ids, True)
            
            # Verify total calculation
            assert summary.total_issues == 20  # 10 + 5 + 3 + 2 + 0
