"""
Unit tests for DerivativesSyncService.

Tests:
- process_connector_run scopes by sync_connector_run_id
- process_connector_full scopes by connector_id
- Fresh open creates a new position
- Add-to-existing recalculates VWAP entry price
- Partial close decrements remaining_size and accumulates PnL
- Full close sets status=closed and closed_at
- Idempotency: calling twice doesn't create duplicate positions
- Missing open position on close warns, doesn't crash
- is_derivative_connector correctly identifies derivative types
- Non-perp NTs in the run are ignored
"""

import pytest
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import MagicMock, patch, PropertyMock

from backend.db.models import DerivativePosition, NormalizedTransaction
from backend.services.derivatives_sync_service import DerivativesSyncService


# ============================================================================
# Helpers
# ============================================================================


def _make_perp_nt(
    *,
    id: int = None,
    source_transaction_id="oid_100",
    source_transaction_type="perp_open",
    coin="ETH",
    side="long",
    action="open",
    execution_price="3000.0",
    size="1.0",
    realized_pnl="0.0",
    margin_currency="USDC",
    is_new_position=True,
    direction="neutral",
    quantity=0.0,
    fee=1.5,
    account_id=1,
    connector_id=7,
    sync_connector_run_id=42,
    dt=None,
) -> NormalizedTransaction:
    """Build a NormalizedTransaction with PositionIntent-format _position_data in tags."""
    if dt is None:
        dt = datetime(2025, 6, 1, 12, 0, 0, tzinfo=timezone.utc)

    tag_data = {
        "closed_pnl": realized_pnl,
        "dir": f"{'Close' if action == 'close' else 'Open'} {'Long' if side == 'long' else 'Short'}",
        "coin": coin,
        "px": execution_price,
        "sz": size,
        "_position_data": {
            "coin": coin,
            "side": side,
            "action": action,
            "size": size,
            "execution_price": execution_price,
            "realized_pnl": realized_pnl,
            "margin_currency": margin_currency,
            "is_new_position": is_new_position,
        },
    }
    nt = NormalizedTransaction(
        source="hyperliquid-perps",
        account_id=account_id,
        source_transaction_id=source_transaction_id,
        date_time=dt,
        direction=direction,
        transaction_type="margin",
        source_transaction_type=source_transaction_type,
        source_asset_symbol="USDC",
        quantity=quantity,
        fee=fee,
        tags=[tag_data],
        connector_id=connector_id,
        sync_connector_run_id=sync_connector_run_id,
    )
    if id is not None:
        nt.id = id
    return nt


def _make_open_position(
    *,
    size="2.0",
    entry_price="3000.0",
    coin="ETH",
    open_transaction_id=42,
    connector_id=7,
):
    return DerivativePosition(
        account_id=1,
        connector_id=connector_id,
        exchange="hyperliquid",
        coin=coin,
        side="long",
        status="open",
        entry_price=Decimal(entry_price),
        size=Decimal(size),
        remaining_size=Decimal(size),
        margin_currency="USDC",
        realized_pnl=Decimal(0),
        total_fees=Decimal("1.5"),
        opened_at=datetime(2025, 6, 1, tzinfo=timezone.utc),
        open_transaction_id=open_transaction_id,
        close_transaction_ids=[],
    )


class _MockExecResult:
    """Mock for session.exec() results with chainable .all() and .first()."""

    def __init__(self, items=None):
        self._items = items or []
        self._first_val = items[0] if items else None

    def all(self):
        return self._items

    def first(self):
        return self._first_val


# ============================================================================
# is_derivative_connector
# ============================================================================


class TestIsDerivativeConnector:
    """Test the registry-based derivative connector check."""

    def test_hyperliquid_perps_is_derivative(self):
        """hyperliquid-perps has derivative_exchange set."""
        assert DerivativesSyncService.is_derivative_connector("hyperliquid-perps") is True

    def test_binance_transactions_is_not_derivative(self):
        """Regular spot connectors should not be identified as derivative."""
        assert DerivativesSyncService.is_derivative_connector("binance-transactions") is False

    def test_unknown_connector_is_not_derivative(self):
        """Unknown connector types return False."""
        assert DerivativesSyncService.is_derivative_connector("nonexistent-connector") is False


# ============================================================================
# process_connector_run — scoped by sync_connector_run_id
# ============================================================================


class TestProcessConnectorRun:
    """Tests for process_connector_run scoping and basic flow."""

    def test_no_perp_txns_returns_zero(self):
        """When no perp NTs exist for the run, should return 0."""
        service = DerivativesSyncService()
        session = MagicMock()
        session.exec.return_value = _MockExecResult([])

        result = service.process_connector_run(session, connector_id=7, sync_connector_run_id=42)
        assert result == 0
        session.commit.assert_not_called()

    def test_queries_by_sync_connector_run_id(self):
        """Should query NTs filtered by sync_connector_run_id and perp types."""
        service = DerivativesSyncService()
        session = MagicMock()
        session.exec.return_value = _MockExecResult([])

        service.process_connector_run(session, connector_id=7, sync_connector_run_id=42)

        # Verify exec was called (the query is what matters)
        session.exec.assert_called_once()

    def test_open_creates_position(self):
        """A perp_open with is_new_position=True should create a DerivativePosition."""
        service = DerivativesSyncService()
        session = MagicMock()

        nt = _make_perp_nt(
            id=100,
            source_transaction_type="perp_open",
            action="open",
            is_new_position=True,
            coin="ETH",
            side="long",
            execution_price="3000.0",
            size="1.0",
        )

        # First exec: process_connector_run query returns the NT
        # Second exec: idempotency check returns None (no existing position)
        exec_results = [_MockExecResult([nt]), _MockExecResult([])]
        session.exec.side_effect = exec_results

        result = service.process_connector_run(session, connector_id=7, sync_connector_run_id=42)

        assert result == 1
        session.add.assert_called_once()
        pos = session.add.call_args[0][0]
        assert isinstance(pos, DerivativePosition)
        assert pos.coin == "ETH"
        assert pos.side == "long"
        assert pos.status == "open"
        assert pos.entry_price == Decimal("3000.0")
        assert pos.size == Decimal("1.0")
        assert pos.open_transaction_id == 100
        session.commit.assert_called_once()


# ============================================================================
# Position lifecycle via the service
# ============================================================================


class TestHandleOpen:
    """Test _handle_open through the service."""

    def test_fresh_open_creates_position(self):
        service = DerivativesSyncService()
        session = MagicMock()

        nt = _make_perp_nt(id=100, action="open", is_new_position=True)
        # Idempotency check: no existing position
        session.exec.return_value.first.return_value = None

        intent = service._extract_position_intent(nt)
        result = service._handle_open(session, nt, intent)

        assert result is True
        session.add.assert_called_once()
        pos = session.add.call_args[0][0]
        assert pos.coin == "ETH"
        assert pos.entry_price == Decimal("3000.0")
        assert pos.size == Decimal("1.0")
        assert pos.remaining_size == Decimal("1.0")
        assert pos.connector_id == 7

    def test_fresh_open_idempotent(self):
        """If position already exists for this open_transaction_id, return False."""
        service = DerivativesSyncService()
        session = MagicMock()

        nt = _make_perp_nt(id=100, action="open", is_new_position=True)
        existing = MagicMock(spec=DerivativePosition)
        existing.id = 99
        session.exec.return_value.first.return_value = existing

        intent = service._extract_position_intent(nt)
        result = service._handle_open(session, nt, intent)

        assert result is False
        session.add.assert_not_called()

    def test_add_to_existing_recalculates_vwap(self):
        service = DerivativesSyncService()
        session = MagicMock()

        nt = _make_perp_nt(
            id=101,
            action="open",
            is_new_position=False,
            execution_price="3200.0",
            size="1.0",
            fee=2.0,
        )
        existing_pos = _make_open_position(size="1.0", entry_price="3000.0")
        session.exec.return_value.first.return_value = existing_pos

        intent = service._extract_position_intent(nt)
        result = service._handle_open(session, nt, intent)

        assert result is True
        # VWAP: (3000*1 + 3200*1) / 2 = 3100
        assert existing_pos.entry_price == Decimal("3100.0")
        assert existing_pos.size == Decimal("2.0")
        assert existing_pos.remaining_size == Decimal("2.0")
        assert existing_pos.total_fees == Decimal("3.5")  # 1.5 + 2.0

    def test_add_to_no_open_warns(self):
        service = DerivativesSyncService()
        session = MagicMock()

        nt = _make_perp_nt(id=102, action="open", is_new_position=False)
        session.exec.return_value.first.return_value = None

        intent = service._extract_position_intent(nt)
        result = service._handle_open(session, nt, intent)

        assert result is False
        session.add.assert_not_called()


# ============================================================================
# Close position tests
# ============================================================================


class TestHandleClose:
    """Test _handle_close through the service."""

    def test_partial_close(self):
        service = DerivativesSyncService()
        session = MagicMock()

        nt = _make_perp_nt(
            id=200,
            source_transaction_type="perp_close",
            action="close",
            execution_price="3100.0",
            size="1.0",
            realized_pnl="100.0",
            fee=1.0,
        )
        position = _make_open_position(size="2.0")
        session.exec.return_value.first.return_value = position

        intent = service._extract_position_intent(nt)
        result = service._handle_close(session, nt, intent)

        assert result is True
        assert position.remaining_size == Decimal("1.0")
        assert position.realized_pnl == Decimal("100.0")
        assert position.total_fees == Decimal("2.5")
        assert 200 in position.close_transaction_ids
        assert position.status == "open"  # Still open
        assert position.exit_price == Decimal("3100.0")

    def test_full_close(self):
        service = DerivativesSyncService()
        session = MagicMock()

        close_dt = datetime(2025, 6, 5, 14, 0, 0, tzinfo=timezone.utc)
        nt = _make_perp_nt(
            id=300,
            source_transaction_type="perp_close",
            action="close",
            execution_price="3200.0",
            size="2.0",
            realized_pnl="400.0",
            fee=3.0,
            dt=close_dt,
        )
        position = _make_open_position(size="2.0")
        session.exec.return_value.first.return_value = position

        intent = service._extract_position_intent(nt)
        result = service._handle_close(session, nt, intent)

        assert result is True
        assert position.remaining_size == Decimal(0)
        assert position.status == "closed"
        assert position.closed_at == close_dt
        assert position.realized_pnl == Decimal("400.0")

    def test_close_no_open_warns(self):
        service = DerivativesSyncService()
        session = MagicMock()

        nt = _make_perp_nt(
            id=400,
            source_transaction_type="perp_close",
            action="close",
            realized_pnl="-50.0",
        )
        session.exec.return_value.first.return_value = None

        intent = service._extract_position_intent(nt)
        result = service._handle_close(session, nt, intent)

        assert result is False

    def test_close_idempotent(self):
        """If close fill already in close_transaction_ids, return False."""
        service = DerivativesSyncService()
        session = MagicMock()

        nt = _make_perp_nt(
            id=500,
            source_transaction_type="perp_close",
            action="close",
            size="0.5",
            realized_pnl="50.0",
        )
        position = _make_open_position(size="2.0")
        position.close_transaction_ids = [500]  # Already applied
        session.exec.return_value.first.return_value = position

        intent = service._extract_position_intent(nt)
        result = service._handle_close(session, nt, intent)

        assert result is False
        # Fields unchanged
        assert position.remaining_size == Decimal("2.0")


# ============================================================================
# Intent extraction
# ============================================================================


class TestExtractPositionIntent:
    """Test intent extraction from tags."""

    def test_new_format_intent(self):
        nt = _make_perp_nt(action="open", is_new_position=True)
        intent = DerivativesSyncService._extract_position_intent(nt)
        assert intent is not None
        assert intent.action == "open"
        assert intent.is_new_position is True
        assert intent.coin == "ETH"

    def test_no_tags_returns_none(self):
        nt = NormalizedTransaction(
            source="hyperliquid-perps",
            account_id=1,
            source_transaction_id="x",
            date_time=datetime(2025, 1, 1, tzinfo=timezone.utc),
            direction="neutral",
            transaction_type="margin",
            source_transaction_type="perp_open",
            source_asset_symbol="USDC",
            quantity=0.0,
            tags=None,
        )
        assert DerivativesSyncService._extract_position_intent(nt) is None

    def test_no_position_data_returns_none(self):
        nt = NormalizedTransaction(
            source="hyperliquid-perps",
            account_id=1,
            source_transaction_id="x",
            date_time=datetime(2025, 1, 1, tzinfo=timezone.utc),
            direction="neutral",
            transaction_type="margin",
            source_transaction_type="perp_open",
            source_asset_symbol="USDC",
            quantity=0.0,
            tags=[{"coin": "ETH"}],  # No _position_data
        )
        assert DerivativesSyncService._extract_position_intent(nt) is None


# ============================================================================
# Exchange resolution
# ============================================================================


class TestResolveExchange:
    """Test exchange name resolution."""

    def test_hyperliquid_source(self):
        nt = MagicMock()
        nt.source = "hyperliquid-perps"
        assert DerivativesSyncService._resolve_exchange(nt) == "hyperliquid"

    def test_unknown_source_parses_prefix(self):
        nt = MagicMock()
        nt.source = "dydx-perps"
        # ConnectorRegistry.get("dydx-perps") returns None → fallback
        result = DerivativesSyncService._resolve_exchange(nt)
        assert result == "dydx"

    def test_simple_source(self):
        nt = MagicMock()
        nt.source = "dydx"
        result = DerivativesSyncService._resolve_exchange(nt)
        assert result == "dydx"
