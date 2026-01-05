"""
Price Snapshots endpoints for the Trade Exporter API.
"""

from datetime import datetime
from decimal import Decimal
from fastapi import APIRouter, HTTPException, Query, Depends
from typing import List, Optional
from pydantic import BaseModel
from sqlmodel import Session, select

from backend.db.database import get_db
from backend.db.models import PriceSnapshot, Asset, ensure_utc

router = APIRouter(prefix="/price-snapshots", tags=["Price Snapshots"])


class BulkDeleteRequest(BaseModel):
    """Request model for bulk deleting price snapshots."""

    snapshot_ids: List[int]


class BulkOperationResponse(BaseModel):
    """Response model for bulk operations."""

    success: bool
    affected_count: int
    message: str
    errors: List[str] = []


def parse_datetime(dt_str: str) -> datetime:
    """Parse datetime string to timezone-aware datetime object."""
    try:
        dt = datetime.fromisoformat(dt_str)
        return ensure_utc(dt)
    except ValueError:
        # Try other common formats
        for fmt in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"]:
            try:
                dt = datetime.strptime(dt_str, fmt)
                return ensure_utc(dt)
            except ValueError:
                continue
        raise ValueError(f"Invalid datetime format: {dt_str}")


class PriceSnapshotCreate(BaseModel):
    """Request model for creating a price snapshot."""

    asset_id: int
    quote_asset_id: Optional[int] = None
    snapshot_time: str
    price: float
    source: Optional[str] = None


class PriceSnapshotUpdate(BaseModel):
    """Request model for updating a price snapshot."""

    price: Optional[float] = None
    source: Optional[str] = None


class PriceSnapshotResponse(BaseModel):
    """Response model for price snapshot."""

    snapshot_id: int
    asset_id: int
    quote_asset_id: Optional[int] = None
    snapshot_time: str
    price: float
    source: Optional[str] = None
    created_at: Optional[str] = None
    # Joined fields
    asset_symbol: Optional[str] = None
    quote_asset_symbol: Optional[str] = None


@router.get("", response_model=List[PriceSnapshotResponse])
def list_price_snapshots(
    asset_id: Optional[int] = Query(None, description="Filter by asset ID"),
    quote_asset_id: Optional[int] = Query(None, description="Filter by quote asset ID"),
    source: Optional[str] = Query(None, description="Filter by source"),
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of results"),
    offset: int = Query(0, ge=0, description="Number of results to skip"),
    session: Session = Depends(get_db),
):
    """
    List price snapshots with optional filtering.

    - **asset_id**: Filter by asset ID
    - **quote_asset_id**: Filter by quote asset ID
    - **source**: Filter by price source
    - **limit**: Maximum number of results to return
    - **offset**: Number of results to skip for pagination
    """
    try:
        statement = select(PriceSnapshot)

        if asset_id is not None:
            statement = statement.where(PriceSnapshot.asset_id == asset_id)

        if quote_asset_id is not None:
            statement = statement.where(PriceSnapshot.quote_asset_id == quote_asset_id)

        if source:
            statement = statement.where(PriceSnapshot.source == source)

        statement = (
            statement.order_by(PriceSnapshot.snapshot_time.desc())
            .offset(offset)
            .limit(limit)
        )

        snapshots = session.exec(statement).all()

        results = []
        for s in snapshots:
            # Get asset symbols
            asset_symbol = None
            quote_symbol = None

            asset = session.get(Asset, s.asset_id)
            if asset:
                asset_symbol = asset.symbol

            if s.quote_asset_id:
                quote_asset = session.get(Asset, s.quote_asset_id)
                if quote_asset:
                    quote_symbol = quote_asset.symbol

            results.append(
                PriceSnapshotResponse(
                    snapshot_id=s.snapshot_id,
                    asset_id=s.asset_id,
                    quote_asset_id=s.quote_asset_id,
                    snapshot_time=s.snapshot_time.isoformat()
                    if s.snapshot_time
                    else None,
                    price=float(s.price),
                    source=s.source,
                    created_at=s.created_at.isoformat() if s.created_at else None,
                    asset_symbol=asset_symbol,
                    quote_asset_symbol=quote_symbol,
                )
            )

        return results

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/{snapshot_id}", response_model=PriceSnapshotResponse)
def get_price_snapshot(
    snapshot_id: int,
    session: Session = Depends(get_db),
):
    """
    Get a specific price snapshot by ID.

    - **snapshot_id**: The snapshot ID
    """
    try:
        snapshot = session.get(PriceSnapshot, snapshot_id)

        if not snapshot:
            raise HTTPException(status_code=404, detail="Price snapshot not found")

        # Get asset symbols
        asset_symbol = None
        quote_symbol = None

        asset = session.get(Asset, snapshot.asset_id)
        if asset:
            asset_symbol = asset.symbol

        if snapshot.quote_asset_id:
            quote_asset = session.get(Asset, snapshot.quote_asset_id)
            if quote_asset:
                quote_symbol = quote_asset.symbol

        return PriceSnapshotResponse(
            snapshot_id=snapshot.snapshot_id,
            asset_id=snapshot.asset_id,
            quote_asset_id=snapshot.quote_asset_id,
            snapshot_time=snapshot.snapshot_time.isoformat()
            if snapshot.snapshot_time
            else None,
            price=float(snapshot.price),
            source=snapshot.source,
            created_at=snapshot.created_at.isoformat() if snapshot.created_at else None,
            asset_symbol=asset_symbol,
            quote_asset_symbol=quote_symbol,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.post("", response_model=PriceSnapshotResponse)
def create_price_snapshot(
    data: PriceSnapshotCreate,
    session: Session = Depends(get_db),
):
    """
    Create a new price snapshot record.

    - **data**: The price snapshot data to create
    """
    try:
        dt = parse_datetime(data.snapshot_time)

        snapshot = PriceSnapshot(
            asset_id=data.asset_id,
            quote_asset_id=data.quote_asset_id,
            snapshot_time=dt,
            price=Decimal(str(data.price)),
            source=data.source,
        )

        session.add(snapshot)
        session.commit()
        session.refresh(snapshot)

        # Get asset symbols
        asset_symbol = None
        quote_symbol = None

        asset = session.get(Asset, snapshot.asset_id)
        if asset:
            asset_symbol = asset.symbol

        if snapshot.quote_asset_id:
            quote_asset = session.get(Asset, snapshot.quote_asset_id)
            if quote_asset:
                quote_symbol = quote_asset.symbol

        return PriceSnapshotResponse(
            snapshot_id=snapshot.snapshot_id,
            asset_id=snapshot.asset_id,
            quote_asset_id=snapshot.quote_asset_id,
            snapshot_time=snapshot.snapshot_time.isoformat()
            if snapshot.snapshot_time
            else None,
            price=float(snapshot.price),
            source=snapshot.source,
            created_at=snapshot.created_at.isoformat() if snapshot.created_at else None,
            asset_symbol=asset_symbol,
            quote_asset_symbol=quote_symbol,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.patch("/{snapshot_id}", response_model=PriceSnapshotResponse)
def update_price_snapshot(
    snapshot_id: int,
    update: PriceSnapshotUpdate,
    session: Session = Depends(get_db),
):
    """
    Update an existing price snapshot.

    - **snapshot_id**: The snapshot ID
    - **update**: Fields to update (only provided fields will be changed)
    """
    try:
        existing = session.get(PriceSnapshot, snapshot_id)

        if not existing:
            raise HTTPException(status_code=404, detail="Price snapshot not found")

        # Update only provided fields
        update_data = update.model_dump(exclude_unset=True)

        if "price" in update_data:
            update_data["price"] = Decimal(str(update_data["price"]))

        for key, value in update_data.items():
            setattr(existing, key, value)

        session.add(existing)
        session.commit()
        session.refresh(existing)

        # Get asset symbols
        asset_symbol = None
        quote_symbol = None

        asset = session.get(Asset, existing.asset_id)
        if asset:
            asset_symbol = asset.symbol

        if existing.quote_asset_id:
            quote_asset = session.get(Asset, existing.quote_asset_id)
            if quote_asset:
                quote_symbol = quote_asset.symbol

        return PriceSnapshotResponse(
            snapshot_id=existing.snapshot_id,
            asset_id=existing.asset_id,
            quote_asset_id=existing.quote_asset_id,
            snapshot_time=existing.snapshot_time.isoformat()
            if existing.snapshot_time
            else None,
            price=float(existing.price),
            source=existing.source,
            created_at=existing.created_at.isoformat() if existing.created_at else None,
            asset_symbol=asset_symbol,
            quote_asset_symbol=quote_symbol,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.post("/bulk/delete", response_model=BulkOperationResponse)
def bulk_delete_price_snapshots(
    request: BulkDeleteRequest,
    session: Session = Depends(get_db),
):
    """
    Delete multiple price snapshots by their IDs.

    - **snapshot_ids**: List of snapshot IDs to delete
    """
    if not request.snapshot_ids:
        return BulkOperationResponse(
            success=True,
            affected_count=0,
            message="No snapshot IDs provided",
            errors=[],
        )

    errors = []
    deleted_count = 0

    try:
        for snapshot_id in request.snapshot_ids:
            snapshot = session.get(PriceSnapshot, snapshot_id)
            if snapshot:
                session.delete(snapshot)
                deleted_count += 1
            else:
                errors.append(f"Snapshot ID {snapshot_id} not found")

        session.commit()

        return BulkOperationResponse(
            success=len(errors) == 0,
            affected_count=deleted_count,
            message=f"Deleted {deleted_count} price snapshot(s)",
            errors=errors,
        )

    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.delete("/{snapshot_id}")
def delete_price_snapshot(
    snapshot_id: int,
    session: Session = Depends(get_db),
):
    """
    Delete a price snapshot by ID.

    - **snapshot_id**: The snapshot ID
    """
    try:
        existing = session.get(PriceSnapshot, snapshot_id)

        if not existing:
            raise HTTPException(status_code=404, detail="Price snapshot not found")

        session.delete(existing)
        session.commit()

        return {
            "message": "Price snapshot deleted successfully",
            "snapshot_id": snapshot_id,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
