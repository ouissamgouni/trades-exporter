"""Usage, status and suggestions behind the raw asset / raw account mapping workbench."""

from collections import defaultdict
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy import func
from sqlmodel import Session, select

from backend.api.schemas import SuggestionInfo
from backend.db.models import (
    Account,
    AccountConnector,
    Asset,
    NormalizedTransaction,
    RawAccount,
    RawAsset,
    SpamTokenRule,
)
from backend.db.repositories.raw_asset_repository import token_key
from backend.services.asset_contract_suggestions import suggest_asset_for_contract
from backend.services.similarity_service import get_top_account_suggestions

# Suggestions at or above this confidence are verified and may be accepted in bulk.
VERIFIED_CONFIDENCE = 0.9

STATUSES = ("suggested", "unmapped", "mapped", "ignored")
_STATUS_ORDER = {s: i for i, s in enumerate(STATUSES)}

Usage = List[Any]  # [count, first_seen, last_seen]


def _merge(usage: Dict[Any, Usage], key: Any, n: int, first, last) -> None:
    u = usage.setdefault(key, [0, None, None])
    u[0] += n
    if first is not None and (u[1] is None or first < u[1]):
        u[1] = first
    if last is not None and (u[2] is None or last > u[2]):
        u[2] = last


def status_of(ignored: bool, mapped: bool, suggestion: Optional[SuggestionInfo]) -> str:
    if ignored:
        return "ignored"
    if mapped:
        return "mapped"
    return "suggested" if suggestion else "unmapped"


def filter_items(
    items: List[Dict[str, Any]],
    search_fields: Iterable[str],
    status: Optional[str] = None,
    q: Optional[str] = None,
    source: Optional[str] = None,
    network: Optional[str] = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    """Filter rows; counts per status ignore the status filter so tabs stay stable."""
    needle = (q or "").strip().lower()
    scoped = [
        it
        for it in items
        if (not source or it["source"] == source)
        and (not network or it["network"] == network)
        and (
            not needle
            or any(needle in str(it.get(f) or "").lower() for f in search_fields)
        )
    ]
    counts = {s: 0 for s in STATUSES}
    for it in scoped:
        counts[it["status"]] += 1
    rows = [it for it in scoped if not status or it["status"] == status]
    rows.sort(key=lambda it: (_STATUS_ORDER[it["status"]], -it["usage_count"]))
    return rows, counts


# --- raw assets ----------------------------------------------------------------


def raw_asset_usage(session: Session) -> Dict[Tuple[str, str, str, str], Usage]:
    """Rows referencing each raw asset key, keyed by (source, symbol, network, contract)."""
    T = NormalizedTransaction
    usage: Dict[Tuple[str, str, str, str], Usage] = {}
    rows = session.exec(
        select(
            T.source,
            T.source_asset_symbol,
            T.network,
            T.token_contract_address,
            func.count(),
            func.min(T.date_time),
            func.max(T.date_time),
        ).group_by(T.source, T.source_asset_symbol, T.network, T.token_contract_address)
    ).all()
    for source, symbol, network, contract, n, first, last in rows:
        net, c = token_key(network, contract)
        _merge(usage, (source, symbol, net, c), n, first, last)
    for col in (
        T.source_price_quote_asset_symbol,
        T.source_fee_quote_asset_symbol,
        T.source_attributed_asset_symbol,
    ):
        rows = session.exec(
            select(
                T.source,
                col,
                func.count(),
                func.min(T.date_time),
                func.max(T.date_time),
            )
            .where(col != "")
            .group_by(T.source, col)
        ).all()
        for source, symbol, n, first, last in rows:
            _merge(usage, (source, symbol, "", ""), n, first, last)
    return usage


def symbol_suggestion(
    symbol: str,
    mapped_symbol_ids: Dict[str, Set[int]],
    assets_by_symbol: Dict[str, List[Asset]],
    assets_by_id: Dict[int, Asset],
) -> Optional[SuggestionInfo]:
    """Plain (contract-less) symbol: same symbol mapped elsewhere, else an exact asset symbol."""
    key = (symbol or "").upper()
    ids = mapped_symbol_ids.get(key, set())
    if len(ids) == 1:
        asset_id = next(iter(ids))
        asset = assets_by_id.get(asset_id)
        return SuggestionInfo(
            id=asset_id,
            name=asset.symbol if asset else f"#{asset_id}",
            confidence=0.95,
            reason="known_symbol",
        )
    candidates = assets_by_symbol.get(key, [])
    if len(candidates) == 1:
        return SuggestionInfo(
            id=candidates[0].asset_id,
            name=candidates[0].symbol,
            confidence=0.9,
            reason="exact_symbol",
        )
    return None


def raw_asset_overview(session: Session) -> List[Dict[str, Any]]:
    usage = raw_asset_usage(session)
    assets_by_id = {a.asset_id: a for a in session.exec(select(Asset)).all()}
    assets_by_symbol: Dict[str, List[Asset]] = defaultdict(list)
    for a in assets_by_id.values():
        assets_by_symbol[(a.symbol or "").upper()].append(a)
    verdicts = {
        (r.network, r.contract_address): r.verdict
        for r in session.exec(select(SpamTokenRule)).all()
    }
    raws = session.exec(select(RawAsset)).all()
    mapped_symbol_ids: Dict[str, Set[int]] = defaultdict(set)
    for r in raws:
        if r.asset_id is not None and not r.contract_address:
            mapped_symbol_ids[r.symbol.upper()].add(r.asset_id)

    items = []
    for r in raws:
        spam = (
            verdicts.get((r.network, r.contract_address.lower()))
            if r.contract_address
            else None
        )
        ignored = bool(r.dismissed) or spam == "block"
        suggestion = None
        if r.asset_id is None and not ignored:
            suggestion = (
                suggest_asset_for_contract(
                    session, r.symbol, r.network, r.contract_address
                )
                if r.contract_address
                else symbol_suggestion(
                    r.symbol, mapped_symbol_ids, assets_by_symbol, assets_by_id
                )
            )
        count, first, last = usage.get(
            (r.source, r.symbol, r.network, r.contract_address), [0, None, None]
        )
        asset = assets_by_id.get(r.asset_id) if r.asset_id is not None else None
        items.append(
            {
                "symbol": r.symbol,
                "source": r.source,
                "network": r.network or "",
                "contract_address": r.contract_address or "",
                "asset_id": r.asset_id,
                "asset_symbol": asset.symbol if asset else None,
                "asset_label": asset.label if asset else None,
                "status": status_of(ignored, r.asset_id is not None, suggestion),
                "suggestion": suggestion,
                "usage_count": count,
                "first_seen": first,
                "last_seen": last,
                "dismissed": bool(r.dismissed),
                "dismissed_at": r.dismissed_at,
                "dismissed_reason": r.dismissed_reason,
                "spam_verdict": spam,
            }
        )
    return items


# --- raw accounts --------------------------------------------------------------


def raw_account_usage(
    session: Session,
) -> Dict[
    Tuple[str, str], List[Tuple[str, str, int, Optional[datetime], Optional[datetime]]]
]:
    """Per (source, label): (network, role, count, first, last) rows; role is account/from/to."""
    T = NormalizedTransaction
    out: Dict[Tuple[str, str], list] = defaultdict(list)
    for role, col in (
        ("account", T.source_account),
        ("from", T.source_from_account),
        ("to", T.source_to_account),
    ):
        rows = session.exec(
            select(
                T.source,
                col,
                T.network,
                func.count(),
                func.min(T.date_time),
                func.max(T.date_time),
            )
            .where(col.isnot(None), col != "")
            .group_by(T.source, col, T.network)
        ).all()
        for source, label, network, n, first, last in rows:
            out[(source, label)].append((network or "", role, n, first, last))
    return out


def account_usage_for(entries: list, network: str) -> Dict[str, Any]:
    """Aggregate usage rows for a raw account; an empty network matches every network."""
    roles = {"account": 0, "from": 0, "to": 0}
    total: Dict[str, Usage] = {}
    for net, role, n, first, last in entries:
        if network and net != network:
            continue
        roles[role] += n
        _merge(total, "all", n, first, last)
    acc = total.get("all", [0, None, None])
    return {
        "usage_count": acc[0],
        "first_seen": acc[1],
        "last_seen": acc[2],
        "account_count": roles["account"],
        "from_count": roles["from"],
        "to_count": roles["to"],
    }


def account_suggestion(
    label: str,
    source: str,
    network: str,
    accounts: List[Account],
    mapped_label_ids: Dict[Tuple[str, Optional[str]], Set[int]],
    connectors_map: Dict[int, list],
) -> Optional[SuggestionInfo]:
    """Same label mapped elsewhere > exact address/name > fuzzy (never verified)."""
    by_id = {a.id: a for a in accounts}
    key = (label or "").strip().lower()
    # Same address is often a distinct account per chain: prefer same-network mappings.
    ids = mapped_label_ids.get((key, network), set()) if network else set()
    if len(ids) != 1:
        ids = mapped_label_ids.get((key, None), set())
    if len(ids) == 1:
        account_id = next(iter(ids))
        acc = by_id.get(account_id)
        return SuggestionInfo(
            id=account_id,
            name=acc.name if acc else f"#{account_id}",
            confidence=0.95,
            reason="known_label",
        )
    for field, reason in (
        ("address_or_identifier", "exact_address"),
        ("name", "exact_name"),
    ):
        exact = [
            a for a in accounts if (getattr(a, field) or "").strip().lower() == key
        ]
        if len(exact) > 1 and network:
            exact = [
                a
                for a in exact
                if any(
                    (c.config or {}).get("chain") == network
                    for c in connectors_map.get(a.id, [])
                )
            ]
        if len(exact) == 1:
            return SuggestionInfo(
                id=exact[0].id, name=exact[0].name, confidence=1.0, reason=reason
            )
    top = get_top_account_suggestions(
        label=label,
        accounts=accounts,
        min_confidence=0.5,
        max_results=1,
        source=source,
        account_connectors_map=connectors_map,
        network=network or None,
    )
    if not top:
        return None
    s = top[0]
    return SuggestionInfo(
        id=s.id, name=s.name, confidence=min(s.confidence, 0.85), reason="similar"
    )


def account_suggestion_context(session: Session):
    accounts = session.exec(select(Account)).all()
    connectors_map: Dict[int, list] = defaultdict(list)
    for c in session.exec(select(AccountConnector)).all():
        connectors_map[c.account_id].append(c)
    return accounts, connectors_map


def mapped_label_index(
    raws: Iterable[RawAccount],
) -> Dict[Tuple[str, Optional[str]], Set[int]]:
    """Account ids mapped per (label, network) and per (label, None) across all networks."""
    index: Dict[Tuple[str, Optional[str]], Set[int]] = defaultdict(set)
    for r in raws:
        if r.account_id is not None and not r.dismissed:
            label = r.label.strip().lower()
            index[(label, r.network or "")].add(r.account_id)
            index[(label, None)].add(r.account_id)
    return index


def raw_account_overview(session: Session) -> List[Dict[str, Any]]:
    usage = raw_account_usage(session)
    accounts, connectors_map = account_suggestion_context(session)
    by_id = {a.id: a for a in accounts}
    raws = session.exec(select(RawAccount)).all()
    label_ids = mapped_label_index(raws)

    items = []
    for r in raws:
        suggestion = None
        if r.account_id is None and not r.dismissed:
            suggestion = account_suggestion(
                r.label, r.source, r.network, accounts, label_ids, connectors_map
            )
        acc = by_id.get(r.account_id) if r.account_id is not None else None
        items.append(
            {
                "id": r.id,
                "source": r.source,
                "label": r.label,
                "network": r.network or "",
                "account_id": r.account_id,
                "account_name": acc.name if acc else None,
                "account_type": acc.account_type if acc else None,
                "status": status_of(
                    bool(r.dismissed), r.account_id is not None, suggestion
                ),
                "suggestion": suggestion,
                "dismissed": bool(r.dismissed),
                "dismissed_at": r.dismissed_at,
                "dismissed_reason": r.dismissed_reason,
                **account_usage_for(
                    usage.get((r.source, r.label), []), r.network or ""
                ),
            }
        )
    return items
