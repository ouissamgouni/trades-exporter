"""
Unit tests for PipelineContext.
"""

from backend.services.pipeline import PipelineContext


class TestPipelineContext:
    """Tests for PipelineContext data class."""

    def test_context_default_values(self, mock_session):
        """Test context initializes with correct defaults."""
        context = PipelineContext(session=mock_session)

        assert context.session == mock_session
        assert context.raw_item is None
        assert context.source is None
        assert context.skip_persistence is False
        assert context.skip_split is False
        assert context.skip_transfer_detection is False
        assert context.skip_asset_enrichment is False
        assert context.created_units == []  # V2: bundles instead of groups
        assert context.errors == []
        assert context.warnings == []
        assert context.new_count == 0
        assert context.updated_count == 0
        assert context.skipped_count == 0
        assert context.split_count == 0
        assert context.transfer_count == 0

    def test_context_with_raw_item(self, mock_session):
        """Test context with raw item data."""
        raw_item = {"symbol": "BTC", "amount": 1.0}
        context = PipelineContext(
            session=mock_session,
            raw_item=raw_item,
            source="binance",
        )

        assert context.raw_item == raw_item
        assert context.source == "binance"

    def test_context_statistics_tracking(self, mock_session):
        """Test that statistics can be tracked on context."""
        context = PipelineContext(session=mock_session)

        # Simulate stage statistics updates
        context.new_count += 5
        context.updated_count += 2
        context.skipped_count += 1
        context.split_count += 3
        context.transfer_count += 1

        assert context.new_count == 5
        assert context.updated_count == 2
        assert context.skipped_count == 1
        assert context.split_count == 3
        assert context.transfer_count == 1
