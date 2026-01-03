"""
Unit tests for TransactionPipeline.
"""

from backend.services.pipeline import (
    TransactionPipeline,
    PipelineContext,
    PipelineStage,
    create_default_pipeline,
)


class TestTransactionPipeline:
    """Tests for TransactionPipeline class."""

    def test_pipeline_creation(self, mock_session):
        """Test pipeline can be created with session."""
        pipeline = TransactionPipeline(mock_session)

        assert pipeline.session == mock_session
        assert len(pipeline.stages) == 0

    def test_add_stage(self, mock_session):
        """Test adding stages to pipeline."""
        pipeline = TransactionPipeline(mock_session)

        # Create mock stage
        class MockStage(PipelineStage):
            @property
            def name(self):
                return "mock"

            def process(self, transactions, context):
                return transactions, True

        pipeline.add_stage(MockStage())
        assert len(pipeline.stages) == 1

    def test_add_stage_chaining(self, mock_session):
        """Test that add_stage returns self for chaining."""
        pipeline = TransactionPipeline(mock_session)

        class MockStage(PipelineStage):
            @property
            def name(self):
                return "mock"

            def process(self, transactions, context):
                return transactions, True

        result = pipeline.add_stage(MockStage())
        assert result is pipeline

    def test_process_single_transaction(self, mock_session, sample_transaction):
        """Test processing a single transaction."""
        pipeline = TransactionPipeline(mock_session)

        # Add a pass-through stage
        class PassThroughStage(PipelineStage):
            @property
            def name(self):
                return "passthrough"

            def process(self, transactions, context):
                return transactions, True

        pipeline.add_stage(PassThroughStage())

        context = PipelineContext(session=mock_session)
        result = pipeline.process(sample_transaction, context)

        assert result.success is True
        assert len(result.pydantic_transactions) == 1

    def test_pipeline_respects_stage_order(self, mock_session, sample_transaction):
        """Test that stages are executed in order."""
        execution_order = []

        class OrderedStage(PipelineStage):
            def __init__(self, name_val):
                self._name = name_val

            @property
            def name(self):
                return self._name

            def process(self, transactions, context):
                execution_order.append(self._name)
                return transactions, True

        pipeline = TransactionPipeline(mock_session)
        pipeline.add_stage(OrderedStage("first"))
        pipeline.add_stage(OrderedStage("second"))
        pipeline.add_stage(OrderedStage("third"))

        context = PipelineContext(session=mock_session)
        pipeline.process(sample_transaction, context)

        assert execution_order == ["first", "second", "third"]

    def test_pipeline_stops_on_stage_failure(self, mock_session, sample_transaction):
        """Test pipeline stops when a stage fails."""
        execution_order = []

        class SuccessStage(PipelineStage):
            @property
            def name(self):
                return "success"

            def process(self, transactions, context):
                execution_order.append("success")
                return transactions, True

        class FailStage(PipelineStage):
            @property
            def name(self):
                return "fail"

            def process(self, transactions, context):
                execution_order.append("fail")
                return transactions, False

        pipeline = TransactionPipeline(mock_session)
        pipeline.add_stage(SuccessStage())
        pipeline.add_stage(FailStage())
        pipeline.add_stage(SuccessStage())  # Should not execute

        context = PipelineContext(session=mock_session)
        result = pipeline.process(sample_transaction, context)

        assert result.success is False
        assert execution_order == ["success", "fail"]

    def test_pipeline_skips_stage_when_configured(
        self, mock_session, sample_transaction
    ):
        """Test that stages can be skipped based on context."""

        class SkippableStage(PipelineStage):
            def __init__(self):
                self.was_called = False

            @property
            def name(self):
                return "skippable"

            def process(self, transactions, context):
                self.was_called = True
                return transactions, True

            def should_skip(self, context):
                return context.skip_persistence

        pipeline = TransactionPipeline(mock_session)
        skippable = SkippableStage()
        pipeline.add_stage(skippable)

        context = PipelineContext(session=mock_session, skip_persistence=True)
        pipeline.process(sample_transaction, context)

        assert skippable.was_called is False

    def test_pipeline_handles_stage_exception(self, mock_session, sample_transaction):
        """Test pipeline handles exceptions from stages."""

        class ExceptionStage(PipelineStage):
            @property
            def name(self):
                return "exception"

            def process(self, transactions, context):
                raise ValueError("Test error")

        pipeline = TransactionPipeline(mock_session)
        pipeline.add_stage(ExceptionStage())

        context = PipelineContext(session=mock_session)
        result = pipeline.process(sample_transaction, context)

        assert result.success is False
        assert len(result.errors) > 0
        assert "exception" in result.errors[0].lower()


class TestCreateDefaultPipeline:
    """Tests for create_default_pipeline factory function."""

    def test_default_pipeline_has_all_stages(self, mock_session):
        """Test default pipeline includes all expected stages.

        Note: SplitStage and LegExpansionStage are deprecated.
        Leg expansion is now done at P&L engine level via prepare_transactions_for_pnl().
        """
        pipeline = create_default_pipeline(mock_session)

        assert len(pipeline.stages) == 3

        stage_names = [s.name for s in pipeline.stages]
        assert "transfer_detection" in stage_names
        assert "asset_enrichment" in stage_names
        assert "persistence" in stage_names

    def test_default_pipeline_stage_order(self, mock_session):
        """Test default pipeline has correct stage order."""
        pipeline = create_default_pipeline(mock_session)

        stage_names = [s.name for s in pipeline.stages]
        assert stage_names == [
            "transfer_detection",
            "asset_enrichment",
            "persistence",
        ]

    def test_default_pipeline_runs_successfully(self, mock_session):
        """Test that the default pipeline can be constructed."""
        pipeline = create_default_pipeline(mock_session)
        assert pipeline is not None
        assert len(pipeline.stages) == 3
