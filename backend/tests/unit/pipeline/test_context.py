"""
Unit tests for PipelineContext.
"""

from backend.services.pipeline import PipelineContext
from backend.services.pipeline.context import PersistenceResult


class TestPipelineContext:
    """Tests for PipelineContext data class."""

    def test_context_default_values(self, mock_session):
        """Test context initializes with correct defaults."""
        context = PipelineContext(session=mock_session)

        assert context.session == mock_session
        assert context.raw_item is None
        assert context.source is None
        assert context.sync_connector_run_id is None  # New field
        assert context.skip_persistence is False
        assert context.skip_split is False
        assert context.skip_transfer_detection is False
        assert context.skip_asset_enrichment is False
        assert context.created_units == []  # V2: bundles instead of groups
        assert context.errors == []
        assert context.warnings == []
        assert context.persistence_result is None  # New field
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

    def test_context_with_sync_connector_run_id(self, mock_session):
        """Test context with sync job tracking ID."""
        context = PipelineContext(
            session=mock_session,
            sync_connector_run_id=42,
        )

        assert context.sync_connector_run_id == 42

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

    def test_context_persistence_result(self, mock_session):
        """Test context can hold persistence result."""
        context = PipelineContext(session=mock_session)

        # Simulate persistence stage setting result
        context.persistence_result = PersistenceResult(
            synced_ids=["tx1", "tx2"],
            updated_ids=["tx3"],
            skipped_ids=["tx4"],
            error_details=[{"source_transaction_id": "tx5", "error": "fail"}],
        )

        assert context.persistence_result is not None
        assert len(context.persistence_result.synced_ids) == 2
        assert len(context.persistence_result.updated_ids) == 1
        assert len(context.persistence_result.error_details) == 1


class TestPersistenceResult:
    """Tests for PersistenceResult data class."""

    def test_persistence_result_defaults(self):
        """Test PersistenceResult initializes with empty lists."""
        result = PersistenceResult()

        assert result.synced_ids == []
        assert result.updated_ids == []
        assert result.skipped_ids == []
        assert result.error_details == []

    def test_persistence_result_with_data(self):
        """Test PersistenceResult with populated data."""
        result = PersistenceResult(
            synced_ids=["tx1", "tx2", "tx3"],
            updated_ids=["tx4", "tx5"],
            skipped_ids=["tx6"],
            error_details=[
                {"source_transaction_id": "tx7", "error": "Invalid amount"},
                {"source_transaction_id": "tx8", "error": "Missing asset"},
            ],
        )

        assert len(result.synced_ids) == 3
        assert "tx1" in result.synced_ids
        assert len(result.updated_ids) == 2
        assert len(result.skipped_ids) == 1
        assert len(result.error_details) == 2
        assert result.error_details[0]["error"] == "Invalid amount"
