"""Suspected-spam heuristic: unsolicited incoming transfers of unpriced tokens."""

from typing import Any, Dict, List, Optional, Set, Tuple

from sqlalchemy import func
from sqlmodel import Session, select

from backend.config.loader import configure_logging
from backend.core.spam_detection import apply_spam_markers
from backend.db.models import (
    AssetPriceGetter,
    NormalizedTransaction,
    ReviewStatus,
    SpamTokenRule,
    utc_now,
)

log = configure_logging("spam_heuristic")

ALLOW = "allow"
BLOCK = "block"
SUSPECTED_REASON = "unsolicited_unpriced"
BLOCKLISTED_REASON = "user_blocklisted"
SUSPECTED_TAG_FILTER = [{"spam_level": "suspected"}]

TokenKey = Tuple[str, str]


def _tag_list(tags: Any) -> List[Any]:
    if not tags:
        return []
    if isinstance(tags, dict):
        return [tags]
    return list(tags)


def spam_tag(tags: Any) -> Optional[Dict[str, Any]]:
    return next(
        (t for t in _tag_list(tags) if isinstance(t, dict) and t.get("spam")), None
    )


def token_key(tx: NormalizedTransaction) -> TokenKey:
    return ((tx.network or "").lower(), (tx.token_contract_address or "").lower())


def tx_hash_of(tx: NormalizedTransaction) -> str:
    # Etherscan rows carry the hash only as the source_transaction_id prefix.
    return (
        tx.network_transaction_id or (tx.source_transaction_id or "").split("_")[0]
    ).lower()


def classify(
    tx: NormalizedTransaction,
    *,
    rule: Optional[str],
    wallet_initiated: bool,
    priced: bool,
) -> Optional[str]:
    """Return the spam reason for a pending token transfer, or None if it looks legit."""
    if rule == ALLOW:
        return None
    if rule == BLOCK:
        return BLOCKLISTED_REASON
    if tx.direction != "inflow" or tx.from_account_id is not None:
        return None
    if wallet_initiated or priced:
        return None
    return SUSPECTED_REASON


def _mark(tx: NormalizedTransaction, reason: str) -> None:
    tags = [
        t for t in _tag_list(tx.tags) if not (isinstance(t, dict) and t.get("spam"))
    ]
    apply_spam_markers(
        tx,
        reasons=[reason],
        tags=tags,
        tx_id=tx.source_transaction_id or "",
        suspected=reason == SUSPECTED_REASON,
    )


def _load_rules(session: Session, keys: Set[TokenKey]) -> Dict[TokenKey, str]:
    contracts = {c for _, c in keys}
    rows = session.exec(
        select(SpamTokenRule).where(SpamTokenRule.contract_address.in_(contracts))
    ).all()
    return {(r.network, r.contract_address): r.verdict for r in rows}


def _priced_asset_ids(session: Session, asset_ids: Set[int]) -> Set[int]:
    if not asset_ids:
        return set()
    rows = session.exec(
        select(AssetPriceGetter.asset_id)
        .where(AssetPriceGetter.asset_id.in_(asset_ids))
        .where(AssetPriceGetter.enabled == True)  # noqa: E712
        .distinct()
    ).all()
    return set(rows)


def _wallet_initiated(
    session: Session, candidates: List[NormalizedTransaction]
) -> Set[Tuple[int, str]]:
    """(account_id, tx hash) pairs where the wallet itself sent something in that tx."""
    account_ids = {tx.account_id for tx in candidates if tx.account_id}
    times = {tx.date_time for tx in candidates if tx.date_time}
    if not account_ids or not times:
        return set()
    # Same tx => same block timestamp, so match on time first and compare hashes in Python.
    outflows = session.exec(
        select(NormalizedTransaction)
        .where(NormalizedTransaction.account_id.in_(account_ids))
        .where(NormalizedTransaction.direction == "outflow")
        .where(NormalizedTransaction.date_time.in_(times))
    ).all()
    return {(tx.account_id, tx_hash_of(tx)) for tx in outflows}


def scan_suspected_spam(
    session: Session,
    *,
    sync_connector_run_id: Optional[int] = None,
    connector_id: Optional[int] = None,
    dry_run: bool = False,
) -> List[NormalizedTransaction]:
    """Flag pending token transfers in scope; rows that already carry a spam tag are left alone."""
    stmt = (
        select(NormalizedTransaction)
        .where(NormalizedTransaction.review_status == ReviewStatus.PENDING.value)
        .where(NormalizedTransaction.token_contract_address.is_not(None))
        .where(NormalizedTransaction.token_contract_address != "")
    )
    if sync_connector_run_id is not None:
        stmt = stmt.where(
            NormalizedTransaction.sync_connector_run_id == sync_connector_run_id
        )
    if connector_id is not None:
        stmt = stmt.where(NormalizedTransaction.connector_id == connector_id)

    candidates = [tx for tx in session.exec(stmt).all() if spam_tag(tx.tags) is None]
    if not candidates:
        return []

    rules = _load_rules(session, {token_key(tx) for tx in candidates})
    priced = _priced_asset_ids(
        session, {tx.asset_id for tx in candidates if tx.asset_id}
    )
    initiated = _wallet_initiated(session, candidates)

    flagged = []
    for tx in candidates:
        reason = classify(
            tx,
            rule=rules.get(token_key(tx)),
            wallet_initiated=(tx.account_id, tx_hash_of(tx)) in initiated,
            priced=tx.asset_id in priced,
        )
        if not reason:
            continue
        flagged.append(tx)
        if not dry_run:
            _mark(tx, reason)
            session.add(tx)

    if flagged and not dry_run:
        session.commit()
    log.info(
        "spam_scan_done",
        candidates=len(candidates),
        flagged=len(flagged),
        dry_run=dry_run,
    )
    return flagged


def apply_token_verdict(
    session: Session, transaction_id: int, verdict: str
) -> Dict[str, Any]:
    """Record an allow/block verdict for the token of a transaction and apply it to all its rows."""
    if verdict not in (ALLOW, BLOCK):
        raise ValueError(f"Unknown verdict '{verdict}'")
    tx = session.get(NormalizedTransaction, transaction_id)
    if not tx:
        raise LookupError(f"Transaction {transaction_id} not found")
    network, contract = token_key(tx)
    if not contract:
        raise ValueError("Transaction has no token contract address")

    rule = session.exec(
        select(SpamTokenRule)
        .where(SpamTokenRule.network == network)
        .where(SpamTokenRule.contract_address == contract)
    ).first()
    if rule:
        rule.verdict = verdict
        rule.updated_at = utc_now()
    else:
        rule = SpamTokenRule(
            network=network, contract_address=contract, verdict=verdict
        )
    session.add(rule)

    rows = session.exec(
        select(NormalizedTransaction)
        .where(func.lower(NormalizedTransaction.network) == network)
        .where(func.lower(NormalizedTransaction.token_contract_address) == contract)
    ).all()
    updated = 0
    for row in rows:
        tag = spam_tag(row.tags)
        if verdict == ALLOW:
            if tag is None or row.review_status != ReviewStatus.INVALID.value:
                continue
            row.tags = [t for t in _tag_list(row.tags) if t is not tag]
            row.review_status = ReviewStatus.PENDING.value
            row.taxability_status = "unknown"
            row.review_notes = None
        else:
            is_suspected = bool(tag and tag.get("spam_level") == "suspected")
            if row.review_status != ReviewStatus.PENDING.value and not is_suspected:
                continue
            _mark(row, BLOCKLISTED_REASON)
        row.updated_at = utc_now()
        session.add(row)
        updated += 1

    session.commit()
    log.info(
        "spam_verdict_applied",
        network=network,
        contract=contract,
        verdict=verdict,
        updated=updated,
    )
    return {
        "network": network,
        "contract_address": contract,
        "verdict": verdict,
        "updated_count": updated,
    }


def count_suspected(session: Session) -> int:
    return session.exec(
        select(func.count(NormalizedTransaction.id))
        .where(NormalizedTransaction.review_status == ReviewStatus.INVALID.value)
        .where(NormalizedTransaction.tags.op("@>")(SUSPECTED_TAG_FILTER))  # type: ignore[union-attr]
    ).one()
