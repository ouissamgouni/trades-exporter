"""
Derivatives Sync Service — Standalone service for managing derivative positions.

Responsible for the full lifecycle of derivative positions (open/add/close)
based on perp fill NTs produced by derivative connectors. Runs per-connector
after all of that connector's NTs have been committed, scoped by
sync_connector_run_id to avoid re-scanning old fills.

Replaces the legacy approach of bolting derivative processing into the
sync_job_service finally block via DerivativePositionStage.process_batch().

Key design decisions:
- Processes only NTs from the current sync run (sync_connector_run_id scoping)
- Runs at connector completion (not at job end) — positions are available sooner
- Idempotent: safe to call multiple times for the same run_id
- Non-fatal: errors don't fail the sync job
"""

from decimal import Decimal
from typing import List, Optional

from sqlmodel import select

from backend.config.loader import configure_logging
from backend.connectors.base.position_intent import PositionIntent
from backend.db.models import DerivativePosition, NormalizedTransaction

log = configure_logging("derivatives_sync_service")

PERP_TYPES = frozenset({"perp_open", "perp_close"})


class DerivativesSyncService:
    """
    Standalone service for creating/updating derivative positions from perp fills.

    Usage:
        service = DerivativesSyncService()

        # After a derivative connector's items are committed:
        count = service.process_connector_run(session, connector_id=7, sync_connector_run_id=42)

        # Full resync for a connector (scans all NTs, not just a single run):
        count = service.process_connector_full(session, connector_id=7)
    """

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def process_connector_run(
        self,
        session,
        connector_id: int,
        sync_connector_run_id: int,
    ) -> int:
        """
        Process derivative positions for a single connector sync run.

        Queries NTs belonging to the given sync_connector_run_id with perp
        source types, ordered chronologically, and runs the position lifecycle.

        Args:
            session: SQLModel session (must have the run's NTs already committed).
            connector_id: The connector ID (for logging / scoping position lookups).
            sync_connector_run_id: The SyncJobConnectorRun.id for this sync run.

        Returns:
            Number of positions created or updated.
        """
        stmt = (
            select(NormalizedTransaction)
            .where(
                NormalizedTransaction.sync_connector_run_id == sync_connector_run_id,
                NormalizedTransaction.source_transaction_type.in_(list(PERP_TYPES)),
            )
            .order_by(NormalizedTransaction.date_time, NormalizedTransaction.id)
        )
        db_txns = list(session.exec(stmt).all())

        if not db_txns:
            log.debug(
                "derivatives_sync_no_perp_txns",
                connector_id=connector_id,
                sync_connector_run_id=sync_connector_run_id,
            )
            return 0

        log.info(
            "derivatives_sync_start",
            connector_id=connector_id,
            sync_connector_run_id=sync_connector_run_id,
            perp_txn_count=len(db_txns),
        )

        processed = self._process_txns(session, db_txns)

        if processed > 0:
            self._safe_commit(session, "process_connector_run", processed)

        log.info(
            "derivatives_sync_complete",
            connector_id=connector_id,
            sync_connector_run_id=sync_connector_run_id,
            positions_processed=processed,
        )
        return processed

    def process_connector_full(
        self,
        session,
        connector_id: int,
    ) -> int:
        """
        Full resync: process all perp NTs for a given connector_id.

        Useful for rebuilding positions from scratch (e.g. after data cleanup).
        Scopes by connector_id on the NT, not by sync_connector_run_id.

        Args:
            session: SQLModel session.
            connector_id: The connector ID to scope the query.

        Returns:
            Number of positions created or updated.
        """
        stmt = (
            select(NormalizedTransaction)
            .where(
                NormalizedTransaction.connector_id == connector_id,
                NormalizedTransaction.source_transaction_type.in_(list(PERP_TYPES)),
            )
            .order_by(NormalizedTransaction.date_time, NormalizedTransaction.id)
        )
        db_txns = list(session.exec(stmt).all())

        if not db_txns:
            log.debug(
                "derivatives_sync_full_no_perp_txns",
                connector_id=connector_id,
            )
            return 0

        processed = self._process_txns(session, db_txns)

        if processed > 0:
            self._safe_commit(session, "process_connector_full", processed)

        return processed

    # ------------------------------------------------------------------
    # Registry helper
    # ------------------------------------------------------------------

    @staticmethod
    def is_derivative_connector(connector_type: str) -> bool:
        """
        Check whether a connector type produces derivative positions.

        Looks up the ConnectorInfo in the registry and checks for
        a non-None derivative_exchange field.
        """
        try:
            from backend.connectors.connector_registry import ConnectorRegistry

            registry = ConnectorRegistry.instance()
            info = registry.get(connector_type)
            return info is not None and info.derivative_exchange is not None
        except Exception:
            return False

    # ------------------------------------------------------------------
    # Internal processing
    # ------------------------------------------------------------------

    def _process_txns(
        self, session, db_txns: List[NormalizedTransaction]
    ) -> int:
        """Process a list of perp NTs through the position lifecycle. Returns count of positions touched."""
        processed = 0
        for db_tx in db_txns:
            intent = self._extract_position_intent(db_tx)
            if intent is None:
                continue

            try:
                did_work = False
                if intent.action == "open":
                    did_work = self._handle_open(session, db_tx, intent)
                elif intent.action == "close":
                    did_work = self._handle_close(session, db_tx, intent)
                if did_work:
                    processed += 1
            except Exception as e:
                log.warning(
                    "derivatives_sync_item_error",
                    source_transaction_id=db_tx.source_transaction_id,
                    error=str(e),
                )
                continue

        return processed

    # ------------------------------------------------------------------
    # Position lifecycle
    # ------------------------------------------------------------------

    def _handle_open(
        self, session, db_tx: NormalizedTransaction, intent: PositionIntent
    ) -> bool:
        """Handle a perp_open fill: create or add to position."""
        coin = intent.coin
        side = intent.side
        entry_price = intent.execution_price
        size = intent.size
        fee = Decimal(str(db_tx.fee or 0))

        if intent.is_new_position:
            # Idempotency: skip if position already exists for this open tx
            existing = session.exec(
                select(DerivativePosition).where(
                    DerivativePosition.open_transaction_id == db_tx.id,
                )
            ).first()
            if existing is not None:
                log.debug(
                    "derivatives_sync_open_already_exists",
                    coin=coin,
                    open_transaction_id=db_tx.id,
                    position_id=existing.id,
                )
                return False

            exchange = self._resolve_exchange(db_tx)

            position = DerivativePosition(
                account_id=db_tx.account_id,
                connector_id=getattr(db_tx, "connector_id", None),
                exchange=exchange,
                coin=coin,
                side=side,
                status="open",
                entry_price=entry_price,
                size=size,
                remaining_size=size,
                margin_currency=db_tx.source_asset_symbol or intent.margin_currency,
                realized_pnl=Decimal(0),
                total_fees=fee,
                opened_at=db_tx.date_time,
                open_transaction_id=db_tx.id,
                close_transaction_ids=[],
            )
            session.add(position)
            log.debug(
                "derivatives_sync_position_opened",
                coin=coin,
                side=side,
                size=float(size),
                entry_price=float(entry_price),
                tx_id=db_tx.id,
                connector_id=getattr(db_tx, "connector_id", None),
            )
            return True
        else:
            # Adding to an existing open position — update VWAP entry price
            position = self._find_open_position(
                session,
                db_tx.account_id,
                coin,
                connector_id=getattr(db_tx, "connector_id", None),
            )
            if position is None:
                log.warning(
                    "derivatives_sync_add_no_open",
                    coin=coin,
                    account_id=db_tx.account_id,
                )
                return False

            old_size = position.size
            new_total_size = old_size + size
            if new_total_size > 0:
                position.entry_price = (
                    position.entry_price * old_size + entry_price * size
                ) / new_total_size
            position.size = new_total_size
            position.remaining_size = position.remaining_size + size
            position.total_fees = position.total_fees + fee

            log.debug(
                "derivatives_sync_position_added",
                coin=coin,
                new_size=float(new_total_size),
                vwap_entry=float(position.entry_price),
                tx_id=db_tx.id,
            )
            return True

    def _handle_close(
        self, session, db_tx: NormalizedTransaction, intent: PositionIntent
    ) -> bool:
        """Handle a perp_close fill: update PnL, reduce size, potentially close."""
        coin = intent.coin
        close_size = intent.size
        closed_pnl = intent.realized_pnl
        fee = Decimal(str(db_tx.fee or 0))

        position = self._find_open_position(
            session,
            db_tx.account_id,
            coin,
            connector_id=getattr(db_tx, "connector_id", None),
        )
        if position is None:
            log.warning(
                "derivatives_sync_close_no_open",
                coin=coin,
                account_id=db_tx.account_id,
            )
            return False

        # Idempotency: skip if this close fill was already applied
        close_ids = list(position.close_transaction_ids or [])
        if db_tx.id in close_ids:
            log.debug(
                "derivatives_sync_close_already_applied",
                coin=coin,
                tx_id=db_tx.id,
                position_id=position.id,
            )
            return False

        # Update position fields
        position.remaining_size = position.remaining_size - close_size
        position.realized_pnl = position.realized_pnl + closed_pnl
        position.total_fees = position.total_fees + fee

        # Track close transaction
        close_ids.append(db_tx.id)
        position.close_transaction_ids = close_ids

        # Update exit price as VWAP of all close fills
        close_px = intent.execution_price
        if position.exit_price is None:
            position.exit_price = close_px
        else:
            old_total = position.size - position.remaining_size - close_size
            new_total = position.size - position.remaining_size
            if new_total > 0:
                position.exit_price = (
                    (position.exit_price or Decimal(0)) * old_total
                    + close_px * close_size
                ) / new_total

        # Check if fully closed
        if position.remaining_size <= 0:
            position.status = "closed"
            position.closed_at = db_tx.date_time
            position.remaining_size = Decimal(0)

        log.debug(
            "derivatives_sync_close_fill",
            coin=coin,
            close_size=float(close_size),
            remaining=float(position.remaining_size),
            realized_pnl=float(position.realized_pnl),
            status=position.status,
            tx_id=db_tx.id,
        )
        return True

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_position_intent(
        tx: NormalizedTransaction,
    ) -> Optional[PositionIntent]:
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
    def _find_open_position(
        session,
        account_id: int,
        coin: str,
        connector_id: Optional[int] = None,
    ):
        """Find the currently open position for an account+coin pair, scoped by connector."""
        stmt = select(DerivativePosition).where(
            DerivativePosition.account_id == account_id,
            DerivativePosition.coin == coin,
            DerivativePosition.status == "open",
        )
        if connector_id is not None:
            stmt = stmt.where(DerivativePosition.connector_id == connector_id)
        return session.exec(stmt).first()

    @staticmethod
    def _resolve_exchange(db_tx) -> str:
        """Resolve exchange name from ConnectorInfo registry, falling back to source parsing."""
        try:
            from backend.connectors.connector_registry import ConnectorRegistry

            registry = ConnectorRegistry.instance()
            source = getattr(db_tx, "source", "")
            info = registry.get(source)
            if info and info.derivative_exchange:
                return info.derivative_exchange
        except Exception:
            pass
        # Fallback: parse exchange from source string
        source = getattr(db_tx, "source", "unknown")
        if "hyperliquid" in source:
            return "hyperliquid"
        return source.split("-")[0] if "-" in source else source

    @staticmethod
    def _safe_commit(session, operation: str, count: int) -> None:
        """Commit with error handling — derivative positions are non-fatal."""
        try:
            session.commit()
            log.info(
                "derivatives_sync_committed",
                operation=operation,
                count=count,
            )
        except Exception as e:
            session.rollback()
            log.error(
                "derivatives_sync_commit_failed",
                operation=operation,
                error=str(e),
            )
