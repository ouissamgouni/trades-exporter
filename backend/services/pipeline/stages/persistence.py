"""
PersistenceStage - Persist transactions to the database.
"""

from datetime import datetime, timezone
from typing import List, Optional, Tuple

from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction, ensure_utc
from backend.db.repositories import (
    NormalizedTransactionRepository,
    RawTransactionRepository,
)
from backend.services.pipeline.base import PipelineStage
from backend.services.pipeline.context import PersistenceResult, PipelineContext

log = configure_logging("persistence_stage")

# Fields on NormalizedTransaction that link to cascade-deleted children
# (cost_lots, pnl_warnings, calculation_legs, realized_pnl, lot_settlements, cost_lot_events)
# ORM-level session.delete() triggers these cascades automatically.


# Fields that should trigger an update when changed
# Aligned with COMPARABLE_FIELDS from persistence_service_normalized.py
UPDATABLE_FIELDS = [
    # Source metadata
    "source_transaction_type",
    "source_asset_symbol",
    "source_price_quote_asset_symbol",
    "source_fee_quote_asset_symbol",
    
    # Asset resolution
    "asset_id",
    "price_quote_asset_id",
    "fee_quote_asset_id",
    "source_attributed_asset_symbol",
    "attributed_asset_id",
    
    # Core transaction data
    "date_time",
    "direction",
    "transaction_type",
    "quantity",
    "price",
    "fee",
    
    # Account ownership and transfer fields
    "source_account",
    "source_from_account",
    "source_to_account",
    "account_id",
    "from_account_id",
    "to_account_id",
    
    # Blockchain fields
    "network",
    "network_transaction_id",
    "token_contract_address",
    
    # NOTE: include_fee, taxability_status, and review_status are intentionally
    # excluded — these are user-editable settings that should NOT be overwritten
    # by a connector resync. They are only set on initial insert via
    # _pydantic_to_sqlmodel.
]

# Float/Decimal fields that need tolerance-based comparison
FLOAT_FIELDS = {"quantity", "price", "fee"}

# Datetime fields that need timezone-aware comparison
# DB stores TIMESTAMP WITHOUT TIME ZONE (naive), connectors produce aware datetimes.
# We normalize both sides via ensure_utc() before comparing.
DATETIME_FIELDS = {"date_time"}


class PersistenceStage(PipelineStage):
    """
    Persist transactions to the database.

    Handles:
    - Deduplication (skip if already exists)
    - Update detection (update if changed)
    - Raw transaction storage
    """

    @property
    def name(self) -> str:
        return "persistence"

    def should_skip(self, context: PipelineContext) -> bool:
        return context.skip_persistence

    def process(
        self,
        transactions: List[NormalizedTransaction],
        context: PipelineContext,
    ) -> Tuple[List[NormalizedTransaction], bool]:
        """
        Persist transactions to the database.

        Updates context with:
        - Persisted NormalizedTransaction instances (SQLModel)
        - new_count, updated_count, skipped_count statistics
        - persistence_result: PersistenceResult with detailed ID tracking
        """
        raw_repo = RawTransactionRepository(context.session)
        norm_repo = NormalizedTransactionRepository(context.session)

        new_count = 0
        updated_count = 0
        skipped_count = 0

        # Track IDs for sync job connector runs
        result = PersistenceResult()

        for tx in transactions:
            try:
                # Stamp connector_id from pipeline context onto the transaction
                # so it persists correctly (connectors don't set this themselves)
                if tx.connector_id is None and context.connector_id is not None:
                    tx.connector_id = context.connector_id

                # --- Renormalize mode: atomically delete old + insert new ---
                if context.renormalize_mode:
                    # Look up the existing raw transaction record (it already exists in DB)
                    existing_raw = raw_repo.get_by_source(
                        source=tx.source,
                        source_transaction_id=tx.source_transaction_id,
                    )
                    raw_id = existing_raw.id if existing_raw else None

                    if existing_raw:
                        # Delete all existing normalized transactions linked to this raw record
                        # ORM cascade will clean up cost_lots, P&L, warnings, etc.
                        existing_normalized = self._get_normalized_by_raw_id(context.session, existing_raw.id)
                        for old_tx in existing_normalized:
                            context.session.delete(old_tx)
                        if existing_normalized:
                            context.session.flush()  # Execute deletes within same transaction
                            log.debug(
                                f"renormalize_deleted",
                                source=tx.source,
                                tx_id=tx.source_transaction_id,
                                deleted_count=len(existing_normalized),
                            )

                    # Insert fresh normalized transaction
                    db_tx = self._pydantic_to_sqlmodel(tx, raw_id, context.sync_connector_run_id, context.session)
                    norm_repo.create(db_tx)
                    new_count += 1
                    result.synced_ids.append(tx.source_transaction_id)

                    log.debug(
                        "renormalize_saved",
                        source=tx.source,
                        tx_id=tx.source_transaction_id,
                        amount=str(tx.quantity),
                        asset=tx.source_asset_symbol,
                    )
                    continue

                # --- Normal sync mode ---
                # Check for existing transaction (same source + source_transaction_id)
                existing = self._get_existing(context.session, tx)

                if existing:
                    # Check if update needed
                    changed = self._changed_fields(existing, tx)
                    if changed:
                        self._update_transaction(existing, tx, context.sync_connector_run_id)
                        context.session.add(existing)
                        updated_count += 1
                        result.updated_ids.append(tx.source_transaction_id)
                        log.info(
                            "transaction_updated",
                            changed=changed,
                            source=tx.source,
                            tx_type=tx.transaction_type,
                            tx_id=tx.source_transaction_id,
                            amount=str(tx.quantity),
                            asset=tx.source_asset_symbol,
                            timestamp=tx.date_time.isoformat() if tx.date_time else None,
                        )
                    else:
                        # Still update sync_connector_run_id for tracking even if skipped
                        if context.sync_connector_run_id and existing.sync_connector_run_id != context.sync_connector_run_id:
                            existing.sync_connector_run_id = context.sync_connector_run_id
                            context.session.add(existing)
                        
                        skipped_count += 1
                        result.skipped_ids.append(tx.source_transaction_id)
                        log.debug(
                            "transaction_skipped",
                            reason="duplicate",
                            source=tx.source,
                            tx_type=tx.transaction_type,
                            tx_id=tx.source_transaction_id,
                            amount=str(tx.quantity),
                            asset=tx.source_asset_symbol,
                            timestamp=tx.date_time.isoformat() if tx.date_time else None,
                        )
                    continue

                # Insert raw transaction if we have raw_item
                raw_id = None
                if context.raw_item:
                    raw_id = raw_repo.insert(
                        source=tx.source,
                        source_transaction_id=tx.source_transaction_id,
                        raw_data=context.raw_item,
                        connector_id=context.connector_id,
                    )

                # Create normalized transaction
                db_tx = self._pydantic_to_sqlmodel(tx, raw_id, context.sync_connector_run_id, context.session)
                norm_repo.create(db_tx)
                new_count += 1
                result.synced_ids.append(tx.source_transaction_id)

                log.debug(
                    "transaction_saved",
                    source=tx.source,
                    tx_type=tx.transaction_type,
                    tx_id=tx.source_transaction_id,
                    amount=str(tx.quantity),
                    asset=tx.source_asset_symbol,
                    timestamp=tx.date_time.isoformat() if tx.date_time else None,
                )

            except Exception as e:
                error_msg = f"Failed to persist {tx.source_transaction_id}: {e}"
                context.errors.append(error_msg)
                result.error_details.append({
                    "source_transaction_id": tx.source_transaction_id,
                    "error": str(e),
                })
                log.error(error_msg)

        # Commit all changes
        try:
            context.session.commit()
        except Exception as e:
            context.session.rollback()
            context.errors.append(f"Failed to commit: {e}")
            return transactions, False

        # Update context statistics
        context.new_count += new_count
        context.updated_count += updated_count
        context.skipped_count += skipped_count

        # Store persistence result on context for sync job tracking
        context.persistence_result = result

        connector_name = getattr(context, 'connector_name', None) or 'unknown'
        log.debug(
            "persistence_complete",
            connector=connector_name,
            new_count=new_count,
            updated_count=updated_count,
            skipped_count=skipped_count,
        )

        # Return False if any individual transaction failed to persist
        return transactions, len(result.error_details) == 0

    def _get_existing(
        self,
        session,
        tx: NormalizedTransaction,
    ) -> Optional[NormalizedTransaction]:
        """Get existing transaction by source and source_transaction_id."""
        from sqlmodel import select

        statement = select(NormalizedTransaction).where(
            NormalizedTransaction.source == tx.source,
            NormalizedTransaction.source_transaction_id == tx.source_transaction_id,
        )
        return session.exec(statement).first()

    def _get_normalized_by_raw_id(
        self,
        session,
        raw_transaction_id: int,
    ) -> List[NormalizedTransaction]:
        """Get all normalized transactions linked to a raw transaction ID."""
        from sqlmodel import select

        statement = select(NormalizedTransaction).where(
            NormalizedTransaction.raw_transaction_id == raw_transaction_id,
        )
        return list(session.exec(statement).all())

    def _needs_update(
        self,
        existing: NormalizedTransaction,
        new: NormalizedTransaction,
    ) -> bool:
        """Check if existing transaction needs to be updated (tolerant float/datetime comparison)."""
        return bool(self._changed_fields(existing, new))

    def _changed_fields(
        self,
        existing: NormalizedTransaction,
        new: NormalizedTransaction,
    ) -> List[str]:
        """Describe each UPDATABLE_FIELDS difference as 'field: old -> new' (None new values never overwrite)."""
        changed = []
        for field in UPDATABLE_FIELDS:
            old_val = getattr(existing, field, None)
            new_val = getattr(new, field, None)
            if new_val is None:
                continue
            if field in FLOAT_FIELDS:
                same = self._floats_equal(old_val, new_val)
            elif field in DATETIME_FIELDS:
                same = self._datetimes_equal(old_val, new_val)
            else:
                same = old_val == new_val
            if not same:
                changed.append(f"{field}: {old_val!r} -> {new_val!r}")
        return changed

    def _floats_equal(
        self,
        a: Optional[float],
        b: Optional[float],
        rel_tol: float = 1e-9,
        abs_tol: float = 1e-12,
    ) -> bool:
        """
        Compare two floats with tolerance.
        
        Uses relative tolerance for larger numbers and absolute tolerance
        for numbers close to zero.
        """
        if a is None and b is None:
            return True
        if a is None or b is None:
            return False
        
        # Handle exact equality (including both being 0)
        if a == b:
            return True
        
        # Use math.isclose for tolerance-based comparison
        import math
        return math.isclose(a, b, rel_tol=rel_tol, abs_tol=abs_tol)

    @staticmethod
    def _datetimes_equal(
        a: Optional[datetime],
        b: Optional[datetime],
    ) -> bool:
        """
        Compare two datetimes, normalizing timezone info first.

        The DB stores TIMESTAMP WITHOUT TIME ZONE so values read back are
        naive, while connectors produce timezone-aware (UTC) datetimes.
        We call ensure_utc() on both sides so that
        ``datetime(2025,1,1,12,0,0)`` equals
        ``datetime(2025,1,1,12,0,0, tzinfo=utc)``.
        """
        if a is None and b is None:
            return True
        if a is None or b is None:
            return False
        return ensure_utc(a) == ensure_utc(b)

    def _update_transaction(
        self,
        existing: NormalizedTransaction,
        new: NormalizedTransaction,
        sync_connector_run_id: Optional[int] = None,
    ) -> None:
        """Update existing transaction with new values."""
        for field in UPDATABLE_FIELDS:
            new_val = getattr(new, field, None)
            if new_val is not None:
                setattr(existing, field, new_val)

        existing.synced_at = datetime.now(timezone.utc)

        # Track which sync run last touched this transaction
        if sync_connector_run_id:
            existing.sync_connector_run_id = sync_connector_run_id

        # Track which connector produced this transaction
        if hasattr(new, 'connector_id') and new.connector_id is not None:
            existing.connector_id = new.connector_id

    def _pydantic_to_sqlmodel(
        self,
        tx: NormalizedTransaction,
        raw_id: Optional[int],
        sync_connector_run_id: Optional[int] = None,
        session = None,
    ) -> NormalizedTransaction:
        """Convert Pydantic model to SQLModel."""
        # Handle tags — coerce dict to list for legacy/connector compatibility
        tags = tx.tags
        if isinstance(tags, dict):
            tags = [tags] if tags else []
        elif not isinstance(tags, list):
            tags = []

        # Auto-detect include_fee for trades: when the fee is denominated in the
        # same asset as the inflow, the exchange already deducted it from the
        # received quantity — including it again as a separate disposal would
        # double-count and create a spurious negative lot.
        include_fee = tx.include_fee or False
        if tx.transaction_type == "trade" and include_fee and tx.source_fee_quote_asset_symbol:
            fee_sym = (tx.source_fee_quote_asset_symbol or "").upper()
            if tx.direction == "inflow" and fee_sym == (tx.source_asset_symbol or "").upper():
                # Buy: fee in same asset as what we receive → already deducted
                include_fee = False
            elif tx.direction == "outflow" and fee_sym == (tx.source_price_quote_asset_symbol or "").upper():
                # Sell: fee in quote currency → already deducted from proceeds
                include_fee = False

        return NormalizedTransaction(
            source=tx.source,
            account_id=tx.account_id,
            source_transaction_id=tx.source_transaction_id,
            source_transaction_type=tx.source_transaction_type,
            source_asset_symbol=tx.source_asset_symbol,
            source_price_quote_asset_symbol=tx.source_price_quote_asset_symbol,
            source_fee_quote_asset_symbol=tx.source_fee_quote_asset_symbol,
            raw_transaction_id=raw_id,
            sync_connector_run_id=sync_connector_run_id,
            asset_id=tx.asset_id,
            price_quote_asset_id=tx.price_quote_asset_id,
            fee_quote_asset_id=tx.fee_quote_asset_id,
            source_attributed_asset_symbol=tx.source_attributed_asset_symbol,
            attributed_asset_id=tx.attributed_asset_id,
            user_calculation_unit_id=tx.user_calculation_unit_id,
            date_time=tx.date_time,
            direction=tx.direction,
            transaction_type=tx.transaction_type,
            quantity=tx.quantity,
            price=tx.price,
            fee=tx.fee,
            include_fee=include_fee,
            taxability_status=tx.taxability_status or "unknown",
            source_from_account=tx.source_from_account,
            source_to_account=tx.source_to_account,
            from_account_id=tx.from_account_id,
            to_account_id=tx.to_account_id,
            network=tx.network,
            network_transaction_id=tx.network_transaction_id,
            token_contract_address=tx.token_contract_address,
            review_status=tx.review_status or "pending",
            review_notes=tx.review_notes,
            synced_at=datetime.now(timezone.utc),
            tags=tags,
            content_hash=tx.content_hash,  # Include content_hash for cross-source deduplication
            transaction_hash=None,  # No longer computed at persist time; fuzzy detection is view-time
            connector_id=tx.connector_id,  # Link to the connector that produced this
        )

