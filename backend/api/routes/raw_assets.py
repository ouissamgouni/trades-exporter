"""
Raw Assets endpoints for the Trade Exporter API.
Maps source-specific asset symbols to normalized assets.
"""

from fastapi import APIRouter, HTTPException, Query, Depends
from typing import List, Optional
from pydantic import BaseModel, Field
from sqlmodel import Session, select
from sqlalchemy import update

from backend.db.database import get_db
from backend.db.models import RawAsset, NormalizedTransaction

router = APIRouter(prefix="/raw-assets", tags=["Raw Assets"])


class RawAssetCreate(BaseModel):
    """Request model for creating a raw asset."""

    symbol: str
    source: str
    asset_id: Optional[int] = None


class RawAssetUpdate(BaseModel):
    """Request model for updating a raw asset."""

    asset_id: Optional[int] = None


class RawAssetResponse(BaseModel):
    """Response model for raw asset."""

    symbol: str
    source: str
    asset_id: Optional[int] = None


class BulkMapAssetItem(BaseModel):
    """Single item for bulk asset mapping."""
    symbol: str = Field(..., description="Raw asset symbol")
    source: str = Field(..., description="Source platform/exchange")
    asset_id: int = Field(..., description="Target asset_id to map to")


class BulkMapAssetRequest(BaseModel):
    """Request model for bulk asset mapping."""
    mappings: List[BulkMapAssetItem] = Field(..., description="List of mappings to apply")


class BulkMapResponse(BaseModel):
    """Response model for bulk mapping operations."""
    success_count: int = Field(..., description="Number of successful mappings")
    failed_count: int = Field(..., description="Number of failed mappings")
    errors: List[str] = Field(default_factory=list, description="Error messages for failed mappings")


@router.post("/bulk-map", response_model=BulkMapResponse)
def bulk_map_assets(
    request: BulkMapAssetRequest,
    session: Session = Depends(get_db),
):
    """
    Bulk map multiple raw assets to normalized assets.
    
    Each mapping updates the raw_asset record and propagates to all linked transactions.
    Used by "Apply All Suggestions" feature in Data Health Check.
    """
    success_count = 0
    failed_count = 0
    errors = []
    
    try:
        for item in request.mappings:
            try:
                # Find the raw asset
                statement = select(RawAsset).where(
                    RawAsset.symbol == item.symbol,
                    RawAsset.source == item.source,
                )
                raw_asset = session.exec(statement).first()
                
                if not raw_asset:
                    # Create if doesn't exist
                    raw_asset = RawAsset(
                        symbol=item.symbol,
                        source=item.source,
                        asset_id=item.asset_id,
                    )
                    session.add(raw_asset)
                else:
                    raw_asset.asset_id = item.asset_id
                
                # Propagate to transactions
                # Update asset_id for transactions matching source_asset_symbol
                stmt_asset = (
                    update(NormalizedTransaction)
                    .where(
                        NormalizedTransaction.source == item.source,
                        NormalizedTransaction.source_asset_symbol == item.symbol,
                    )
                    .values(asset_id=item.asset_id)
                )
                session.exec(stmt_asset)
                
                # Update price_quote_asset_id for transactions matching source_price_quote_asset_symbol
                stmt_price = (
                    update(NormalizedTransaction)
                    .where(
                        NormalizedTransaction.source == item.source,
                        NormalizedTransaction.source_price_quote_asset_symbol == item.symbol,
                    )
                    .values(price_quote_asset_id=item.asset_id)
                )
                session.exec(stmt_price)
                
                # Update fee_quote_asset_id for transactions matching source_fee_quote_asset_symbol
                stmt_fee = (
                    update(NormalizedTransaction)
                    .where(
                        NormalizedTransaction.source == item.source,
                        NormalizedTransaction.source_fee_quote_asset_symbol == item.symbol,
                    )
                    .values(fee_quote_asset_id=item.asset_id)
                )
                session.exec(stmt_fee)
                
                # Update attributed_asset_id for transactions matching source_attributed_asset_symbol
                stmt_attr = (
                    update(NormalizedTransaction)
                    .where(
                        NormalizedTransaction.source == item.source,
                        NormalizedTransaction.source_attributed_asset_symbol == item.symbol,
                    )
                    .values(attributed_asset_id=item.asset_id)
                )
                session.exec(stmt_attr)
                
                success_count += 1
                
            except Exception as e:
                failed_count += 1
                errors.append(f"{item.symbol}@{item.source}: {str(e)}")
        
        session.commit()
        
        return BulkMapResponse(
            success_count=success_count,
            failed_count=failed_count,
            errors=errors
        )
        
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=f"Bulk mapping failed: {str(e)}")


@router.get("", response_model=List[RawAssetResponse])
def list_raw_assets(
    source: Optional[str] = Query(None, description="Filter by source"),
    has_asset_id: Optional[bool] = Query(
        None, description="Filter by whether asset_id is set"
    ),
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of results"),
    offset: int = Query(0, ge=0, description="Number of results to skip"),
    session: Session = Depends(get_db),
):
    """
    List raw assets with optional filtering.

    - **source**: Filter by source exchange/platform
    - **has_asset_id**: Filter by whether asset_id is linked
    - **limit**: Maximum number of results to return
    - **offset**: Number of results to skip for pagination
    """
    try:
        statement = select(RawAsset)

        if source:
            statement = statement.where(RawAsset.source == source)

        if has_asset_id is True:
            statement = statement.where(RawAsset.asset_id != None)
        elif has_asset_id is False:
            statement = statement.where(RawAsset.asset_id == None)

        statement = (
            statement.order_by(RawAsset.source, RawAsset.symbol)
            .offset(offset)
            .limit(limit)
        )

        raw_assets = session.exec(statement).all()

        return [
            RawAssetResponse(
                symbol=ra.symbol,
                source=ra.source,
                asset_id=ra.asset_id,
            )
            for ra in raw_assets
        ]

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/{source}/{symbol}", response_model=RawAssetResponse)
def get_raw_asset(
    source: str,
    symbol: str,
    session: Session = Depends(get_db),
):
    """
    Get a specific raw asset by composite key.

    - **source**: Source exchange/platform name
    - **symbol**: Asset symbol from the source
    """
    try:
        statement = select(RawAsset).where(
            RawAsset.symbol == symbol,
            RawAsset.source == source,
        )
        raw_asset = session.exec(statement).first()

        if not raw_asset:
            raise HTTPException(status_code=404, detail="Raw asset not found")

        return RawAssetResponse(
            symbol=raw_asset.symbol,
            source=raw_asset.source,
            asset_id=raw_asset.asset_id,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.post("", response_model=RawAssetResponse)
def create_raw_asset(
    raw_asset_data: RawAssetCreate,
    session: Session = Depends(get_db),
):
    """
    Create a new raw asset mapping.

    - **raw_asset_data**: The raw asset data to create
    """
    try:
        # Check if raw asset already exists
        statement = select(RawAsset).where(
            RawAsset.symbol == raw_asset_data.symbol,
            RawAsset.source == raw_asset_data.source,
        )
        existing = session.exec(statement).first()

        if existing:
            raise HTTPException(
                status_code=400,
                detail=f"Raw asset ({raw_asset_data.symbol}, {raw_asset_data.source}) already exists",
            )

        raw_asset = RawAsset(
            symbol=raw_asset_data.symbol,
            source=raw_asset_data.source,
            asset_id=raw_asset_data.asset_id,
        )

        session.add(raw_asset)
        session.commit()
        session.refresh(raw_asset)

        return RawAssetResponse(
            symbol=raw_asset.symbol,
            source=raw_asset.source,
            asset_id=raw_asset.asset_id,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.patch("/{source}/{symbol}", response_model=RawAssetResponse)
def update_raw_asset(
    source: str,
    symbol: str,
    asset_update: RawAssetUpdate,
    session: Session = Depends(get_db),
):
    """
    Update a raw asset's asset_id.
    When asset_id is updated, propagates to all linked transactions.

    - **source**: Source exchange/platform name
    - **symbol**: Asset symbol from the source
    - **update**: Fields to update
    """
    try:
        statement = select(RawAsset).where(
            RawAsset.symbol == symbol,
            RawAsset.source == source,
        )
        existing = session.exec(statement).first()

        if not existing:
            raise HTTPException(status_code=404, detail="Raw asset not found")

        # Update asset_id
        update_data = asset_update.model_dump(exclude_unset=True)
        if "asset_id" in update_data:
            new_asset_id = update_data["asset_id"]
            existing.asset_id = new_asset_id

            # Propagate asset_id to transactions where this raw asset is used
            # Use bulk updates for efficiency and reliability

            # Update asset_id for transactions matching source_asset_symbol
            stmt_asset = (
                update(NormalizedTransaction)
                .where(
                    NormalizedTransaction.source == source,
                    NormalizedTransaction.source_asset_symbol == symbol,
                )
                .values(asset_id=new_asset_id)
            )
            session.exec(stmt_asset)

            # Update price_quote_asset_id for transactions matching source_price_quote_asset_symbol
            stmt_price = (
                update(NormalizedTransaction)
                .where(
                    NormalizedTransaction.source == source,
                    NormalizedTransaction.source_price_quote_asset_symbol == symbol,
                )
                .values(price_quote_asset_id=new_asset_id)
            )
            session.exec(stmt_price)

            # Update fee_quote_asset_id for transactions matching source_fee_quote_asset_symbol
            stmt_fee = (
                update(NormalizedTransaction)
                .where(
                    NormalizedTransaction.source == source,
                    NormalizedTransaction.source_fee_quote_asset_symbol == symbol,
                )
                .values(fee_quote_asset_id=new_asset_id)
            )
            session.exec(stmt_fee)

            # Update attributed_asset_id for transactions matching source_attributed_asset_symbol
            stmt_attr = (
                update(NormalizedTransaction)
                .where(
                    NormalizedTransaction.source == source,
                    NormalizedTransaction.source_attributed_asset_symbol == symbol,
                )
                .values(attributed_asset_id=new_asset_id)
            )
            session.exec(stmt_attr)

        session.add(existing)
        session.commit()
        session.refresh(existing)

        return RawAssetResponse(
            symbol=existing.symbol,
            source=existing.source,
            asset_id=existing.asset_id,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.delete("/{source}/{symbol}")
def delete_raw_asset(
    source: str,
    symbol: str,
    session: Session = Depends(get_db),
):
    """
    Delete a raw asset by composite key.

    - **source**: Source exchange/platform name
    - **symbol**: Asset symbol from the source
    """
    try:
        statement = select(RawAsset).where(
            RawAsset.symbol == symbol,
            RawAsset.source == source,
        )
        existing = session.exec(statement).first()

        if not existing:
            raise HTTPException(status_code=404, detail="Raw asset not found")

        session.delete(existing)
        session.commit()

        return {
            "message": "Raw asset deleted successfully",
            "symbol": symbol,
            "source": source,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
