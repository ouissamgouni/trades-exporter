"""
Derivative Position Stage — Creates/updates DerivativePosition records from perp fills.

Designed to run as a BATCH post-processing step after all NTs have been
committed to the DB by the parallel pipeline workers.  This avoids race
conditions caused by multi-threaded workers processing fills out of
chronological order (close before open).

Also used by the legacy per-item pipeline path (process()) which now sorts
transactions by date_time before iterating.

Reads position intent from tags["_position_data"] (set by the connector via
PositionIntent.to_dict()) and manages position lifecycle in the
derivative_positions table.
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
    Pipeline stage that creates/updates derivative position records.

    Position lifecycle:
    - perp_open with start_position=="0" → create new position
    - perp_open with start_position!="0" → add to existing (VWAP entry)
    - perp_close → update PnL, reduce size, potentially close position

    IMPORTANT: This stage is designed to run as a batch post-step after all
    pipeline workers have finished and NTs are committed.  It must NOT run
    in the per-item pipeline because multi-threaded workers process fills
    out of chronological order, causing close fills to arrive before their
    matching opens.
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
        session = context.session
        processed = 0

        # Sort perp txns by date_time so opens are processed before closes
        perp_txns = [
            tx for tx in transactions
            if tx.source_transaction_type in PERP_TYPES
        ]
        perp_txns.sort(
            key=lambda tx: (tx.date_time or 0, tx.source_transaction_id or "")
        )

        for tx in perp_txns:
            # Extract position intent from tags
            intent = self._extract_position_intent(tx)
            if intent is None:
                continue

            # Look up the persisted NT to get its DB id
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
                # Don't fail the pipeline over position tracking errors
                continue

        if processed > 0:
            try:
                session.commit()
                log.debug("derivative_positions_committed", count=processed)
            except Exception as e:
                session.rollback()
                log.error("derivative_positions_commit_failed", error=str(e))
                # Non-fatal: positions are enrichment, not core data
                context.warnings.append(
                    f"Failed to commit derivative positions: {e}"
                )

        return transactions, True

    # ------------------------------------------------------------------
    # Batch entry point (called from sync_job_service after processor.stop)
    # ------------------------------------------------------------------

    def process_batch(
        self,
        session,
        account_ids: Optional[List[int]] = None,
        connector_ids: Optional[List[int]] = None,
    ) -> int:
        """
        Batch-process all perp NTs for given accounts/connectors (or all).

        Queries the DB for perp-type NTs sorted by date_time, then runs
        the position lifecycle with full idempotency (safe for resync).

        Args:
            session: SQLModel session.
            account_ids: Optional list of account IDs to scope the query.
            connector_ids: Optional list of connector IDs to scope the query.
                          Preferred over account_ids for targeted resyncs.

        Returns:
            Number of positions created / updated.
        """
        stmt = (
            select(NormalizedTransaction)
            .where(
                NormalizedTransaction.source_transaction_type.in_(list(PERP_TYPES))
            )
            .order_by(NormalizedTransaction.date_time, NormalizedTransaction.id)
        )
        if connector_ids:
            stmt = stmt.where(NormalizedTransaction.connector_id.in_(connector_ids))
        elif account_ids:
            stmt = stmt.where(NormalizedTransaction.account_id.in_(account_ids))

        db_txns = list(session.exec(stmt).all())
        if not db_txns:
            log.debug("derivative_position_batch_no_perp_txns")
            return 0

        processed = 0
        for db_tx in db_txns:
            intent = self._extract_position_intent(db_tx)
            if intent is None:
                continue

            try:
                did_work = False
                if intent.action == "open":
                    did_work = self._handle_open(session, db_tx, db_tx, intent)
                elif intent.action == "close":
                    did_work = self._handle_close(session, db_tx, db_tx, intent)
                if did_work:
                    processed += 1
            except Exception as e:
                log.warning(
                    "derivative_position_batch_error",
                    source_transaction_id=db_tx.source_transaction_id,
                    error=str(e),
                )
                continue

        if processed > 0:
            try:
                session.commit()
                log.info("derivative_positions_batch_committed", count=processed)
            except Exception as e:
                session.rollback()
                log.error("derivative_positions_batch_commit_failed", error=str(e))

        return processed

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_position_intent(tx: NormalizedTransaction) -> Optional[PositionIntent]:
        """Extract PositionIntent from the first tag dict, if present.

        Supports both the new PositionIntent format (with 'action' key) and
        the legacy _position_data format (with 'is_open'/'is_close' keys).
        """
        if not tx.tags or not isinstance(tx.tags, list) or len(tx.tags) == 0:
            return None
        first_tag = tx.tags[0]
        if not isinstance(first_tag, dict):
            return None
        raw = first_tag.get("_position_data")
        if raw is None:
            return None
        # New format has 'action' key; legacy has 'is_open'/'is_close'
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
        """Handle a perp_open fill: create or add to position. Returns True if work was done."""
        coin = intent.coin
        side = intent.side
        entry_price = intent.execution_price
        size = intent.size
        fee = Decimal(str(tx.fee or 0))

        if intent.is_new_position:
            # --- Idempotency: skip if position already exists for this open tx ---
            existing = session.exec(
                select(DerivativePosition).where(
                    DerivativePosition.open_transaction_id == db_tx.id,
                )
            ).first()
            if existing is not None:
                log.debug(
                    "derivative_position_open_already_exists",
                    coin=coin,
                    open_transaction_id=db_tx.id,
                    position_id=existing.id,
                )
                return False

            # Resolve exchange from ConnectorInfo registry (fallback to source parsing)
            exchange = self._resolve_exchange(db_tx)

            # Create a new position
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
                margin_currency=tx.source_asset_symbol or intent.margin_currency,
                realized_pnl=Decimal(0),
                total_fees=fee,
                opened_at=db_tx.date_time,
                open_transaction_id=db_tx.id,
                close_transaction_ids=[],
            )
            session.add(position)
            log.debug(
                "derivative_position_opened",
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
                session, db_tx.account_id, coin,
                connector_id=getattr(db_tx, "connector_id", None),
            )
            if position is None:
                log.warning(
                    "derivative_position_add_no_open",
                    coin=coin,
                    account_id=db_tx.account_id,
                )
                return False

            old_size = position.size
            new_total_size = old_size + size
            if new_total_size > 0:
                # VWAP: (old_entry * old_size + new_entry * new_size) / total_size
                position.entry_price = (
                    position.entry_price * old_size + entry_price * size
                ) / new_total_size
            position.size = new_total_size
            position.remaining_size = position.remaining_size + size
            position.total_fees = position.total_fees + fee

            log.debug(
                "derivative_position_added",
                coin=coin,
                new_size=float(new_total_size),
                vwap_entry=float(position.entry_price),
                tx_id=db_tx.id,
            )
            return True

    def _handle_close(self, session, db_tx, tx, intent: PositionIntent) -> bool:
        """Handle a perp_close fill: update PnL, reduce size, potentially close. Returns True if work was done."""
        coin = intent.coin
        close_size = intent.size
        closed_pnl = intent.realized_pnl
        fee = Decimal(str(tx.fee or 0))

        position = self._find_open_position(
            session, db_tx.account_id, coin,
            connector_id=getattr(db_tx, "connector_id", None),
        )
        if position is None:
            log.warning(
                "derivative_position_close_no_open",
                coin=coin,
                account_id=db_tx.account_id,
            )
            return False

        # --- Idempotency: skip if this close fill was already applied ---
        close_ids = list(position.close_transaction_ids or [])
        if db_tx.id in close_ids:
            log.debug(
                "derivative_position_close_already_applied",
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
            # Running VWAP weighted by size
            old_total = position.size - position.remaining_size - close_size
            new_total = position.size - position.remaining_size
            if new_total > 0:
                position.exit_price = (
                    (position.exit_price or Decimal(0)) * old_total + close_px * close_size
                ) / new_total

        # Check if fully closed
        if position.remaining_size <= 0:
            position.status = "closed"
            position.closed_at = db_tx.date_time
            position.remaining_size = Decimal(0)  # Clamp

        log.debug(
            "derivative_position_close_fill",
            coin=coin,
            close_size=float(close_size),
            remaining=float(position.remaining_size),
            realized_pnl=float(position.realized_pnl),
            status=position.status,
            tx_id=db_tx.id,
        )
        return True

    @staticmethod
    def _find_open_position(session, account_id: int, coin: str, connector_id: Optional[int] = None):
        """Find the currently open position for an account+coin pair, optionally scoped by connector."""
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
            # Try to find the connector info by looking up connector_id
            connector_id = getattr(db_tx, "connector_id", None)
            if connector_id:
                from backend.db.models import AccountConnector
                # We can't query DB here easily; fall back to source-based lookup
                pass

            # Look up by source string (e.g. "hyperliquid-perps")
            source = getattr(db_tx, "source", "")
            info = registry.get(source)
            if info and info.derivative_exchange:
                return info.derivative_exchange
        except Exception:
            pass
        # Fallback: parse exchange from source string
        return DerivativePositionStage._exchange_from_source(
            getattr(db_tx, "source", "unknown")
        )

    @staticmethod
    def _exchange_from_source(source: str) -> str:
        """Derive exchange name from the connector source string (legacy fallback)."""
        if "hyperliquid" in source:
            return "hyperliquid"
        return source.split("-")[0] if "-" in source else source
