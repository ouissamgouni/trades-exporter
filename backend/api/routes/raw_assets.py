"""
Raw Assets endpoints for the TradeTrail API.
Maps source-specific asset symbols (and on-chain token contracts) to normalized assets.
"""

from fastapi import APIRouter, HTTPException, Query, Depends
from typing import List, Optional
from pydantic import BaseModel, Field
from sqlmodel import Session, select
from sqlalchemy import update, func, or_

from backend.db.database import get_db
from backend.db.models import RawAsset, NormalizedTransaction
from backend.db.repositories.raw_asset_repository import token_key

router = APIRouter(prefix="/raw-assets", tags=["Raw Assets"])


class RawAssetCreate(BaseModel):
    """Request model for creating a raw asset."""

    symbol: str
    source: str
    network: str = ""
    contract_address: str = ""
    asset_id: Optional[int] = None


class RawAssetUpdate(BaseModel):
    """Request model for updating a raw asset."""

    asset_id: Optional[int] = None


class RawAssetResponse(BaseModel):
    """Response model for raw asset."""

    symbol: str
    source: str
    network: str = ""
    contract_address: str = ""
    asset_id: Optional[int] = None


class BulkMapAssetItem(BaseModel):
    """Single item for bulk asset mapping."""

    symbol: str = Field(..., description="Raw asset symbol")
    source: str = Field(..., description="Source platform/exchange")
    network: str = Field("", description="Token network (only used with a contract)")
    contract_address: str = Field("", description="Token contract; empty for non-token symbols")
    asset_id: int = Field(..., description="Target asset_id to map to")


class BulkMapAssetRequest(BaseModel):
    """Request model for bulk asset mapping."""

    mappings: List[BulkMapAssetItem] = Field(
        ..., description="List of mappings to apply"
    )


class BulkMapResponse(BaseModel):
    """Response model for bulk mapping operations."""

    success_count: int = Field(..., description="Number of successful mappings")
    failed_count: int = Field(..., description="Number of failed mappings")
    errors: List[str] = Field(
        default_factory=list, description="Error messages for failed mappings"
    )


def _to_response(ra: RawAsset) -> RawAssetResponse:
    return RawAssetResponse(
        symbol=ra.symbol,
        source=ra.source,
        network=ra.network or "",
        contract_address=ra.contract_address or "",
        asset_id=ra.asset_id,
    )


def _find(
    session: Session, symbol: str, source: str, network: str, contract_address: str
) -> Optional[RawAsset]:
    network, contract = token_key(network, contract_address)
    return session.exec(
        select(RawAsset).where(
            RawAsset.symbol == symbol,
            RawAsset.source == source,
            RawAsset.network == network,
            RawAsset.contract_address == contract,
        )
    ).first()


def _propagate(session: Session, raw: RawAsset, asset_id: Optional[int]) -> None:
    """Apply a raw asset mapping to the transactions it covers.

    A token row only covers transactions of that exact contract; a plain row covers
    contract-less transactions plus quote/fee/attributed symbols.
    """
    T = NormalizedTransaction
    if raw.contract_address:
        contract_col = (
            func.lower(T.token_contract_address)
            if raw.contract_address.startswith("0x")
            else T.token_contract_address
        )
        session.exec(
            update(T)
            .where(
                T.source == raw.source,
                T.source_asset_symbol == raw.symbol,
                func.lower(func.coalesce(T.network, "")) == raw.network,
                contract_col == raw.contract_address,
            )
            .values(asset_id=asset_id)
        )
        return

    session.exec(
        update(T)
        .where(
            T.source == raw.source,
            T.source_asset_symbol == raw.symbol,
            or_(T.token_contract_address.is_(None), T.token_contract_address == ""),
        )
        .values(asset_id=asset_id)
    )
    for symbol_col, id_field in (
        (T.source_price_quote_asset_symbol, "price_quote_asset_id"),
        (T.source_fee_quote_asset_symbol, "fee_quote_asset_id"),
        (T.source_attributed_asset_symbol, "attributed_asset_id"),
    ):
        session.exec(
            update(T)
            .where(T.source == raw.source, symbol_col == raw.symbol)
            .values({id_field: asset_id})
        )


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
                raw_asset = _find(
                    session, item.symbol, item.source, item.network, item.contract_address
                )
                if not raw_asset:
                    network, contract = token_key(item.network, item.contract_address)
                    raw_asset = RawAsset(
                        symbol=item.symbol,
                        source=item.source,
                        network=network,
                        contract_address=contract,
                        asset_id=item.asset_id,
                    )
                    session.add(raw_asset)
                else:
                    raw_asset.asset_id = item.asset_id

                _propagate(session, raw_asset, item.asset_id)
                success_count += 1

            except Exception as e:
                failed_count += 1
                errors.append(f"{item.symbol}@{item.source}: {str(e)}")

        session.commit()

        return BulkMapResponse(
            success_count=success_count, failed_count=failed_count, errors=errors
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
            statement.order_by(
                RawAsset.source, RawAsset.symbol, RawAsset.network, RawAsset.contract_address
            )
            .offset(offset)
            .limit(limit)
        )

        return [_to_response(ra) for ra in session.exec(statement).all()]

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/{source}/{symbol}", response_model=RawAssetResponse)
def get_raw_asset(
    source: str,
    symbol: str,
    network: str = Query("", description="Token network (with contract_address)"),
    contract_address: str = Query("", description="Token contract address"),
    session: Session = Depends(get_db),
):
    """
    Get a specific raw asset by composite key.

    - **source**: Source exchange/platform name
    - **symbol**: Asset symbol from the source
    """
    try:
        raw_asset = _find(session, symbol, source, network, contract_address)

        if not raw_asset:
            raise HTTPException(status_code=404, detail="Raw asset not found")

        return _to_response(raw_asset)

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
        existing = _find(
            session,
            raw_asset_data.symbol,
            raw_asset_data.source,
            raw_asset_data.network,
            raw_asset_data.contract_address,
        )

        if existing:
            raise HTTPException(
                status_code=400,
                detail=f"Raw asset ({raw_asset_data.symbol}, {raw_asset_data.source}) already exists",
            )

        network, contract = token_key(
            raw_asset_data.network, raw_asset_data.contract_address
        )
        raw_asset = RawAsset(
            symbol=raw_asset_data.symbol,
            source=raw_asset_data.source,
            network=network,
            contract_address=contract,
            asset_id=raw_asset_data.asset_id,
        )

        session.add(raw_asset)
        if raw_asset.asset_id is not None:
            _propagate(session, raw_asset, raw_asset.asset_id)
        session.commit()
        session.refresh(raw_asset)

        return _to_response(raw_asset)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.patch("/{source}/{symbol}", response_model=RawAssetResponse)
def update_raw_asset(
    source: str,
    symbol: str,
    asset_update: RawAssetUpdate,
    network: str = Query("", description="Token network (with contract_address)"),
    contract_address: str = Query("", description="Token contract address"),
    session: Session = Depends(get_db),
):
    """
    Update a raw asset's asset_id.
    When asset_id is updated, propagates to all linked transactions.

    - **source**: Source exchange/platform name
    - **symbol**: Asset symbol from the source
    - **network** / **contract_address**: select the token row (empty = plain symbol row)
    """
    try:
        existing = _find(session, symbol, source, network, contract_address)

        if not existing:
            raise HTTPException(status_code=404, detail="Raw asset not found")

        update_data = asset_update.model_dump(exclude_unset=True)
        if "asset_id" in update_data:
            existing.asset_id = update_data["asset_id"]
            _propagate(session, existing, existing.asset_id)

        session.add(existing)
        session.commit()
        session.refresh(existing)

        return _to_response(existing)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.delete("/{source}/{symbol}")
def delete_raw_asset(
    source: str,
    symbol: str,
    network: str = Query("", description="Token network (with contract_address)"),
    contract_address: str = Query("", description="Token contract address"),
    session: Session = Depends(get_db),
):
    """
    Delete a raw asset by composite key.

    - **source**: Source exchange/platform name
    - **symbol**: Asset symbol from the source
    """
    try:
        existing = _find(session, symbol, source, network, contract_address)

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
