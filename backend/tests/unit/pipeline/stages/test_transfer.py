"""
Unit tests for AccountResolutionStage.
"""


from backend.services.pipeline import AccountResolutionStage, PipelineContext


class TestAccountResolutionStage:
    """Tests for AccountResolutionStage."""

    def test_account_resolution_stage_name(self):
        """Test account resolution stage has correct name."""
        stage = AccountResolutionStage()
        assert stage.name == "account_resolution"

    def test_account_resolution_respects_skip_flag(self, mock_session):
        """Test account resolution stage can be skipped."""
        stage = AccountResolutionStage()
        context = PipelineContext(session=mock_session, skip_transfer_detection=True)

        assert stage.should_skip(context) is True

    def test_account_resolution_does_not_skip_by_default(self, mock_session):
        """Test account resolution stage runs by default."""
        stage = AccountResolutionStage()
        context = PipelineContext(session=mock_session)

        assert stage.should_skip(context) is False

    def test_account_resolution_passes_through(self, mock_session, sample_transaction):
        """Test account resolution passes through transactions."""
        stage = AccountResolutionStage()
        context = PipelineContext(session=mock_session, source="test")

        transactions, success = stage.process([sample_transaction], context)

        assert success is True
        assert len(transactions) == 1
