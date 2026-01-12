"""
Tests for P&L Units API endpoint with new data structure.

Tests cover the refactored response format:
- transactions: Dict[int, TransactionSummary]
- legs: List[LegWithTransaction] with leg_type and transaction_id
"""

import pytest
from datetime import datetime
from decimal import Decimal
from unittest.mock import patch, MagicMock


@pytest.fixture
def client():
    """Create test client."""
    from fastapi.testclient import TestClient
    from backend.api.main import app
    return TestClient(app)


@pytest.fixture
def mock_session():
    """Create mock database session."""
    with patch("backend.api.routes.pnl.get_session_dependency") as mock:
        session = MagicMock()
        mock.return_value = session
        yield session


@pytest.fixture
def mock_version():
    """Create mock CalculationVersion."""
    version = MagicMock()
    version.version_id = 123
    version.status = "committed"
    version.method = "FIFO"
    version.lot_mode = "LOT_TRAVEL"
    version.base_currency_id = 1
    version.allow_negative_balances = False
    version.residual_tolerance_pct = Decimal("0.05")
    version.account_ids = None
    version.created_at = datetime(2025, 1, 1)
    version.expires_at = None
    return version


@pytest.fixture
def mock_unit_with_legs():
    """Create mock CalculationUnit with legs and transactions."""
    # Mock transaction
    mock_tx = MagicMock()
    mock_tx.id = 100
    mock_tx.timestamp = datetime(2025, 1, 1, 10, 0, 0)
    mock_tx.source = "coinbase"
    mock_tx.source_transaction_id = "tx-123"
    mock_tx.platform_fee = None
    
    # Mock account
    mock_account = MagicMock()
    mock_account.id = 1
    mock_account.name = "Coinbase"
    mock_account.account_type = "CEX"
    mock_tx.account = mock_account
    mock_tx.account_id = 1
    
    # Mock assets
    mock_asset_btc = MagicMock()
    mock_asset_btc.asset_id = 1
    mock_asset_btc.symbol = "BTC"
    
    mock_asset_usd = MagicMock()
    mock_asset_usd.asset_id = 2
    mock_asset_usd.symbol = "USD"
    
    # Mock outflow leg (BTC)
    mock_leg_outflow = MagicMock()
    mock_leg_outflow.transaction_id = 100
    mock_leg_outflow.leg_type = "outflow"
    mock_leg_outflow.direction = "outflow"
    mock_leg_outflow.disposal_taxable = False
    mock_leg_outflow.quantity = Decimal("-0.5")
    mock_leg_outflow.asset = mock_asset_btc
    mock_leg_outflow.asset_id = 1
    mock_leg_outflow.transaction = mock_tx
    
    # Mock inflow leg (USD)
    mock_leg_inflow = MagicMock()
    mock_leg_inflow.transaction_id = 100
    mock_leg_inflow.leg_type = "inflow"
    mock_leg_inflow.direction = "inflow"
    mock_leg_inflow.disposal_taxable = False
    mock_leg_inflow.quantity = Decimal("25000.00")
    mock_leg_inflow.asset = mock_asset_usd
    mock_leg_inflow.asset_id = 2
    mock_leg_inflow.transaction = mock_tx
    
    # Mock calculation unit
    mock_unit = MagicMock()
    mock_unit.id = 1
    mock_unit.unit_label = "Trade: -0.5 BTC → +25000.0 USD"
    mock_unit.timestamp = datetime(2025, 1, 1, 10, 0, 0)
    mock_unit.pattern = "swap"
    mock_unit.is_taxable = True
    mock_unit.legs = [mock_leg_outflow, mock_leg_inflow]
    mock_unit.cost_lots = []
    mock_unit.consumed_slices = []
    mock_unit.realized_pnl_records = []
    mock_unit.warnings = []
    mock_unit.fee_entries = []
    mock_unit.total_realized_pnl_in_base = Decimal("0")
    
    return mock_unit


class TestGetVersionUnits:
    """Tests for GET /pnl/versions/{version_id}/units endpoint."""
    
    def test_units_response_structure(self, client, mock_session, mock_version, mock_unit_with_legs):
        """Test that units response has correct structure with deduplicated transactions."""
        # Setup mocks
        mock_session.get.return_value = mock_version
        
        response = client.get("/pnl/versions/123/units?page=1&page_size=10")
        
        assert response.status_code == 200
        data = response.json()
        
        # Check pagination structure
        assert "items" in data
        assert "total" in data
        assert "page" in data
        assert "limit" in data  # API returns 'limit', not 'page_size'
        
        # Check unit structure
        assert len(data["items"]) > 0
        unit = data["items"][0]
        
        # Check new structure
        assert "transactions" in unit, "Unit should have transactions list"
        assert "legs" in unit, "Unit should have legs array"
        
        # Verify transactions is a list (changed from dict)
        assert isinstance(unit["transactions"], list)
        
        # Verify legs is a list
        assert isinstance(unit["legs"], list)
        
        # Check leg structure
        for leg in unit["legs"]:
            assert "leg_type" in leg, "Leg should have leg_type field"
            assert "transaction_id" in leg, "Leg should reference transaction by ID"
            assert "asset" in leg
            assert "qty" in leg
            assert leg["leg_type"] in ["inflow", "outflow", "fee"]
    
    def test_transaction_deduplication(self, client, mock_session, mock_version, mock_unit_with_legs):
        """Test that transactions are deduplicated at unit level."""
        # Both legs reference the same transaction (tx_id=100)
        mock_session.get.return_value = mock_version
        
        response = client.get("/pnl/versions/123/units?page=1&page_size=10")
        
        assert response.status_code == 200
        unit = response.json()["items"][0]
        
        # Both legs reference transaction 100, but it should appear only once in the transactions list
        assert len(unit["transactions"]) == 1
        # Check that the transaction with id 100 is in the list
        assert unit["transactions"][0]["id"] == 100
        
        # Both legs should reference the same transaction_id
        assert all(leg["transaction_id"] == 100 for leg in unit["legs"])
    
    def test_leg_type_filtering(self, client, mock_session, mock_version, mock_unit_with_legs):
        """Test that legs can be filtered by leg_type."""
        mock_session.get.return_value = mock_version
        
        response = client.get("/pnl/versions/123/units?page=1&page_size=10")
        
        assert response.status_code == 200
        unit = response.json()["items"][0]
        
        # Frontend should be able to filter by leg_type
        inflow_legs = [leg for leg in unit["legs"] if leg["leg_type"] == "inflow"]
        outflow_legs = [leg for leg in unit["legs"] if leg["leg_type"] == "outflow"]
        fee_legs = [leg for leg in unit["legs"] if leg["leg_type"] == "fee"]
        
        assert len(inflow_legs) == 1
        assert len(outflow_legs) == 1
        assert len(fee_legs) == 0
