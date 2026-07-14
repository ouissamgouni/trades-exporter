"""Timeline endpoints for the TradeTrail API.

Provides aggregated transaction statistics for calendar heatmap visualization.
"""

from datetime import datetime, date
from fastapi import APIRouter, Query, Depends
from typing import List
from pydantic import BaseModel, Field
from sqlmodel import Session, select
from sqlalchemy import func, extract, case

from backend.db.database import get_db
from backend.db.models import NormalizedTransaction

router = APIRouter(prefix="/timeline", tags=["Timeline"])


# ============================================================================
# Response Models
# ============================================================================


class DailyStats(BaseModel):
    """Daily transaction statistics for calendar heatmap."""

    date: str = Field(..., description="Date in YYYY-MM-DD format")
    count: int = Field(..., description="Number of transactions on this day")
    volume: float = Field(..., description="Total transaction volume (sum of totals)")
    inflow_count: int = Field(0, description="Number of inflow transactions")
    outflow_count: int = Field(0, description="Number of outflow transactions")


class TimelineStatsResponse(BaseModel):
    """Response containing daily stats for a year."""

    year: int
    daily_stats: List[DailyStats]
    total_transactions: int
    excluded_invalid_count: int = Field(
        0, description="Number of invalid transactions excluded from stats"
    )
    min_year: int = Field(..., description="Earliest year with transactions")
    max_year: int = Field(..., description="Latest year with transactions")


# ============================================================================
# Endpoints
# ============================================================================


@router.get("/daily-stats", response_model=TimelineStatsResponse)
def get_daily_stats(
    year: int = Query(..., description="Year to get statistics for"),
    session: Session = Depends(get_db),
):
    """
    Get daily transaction statistics for a given year.

    Returns aggregated counts and volumes per day for calendar heatmap visualization.
    Also returns min/max years to enable year navigation.
    """
    # Get date range for the year
    year_start = datetime(year, 1, 1)
    year_end = datetime(year, 12, 31, 23, 59, 59)

    # Count invalid transactions for this year (to show as excluded)
    invalid_count_query = (
        select(func.count(NormalizedTransaction.id))
        .where(NormalizedTransaction.date_time >= year_start)
        .where(NormalizedTransaction.date_time <= year_end)
        .where(NormalizedTransaction.review_status == "invalid")
    )
    excluded_invalid_count = session.exec(invalid_count_query).one() or 0

    # Query for daily aggregates (excluding invalid transactions)
    # Group by date, counting transactions and summing volumes
    # Use func.date() for PostgreSQL date extraction
    daily_query = (
        select(
            func.date(NormalizedTransaction.date_time).label("tx_date"),
            func.count(NormalizedTransaction.id).label("count"),
            func.coalesce(
                func.sum(
                    NormalizedTransaction.quantity
                    * func.coalesce(NormalizedTransaction.price, 0)
                ),
                0,
            ).label("volume"),
            func.sum(
                case((NormalizedTransaction.direction == "inflow", 1), else_=0)
            ).label("inflow_count"),
            func.sum(
                case((NormalizedTransaction.direction == "outflow", 1), else_=0)
            ).label("outflow_count"),
        )
        .where(NormalizedTransaction.date_time >= year_start)
        .where(NormalizedTransaction.date_time <= year_end)
        .where(NormalizedTransaction.date_time.isnot(None))
        .where(NormalizedTransaction.review_status.in_(["valid", "pending"]))
        .group_by(func.date(NormalizedTransaction.date_time))
        .order_by(func.date(NormalizedTransaction.date_time))
    )

    results = session.exec(daily_query).all()

    # Build daily stats list
    daily_stats = []
    total_transactions = 0

    for row in results:
        tx_date, count, volume, inflow_count, outflow_count = row
        total_transactions += count
        daily_stats.append(
            DailyStats(
                date=tx_date.isoformat() if isinstance(tx_date, date) else str(tx_date),
                count=count,
                volume=float(volume) if volume else 0.0,
                inflow_count=inflow_count or 0,
                outflow_count=outflow_count or 0,
            )
        )

    # Get min and max years for navigation
    min_max_query = select(
        func.min(extract("year", NormalizedTransaction.date_time)).label("min_year"),
        func.max(extract("year", NormalizedTransaction.date_time)).label("max_year"),
    )
    min_max_result = session.exec(min_max_query).first()

    min_year = int(min_max_result[0]) if min_max_result and min_max_result[0] else year
    max_year = int(min_max_result[1]) if min_max_result and min_max_result[1] else year

    return TimelineStatsResponse(
        year=year,
        daily_stats=daily_stats,
        total_transactions=total_transactions,
        excluded_invalid_count=excluded_invalid_count,
        min_year=min_year,
        max_year=max_year,
    )


@router.get("/years", response_model=List[int])
def get_available_years(
    session: Session = Depends(get_db),
):
    """
    Get list of years that have transactions.

    Used for year navigation dropdown/arrows.
    """
    years_query = (
        select(extract("year", NormalizedTransaction.date_time).label("year"))
        .distinct()
        .order_by(extract("year", NormalizedTransaction.date_time).desc())
    )

    results = session.exec(years_query).all()

    return [int(y) for y in results if y is not None]
