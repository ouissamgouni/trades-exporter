"""
Unit tests for PipelineResult.
"""

from backend.services.pipeline import PipelineResult


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
