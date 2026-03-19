"""
Tests for P&L Units API endpoint with new data structure.

Tests cover the refactored response format:
- transactions: Dict[int, TransactionSummary]
- legs: List[LegWithTransaction] with leg_type and transaction_id
"""

import pytest
from datetime import datetime
from decimal import Decimal
from unittest.mock import MagicMock

from backend.db.database import get_session_dependency
from backend.api.routes.pnl_filter_depends import (
    get_pnl_transaction_filters,
    PnLTransactionFilters,
)
from backend.api.schemas import AppliedFilters


@pytest.fixture
def client(mock_session):
    """Create test client — must depend on mock_session so overrides are active."""
    from fastapi.testclient import TestClient
    from backend.api.main import app
    return TestClient(app)


@pytest.fixture
def mock_session():
    """Override FastAPI dependencies with a mock session."""
    from backend.api.main import app

    session = MagicMock()

    # Override the DB session dependency
    app.dependency_overrides[get_session_dependency] = lambda: session

    # Override the transaction-filter dependency (it also needs a session)
    app.dependency_overrides[get_pnl_transaction_filters] = lambda: PnLTransactionFilters(
        applied_filters=AppliedFilters(),
        non_owned=False,
        warnings=[],
    )

    yield session
    app.dependency_overrides.clear()


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
    mock_tx.date_time = datetime(2025, 1, 1, 10, 0, 0)
    mock_tx.timestamp = datetime(2025, 1, 1, 10, 0, 0)
    mock_tx.source = "coinbase"
    mock_tx.transaction_type = "trade"
    mock_tx.source_transaction_type = "fill"
    mock_tx.source_transaction_id = "tx-123"
    mock_tx.direction = "outflow"
    mock_tx.platform_fee = None
    mock_tx.source_asset_symbol = "BTC"
    mock_tx.quantity = Decimal("0.5")
    mock_tx.price = Decimal("50000.0")
    mock_tx.total = Decimal("25000.0")
    mock_tx.fee = None
    mock_tx.network = None
    mock_tx.network_transaction_id = None
    mock_tx.source_from_account = None
    mock_tx.source_to_account = None
    
    # Mock account relationship
    mock_account_rel = MagicMock()
    mock_account_rel.name = "Coinbase"
    mock_tx.account_rel = mock_account_rel
    mock_tx.account_id = 1
    
    # Mock from/to accounts
    mock_tx.from_account = None
    mock_tx.to_account = None
    
    # Mock asset relationship (tx.asset)
    mock_asset = MagicMock()
    mock_asset.asset_id = 1
    mock_asset.symbol = "BTC"
    mock_tx.asset = mock_asset
    mock_tx.asset_id = 1
    
    # Mock price_quote_asset and fee_quote_asset
    mock_tx.price_quote_asset = None
    mock_tx.price_quote_asset_id = None
    mock_tx.fee_quote_asset = None
    mock_tx.fee_quote_asset_id = None
    
    # Mock assets for legs
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


def _setup_exec_chain(mock_session, mock_units):
    """
    Set up sequential session.exec() return values for the units endpoint.

    The endpoint performs these exec() calls in order:
      1. count query  → .one() → int
      2. paginated query → .all() → List[CalculationUnit]
      3. settlements query → .all() → List[LotSettlement]
      4. events query → .all() → List[Tuple[int, int]]
      5. fee pnl ids query → .all() → List[int]
    """
    count_result = MagicMock()
    count_result.one.return_value = len(mock_units)

    units_result = MagicMock()
    units_result.all.return_value = mock_units

    settlements_result = MagicMock()
    settlements_result.all.return_value = []

    events_result = MagicMock()
    events_result.all.return_value = []

    fee_result = MagicMock()
    fee_result.all.return_value = []

    mock_session.exec.side_effect = [
        count_result,
        units_result,
        settlements_result,
        events_result,
        fee_result,
    ]


class TestGetVersionUnits:
    """Tests for GET /pnl/versions/{version_id}/units endpoint."""

    def test_units_response_structure(self, client, mock_session, mock_version, mock_unit_with_legs):
        """Test that units response has correct structure with deduplicated transactions."""
        mock_session.get.return_value = mock_version
        _setup_exec_chain(mock_session, [mock_unit_with_legs])

        response = client.get("/pnl/versions/123/units?page=1&limit=10")

        assert response.status_code == 200
        data = response.json()

        # Check pagination structure
        assert "items" in data
        assert "total" in data
        assert "page" in data
        assert "limit" in data

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
        mock_session.get.return_value = mock_version
        _setup_exec_chain(mock_session, [mock_unit_with_legs])

        response = client.get("/pnl/versions/123/units?page=1&limit=10")

        assert response.status_code == 200
        unit = response.json()["items"][0]

        # Both legs reference transaction 100, but it should appear only once
        assert len(unit["transactions"]) == 1
        assert unit["transactions"][0]["id"] == 100

        # Both legs should reference the same transaction_id
        assert all(leg["transaction_id"] == 100 for leg in unit["legs"])

    def test_leg_type_filtering(self, client, mock_session, mock_version, mock_unit_with_legs):
        """Test that legs can be filtered by leg_type."""
        mock_session.get.return_value = mock_version
        _setup_exec_chain(mock_session, [mock_unit_with_legs])

        response = client.get("/pnl/versions/123/units?page=1&limit=10")

        assert response.status_code == 200
        unit = response.json()["items"][0]

        # Frontend should be able to filter by leg_type
        inflow_legs = [leg for leg in unit["legs"] if leg["leg_type"] == "inflow"]
        outflow_legs = [leg for leg in unit["legs"] if leg["leg_type"] == "outflow"]
        fee_legs = [leg for leg in unit["legs"] if leg["leg_type"] == "fee"]

        assert len(inflow_legs) == 1
        assert len(outflow_legs) == 1
        assert len(fee_legs) == 0
