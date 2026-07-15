"""
Raw Transaction Repository - CRUD operations for raw transactions.
"""

from typing import Optional, Dict, Any, Generator, List
from sqlmodel import Session, select, func

from backend.db.models import RawTransaction
from backend.db.repositories.base import make_json_serializable


class RawTransactionRepository:
    """Repository for RawTransaction CRUD operations."""

    def __init__(self, session: Session):
        self.session = session

    def create(self, raw_tx: RawTransaction) -> RawTransaction:
        """Create a new raw transaction."""
        self.session.add(raw_tx)
        self.session.flush()
        self.session.refresh(raw_tx)
        return raw_tx

    def insert(
        self, source: str, source_transaction_id: str, raw_data: Dict[str, Any],
        connector_id: Optional[int] = None
    ) -> int:
        """Insert a raw transaction and return its ID.
        
        Args:
            source: Source identifier (e.g., "binance_trx")
            source_transaction_id: External transaction ID for deduplication
            raw_data: Raw JSON data from the source API
            connector_id: Optional FK to account_connectors.id (for incremental sync tracking)
        
        Returns:
            The ID of the created raw transaction
        """
        # Ensure raw_data is JSON-serializable
        serializable_data = make_json_serializable(raw_data)

        raw_tx = RawTransaction(
            source=source,
            source_transaction_id=source_transaction_id,
            raw_data=serializable_data,
            connector_id=connector_id,
        )
        self.create(raw_tx)
        return raw_tx.id

    def get(self, raw_id: int) -> Optional[RawTransaction]:
        """Get a raw transaction by ID."""
        return self.session.get(RawTransaction, raw_id)

    def exists(self, source: str, source_transaction_id: str) -> bool:
        """Check if a raw transaction exists."""
        statement = select(RawTransaction).where(
            RawTransaction.source == source,
            RawTransaction.source_transaction_id == source_transaction_id,
        )
        return self.session.exec(statement).first() is not None

    def get_batch_by_ids(self, raw_ids: list[int]) -> list[RawTransaction]:
        """Get multiple raw transactions by their IDs.
        
        Args:
            raw_ids: List of raw transaction IDs
            
        Returns:
            List of RawTransaction objects (may be fewer than requested if some IDs don't exist)
        """
        if not raw_ids:
            return []
        statement = select(RawTransaction).where(RawTransaction.id.in_(raw_ids))
        return list(self.session.exec(statement).all())

    def get_batch_by_source_ids(
        self, source: str, source_transaction_ids: list[str]
    ) -> list[RawTransaction]:
        """Get multiple raw transactions by source and source_transaction_ids.
        
        Args:
            source: Source identifier (e.g., "binance_trx")
            source_transaction_ids: List of external transaction IDs
            
        Returns:
            List of RawTransaction objects
        """
        if not source_transaction_ids:
            return []
        statement = select(RawTransaction).where(
            RawTransaction.source == source,
            RawTransaction.source_transaction_id.in_(source_transaction_ids),
        )
        return list(self.session.exec(statement).all())

    def iter_by_connector_id(
        self, connector_id: int, batch_size: int = 500
    ) -> Generator[List[RawTransaction], None, None]:
        """Yield batches of raw transactions for a given connector_id.
        
        Args:
            connector_id: The AccountConnector ID to filter by
            batch_size: Number of records per batch
            
        Yields:
            Lists of RawTransaction objects, each list up to batch_size items
        """
        offset = 0
        while True:
            statement = (
                select(RawTransaction)
                .where(RawTransaction.connector_id == connector_id)
                .order_by(RawTransaction.id)
                .offset(offset)
                .limit(batch_size)
            )
            batch = list(self.session.exec(statement).all())
            if not batch:
                break
            yield batch
            offset += batch_size

    def count_by_connector_id(self, connector_id: int) -> int:
        """Count raw transactions for a given connector_id.
        
        Args:
            connector_id: The AccountConnector ID to filter by
            
        Returns:
            Number of raw transactions for this connector
        """
        statement = (
            select(func.count())
            .select_from(RawTransaction)
            .where(RawTransaction.connector_id == connector_id)
        )
        return self.session.exec(statement).one()

    def get_by_source(
        self, source: str, source_transaction_id: str
    ) -> Optional[RawTransaction]:
        """Get a raw transaction by source and source_transaction_id.
        
        Args:
            source: Source identifier (e.g., "binance_trx")
            source_transaction_id: External transaction ID
            
        Returns:
            RawTransaction if found, None otherwise
        """
        statement = select(RawTransaction).where(
            RawTransaction.source == source,
            RawTransaction.source_transaction_id == source_transaction_id,
        )
        return self.session.exec(statement).first()
