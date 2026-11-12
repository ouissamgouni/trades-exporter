"""Effective "fetch from" window of a connector, shared by the sync job and the UI."""

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from sqlmodel import Session

from backend.connectors.connector_registry import get_connector_registry
from backend.db.models import AccountConnector, ensure_utc
from backend.db.repositories import NormalizedTransactionRepository

# Sentinel: no per-run since override was given (None means "full sync" override).
NO_OVERRIDE = object()

SOURCE_LABELS = {
    "override": "manual override",
    "last_transaction": "last stored transaction",
    "config_start": "configured start date",
    "history_cutoff": "history cutoff (older rows owned by previous provider)",
    "connector_default": "connector default",
    "full_history": "full history",
}


def _parse_dt(raw: Any) -> Optional[datetime]:
    if not raw:
        return None
    if isinstance(raw, datetime):
        return raw
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return ensure_utc(dt).isoformat() if dt else None


def resolve_sync_window(
    session: Session,
    connector: AccountConnector,
    override_since: Any = NO_OVERRIDE,
) -> Dict[str, Any]:
    """Return the effective start of the next fetch and why.

    ``since`` is a datetime (or None = no lower bound sent to the provider).
    Non-incremental connectors always re-fetch the full history; existing rows
    are skipped and rows older than ``history_cutoff`` are dropped.
    """
    info = get_connector_registry().get(connector.connector_type)
    incremental = bool(info and info.supports_incremental_sync)
    config = connector.config or {}
    default_start = _parse_dt(info.default_start) if info else None
    last_tx = NormalizedTransactionRepository(session).get_max_datetime_by_connector(
        connector.id
    )
    cutoff = _parse_dt(config.get("history_cutoff"))

    since: Optional[datetime] = None
    source = "full_history"
    overlap_days = 0
    if incremental:
        if override_since is not NO_OVERRIDE:
            since = override_since
            source = "override" if override_since else "full_history"
        elif last_tx:
            since, source = last_tx, "last_transaction"
            overlap_days = info.incremental_overlap_days if info else 0
            if overlap_days:
                since = last_tx - timedelta(days=overlap_days)
                config_start = _parse_dt(config.get("start_datetime"))
                if config_start and ensure_utc(since) < ensure_utc(config_start):
                    since = config_start
        elif _parse_dt(config.get("start_datetime")):
            since, source = _parse_dt(config.get("start_datetime")), "config_start"
        if cutoff and (since is None or ensure_utc(since) < ensure_utc(cutoff)):
            since, source = cutoff, "history_cutoff"
        if since is None and default_start:
            source = "connector_default"

    return {
        "incremental": incremental,
        "since": since,
        "source": source,
        "last_transaction_at": last_tx,
        "history_cutoff": cutoff,
        "default_start": default_start,
        "overlap_days": overlap_days,
    }


def sync_window_to_dict(window: Dict[str, Any]) -> Dict[str, Any]:
    """JSON-friendly version of :func:`resolve_sync_window`."""
    return {
        "incremental": window["incremental"],
        "since": _iso(window["since"]),
        "source": window["source"],
        "last_transaction_at": _iso(window["last_transaction_at"]),
        "history_cutoff": _iso(window["history_cutoff"]),
        "default_start": _iso(window["default_start"]),
        "overlap_days": window.get("overlap_days", 0),
    }


def describe_sync_window(window: Dict[str, Any]) -> str:
    """One-line human summary, e.g. for the connector run log."""

    def fmt(dt: datetime) -> str:
        return ensure_utc(dt).astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    source = window["source"]
    if window["since"]:
        text = f"from {fmt(window['since'])} ({SOURCE_LABELS[source]}"
        if window.get("overlap_days") and source == "last_transaction":
            text += f" minus {window['overlap_days']}-day overlap for late-completing transfers"
        text += ")"
    elif source == "connector_default":
        text = f"from {fmt(window['default_start'])} ({SOURCE_LABELS[source]})"
    elif window["incremental"]:
        text = "full history (no stored transaction or start date)"
    else:
        text = "full history every run (already stored rows are skipped)"
    if window["history_cutoff"] and source != "history_cutoff":
        text += f"; rows up to {fmt(window['history_cutoff'])} ignored (history cutoff)"
    return text
