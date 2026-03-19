"""
Price Snapshots endpoints for the Trade Exporter API.
"""

from datetime import datetime, timezone
from decimal import Decimal
from collections import defaultdict
from fastapi import APIRouter, HTTPException, Query, Depends
from typing import List, Optional, Dict
from pydantic import BaseModel
from sqlmodel import Session, select, func, col

from backend.db.database import get_db
from backend.db.models import PriceSnapshot, Asset, AppSettings, ensure_utc

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
    asset_label: Optional[str] = None
    quote_asset_symbol: Optional[str] = None
    quote_asset_label: Optional[str] = None


class PaginatedPriceSnapshotsResponse(BaseModel):
    """Paginated response for price snapshots."""

    items: List[PriceSnapshotResponse]
    total: int
    limit: int
    offset: int


@router.get("", response_model=PaginatedPriceSnapshotsResponse)
def list_price_snapshots(
    asset_id: Optional[int] = Query(None, description="Filter by asset ID"),
    quote_asset_id: Optional[int] = Query(None, description="Filter by quote asset ID"),
    source: Optional[str] = Query(None, description="Filter by source"),
    snapshot_time_from: Optional[str] = Query(None, description="Filter by minimum snapshot time (ISO format)"),
    snapshot_time_to: Optional[str] = Query(None, description="Filter by maximum snapshot time (ISO format)"),
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of results"),
    offset: int = Query(0, ge=0, description="Number of results to skip"),
    session: Session = Depends(get_db),
):
    """
    List price snapshots with optional filtering.

    - **asset_id**: Filter by asset ID
    - **quote_asset_id**: Filter by quote asset ID
    - **source**: Filter by price source
    - **snapshot_time_from**: Filter by minimum snapshot time (ISO format)
    - **snapshot_time_to**: Filter by maximum snapshot time (ISO format)
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

        if snapshot_time_from:
            dt_from = parse_datetime(snapshot_time_from)
            statement = statement.where(PriceSnapshot.snapshot_time >= dt_from)

        if snapshot_time_to:
            dt_to = parse_datetime(snapshot_time_to)
            statement = statement.where(PriceSnapshot.snapshot_time <= dt_to)

        # Get total count before pagination
        from sqlmodel import func
        count_statement = select(func.count()).select_from(statement.subquery())
        total = session.exec(count_statement).one()

        statement = (
            statement.order_by(PriceSnapshot.snapshot_time.desc())
            .offset(offset)
            .limit(limit)
        )

        snapshots = session.exec(statement).all()

        results = []
        for s in snapshots:
            # Get asset symbols and labels
            asset_symbol = None
            asset_label = None
            quote_symbol = None
            quote_label = None

            asset = session.get(Asset, s.asset_id)
            if asset:
                asset_symbol = asset.symbol
                asset_label = asset.label

            if s.quote_asset_id:
                quote_asset = session.get(Asset, s.quote_asset_id)
                if quote_asset:
                    quote_symbol = quote_asset.symbol
                    quote_label = quote_asset.label

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
                    asset_label=asset_label,
                    quote_asset_symbol=quote_symbol,
                    quote_asset_label=quote_label,
                )
            )

        return PaginatedPriceSnapshotsResponse(
            items=results,
            total=total,
            limit=limit,
            offset=offset,
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


# ============================================================================
# Price Health & Timeseries Endpoints
# ============================================================================


class PriceHealthRow(BaseModel):
    """Health summary for a single asset's price data."""
    asset_id: int
    symbol: str
    label: Optional[str] = None
    last_price: float
    last_source: Optional[str] = None
    last_updated: str  # ISO datetime
    first_snapshot: str  # ISO datetime
    total_snapshots: int
    days_stale: int
    is_flatline: bool
    status: str  # "healthy", "warning", "stale"


class PriceHealthResponse(BaseModel):
    """Response model for price health endpoint."""
    items: List[PriceHealthRow]
    staleness_threshold_days: int
    summary: Dict[str, int]  # {"healthy": N, "warning": N, "stale": N}


class PriceTimeseriesPoint(BaseModel):
    date: str
    price: float


class PriceTimeseriesAsset(BaseModel):
    asset_id: int
    symbol: str
    label: Optional[str] = None
    points: List[PriceTimeseriesPoint]


class PriceTimeseriesResponse(BaseModel):
    assets: List[PriceTimeseriesAsset]


def _get_app_settings(session: Session) -> AppSettings:
    """Get or create app settings (reuse config pattern)."""
    settings = session.exec(select(AppSettings)).first()
    if not settings:
        settings = AppSettings()
        session.add(settings)
        session.commit()
        session.refresh(settings)
    return settings


@router.get("/health", response_model=PriceHealthResponse)
def get_price_health(
    session: Session = Depends(get_db),
):
    """
    Get price health summary for all assets with price data.
    
    Returns per-asset freshness status, flat-line detection, and staleness info.
    Uses the configured pnl_price_staleness_days threshold from app settings.
    """
    try:
        settings = _get_app_settings(session)
        staleness_days = settings.pnl_price_staleness_days
        warning_days = max(1, staleness_days // 2)  # Warning at half the stale threshold
        now = datetime.now(timezone.utc)

        # 1) Aggregate stats per asset
        agg_stmt = (
            select(
                PriceSnapshot.asset_id,
                func.max(PriceSnapshot.snapshot_time).label("last_updated"),
                func.min(PriceSnapshot.snapshot_time).label("first_snapshot"),
                func.count(PriceSnapshot.snapshot_id).label("total_snapshots"),
            )
            .group_by(PriceSnapshot.asset_id)
        )
        agg_rows = session.exec(agg_stmt).all()

        if not agg_rows:
            return PriceHealthResponse(
                items=[],
                staleness_threshold_days=staleness_days,
                summary={"healthy": 0, "warning": 0, "stale": 0},
            )

        # 2) Get latest price + source per asset using a subquery
        asset_ids = [r[0] for r in agg_rows]

        # Build a lookup: asset_id -> (last_price, last_source)
        latest_lookup: Dict[int, tuple] = {}
        for aid in asset_ids:
            latest_stmt = (
                select(PriceSnapshot.price, PriceSnapshot.source)
                .where(PriceSnapshot.asset_id == aid)
                .order_by(PriceSnapshot.snapshot_time.desc())
                .limit(1)
            )
            row = session.exec(latest_stmt).first()
            if row:
                latest_lookup[aid] = (float(row[0]), row[1])

        # 3) Flat-line detection: check if last 5 prices are identical per asset
        flatline_set: set = set()
        for aid in asset_ids:
            recent_stmt = (
                select(PriceSnapshot.price)
                .where(PriceSnapshot.asset_id == aid)
                .order_by(PriceSnapshot.snapshot_time.desc())
                .limit(5)
            )
            recent_prices = session.exec(recent_stmt).all()
            if len(recent_prices) >= 5:
                prices_float = [float(p[0]) if isinstance(p, tuple) else float(p) for p in recent_prices]
                if prices_float[0] > 0:
                    all_same = all(
                        abs(p - prices_float[0]) / prices_float[0] < 0.0001
                        for p in prices_float[1:]
                    )
                    if all_same:
                        flatline_set.add(aid)

        # 4) Build asset info lookup
        asset_lookup: Dict[int, Asset] = {}
        for aid in asset_ids:
            asset = session.get(Asset, aid)
            if asset:
                asset_lookup[aid] = asset

        # 5) Build response rows
        summary = {"healthy": 0, "warning": 0, "stale": 0}
        items: List[PriceHealthRow] = []

        for row in agg_rows:
            aid, last_updated, first_snapshot, total_snapshots = row
            asset = asset_lookup.get(aid)
            latest = latest_lookup.get(aid, (0.0, None))

            last_updated_dt = ensure_utc(last_updated) if last_updated else now
            days = (now - last_updated_dt).days

            if days >= staleness_days:
                status = "stale"
            elif days >= warning_days:
                status = "warning"
            else:
                status = "healthy"

            summary[status] += 1

            items.append(PriceHealthRow(
                asset_id=aid,
                symbol=asset.symbol if asset else f"ID:{aid}",
                label=asset.label if asset else None,
                last_price=latest[0],
                last_source=latest[1],
                last_updated=last_updated_dt.isoformat() if last_updated else "",
                first_snapshot=ensure_utc(first_snapshot).isoformat() if first_snapshot else "",
                total_snapshots=total_snapshots,
                days_stale=days,
                is_flatline=aid in flatline_set,
                status=status,
            ))

        # Sort by days_stale descending (worst offenders first)
        items.sort(key=lambda x: x.days_stale, reverse=True)

        return PriceHealthResponse(
            items=items,
            staleness_threshold_days=staleness_days,
            summary=summary,
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/timeseries", response_model=PriceTimeseriesResponse)
def get_price_timeseries(
    asset_ids: str = Query(..., description="Comma-separated asset IDs"),
    quote_asset_id: Optional[int] = Query(None, description="Filter by quote asset ID"),
    source: Optional[str] = Query(None, description="Filter by source"),
    date_from: Optional[str] = Query(None, description="Start date (ISO format)"),
    date_to: Optional[str] = Query(None, description="End date (ISO format)"),
    session: Session = Depends(get_db),
):
    """
    Get price timeseries for selected assets, grouped by asset.
    
    Designed for charting — returns all data points (no pagination).
    Limited to 10 assets at a time.
    """
    try:
        # Parse asset IDs
        try:
            ids = [int(x.strip()) for x in asset_ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid asset_ids format. Use comma-separated integers.")

        if not ids:
            raise HTTPException(status_code=400, detail="At least one asset_id is required.")
        if len(ids) > 50:
            raise HTTPException(status_code=400, detail="Maximum 50 assets per request.")

        # Build query
        statement = (
            select(
                PriceSnapshot.asset_id,
                PriceSnapshot.snapshot_time,
                PriceSnapshot.price,
            )
            .where(col(PriceSnapshot.asset_id).in_(ids))
            .order_by(PriceSnapshot.asset_id, PriceSnapshot.snapshot_time)
        )

        if quote_asset_id is not None:
            statement = statement.where(PriceSnapshot.quote_asset_id == quote_asset_id)
        if source:
            statement = statement.where(PriceSnapshot.source == source)
        if date_from:
            statement = statement.where(PriceSnapshot.snapshot_time >= parse_datetime(date_from))
        if date_to:
            statement = statement.where(PriceSnapshot.snapshot_time <= parse_datetime(date_to))

        rows = session.exec(statement).all()

        # Group by asset_id
        grouped: Dict[int, List[PriceTimeseriesPoint]] = defaultdict(list)
        for asset_id, snapshot_time, price in rows:
            dt = ensure_utc(snapshot_time)
            grouped[asset_id].append(PriceTimeseriesPoint(
                date=dt.strftime("%Y-%m-%d"),
                price=float(price),
            ))

        # Build response with asset info
        result_assets: List[PriceTimeseriesAsset] = []
        for aid in ids:
            if aid not in grouped:
                continue
            asset = session.get(Asset, aid)
            result_assets.append(PriceTimeseriesAsset(
                asset_id=aid,
                symbol=asset.symbol if asset else f"ID:{aid}",
                label=asset.label if asset else None,
                points=grouped[aid],
            ))

        return PriceTimeseriesResponse(assets=result_assets)

    except HTTPException:
        raise
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
