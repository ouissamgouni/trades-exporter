"""
Tests for Positions API routes.

Tests cover:
- GET /positions/ (list with filters)
- GET /positions/{id} (single position detail)
- Helper _enrich_position computed fields
"""

import pytest
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from unittest.mock import MagicMock

from backend.api.routes.positions import _enrich_position
from backend.db.models import DerivativePosition


# ============================================================================
# Fixtures
# ============================================================================


def _make_position(
    *,
    id=1,
    account_id=1,
    exchange="hyperliquid",
    coin="ETH",
    side="long",
    status="closed",
    entry_price=Decimal("3000"),
    exit_price=Decimal("3200"),
    size=Decimal("2.0"),
    remaining_size=Decimal("0"),
    margin_currency="USDC",
    realized_pnl=Decimal("400"),
    total_fees=Decimal("5"),
    opened_at=None,
    closed_at=None,
    open_transaction_id=42,
    close_transaction_ids=None,
) -> DerivativePosition:
    if opened_at is None:
        opened_at = datetime(2025, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
    if close_transaction_ids is None:
        close_transaction_ids = [50, 51]
    pos = DerivativePosition(
        account_id=account_id,
        exchange=exchange,
        coin=coin,
        side=side,
        status=status,
        entry_price=entry_price,
        exit_price=exit_price,
        size=size,
        remaining_size=remaining_size,
        margin_currency=margin_currency,
        realized_pnl=realized_pnl,
        total_fees=total_fees,
        opened_at=opened_at,
        closed_at=closed_at,
        open_transaction_id=open_transaction_id,
        close_transaction_ids=close_transaction_ids,
    )
    # Simulate DB id
    pos.id = id
    return pos


# ============================================================================
# _enrich_position tests
# ============================================================================


class TestEnrichPosition:
    """Test computed fields in _enrich_position helper."""

    def test_net_pnl_computed(self):
        """net_pnl = realized_pnl - total_fees."""
        pos = _make_position(realized_pnl=Decimal("400"), total_fees=Decimal("5"))
        data = _enrich_position(pos)
        assert data["net_pnl"] == 395.0

    def test_net_pnl_negative(self):
        """Net P&L can be negative when fees exceed gains."""
        pos = _make_position(realized_pnl=Decimal("-100"), total_fees=Decimal("10"))
        data = _enrich_position(pos)
        assert data["net_pnl"] == -110.0

    def test_duration_hours_computed(self):
        """duration_hours should calculate from opened_at to closed_at."""
        opened = datetime(2025, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
        closed = datetime(2025, 6, 2, 0, 0, 0, tzinfo=timezone.utc)  # 12 hours later
        pos = _make_position(opened_at=opened, closed_at=closed)
        data = _enrich_position(pos)
        assert data["duration_hours"] == 12.0

    def test_duration_hours_none_when_open(self):
        """duration_hours should be None for open positions."""
        pos = _make_position(status="open", closed_at=None)
        data = _enrich_position(pos)
        assert data["duration_hours"] is None

    def test_return_pct_computed(self):
        """return_pct = realized_pnl / (entry_price * size) * 100."""
        pos = _make_position(
            entry_price=Decimal("3000"),
            size=Decimal("2.0"),
            realized_pnl=Decimal("600"),
        )
        data = _enrich_position(pos)
        # 600 / (3000*2) * 100 = 10.0%
        assert data["return_pct"] == 10.0

    def test_return_pct_none_when_zero_notional(self):
        """return_pct should be None if entry notional is 0."""
        pos = _make_position(entry_price=Decimal("0"), size=Decimal("1"))
        data = _enrich_position(pos)
        assert data["return_pct"] is None

    def test_core_fields_passed_through(self):
        """All core fields should be present in enriched data."""
        pos = _make_position()
        data = _enrich_position(pos)

        assert data["id"] == 1
        assert data["account_id"] == 1
        assert data["exchange"] == "hyperliquid"
        assert data["coin"] == "ETH"
        assert data["side"] == "long"
        assert data["status"] == "closed"
        assert data["entry_price"] == Decimal("3000")
        assert data["exit_price"] == Decimal("3200")
        assert data["size"] == Decimal("2.0")
        assert data["remaining_size"] == Decimal("0")
        assert data["margin_currency"] == "USDC"
        assert data["open_transaction_id"] == 42
        assert data["close_transaction_ids"] == [50, 51]

    def test_negative_return_pct(self):
        """Losing position should have negative return_pct."""
        pos = _make_position(
            entry_price=Decimal("3000"),
            size=Decimal("1.0"),
            realized_pnl=Decimal("-300"),
        )
        data = _enrich_position(pos)
        # -300 / 3000 * 100 = -10.0%
        assert data["return_pct"] == -10.0
