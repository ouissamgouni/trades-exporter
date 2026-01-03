"""
Unit tests for PersistenceStage.
"""


from backend.services.pipeline import PersistenceStage, PipelineContext


class TestPersistenceStage:
    """Tests for PersistenceStage."""

    def test_persistence_stage_name(self):
        """Test persistence stage has correct name."""
        stage = PersistenceStage()
        assert stage.name == "persistence"

    def test_persistence_respects_skip_flag(self, mock_session):
        """Test persistence stage can be skipped."""
        stage = PersistenceStage()
        context = PipelineContext(session=mock_session, skip_persistence=True)

        assert stage.should_skip(context) is True

    def test_persistence_does_not_skip_by_default(self, mock_session):
        """Test persistence stage runs by default."""
        stage = PersistenceStage()
        context = PipelineContext(session=mock_session)

        assert stage.should_skip(context) is False
