"""Bundle health: detect confirmed bundles that lost legs and suggest standalone transactions to complete them."""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Dict, List, Optional

from sqlmodel import Session, select

from backend.db.models import (
    Direction,
    NormalizedTransaction,
    ReviewStatus,
    UnitPattern,
    UserCalculationBundle,
    ensure_utc,
)

# Bridges / relays can take a while and shave a small fee off the amount.
COMPLETION_TIME_WINDOW = timedelta(hours=24)
COMPLETION_EARLY_SLACK = timedelta(minutes=5)
COMPLETION_QTY_TOLERANCE = Decimal("0.05")
MAX_CANDIDATES = 3

ISSUE_EMPTY = "empty"
ISSUE_MISSING_INFLOW = "missing_inflow"
ISSUE_MISSING_OUTFLOW = "missing_outflow"

# Patterns that need both an outflow and an inflow to be meaningful.
_TWO_SIDED_PATTERNS = {UnitPattern.INTERNAL_TRANSFER.value, UnitPattern.SWAP.value}


@dataclass
class CompletionCandidate:
    transaction_id: int
    date_time: Optional[datetime]
    account_id: Optional[int]
    asset_symbol: str
    quantity: float
    confidence: float
    reason: str


@dataclass
class BrokenBundle:
    bundle_id: int
    label: Optional[str]
    pattern: Optional[str]
    created_at: Optional[datetime]
    issue: str
    transaction_ids: List[int] = field(default_factory=list)
    candidates: List[CompletionCandidate] = field(default_factory=list)


class BundleHealthService:
    def __init__(self, session: Session):
        self.session = session

    def find_broken(self, with_candidates: bool = True) -> List[BrokenBundle]:
        bundles = self.session.exec(
            select(UserCalculationBundle)
            .where(UserCalculationBundle.confidence.is_(None))
            .order_by(UserCalculationBundle.id)
        ).all()
        if not bundles:
            return []

        txs = self.session.exec(
            select(NormalizedTransaction)
            .where(
                NormalizedTransaction.user_calculation_unit_id.in_(
                    [b.id for b in bundles]
                )
            )
            .order_by(NormalizedTransaction.date_time)
        ).all()
        by_bundle: Dict[int, List[NormalizedTransaction]] = {}
        for tx in txs:
            by_bundle.setdefault(tx.user_calculation_unit_id, []).append(tx)

        broken: List[BrokenBundle] = []
        for bundle in bundles:
            members = by_bundle.get(bundle.id, [])
            issue = self._issue_for(bundle, members)
            if not issue:
                continue
            item = BrokenBundle(
                bundle_id=bundle.id,
                label=bundle.label,
                pattern=bundle.pattern,
                created_at=bundle.created_at,
                issue=issue,
                transaction_ids=[t.id for t in members],
            )
            if (
                with_candidates
                and bundle.pattern == UnitPattern.INTERNAL_TRANSFER.value
                and members
            ):
                item.candidates = self.find_completion_candidates(members, issue)
            broken.append(item)
        return broken

    def count_broken(self) -> int:
        return len(self.find_broken(with_candidates=False))

    @staticmethod
    def _issue_for(
        bundle: UserCalculationBundle, members: List[NormalizedTransaction]
    ) -> Optional[str]:
        if not members:
            return ISSUE_EMPTY
        if bundle.pattern not in _TWO_SIDED_PATTERNS:
            return None
        directions = {t.direction for t in members}
        if Direction.INFLOW.value not in directions:
            return ISSUE_MISSING_INFLOW
        if Direction.OUTFLOW.value not in directions:
            return ISSUE_MISSING_OUTFLOW
        return None

    def find_completion_candidates(
        self, members: List[NormalizedTransaction], issue: str
    ) -> List[CompletionCandidate]:
        anchor_dirs = {t.direction for t in members}
        if len(anchor_dirs) != 1 or issue not in (
            ISSUE_MISSING_INFLOW,
            ISSUE_MISSING_OUTFLOW,
        ):
            return []
        asset_ids = {t.asset_id for t in members if t.asset_id}
        symbols = {(t.source_asset_symbol or "").upper() for t in members}
        anchor_qty = sum((Decimal(str(t.quantity or 0)) for t in members), Decimal(0))
        anchor_accounts = {t.account_id for t in members}
        dated = [ensure_utc(t.date_time) for t in members if t.date_time]
        if anchor_qty <= 0 or not dated:
            return []

        want_inflow = issue == ISSUE_MISSING_INFLOW
        if want_inflow:
            anchor_dt = max(dated)
            start, end = (
                anchor_dt - COMPLETION_EARLY_SLACK,
                anchor_dt + COMPLETION_TIME_WINDOW,
            )
        else:
            anchor_dt = min(dated)
            start, end = (
                anchor_dt - COMPLETION_TIME_WINDOW,
                anchor_dt + COMPLETION_EARLY_SLACK,
            )

        query = (
            select(NormalizedTransaction)
            .where(NormalizedTransaction.user_calculation_unit_id.is_(None))
            .where(NormalizedTransaction.transaction_type == "transfer")
            .where(
                NormalizedTransaction.direction
                == (Direction.INFLOW.value if want_inflow else Direction.OUTFLOW.value)
            )
            .where(NormalizedTransaction.review_status != ReviewStatus.INVALID)
            .where(NormalizedTransaction.date_time >= start.replace(tzinfo=None))
            .where(NormalizedTransaction.date_time <= end.replace(tzinfo=None))
        )
        candidates: List[CompletionCandidate] = []
        for tx in self.session.exec(query).all():
            if tx.account_id in anchor_accounts:
                continue
            same_asset = (
                (tx.asset_id in asset_ids)
                if (tx.asset_id and asset_ids)
                else ((tx.source_asset_symbol or "").upper() in symbols)
            )
            if not same_asset:
                continue
            qty = Decimal(str(tx.quantity or 0))
            if qty <= 0:
                continue
            # The received side is the sent side minus fees: received <= sent, within tolerance.
            sent, received = (anchor_qty, qty) if want_inflow else (qty, anchor_qty)
            if received > sent * Decimal("1.001") or received < sent * (
                1 - COMPLETION_QTY_TOLERANCE
            ):
                continue
            qty_gap = float(abs(sent - received) / sent)
            dt_gap = abs((ensure_utc(tx.date_time) - anchor_dt).total_seconds())
            confidence = max(
                0.0,
                1.0
                - min(dt_gap / COMPLETION_TIME_WINDOW.total_seconds(), 1.0) * 0.3
                - qty_gap * 2,
            )
            candidates.append(
                CompletionCandidate(
                    transaction_id=tx.id,
                    date_time=tx.date_time,
                    account_id=tx.account_id,
                    asset_symbol=tx.source_asset_symbol or "",
                    quantity=float(qty),
                    confidence=round(confidence, 3),
                    reason=_format_reason(
                        dt_gap, sent - received, tx.source_asset_symbol or ""
                    ),
                )
            )
        candidates.sort(key=lambda c: c.confidence, reverse=True)
        return candidates[:MAX_CANDIDATES]


def _format_reason(dt_gap_seconds: float, fee: Decimal, symbol: str) -> str:
    if dt_gap_seconds < 120:
        delay = f"{int(dt_gap_seconds)}s apart"
    elif dt_gap_seconds < 7200:
        delay = f"{int(dt_gap_seconds // 60)}min apart"
    else:
        delay = f"{dt_gap_seconds / 3600:.1f}h apart"
    return f"{delay}, fee {float(fee):.6g} {symbol}".rstrip()
