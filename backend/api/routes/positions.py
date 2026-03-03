"""
API routes for derivative positions.
"""

from typing import List, Optional
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select, col
from sqlalchemy import cast, Integer

from backend.db.database import get_session_dependency
from backend.db.models import DerivativePosition, NormalizedTransaction
from backend.api.schemas import DerivativePositionResponse, TransactionResponse

router = APIRouter(prefix="/positions", tags=["Positions"])


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------


def _enrich_position(pos: DerivativePosition) -> dict:
    """Add computed fields to a position dict."""
    data = {
        "id": pos.id,
        "account_id": pos.account_id,
        "exchange": pos.exchange,
        "coin": pos.coin,
        "side": pos.side,
        "status": pos.status,
        "entry_price": pos.entry_price,
        "exit_price": pos.exit_price,
        "size": pos.size,
        "remaining_size": pos.remaining_size,
        "margin_currency": pos.margin_currency,
        "realized_pnl": pos.realized_pnl,
        "total_fees": pos.total_fees,
        "opened_at": pos.opened_at,
        "closed_at": pos.closed_at,
        "open_transaction_id": pos.open_transaction_id,
        "close_transaction_ids": pos.close_transaction_ids or [],
    }

    # Computed: net_pnl
    rpnl = pos.realized_pnl or Decimal(0)
    fees = pos.total_fees or Decimal(0)
    data["net_pnl"] = float(rpnl - fees)

    # Computed: duration_hours
    if pos.closed_at and pos.opened_at:
        delta = pos.closed_at - pos.opened_at
        data["duration_hours"] = round(delta.total_seconds() / 3600, 2)
    else:
        data["duration_hours"] = None

    # Computed: return_pct
    entry = pos.entry_price or Decimal(0)
    size = pos.size or Decimal(0)
    notional = entry * size
    if notional > 0:
        data["return_pct"] = round(float(rpnl / notional * 100), 4)
    else:
        data["return_pct"] = None

    return data


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------


@router.get("/", response_model=List[DerivativePositionResponse])
def list_positions(
    account_id: Optional[int] = Query(None),
    coin: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    exchange: Optional[str] = Query(None),
    transaction_id: Optional[int] = Query(
        None, description="Find position linked to this transaction (open or close)"
    ),
    sort_by: str = Query("opened_at", description="Sort field"),
    sort_dir: str = Query("desc", description="Sort direction: asc or desc"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session_dependency),
):
    """List derivative positions with optional filters."""
    stmt = select(DerivativePosition)

    if account_id is not None:
        stmt = stmt.where(DerivativePosition.account_id == account_id)
    if coin is not None:
        stmt = stmt.where(DerivativePosition.coin == coin)
    if status is not None:
        stmt = stmt.where(DerivativePosition.status == status)
    if exchange is not None:
        stmt = stmt.where(DerivativePosition.exchange == exchange)

    # transaction_id filter: matches open_transaction_id OR is in close_transaction_ids JSONB
    if transaction_id is not None:
        from sqlalchemy import or_, text

        stmt = stmt.where(
            or_(
                DerivativePosition.open_transaction_id == transaction_id,
                # JSONB containment: close_transaction_ids @> '[tx_id]'
                text(
                    "derivative_positions.close_transaction_ids @> :tx_json"
                ).bindparams(tx_json=f"[{transaction_id}]"),
            )
        )

    # Sorting
    sort_column = getattr(DerivativePosition, sort_by, DerivativePosition.opened_at)
    if sort_dir == "asc":
        stmt = stmt.order_by(sort_column.asc())
    else:
        stmt = stmt.order_by(sort_column.desc())

    stmt = stmt.offset(offset).limit(limit)
    positions = session.exec(stmt).all()

    return [DerivativePositionResponse(**_enrich_position(p)) for p in positions]


@router.get("/{position_id}", response_model=DerivativePositionResponse)
def get_position(
    position_id: int,
    session: Session = Depends(get_session_dependency),
):
    """Get a single derivative position with linked transactions."""
    position = session.get(DerivativePosition, position_id)
    if position is None:
        raise HTTPException(status_code=404, detail="Position not found")

    data = _enrich_position(position)

    # Fetch open transaction
    if position.open_transaction_id:
        open_tx = session.get(NormalizedTransaction, position.open_transaction_id)
        if open_tx:
            data["open_transaction"] = TransactionResponse.model_validate(open_tx)

    # Fetch close transactions
    close_ids = position.close_transaction_ids or []
    if close_ids:
        close_txs = session.exec(
            select(NormalizedTransaction).where(
                col(NormalizedTransaction.id).in_(close_ids)
            )
        ).all()
        data["close_transactions"] = [
            TransactionResponse.model_validate(tx) for tx in close_txs
        ]

    return DerivativePositionResponse(**data)
