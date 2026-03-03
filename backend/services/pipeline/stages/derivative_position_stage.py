"""
Derivative Position Stage — DEPRECATED thin adapter.

Position lifecycle management has been moved to DerivativesSyncService,
which runs per-connector at completion time (scoped by sync_connector_run_id).

This module is kept for backwards compatibility — existing tests and imports
continue to work. The process() and process_batch() methods delegate to
DerivativesSyncService internally.

For new code, use DerivativesSyncService directly:
    from backend.services.derivatives_sync_service import DerivativesSyncService
    service = DerivativesSyncService()
    service.process_connector_run(session, connector_id, sync_connector_run_id)
"""

from decimal import Decimal
from typing import List, Optional, Tuple

from sqlmodel import select

from backend.config.loader import configure_logging
from backend.connectors.base.position_intent import PositionIntent
from backend.db.models import DerivativePosition, NormalizedTransaction
from backend.services.pipeline.base import PipelineStage
from backend.services.pipeline.context import PipelineContext

log = configure_logging("derivative_position_stage")

PERP_TYPES = frozenset({"perp_open", "perp_close"})


class DerivativePositionStage(PipelineStage):
    """
    DEPRECATED — Thin adapter over DerivativesSyncService.

    Derivative position processing now happens per-connector at completion
    time via DerivativesSyncService, not as a pipeline stage or batch
    post-step in the sync_job_service finally block.

    This class is retained for backwards compatibility with existing tests.
    """

    @property
    def name(self) -> str:
        return "derivative_position"

    def should_skip(self, context: PipelineContext) -> bool:
        return context.skip_persistence

    def process(
        self,
        transactions: List[NormalizedTransaction],
        context: PipelineContext,
    ) -> Tuple[List[NormalizedTransaction], bool]:
        """Legacy per-item pipeline path — delegates to internal processing."""
        session = context.session
        processed = 0

        perp_txns = [
            tx for tx in transactions
            if tx.source_transaction_type in PERP_TYPES
        ]
        perp_txns.sort(
            key=lambda tx: (tx.date_time or 0, tx.source_transaction_id or "")
        )

        for tx in perp_txns:
            intent = self._extract_position_intent(tx)
            if intent is None:
                continue

            db_tx = self._resolve_persisted_nt(session, tx)
            if db_tx is None:
                log.warning(
                    "derivative_position_skip_no_db_id",
                    source=tx.source,
                    source_transaction_id=tx.source_transaction_id,
                )
                continue

            try:
                did_work = False
                if intent.action == "open":
                    did_work = self._handle_open(session, db_tx, tx, intent)
                elif intent.action == "close":
                    did_work = self._handle_close(session, db_tx, tx, intent)
                if did_work:
                    processed += 1
            except Exception as e:
                log.warning(
                    "derivative_position_error",
                    source_transaction_id=tx.source_transaction_id,
                    error=str(e),
                )
                continue

        if processed > 0:
            try:
                session.commit()
                log.debug("derivative_positions_committed", count=processed)
            except Exception as e:
                session.rollback()
                log.error("derivative_positions_commit_failed", error=str(e))
                context.warnings.append(
                    f"Failed to commit derivative positions: {e}"
                )

        return transactions, True

    # ------------------------------------------------------------------
    # Batch entry point (DEPRECATED — use DerivativesSyncService instead)
    # ------------------------------------------------------------------

    def process_batch(
        self,
        session,
        account_ids: Optional[List[int]] = None,
        connector_ids: Optional[List[int]] = None,
    ) -> int:
        """
        DEPRECATED — Use DerivativesSyncService.process_connector_run() or
        DerivativesSyncService.process_connector_full() instead.

        Kept for backwards compatibility.
        """
        from backend.services.derivatives_sync_service import DerivativesSyncService

        service = DerivativesSyncService()
        total = 0
        if connector_ids:
            for cid in connector_ids:
                total += service.process_connector_full(session, connector_id=cid)
        elif account_ids:
            # Fall back to querying NTs by account_id
            stmt = (
                select(NormalizedTransaction)
                .where(
                    NormalizedTransaction.source_transaction_type.in_(list(PERP_TYPES))
                )
                .where(NormalizedTransaction.account_id.in_(account_ids))
                .order_by(NormalizedTransaction.date_time, NormalizedTransaction.id)
            )
            db_txns = list(session.exec(stmt).all())
            if db_txns:
                total = service._process_txns(session, db_txns)
                if total > 0:
                    service._safe_commit(session, "legacy_process_batch", total)
        return total

    # ------------------------------------------------------------------
    # Helpers (kept for process() compatibility)
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_position_intent(tx: NormalizedTransaction) -> Optional[PositionIntent]:
        """Extract PositionIntent from the first tag dict, if present."""
        if not tx.tags or not isinstance(tx.tags, list) or len(tx.tags) == 0:
            return None
        first_tag = tx.tags[0]
        if not isinstance(first_tag, dict):
            return None
        raw = first_tag.get("_position_data")
        if raw is None:
            return None
        if "action" in raw:
            return PositionIntent.from_dict(raw)
        return PositionIntent.from_legacy_dict(raw)

    @staticmethod
    def _resolve_persisted_nt(session, tx: NormalizedTransaction):
        """Find the persisted NT by (source, source_transaction_id)."""
        stmt = select(NormalizedTransaction).where(
            NormalizedTransaction.source == tx.source,
            NormalizedTransaction.source_transaction_id == tx.source_transaction_id,
        )
        return session.exec(stmt).first()

    def _handle_open(self, session, db_tx, tx, intent: PositionIntent) -> bool:
        """Handle a perp_open fill: create or add to position."""
        from backend.services.derivatives_sync_service import DerivativesSyncService
        service = DerivativesSyncService()
        return service._handle_open(session, db_tx, intent)

    def _handle_close(self, session, db_tx, tx, intent: PositionIntent) -> bool:
        """Handle a perp_close fill: update PnL, reduce size, potentially close."""
        from backend.services.derivatives_sync_service import DerivativesSyncService
        service = DerivativesSyncService()
        return service._handle_close(session, db_tx, intent)

    @staticmethod
    def _find_open_position(session, account_id: int, coin: str, connector_id: Optional[int] = None):
        """Find the currently open position for an account+coin pair."""
        return DerivativesSyncService._find_open_position(session, account_id, coin, connector_id)

    @staticmethod
    def _resolve_exchange(db_tx) -> str:
        """Resolve exchange name from ConnectorInfo registry."""
        return DerivativesSyncService._resolve_exchange(db_tx)

    @staticmethod
    def _exchange_from_source(source: str) -> str:
        """Derive exchange name from the connector source string."""
        if "hyperliquid" in source:
            return "hyperliquid"
        return source.split("-")[0] if "-" in source else source
