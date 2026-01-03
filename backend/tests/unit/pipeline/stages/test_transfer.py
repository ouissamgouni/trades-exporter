"""
Unit tests for TransferDetectionStage.
"""


from backend.services.pipeline import TransferDetectionStage, PipelineContext


class TestTransferDetectionStage:
    """Tests for TransferDetectionStage."""

    def test_transfer_detection_stage_name(self):
        """Test transfer detection stage has correct name."""
        stage = TransferDetectionStage()
        assert stage.name == "transfer_detection"

    def test_transfer_detection_respects_skip_flag(self, mock_session):
        """Test transfer detection stage can be skipped."""
        stage = TransferDetectionStage()
        context = PipelineContext(session=mock_session, skip_transfer_detection=True)

        assert stage.should_skip(context) is True

    def test_transfer_detection_does_not_skip_by_default(self, mock_session):
        """Test transfer detection stage runs by default."""
        stage = TransferDetectionStage()
        context = PipelineContext(session=mock_session)

        assert stage.should_skip(context) is False

    def test_transfer_detection_passes_through(self, mock_session, sample_transaction):
        """Test transfer detection passes through transactions."""
        stage = TransferDetectionStage()
        context = PipelineContext(session=mock_session, source="test")

        transactions, success = stage.process([sample_transaction], context)

        assert success is True
        assert len(transactions) == 1
