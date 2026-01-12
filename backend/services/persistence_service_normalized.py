"""Trade Persistence Service: Handles persisting normalized trade data from connectors.
Separates persistence concerns from data fetching/normalization.

NOTE: Leg expansion (creating cost/proceeds/acquired/disposed/fee legs) is NOT done here.
Expansion is a separate orchestration concern that should happen AFTER normalization,
either via the migration script or a dedicated expansion step in the pipeline.
"""

from dataclasses import dataclass
from datetime import datetime, date, timezone
from decimal import Decimal
from typing import Dict, Any, Union, Optional, Tuple
from sqlmodel import Session, select

from backend.config.loader import configure_logging
from backend.db.database import get_engine
from backend.db.models import NormalizedTransaction
from backend.db.repositories import (
    RawTransactionRepository,
    NormalizedTransactionRepository,
)

log = configure_logging("trade_persistence")


# Fields to compare for updates (excluding metadata fields that shouldn't trigger updates)
# Note: *_in_base fields removed - base currency is a P&L runtime config, not normalization-time
COMPARABLE_FIELDS = [
    "source_transaction_type",
    "source_asset_symbol",
    "source_price_quote_asset_symbol",
    "source_fee_quote_asset_symbol",
    "asset_id",
    "price_quote_asset_id",
    "fee_quote_asset_id",
    "date_time",
    "direction",
    "transaction_type",
    "quantity",
    "price",
    "total",
    "fee",
    "from_address",
    "to_address",
    "network",
    "network_transaction_id",
    "token_contract_address",
]


@dataclass
class UpdateResult:
    """Result of an update operation."""

    updated: bool
    changes: Dict[str, Tuple[Any, Any]]  # field -> (old_value, new_value)


def make_json_serializable(obj: Any) -> Any:
    """
    Recursively convert an object to JSON-serializable types.
    """
    if obj is None:
        return None
    if isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, dict):
        return {k: make_json_serializable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [make_json_serializable(item) for item in obj]
    if hasattr(obj, "model_dump"):
        return make_json_serializable(obj.model_dump())
    if hasattr(obj, "dict"):
        return make_json_serializable(obj.dict())
    return str(obj)


class PersistenceServiceNormalizedTrx:
    """
    Service responsible for persisting normalized trade data from connectors.
    Handles database operations, deduplication, and error handling.
    Uses SQLModel with PostgreSQL.
    """

    def __init__(self):
        """
        Initialize the persistence service with database session.
        """
        self.engine = get_engine()
        self._session: Optional[Session] = None

    @property
    def session(self) -> Session:
        """Get or create a database session."""
        if self._session is None:
            self._session = Session(self.engine)
        return self._session

    @property
    def raw_repo(self) -> RawTransactionRepository:
        """Get raw transaction repository."""
        return RawTransactionRepository(self.session)

    @property
    def norm_repo(self) -> NormalizedTransactionRepository:
        """Get normalized transaction repository."""
        return NormalizedTransactionRepository(self.session)

    def exists(self, source: str, source_transaction_id: str) -> bool:
        """
        Check if a normalized transaction already exists in the database.

        Args:
            source: Source connector name.
            source_transaction_id: Unique transaction ID from the source.

        Returns:
            bool: True if the transaction exists, False otherwise.
        """
        return self.norm_repo.exists(source, source_transaction_id)

    def get_existing(
        self, source: str, source_transaction_id: str
    ) -> Optional[NormalizedTransaction]:
        """
        Get an existing normalized transaction from the database.

        Args:
            source: Source connector name.
            source_transaction_id: Unique transaction ID from the source.

        Returns:
            NormalizedTransaction if found, None otherwise.
        """
        statement = select(NormalizedTransaction).where(
            NormalizedTransaction.source == source,
            NormalizedTransaction.source_transaction_id == source_transaction_id,
        )
        return self.session.exec(statement).first()

    def update_if_changed(
        self,
        existing: NormalizedTransaction,
        new_item: Union[Dict[str, Any], NormalizedTransaction],
    ) -> UpdateResult:
        """
        Compare existing transaction with new data and update if there are differences.

        Args:
            existing: The existing transaction in the database.
            new_item: The new transaction data to compare against.

        Returns:
            UpdateResult with updated flag and dict of changes (field -> (old, new)).
        """
        changes: Dict[str, Tuple[Any, Any]] = {}

        for field in COMPARABLE_FIELDS:
            old_value = getattr(existing, field, None)

            if isinstance(new_item, NormalizedTransaction):
                new_value = getattr(new_item, field, None)
            else:
                new_value = new_item.get(field)

            # Normalize values for comparison
            old_normalized = self._normalize_value(old_value)
            new_normalized = self._normalize_value(new_value)

            # Skip if new value is None (don't overwrite with None)
            if new_normalized is None:
                continue

            # Check if values differ
            if old_normalized != new_normalized:
                changes[field] = (old_value, new_value)
                setattr(existing, field, new_value)

        if changes:
            existing.synced_at = datetime.now(timezone.utc)
            self.session.add(existing)
            self.session.commit()
            return UpdateResult(updated=True, changes=changes)

        return UpdateResult(updated=False, changes={})

    def _normalize_value(self, value: Any) -> Any:
        """Normalize a value for comparison."""
        if value is None:
            return None
        if isinstance(value, datetime):
            # Normalize datetime: remove timezone info for comparison
            # Both naive and aware datetimes are compared by their raw components
            if value.tzinfo is not None:
                # Convert to UTC and make naive for comparison
                from datetime import timezone

                utc_value = value.astimezone(timezone.utc)
                return (
                    utc_value.year,
                    utc_value.month,
                    utc_value.day,
                    utc_value.hour,
                    utc_value.minute,
                    utc_value.second,
                )
            else:
                # Treat naive datetime as UTC
                return (
                    value.year,
                    value.month,
                    value.day,
                    value.hour,
                    value.minute,
                    value.second,
                )
        if isinstance(value, Decimal):
            return float(value)
        if isinstance(value, float):
            # Round floats to avoid precision issues
            return round(value, 8)
        return value

    def persist(
        self,
        normalized_item: Union[Dict[str, Any], NormalizedTransaction],
        raw_item: Dict[str, Any],
    ) -> NormalizedTransaction:
        """
        Persist trades from a connector's yield_normalized() generator.
        Accepts NormalizedTransaction Pydantic model (preferred) or dict (backward compatibility).

        NOTE: This method only persists the transaction. Leg expansion (creating
        cost/proceeds/acquired/disposed/fee legs) should be done separately after
        normalization is complete, via the migration script or pipeline orchestrator.

        Returns the SQLModel NormalizedTransaction that was persisted.
        """
        try:
            # Extract source info from the normalized item
            if isinstance(normalized_item, NormalizedTransaction):
                source = normalized_item.source
                source_transaction_id = normalized_item.source_transaction_id
            else:
                source = normalized_item.get("source")
                source_transaction_id = normalized_item.get("source_transaction_id")

            if not source_transaction_id or not source:
                raise ValueError(
                    "Missing source or source_transaction_id in transaction"
                )

            # Insert raw data after successful normalization
            raw_id = self.raw_repo.insert(
                source=source,
                source_transaction_id=source_transaction_id,
                raw_data=raw_item,
            )

            # Convert Pydantic model to SQLModel
            norm_tx = self._pydantic_to_sqlmodel(normalized_item, raw_id)

            # Insert normalized transaction
            created = self.norm_repo.create(norm_tx)

            # Commit the transaction
            self.session.commit()
            self.session.refresh(created)

            log.debug(
                f"Inserted {source} transaction: raw_id={raw_id}, norm_id={created.id}"
            )
            return created

        except Exception as e:
            self.session.rollback()
            log.error(f"Error in persistence service: {e}")
            raise

    def _pydantic_to_sqlmodel(
        self, pydantic_model: NormalizedTransaction, raw_id: int
    ) -> NormalizedTransaction:
        """Convert Pydantic NormalizedTransaction to SQLModel."""
        # Handle tags - convert to dict if needed and serialize for JSON
        tags = pydantic_model.tags if isinstance(pydantic_model.tags, dict) else {}
        tags = make_json_serializable(tags)

        return NormalizedTransaction(
            source=pydantic_model.source,
            account_id=pydantic_model.account_id,
            source_transaction_id=pydantic_model.source_transaction_id,
            source_transaction_type=pydantic_model.source_transaction_type,
            source_asset_symbol=pydantic_model.source_asset_symbol,
            source_price_quote_asset_symbol=pydantic_model.source_price_quote_asset_symbol,
            source_fee_quote_asset_symbol=pydantic_model.source_fee_quote_asset_symbol,
            raw_transaction_id=raw_id,
            asset_id=pydantic_model.asset_id,
            price_quote_asset_id=pydantic_model.price_quote_asset_id,
            fee_quote_asset_id=pydantic_model.fee_quote_asset_id,
            user_calculation_unit_id=pydantic_model.user_calculation_unit_id,
            date_time=pydantic_model.date_time,
            direction=pydantic_model.direction,
            transaction_type=pydantic_model.transaction_type,
            quantity=pydantic_model.quantity,
            price=pydantic_model.price,
            fee=pydantic_model.fee,
            include_fee=pydantic_model.include_fee or False,
            disposal_taxable=pydantic_model.disposal_taxable or False,
            source_from_account=pydantic_model.source_from_account,
            source_to_account=pydantic_model.source_to_account,
            from_account_id=pydantic_model.from_account_id,
            to_account_id=pydantic_model.to_account_id,
            network=pydantic_model.network,
            network_transaction_id=pydantic_model.network_transaction_id,
            token_contract_address=pydantic_model.token_contract_address,
            review_status=pydantic_model.review_status or "pending",
            review_notes=pydantic_model.review_notes,
            synced_at=datetime.now(timezone.utc),
            tags=tags,
        )

    def close(self):
        """Close database session."""
        try:
            if self._session:
                self._session.close()
                self._session = None
            log.debug("Persistence service closed")
        except Exception as e:
            log.error(f"Error closing persistence service: {e}")

    def __enter__(self):
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit - ensure session is closed."""
        self.close()
