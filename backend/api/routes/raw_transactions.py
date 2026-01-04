"""
Raw Transaction endpoints for the Trade Exporter API.

Provides access to original raw transaction data from exchange APIs.
"""

from fastapi import APIRouter, HTTPException, Depends
from typing import Optional, Dict, Any
from pydantic import BaseModel
from sqlmodel import Session

from backend.db.database import get_db
from backend.db.repositories.raw_transaction_repository import RawTransactionRepository


router = APIRouter(prefix="/raw-transactions", tags=["Raw Transactions"])


class RawTransactionResponse(BaseModel):
    """Response model for raw transaction data."""
    id: int
    source: str
    source_transaction_id: str
    raw_data: Dict[str, Any]
    ingestion_time: str


@router.get("/{raw_id}", response_model=RawTransactionResponse)
def get_raw_transaction(raw_id: int, db: Session = Depends(get_db)):
    """
    Get raw transaction by ID.
    
    Returns the original raw data from the exchange API.
    """
    repo = RawTransactionRepository(db)
    raw_tx = repo.get(raw_id)
    
    if not raw_tx:
        raise HTTPException(status_code=404, detail=f"Raw transaction {raw_id} not found")
    
    return RawTransactionResponse(
        id=raw_tx.id,
        source=raw_tx.source,
        source_transaction_id=raw_tx.source_transaction_id,
        raw_data=raw_tx.raw_data or {},
        ingestion_time=raw_tx.ingestion_time.isoformat() if raw_tx.ingestion_time else "",
    )


@router.get("/by-source/{source}/{source_transaction_id}", response_model=Optional[RawTransactionResponse])
def get_raw_transaction_by_source(source: str, source_transaction_id: str, db: Session = Depends(get_db)):
    """
    Get raw transaction by source and source_transaction_id.
    
    Useful when you have the source identifiers but not the raw_transaction_id.
    """
    from sqlmodel import select
    from backend.db.models import RawTransaction
    
    statement = select(RawTransaction).where(
        RawTransaction.source == source,
        RawTransaction.source_transaction_id == source_transaction_id,
    )
    raw_tx = db.exec(statement).first()
    
    if not raw_tx:
        raise HTTPException(
            status_code=404, 
            detail=f"Raw transaction not found for source={source}, id={source_transaction_id}"
        )
    
    return RawTransactionResponse(
        id=raw_tx.id,
        source=raw_tx.source,
        source_transaction_id=raw_tx.source_transaction_id,
        raw_data=raw_tx.raw_data or {},
        ingestion_time=raw_tx.ingestion_time.isoformat() if raw_tx.ingestion_time else "",
    )
