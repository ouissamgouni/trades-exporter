"""
Tests for P&L Enriched Transactions API endpoint.

Tests the `GET /pnl/versions/{version_id}/enriched-transactions` endpoint
that returns transactions enriched with P&L data (unit info, realized P&L,
fees, cost lot events) for the transaction-level audit view.
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

    app.dependency_overrides[get_session_dependency] = lambda: session
    app.dependency_overrides[get_pnl_transaction_filters] = lambda: (
        PnLTransactionFilters(
            applied_filters=AppliedFilters(),
            non_owned=False,
            warnings=[],
        )
    )

    yield session
    app.dependency_overrides.clear()


@pytest.fixture
def mock_version():
    """Create mock CalculationVersion."""
    version = MagicMock()
    version.version_id = 123
    version.status = "committed"
    return version


def _make_mock_tx(
    tx_id, direction="inflow", asset_symbol="BTC", quantity="1.0", date_time=None
):
    """Helper to create a mock NormalizedTransaction."""
    tx = MagicMock()
    tx.id = tx_id
    tx.date_time = date_time or datetime(2025, 1, 15, 10, 0, 0)
    tx.source = "coinbase"
    tx.transaction_type = "trade"
    tx.source_transaction_type = "fill"
    tx.source_transaction_id = f"src-{tx_id}"
    tx.source_asset_symbol = asset_symbol
    tx.direction = direction
    tx.quantity = Decimal(quantity)
    tx.price = Decimal("50000")
    tx.total = Decimal(quantity) * Decimal("50000")
    tx.fee = None
    tx.include_fee = False
    tx.network = None
    tx.network_transaction_id = None
    tx.token_contract_address = None
    tx.review_status = "valid"
    tx.taxability_status = "unknown"
    tx.review_notes = None
    tx.source_from_account = None
    tx.source_to_account = None
    tx.from_account_id = None
    tx.to_account_id = None
    tx.raw_transaction_id = None
    tx.synced_at = None
    tx.sync_connector_run_id = None
    tx.user_calculation_unit_id = None
    tx.source_price_quote_asset_symbol = None
    tx.source_fee_quote_asset_symbol = None
    tx.tags = []

    # Relationships
    mock_account = MagicMock()
    mock_account.name = "Coinbase"
    tx.account_rel = mock_account
    tx.account_id = 1

    tx.from_account = None
    tx.to_account = None

    mock_asset = MagicMock()
    mock_asset.asset_id = 1
    mock_asset.symbol = asset_symbol
    mock_asset.label = asset_symbol
    tx.asset = mock_asset
    tx.asset_id = 1

    tx.price_quote_asset = None
    tx.price_quote_asset_id = None
    tx.fee_quote_asset = None
    tx.fee_quote_asset_id = None
    tx.attributed_asset = None

    tx.sync_connector_run = None

    # model_dump to dict
    tx.model_dump.return_value = {
        "id": tx.id,
        "date_time": tx.date_time,
        "source": tx.source,
        "transaction_type": tx.transaction_type,
        "source_transaction_type": tx.source_transaction_type,
        "source_transaction_id": tx.source_transaction_id,
        "source_asset_symbol": tx.source_asset_symbol,
        "direction": tx.direction,
        "quantity": float(tx.quantity),
        "price": float(tx.price),
        "total": float(tx.total),
        "fee": tx.fee,
        "include_fee": tx.include_fee,
        "network": tx.network,
        "network_transaction_id": tx.network_transaction_id,
        "token_contract_address": tx.token_contract_address,
        "review_status": tx.review_status,
        "taxability_status": tx.taxability_status,
        "review_notes": tx.review_notes,
        "source_from_account": tx.source_from_account,
        "source_to_account": tx.source_to_account,
        "from_account_id": tx.from_account_id,
        "to_account_id": tx.to_account_id,
        "raw_transaction_id": tx.raw_transaction_id,
        "account_id": tx.account_id,
        "asset_id": tx.asset_id,
        "price_quote_asset_id": tx.price_quote_asset_id,
        "fee_quote_asset_id": tx.fee_quote_asset_id,
        "synced_at": tx.synced_at,
        "sync_connector_run_id": tx.sync_connector_run_id,
        "user_calculation_unit_id": tx.user_calculation_unit_id,
        "source_price_quote_asset_symbol": tx.source_price_quote_asset_symbol,
        "source_fee_quote_asset_symbol": tx.source_fee_quote_asset_symbol,
        "tags": tx.tags,
    }
    return tx


def _setup_enriched_exec_chain(
    mock_session,
    transactions,
    leg_rows=None,
    rpnl_rows=None,
    fee_pnl_ids=None,
    fee_rows=None,
    event_rows=None,
    fee_assets=None,
):
    """
    Set up sequential session.exec() return values for the enriched-transactions endpoint.

    The endpoint performs these exec() calls in order:
      1. total_count query → .one() → int
      2. filtered_count query → .one() → int
      3. paginated transactions query → .all() → List[NormalizedTransaction]
      4. fr_override_tx_ids query → .all() → List[int]
      5. leg_rows query → .all() → List[Tuple]   (tx_id, unit_id, leg_type, pattern, label)
      6. rpnl_rows query → .all() → List[RealizedPnl]
      7. fee_pnl_ids query → .all() → List[int]
      8. fee_rows query → .all() → List[Tuple]   (tx_id, fee_value_in_base, asset_id)
      9. (optional) fee_assets query → .all() → List[Asset]
      10. event_rows query → .all() → List[Tuple]  (tx_id, event_type, qty_delta, lot_id)
    """
    results = []

    # 1. total_count
    total_count_result = MagicMock()
    total_count_result.one.return_value = len(transactions)
    results.append(total_count_result)

    # 2. filtered_count
    filtered_count_result = MagicMock()
    filtered_count_result.one.return_value = len(transactions)
    results.append(filtered_count_result)

    # 3. transactions
    tx_result = MagicMock()
    tx_result.all.return_value = transactions
    results.append(tx_result)

    # 4. fr_override_tx_ids
    fr_override_result = MagicMock()
    fr_override_result.all.return_value = []
    results.append(fr_override_result)

    # 5. leg_rows
    leg_result = MagicMock()
    leg_result.all.return_value = leg_rows or []
    results.append(leg_result)

    # 6. rpnl_rows
    rpnl_result = MagicMock()
    rpnl_result.all.return_value = rpnl_rows or []
    results.append(rpnl_result)

    # 7. fee_pnl_ids
    fee_pnl_result = MagicMock()
    fee_pnl_result.all.return_value = fee_pnl_ids or []
    results.append(fee_pnl_result)

    # 8. fee_rows
    fee_result = MagicMock()
    fee_result.all.return_value = fee_rows or []
    results.append(fee_result)

    # 9. fee_assets (only if fee_rows has asset_ids)
    if fee_assets is not None:
        fee_assets_result = MagicMock()
        fee_assets_result.all.return_value = fee_assets
        results.append(fee_assets_result)

    # 10. event_rows
    event_result = MagicMock()
    event_result.all.return_value = event_rows or []
    results.append(event_result)

    mock_session.exec.side_effect = results


class TestEnrichedTransactionsBasicResponse:
    """Test 1: Basic response shape."""

    def test_response_shape(self, client, mock_session, mock_version):
        """GET enriched-transactions returns TransactionListResponse shape with enrichment fields."""
        mock_session.get.return_value = mock_version

        tx1 = _make_mock_tx(100, direction="outflow")
        tx2 = _make_mock_tx(101, direction="inflow")

        leg_rows = [
            (100, 1, "outflow", "swap", "Trade: BTC→USD"),
            (101, 1, "inflow", "swap", "Trade: BTC→USD"),
        ]

        _setup_enriched_exec_chain(mock_session, [tx1, tx2], leg_rows=leg_rows)

        response = client.get("/pnl/versions/123/enriched-transactions")
        assert response.status_code == 200

        data = response.json()

        # Check TransactionListResponse shape
        assert "results" in data
        assert "metadata" in data
        assert "total_count" in data["metadata"]
        assert "filtered_count" in data["metadata"]
        assert "limit" in data["metadata"]
        assert "offset" in data["metadata"]

        assert len(data["results"]) == 2

        # Check enrichment fields on each result
        for tx in data["results"]:
            assert "unit_id" in tx
            assert "unit_pattern" in tx
            assert "unit_label" in tx
            assert "realized_entries" in tx
            assert "realized_pnl_in_base" in tx
            assert "fee_entries" in tx
            assert "total_fees_in_base" in tx
            assert "cost_lot_event_summary" in tx
            assert "is_disposal_taxable" in tx

        # Check unit info
        assert data["results"][0]["unit_id"] == 1
        assert data["results"][0]["unit_pattern"] == "swap"


class TestEnrichedTransactionsPnlOnDisposalLeg:
    """Test 2: Realized P&L appears on the disposal transaction."""

    def test_pnl_on_disposal_only(self, client, mock_session, mock_version):
        """Only the disposal (outflow) transaction should have realized_pnl_in_base."""
        mock_session.get.return_value = mock_version

        tx_outflow = _make_mock_tx(100, direction="outflow")
        tx_inflow = _make_mock_tx(101, direction="inflow")

        leg_rows = [
            (100, 1, "outflow", "swap", "Trade: BTC→USD"),
            (101, 1, "inflow", "swap", "Trade: BTC→USD"),
        ]

        # Realized P&L entry linked to the outflow transaction
        mock_rpnl = MagicMock()
        mock_rpnl.pnl_id = 1
        mock_rpnl.transaction_id = 100  # outflow tx
        mock_rpnl.asset = MagicMock(asset_id=1, symbol="BTC", label="Bitcoin")
        mock_rpnl.qty = Decimal("0.5")
        mock_rpnl.proceeds_in_base = Decimal("25000")
        mock_rpnl.cost_basis_in_base = Decimal("20000")
        mock_rpnl.pnl_in_base = Decimal("5000")
        mock_rpnl.disposal_taxable = True
        mock_rpnl.proceeds_source = "fmv"
        mock_rpnl.proceeds_price = Decimal("50000")
        mock_rpnl.proceeds_price_source = "coingecko"
        mock_rpnl.proceeds_price_timestamp = None

        _setup_enriched_exec_chain(
            mock_session,
            [tx_outflow, tx_inflow],
            leg_rows=leg_rows,
            rpnl_rows=[mock_rpnl],
        )

        response = client.get("/pnl/versions/123/enriched-transactions")
        assert response.status_code == 200

        results = response.json()["results"]

        # Find outflow and inflow results
        outflow_tx = next(r for r in results if r["id"] == 100)
        inflow_tx = next(r for r in results if r["id"] == 101)

        # Outflow should have P&L
        assert outflow_tx["realized_pnl_in_base"] == 5000.0
        assert len(outflow_tx["realized_entries"]) == 1
        assert outflow_tx["realized_entries"][0]["pnl_in_base"] == 5000.0

        # Inflow should NOT have P&L
        assert inflow_tx["realized_pnl_in_base"] is None
        assert len(inflow_tx["realized_entries"]) == 0


class TestEnrichedTransactionsPagination:
    """Test 3: Pagination and sorting."""

    def test_pagination(self, client, mock_session, mock_version):
        """Limit/offset work correctly and metadata reflects total counts."""
        mock_session.get.return_value = mock_version

        tx1 = _make_mock_tx(100, date_time=datetime(2025, 1, 15))
        tx2 = _make_mock_tx(101, date_time=datetime(2025, 1, 14))

        # Simulate total=5 but only 2 returned due to limit
        results = []
        # total_count = 5
        tc = MagicMock()
        tc.one.return_value = 5
        results.append(tc)
        # filtered_count = 5
        fc = MagicMock()
        fc.one.return_value = 5
        results.append(fc)
        # transactions (page)
        tr = MagicMock()
        tr.all.return_value = [tx1, tx2]
        results.append(tr)
        # fr_override_tx_ids
        fo = MagicMock()
        fo.all.return_value = []
        results.append(fo)
        # leg_rows
        lr = MagicMock()
        lr.all.return_value = []
        results.append(lr)
        # rpnl_rows
        rr = MagicMock()
        rr.all.return_value = []
        results.append(rr)
        # fee_pnl_ids
        fp = MagicMock()
        fp.all.return_value = []
        results.append(fp)
        # fee_rows
        fr = MagicMock()
        fr.all.return_value = []
        results.append(fr)
        # event_rows
        er = MagicMock()
        er.all.return_value = []
        results.append(er)

        mock_session.exec.side_effect = results

        response = client.get(
            "/pnl/versions/123/enriched-transactions?limit=2&offset=0&sort_by=date_time&sort_dir=desc"
        )
        assert response.status_code == 200

        data = response.json()
        assert len(data["results"]) == 2
        assert data["metadata"]["total_count"] == 5
        assert data["metadata"]["limit"] == 2
        assert data["metadata"]["offset"] == 0


class TestEnrichedTransactionsVersionNotFound:
    """Test 4: 404 when version doesn't exist."""

    def test_version_not_found(self, client, mock_session):
        """Should return 404 for non-existent version."""
        mock_session.get.return_value = None

        response = client.get("/pnl/versions/999/enriched-transactions")
        assert response.status_code == 404


class TestEnrichedTransactionsFilterOptions:
    """Test 5: Filter options endpoint."""

    def test_filter_options_response_shape(self, client, mock_session, mock_version):
        """GET enriched-transactions/filter-options returns correct shape with tx counts."""
        mock_session.get.return_value = mock_version

        results = []
        # 1. total_tx → .one()
        tt = MagicMock()
        tt.one.return_value = 15
        results.append(tt)
        # 2. pattern_q → .all() → [(pattern, count)]
        pr = MagicMock()
        pr.all.return_value = [("swap", 10), ("flow", 5)]
        results.append(pr)
        # 3. has_realized_pnl_count → .one()
        rp = MagicMock()
        rp.one.return_value = 8
        results.append(rp)
        # 4. has_fees_count → .one()
        hf = MagicMock()
        hf.one.return_value = 3
        results.append(hf)
        # 5. has_warnings_count → .one()
        hw = MagicMock()
        hw.one.return_value = 2
        results.append(hw)
        # 6. warning_type_q → .all()
        wt = MagicMock()
        wt.all.return_value = [("missing_price", 2)]
        results.append(wt)

        mock_session.exec.side_effect = results

        response = client.get("/pnl/versions/123/enriched-transactions/filter-options")
        assert response.status_code == 200

        data = response.json()
        assert "patterns" in data
        assert "total_transactions" in data
        assert "has_realized_pnl_count" in data
        assert "has_fees_count" in data
        assert "has_warnings_count" in data
        assert "warning_types" in data

        assert len(data["patterns"]) == 2
        assert data["total_transactions"] == 15
        assert data["has_realized_pnl_count"] == 8
        assert data["has_fees_count"] == 3
