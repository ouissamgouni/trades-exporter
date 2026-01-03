"""
Category endpoints for the Trade Exporter API.
Provides CRUD operations for asset categories used in reporting.
"""

from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, select

from backend.db.database import get_db
from backend.db.models import Category, AssetCategory, Asset


router = APIRouter(prefix="/categories", tags=["Categories"])


# ============================================================================
# Pydantic Models
# ============================================================================


class CategoryCreate(BaseModel):
    """Request model for creating a category."""
    dimension: str
    dimension_label: Optional[str] = None  # Display name like "Asset Class"
    key: str
    label: str
    parent_id: Optional[int] = None
    color: Optional[str] = None
    ordinal: int = 0


class CategoryUpdate(BaseModel):
    """Request model for updating a category."""
    dimension_label: Optional[str] = None  # Update dimension display name
    label: Optional[str] = None
    parent_id: Optional[int] = None
    color: Optional[str] = None
    ordinal: Optional[int] = None


class CategoryResponse(BaseModel):
    """Response model for a category."""
    id: int
    dimension: str
    dimension_label: Optional[str] = None  # "Asset Class", "Sector", etc.
    key: str
    label: str
    parent_id: Optional[int]
    color: Optional[str]
    ordinal: int
    
    class Config:
        from_attributes = True


class CategoryWithChildren(CategoryResponse):
    """Category with nested children for hierarchy display."""
    children: List["CategoryWithChildren"] = []


class DimensionResponse(BaseModel):
    """Response model for a dimension with its categories."""
    dimension: str
    dimension_label: str  # "Asset Class", "Sector", etc.
    categories: List[CategoryResponse]


class AssetCategoryAssignment(BaseModel):
    """Request model for assigning categories to an asset."""
    category_ids: List[int]


class AssetCategoriesResponse(BaseModel):
    """Response model for asset's categories."""
    asset_id: int
    categories: List[CategoryResponse]


# ============================================================================
# Category CRUD Endpoints
# ============================================================================


@router.get("", response_model=List[CategoryResponse])
def list_categories(
    dimension: Optional[str] = Query(None, description="Filter by dimension"),
    session: Session = Depends(get_db)
):
    """
    List all categories, optionally filtered by dimension.
    
    Args:
        dimension: Optional filter (e.g., "sector", "asset_class", "region")
    """
    query = select(Category).order_by(Category.dimension, Category.ordinal, Category.label)
    
    if dimension:
        query = query.where(Category.dimension == dimension)
    
    categories = session.exec(query).all()
    return categories


@router.get("/dimensions", response_model=List[DimensionResponse])
def list_dimensions(session: Session = Depends(get_db)):
    """
    List all unique dimensions with their labels.
    
    Returns dimensions with info like: [{"dimension": "asset_class", "dimension_label": "Asset Class", "categories": []}]
    """
    # Get all categories to extract unique dimensions with labels
    categories = session.exec(
        select(Category).order_by(Category.dimension)
    ).all()
    
    dimensions_map: dict[str, str] = {}
    for cat in categories:
        if cat.dimension not in dimensions_map:
            dimensions_map[cat.dimension] = cat.dimension_label or cat.dimension.replace('_', ' ').title()
    
    return [
        DimensionResponse(dimension=dim, dimension_label=label, categories=[])
        for dim, label in sorted(dimensions_map.items())
    ]


class DimensionCreate(BaseModel):
    """Request model for creating a dimension."""
    dimension: str  # Key like "asset_class"
    dimension_label: str  # Display like "Asset Class"


class DimensionUpdate(BaseModel):
    """Request model for updating a dimension."""
    dimension_label: str  # New display name


@router.post("/dimensions", response_model=DimensionResponse, status_code=201)
def create_dimension(data: DimensionCreate, session: Session = Depends(get_db)):
    """
    Create a new dimension by creating a placeholder category.
    
    The dimension will appear in the UI even without categories.
    """
    # Check if dimension already exists
    existing = session.exec(
        select(Category).where(Category.dimension == data.dimension)
    ).first()
    
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Dimension '{data.dimension}' already exists"
        )
    
    # Create a placeholder category to establish the dimension
    # This will be the first category users can then add values to
    category = Category(
        dimension=data.dimension,
        dimension_label=data.dimension_label,
        key="_placeholder",
        label="(Add values to this dimension)",
        ordinal=-1,  # Will be at the top
    )
    
    session.add(category)
    session.commit()
    
    return DimensionResponse(
        dimension=data.dimension,
        dimension_label=data.dimension_label,
        categories=[]
    )


@router.put("/dimensions/{dimension}", response_model=DimensionResponse)
def update_dimension(dimension: str, data: DimensionUpdate, session: Session = Depends(get_db)):
    """
    Update a dimension's label.
    
    This updates the dimension_label for all categories in this dimension.
    """
    categories = session.exec(
        select(Category).where(Category.dimension == dimension)
    ).all()
    
    if not categories:
        raise HTTPException(status_code=404, detail=f"Dimension '{dimension}' not found")
    
    for cat in categories:
        cat.dimension_label = data.dimension_label
        session.add(cat)
    
    session.commit()
    
    return DimensionResponse(
        dimension=dimension,
        dimension_label=data.dimension_label,
        categories=[CategoryResponse.model_validate(c) for c in categories]
    )


@router.delete("/dimensions/{dimension}")
def delete_dimension(dimension: str, session: Session = Depends(get_db)):
    """
    Delete a dimension and all its categories.
    
    This also removes all asset-category associations for this dimension.
    """
    categories = session.exec(
        select(Category).where(Category.dimension == dimension)
    ).all()
    
    if not categories:
        raise HTTPException(status_code=404, detail=f"Dimension '{dimension}' not found")
    
    # Delete asset-category associations first
    category_ids = [c.id for c in categories]
    for cat_id in category_ids:
        session.exec(
            select(AssetCategory).where(AssetCategory.category_id == cat_id)
        )
        # Delete associations
        assocs = session.exec(
            select(AssetCategory).where(AssetCategory.category_id == cat_id)
        ).all()
        for assoc in assocs:
            session.delete(assoc)
    
    # Delete categories
    for cat in categories:
        session.delete(cat)
    
    session.commit()
    
    return {"message": f"Dimension '{dimension}' and {len(categories)} categories deleted"}


@router.get("/by-dimension", response_model=List[DimensionResponse])
def list_categories_by_dimension(session: Session = Depends(get_db)):
    """
    List all categories grouped by dimension.
    
    Returns a list of dimensions, each with its categories.
    """
    # Get all categories ordered
    categories = session.exec(
        select(Category).order_by(Category.dimension, Category.ordinal, Category.label)
    ).all()
    
    # Group by dimension
    dimensions_map: dict[str, dict] = {}
    for cat in categories:
        if cat.dimension not in dimensions_map:
            # Get dimension_label from first category or generate from dimension
            dim_label = cat.dimension_label or cat.dimension.replace('_', ' ').title()
            dimensions_map[cat.dimension] = {
                'dimension_label': dim_label,
                'categories': []
            }
        dimensions_map[cat.dimension]['categories'].append(CategoryResponse.model_validate(cat))
    
    return [
        DimensionResponse(
            dimension=dim, 
            dimension_label=data['dimension_label'],
            categories=data['categories']
        )
        for dim, data in sorted(dimensions_map.items())
    ]


@router.get("/hierarchy", response_model=List[DimensionResponse])
def list_categories_hierarchy(session: Session = Depends(get_db)):
    """
    List categories with hierarchy (parent-child relationships).
    
    Categories with parent_id are nested under their parent.
    """
    categories = session.exec(
        select(Category).order_by(Category.dimension, Category.ordinal, Category.label)
    ).all()
    
    # Build hierarchy per dimension
    def build_tree(cats: List[Category], parent_id: Optional[int] = None) -> List[CategoryWithChildren]:
        result = []
        for cat in cats:
            if cat.parent_id == parent_id:
                children = build_tree(cats, cat.id)
                result.append(CategoryWithChildren(
                    id=cat.id,
                    dimension=cat.dimension,
                    key=cat.key,
                    label=cat.label,
                    parent_id=cat.parent_id,
                    color=cat.color,
                    ordinal=cat.ordinal,
                    children=children
                ))
        return result
    
    # Group by dimension first
    dimensions_map: dict[str, List[Category]] = {}
    for cat in categories:
        if cat.dimension not in dimensions_map:
            dimensions_map[cat.dimension] = []
        dimensions_map[cat.dimension].append(cat)
    
    # Build hierarchy for each dimension
    result = []
    for dim, cats in sorted(dimensions_map.items()):
        tree = build_tree(cats, None)
        # Flatten for response (hierarchy is shown via parent_id)
        flat_cats = [CategoryResponse.model_validate(c) for c in cats]
        # Get dimension_label from first category
        dim_label = cats[0].dimension_label if cats else dim.replace('_', ' ').title()
        result.append(DimensionResponse(dimension=dim, dimension_label=dim_label, categories=flat_cats))
    
    return result


@router.get("/{category_id}", response_model=CategoryResponse)
def get_category(category_id: int, session: Session = Depends(get_db)):
    """Get a specific category by ID."""
    category = session.get(Category, category_id)
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")
    return category


@router.post("", response_model=CategoryResponse, status_code=201)
def create_category(data: CategoryCreate, session: Session = Depends(get_db)):
    """
    Create a new category.
    
    The combination of (dimension, key) must be unique.
    """
    # Check for duplicate
    existing = session.exec(
        select(Category).where(
            Category.dimension == data.dimension,
            Category.key == data.key
        )
    ).first()
    
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Category with dimension '{data.dimension}' and key '{data.key}' already exists"
        )
    
    # Validate parent if provided
    if data.parent_id:
        parent = session.get(Category, data.parent_id)
        if not parent:
            raise HTTPException(status_code=400, detail="Parent category not found")
        if parent.dimension != data.dimension:
            raise HTTPException(
                status_code=400,
                detail="Parent must be in the same dimension"
            )
    
    # Get dimension_label from existing categories in same dimension, or use provided value
    dimension_label = data.dimension_label
    if not dimension_label:
        existing_in_dim = session.exec(
            select(Category).where(Category.dimension == data.dimension).limit(1)
        ).first()
        if existing_in_dim and existing_in_dim.dimension_label:
            dimension_label = existing_in_dim.dimension_label
        else:
            dimension_label = data.dimension.replace('_', ' ').title()
    
    category = Category(
        dimension=data.dimension,
        dimension_label=dimension_label,
        key=data.key,
        label=data.label,
        parent_id=data.parent_id,
        color=data.color,
        ordinal=data.ordinal
    )
    
    session.add(category)
    session.commit()
    session.refresh(category)
    
    return category


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
    
    # Validate parent if changing
    if data.parent_id is not None:
        if data.parent_id == category_id:
            raise HTTPException(status_code=400, detail="Category cannot be its own parent")
        if data.parent_id != 0:  # 0 means remove parent
            parent = session.get(Category, data.parent_id)
            if not parent:
                raise HTTPException(status_code=400, detail="Parent category not found")
            if parent.dimension != category.dimension:
                raise HTTPException(
                    status_code=400,
                    detail="Parent must be in the same dimension"
                )
    
    # Apply updates
    if data.dimension_label is not None:
        # Update dimension_label for all categories in this dimension
        for cat in session.exec(select(Category).where(Category.dimension == category.dimension)).all():
            cat.dimension_label = data.dimension_label
            session.add(cat)
    if data.label is not None:
        category.label = data.label
    if data.parent_id is not None:
        category.parent_id = data.parent_id if data.parent_id != 0 else None
    if data.color is not None:
        category.color = data.color
    if data.ordinal is not None:
        category.ordinal = data.ordinal
    
    session.add(category)
    session.commit()
    session.refresh(category)
    
    return category


@router.delete("/{category_id}", status_code=204)
def delete_category(category_id: int, session: Session = Depends(get_db)):
    """
    Delete a category.
    
    Will also remove all asset-category associations.
    Children categories will be orphaned (parent_id set to NULL).
    """
    category = session.get(Category, category_id)
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")
    
    # Remove asset associations
    session.exec(
        select(AssetCategory).where(AssetCategory.category_id == category_id)
    )
    for ac in session.exec(select(AssetCategory).where(AssetCategory.category_id == category_id)).all():
        session.delete(ac)
    
    # Orphan children (set parent_id to NULL)
    for child in session.exec(select(Category).where(Category.parent_id == category_id)).all():
        child.parent_id = None
        session.add(child)
    
    session.delete(category)
    session.commit()
    
    return None


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
        .order_by(Category.dimension, Category.ordinal)
    ).all()
    
    return AssetCategoriesResponse(
        asset_id=asset_id,
        categories=[CategoryResponse.model_validate(c) for c in categories]
    )


@router.put("/asset/{asset_id}", response_model=AssetCategoriesResponse)
def set_asset_categories(
    asset_id: int,
    data: AssetCategoryAssignment,
    session: Session = Depends(get_db)
):
    """
    Set categories for an asset (replaces existing assignments).
    
    Pass an array of category_ids to assign to the asset.
    """
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    
    # Validate all category IDs exist
    for cat_id in data.category_ids:
        if not session.get(Category, cat_id):
            raise HTTPException(
                status_code=400,
                detail=f"Category with id {cat_id} not found"
            )
    
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
    categories = session.exec(
        select(Category)
        .join(AssetCategory, AssetCategory.category_id == Category.id)
        .where(AssetCategory.asset_id == asset_id)
        .order_by(Category.dimension, Category.ordinal)
    ).all()
    
    return AssetCategoriesResponse(
        asset_id=asset_id,
        categories=[CategoryResponse.model_validate(c) for c in categories]
    )


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
    
    # Return updated categories
    categories = session.exec(
        select(Category)
        .join(AssetCategory, AssetCategory.category_id == Category.id)
        .where(AssetCategory.asset_id == asset_id)
        .order_by(Category.dimension, Category.ordinal)
    ).all()
    
    return AssetCategoriesResponse(
        asset_id=asset_id,
        categories=[CategoryResponse.model_validate(c) for c in categories]
    )


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
    
    # Find and remove assignment
    ac = session.exec(
        select(AssetCategory).where(
            AssetCategory.asset_id == asset_id,
            AssetCategory.category_id == category_id
        )
    ).first()
    
    if ac:
        session.delete(ac)
        session.commit()
    
    # Return updated categories
    categories = session.exec(
        select(Category)
        .join(AssetCategory, AssetCategory.category_id == Category.id)
        .where(AssetCategory.asset_id == asset_id)
        .order_by(Category.dimension, Category.ordinal)
    ).all()
    
    return AssetCategoriesResponse(
        asset_id=asset_id,
        categories=[CategoryResponse.model_validate(c) for c in categories]
    )
