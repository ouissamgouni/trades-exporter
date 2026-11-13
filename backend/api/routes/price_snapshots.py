"""
Price Snapshots endpoints for the TradeTrail API.
"""

from datetime import datetime, date, timezone
from decimal import Decimal
from collections import defaultdict
from dataclasses import asdict
from fastapi import APIRouter, HTTPException, Query, Depends
from typing import Any, List, Optional, Dict
from pydantic import BaseModel
from sqlmodel import Session, select, func, col, text

from backend.db.database import get_db
from backend.db.models import (
    PriceSnapshot,
    Asset,
    AppSettings,
    NormalizedTransaction,
    ensure_utc,
)
from backend.services.price_service import (
    detect_gaps,
    _expected_trading_days,
    _is_business_day,
    GapDetectionResult,
    GapRange as GapRangeData,
)
from backend.services.price_gap_job_service import gap_fix_jobs

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


# ============================================================================
# Gap Detection Models
# ============================================================================


class GapRangeResponse(BaseModel):
    start_date: str
    end_date: str
    missing_days_count: int
    last_known_price: Optional[float] = None
    last_known_price_date: Optional[str] = None
    last_known_source: Optional[str] = None


class GapDetectionResponse(BaseModel):
    asset_id: int
    symbol: str
    price_type: Optional[str] = None
    total_expected: int
    total_covered: int
    coverage_pct: float
    gaps: List[GapRangeResponse]


class GapSummaryItem(BaseModel):
    asset_id: int
    symbol: str
    label: Optional[str] = None
    gap_count: int
    total_missing_days: int


class GapSummaryResponse(BaseModel):
    items: List[GapSummaryItem]


class GapCandidatesResponse(BaseModel):
    items: List[GapDetectionResponse]


class BackfillRequest(BaseModel):
    asset_id: int
    date_from: str  # ISO date
    date_to: str  # ISO date
    quote_asset_id: Optional[int] = None


class BackfillFetchedItem(BaseModel):
    date: str
    price: float
    source: str


class BackfillFailedItem(BaseModel):
    date: str
    error: str


class BackfillResponse(BaseModel):
    asset_id: int
    fetched: List[BackfillFetchedItem]
    failed: List[BackfillFailedItem]


class GapFixJobItem(BaseModel):
    asset_id: int
    date_from: Optional[str] = None  # ISO date; None = from the first transaction
    date_to: Optional[str] = None  # ISO date; None = today / position close


class GapFixJobStartRequest(BaseModel):
    # None = all transaction-backed assets (unless `items` is given)
    asset_ids: Optional[List[int]] = None
    quote_asset_id: Optional[int] = None
    # Per-asset date ranges (e.g. one gap); combined with asset_ids
    items: Optional[List[GapFixJobItem]] = None


class BulkManualRequest(BaseModel):
    asset_id: int
    quote_asset_id: Optional[int] = None
    date_from: str  # ISO date
    date_to: str  # ISO date
    price: float = 0.0
    source: str = "manual"
    force: bool = False  # When True, overwrite existing snapshots
    interpolate: bool = (
        False  # When True, linearly interpolate between price_start and price_end
    )
    price_start: Optional[float] = None
    price_end: Optional[float] = None


class BulkManualResponse(BaseModel):
    asset_id: int
    created_count: int
    skipped_count: int  # already existing
    overwritten_count: int = 0


@router.get("", response_model=PaginatedPriceSnapshotsResponse)
def list_price_snapshots(
    asset_id: Optional[int] = Query(None, description="Filter by asset ID"),
    quote_asset_id: Optional[int] = Query(None, description="Filter by quote asset ID"),
    source: Optional[str] = Query(None, description="Filter by source"),
    snapshot_time_from: Optional[str] = Query(
        None, description="Filter by minimum snapshot time (ISO format)"
    ),
    snapshot_time_to: Optional[str] = Query(
        None, description="Filter by maximum snapshot time (ISO format)"
    ),
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
# Gap Detection, Backfill & Bulk-Manual Endpoints
# ============================================================================


@router.get("/gaps", response_model=GapDetectionResponse)
def get_price_gaps(
    asset_id: int = Query(..., description="Asset ID"),
    date_from: Optional[str] = Query(None, description="Start date (YYYY-MM-DD)"),
    date_to: Optional[str] = Query(None, description="End date (YYYY-MM-DD)"),
    quote_asset_id: Optional[int] = Query(None, description="Filter by quote asset ID"),
    session: Session = Depends(get_db),
):
    """Detect price gaps for a single asset."""
    try:
        d_from = date.fromisoformat(date_from) if date_from else None
        d_to = date.fromisoformat(date_to) if date_to else None
    except ValueError:
        raise HTTPException(
            status_code=400, detail="Invalid date format. Use YYYY-MM-DD."
        )

    # Resolve base currency if no explicit quote_asset_id
    if quote_asset_id is None:
        settings = _get_app_settings(session)
        base_asset = session.exec(
            select(Asset).where(Asset.symbol == settings.base_currency)
        ).first()
        if base_asset:
            quote_asset_id = base_asset.asset_id

    try:
        result = detect_gaps(
            session, asset_id, d_from, d_to, quote_asset_id=quote_asset_id
        )
        return GapDetectionResponse(
            asset_id=result.asset_id,
            symbol=result.symbol,
            price_type=result.price_type,
            total_expected=result.total_expected,
            total_covered=result.total_covered,
            coverage_pct=result.coverage_pct,
            gaps=[
                GapRangeResponse(
                    start_date=g.start_date,
                    end_date=g.end_date,
                    missing_days_count=g.missing_days_count,
                    last_known_price=g.last_known_price,
                    last_known_price_date=g.last_known_price_date,
                    last_known_source=g.last_known_source,
                )
                for g in result.gaps
            ],
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gap detection error: {str(e)}")


def _transaction_asset_ids(session: Session) -> List[int]:
    rows = session.exec(
        select(NormalizedTransaction.asset_id)
        .where(NormalizedTransaction.asset_id.isnot(None))
        .distinct()
    ).all()
    ids = {row[0] if isinstance(row, tuple) else row for row in rows}
    return sorted(aid for aid in ids if aid is not None)


def _price_fetchable_asset_ids(session: Session, ids: List[int]) -> List[int]:
    """Drop assets whose prices can't be fetched (e.g. Polymarket without a getter): their gaps are unfixable."""
    from backend.api.routes.pnl import (
        _classify_asset_price_policy,
        _get_enabled_price_getters_by_asset,
    )

    if not ids:
        return []
    assets = session.exec(select(Asset).where(Asset.asset_id.in_(ids))).all()
    getters = _get_enabled_price_getters_by_asset(session, ids)
    fetchable = {
        a.asset_id
        for a in assets
        if _classify_asset_price_policy(a, getters.get(a.asset_id))["price_fetch_eligible"]
    }
    return [aid for aid in ids if aid in fetchable]


@router.get("/gaps/summary", response_model=GapSummaryResponse)
def get_price_gaps_summary(
    asset_ids: Optional[str] = Query(
        None,
        description="Comma-separated asset IDs (omit for all transaction-backed assets)",
    ),
    quote_asset_id: Optional[int] = Query(None, description="Filter by quote asset ID"),
    session: Session = Depends(get_db),
):
    """Get gap counts for multiple assets (lightweight, for dashboards)."""
    if asset_ids is None:
        ids = _transaction_asset_ids(session)
    else:
        try:
            ids = [int(x.strip()) for x in asset_ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid asset_ids format.")

    ids = _price_fetchable_asset_ids(session, ids)
    if not ids:
        return GapSummaryResponse(items=[])

    # Resolve base currency if no explicit quote_asset_id
    if quote_asset_id is None:
        settings = _get_app_settings(session)
        base_asset = session.exec(
            select(Asset).where(Asset.symbol == settings.base_currency)
        ).first()
        if base_asset:
            quote_asset_id = base_asset.asset_id

    items: List[GapSummaryItem] = []
    for aid in ids:
        try:
            result = detect_gaps(session, aid, quote_asset_id=quote_asset_id)
            total_missing = sum(g.missing_days_count for g in result.gaps)
            if result.gaps:
                asset = session.get(Asset, aid)
                items.append(
                    GapSummaryItem(
                        asset_id=aid,
                        symbol=result.symbol,
                        label=asset.label if asset else None,
                        gap_count=len(result.gaps),
                        total_missing_days=total_missing,
                    )
                )
        except ValueError:
            continue  # skip unknown asset IDs

    return GapSummaryResponse(items=items)


@router.get("/gaps/candidates", response_model=GapCandidatesResponse)
def get_price_gap_candidates(
    quote_asset_id: Optional[int] = Query(None, description="Filter by quote asset ID"),
    session: Session = Depends(get_db),
):
    """Get transaction-backed assets with at least one price gap."""
    if quote_asset_id is None:
        settings = _get_app_settings(session)
        base_asset = session.exec(
            select(Asset).where(Asset.symbol == settings.base_currency)
        ).first()
        if base_asset:
            quote_asset_id = base_asset.asset_id

    rows = session.exec(
        select(NormalizedTransaction.asset_id)
        .where(NormalizedTransaction.asset_id.isnot(None))
        .distinct()
    ).all()
    asset_ids = set()
    for row in rows:
        aid = row[0] if isinstance(row, tuple) else row
        if aid is not None:
            asset_ids.add(aid)

    items: List[GapDetectionResponse] = []
    for aid in sorted(asset_ids):
        try:
            result = detect_gaps(session, aid, quote_asset_id=quote_asset_id)
        except ValueError:
            continue
        if not result.gaps:
            continue
        items.append(
            GapDetectionResponse(
                asset_id=result.asset_id,
                symbol=result.symbol,
                price_type=result.price_type,
                total_expected=result.total_expected,
                total_covered=result.total_covered,
                coverage_pct=result.coverage_pct,
                gaps=[
                    GapRangeResponse(
                        start_date=g.start_date,
                        end_date=g.end_date,
                        missing_days_count=g.missing_days_count,
                        last_known_price=g.last_known_price,
                        last_known_price_date=g.last_known_price_date,
                        last_known_source=g.last_known_source,
                    )
                    for g in result.gaps
                ],
            )
        )

    return GapCandidatesResponse(items=items)


@router.post("/backfill")
def backfill_prices(
    req: BackfillRequest,
    session: Session = Depends(get_db),
) -> Dict[str, Any]:
    """
    Fetch missing prices for an asset in a date range through the gap-fix job
    (one path: same logs, progress and quota handling as "fix all gaps").
    Starts the job or adds the range to the running one; returns the job state.
    """
    d_from, d_to = _parse_range(req.date_from, req.date_to)
    if not session.get(Asset, req.asset_id):
        raise HTTPException(
            status_code=404, detail=f"Asset ID {req.asset_id} not found"
        )
    return gap_fix_jobs.enqueue(
        [], _resolve_quote_id(session, req.quote_asset_id), [(req.asset_id, d_from, d_to)]
    )


def _parse_range(date_from: Optional[str], date_to: Optional[str]):
    try:
        return (
            date.fromisoformat(date_from) if date_from else None,
            date.fromisoformat(date_to) if date_to else None,
        )
    except ValueError:
        raise HTTPException(
            status_code=400, detail="Invalid date format. Use YYYY-MM-DD."
        )


def _resolve_quote_id(session: Session, quote_asset_id: Optional[int]) -> Optional[int]:
    if quote_asset_id is not None:
        return quote_asset_id
    base_asset = session.exec(
        select(Asset).where(Asset.symbol == _get_app_settings(session).base_currency)
    ).first()
    return base_asset.asset_id if base_asset else None


# ---------------------------------------------------------------------------
# Gap-fix background job
# ---------------------------------------------------------------------------


@router.post("/gaps/jobs")
def start_gap_fix_job(
    req: GapFixJobStartRequest,
    session: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Start the gap-fix job, or add the request to the running one."""
    quote_id = _resolve_quote_id(session, req.quote_asset_id)
    ranges = []
    for it in req.items or []:
        d_from, d_to = _parse_range(it.date_from, it.date_to)
        ranges.append((it.asset_id, d_from, d_to))
    if ranges:
        fetchable = set(_price_fetchable_asset_ids(session, sorted({r[0] for r in ranges})))
        ranges = [r for r in ranges if r[0] in fetchable]
    if req.asset_ids is None and req.items:
        asset_ids: List[int] = []
    else:
        asset_ids = _price_fetchable_asset_ids(
            session,
            req.asset_ids if req.asset_ids is not None else _transaction_asset_ids(session),
        )
    return gap_fix_jobs.enqueue(asset_ids, quote_id, ranges)


@router.get("/gaps/jobs/current")
def get_gap_fix_job() -> Dict[str, Any]:
    return gap_fix_jobs.get_status()


@router.post("/gaps/jobs/current/cancel")
def cancel_gap_fix_job() -> Dict[str, Any]:
    return gap_fix_jobs.cancel()


@router.post("/gaps/jobs/current/skip/{asset_id}")
def skip_gap_fix_asset(asset_id: int) -> Dict[str, Any]:
    return gap_fix_jobs.skip_asset(asset_id)


# ---------------------------------------------------------------------------
# Test-fetch: try fetching a single date price without persisting
# ---------------------------------------------------------------------------


class TestFetchResponse(BaseModel):
    asset_id: int
    date: str
    price: float
    source: str
    quote_currency: str


@router.get("/test-fetch", response_model=TestFetchResponse)
def test_fetch_price(
    asset_id: int = Query(...),
    date_str: str = Query(..., alias="date", description="YYYY-MM-DD"),
    session: Session = Depends(get_db),
):
    """
    Test-fetch a price for a single date via configured price getters.
    Does NOT persist the result — dry-run only.
    """
    try:
        d = date.fromisoformat(date_str)
    except ValueError:
        raise HTTPException(
            status_code=400, detail="Invalid date format. Use YYYY-MM-DD."
        )

    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail=f"Asset ID {asset_id} not found")

    from backend.services.price_service import PriceService
    from backend.config.loader import load_settings as _load

    settings = _load()
    svc = PriceService(
        session=session, base_currency=settings.get("base_currency", "EUR")
    )

    dt = datetime.combine(d, datetime.min.time(), tzinfo=timezone.utc)
    try:
        result = svc.get_price_with_fallback(
            asset_id=asset_id,
            dt=dt,
            use_fallback=False,
            max_timeout_seconds=15,
        )
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Fetch failed: {str(e)[:300]}")

    # Roll back so nothing is persisted
    session.rollback()

    return TestFetchResponse(
        asset_id=asset_id,
        date=d.isoformat(),
        price=result.price,
        source=result.source or "unknown",
        quote_currency=getattr(result, "quote_currency", ""),
    )


# ---------------------------------------------------------------------------
# Check existing prices in a date range (for override confirmation)
# ---------------------------------------------------------------------------


class ExistingPriceItem(BaseModel):
    date: str
    price: float
    source: Optional[str] = None


class CheckExistingResponse(BaseModel):
    asset_id: int
    count: int
    items: List[ExistingPriceItem]


@router.get("/check-existing")
def check_existing_prices(
    asset_id: int = Query(...),
    date_from: str = Query(...),
    date_to: str = Query(...),
    quote_asset_id: Optional[int] = Query(None),
    session: Session = Depends(get_db),
) -> CheckExistingResponse:
    """Return existing price snapshots in a date range for override confirmation."""
    try:
        d_from = date.fromisoformat(date_from)
        d_to = date.fromisoformat(date_to)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format.")

    stmt = (
        select(
            func.date(PriceSnapshot.snapshot_time).label("snap_date"),
            PriceSnapshot.price,
            PriceSnapshot.source,
        )
        .where(
            PriceSnapshot.asset_id == asset_id,
            PriceSnapshot.snapshot_time
            >= datetime.combine(d_from, datetime.min.time()),
            PriceSnapshot.snapshot_time <= datetime.combine(d_to, datetime.max.time()),
        )
        .order_by(PriceSnapshot.snapshot_time)
    )
    if quote_asset_id is not None:
        stmt = stmt.where(PriceSnapshot.quote_asset_id == quote_asset_id)

    items: List[ExistingPriceItem] = []
    seen_dates: set = set()
    for row in session.exec(stmt).all():
        d_val = row[0]
        if hasattr(d_val, "isoformat"):
            d_str = d_val.isoformat()
        else:
            d_str = str(d_val)
        if d_str in seen_dates:
            continue
        seen_dates.add(d_str)
        items.append(
            ExistingPriceItem(
                date=d_str,
                price=float(row[1]),
                source=row[2],
            )
        )

    return CheckExistingResponse(asset_id=asset_id, count=len(items), items=items)


@router.post("/bulk-manual", response_model=BulkManualResponse)
def bulk_create_manual_prices(
    req: BulkManualRequest,
    session: Session = Depends(get_db),
):
    """
    Create manual price snapshots for every expected trading day in a date range.

    - Default: skips dates that already have a snapshot for this asset+quote.
    - force=True: overwrites existing snapshots for matching dates.
    - interpolate=True: linearly interpolates between price_start and price_end.
    """
    try:
        d_from = date.fromisoformat(req.date_from)
        d_to = date.fromisoformat(req.date_to)
    except ValueError:
        raise HTTPException(
            status_code=400, detail="Invalid date format. Use YYYY-MM-DD."
        )

    # Validate pricing fields
    if req.interpolate:
        if req.price_start is None or req.price_end is None:
            raise HTTPException(
                status_code=400,
                detail="price_start and price_end required for interpolation.",
            )
        if req.price_start <= 0 or req.price_end <= 0:
            raise HTTPException(status_code=400, detail="Prices must be positive.")
    else:
        if req.price <= 0:
            raise HTTPException(status_code=400, detail="Price must be positive.")

    asset = session.get(Asset, req.asset_id)
    if not asset:
        raise HTTPException(
            status_code=404, detail=f"Asset ID {req.asset_id} not found"
        )

    is_crypto = (asset.price_type or "crypto").lower() == "crypto"
    expected = _expected_trading_days(d_from, d_to, is_crypto)

    if not expected:
        return BulkManualResponse(
            asset_id=req.asset_id, created_count=0, skipped_count=0, overwritten_count=0
        )

    # Find existing dates
    existing_stmt = select(func.date(PriceSnapshot.snapshot_time)).where(
        PriceSnapshot.asset_id == req.asset_id,
        PriceSnapshot.snapshot_time >= datetime.combine(d_from, datetime.min.time()),
        PriceSnapshot.snapshot_time <= datetime.combine(d_to, datetime.max.time()),
    )
    if req.quote_asset_id is not None:
        existing_stmt = existing_stmt.where(
            PriceSnapshot.quote_asset_id == req.quote_asset_id
        )
    existing_dates: set[date] = set()
    for row in session.exec(existing_stmt).all():
        d = row[0] if isinstance(row, tuple) else row
        if hasattr(d, "date"):
            d = d.date()
        existing_dates.add(d)

    # If force, delete existing snapshots for these dates
    overwritten = 0
    if req.force and existing_dates:
        dates_to_delete = existing_dates & set(expected)
        if dates_to_delete:
            for dd in dates_to_delete:
                del_stmt = select(PriceSnapshot).where(
                    PriceSnapshot.asset_id == req.asset_id,
                    PriceSnapshot.snapshot_time
                    >= datetime.combine(dd, datetime.min.time()),
                    PriceSnapshot.snapshot_time
                    <= datetime.combine(dd, datetime.max.time()),
                )
                if req.quote_asset_id is not None:
                    del_stmt = del_stmt.where(
                        PriceSnapshot.quote_asset_id == req.quote_asset_id
                    )
                for snap in session.exec(del_stmt).all():
                    session.delete(snap)
                    overwritten += 1
            session.flush()
            existing_dates -= dates_to_delete

    created = 0
    skipped = 0
    n = len(expected)
    for i, d in enumerate(expected):
        if d in existing_dates:
            skipped += 1
            continue

        if req.interpolate:
            # Linear interpolation between price_start and price_end
            t = i / max(n - 1, 1)
            day_price = req.price_start + t * (req.price_end - req.price_start)
        else:
            day_price = req.price

        snapshot = PriceSnapshot(
            asset_id=req.asset_id,
            quote_asset_id=req.quote_asset_id,
            snapshot_time=datetime.combine(d, datetime.min.time(), tzinfo=timezone.utc),
            price=Decimal(str(round(day_price, 18))),
            source=req.source or "manual",
        )
        session.add(snapshot)
        created += 1

    if created or overwritten:
        session.commit()

    return BulkManualResponse(
        asset_id=req.asset_id,
        created_count=created,
        skipped_count=skipped,
        overwritten_count=overwritten,
    )


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
    status: str  # "healthy", "warning", "stale", "no_transactions"
    has_transactions: bool = True
    sparkline: List[float] = []
    quote_currencies: List[Dict[str, Any]] = []  # [{asset_id, symbol}]


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
    # Earliest transaction of the asset (YYYY-MM-DD); charts start there
    first_transaction_date: Optional[str] = None


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
        warning_days = max(
            1, staleness_days // 2
        )  # Warning at half the stale threshold
        now = datetime.now(timezone.utc)

        # Resolve base currency → quote_asset_id for filtering
        base_asset = session.exec(
            select(Asset).where(Asset.symbol == settings.base_currency)
        ).first()
        quote_id = base_asset.asset_id if base_asset else None

        # 1) Aggregate stats per asset (filtered by quote currency)
        agg_stmt = select(
            PriceSnapshot.asset_id,
            func.max(PriceSnapshot.snapshot_time).label("last_updated"),
            func.min(PriceSnapshot.snapshot_time).label("first_snapshot"),
            func.count(PriceSnapshot.snapshot_id).label("total_snapshots"),
        ).group_by(PriceSnapshot.asset_id)
        if quote_id is not None:
            agg_stmt = agg_stmt.where(PriceSnapshot.quote_asset_id == quote_id)
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
            if quote_id is not None:
                latest_stmt = latest_stmt.where(
                    PriceSnapshot.quote_asset_id == quote_id
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
            if quote_id is not None:
                recent_stmt = recent_stmt.where(
                    PriceSnapshot.quote_asset_id == quote_id
                )
            recent_prices = session.exec(recent_stmt).all()
            if len(recent_prices) >= 5:
                prices_float = [
                    float(p[0]) if isinstance(p, tuple) else float(p)
                    for p in recent_prices
                ]
                if prices_float[0] > 0:
                    all_same = all(
                        abs(p - prices_float[0]) / prices_float[0] < 0.0001
                        for p in prices_float[1:]
                    )
                    if all_same:
                        flatline_set.add(aid)

        # 3b) Sparkline: one price per distinct calendar day, last 365 days
        sparkline_lookup: Dict[int, List[float]] = {}
        for aid in asset_ids:
            spark_stmt = (
                select(
                    func.date(PriceSnapshot.snapshot_time).label("day"),
                    func.max(PriceSnapshot.price).label("price"),
                )
                .where(PriceSnapshot.asset_id == aid)
                .group_by(func.date(PriceSnapshot.snapshot_time))
                .order_by(text("day DESC"))
                .limit(365)
            )
            if quote_id is not None:
                spark_stmt = spark_stmt.where(PriceSnapshot.quote_asset_id == quote_id)
            rows = session.exec(spark_stmt).all()
            if rows:
                sparkline_lookup[aid] = [float(r[1]) for r in reversed(rows)]

        # 3c) Quote currencies per asset: distinct quote_asset_ids with symbols
        quote_currencies_lookup: Dict[int, List[Dict[str, Any]]] = {}
        for aid in asset_ids:
            qc_stmt = (
                select(PriceSnapshot.quote_asset_id)
                .where(PriceSnapshot.asset_id == aid)
                .where(PriceSnapshot.quote_asset_id.isnot(None))
                .distinct()
            )
            qc_rows = session.exec(qc_stmt).all()
            quotes = []
            for qr in qc_rows:
                qid = qr[0] if isinstance(qr, tuple) else qr
                if qid is not None:
                    q_asset = session.get(Asset, qid)
                    quotes.append(
                        {
                            "asset_id": qid,
                            "symbol": q_asset.symbol if q_asset else f"ID:{qid}",
                        }
                    )
            quote_currencies_lookup[aid] = quotes

        # 4) Build asset info lookup
        asset_lookup: Dict[int, Asset] = {}
        for aid in asset_ids:
            asset = session.get(Asset, aid)
            if asset:
                asset_lookup[aid] = asset

        # 4b) Determine which assets have at least one transaction
        tx_asset_ids: set = set()
        tx_stmt = (
            select(NormalizedTransaction.asset_id)
            .where(NormalizedTransaction.asset_id.in_(asset_ids))
            .distinct()
        )
        for row in session.exec(tx_stmt).all():
            aid_val = row[0] if isinstance(row, tuple) else row
            tx_asset_ids.add(aid_val)

        # 5) Build response rows
        summary = {"healthy": 0, "warning": 0, "stale": 0}
        items: List[PriceHealthRow] = []

        for row in agg_rows:
            aid, last_updated, first_snapshot, total_snapshots = row
            asset = asset_lookup.get(aid)
            latest = latest_lookup.get(aid, (0.0, None))
            has_tx = aid in tx_asset_ids

            last_updated_dt = ensure_utc(last_updated) if last_updated else now
            days = (now - last_updated_dt).days

            if not has_tx:
                status = "no_transactions"
            elif days >= staleness_days:
                status = "stale"
            elif days >= warning_days:
                status = "warning"
            else:
                status = "healthy"

            if status in summary:
                summary[status] += 1

            items.append(
                PriceHealthRow(
                    asset_id=aid,
                    symbol=asset.symbol if asset else f"ID:{aid}",
                    label=asset.label if asset else None,
                    last_price=latest[0],
                    last_source=latest[1],
                    last_updated=last_updated_dt.isoformat() if last_updated else "",
                    first_snapshot=ensure_utc(first_snapshot).isoformat()
                    if first_snapshot
                    else "",
                    total_snapshots=total_snapshots,
                    days_stale=days,
                    is_flatline=aid in flatline_set,
                    status=status,
                    has_transactions=has_tx,
                    sparkline=sparkline_lookup.get(aid, []),
                    quote_currencies=quote_currencies_lookup.get(aid, []),
                )
            )

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
            raise HTTPException(
                status_code=400,
                detail="Invalid asset_ids format. Use comma-separated integers.",
            )

        if not ids:
            raise HTTPException(
                status_code=400, detail="At least one asset_id is required."
            )
        if len(ids) > 50:
            raise HTTPException(
                status_code=400, detail="Maximum 50 assets per request."
            )

        # Build base filters
        base_filters = [col(PriceSnapshot.asset_id).in_(ids)]
        if quote_asset_id is not None:
            base_filters.append(PriceSnapshot.quote_asset_id == quote_asset_id)
        if source:
            base_filters.append(PriceSnapshot.source == source)
        if date_from:
            base_filters.append(
                PriceSnapshot.snapshot_time >= parse_datetime(date_from)
            )
        if date_to:
            base_filters.append(PriceSnapshot.snapshot_time <= parse_datetime(date_to))

        # Deduplicate: one price per (asset_id, date) using latest snapshot_time
        date_col = func.date(PriceSnapshot.snapshot_time).label("snap_date")
        max_time_sub = (
            select(
                PriceSnapshot.asset_id,
                date_col,
                func.max(PriceSnapshot.snapshot_time).label("max_time"),
            )
            .where(*base_filters)
            .group_by(PriceSnapshot.asset_id, func.date(PriceSnapshot.snapshot_time))
            .subquery()
        )

        statement = (
            select(
                PriceSnapshot.asset_id,
                PriceSnapshot.snapshot_time,
                PriceSnapshot.price,
            )
            .join(
                max_time_sub,
                (PriceSnapshot.asset_id == max_time_sub.c.asset_id)
                & (PriceSnapshot.snapshot_time == max_time_sub.c.max_time),
            )
            .where(*base_filters)
            .order_by(PriceSnapshot.asset_id, PriceSnapshot.snapshot_time)
        )

        rows = session.exec(statement).all()

        # Group by asset_id
        grouped: Dict[int, List[PriceTimeseriesPoint]] = defaultdict(list)
        for asset_id, snapshot_time, price in rows:
            dt = ensure_utc(snapshot_time)
            date_str = dt.strftime("%Y-%m-%d")
            # Safety: skip if we already have this date (e.g. ties on max_time)
            pts = grouped[asset_id]
            if pts and pts[-1].date == date_str:
                continue
            pts.append(
                PriceTimeseriesPoint(
                    date=date_str,
                    price=float(price),
                )
            )

        first_tx_rows = session.exec(
            select(
                NormalizedTransaction.asset_id,
                func.min(NormalizedTransaction.date_time),
            )
            .where(col(NormalizedTransaction.asset_id).in_(ids))
            .group_by(NormalizedTransaction.asset_id)
        ).all()
        first_tx = {aid: str(dt)[:10] for aid, dt in first_tx_rows if dt is not None}

        # Build response with asset info
        result_assets: List[PriceTimeseriesAsset] = []
        for aid in ids:
            if aid not in grouped:
                continue
            asset = session.get(Asset, aid)
            result_assets.append(
                PriceTimeseriesAsset(
                    asset_id=aid,
                    symbol=asset.symbol if asset else f"ID:{aid}",
                    label=asset.label if asset else None,
                    points=grouped[aid],
                    first_transaction_date=first_tx.get(aid),
                )
            )

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
