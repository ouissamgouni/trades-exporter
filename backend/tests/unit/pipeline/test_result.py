"""
Unit tests for PipelineResult.
"""

from backend.services.pipeline import PipelineResult
from backend.services.pipeline.context import PersistenceResult


class TestPipelineResult:
    """Tests for PipelineResult data class."""

    def test_result_success(self):
        """Test successful result creation."""
        result = PipelineResult(
            success=True,
            transactions=[],
            pydantic_transactions=[],
            units=[],  # V2: bundles instead of groups
            errors=[],
            warnings=[],
            new_count=5,
        )

        assert result.success is True
        assert result.new_count == 5
        assert len(result.errors) == 0

    def test_result_with_errors(self):
        """Test result with errors."""
        result = PipelineResult(
            success=False,
            transactions=[],
            pydantic_transactions=[],
            units=[],  # V2: bundles instead of groups
            errors=["Database connection failed", "Validation error"],
            warnings=["Asset not found"],
        )

        assert result.success is False
        assert len(result.errors) == 2
        assert len(result.warnings) == 1

    def test_result_statistics_defaults(self):
        """Test result statistics have correct defaults."""
        result = PipelineResult(
            success=True,
            transactions=[],
            pydantic_transactions=[],
            units=[],  # V2: bundles instead of groups
            errors=[],
            warnings=[],
        )

        assert result.new_count == 0
        assert result.updated_count == 0
        assert result.skipped_count == 0
        assert result.split_count == 0
        assert result.transfer_count == 0
        assert result.persistence_result is None

    def test_result_with_persistence_result(self):
        """Test result with persistence tracking data."""
        persistence = PersistenceResult(
            synced_ids=["tx1", "tx2"],
            updated_ids=["tx3"],
            skipped_ids=["tx4"],
            error_details=[],
        )

        result = PipelineResult(
            success=True,
            transactions=[],
            pydantic_transactions=[],
            units=[],
            errors=[],
            warnings=[],
            new_count=2,
            updated_count=1,
            skipped_count=1,
            persistence_result=persistence,
        )

        assert result.persistence_result is not None
        assert len(result.persistence_result.synced_ids) == 2
        assert len(result.persistence_result.updated_ids) == 1
        assert len(result.persistence_result.skipped_ids) == 1
