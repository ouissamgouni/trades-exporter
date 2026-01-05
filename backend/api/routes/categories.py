"""
Category endpoints for the Trade Exporter API.
Provides CRUD operations for dimensions and categories used in asset classification.
"""

from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, select, func

from backend.db.database import get_db
from backend.db.models import Category, AssetCategory, Asset, Dimension


router = APIRouter(prefix="/categories", tags=["Categories"])


# ============================================================================
# Pydantic Models
# ============================================================================


class DimensionCreate(BaseModel):
    """Request model for creating a dimension."""
    label: str  # Display name like "Asset Class"
    ordinal: int = 0


class DimensionUpdate(BaseModel):
    """Request model for updating a dimension."""
    label: Optional[str] = None
    ordinal: Optional[int] = None


class DimensionResponse(BaseModel):
    """Response model for a dimension."""
    id: int
    label: str
    ordinal: int
    category_count: int = 0
    asset_count: int = 0  # Total assets across all categories in this dimension
    
    class Config:
        from_attributes = True


class CategoryCreate(BaseModel):
    """Request model for creating a category."""
    dimension_id: int
    label: str
    color: Optional[str] = None
    ordinal: int = 0


class CategoryUpdate(BaseModel):
    """Request model for updating a category."""
    label: Optional[str] = None
    color: Optional[str] = None
    ordinal: Optional[int] = None


class CategoryResponse(BaseModel):
    """Response model for a category."""
    id: int
    dimension_id: int
    dimension_label: str  # Convenience field from dimension
    label: str
    color: Optional[str]
    ordinal: int
    asset_count: int = 0  # Number of assets linked to this category
    
    class Config:
        from_attributes = True


class LinkedAssetResponse(BaseModel):
    """Response model for an asset linked to a category."""
    asset_id: int
    symbol: str
    label: Optional[str] = None


class CategoryAssetsResponse(BaseModel):
    """Response model for assets linked to a category."""
    category_id: int
    category_label: str
    dimension_id: int
    dimension_label: str
    assets: List[LinkedAssetResponse]
    count: int


class DimensionWithCategoriesResponse(BaseModel):
    """Response model for a dimension with its categories."""
    id: int
    label: str
    ordinal: int
    categories: List[CategoryResponse]


class AssetCategoryAssignment(BaseModel):
    """Request model for assigning categories to an asset."""
    category_ids: List[int]


class AssetCategoriesResponse(BaseModel):
    """Response model for asset's categories."""
    asset_id: int
    categories: List[CategoryResponse]


class UnclassifiedResponse(BaseModel):
    """Response for unclassified assets in a dimension."""
    dimension_id: int
    dimension_label: str
    count: int
    assets: List[LinkedAssetResponse]


# ============================================================================
# Helper Functions
# ============================================================================


def _build_category_response(category: Category, dimension: Dimension, asset_count: int = 0) -> CategoryResponse:
    """Build a CategoryResponse from a Category and its Dimension."""
    return CategoryResponse(
        id=category.id,
        dimension_id=category.dimension_id,
        dimension_label=dimension.label,
        label=category.label,
        color=category.color,
        ordinal=category.ordinal,
        asset_count=asset_count
    )


# ============================================================================
# Dimension CRUD Endpoints
# ============================================================================


@router.get("/dimensions", response_model=List[DimensionResponse])
def list_dimensions(session: Session = Depends(get_db)):
    """List all dimensions with category and asset counts."""
    dimensions = session.exec(
        select(Dimension).order_by(Dimension.ordinal, Dimension.label)
    ).all()
    
    # Get category counts per dimension
    cat_counts = dict(session.exec(
        select(Category.dimension_id, func.count(Category.id))
        .group_by(Category.dimension_id)
    ).all())
    
    # Get asset counts per dimension (distinct assets)
    # This requires joining through categories
    asset_counts_query = (
        select(Category.dimension_id, func.count(func.distinct(AssetCategory.asset_id)))
        .join(AssetCategory, AssetCategory.category_id == Category.id)
        .group_by(Category.dimension_id)
    )
    asset_counts = dict(session.exec(asset_counts_query).all())
    
    return [
        DimensionResponse(
            id=d.id,
            label=d.label,
            ordinal=d.ordinal,
            category_count=cat_counts.get(d.id, 0),
            asset_count=asset_counts.get(d.id, 0)
        )
        for d in dimensions
    ]


@router.post("/dimensions", response_model=DimensionResponse, status_code=201)
def create_dimension(data: DimensionCreate, session: Session = Depends(get_db)):
    """Create a new dimension."""
    # Check if dimension with same label exists
    existing = session.exec(
        select(Dimension).where(Dimension.label == data.label)
    ).first()
    
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Dimension '{data.label}' already exists"
        )
    
    dimension = Dimension(
        label=data.label,
        ordinal=data.ordinal
    )
    
    session.add(dimension)
    session.commit()
    session.refresh(dimension)
    
    return DimensionResponse(
        id=dimension.id,
        label=dimension.label,
        ordinal=dimension.ordinal,
        category_count=0,
        asset_count=0
    )


@router.get("/dimensions/{dimension_id}", response_model=DimensionResponse)
def get_dimension(dimension_id: int, session: Session = Depends(get_db)):
    """Get a specific dimension by ID."""
    dimension = session.get(Dimension, dimension_id)
    if not dimension:
        raise HTTPException(status_code=404, detail="Dimension not found")
    
    # Get counts
    cat_count = session.exec(
        select(func.count(Category.id)).where(Category.dimension_id == dimension_id)
    ).one()
    
    asset_count = session.exec(
        select(func.count(func.distinct(AssetCategory.asset_id)))
        .join(Category, Category.id == AssetCategory.category_id)
        .where(Category.dimension_id == dimension_id)
    ).one() or 0
    
    return DimensionResponse(
        id=dimension.id,
        label=dimension.label,
        ordinal=dimension.ordinal,
        category_count=cat_count,
        asset_count=asset_count
    )


@router.put("/dimensions/{dimension_id}", response_model=DimensionResponse)
def update_dimension(dimension_id: int, data: DimensionUpdate, session: Session = Depends(get_db)):
    """Update a dimension."""
    dimension = session.get(Dimension, dimension_id)
    if not dimension:
        raise HTTPException(status_code=404, detail="Dimension not found")
    
    if data.label is not None:
        # Check for duplicate label
        existing = session.exec(
            select(Dimension).where(Dimension.label == data.label, Dimension.id != dimension_id)
        ).first()
        if existing:
            raise HTTPException(status_code=400, detail=f"Dimension '{data.label}' already exists")
        dimension.label = data.label
    
    if data.ordinal is not None:
        dimension.ordinal = data.ordinal
    
    session.add(dimension)
    session.commit()
    session.refresh(dimension)
    
    # Get counts for response
    cat_count = session.exec(
        select(func.count(Category.id)).where(Category.dimension_id == dimension_id)
    ).one()
    
    asset_count = session.exec(
        select(func.count(func.distinct(AssetCategory.asset_id)))
        .join(Category, Category.id == AssetCategory.category_id)
        .where(Category.dimension_id == dimension_id)
    ).one() or 0
    
    return DimensionResponse(
        id=dimension.id,
        label=dimension.label,
        ordinal=dimension.ordinal,
        category_count=cat_count,
        asset_count=asset_count
    )


@router.delete("/dimensions/{dimension_id}", status_code=204)
def delete_dimension(dimension_id: int, session: Session = Depends(get_db)):
    """
    Delete a dimension and all its categories.
    Also removes all asset-category associations for this dimension.
    """
    dimension = session.get(Dimension, dimension_id)
    if not dimension:
        raise HTTPException(status_code=404, detail="Dimension not found")
    
    # Get all categories in this dimension
    categories = session.exec(
        select(Category).where(Category.dimension_id == dimension_id)
    ).all()
    
    # Delete asset-category associations
    for cat in categories:
        assocs = session.exec(
            select(AssetCategory).where(AssetCategory.category_id == cat.id)
        ).all()
        for assoc in assocs:
            session.delete(assoc)
    
    # Delete categories
    for cat in categories:
        session.delete(cat)
    
    # Delete dimension
    session.delete(dimension)
    session.commit()
    
    return None


@router.get("/dimensions/{dimension_id}/unclassified", response_model=UnclassifiedResponse)
def get_unclassified_assets(dimension_id: int, session: Session = Depends(get_db)):
    """Get assets that have no category assigned in the specified dimension."""
    dimension = session.get(Dimension, dimension_id)
    if not dimension:
        raise HTTPException(status_code=404, detail="Dimension not found")
    
    # Get category IDs for this dimension
    category_ids = session.exec(
        select(Category.id).where(Category.dimension_id == dimension_id)
    ).all()
    
    # Get assets that have a category from this dimension
    if category_ids:
        assets_with_dim_ids = set(session.exec(
            select(AssetCategory.asset_id).where(AssetCategory.category_id.in_(category_ids))
        ).all())
    else:
        assets_with_dim_ids = set()
    
    # Get all assets
    all_assets = session.exec(select(Asset).order_by(Asset.symbol)).all()
    
    # Filter unclassified
    unclassified = [a for a in all_assets if a.asset_id not in assets_with_dim_ids]
    
    return UnclassifiedResponse(
        dimension_id=dimension_id,
        dimension_label=dimension.label,
        count=len(unclassified),
        assets=[LinkedAssetResponse(asset_id=a.asset_id, symbol=a.symbol, label=a.label) for a in unclassified]
    )


# ============================================================================
# Category CRUD Endpoints
# ============================================================================


@router.get("", response_model=List[CategoryResponse])
def list_categories(
    dimension_id: Optional[int] = Query(None, description="Filter by dimension ID"),
    session: Session = Depends(get_db)
):
    """List all categories, optionally filtered by dimension."""
    query = select(Category).order_by(Category.dimension_id, Category.ordinal, Category.label)
    
    if dimension_id:
        query = query.where(Category.dimension_id == dimension_id)
    
    categories = session.exec(query).all()
    
    # Get dimensions for labels
    dimension_ids = list(set(c.dimension_id for c in categories))
    dimensions = {d.id: d for d in session.exec(
        select(Dimension).where(Dimension.id.in_(dimension_ids))
    ).all()} if dimension_ids else {}
    
    # Get asset counts per category
    count_results = session.exec(
        select(AssetCategory.category_id, func.count(AssetCategory.asset_id))
        .group_by(AssetCategory.category_id)
    ).all()
    asset_counts = {row[0]: row[1] for row in count_results}
    
    return [
        _build_category_response(c, dimensions.get(c.dimension_id), asset_counts.get(c.id, 0))
        for c in categories
        if c.dimension_id in dimensions
    ]


@router.get("/by-dimension", response_model=List[DimensionWithCategoriesResponse])
def list_categories_by_dimension(session: Session = Depends(get_db)):
    """List all categories grouped by dimension."""
    # Get all dimensions
    dimensions = session.exec(
        select(Dimension).order_by(Dimension.ordinal, Dimension.label)
    ).all()
    
    # Get all categories
    categories = session.exec(
        select(Category).order_by(Category.dimension_id, Category.ordinal, Category.label)
    ).all()
    
    # Get asset counts per category
    count_results = session.exec(
        select(AssetCategory.category_id, func.count(AssetCategory.asset_id))
        .group_by(AssetCategory.category_id)
    ).all()
    asset_counts = {row[0]: row[1] for row in count_results}
    
    # Group categories by dimension
    categories_by_dim = {}
    for cat in categories:
        if cat.dimension_id not in categories_by_dim:
            categories_by_dim[cat.dimension_id] = []
        categories_by_dim[cat.dimension_id].append(cat)
    
    return [
        DimensionWithCategoriesResponse(
            id=dim.id,
            label=dim.label,
            ordinal=dim.ordinal,
            categories=[
                _build_category_response(c, dim, asset_counts.get(c.id, 0))
                for c in categories_by_dim.get(dim.id, [])
            ]
        )
        for dim in dimensions
    ]


@router.get("/{category_id}", response_model=CategoryResponse)
def get_category(category_id: int, session: Session = Depends(get_db)):
    """Get a specific category by ID."""
    category = session.get(Category, category_id)
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")
    
    dimension = session.get(Dimension, category.dimension_id)
    
    # Get asset count
    count = session.exec(
        select(func.count(AssetCategory.asset_id))
        .where(AssetCategory.category_id == category_id)
    ).one()
    
    return _build_category_response(category, dimension, count)


@router.get("/{category_id}/assets", response_model=CategoryAssetsResponse)
def get_category_assets(category_id: int, session: Session = Depends(get_db)):
    """Get all assets linked to a category."""
    category = session.get(Category, category_id)
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")
    
    dimension = session.get(Dimension, category.dimension_id)
    
    assets = session.exec(
        select(Asset)
        .join(AssetCategory, AssetCategory.asset_id == Asset.asset_id)
        .where(AssetCategory.category_id == category_id)
        .order_by(Asset.symbol)
    ).all()
    
    return CategoryAssetsResponse(
        category_id=category_id,
        category_label=category.label,
        dimension_id=category.dimension_id,
        dimension_label=dimension.label,
        assets=[LinkedAssetResponse(asset_id=a.asset_id, symbol=a.symbol, label=a.label) for a in assets],
        count=len(assets)
    )


@router.post("", response_model=CategoryResponse, status_code=201)
def create_category(data: CategoryCreate, session: Session = Depends(get_db)):
    """Create a new category within a dimension."""
    # Check dimension exists
    dimension = session.get(Dimension, data.dimension_id)
    if not dimension:
        raise HTTPException(status_code=404, detail="Dimension not found")
    
    # Check for duplicate label in same dimension
    existing = session.exec(
        select(Category).where(
            Category.dimension_id == data.dimension_id,
            Category.label == data.label
        )
    ).first()
    
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Category '{data.label}' already exists in dimension '{dimension.label}'"
        )
    
    category = Category(
        dimension_id=data.dimension_id,
        label=data.label,
        color=data.color,
        ordinal=data.ordinal
    )
    
    session.add(category)
    session.commit()
    session.refresh(category)
    
    return _build_category_response(category, dimension, 0)


@router.put("/{category_id}", response_model=CategoryResponse)
def update_category(
    category_id: int,
    data: CategoryUpdate,
    session: Session = Depends(get_db)
):
    """Update an existing category."""
    category = session.get(Category, category_id)
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")
    
    dimension = session.get(Dimension, category.dimension_id)
    
    if data.label is not None:
        # Check for duplicate label in same dimension
        existing = session.exec(
            select(Category).where(
                Category.dimension_id == category.dimension_id,
                Category.label == data.label,
                Category.id != category_id
            )
        ).first()
        if existing:
            raise HTTPException(
                status_code=400,
                detail=f"Category '{data.label}' already exists in dimension '{dimension.label}'"
            )
        category.label = data.label
    
    if data.color is not None:
        category.color = data.color
    if data.ordinal is not None:
        category.ordinal = data.ordinal
    
    session.add(category)
    session.commit()
    session.refresh(category)
    
    # Get asset count
    count = session.exec(
        select(func.count(AssetCategory.asset_id))
        .where(AssetCategory.category_id == category_id)
    ).one()
    
    return _build_category_response(category, dimension, count)


@router.delete("/{category_id}", status_code=204)
def delete_category(category_id: int, session: Session = Depends(get_db)):
    """Delete a category and all its asset associations."""
    category = session.get(Category, category_id)
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")
    
    # Remove asset associations
    for ac in session.exec(select(AssetCategory).where(AssetCategory.category_id == category_id)).all():
        session.delete(ac)
    
    session.delete(category)
    session.commit()
    
    return None


@router.delete("/{category_id}/assets/{asset_id}", status_code=200)
def unlink_asset_from_category(
    category_id: int, 
    asset_id: int, 
    session: Session = Depends(get_db)
):
    """Remove an asset from a category (unlink)."""
    ac = session.exec(
        select(AssetCategory).where(
            AssetCategory.asset_id == asset_id,
            AssetCategory.category_id == category_id
        )
    ).first()
    
    if not ac:
        raise HTTPException(status_code=404, detail="Asset-category link not found")
    
    session.delete(ac)
    session.commit()
    
    return {"message": "Asset unlinked from category"}


# ============================================================================
# Asset-Category Assignment Endpoints
# ============================================================================


@router.get("/asset/{asset_id}", response_model=AssetCategoriesResponse)
def get_asset_categories(asset_id: int, session: Session = Depends(get_db)):
    """Get all categories assigned to an asset."""
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    
    categories = session.exec(
        select(Category)
        .join(AssetCategory, AssetCategory.category_id == Category.id)
        .where(AssetCategory.asset_id == asset_id)
        .order_by(Category.dimension_id, Category.ordinal)
    ).all()
    
    # Get dimensions for labels
    dimension_ids = list(set(c.dimension_id for c in categories))
    dimensions = {d.id: d for d in session.exec(
        select(Dimension).where(Dimension.id.in_(dimension_ids))
    ).all()} if dimension_ids else {}
    
    # Get asset counts per category
    count_results = session.exec(
        select(AssetCategory.category_id, func.count(AssetCategory.asset_id))
        .where(AssetCategory.category_id.in_([c.id for c in categories]))
        .group_by(AssetCategory.category_id)
    ).all() if categories else []
    asset_counts = {row[0]: row[1] for row in count_results}
    
    return AssetCategoriesResponse(
        asset_id=asset_id,
        categories=[
            _build_category_response(c, dimensions.get(c.dimension_id), asset_counts.get(c.id, 0))
            for c in categories
            if c.dimension_id in dimensions
        ]
    )


@router.put("/asset/{asset_id}", response_model=AssetCategoriesResponse)
def set_asset_categories(
    asset_id: int,
    data: AssetCategoryAssignment,
    session: Session = Depends(get_db)
):
    """Set categories for an asset (replaces existing assignments)."""
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    
    # Validate all category IDs exist
    for cat_id in data.category_ids:
        if not session.get(Category, cat_id):
            raise HTTPException(status_code=400, detail=f"Category with id {cat_id} not found")
    
    # Remove existing assignments
    existing = session.exec(
        select(AssetCategory).where(AssetCategory.asset_id == asset_id)
    ).all()
    for ac in existing:
        session.delete(ac)
    
    # Add new assignments
    for cat_id in data.category_ids:
        ac = AssetCategory(asset_id=asset_id, category_id=cat_id)
        session.add(ac)
    
    session.commit()
    
    # Return updated categories
    return get_asset_categories(asset_id, session)


@router.post("/asset/{asset_id}/add/{category_id}", response_model=AssetCategoriesResponse)
def add_category_to_asset(
    asset_id: int,
    category_id: int,
    session: Session = Depends(get_db)
):
    """Add a single category to an asset."""
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    
    category = session.get(Category, category_id)
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")
    
    # Check if already assigned
    existing = session.exec(
        select(AssetCategory).where(
            AssetCategory.asset_id == asset_id,
            AssetCategory.category_id == category_id
        )
    ).first()
    
    if not existing:
        ac = AssetCategory(asset_id=asset_id, category_id=category_id)
        session.add(ac)
        session.commit()
    
    return get_asset_categories(asset_id, session)


@router.delete("/asset/{asset_id}/remove/{category_id}", response_model=AssetCategoriesResponse)
def remove_category_from_asset(
    asset_id: int,
    category_id: int,
    session: Session = Depends(get_db)
):
    """Remove a single category from an asset."""
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    
    ac = session.exec(
        select(AssetCategory).where(
            AssetCategory.asset_id == asset_id,
            AssetCategory.category_id == category_id
        )
    ).first()
    
    if ac:
        session.delete(ac)
        session.commit()
    
    return get_asset_categories(asset_id, session)
