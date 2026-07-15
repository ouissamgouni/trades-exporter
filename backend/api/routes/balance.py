"""
API routes for live balance queries.
"""

from typing import Any, Dict, List, Optional
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from backend.db.database import get_session_dependency
from backend.services.balance_service import BalanceService

router = APIRouter(prefix="/balance", tags=["balance"])


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------


def _decimal_to_str(v: Any) -> Any:
    """Convert Decimal values to strings for JSON serialisation."""
    if isinstance(v, Decimal):
        return str(v)
    return v


def _entry_to_dict(entry) -> Dict[str, Any]:
    return {
        "asset_symbol": entry.asset_symbol,
        "total": _decimal_to_str(entry.total),
        "available": _decimal_to_str(entry.available),
        "locked": _decimal_to_str(entry.locked),
        "chain": entry.chain,
        "raw": entry.raw,
    }


def _connector_balance_to_dict(cb) -> Dict[str, Any]:
    return {
        "connector_id": cb.connector_id,
        "connector_type": cb.connector_type,
        "account_id": cb.account_id,
        "account_name": cb.account_name,
        "chain": cb.chain,
        "entries": [_entry_to_dict(e) for e in cb.entries],
        "fetched_at": cb.fetched_at,
        "error": cb.error,
    }


def _account_balance_to_dict(ab) -> Dict[str, Any]:
    return {
        "account_id": ab.account_id,
        "account_name": ab.account_name,
        "account_type": ab.account_type,
        "group": ab.group,
        "connector_balances": [
            _connector_balance_to_dict(cb) for cb in ab.connector_balances
        ],
    }


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------


@router.get("/connector/{connector_id}")
def get_connector_balance(
    connector_id: int,
    session: Session = Depends(get_session_dependency),
):
    """Fetch live balance for a single connector."""
    svc = BalanceService(session)
    result = svc.fetch_connector_balance(connector_id)
    if result is None:
        raise HTTPException(
            status_code=404,
            detail="Connector not found or does not support balance",
        )
    return _connector_balance_to_dict(result)


@router.get("/account/{account_id}")
def get_account_balance(
    account_id: int,
    session: Session = Depends(get_session_dependency),
):
    """Fetch live balances for all connectors of an account."""
    svc = BalanceService(session)
    result = svc.fetch_account_balance(account_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Account not found")
    return _account_balance_to_dict(result)


@router.get("/global")
def get_global_balance(
    session: Session = Depends(get_session_dependency),
):
    """Fetch live balances for all enabled accounts/connectors."""
    svc = BalanceService(session)
    results = svc.fetch_all_balances()
    return [_account_balance_to_dict(ab) for ab in results]
