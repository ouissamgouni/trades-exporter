"""
Unit tests for DerivativePositionStage.

Tests:
- Fresh open creates a new position
- Add-to-existing recalculates VWAP entry price
- Partial close decrements remaining_size and accumulates PnL
- Full close sets status=closed and closed_at
- Missing open position logs warning on close
- Skips when skip_persistence=True
- Non-perp transactions are ignored
"""

import pytest
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import MagicMock, patch, call

from backend.db.models import DerivativePosition, NormalizedTransaction
from backend.services.pipeline.stages.derivative_position_stage import (
    DerivativePositionStage,
)
from backend.services.pipeline.context import PipelineContext


# ============================================================================
# Helpers
# ============================================================================


def _make_perp_tx(
    *,
    source_transaction_id="oid_100",
    source_transaction_type="perp_open",
    coin="ETH",
    side="long",
    entry_price="3000.0",
    size="1.0",
    closed_pnl="0.0",
    start_position="0.0",
    is_open=True,
    is_close=False,
    direction="neutral",
    quantity=0.0,
    fee=1.5,
    account_id=1,
    dt=None,
) -> NormalizedTransaction:
    """Build a NormalizedTransaction with _position_data in tags."""
    if dt is None:
        dt = datetime(2025, 6, 1, 12, 0, 0, tzinfo=timezone.utc)

    tag_data = {
        "closed_pnl": closed_pnl,
        "dir": ("Open Long" if is_open else "Close Long") if side == "long" else (
            "Open Short" if is_open else "Close Short"
        ),
        "coin": coin,
        "start_position": start_position,
        "px": entry_price,
        "sz": size,
        "_position_data": {
            "coin": coin,
            "side": side,
            "entry_price": entry_price,
            "size": size,
            "closed_pnl": closed_pnl,
            "start_position": start_position,
            "is_open": is_open,
            "is_close": is_close,
        },
    }
    return NormalizedTransaction(
        source="hyperliquid-perps",
        account_id=account_id,
        source_transaction_id=source_transaction_id,
        date_time=dt,
        direction=direction,
        transaction_type="transfer",
        source_transaction_type=source_transaction_type,
        source_asset_symbol="USDC",
        quantity=quantity,
        fee=fee,
        tags=[tag_data],
    )


def _make_db_tx(id: int, tx: NormalizedTransaction, connector_id: int = None) -> MagicMock:
    """Create a mock persisted NT with an id."""
    db_tx = MagicMock(spec=NormalizedTransaction)
    db_tx.id = id
    db_tx.account_id = tx.account_id
    db_tx.connector_id = connector_id
    db_tx.date_time = tx.date_time
    db_tx.source = tx.source
    db_tx.source_transaction_id = tx.source_transaction_id
    db_tx.source_asset_symbol = tx.source_asset_symbol
    db_tx.fee = tx.fee
    return db_tx


def _make_mock_session(db_tx=None, open_position=None):
    """Create a mock session with configurable query results."""
    session = MagicMock()

    def exec_side_effect(stmt):
        result = MagicMock()
        # We need different results for NT lookup vs position lookup
        # First call is always NT lookup, second is position lookup
        return result

    session.exec.return_value.first.side_effect = [db_tx, open_position]
    return session


# ============================================================================
# Stage basics
# ============================================================================


class TestDerivativePositionStageBasics:
    """Test basic stage properties and skip logic."""

    def test_stage_name(self):
        stage = DerivativePositionStage()
        assert stage.name == "derivative_position"

    def test_should_skip_when_persistence_skipped(self):
        stage = DerivativePositionStage()
        session = MagicMock()
        ctx = PipelineContext(session=session, skip_persistence=True)
        assert stage.should_skip(ctx) is True

    def test_should_not_skip_by_default(self):
        stage = DerivativePositionStage()
        session = MagicMock()
        ctx = PipelineContext(session=session)
        assert stage.should_skip(ctx) is False

    def test_ignores_non_perp_transactions(self):
        """Transactions without perp source types should be ignored entirely."""
        stage = DerivativePositionStage()
        session = MagicMock()
        ctx = PipelineContext(session=session)

        tx = NormalizedTransaction(
            source="binance",
            account_id=1,
            source_transaction_id="deposit_1",
            date_time=datetime(2025, 1, 1, tzinfo=timezone.utc),
            direction="inflow",
            transaction_type="deposit",
            source_transaction_type="deposit",
            source_asset_symbol="USDC",
            quantity=100.0,
        )

        result_txns, should_continue = stage.process([tx], ctx)
        assert should_continue is True
        assert result_txns == [tx]
        # Session should not have been queried
        session.exec.assert_not_called()
        session.commit.assert_not_called()


# ============================================================================
# Open position tests
# ============================================================================


class TestDerivativePositionOpen:
    """Test opening new and adding to existing positions."""

    def test_fresh_open_creates_position(self):
        """perp_open with start_position=0 creates a new DerivativePosition."""
        stage = DerivativePositionStage()
        session = MagicMock()

        tx = _make_perp_tx(
            source_transaction_type="perp_open",
            coin="ETH",
            side="long",
            entry_price="3000.0",
            size="1.0",
            start_position="0.0",
            is_open=True,
            is_close=False,
        )
        db_tx = _make_db_tx(id=42, tx=tx, connector_id=7)

        # NT lookup returns db_tx, then idempotency check returns None (no existing position)
        session.exec.return_value.first.side_effect = [db_tx, None]

        ctx = PipelineContext(session=session)
        stage.process([tx], ctx)

        # Should have called session.add with a DerivativePosition
        session.add.assert_called_once()
        pos = session.add.call_args[0][0]
        assert isinstance(pos, DerivativePosition)
        assert pos.coin == "ETH"
        assert pos.side == "long"
        assert pos.status == "open"
        assert pos.entry_price == Decimal("3000.0")
        assert pos.size == Decimal("1.0")
        assert pos.remaining_size == Decimal("1.0")
        assert pos.realized_pnl == Decimal(0)
        assert pos.total_fees == Decimal("1.5")
        assert pos.open_transaction_id == 42
        assert pos.close_transaction_ids == []
        assert pos.connector_id == 7

        session.commit.assert_called_once()

    def test_add_to_existing_recalculates_vwap(self):
        """perp_open with start_position!=0 adds to existing and recalculates VWAP."""
        stage = DerivativePositionStage()
        session = MagicMock()

        tx = _make_perp_tx(
            source_transaction_type="perp_open",
            coin="ETH",
            side="long",
            entry_price="3200.0",
            size="1.0",
            start_position="1.0",  # non-zero → adding to existing
            is_open=True,
            is_close=False,
            fee=2.0,
        )
        db_tx = _make_db_tx(id=43, tx=tx)

        # Existing open position with size=1 @ 3000
        existing_pos = DerivativePosition(
            account_id=1,
            exchange="hyperliquid",
            coin="ETH",
            side="long",
            status="open",
            entry_price=Decimal("3000.0"),
            size=Decimal("1.0"),
            remaining_size=Decimal("1.0"),
            margin_currency="USDC",
            realized_pnl=Decimal(0),
            total_fees=Decimal("1.5"),
            opened_at=datetime(2025, 6, 1, tzinfo=timezone.utc),
            open_transaction_id=42,
            close_transaction_ids=[],
        )

        # First exec call returns db_tx (NT lookup), second returns existing_pos (position lookup)
        session.exec.return_value.first.side_effect = [db_tx, existing_pos]

        ctx = PipelineContext(session=session)
        stage.process([tx], ctx)

        # VWAP: (3000*1 + 3200*1) / 2 = 3100
        assert existing_pos.entry_price == Decimal("3100.0")
        assert existing_pos.size == Decimal("2.0")
        assert existing_pos.remaining_size == Decimal("2.0")
        assert existing_pos.total_fees == Decimal("3.5")  # 1.5 + 2.0

        # Should NOT add a new position (only update)
        session.add.assert_not_called()
        session.commit.assert_called_once()

    def test_add_to_position_no_open_warns(self):
        """Adding to a position when none is open should warn, not crash."""
        stage = DerivativePositionStage()
        session = MagicMock()

        tx = _make_perp_tx(
            source_transaction_type="perp_open",
            start_position="1.0",
            is_open=True,
            is_close=False,
        )
        db_tx = _make_db_tx(id=44, tx=tx)

        # NT lookup returns db_tx, position lookup returns None
        session.exec.return_value.first.side_effect = [db_tx, None]

        ctx = PipelineContext(session=session)
        # Should not raise
        result_txns, should_continue = stage.process([tx], ctx)
        assert should_continue is True
        session.add.assert_not_called()
        # No commit since processed=0
        session.commit.assert_not_called()


# ============================================================================
# Close position tests
# ============================================================================


class TestDerivativePositionClose:
    """Test closing positions — partial and full."""

    def _make_open_position(self, *, size="2.0", entry_price="3000.0", coin="ETH"):
        return DerivativePosition(
            account_id=1,
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
            open_transaction_id=42,
            close_transaction_ids=[],
        )

    def test_partial_close_decrements_remaining(self):
        """Partial close should reduce remaining_size, accumulate PnL, keep status=open."""
        stage = DerivativePositionStage()
        session = MagicMock()

        tx = _make_perp_tx(
            source_transaction_id="oid_200",
            source_transaction_type="perp_close",
            coin="ETH",
            side="long",
            entry_price="3100.0",  # exit price for this fill
            size="1.0",
            closed_pnl="100.0",
            is_open=False,
            is_close=True,
            direction="inflow",
            quantity=100.0,
            fee=1.0,
        )
        db_tx = _make_db_tx(id=50, tx=tx)
        position = self._make_open_position(size="2.0")

        session.exec.return_value.first.side_effect = [db_tx, position]

        ctx = PipelineContext(session=session)
        stage.process([tx], ctx)

        assert position.remaining_size == Decimal("1.0")
        assert position.realized_pnl == Decimal("100.0")
        assert position.total_fees == Decimal("2.5")  # 1.5 + 1.0
        assert 50 in position.close_transaction_ids
        assert position.status == "open"  # Still open - partial close
        assert position.exit_price == Decimal("3100.0")
        session.commit.assert_called_once()

    def test_full_close_sets_closed_status(self):
        """Closing the full remaining size should set status=closed and closed_at."""
        stage = DerivativePositionStage()
        session = MagicMock()

        close_dt = datetime(2025, 6, 5, 14, 0, 0, tzinfo=timezone.utc)
        tx = _make_perp_tx(
            source_transaction_id="oid_300",
            source_transaction_type="perp_close",
            coin="ETH",
            side="long",
            entry_price="3200.0",
            size="2.0",  # Closing full size
            closed_pnl="400.0",
            is_open=False,
            is_close=True,
            direction="inflow",
            quantity=400.0,
            fee=3.0,
            dt=close_dt,
        )
        db_tx = _make_db_tx(id=60, tx=tx)
        position = self._make_open_position(size="2.0")

        session.exec.return_value.first.side_effect = [db_tx, position]

        ctx = PipelineContext(session=session)
        stage.process([tx], ctx)

        assert position.remaining_size == Decimal(0)
        assert position.status == "closed"
        assert position.closed_at == close_dt
        assert position.realized_pnl == Decimal("400.0")
        assert 60 in position.close_transaction_ids
        session.commit.assert_called_once()

    def test_close_with_no_open_position_warns(self):
        """Closing when no open position exists should warn, not crash."""
        stage = DerivativePositionStage()
        session = MagicMock()

        tx = _make_perp_tx(
            source_transaction_type="perp_close",
            closed_pnl="-50.0",
            is_open=False,
            is_close=True,
            direction="outflow",
            quantity=50.0,
        )
        db_tx = _make_db_tx(id=70, tx=tx)

        # NT found, but no open position
        session.exec.return_value.first.side_effect = [db_tx, None]

        ctx = PipelineContext(session=session)
        result_txns, should_continue = stage.process([tx], ctx)
        assert should_continue is True
        # No commit since nothing was processed
        session.commit.assert_not_called()

    def test_close_accumulates_multiple_pnl(self):
        """Multiple close fills should accumulate PnL correctly."""
        stage = DerivativePositionStage()
        session = MagicMock()
        position = self._make_open_position(size="3.0")

        # First close: partial, profit
        tx1 = _make_perp_tx(
            source_transaction_id="oid_400",
            source_transaction_type="perp_close",
            size="1.0",
            closed_pnl="50.0",
            is_open=False,
            is_close=True,
            direction="inflow",
            quantity=50.0,
        )
        db_tx1 = _make_db_tx(id=80, tx=tx1)
        session.exec.return_value.first.side_effect = [db_tx1, position]

        ctx = PipelineContext(session=session)
        stage.process([tx1], ctx)

        assert position.remaining_size == Decimal("2.0")
        assert position.realized_pnl == Decimal("50.0")

        # Second close: partial, loss
        tx2 = _make_perp_tx(
            source_transaction_id="oid_401",
            source_transaction_type="perp_close",
            size="1.0",
            closed_pnl="-30.0",
            is_open=False,
            is_close=True,
            direction="outflow",
            quantity=30.0,
        )
        db_tx2 = _make_db_tx(id=81, tx=tx2)
        session.exec.return_value.first.side_effect = [db_tx2, position]

        stage.process([tx2], ctx)

        assert position.remaining_size == Decimal("1.0")
        assert position.realized_pnl == Decimal("20.0")  # 50 + (-30)
        assert position.close_transaction_ids == [80, 81]


# ============================================================================
# Edge cases
# ============================================================================


class TestDerivativePositionEdgeCases:
    """Test edge cases and error handling."""

    def test_missing_position_data_tag_skips(self):
        """Transaction without _position_data in tags should be skipped."""
        stage = DerivativePositionStage()
        session = MagicMock()

        tx = NormalizedTransaction(
            source="hyperliquid-perps",
            account_id=1,
            source_transaction_id="oid_500",
            date_time=datetime(2025, 1, 1, tzinfo=timezone.utc),
            direction="neutral",
            transaction_type="transfer",
            source_transaction_type="perp_open",
            source_asset_symbol="USDC",
            quantity=0.0,
            tags=[{"coin": "ETH", "closed_pnl": "0"}],  # No _position_data
        )

        ctx = PipelineContext(session=session)
        stage.process([tx], ctx)
        session.commit.assert_not_called()

    def test_no_tags_skips(self):
        """Transaction with no tags should be skipped."""
        stage = DerivativePositionStage()
        session = MagicMock()

        tx = NormalizedTransaction(
            source="hyperliquid-perps",
            account_id=1,
            source_transaction_id="oid_501",
            date_time=datetime(2025, 1, 1, tzinfo=timezone.utc),
            direction="neutral",
            transaction_type="transfer",
            source_transaction_type="perp_open",
            source_asset_symbol="USDC",
            quantity=0.0,
            tags=None,
        )

        ctx = PipelineContext(session=session)
        stage.process([tx], ctx)
        session.commit.assert_not_called()

    def test_nt_not_found_in_db_warns(self):
        """If the persisted NT isn't found, should warn and skip."""
        stage = DerivativePositionStage()
        session = MagicMock()

        tx = _make_perp_tx()
        # resolve_persisted_nt returns None
        session.exec.return_value.first.return_value = None

        ctx = PipelineContext(session=session)
        result_txns, should_continue = stage.process([tx], ctx)
        assert should_continue is True
        session.commit.assert_not_called()

    def test_exchange_from_source(self):
        """Test exchange name extraction from source string."""
        assert DerivativePositionStage._exchange_from_source("hyperliquid-perps") == "hyperliquid"
        assert DerivativePositionStage._exchange_from_source("binance-futures") == "binance"
        assert DerivativePositionStage._exchange_from_source("dydx") == "dydx"

    def test_commit_failure_adds_warning(self):
        """Commit failure should add a warning to context, not raise."""
        stage = DerivativePositionStage()
        session = MagicMock()

        tx = _make_perp_tx(
            source_transaction_type="perp_open",
            start_position="0.0",
            is_open=True,
            is_close=False,
        )
        db_tx = _make_db_tx(id=42, tx=tx)
        # NT lookup returns db_tx, then idempotency check returns None (no existing position)
        session.exec.return_value.first.side_effect = [db_tx, None]
        session.commit.side_effect = Exception("DB error")

        ctx = PipelineContext(session=session)
        result_txns, should_continue = stage.process([tx], ctx)

        assert should_continue is True
        assert len(ctx.warnings) == 1
        assert "DB error" in ctx.warnings[0]
        session.rollback.assert_called_once()


# ============================================================================
# Idempotency tests
# ============================================================================


class TestDerivativePositionIdempotency:
    """Verify that re-processing the same fills doesn't create duplicates."""

    def test_fresh_open_idempotent_on_resync(self):
        """
        If a position already exists for the same open_transaction_id,
        _handle_open should return False (no-op) instead of creating a
        duplicate.
        """
        stage = DerivativePositionStage()
        session = MagicMock()

        tx = _make_perp_tx(
            source_transaction_type="perp_open",
            start_position="0.0",
            is_open=True,
            is_close=False,
        )
        db_tx = _make_db_tx(id=42, tx=tx)

        # Simulate an existing position returned by the idempotency query
        existing_pos = MagicMock(spec=DerivativePosition)
        existing_pos.id = 99
        existing_pos.open_transaction_id = 42

        # First exec call returns the existing position for the idempotency check
        session.exec.return_value.first.return_value = existing_pos

        intent = stage._extract_position_intent(tx)
        result = stage._handle_open(session, db_tx, tx, intent)

        assert result is False  # No work done
        session.add.assert_not_called()  # No new position created

    def test_close_fill_idempotent_on_resync(self):
        """
        If a close fill's tx id is already in close_transaction_ids,
        _handle_close should return False (no-op) instead of re-applying
        the PnL and size reduction.
        """
        stage = DerivativePositionStage()
        session = MagicMock()

        tx = _make_perp_tx(
            source_transaction_type="perp_close",
            start_position="1.0",
            is_open=False,
            is_close=True,
            entry_price="3000.0",
            size="0.5",
            closed_pnl="50.0",
        )
        db_tx = _make_db_tx(id=101, tx=tx)

        # Simulate an open position where this close was already applied
        open_pos = MagicMock(spec=DerivativePosition)
        open_pos.id = 10
        open_pos.account_id = 1
        open_pos.coin = "ETH"
        open_pos.remaining_size = Decimal("0.5")
        open_pos.realized_pnl = Decimal("50.0")
        open_pos.total_fees = Decimal("3.0")
        open_pos.close_transaction_ids = [101]  # Already contains this tx
        open_pos.exit_price = Decimal("3100.0")

        session.exec.return_value.first.return_value = open_pos

        intent = stage._extract_position_intent(tx)
        result = stage._handle_close(session, db_tx, tx, intent)

        assert result is False  # No work done
        # Remaining size should be unchanged
        assert open_pos.remaining_size == Decimal("0.5")


# ============================================================================
# Chronological sorting tests
# ============================================================================


class TestDerivativePositionChronologicalSort:
    """Verify that process() sorts perp fills by date_time before iterating."""

    def test_out_of_order_fills_sorted(self):
        """
        Given fills in [close, open] order (by list position), process()
        should sort them chronologically so the open is handled first.
        """
        stage = DerivativePositionStage()
        session = MagicMock()

        open_tx = _make_perp_tx(
            source_transaction_id="oid_open",
            source_transaction_type="perp_open",
            start_position="0.0",
            is_open=True,
            is_close=False,
            dt=datetime(2025, 6, 1, 12, 0, 0, tzinfo=timezone.utc),  # earlier
        )
        close_tx = _make_perp_tx(
            source_transaction_id="oid_close",
            source_transaction_type="perp_close",
            start_position="1.0",
            is_open=False,
            is_close=True,
            entry_price="3100.0",
            size="1.0",
            closed_pnl="100.0",
            dt=datetime(2025, 6, 1, 13, 0, 0, tzinfo=timezone.utc),  # later
        )

        # Pass them deliberately out of order: close first, open second
        out_of_order = [close_tx, open_tx]

        # Track the order _handle_open and _handle_close are called
        call_order = []
        original_handle_open = stage._handle_open
        original_handle_close = stage._handle_close

        def mock_handle_open(*args, **kwargs):
            call_order.append("open")
            return False  # skip actual DB work

        def mock_handle_close(*args, **kwargs):
            call_order.append("close")
            return False  # skip actual DB work

        # Intercept DB lookup to return a mock db_tx
        mock_db_tx_open = _make_db_tx(id=10, tx=open_tx)
        mock_db_tx_close = _make_db_tx(id=11, tx=close_tx)

        def resolve_side_effect(s, tx):
            if tx.source_transaction_id == "oid_open":
                return mock_db_tx_open
            return mock_db_tx_close

        with patch.object(stage, "_handle_open", side_effect=mock_handle_open), \
             patch.object(stage, "_handle_close", side_effect=mock_handle_close), \
             patch.object(stage, "_resolve_persisted_nt", side_effect=resolve_side_effect):
            ctx = PipelineContext(session=session)
            stage.process(out_of_order, ctx)

        # The open fill (earlier datetime) must be processed before the close
        assert call_order == ["open", "close"], f"Expected [open, close] but got {call_order}"
