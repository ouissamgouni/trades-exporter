"""P&L warning triage: dust classification and acknowledgement matching.

Warnings are regenerated on every recalculation, so their status is derived
from data that survives versions:
- dust: details["severity"] == "dust", set at calculation time when the
  warning's value in base currency is below the configured threshold.
- acknowledged: a PnlWarningAck row matches (type, transaction, asset, fingerprint).
"""

from decimal import Decimal
from typing import Iterable, Optional

from sqlalchemy import and_, exists, func, not_, or_

from backend.db.models import PnlWarning, PnlWarningAck

STATUS_OPEN = "open"
STATUS_ACKNOWLEDGED = "acknowledged"
STATUS_DUST = "dust"
STATUS_ALL = "all"
STATUSES = (STATUS_OPEN, STATUS_ACKNOWLEDGED, STATUS_DUST, STATUS_ALL)


def warning_value_in_base(details: Optional[dict]) -> Optional[Decimal]:
    """Best-effort magnitude (base currency) of a warning, from its details."""
    if not details:
        return None
    for key in ("value_in_base", "fmv_value"):
        if details.get(key) is not None:
            return abs(Decimal(str(details[key])))
    qty, unit_cost = details.get("negative_lot_qty"), details.get("unit_cost")
    if qty is not None and unit_cost is not None:
        return abs(Decimal(str(qty)) * Decimal(str(unit_cost)))
    return None


def fingerprint_for(value: Optional[Decimal]) -> str:
    return "" if value is None else f"{value.quantize(Decimal('0.01'))}"


def annotate_warnings(warnings: Iterable[PnlWarning], dust_threshold: Decimal) -> None:
    """Store value_in_base, fingerprint and dust severity in each warning's details."""
    for w in warnings:
        details = dict(w.details or {})
        value = warning_value_in_base(details)
        if value is not None:
            details["value_in_base"] = float(value)
            if value < dust_threshold:
                details["severity"] = STATUS_DUST
        details["fingerprint"] = fingerprint_for(value)
        w.details = details


def _fingerprint_expr():
    return func.coalesce(PnlWarning.details["fingerprint"].as_string(), "")


def is_acknowledged_clause():
    return exists().where(
        and_(
            PnlWarningAck.warning_type == PnlWarning.warning_type,
            func.coalesce(PnlWarningAck.transaction_id, 0)
            == func.coalesce(PnlWarning.transaction_id, 0),
            func.coalesce(PnlWarningAck.asset_id, 0)
            == func.coalesce(PnlWarning.asset_id, 0),
            PnlWarningAck.fingerprint == _fingerprint_expr(),
        )
    )


def is_dust_clause():
    return func.coalesce(PnlWarning.details["severity"].as_string(), "") == STATUS_DUST


def status_clause(status: str):
    """SQL condition on PnlWarning for a triage status (None = no filter)."""
    if status == STATUS_ALL:
        return None
    if status == STATUS_ACKNOWLEDGED:
        return is_acknowledged_clause()
    if status == STATUS_DUST:
        return and_(is_dust_clause(), not_(is_acknowledged_clause()))
    return and_(not_(is_dust_clause()), not_(is_acknowledged_clause()))


def apply_status(query, status: Optional[str]):
    clause = status_clause(status or STATUS_OPEN)
    return query if clause is None else query.where(clause)


def warning_status(w: PnlWarning, acked_keys: set) -> str:
    if (
        ack_key(
            w.warning_type,
            w.transaction_id,
            w.asset_id,
            (w.details or {}).get("fingerprint", ""),
        )
        in acked_keys
    ):
        return STATUS_ACKNOWLEDGED
    if (w.details or {}).get("severity") == STATUS_DUST:
        return STATUS_DUST
    return STATUS_OPEN


def ack_key(
    warning_type: str,
    transaction_id: Optional[int],
    asset_id: Optional[int],
    fingerprint: Optional[str],
):
    return (warning_type, transaction_id or 0, asset_id or 0, fingerprint or "")


def load_ack_keys(session, warnings: Iterable[PnlWarning]) -> set:
    tx_ids = {w.transaction_id for w in warnings if w.transaction_id}
    query = PnlWarningAck.__table__.select()
    if tx_ids:
        query = query.where(
            or_(
                PnlWarningAck.transaction_id.in_(tx_ids),
                PnlWarningAck.transaction_id.is_(None),
            )
        )
    rows = session.exec(query).all()
    return {
        ack_key(r.warning_type, r.transaction_id, r.asset_id, r.fingerprint)
        for r in rows
    }
