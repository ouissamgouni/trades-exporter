"""
Raw Transaction endpoints for the Trade Exporter API.

Provides access to original raw transaction data from exchange APIs.
"""

import json
from fastapi import APIRouter, HTTPException, Depends
from typing import Optional, Dict, Any, List
from pydantic import BaseModel
from sqlmodel import Session

from backend.db.database import get_db
from backend.db.repositories.raw_transaction_repository import RawTransactionRepository


router = APIRouter(prefix="/raw-transactions", tags=["Raw Transactions"])

# Maximum raw data size in response (10KB per transaction)
MAX_RAW_DATA_SIZE = 10 * 1024


class RawTransactionResponse(BaseModel):
    """Response model for raw transaction data."""
    id: int
    source: str
    source_transaction_id: str
    raw_data: Dict[str, Any]
    ingestion_time: str
    truncated: bool = False


class BatchRawTransactionRequest(BaseModel):
    """Request model for batch raw transaction fetch."""
    raw_ids: List[int]


class BatchRawTransactionResponse(BaseModel):
    """Response model for batch raw transaction data."""
    transactions: List[RawTransactionResponse]
    total_requested: int
    total_found: int


def _truncate_raw_data(raw_data: Dict[str, Any], max_size: int = MAX_RAW_DATA_SIZE) -> tuple[Dict[str, Any], bool]:
    """Truncate raw data if it exceeds max size.
    
    Returns:
        Tuple of (data, was_truncated)
    """
    serialized = json.dumps(raw_data)
    if len(serialized) <= max_size:
        return raw_data, False
    
    # Return a summary with truncation notice
    return {
        "_truncated": True,
        "_original_size": len(serialized),
        "_max_size": max_size,
        "_message": f"Raw data truncated from {len(serialized)} to {max_size} bytes. Use full=true parameter to get complete data.",
        "_preview": serialized[:max_size - 200] + "..." if len(serialized) > max_size else serialized,
    }, True


@router.get("/{raw_id}", response_model=RawTransactionResponse)
def get_raw_transaction(raw_id: int, full: bool = False, db: Session = Depends(get_db)):
    """
    Get raw transaction by ID.
    
    Returns the original raw data from the exchange API.
    Raw data is truncated to 10KB unless full=true.
    """
    repo = RawTransactionRepository(db)
    raw_tx = repo.get(raw_id)
    
    if not raw_tx:
        raise HTTPException(status_code=404, detail=f"Raw transaction {raw_id} not found")
    
    raw_data = raw_tx.raw_data or {}
    truncated = False
    
    if not full:
        raw_data, truncated = _truncate_raw_data(raw_data)
    
    return RawTransactionResponse(
        id=raw_tx.id,
        source=raw_tx.source,
        source_transaction_id=raw_tx.source_transaction_id,
        raw_data=raw_data,
        ingestion_time=raw_tx.ingestion_time.isoformat() if raw_tx.ingestion_time else "",
        truncated=truncated,
    )


@router.get("/by-source/{source}/{source_transaction_id}", response_model=Optional[RawTransactionResponse])
def get_raw_transaction_by_source(
    source: str, 
    source_transaction_id: str, 
    full: bool = False,
    db: Session = Depends(get_db),
):
    """
    Get raw transaction by source and source_transaction_id.
    
    Useful when you have the source identifiers but not the raw_transaction_id.
    Raw data is truncated to 10KB unless full=true.
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
    
    raw_data = raw_tx.raw_data or {}
    truncated = False
    
    if not full:
        raw_data, truncated = _truncate_raw_data(raw_data)
    
    return RawTransactionResponse(
        id=raw_tx.id,
        source=raw_tx.source,
        source_transaction_id=raw_tx.source_transaction_id,
        raw_data=raw_data,
        ingestion_time=raw_tx.ingestion_time.isoformat() if raw_tx.ingestion_time else "",
        truncated=truncated,
    )


@router.post("/batch", response_model=BatchRawTransactionResponse)
def get_raw_transactions_batch(
    request: BatchRawTransactionRequest,
    full: bool = False,
    db: Session = Depends(get_db),
):
    """
    Get multiple raw transactions by their IDs.
    
    Useful for bulk fetching raw data for job details display.
    Raw data is truncated to 10KB per transaction unless full=true.
    
    Args:
        request: BatchRawTransactionRequest with list of raw_ids
        full: If true, return full raw data without truncation (default: false)
    """
    # Limit batch size to prevent abuse
    MAX_BATCH_SIZE = 100
    if len(request.raw_ids) > MAX_BATCH_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"Batch size exceeds maximum of {MAX_BATCH_SIZE}. Requested: {len(request.raw_ids)}"
        )
    
    repo = RawTransactionRepository(db)
    raw_txs = repo.get_batch_by_ids(request.raw_ids)
    
    transactions = []
    for raw_tx in raw_txs:
        raw_data = raw_tx.raw_data or {}
        truncated = False
        
        if not full:
            raw_data, truncated = _truncate_raw_data(raw_data)
        
        transactions.append(RawTransactionResponse(
            id=raw_tx.id,
            source=raw_tx.source,
            source_transaction_id=raw_tx.source_transaction_id,
            raw_data=raw_data,
            ingestion_time=raw_tx.ingestion_time.isoformat() if raw_tx.ingestion_time else "",
            truncated=truncated,
        ))
    
    return BatchRawTransactionResponse(
        transactions=transactions,
        total_requested=len(request.raw_ids),
        total_found=len(transactions),
    )


@router.get("/{raw_id}/full", response_model=RawTransactionResponse)
def get_raw_transaction_full(raw_id: int, db: Session = Depends(get_db)):
    """
    Get raw transaction by ID with full data (no truncation).
    
    Use this when you need the complete raw data for a single transaction.
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
        truncated=False,
    )


class LookupSourceIdsRequest(BaseModel):
    """Request model for looking up raw_transaction_ids by source_transaction_ids."""
    source_transaction_ids: List[str]


class LookupSourceIdsResponse(BaseModel):
    """Response model mapping source_transaction_ids to raw_transaction_ids."""
    mapping: Dict[str, int]  # source_transaction_id -> raw_transaction_id


@router.post("/lookup-by-source-ids", response_model=LookupSourceIdsResponse)
def lookup_raw_ids_by_source_ids(
    request: LookupSourceIdsRequest,
    db: Session = Depends(get_db),
):
    """
    Look up raw_transaction_ids for a list of source_transaction_ids.
    
    This is useful when you have source_transaction_ids from synced_ids/updated_ids
    and need to fetch the raw data for those transactions.
    
    Returns a mapping of source_transaction_id -> raw_transaction_id for found records.
    Missing records are omitted from the response.
    """
    from sqlmodel import select
    from backend.db.models import NormalizedTransaction
    
    MAX_LOOKUP_SIZE = 200
    if len(request.source_transaction_ids) > MAX_LOOKUP_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"Lookup size exceeds maximum of {MAX_LOOKUP_SIZE}. Requested: {len(request.source_transaction_ids)}"
        )
    
    if not request.source_transaction_ids:
        return LookupSourceIdsResponse(mapping={})
    
    # Query normalized_transactions to get raw_transaction_id mapping
    statement = select(
        NormalizedTransaction.source_transaction_id,
        NormalizedTransaction.raw_transaction_id,
    ).where(
        NormalizedTransaction.source_transaction_id.in_(request.source_transaction_ids),
        NormalizedTransaction.raw_transaction_id.isnot(None),
    )
    
    results = db.exec(statement).all()
    
    # Build mapping (skip duplicates by taking first)
    mapping: Dict[str, int] = {}
    for source_tx_id, raw_tx_id in results:
        if source_tx_id not in mapping and raw_tx_id is not None:
            mapping[source_tx_id] = raw_tx_id
    
    return LookupSourceIdsResponse(mapping=mapping)
