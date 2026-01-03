"""
Unit tests for AssetEnrichmentStage.
"""

from backend.services.pipeline import AssetEnrichmentStage, PipelineContext


class TestAssetEnrichmentStage:
    """Tests for AssetEnrichmentStage."""

    def test_asset_enrichment_stage_name(self):
        """Test asset enrichment stage has correct name."""
        stage = AssetEnrichmentStage()
        assert stage.name == "asset_enrichment"

    def test_asset_enrichment_respects_skip_flag(self, mock_session):
        """Test asset enrichment stage can be skipped."""
        stage = AssetEnrichmentStage()
        context = PipelineContext(session=mock_session, skip_asset_enrichment=True)

        assert stage.should_skip(context) is True

    def test_asset_enrichment_does_not_skip_by_default(self, mock_session):
        """Test asset enrichment stage runs by default."""
        stage = AssetEnrichmentStage()
        context = PipelineContext(session=mock_session)

        assert stage.should_skip(context) is False

    def test_asset_enrichment_warns_without_source(self, mock_session):
        """Test asset enrichment adds warning when no source available."""
        from datetime import datetime
        from backend.db.models import NormalizedTransaction

        # Create transaction without source (use empty string since source is required)
        tx = NormalizedTransaction(
            source="",  # Empty source
            source_transaction_id="test_123",
            source_asset_symbol="BTC",
            date_time=datetime(2024, 1, 15, 10, 0, 0),
            direction="inflow",
            transaction_type="deposit",
            quantity=1.0,
        )

        stage = AssetEnrichmentStage()
        context = PipelineContext(session=mock_session, source=None)

        transactions, success = stage.process([tx], context)

        assert success is True
        assert len(context.warnings) > 0
