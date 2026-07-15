"""
Unit tests for PersistenceStage.
"""

from datetime import datetime
from unittest.mock import MagicMock, patch

from backend.db.models import NormalizedTransaction
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


class TestPersistenceConnectorIdStamp:
    """
    Regression tests: connector_id must be stamped from the pipeline context
    onto NormalizedTransaction before persistence.

    Previously connector_id was only persisted for raw_transactions, leaving
    NTs with connector_id=NULL.  This broke derivative position batch
    processing which filters by connector_id.
    """

    def test_connector_id_stamped_from_context(self, mock_session):
        """
        When tx.connector_id is None and context.connector_id is set,
        the persistence stage must stamp context.connector_id onto the tx.
        """
        stage = PersistenceStage()
        context = PipelineContext(session=mock_session, connector_id=699)

        tx = NormalizedTransaction(
            source="hyperliquid-perps",
            source_transaction_id="oid_100",
            source_transaction_type="perp_open",
            source_asset_symbol="USDC",
            date_time=datetime(2025, 6, 15, 12, 0, 0),
            direction="neutral",
            transaction_type="transfer",
            quantity=0.0,
        )
        assert tx.connector_id is None

        # Mock the DB to report no existing transaction (new insert path)
        mock_session.exec.return_value.first.return_value = None

        # Patch _pydantic_to_sqlmodel to capture the tx after stamping
        original_method = stage._pydantic_to_sqlmodel

        captured_txs = []

        def capture_pydantic_to_sqlmodel(tx, *args, **kwargs):
            captured_txs.append(tx)
            return original_method(tx, *args, **kwargs)

        with patch.object(stage, "_pydantic_to_sqlmodel", side_effect=capture_pydantic_to_sqlmodel):
            stage.process([tx], context)

        # The tx should have been stamped with context.connector_id
        assert tx.connector_id == 699

    def test_connector_id_not_overwritten_if_already_set(self, mock_session):
        """
        When tx already has a connector_id, the persistence stage must NOT
        overwrite it with the context value.
        """
        stage = PersistenceStage()
        context = PipelineContext(session=mock_session, connector_id=999)

        tx = NormalizedTransaction(
            source="test",
            source_transaction_id="tx_001",
            source_transaction_type="deposit",
            source_asset_symbol="BTC",
            date_time=datetime(2025, 1, 1, 0, 0, 0),
            direction="inflow",
            transaction_type="deposit",
            quantity=1.0,
            connector_id=42,  # Already set by connector
        )

        mock_session.exec.return_value.first.return_value = None

        stage.process([tx], context)

        # Original connector_id should be preserved
        assert tx.connector_id == 42
