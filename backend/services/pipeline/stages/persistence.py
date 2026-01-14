"""
PersistenceStage - Persist transactions to the database.
"""

from datetime import datetime, timezone
from typing import List, Optional, Tuple

from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction
from backend.db.repositories import (
    NormalizedTransactionRepository,
    RawTransactionRepository,
)
from backend.services.pipeline.base import PipelineStage
from backend.services.pipeline.context import PersistenceResult, PipelineContext

log = configure_logging("persistence_stage")


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
                # Check for existing transaction
                existing = self._get_existing(context.session, tx)

                if existing:
                    # Check if update needed
                    if self._needs_update(existing, tx):
                        self._update_transaction(existing, tx, context.sync_connector_run_id)
                        context.session.add(existing)
                        updated_count += 1
                        result.updated_ids.append(tx.source_transaction_id)
                        log.debug(f"Updated transaction {tx.source_transaction_id}")
                    else:
                        skipped_count += 1
                        result.skipped_ids.append(tx.source_transaction_id)
                        log.debug(f"Skipped duplicate {tx.source_transaction_id}")
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
                db_tx = self._pydantic_to_sqlmodel(tx, raw_id, context.sync_connector_run_id)
                norm_repo.create(db_tx)
                new_count += 1
                result.synced_ids.append(tx.source_transaction_id)

                log.debug(f"Created transaction {tx.source_transaction_id}")

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

        log.info(
            f"Persistence complete: {new_count} new, "
            f"{updated_count} updated, {skipped_count} skipped"
        )

        return transactions, True

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

    def _needs_update(
        self,
        existing: NormalizedTransaction,
        new: NormalizedTransaction,
    ) -> bool:
        """Check if existing transaction needs to be updated."""
        # Compare key fields
        fields_to_compare = [
            "quantity",
            "price",
            "total",
            "fee",
            "direction",
            "transaction_type",
            "asset_id",
            "price_quote_asset_id",
            "fee_quote_asset_id",
            "from_account_id",
            "to_account_id",
        ]

        for field in fields_to_compare:
            old_val = getattr(existing, field, None)
            new_val = getattr(new, field, None)

            # Skip if new value is None (don't overwrite with None)
            if new_val is None:
                continue

            if old_val != new_val:
                return True

        return False

    def _update_transaction(
        self,
        existing: NormalizedTransaction,
        new: NormalizedTransaction,
        sync_connector_run_id: Optional[int] = None,
    ) -> None:
        """Update existing transaction with new values."""
        # Update fields that changed
        updatable_fields = [
            "source_transaction_type",
            "source_asset_symbol",
            "source_price_quote_asset_symbol",
            "source_fee_quote_asset_symbol",
            "asset_id",
            "price_quote_asset_id",
            "fee_quote_asset_id",
            "direction",
            "transaction_type",
            "quantity",
            "price",
            "total",
            "fee",
            "from_account_id",
            "to_account_id",
            "group_id",
            "disposal_taxable",
        ]

        for field in updatable_fields:
            new_val = getattr(new, field, None)
            if new_val is not None:
                setattr(existing, field, new_val)

        existing.synced_at = datetime.now(timezone.utc)

        # Track which sync run last touched this transaction
        if sync_connector_run_id:
            existing.sync_connector_run_id = sync_connector_run_id

    def _pydantic_to_sqlmodel(
        self,
        tx: NormalizedTransaction,
        raw_id: Optional[int],
        sync_connector_run_id: Optional[int] = None,
    ) -> NormalizedTransaction:
        """Convert Pydantic model to SQLModel."""
        # Handle tags
        tags = tx.tags if isinstance(tx.tags, dict) else {}

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
            user_calculation_unit_id=tx.user_calculation_unit_id,
            date_time=tx.date_time,
            direction=tx.direction,
            transaction_type=tx.transaction_type,
            quantity=tx.quantity,
            price=tx.price,
            fee=tx.fee,
            include_fee=tx.include_fee or False,
            disposal_taxable=tx.disposal_taxable or False,
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
        )
