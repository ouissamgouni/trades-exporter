"""
Tests for P&L Engine persistence methods.

Tests cover:
- persist_results() with different statuses
- save_draft() and commit_draft()
- discard_draft()
"""

import pytest
from datetime import datetime, timedelta
from decimal import Decimal
from unittest.mock import Mock, MagicMock, patch

from backend.services.pnl.engine import PnLEngine
from backend.services.pnl.config import PnLConfig, CostMethod, LotMode, WarningType
from backend.services.pnl.models import (
    PnLResult,
)
from backend.db.models import (
    CostLot,
    ConsumedLotSlice,
    RealizedPnl,
    CalculationUnit,
    PnlWarning,
    CalculationVersion,
)


@pytest.fixture
def mock_session():
    """Mock database session."""
    session = MagicMock()
    session.get = MagicMock(return_value=None)
    session.add = MagicMock()
    session.commit = MagicMock()
    session.flush = MagicMock()
    session.delete = MagicMock()
    
    # Mock exec for queries
    mock_exec_result = MagicMock()
    mock_exec_result.all.return_value = []
    session.exec = MagicMock(return_value=mock_exec_result)
    
    return session


@pytest.fixture
def mock_price_service():
    """Mock price service."""
    service = MagicMock()
    service.get_price = MagicMock(return_value=Decimal("1"))
    return service


@pytest.fixture
def fifo_config():
    """FIFO configuration."""
    return PnLConfig(
        lot_method=CostMethod.FIFO,
        lot_mode=LotMode.LOT_TRAVEL,
        base_currency_id=1,
        base_currency_symbol="EUR",
    )


@pytest.fixture
def sample_version():
    """Sample CalculationVersion for testing."""
    version = CalculationVersion(
        version_id=123,
        description="Test P&L calculation",
        method="fifo",
        lot_mode="lot_travel",
        base_currency_id=1,
        status="draft",
    )
    return version


@pytest.fixture
def sample_result(fifo_config, sample_version):
    """Sample PnLResult for testing using SQLModel entities with proper cascade structure."""
    result = PnLResult(config=fifo_config, version=sample_version)
    
    # Create a calculation unit (this is the owner of all entities)
    unit = CalculationUnit(
        version_id=sample_version.version_id,
        unit_origin="tx:100",
        pattern="swap",
        is_taxable=True,
    )
    
    # Create and attach a cost lot (owned by unit via cascade)
    lot = CostLot(
        asset_id=3,  # ETH
        account_id=1,
        qty=Decimal("10"),
        qty_remaining=Decimal("10"),
        unit_cost_in_base=Decimal("100"),
        origin_transaction_id=101,
    )
    unit.cost_lots.append(lot)
    
    # Create and attach a consumed slice (owned by lot via cascade)
    consumed_slice = ConsumedLotSlice(
        cost_lot_id=lot.cost_lot_id,  # Will be set when lot is persisted
        quantity=Decimal("1"),
        unit_cost_in_base=Decimal("500"),
        total_cost_in_base=Decimal("500"),
    )
    lot.consumed_slices.append(consumed_slice)
    
    # Create and attach a realized P&L entry (owned by unit via cascade)
    pnl_entry = RealizedPnl(
        asset_id=2,  # BTC
        qty=Decimal("1"),
        proceeds_in_base=Decimal("2000"),
        cost_basis_in_base=Decimal("500"),
        pnl_in_base=Decimal("1500"),
        disposal_taxable=True,
        transaction_id=100,
        holding_period_days=365,
    )
    unit.realized_pnl_records.append(pnl_entry)
    
    # Create and attach a warning (owned by unit via cascade)
    warning = PnlWarning(
        warning_type=WarningType.MISSING_PRICE.value,
        message="Could not get price for asset X",
        transaction_id=102,
    )
    unit.warnings.append(warning)
    
    # Add unit to version (cascade will persist everything)
    sample_version.calculation_units.append(unit)
    
    return result


class TestPersistResults:
    """Tests for persist_results() method."""

    def test_persist_updates_version_with_draft_status(
        self,
        mock_session,
        mock_price_service,
        fifo_config,
        sample_result,
    ):
        """Test persist_results updates version with draft status by default."""
        engine = PnLEngine(mock_session, mock_price_service, fifo_config)
        version = engine.persist_results(sample_result, status="draft")
        
        # Verify version was updated with draft status
        assert sample_result.version.status == "draft"
        assert sample_result.version.expires_at is not None
        assert version.version_id == sample_result.version.version_id

    def test_persist_committed_has_no_expiry(
        self,
        mock_session,
        mock_price_service,
        fifo_config,
        sample_result,
    ):
        """Test persist_results with committed status has no expiry."""
        engine = PnLEngine(mock_session, mock_price_service, fifo_config)
        version = engine.persist_results(sample_result, status="committed")
        
        # Verify version was updated with committed status and no expiry
        assert sample_result.version.status == "committed"
        assert sample_result.version.expires_at is None

    def test_persist_updates_version_totals(
        self,
        mock_session,
        mock_price_service,
        fifo_config,
        sample_result,
    ):
        """Test persist_results saves entities which cascade from version."""
        engine = PnLEngine(mock_session, mock_price_service, fifo_config)
        engine.persist_results(sample_result, status="draft")
        
        # Verify computed properties work from cascade relationships
        assert sample_result.total_realized_pnl == Decimal("1500")  # From realized_pnl_entries
        assert len(sample_result.calculation_units) == 1  # One unit added
        assert len(sample_result.created_lots) == 1  # One lot in unit
        assert len(sample_result.warnings) == 1  # One warning in unit
        
        # Verify session methods were called
        mock_session.add.assert_called_with(sample_result.version)
        mock_session.commit.assert_called()

    def test_persist_raises_without_version(
        self,
        mock_session,
        mock_price_service,
        fifo_config,
    ):
        """Test persist_results raises if PnLResult has no version."""
        result = PnLResult(config=fifo_config, version=None)
        
        engine = PnLEngine(mock_session, mock_price_service, fifo_config)
        with pytest.raises(ValueError, match="no version"):
            engine.persist_results(result, status="draft")


class TestSaveDraft:
    """Tests for save_draft() method."""

    def test_save_draft_calls_persist_with_draft_status(
        self,
        mock_session,
        mock_price_service,
        fifo_config,
        sample_result,
    ):
        """Test save_draft calls persist_results with status='draft'."""
        engine = PnLEngine(mock_session, mock_price_service, fifo_config)
        version = engine.save_draft(sample_result, expires_in_hours=2)
        
        assert sample_result.version.status == "draft"
        assert version.version_id == sample_result.version.version_id


class TestCommitDraft:
    """Tests for commit_draft() method."""

    def test_commit_draft_not_found(
        self, mock_session, mock_price_service, fifo_config
    ):
        """Test commit_draft returns False when version not found."""
        mock_session.get.return_value = None
        
        engine = PnLEngine(mock_session, mock_price_service, fifo_config)
        result = engine.commit_draft(999)
        
        assert result is False

    def test_commit_draft_non_draft_status(
        self, mock_session, mock_price_service, fifo_config
    ):
        """Test commit_draft returns False for non-draft version."""
        mock_version = MagicMock()
        mock_version.status = "committed"
        mock_session.get.return_value = mock_version
        
        engine = PnLEngine(mock_session, mock_price_service, fifo_config)
        result = engine.commit_draft(123)
        
        assert result is False

    def test_commit_draft_success(
        self, mock_session, mock_price_service, fifo_config
    ):
        """Test successful commit_draft."""
        mock_version = MagicMock()
        mock_version.status = "draft"
        mock_version.expires_at = datetime.utcnow() + timedelta(hours=1)
        mock_session.get.return_value = mock_version
        
        engine = PnLEngine(mock_session, mock_price_service, fifo_config)
        result = engine.commit_draft(123)
        
        assert result is True
        assert mock_version.status == "committed"
        assert mock_version.expires_at is None
        mock_session.commit.assert_called()


class TestDiscardDraft:
    """Tests for discard_draft() method."""

    def test_discard_draft_not_found(
        self, mock_session, mock_price_service, fifo_config
    ):
        """Test discard_draft returns False when version not found."""
        mock_session.get.return_value = None
        
        engine = PnLEngine(mock_session, mock_price_service, fifo_config)
        result = engine.discard_draft(999)
        
        assert result is False

    def test_discard_draft_deletes_version(
        self, mock_session, mock_price_service, fifo_config
    ):
        """Test discard_draft deletes version (cascade handles related data)."""
        mock_version = MagicMock()
        mock_version.version_id = 123
        mock_version.status = "draft"
        mock_session.get.return_value = mock_version
        
        engine = PnLEngine(mock_session, mock_price_service, fifo_config)
        result = engine.discard_draft(123)
        
        assert result is True
        # Version should be deleted (cascade handles related records)
        mock_session.delete.assert_called_with(mock_version)
        mock_session.commit.assert_called()

