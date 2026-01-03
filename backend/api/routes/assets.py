"""
Asset endpoints for the Trade Exporter API.

Includes:
- Asset CRUD operations
- Asset Price Getter CRUD operations (sub-resource of assets)
"""

from datetime import datetime
from fastapi import APIRouter, HTTPException, Query, Depends
from typing import List, Optional, Dict, Any
from pydantic import BaseModel
from sqlmodel import Session, select

from backend.db.database import get_db
from backend.db.models import Asset, AssetPriceGetter
from backend.services.price_getters import list_price_getters

router = APIRouter(prefix="/assets", tags=["Assets"])


# ============================================================================
# Asset Models
# ============================================================================


class AssetCreate(BaseModel):
    """Request model for creating an asset."""

    symbol: str
    label: Optional[str] = None
    price_type: Optional[str] = None
    tags: Optional[List[str]] = None
    status: Optional[int] = 0


class AssetUpdate(BaseModel):
    """Request model for updating an asset."""

    symbol: Optional[str] = None
    label: Optional[str] = None
    price_type: Optional[str] = None
    tags: Optional[List[str]] = None
    status: Optional[int] = None


class AssetPriceGetterResponse(BaseModel):
    """Response model for asset price getters."""

    id: int
    asset_id: int
    price_getter: str
    priority: int
    enabled: bool
    params: Dict[str, Any]
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class AssetResponse(BaseModel):
    """Response model for assets."""

    asset_id: Optional[int] = None
    symbol: str
    label: Optional[str] = None
    price_type: Optional[str] = None
    tags: Optional[List[str]] = None
    created_at: Optional[str] = None
    status: Optional[int] = 0
    price_getters: Optional[List[AssetPriceGetterResponse]] = None


# ============================================================================
# Asset Price Getter Models
# ============================================================================


class AssetPriceGetterCreate(BaseModel):
    """Request model for creating an asset price getter."""

    price_getter: str  # e.g., 'yahoo', 'coingecko'
    priority: Optional[int] = 100  # Lower = higher priority
    enabled: Optional[bool] = True
    params: Optional[Dict[str, Any]] = None  # {"asset_id": "BTC-USD"}


class AssetPriceGetterUpdate(BaseModel):
    """Request model for updating an asset price getter."""

    price_getter: Optional[str] = None
    priority: Optional[int] = None
    enabled: Optional[bool] = None
    params: Optional[Dict[str, Any]] = None


# ============================================================================
# Helper Functions
# ============================================================================


def _asset_to_response(asset: Asset, include_getters: bool = False) -> AssetResponse:
    """Convert Asset model to response."""
    response = AssetResponse(
        asset_id=asset.asset_id,
        symbol=asset.symbol,
        label=asset.label,
        price_type=asset.price_type,
        tags=asset.tags,
        created_at=asset.created_at.isoformat() if asset.created_at else None,
        status=asset.status,
    )

    if include_getters and asset.price_getters:
        response.price_getters = [
            AssetPriceGetterResponse(
                id=pg.id,
                asset_id=pg.asset_id,
                price_getter=pg.price_getter,
                priority=pg.priority,
                enabled=pg.enabled,
                params=pg.params or {},
                created_at=pg.created_at.isoformat() if pg.created_at else None,
                updated_at=pg.updated_at.isoformat() if pg.updated_at else None,
            )
            for pg in sorted(asset.price_getters, key=lambda x: x.priority)
        ]

    return response


# ============================================================================
# Asset Endpoints
# ============================================================================


@router.get("", response_model=List[AssetResponse])
def list_assets(
    status: Optional[int] = Query(
        None, description="Filter by status (0=active, 1=inactive)"
    ),
    symbol: Optional[str] = Query(None, description="Filter by symbol (partial match)"),
    include_getters: bool = Query(
        False, description="Include price getters in response"
    ),
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of results"),
    offset: int = Query(0, ge=0, description="Number of results to skip"),
    session: Session = Depends(get_db),
):
    """List all assets with optional filtering."""
    try:
        statement = select(Asset)

        if status is not None:
            statement = statement.where(Asset.status == status)

        if symbol:
            statement = statement.where(Asset.symbol.ilike(f"%{symbol}%"))

        statement = statement.order_by(Asset.symbol).offset(offset).limit(limit)

        assets = session.exec(statement).all()
        return [_asset_to_response(a, include_getters=include_getters) for a in assets]

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/price-getters/available", response_model=List[str])
def get_available_price_getters():
    """Get list of available price getter names."""
    return list_price_getters()


@router.get("/{asset_id}", response_model=AssetResponse)
def get_asset(
    asset_id: int,
    include_getters: bool = Query(
        True, description="Include price getters in response"
    ),
    session: Session = Depends(get_db),
):
    """Get a specific asset by ID."""
    try:
        asset = session.get(Asset, asset_id)

        if not asset:
            raise HTTPException(status_code=404, detail="Asset not found")

        return _asset_to_response(asset, include_getters=include_getters)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.post("", response_model=AssetResponse)
def create_asset(
    asset_data: AssetCreate,
    session: Session = Depends(get_db),
):
    """Create a new asset."""
    try:
        # Check if asset with same symbol already exists
        statement = select(Asset).where(Asset.symbol == asset_data.symbol)
        existing = session.exec(statement).first()

        if existing:
            raise HTTPException(
                status_code=400,
                detail=f"Asset with symbol '{asset_data.symbol}' already exists",
            )

        asset = Asset(
            symbol=asset_data.symbol,
            label=asset_data.label,
            price_type=asset_data.price_type,
            tags=asset_data.tags,
            status=asset_data.status or 0,
        )

        session.add(asset)
        session.commit()
        session.refresh(asset)

        return _asset_to_response(asset)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.patch("/{asset_id}", response_model=AssetResponse)
def update_asset(
    asset_id: int,
    update: AssetUpdate,
    session: Session = Depends(get_db),
):
    """Update an existing asset."""
    try:
        asset = session.get(Asset, asset_id)

        if not asset:
            raise HTTPException(status_code=404, detail="Asset not found")

        update_data = update.model_dump(exclude_unset=True)

        # Check symbol uniqueness if being changed
        if "symbol" in update_data and update_data["symbol"] != asset.symbol:
            statement = select(Asset).where(Asset.symbol == update_data["symbol"])
            symbol_check = session.exec(statement).first()
            if symbol_check:
                raise HTTPException(
                    status_code=400,
                    detail=f"Asset with symbol '{update_data['symbol']}' already exists",
                )

        for key, value in update_data.items():
            setattr(asset, key, value)

        session.add(asset)
        session.commit()
        session.refresh(asset)

        return _asset_to_response(asset, include_getters=True)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.delete("/{asset_id}")
def delete_asset(
    asset_id: int,
    session: Session = Depends(get_db),
):
    """Delete an asset by ID."""
    try:
        asset = session.get(Asset, asset_id)

        if not asset:
            raise HTTPException(status_code=404, detail="Asset not found")

        session.delete(asset)
        session.commit()

        return {"message": "Asset deleted successfully", "asset_id": asset_id}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


# ============================================================================
# Asset Price Getter Endpoints
# ============================================================================


@router.get("/{asset_id}/price-getters", response_model=List[AssetPriceGetterResponse])
def list_asset_price_getters(
    asset_id: int,
    session: Session = Depends(get_db),
):
    """List all price getters for an asset, ordered by priority."""
    try:
        asset = session.get(Asset, asset_id)
        if not asset:
            raise HTTPException(status_code=404, detail="Asset not found")

        statement = (
            select(AssetPriceGetter)
            .where(AssetPriceGetter.asset_id == asset_id)
            .order_by(AssetPriceGetter.priority)
        )
        getters = session.exec(statement).all()

        return [
            AssetPriceGetterResponse(
                id=pg.id,
                asset_id=pg.asset_id,
                price_getter=pg.price_getter,
                priority=pg.priority,
                enabled=pg.enabled,
                params=pg.params or {},
                created_at=pg.created_at.isoformat() if pg.created_at else None,
                updated_at=pg.updated_at.isoformat() if pg.updated_at else None,
            )
            for pg in getters
        ]

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.post("/{asset_id}/price-getters", response_model=AssetPriceGetterResponse)
def create_asset_price_getter(
    asset_id: int,
    data: AssetPriceGetterCreate,
    session: Session = Depends(get_db),
):
    """Add a price getter configuration to an asset."""
    try:
        asset = session.get(Asset, asset_id)
        if not asset:
            raise HTTPException(status_code=404, detail="Asset not found")

        # Validate price_getter name
        available = list_price_getters()
        if data.price_getter not in available:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid price_getter '{data.price_getter}'. Available: {available}",
            )

        # Check for duplicate
        statement = select(AssetPriceGetter).where(
            AssetPriceGetter.asset_id == asset_id,
            AssetPriceGetter.price_getter == data.price_getter,
        )
        existing = session.exec(statement).first()
        if existing:
            raise HTTPException(
                status_code=400,
                detail=f"Price getter '{data.price_getter}' already configured for this asset",
            )

        getter = AssetPriceGetter(
            asset_id=asset_id,
            price_getter=data.price_getter,
            priority=data.priority or 100,
            enabled=data.enabled if data.enabled is not None else True,
            params=data.params or {},
        )

        session.add(getter)
        session.commit()
        session.refresh(getter)

        return AssetPriceGetterResponse(
            id=getter.id,
            asset_id=getter.asset_id,
            price_getter=getter.price_getter,
            priority=getter.priority,
            enabled=getter.enabled,
            params=getter.params or {},
            created_at=getter.created_at.isoformat() if getter.created_at else None,
            updated_at=getter.updated_at.isoformat() if getter.updated_at else None,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.patch(
    "/{asset_id}/price-getters/{getter_id}", response_model=AssetPriceGetterResponse
)
def update_asset_price_getter(
    asset_id: int,
    getter_id: int,
    update: AssetPriceGetterUpdate,
    session: Session = Depends(get_db),
):
    """Update a price getter configuration."""
    try:
        getter = session.get(AssetPriceGetter, getter_id)
        if not getter or getter.asset_id != asset_id:
            raise HTTPException(status_code=404, detail="Price getter not found")

        update_data = update.model_dump(exclude_unset=True)

        # Validate price_getter name if being changed
        if "price_getter" in update_data:
            available = list_price_getters()
            if update_data["price_getter"] not in available:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid price_getter '{update_data['price_getter']}'. Available: {available}",
                )

            # Check for duplicate
            statement = select(AssetPriceGetter).where(
                AssetPriceGetter.asset_id == asset_id,
                AssetPriceGetter.price_getter == update_data["price_getter"],
                AssetPriceGetter.id != getter_id,
            )
            existing = session.exec(statement).first()
            if existing:
                raise HTTPException(
                    status_code=400,
                    detail=f"Price getter '{update_data['price_getter']}' already configured for this asset",
                )

        for key, value in update_data.items():
            setattr(getter, key, value)

        getter.updated_at = datetime.utcnow()

        session.add(getter)
        session.commit()
        session.refresh(getter)

        return AssetPriceGetterResponse(
            id=getter.id,
            asset_id=getter.asset_id,
            price_getter=getter.price_getter,
            priority=getter.priority,
            enabled=getter.enabled,
            params=getter.params or {},
            created_at=getter.created_at.isoformat() if getter.created_at else None,
            updated_at=getter.updated_at.isoformat() if getter.updated_at else None,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.delete("/{asset_id}/price-getters/{getter_id}")
def delete_asset_price_getter(
    asset_id: int,
    getter_id: int,
    session: Session = Depends(get_db),
):
    """Delete a price getter configuration from an asset."""
    try:
        getter = session.get(AssetPriceGetter, getter_id)
        if not getter or getter.asset_id != asset_id:
            raise HTTPException(status_code=404, detail="Price getter not found")

        session.delete(getter)
        session.commit()

        return {"message": "Price getter deleted successfully", "id": getter_id}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
