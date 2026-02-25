"""
Asset endpoints for the Trade Exporter API.

Includes:
- Asset CRUD operations
- Asset Price Getter CRUD operations (sub-resource of assets)
- CSV import endpoint for bulk asset creation
"""

from datetime import datetime
from fastapi import APIRouter, HTTPException, Query, Depends, UploadFile, File
from typing import List, Optional, Dict, Any
from pydantic import BaseModel
from sqlmodel import Session, select
from sqlalchemy import func

from backend.db.database import get_db
from backend.db.models import (
    Asset,
    AssetPriceGetter,
    Category,
    AssetCategory,
    Dimension,
    NormalizedTransaction,
    PriceSnapshot,
    RawAsset,
    CostLot,
    RealizedPnl,
)
from backend.services.price_getters import list_price_getters
from backend.file_loaders.asset_csv_loader import AssetCSVLoader
from backend.services.asset_import_service import AssetImportService

router = APIRouter(prefix="/assets", tags=["Assets"])


# ============================================================================
# Asset Models
# ============================================================================


class AssetCreate(BaseModel):
    """Request model for creating an asset."""

    symbol: str
    label: Optional[str] = None
    price_type: Optional[str] = None
    tags: Optional[List[Dict[str, Any]]] = None
    status: Optional[int] = 0


class AssetUpdate(BaseModel):
    """Request model for updating an asset."""

    symbol: Optional[str] = None
    label: Optional[str] = None
    price_type: Optional[str] = None
    tags: Optional[List[Dict[str, Any]]] = None
    status: Optional[int] = None


class AssetPriceGetterResponse(BaseModel):
    """Response model for asset price getters."""

    id: int
    asset_id: int
    price_getter: str
    external_id: Optional[str] = None  # API identifier: "BTC-USD", "bitcoin", "AAPL"
    priority: int
    enabled: bool
    params: Dict[str, Any]  # Extra params: native_quote_currency, source, etc.
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class CategoryResponse(BaseModel):
    """Response model for categories in asset response."""
    id: int
    dimension_id: int
    dimension_label: str  # From joined Dimension
    label: str
    color: Optional[str] = None
    ordinal: int = 0


class AssetResponse(BaseModel):
    """Response model for assets."""

    asset_id: Optional[int] = None
    symbol: str
    label: Optional[str] = None
    price_type: Optional[str] = None
    tags: Optional[List[Dict[str, Any]]] = None
    created_at: Optional[str] = None
    status: Optional[int] = 0
    price_getters: Optional[List[AssetPriceGetterResponse]] = None
    categories: Optional[List[CategoryResponse]] = None


# ============================================================================
# Asset Price Getter Models
# ============================================================================


class AssetPriceGetterCreate(BaseModel):
    """Request model for creating an asset price getter."""

    price_getter: str  # e.g., 'yahoo', 'coingecko'
    external_id: Optional[str] = None  # API identifier: "BTC-USD", "bitcoin", "AAPL"
    priority: Optional[int] = 100  # Lower = higher priority
    enabled: Optional[bool] = True
    params: Optional[Dict[str, Any]] = None  # Extra params: {"native_quote_currency": "EUR"}


class AssetPriceGetterUpdate(BaseModel):
    """Request model for updating an asset price getter."""

    price_getter: Optional[str] = None
    external_id: Optional[str] = None  # API identifier: "BTC-USD", "bitcoin", "AAPL"
    priority: Optional[int] = None
    enabled: Optional[bool] = None
    params: Optional[Dict[str, Any]] = None  # Extra params


# ============================================================================
# Helper Functions
# ============================================================================


def _asset_to_response(asset: Asset, include_getters: bool = False, include_categories: bool = False, session: Session = None) -> AssetResponse:
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
                external_id=pg.external_id,
                priority=pg.priority,
                enabled=pg.enabled,
                params=pg.params or {},
                created_at=pg.created_at.isoformat() if pg.created_at else None,
                updated_at=pg.updated_at.isoformat() if pg.updated_at else None,
            )
            for pg in sorted(asset.price_getters, key=lambda x: x.priority)
        ]

    if include_categories and session:
        categories = session.exec(
            select(Category, Dimension)
            .join(Dimension, Category.dimension_id == Dimension.id)
            .join(AssetCategory, AssetCategory.category_id == Category.id)
            .where(AssetCategory.asset_id == asset.asset_id)
            .order_by(Dimension.ordinal, Category.ordinal)
        ).all()
        response.categories = [
            CategoryResponse(
                id=c.id,
                dimension_id=c.dimension_id,
                dimension_label=d.label,
                label=c.label,
                color=c.color,
                ordinal=c.ordinal,
            )
            for c, d in categories
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
    include_categories: bool = Query(
        False, description="Include categories in response"
    ),
    limit: int = Query(100, ge=1, le=10000, description="Maximum number of results"),
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
        return [_asset_to_response(a, include_getters=include_getters, include_categories=include_categories, session=session) for a in assets]

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/price-getters/available", response_model=List[str])
def get_available_price_getters():
    """Get list of available price getter names."""
    return list_price_getters()


@router.get("/transaction-counts", response_model=Dict[str, int])
def get_transaction_counts_by_symbol(session: Session = Depends(get_db)):
    """Return {symbol: count} for non-invalid transactions, grouped by source_asset_symbol."""
    statement = (
        select(NormalizedTransaction.source_asset_symbol, func.count().label("cnt"))
        .where(
            NormalizedTransaction.review_status != "invalid",
            NormalizedTransaction.source_asset_symbol != "",
            NormalizedTransaction.source_asset_symbol.isnot(None),
        )
        .group_by(NormalizedTransaction.source_asset_symbol)
        .order_by(func.count().desc())
    )
    rows = session.exec(statement).all()
    return {symbol: cnt for symbol, cnt in rows}


@router.get("/{asset_id}", response_model=AssetResponse)
def get_asset(
    asset_id: int,
    include_getters: bool = Query(
        True, description="Include price getters in response"
    ),
    include_categories: bool = Query(
        True, description="Include categories in response"
    ),
    session: Session = Depends(get_db),
):
    """Get a specific asset by ID."""
    try:
        asset = session.get(Asset, asset_id)

        if not asset:
            raise HTTPException(status_code=404, detail="Asset not found")

        return _asset_to_response(asset, include_getters=include_getters, include_categories=include_categories, session=session)

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


# ============================================================================
# Bulk Operations Models
# ============================================================================


class BulkUpdateRequest(BaseModel):
    """Request model for bulk updating assets."""
    asset_ids: List[int]
    updates: Dict[str, Any]  # Fields to update: status, price_type, etc.


class BulkCategoriesRequest(BaseModel):
    """Request model for bulk category operations."""
    asset_ids: List[int]
    category_ids: List[int]
    mode: str  # 'add', 'replace', 'remove'


class BulkPriceGettersRequest(BaseModel):
    """Request model for bulk price getter assignment."""
    asset_ids: List[int]
    price_getter: str
    external_id: Optional[str] = None
    priority: int = 100


class BulkDeleteRequest(BaseModel):
    """Request model for bulk deletion."""
    asset_ids: List[int]


# ============================================================================
# Bulk Operations Endpoints
# ============================================================================


@router.post("/bulk/update")
def bulk_update_assets(
    request: BulkUpdateRequest,
    session: Session = Depends(get_db),
):
    """Bulk update multiple assets with the same values."""
    try:
        if not request.asset_ids:
            raise HTTPException(status_code=400, detail="No asset IDs provided")
        
        if not request.updates:
            raise HTTPException(status_code=400, detail="No updates provided")
        
        # Validate allowed update fields
        allowed_fields = {'status', 'price_type', 'label', 'tags'}
        for key in request.updates.keys():
            if key not in allowed_fields:
                raise HTTPException(
                    status_code=400, 
                    detail=f"Field '{key}' cannot be bulk updated. Allowed: {allowed_fields}"
                )
        
        updated_count = 0
        errors = []
        
        for asset_id in request.asset_ids:
            asset = session.get(Asset, asset_id)
            if not asset:
                errors.append({"asset_id": asset_id, "error": "Asset not found"})
                continue
            
            for key, value in request.updates.items():
                setattr(asset, key, value)
            
            session.add(asset)
            updated_count += 1
        
        session.commit()
        
        return {
            "message": f"Updated {updated_count} assets",
            "updated_count": updated_count,
            "errors": errors
        }
    
    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.post("/bulk/categories")
def bulk_update_categories(
    request: BulkCategoriesRequest,
    session: Session = Depends(get_db),
):
    """Bulk update categories for multiple assets."""
    try:
        if not request.asset_ids:
            raise HTTPException(status_code=400, detail="No asset IDs provided")
        
        if request.mode not in ('add', 'replace', 'remove'):
            raise HTTPException(status_code=400, detail="Mode must be 'add', 'replace', or 'remove'")
        
        # Verify all categories exist
        if request.category_ids:
            for cat_id in request.category_ids:
                cat = session.get(Category, cat_id)
                if not cat:
                    raise HTTPException(status_code=404, detail=f"Category {cat_id} not found")
        
        updated_count = 0
        errors = []
        
        for asset_id in request.asset_ids:
            asset = session.get(Asset, asset_id)
            if not asset:
                errors.append({"asset_id": asset_id, "error": "Asset not found"})
                continue
            
            if request.mode == 'replace':
                # Delete all existing category assignments
                statement = select(AssetCategory).where(AssetCategory.asset_id == asset_id)
                existing = session.exec(statement).all()
                for ac in existing:
                    session.delete(ac)
            
            if request.mode == 'remove':
                # Remove only specified categories
                for cat_id in request.category_ids:
                    statement = select(AssetCategory).where(
                        AssetCategory.asset_id == asset_id,
                        AssetCategory.category_id == cat_id
                    )
                    existing = session.exec(statement).first()
                    if existing:
                        session.delete(existing)
            
            if request.mode in ('add', 'replace'):
                # Add new categories
                for cat_id in request.category_ids:
                    # Check if already exists (for 'add' mode)
                    if request.mode == 'add':
                        statement = select(AssetCategory).where(
                            AssetCategory.asset_id == asset_id,
                            AssetCategory.category_id == cat_id
                        )
                        if session.exec(statement).first():
                            continue  # Skip if already assigned
                    
                    ac = AssetCategory(asset_id=asset_id, category_id=cat_id)
                    session.add(ac)
            
            updated_count += 1
        
        session.commit()
        
        return {
            "message": f"Updated categories for {updated_count} assets",
            "updated_count": updated_count,
            "mode": request.mode,
            "errors": errors
        }
    
    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.post("/bulk/price-getters")
def bulk_assign_price_getters(
    request: BulkPriceGettersRequest,
    session: Session = Depends(get_db),
):
    """Bulk assign a price getter to multiple assets."""
    try:
        if not request.asset_ids:
            raise HTTPException(status_code=400, detail="No asset IDs provided")
        
        # Validate price_getter
        available = list_price_getters()
        if request.price_getter not in available:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid price_getter '{request.price_getter}'. Available: {available}"
            )
        
        created_count = 0
        skipped_count = 0
        errors = []
        
        for asset_id in request.asset_ids:
            asset = session.get(Asset, asset_id)
            if not asset:
                errors.append({"asset_id": asset_id, "error": "Asset not found"})
                continue
            
            # Check if this getter already exists for the asset
            statement = select(AssetPriceGetter).where(
                AssetPriceGetter.asset_id == asset_id,
                AssetPriceGetter.price_getter == request.price_getter
            )
            existing = session.exec(statement).first()
            if existing:
                skipped_count += 1
                continue  # Skip if already has this getter
            
            # Use asset symbol if no external_id provided
            external_id = request.external_id if request.external_id else None
            
            getter = AssetPriceGetter(
                asset_id=asset_id,
                price_getter=request.price_getter,
                external_id=external_id,
                priority=request.priority,
                enabled=True,
                params={}
            )
            session.add(getter)
            created_count += 1
        
        session.commit()
        
        return {
            "message": f"Added price getter to {created_count} assets ({skipped_count} already had it)",
            "created_count": created_count,
            "skipped_count": skipped_count,
            "errors": errors
        }
    
    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.post("/bulk/check-linked", response_model=Dict[str, int])
def check_bulk_delete_impact(
    request: BulkDeleteRequest,
    session: Session = Depends(get_db),
):
    """
    Check for linked objects that would be affected by deleting these assets.
    
    Returns counts of related objects:
    - Cascade deletions (will be automatically deleted): categories, price_getters, raw_assets, price_snapshots
    - Blockers (will prevent deletion): transactions, cost_lots, realized_pnl
    """
    if not request.asset_ids:
        return {}
    
    impact = {
        # Will cascade delete (informational)
        "asset_categories": 0,
        "price_getters": 0,
        "raw_assets": 0,
        "price_snapshots": 0,
        
        # Will block deletion (errors)
        "transactions": 0,
        "cost_lots": 0,
        "realized_pnl": 0,
    }
    
    # Count cascade deletions
    impact["asset_categories"] = session.exec(
        select(func.count(AssetCategory.asset_id)).where(AssetCategory.asset_id.in_(request.asset_ids))
    ).first() or 0
    
    impact["price_getters"] = session.exec(
        select(func.count(AssetPriceGetter.id)).where(AssetPriceGetter.asset_id.in_(request.asset_ids))
    ).first() or 0
    
    impact["raw_assets"] = session.exec(
        select(func.count(RawAsset.id)).where(RawAsset.asset_id.in_(request.asset_ids))
    ).first() or 0
    
    impact["price_snapshots"] = session.exec(
        select(func.count(PriceSnapshot.snapshot_id)).where(PriceSnapshot.asset_id.in_(request.asset_ids))
    ).first() or 0
    
    # Count blockers (transactions referencing these assets)
    impact["transactions"] = session.exec(
        select(func.count(NormalizedTransaction.id)).where(
            (NormalizedTransaction.asset_id.in_(request.asset_ids)) |
            (NormalizedTransaction.price_quote_asset_id.in_(request.asset_ids)) |
            (NormalizedTransaction.fee_quote_asset_id.in_(request.asset_ids))
        )
    ).first() or 0
    
    impact["cost_lots"] = session.exec(
        select(func.count(CostLot.cost_lot_id)).where(CostLot.asset_id.in_(request.asset_ids))
    ).first() or 0
    
    impact["realized_pnl"] = session.exec(
        select(func.count(RealizedPnl.pnl_id)).where(RealizedPnl.asset_id.in_(request.asset_ids))
    ).first() or 0
    
    # Filter out zeros for cleaner response
    return {k: v for k, v in impact.items() if v > 0}


@router.post("/bulk/delete")
def bulk_delete_assets(
    request: BulkDeleteRequest,
    session: Session = Depends(get_db),
):
    """Bulk delete multiple assets."""
    try:
        if not request.asset_ids:
            raise HTTPException(status_code=400, detail="No asset IDs provided")
        
        # Check for blocking relationships across all assets
        blockers = {}
        assets_with_blockers = []
        
        for asset_id in request.asset_ids:
            asset_blockers = {}
            
            # Check for transactions referencing this asset
            tx_count = session.exec(
                select(func.count(NormalizedTransaction.id)).where(
                    (NormalizedTransaction.asset_id == asset_id) |
                    (NormalizedTransaction.price_quote_asset_id == asset_id) |
                    (NormalizedTransaction.fee_quote_asset_id == asset_id)
                )
            ).first() or 0
            
            if tx_count > 0:
                asset_blockers["transactions"] = tx_count
            
            # Check for cost lots
            lot_count = session.exec(
                select(func.count(CostLot.cost_lot_id)).where(CostLot.asset_id == asset_id)
            ).first() or 0
            
            if lot_count > 0:
                asset_blockers["cost_lots"] = lot_count
            
            # Check for realized P&L
            pnl_count = session.exec(
                select(func.count(RealizedPnl.pnl_id)).where(RealizedPnl.asset_id == asset_id)
            ).first() or 0
            
            if pnl_count > 0:
                asset_blockers["realized_pnl"] = pnl_count
            
            if asset_blockers:
                assets_with_blockers.append(asset_id)
                blockers[str(asset_id)] = asset_blockers
        
        # If any assets have blocking relationships, reject the entire operation
        if blockers:
            raise HTTPException(
                status_code=400,
                detail={
                    "message": "Cannot delete assets with existing transactions or P&L data",
                    "blockers": blockers,
                    "affected_assets": assets_with_blockers,
                }
            )
        
        # Proceed with deletion
        deleted_count = 0
        errors = []
        
        for asset_id in request.asset_ids:
            asset = session.get(Asset, asset_id)
            if not asset:
                errors.append({"asset_id": asset_id, "error": "Asset not found"})
                continue
            
            session.delete(asset)
            deleted_count += 1
        
        session.commit()
        
        return {
            "message": f"Deleted {deleted_count} assets",
            "deleted_count": deleted_count,
            "errors": errors
        }
    
    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
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
        
        # Check for blocking relationships
        blockers = {}
        
        # Check for transactions
        tx_count = session.exec(
            select(func.count(NormalizedTransaction.id)).where(
                (NormalizedTransaction.asset_id == asset_id) |
                (NormalizedTransaction.price_quote_asset_id == asset_id) |
                (NormalizedTransaction.fee_quote_asset_id == asset_id)
            )
        ).first() or 0
        
        if tx_count > 0:
            blockers["transactions"] = tx_count
        
        # Check for cost lots
        lot_count = session.exec(
            select(func.count(CostLot.cost_lot_id)).where(CostLot.asset_id == asset_id)
        ).first() or 0
        
        if lot_count > 0:
            blockers["cost_lots"] = lot_count
        
        # Check for realized P&L
        pnl_count = session.exec(
            select(func.count(RealizedPnl.pnl_id)).where(RealizedPnl.asset_id == asset_id)
        ).first() or 0
        
        if pnl_count > 0:
            blockers["realized_pnl"] = pnl_count
        
        # If any blocking relationships exist, reject deletion
        if blockers:
            raise HTTPException(
                status_code=400,
                detail={
                    "message": f"Cannot delete asset '{asset.symbol}' with existing transactions or P&L data",
                    "asset_id": asset_id,
                    "asset_symbol": asset.symbol,
                    "blockers": blockers,
                }
            )

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
                external_id=pg.external_id,
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
            external_id=data.external_id,
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
            external_id=getter.external_id,
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
            external_id=getter.external_id,
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


# ============================================================================
# CSV Import Endpoints
# ============================================================================


class ImportResultResponse(BaseModel):
    """Response model for CSV import operation."""
    assets: Dict[str, Any]
    categories: Dict[str, Any]
    price_getters: Dict[str, Any]
    asset_categories: Dict[str, Any]
    parse_errors: List[Dict[str, Any]]
    warnings: List[str]
    dry_run: bool
    summary: Dict[str, Any]


@router.post("/import-csv", response_model=ImportResultResponse)
async def import_assets_from_csv(
    file: UploadFile = File(...),
    dry_run: bool = Query(False, description="Preview changes without committing"),
    replace_price_getters: bool = Query(True, description="Replace existing price getters (vs merge)"),
    session: Session = Depends(get_db),
):
    """
    Import assets, categories, and price getters from a CSV file.
    
    Expected CSV format with columns:
    - Ticker / Symbol: Asset symbol (required)
    - Label: Display name
    - Source 1/2/3: Price getter source name (coingecko, yahoo, etc.)
    - Symbol 1/2/3: Symbol/ID to use with the price getter
    - Currency: Base currency (EUR, USD)
    - Investment Category 1: Asset class category
    - Investment Category 2: Sector category
    
    Use dry_run=true to preview what would be imported without making changes.
    """
    try:
        # Validate file type
        if not file.filename:
            raise HTTPException(status_code=400, detail="No file provided")
        
        if not file.filename.endswith('.csv'):
            raise HTTPException(status_code=400, detail="File must be a CSV file")
        
        # Read file content
        content = await file.read()
        
        # Parse CSV
        loader = AssetCSVLoader()
        load_result = loader.load_from_content(content)
        
        # Check for critical parse errors
        if load_result.errors and not load_result.assets:
            raise HTTPException(
                status_code=400, 
                detail=f"CSV parsing failed: {load_result.errors}"
            )
        
        # Import data
        import_service = AssetImportService(session)
        result = import_service.import_from_load_result(
            load_result,
            dry_run=dry_run,
            replace_price_getters=replace_price_getters
        )
        
        return ImportResultResponse(**result.to_dict())
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Import failed: {str(e)}")


@router.post("/import-csv/preview")
async def preview_csv_import(
    file: UploadFile = File(...),
):
    """
    Preview CSV file contents without importing.
    
    Returns parsed assets and categories that would be created/updated.
    Useful for validation before actual import.
    """
    try:
        if not file.filename or not file.filename.endswith('.csv'):
            raise HTTPException(status_code=400, detail="File must be a CSV file")
        
        content = await file.read()
        
        loader = AssetCSVLoader()
        load_result = loader.load_from_content(content)
        
        return {
            "filename": file.filename,
            "assets_count": len(load_result.assets),
            "categories_count": len(load_result.categories),
            "errors": load_result.errors,
            "warnings": load_result.warnings,
            "assets": [
                {
                    "symbol": a.symbol,
                    "label": a.label,
                    "price_type": a.price_type,
                    "currency": a.currency,
                    "price_getters": [
                        {
                            "getter": pg.price_getter,
                            "priority": pg.priority,
                            "params": pg.params
                        }
                        for pg in a.price_getters
                    ],
                    "categories": [f"{dim}:{cat}" for dim, cat in a.category_keys]
                }
                for a in load_result.assets
            ],
            "categories": [
                {
                    "dimension_label": c.dimension_label,
                    "label": c.label
                }
                for c in load_result.categories
            ]
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Preview failed: {str(e)}")
