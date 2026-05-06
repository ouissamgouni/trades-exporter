"""
Transaction endpoints for the Trade Exporter API.
"""

import uuid
import time
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Query, Body, Depends
from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field
from sqlmodel import Session, select
from sqlalchemy import func, or_, literal_column, update
from sqlalchemy.sql.functions import count as sa_count
from sqlalchemy import distinct
from sqlalchemy.orm import joinedload
from sqlalchemy.exc import OperationalError

from backend.api.schemas import (
    TransactionResponse, 
    TransactionUpdate, 
    AssetRef,
    TransactionListResponse,
    FilterMetadata,
    AppliedFilters,
    ValidationWarning,
)
from backend.db.database import get_db
from backend.db.models import (
    NormalizedTransaction,
    Asset,
    CalculationUnit,
    Account,
    RawAccount,
    ReviewStatus,
    TaxabilityStatus,
    Direction,
    TransactionType,
    PnlWarning,
    CostLot,
    CalculationUnitLeg,
    RealizedPnl,
    LotSettlement,
    CostLotEvent,
    ConsumedLotSlice,
    SyncJobConnectorRun,
    TransactionTaxOverride,
)
from backend.services.pipeline import (
    create_default_pipeline,
    PipelineContext,
)

router = APIRouter(prefix="/transactions", tags=["Transactions"])


# ============================================================================
# Bulk Operation Models
# ============================================================================


class BulkUpdateRequest(BaseModel):
    """Request model for bulk updating transactions."""

    transaction_ids: List[int] = Field(..., description="IDs of transactions to update")
    review_status: Optional[ReviewStatus] = Field(
        None, description="New review status"
    )
    transaction_type: Optional[str] = Field(None, description="New transaction type")
    taxability_status: Optional[TaxabilityStatus] = Field(
        None, description="New taxability status"
    )
    include_fee: Optional[bool] = Field(
        None, description="Include fee in cost basis/proceeds"
    )
    clear_from_account: Optional[bool] = Field(
        None, description="Clear from_account_id (set to null)"
    )
    clear_to_account: Optional[bool] = Field(
        None, description="Clear to_account_id (set to null)"
    )


class BulkStatusUpdate(BaseModel):
    """Request model for bulk review status update."""

    transaction_ids: List[int] = Field(..., description="IDs of transactions to update")
    review_status: ReviewStatus = Field(
        ..., description="New review status"
    )
    taxability_status: Optional[TaxabilityStatus] = Field(
        None,
        description="New taxability status",
    )


class BulkDeleteRequest(BaseModel):
    """Request model for bulk deleting transactions."""

    transaction_ids: List[int] = Field(..., description="IDs of transactions to delete")


class BulkAddToUnitRequest(BaseModel):
    """Request model for adding transactions to a unit."""

    transaction_ids: List[int] = Field(..., description="IDs of transactions to add")
    unit_id: Optional[int] = Field(None, description="Existing unit ID (optional)")
    unit_label: Optional[str] = Field(
        None, description="New unit label (creates new unit if unit_id not provided)"
    )


class BulkOperationResponse(BaseModel):
    """Response model for bulk operations."""

    success: bool
    affected_count: int
    message: str
    errors: List[str] = []


class TransactionCreate(BaseModel):
    """Request model for creating a manual transaction."""

    date_time: str = Field(..., description="Transaction datetime (ISO format)")
    direction: Direction = Field(
        ..., description="Transaction direction"
    )
    transaction_type: str = Field(
        ...,
        description="Transaction type (predefined or custom)",
    )
    quantity: float = Field(..., gt=0, description="Transaction quantity")

    # Required asset links
    asset_id: int = Field(..., description="Linked asset ID (required)")
    price_quote_asset_id: int = Field(
        ..., description="Linked price quote asset ID (required)"
    )
    fee_quote_asset_id: int = Field(
        ..., description="Linked fee quote asset ID (required)"
    )

    # Optional fields
    source: Optional[str] = Field(
        None, description="Source identifier (e.g., manual, binance-transactions)"
    )
    source_transaction_type: Optional[str] = Field(
        None, description="Source transaction type"
    )
    account_id: Optional[int] = Field(
        None, description="Account ID for trades (exchange where trade occurred)"
    )
    from_account_id: Optional[int] = Field(
        None, description="From account ID for transfers"
    )
    to_account_id: Optional[int] = Field(
        None, description="To account ID for transfers"
    )
    source_asset_symbol: Optional[str] = Field(None, description="Asset symbol")
    price: Optional[float] = Field(None, ge=0, description="Price per unit")
    source_price_quote_asset_symbol: Optional[str] = Field(
        None, description="Price quote asset symbol"
    )
    total: Optional[float] = Field(None, ge=0, description="Total value")
    fee: Optional[float] = Field(None, ge=0, description="Fee amount")
    source_fee_quote_asset_symbol: Optional[str] = Field(
        None, description="Fee quote asset symbol"
    )
    include_fee: bool = Field(False, description="Include fee in cost basis/proceeds")
    source_from_account: Optional[str] = Field(
        None, description="Source account/address"
    )
    source_to_account: Optional[str] = Field(
        None, description="Destination account/address"
    )
    network: Optional[str] = Field(None, description="Network name")
    network_transaction_id: Optional[str] = Field(None, description="Network TX ID")
    token_contract_address: Optional[str] = Field(None, description="Token contract")
    review_status: ReviewStatus = Field(
        ReviewStatus.PENDING,
        description="Review status",
    )
    review_notes: Optional[str] = Field(None, description="Notes")
    taxability_status: Optional[str] = Field(
        "unknown", description="Taxability status (taxable, non_taxable, unknown)"
    )
    tags: Optional[List[Dict[str, Any]]] = Field(
        None, description="Tags as list of {key: value} pairs"
    )


def _serialize_datetime(value):
    """Convert datetime to ISO string with UTC timezone marker if needed."""
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return value


def _build_transaction_response(
    tx: NormalizedTransaction, session: Session, fr_override_tx_ids: Optional[set] = None,
) -> TransactionResponse:
    """
    Build a TransactionResponse from a NormalizedTransaction.

    Resolves asset IDs to nested AssetRef objects for linked_asset, price_quote_asset, fee_quote_asset.
    Resolves account IDs to names for the account_name, from_account_name, to_account_name fields.
    Also maintains backward-compatible flat symbol fields.
    """
    # Build nested AssetRef objects
    linked_asset = AssetRef(
        asset_id=tx.asset.asset_id,
        symbol=tx.asset.symbol,
        label=tx.asset.label
    ) if tx.asset else None
    
    price_quote_asset = AssetRef(
        asset_id=tx.price_quote_asset.asset_id,
        symbol=tx.price_quote_asset.symbol,
        label=tx.price_quote_asset.label
    ) if tx.price_quote_asset else None
    
    fee_quote_asset = AssetRef(
        asset_id=tx.fee_quote_asset.asset_id,
        symbol=tx.fee_quote_asset.symbol,
        label=tx.fee_quote_asset.label
    ) if tx.fee_quote_asset else None

    attributed_asset = AssetRef(
        asset_id=tx.attributed_asset.asset_id,
        symbol=tx.attributed_asset.symbol,
        label=tx.attributed_asset.label
    ) if tx.attributed_asset else None

    # Backward-compatible flat symbol fields
    linked_asset_symbol = tx.asset.symbol if tx.asset else None
    linked_price_quote_symbol = tx.price_quote_asset.symbol if tx.price_quote_asset else None
    linked_fee_quote_symbol = tx.fee_quote_asset.symbol if tx.fee_quote_asset else None

    # Resolve account names server-side
    account_name = tx.account_rel.name if tx.account_rel else None
    from_account_name = tx.from_account.name if tx.from_account else None
    to_account_name = tx.to_account.name if tx.to_account else None
    
    # Extract connector run metadata
    connector_name = None
    run_datetime = None
    if tx.sync_connector_run:
        connector_name = tx.sync_connector_run.connector_type
        run_datetime = tx.sync_connector_run.started_at

    # Normalize tags field - get directly from model without model_dump() to avoid list->dict conversion
    tags = tx.tags
    normalized_tags = []
    if tags is None:
        normalized_tags = []
    elif isinstance(tags, dict):
        # Convert multi-key dict to separate single-key dicts
        # E.g., {'goal': 'test', 'expanded': True} -> [{'goal': 'test'}, {'expanded': True}]
        for key, value in tags.items():
            normalized_tags.append({key: value})
    elif isinstance(tags, list):
        # Ensure all items are dicts and split multi-key dicts into separate single-key dicts
        for tag in tags:
            if isinstance(tag, dict):
                # If tag has multiple keys, split it into separate single-key dicts
                if len(tag) > 1:
                    for key, value in tag.items():
                        normalized_tags.append({key: value})
                else:
                    # Already a single-key dict, keep as-is
                    normalized_tags.append(tag)
            elif isinstance(tag, str):
                # Legacy string format - convert to dict
                normalized_tags.append({"tag": tag})
    else:
        # Unknown format, set to empty list
        normalized_tags = []

    # Build response using model_dump() but override specific fields
    tx_dict = tx.model_dump()
    tx_dict["total"] = tx.total  # Computed property: price * quantity
    tx_dict["connector_name"] = connector_name
    tx_dict["run_datetime"] = _serialize_datetime(run_datetime)
    tx_dict["tags"] = normalized_tags  # Use pre-normalized tags
    tx_dict["synced_at"] = _serialize_datetime(tx_dict.get("synced_at"))
    
    # Nested asset references
    tx_dict["linked_asset"] = linked_asset
    tx_dict["price_quote_asset"] = price_quote_asset
    tx_dict["fee_quote_asset"] = fee_quote_asset
    tx_dict["attributed_asset"] = attributed_asset
    
    # Backward-compatible flat fields
    tx_dict["linked_asset_symbol"] = linked_asset_symbol
    tx_dict["linked_price_quote_asset_symbol"] = linked_price_quote_symbol
    tx_dict["linked_fee_quote_asset_symbol"] = linked_fee_quote_symbol
    
    tx_dict["account_name"] = account_name
    tx_dict["from_account_name"] = from_account_name
    tx_dict["to_account_name"] = to_account_name

    # FR tax override indicator
    if fr_override_tx_ids is not None:
        tx_dict["has_fr_tax_override"] = tx.id in fr_override_tx_ids
    else:
        # Single-transaction fetch: query directly
        has_override = session.exec(
            select(TransactionTaxOverride.transaction_id)
            .where(TransactionTaxOverride.transaction_id == tx.id)
            .where(TransactionTaxOverride.jurisdiction == "fr")
        ).first()
        tx_dict["has_fr_tax_override"] = has_override is not None

    return TransactionResponse(**tx_dict)


class FilterOption(BaseModel):
    """A single filter option with value and label."""
    value: str
    label: str
    count: Optional[int] = None


class CategoryOption(BaseModel):
    """Category option with dimension info."""
    value: str
    label: str
    dimension_id: int
    dimension_label: str


class DimensionWithCategories(BaseModel):
    """Dimension with its categories."""
    id: int
    label: str
    categories: List[CategoryOption]


class FilterOptionsResponse(BaseModel):
    """Response model for filter options endpoint."""
    sources: List[FilterOption]
    accounts: List[FilterOption]
    from_accounts: List[FilterOption]
    to_accounts: List[FilterOption]
    assets: List[FilterOption]
    categories: List[FilterOption]  # Flat list for backward compat
    categories_by_dimension: List[DimensionWithCategories]  # Grouped by dimension
    dimensions: List[FilterOption]
    transaction_types: List[FilterOption]
    directions: List[FilterOption]
    review_statuses: List[FilterOption]
    taxability_statuses: List[FilterOption]
    connector_runs: List[FilterOption]
    tags: List[FilterOption]
    networks: List[FilterOption]
    price_quote_assets: List[FilterOption] = []
    fee_quote_assets: List[FilterOption] = []
    attributed_assets: List[FilterOption] = []
    bundle_patterns: List[FilterOption] = []
    non_owned_count: int = 0
    include_fee_count: int = 0
    has_fee_count: int = 0
    has_bundle_count: int = 0
    total_count: int = 0


@router.get("/filter-options", response_model=FilterOptionsResponse)
def get_filter_options(
    # Accept filter parameters for context-aware counting
    review_status: Optional[str] = Query(None),
    taxability: Optional[str] = Query(None),
    source: Optional[str] = Query(None),
    account_id: Optional[str] = Query(None),
    from_account_id: Optional[str] = Query(None),
    to_account_id: Optional[str] = Query(None),
    related_account_id: Optional[str] = Query(None),
    asset_id: Optional[str] = Query(None),
    related_asset_id: Optional[str] = Query(None),
    category_id: Optional[str] = Query(None),
    transaction_type: Optional[str] = Query(None),
    direction: Optional[str] = Query(None),
    connector_run_id: Optional[str] = Query(None),
    tag_key: Optional[str] = Query(None),
    network: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    ids: Optional[str] = Query(None, description="Filter by transaction IDs (comma-separated)"),
    has_fee: Optional[bool] = Query(None, description="Filter by fee presence: true = fee > 0, false = no fee"),
    price_quote_asset_id: Optional[str] = Query(None),
    fee_quote_asset_id: Optional[str] = Query(None),
    attributed_asset_id: Optional[str] = Query(None),
    include_fee: Optional[bool] = Query(None),
    has_bundle: Optional[bool] = Query(None),
    bundle_pattern: Optional[str] = Query(None),
    session: Session = Depends(get_db)
):
    """
    Get all available filter options for the transactions table.
    
    Applies current filters to show contextual counts based on active filter state.
    Returns distinct values from the database for dynamic filter dropdowns.
    This ensures filters always show values that actually exist in the data.
    """
    from backend.db.models import Category, Dimension, AssetCategory
    from sqlalchemy import func, distinct, or_
    from datetime import datetime

    from backend.api.routes.filter_validator import validate_transaction_filters
    from backend.services.filters.transaction_filter import build_filtered_transaction_query

    # Re-use the shared validation + filter builder for the base CTE
    applied, _ = validate_transaction_filters(
        session=session,
        review_status=review_status,
        taxability=taxability,
        source=source,
        account_id=account_id,
        from_account_id=from_account_id,
        to_account_id=to_account_id,
        related_account_id=related_account_id,
        asset_id=asset_id,
        related_asset_id=related_asset_id,
        category_id=category_id,
        transaction_type=transaction_type,
        direction=direction,
        connector_run_id=connector_run_id,
        tag_key=tag_key,
        network=network,
        date_from=date_from,
        date_to=date_to,
        price_quote_asset_id=price_quote_asset_id,
        fee_quote_asset_id=fee_quote_asset_id,
        attributed_asset_id=attributed_asset_id,
        include_fee=include_fee,
        has_bundle=has_bundle,
        bundle_pattern=bundle_pattern,
    )

    try:
        # Build base CTE from the shared filter builder
        base_query = build_filtered_transaction_query(applied)

        # Apply extra filters not handled by the shared builder
        if ids:
            id_list = [int(i.strip()) for i in ids.split(',') if i.strip().isdigit()]
            if id_list:
                if len(id_list) == 1:
                    base_query = base_query.where(NormalizedTransaction.id == id_list[0])
                else:
                    base_query = base_query.where(NormalizedTransaction.id.in_(id_list))
        if has_fee is True:
            base_query = base_query.where(
                NormalizedTransaction.fee.isnot(None),
                NormalizedTransaction.fee > 0,
            )
        elif has_fee is False:
            base_query = base_query.where(
                or_(NormalizedTransaction.fee.is_(None), NormalizedTransaction.fee == 0)
            )

        base_cte = base_query.cte("filtered_txs")
        
        # Get distinct sources with counts (filtered)
        source_query = (
            select(
                NormalizedTransaction.source,
                func.count(base_cte.c.id).label('count')
            )
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .group_by(NormalizedTransaction.source)
            .order_by(NormalizedTransaction.source)
        )
        sources = session.exec(source_query).all()
        source_options = [
            FilterOption(value=s[0], label=s[0], count=s[1])
            for s in sources if s[0]
        ]
        
        # Get accounts with counts (filtered) + unmapped entry
        account_query = (
            select(
                Account.id,
                Account.name,
                func.count(base_cte.c.id).label('count')
            )
            .outerjoin(NormalizedTransaction, NormalizedTransaction.account_id == Account.id)
            .outerjoin(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .group_by(Account.id, Account.name)
            .order_by(Account.name)
        )
        accounts = session.exec(account_query).all()
        account_options = [
            FilterOption(value=str(a[0]), label=a[1], count=a[2] or 0)
            for a in accounts
        ]
        # Add "Undefined" entry for transactions with account_id IS NULL
        unmapped_account_count = session.exec(
            select(func.count(NormalizedTransaction.id))
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .where(NormalizedTransaction.account_id.is_(None))
        ).one()
        if unmapped_account_count > 0:
            account_options.append(
                FilterOption(value='undefined', label='\u2753 Undefined', count=unmapped_account_count)
            )
        
        # Get from_accounts with counts (filtered) + unmapped entry
        from_account_query = (
            select(
                Account.id,
                Account.name,
                func.count(base_cte.c.id).label('count')
            )
            .join(NormalizedTransaction, NormalizedTransaction.from_account_id == Account.id)
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .group_by(Account.id, Account.name)
            .order_by(Account.name)
        )
        from_accounts = session.exec(from_account_query).all()
        from_account_options = [
            FilterOption(value=str(a[0]), label=a[1], count=a[2] or 0)
            for a in from_accounts
        ]
        unmapped_from_count = session.exec(
            select(func.count(NormalizedTransaction.id))
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .where(NormalizedTransaction.from_account_id.is_(None))
        ).one()
        if unmapped_from_count > 0:
            from_account_options.insert(
                0, FilterOption(value='undefined', label='\u2753 Undefined', count=unmapped_from_count)
            )
        
        # Get to_accounts with counts (filtered) + unmapped entry
        to_account_query = (
            select(
                Account.id,
                Account.name,
                func.count(base_cte.c.id).label('count')
            )
            .join(NormalizedTransaction, NormalizedTransaction.to_account_id == Account.id)
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .group_by(Account.id, Account.name)
            .order_by(Account.name)
        )
        to_accounts = session.exec(to_account_query).all()
        to_account_options = [
            FilterOption(value=str(a[0]), label=a[1], count=a[2] or 0)
            for a in to_accounts
        ]
        unmapped_to_count = session.exec(
            select(func.count(NormalizedTransaction.id))
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .where(NormalizedTransaction.to_account_id.is_(None))
        ).one()
        if unmapped_to_count > 0:
            to_account_options.insert(
                0, FilterOption(value='undefined', label='\u2753 Undefined', count=unmapped_to_count)
            )
        
        # Get assets that have transactions (filtered)
        asset_query = (
            select(
                Asset.asset_id,
                Asset.symbol,
                Asset.label,
                func.count(base_cte.c.id).label('count')
            )
            .join(NormalizedTransaction, NormalizedTransaction.asset_id == Asset.asset_id)
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .group_by(Asset.asset_id, Asset.symbol, Asset.label)
            .order_by(Asset.symbol)
        )
        assets = session.exec(asset_query).all()
        asset_options = [
            FilterOption(
                value=str(a[0]),
                label=f"{a[1]}" + (f" ({a[2]})" if a[2] else ""),
                count=a[3]
            )
            for a in assets
        ]
        
        # Get categories with dimension info
        category_query = (
            select(Category, Dimension)
            .join(Dimension, Category.dimension_id == Dimension.id)
            .order_by(Dimension.ordinal, Category.label)
        )
        category_results = session.exec(category_query).all()
        
        # Flat list for backward compatibility
        category_options = [
            FilterOption(value=str(c.id), label=c.label)
            for c, d in category_results
        ]
        
        # Group categories by dimension
        dimensions_dict: Dict[int, DimensionWithCategories] = {}
        for cat, dim in category_results:
            if dim.id not in dimensions_dict:
                dimensions_dict[dim.id] = DimensionWithCategories(
                    id=dim.id,
                    label=dim.label,
                    categories=[]
                )
            dimensions_dict[dim.id].categories.append(
                CategoryOption(
                    value=str(cat.id),
                    label=cat.label,
                    dimension_id=dim.id,
                    dimension_label=dim.label
                )
            )
        categories_by_dimension = list(dimensions_dict.values())
        
        # Get dimensions
        dimension_query = select(Dimension).order_by(Dimension.ordinal)
        dimensions = session.exec(dimension_query).all()
        dimension_options = [
            FilterOption(value=str(d.id), label=d.label)
            for d in dimensions
        ]
        
        # Get transaction types with counts (filtered)
        type_query = (
            select(
                NormalizedTransaction.transaction_type,
                func.count(base_cte.c.id).label('count')
            )
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .group_by(NormalizedTransaction.transaction_type)
            .order_by(NormalizedTransaction.transaction_type)
        )
        types = session.exec(type_query).all()
        type_options = [
            FilterOption(value=t[0], label=t[0].title() if t[0] else 'Unknown', count=t[1])
            for t in types if t[0]
        ]
        
        # Get directions with counts (filtered)
        direction_query = (
            select(
                NormalizedTransaction.direction,
                func.count(base_cte.c.id).label('count')
            )
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .group_by(NormalizedTransaction.direction)
            .order_by(NormalizedTransaction.direction)
        )
        directions = session.exec(direction_query).all()
        direction_options = [
            FilterOption(value=d[0], label=d[0].title() if d[0] else 'Unknown', count=d[1])
            for d in directions if d[0]
        ]
        
        # Get review statuses with counts (filtered)
        review_status_query = (
            select(
                NormalizedTransaction.review_status,
                func.count(base_cte.c.id).label('count')
            )
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .group_by(NormalizedTransaction.review_status)
        )
        review_results = session.exec(review_status_query).all()
        review_status_counts = {r[0]: r[1] for r in review_results}
        
        review_status_options = [
            FilterOption(value='pending', label='Pending', count=review_status_counts.get('pending', 0)),
            FilterOption(value='valid', label='Valid', count=review_status_counts.get('valid', 0)),
            FilterOption(value='invalid', label='Invalid', count=review_status_counts.get('invalid', 0)),
        ]
        
        # Get taxability statuses with counts (filtered)
        taxability_query = (
            select(
                NormalizedTransaction.taxability_status,
                func.count(base_cte.c.id).label('count')
            )
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .group_by(NormalizedTransaction.taxability_status)
        )
        taxability_results = session.exec(taxability_query).all()
        taxability_counts = {t[0]: t[1] for t in taxability_results}
        
        taxability_options = [
            FilterOption(value='taxable', label='Taxable', count=taxability_counts.get('taxable', 0)),
            FilterOption(value='non_taxable', label='Non-Taxable', count=taxability_counts.get('non_taxable', 0)),
            FilterOption(value='unknown', label='Unknown', count=taxability_counts.get('unknown', 0)),
        ]
        
        # Get connector runs with counts (most recent first, filtered)
        connector_run_query = (
            select(
                SyncJobConnectorRun.id,
                SyncJobConnectorRun.connector_type,
                SyncJobConnectorRun.account_name,
                SyncJobConnectorRun.started_at,
                func.count(base_cte.c.id).label('count')
            )
            .outerjoin(NormalizedTransaction, NormalizedTransaction.sync_connector_run_id == SyncJobConnectorRun.id)
            .outerjoin(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .group_by(
                SyncJobConnectorRun.id,
                SyncJobConnectorRun.connector_type,
                SyncJobConnectorRun.account_name,
                SyncJobConnectorRun.started_at
            )
            .having(func.count(base_cte.c.id) > 0)
            .order_by(SyncJobConnectorRun.started_at.desc())
            .limit(50)
        )
        connector_runs = session.exec(connector_run_query).all()
        connector_run_options = [
            FilterOption(
                value=str(cr[0]),
                label=f"{cr[2] or 'Unknown'} {cr[1]} #{cr[0]} - ({cr[3].strftime('%m/%d %H:%M') if cr[3] else 'N/A'})",
                count=cr[4]
            )
            for cr in connector_runs
        ]
        
        # Get unique tag key:value pairs from filtered transactions
        try:
            tag_statement = (
                select(NormalizedTransaction.tags)
                .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
                .where(NormalizedTransaction.tags.isnot(None))
            )
            tag_results = session.exec(tag_statement).all()
            
            # Collect unique tag key:value pairs
            # Tags are stored as list of single-key dicts: [{key: value}, {key: value}]
            unique_tags = set()
            for tags in tag_results:
                if tags and isinstance(tags, list):
                    for tag in tags:
                        if isinstance(tag, dict):
                            for key, value in tag.items():
                                tag_str = f"{key}:{value}"
                                unique_tags.add(tag_str)
            
            tag_options = [
                FilterOption(
                    value=tag_str,
                    label=tag_str.replace('_', ' ').replace(':', ': ')
                )
                for tag_str in sorted(unique_tags) if tag_str
            ]
        except Exception as e:
            print(f"Error fetching tags: {e}")
            tag_options = []
        
        # Get distinct networks with counts (filtered)
        from backend.core.network_normalizer import get_network_display_name
        network_query = (
            select(
                NormalizedTransaction.network,
                func.count(base_cte.c.id).label('count')
            )
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .where(NormalizedTransaction.network.isnot(None))
            .where(NormalizedTransaction.network != '')
            .group_by(NormalizedTransaction.network)
            .order_by(NormalizedTransaction.network)
        )
        networks = session.exec(network_query).all()
        network_options = [
            FilterOption(
                value=n[0],
                label=get_network_display_name(n[0]),
                count=n[1]
            )
            for n in networks if n[0]
        ]
        
        # Non-owned count: transactions where from/to account is non-owned or NULL
        non_owned_subq = select(Account.id).where(Account.owned == False)  # noqa: E712
        non_owned_count = session.exec(
            select(func.count(distinct(NormalizedTransaction.id)))
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .where(
                or_(
                    NormalizedTransaction.from_account_id.in_(non_owned_subq),
                    NormalizedTransaction.to_account_id.in_(non_owned_subq),
                    NormalizedTransaction.from_account_id.is_(None),
                    NormalizedTransaction.to_account_id.is_(None),
                )
            )
        ).one() or 0

        # Price quote assets with counts
        from backend.db.models import UserCalculationBundle
        pqa_query = (
            select(
                Asset.asset_id,
                Asset.symbol,
                Asset.label,
                func.count(base_cte.c.id).label('count')
            )
            .join(NormalizedTransaction, NormalizedTransaction.price_quote_asset_id == Asset.asset_id)
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .group_by(Asset.asset_id, Asset.symbol, Asset.label)
            .order_by(Asset.symbol)
        )
        pqa_results = session.exec(pqa_query).all()
        price_quote_asset_options = [
            FilterOption(
                value=str(r[0]),
                label=f"{r[1]}" + (f" ({r[2]})" if r[2] else ""),
                count=r[3]
            )
            for r in pqa_results
        ]

        # Fee quote assets with counts
        fqa_query = (
            select(
                Asset.asset_id,
                Asset.symbol,
                Asset.label,
                func.count(base_cte.c.id).label('count')
            )
            .join(NormalizedTransaction, NormalizedTransaction.fee_quote_asset_id == Asset.asset_id)
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .group_by(Asset.asset_id, Asset.symbol, Asset.label)
            .order_by(Asset.symbol)
        )
        fqa_results = session.exec(fqa_query).all()
        fee_quote_asset_options = [
            FilterOption(
                value=str(r[0]),
                label=f"{r[1]}" + (f" ({r[2]})" if r[2] else ""),
                count=r[3]
            )
            for r in fqa_results
        ]

        # Attributed asset options
        attr_query = (
            select(
                Asset.asset_id,
                Asset.symbol,
                Asset.label,
                func.count(base_cte.c.id).label('count')
            )
            .join(NormalizedTransaction, NormalizedTransaction.attributed_asset_id == Asset.asset_id)
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .group_by(Asset.asset_id, Asset.symbol, Asset.label)
            .order_by(Asset.symbol)
        )
        attr_results = session.exec(attr_query).all()
        attributed_asset_options = [
            FilterOption(
                value=str(r[0]),
                label=f"{r[1]}" + (f" ({r[2]})" if r[2] else ""),
                count=r[3]
            )
            for r in attr_results
        ]

        # Bundle patterns with counts
        bundle_q = (
            select(
                UserCalculationBundle.pattern,
                func.count(base_cte.c.id).label('count')
            )
            .join(NormalizedTransaction, NormalizedTransaction.user_calculation_unit_id == UserCalculationBundle.id)
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .group_by(UserCalculationBundle.pattern)
            .order_by(UserCalculationBundle.pattern)
        )
        bundle_results = session.exec(bundle_q).all()
        bundle_pattern_options = [
            FilterOption(
                value=r[0],
                label=r[0].replace('_', ' ').title() if r[0] else 'Unknown',
                count=r[1]
            )
            for r in bundle_results if r[0]
        ]

        # Include fee count
        include_fee_count = session.exec(
            select(func.count(NormalizedTransaction.id))
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .where(NormalizedTransaction.include_fee == True)  # noqa: E712
        ).one() or 0

        # Has fee count (fee > 0)
        has_fee_count = session.exec(
            select(func.count(NormalizedTransaction.id))
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .where(NormalizedTransaction.fee.isnot(None))
            .where(NormalizedTransaction.fee > 0)
        ).one() or 0

        # Has bundle count
        has_bundle_count = session.exec(
            select(func.count(NormalizedTransaction.id))
            .join(base_cte, NormalizedTransaction.id == base_cte.c.id)
            .where(NormalizedTransaction.user_calculation_unit_id.isnot(None))
        ).one() or 0

        # Total count (for computing "no" counts on frontend)
        total_count = session.exec(
            select(func.count(base_cte.c.id))
        ).one() or 0

        return FilterOptionsResponse(
            sources=source_options,
            accounts=account_options,
            from_accounts=from_account_options,
            to_accounts=to_account_options,
            assets=asset_options,
            categories=category_options,
            categories_by_dimension=categories_by_dimension,
            dimensions=dimension_options,
            transaction_types=type_options,
            directions=direction_options,
            review_statuses=review_status_options,
            taxability_statuses=taxability_options,
            connector_runs=connector_run_options,
            tags=tag_options,
            networks=network_options,
            price_quote_assets=price_quote_asset_options,
            fee_quote_assets=fee_quote_asset_options,
            attributed_assets=attributed_asset_options,
            bundle_patterns=bundle_pattern_options,
            non_owned_count=non_owned_count,
            include_fee_count=include_fee_count,
            has_fee_count=has_fee_count,
            has_bundle_count=has_bundle_count,
            total_count=total_count,
        )
        
    except Exception as e:
        print(f"Error fetching filter options: {e}")
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


# =============================================================================
# Data Health Check Endpoint
# =============================================================================


from backend.api.schemas import (
    DataHealthCheckResponse, 
    RawAssetIssue, 
    RawAccountIssue, 
    SuggestionInfo,
    TransactionIssue,
    IssueType,
)
from backend.services.suggestion_service import SuggestionService
from backend.services.similarity_service import (
    get_best_asset_suggestion,
    get_best_account_suggestion,
)
from backend.db.models import RawAsset, RawAccount, Asset, Account


# =============================================================================
# DEPRECATED: Legacy unified endpoint - Use split endpoints instead
# - GET /transactions/data-health-check/status for counts
# - GET /transactions/data-health-check/linkage-issues for linkage issues
# - GET /transactions/data-health-check/transfer-issues for transfer issues
# =============================================================================

# @router.get("/data-health-check", response_model=DataHealthCheckResponse)
# def get_data_health_check(...):
#     # Legacy endpoint removed - use split endpoints above
#     pass


# =============================================================================
# New Data Health Check Endpoints (Split by Resource Type)
# =============================================================================

from backend.api.schemas import (
    TransactionStatusResponse,
    MissingDataIssuesResponse,
    LinkageIssuesResponse,
    TransferIssuesResponse,
    PaginationMetadata,
)


@router.get("/data-health-check/status", response_model=TransactionStatusResponse)
def get_transaction_status(
    account_ids: Optional[str] = Query(
        None,
        description="Optional comma-separated account IDs to filter scope"
    ),
    session: Session = Depends(get_db),
):
    """
    Get transaction status counts and data health metrics.
    
    Returns:
    - Transaction counts by review status (valid, pending, invalid, total)
    - Data quality issue counts (linkage, transfer, duplicates)
    - Bundle suggestions count
    - Aggregated total_issues and has_issues flags
    """
    try:
        # Parse account IDs filter if provided
        account_id_list: Optional[List[int]] = None
        if account_ids:
            account_id_list = [
                int(a.strip()) for a in account_ids.split(',') 
                if a.strip().isdigit()
            ]
        
        # Base query with optional account filter
        def base_filter(query):
            if account_id_list:
                return query.where(NormalizedTransaction.account_id.in_(account_id_list))
            return query
        
        # Total count (excluding invalid transactions)
        total_query = base_filter(
            select(func.count(NormalizedTransaction.id))
            .where(NormalizedTransaction.review_status != ReviewStatus.INVALID)
        )
        total_count = session.exec(total_query).one()
        
        # Count by review status
        valid_query = base_filter(
            select(func.count(NormalizedTransaction.id))
            .where(NormalizedTransaction.review_status == ReviewStatus.VALID)
        )
        valid_count = session.exec(valid_query).one()
        
        pending_query = base_filter(
            select(func.count(NormalizedTransaction.id))
            .where(NormalizedTransaction.review_status == ReviewStatus.PENDING)
        )
        pending_count = session.exec(pending_query).one()
        
        invalid_query = base_filter(
            select(func.count(NormalizedTransaction.id))
            .where(NormalizedTransaction.review_status == ReviewStatus.INVALID)
        )
        invalid_count = session.exec(invalid_query).one()
        
        # Get all data quality issue counts from IssueService
        from backend.services.data_health import IssueService
        issue_service = IssueService(session)
        counts = issue_service.get_counts(account_ids=account_id_list, include_dismissed=False)
        
        # Calculate aggregated totals
        total_issues = counts.total_issues
        has_issues = total_issues > 0 or counts.bundle_suggestions > 0
        
        return TransactionStatusResponse(
            total_count=total_count,
            valid_count=valid_count,
            pending_count=pending_count,
            invalid_count=invalid_count,
            bundle_suggestions_count=counts.bundle_suggestions,
            missing_data_issues_count=counts.missing_data_issues,
            linkage_issues_count=counts.linkage_issues,
            transfer_issues_count=counts.transfer_issues,
            duplicate_count=counts.duplicates,
            total_issues=total_issues,
            has_issues=has_issues,
        )
        
    except Exception as e:
        print(f"Error fetching transaction status: {e}")
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/data-health-check/missing-data-issues", response_model=MissingDataIssuesResponse)
def get_missing_data_issues(
    account_ids: Optional[str] = Query(
        None,
        description="Optional comma-separated account IDs to filter scope"
    ),
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(50, ge=1, le=200, description="Items per page"),
    session: Session = Depends(get_db),
):
    """
    Get paginated missing data issues (missing required source fields).
    
    Returns transactions with missing required source data that prevent proper processing.
    These are blocker issues that cannot be resolved through mappings alone.
    
    Issue types included:
    - missing_source: Transaction has no source field
    - missing_source_asset: No asset_id AND no source_asset_symbol
    - missing_source_account: No account_id AND no source_account
    """
    try:
        # Parse account IDs filter
        account_id_list: Optional[List[int]] = None
        if account_ids:
            account_id_list = [
                int(a.strip()) for a in account_ids.split(',') 
                if a.strip().isdigit()
            ]
        
        # Use IssueService to fetch missing data issues
        from backend.services.data_health import IssueService
        issue_service = IssueService(session)
        issues_list, total_count = issue_service.get_missing_data_issues(
            page=page,
            per_page=per_page,
            account_ids=account_id_list,
        )
        
        return MissingDataIssuesResponse(
            issues=issues_list,
            pagination=PaginationMetadata(
                page=page,
                per_page=per_page,
                total_count=total_count,
            ),
        )
        
    except Exception as e:
        print(f"Error fetching missing data issues: {e}")
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/data-health-check/linkage-issues", response_model=LinkageIssuesResponse)
def get_linkage_issues(
    account_ids: Optional[str] = Query(
        None,
        description="Optional comma-separated account IDs to filter scope"
    ),
    issue_types: Optional[str] = Query(
        None,
        description="Optional comma-separated issue types to include (e.g. unlinked_asset,unlinked_price_quote,unlinked_fee_quote)"
    ),
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(50, ge=1, le=200, description="Items per page"),
    session: Session = Depends(get_db),
):
    """
    Get paginated linkage issues (missing asset/account/price_quote/fee_quote mappings).
    
    Returns transactions missing required data mappings with fuzzy match suggestions
    for inline fixing.
    
    Issue types included:
    - asset: Missing asset_id mapping
    - account: Missing account_id mapping  
    - price_quote: Missing price_quote_asset_id mapping
    - fee_quote: Missing fee_quote_asset_id mapping
    """
    try:
        # Parse account IDs filter
        account_id_list: Optional[List[int]] = None
        if account_ids:
            account_id_list = [
                int(a.strip()) for a in account_ids.split(',') 
                if a.strip().isdigit()
            ]
        
        # Parse issue types filter
        issue_type_list: Optional[List[str]] = None
        if issue_types:
            issue_type_list = [t.strip() for t in issue_types.split(',') if t.strip()]
        
        # Use IssueService to fetch linkage issues
        from backend.services.data_health import IssueService
        issue_service = IssueService(session)
        issues_list, total_count = issue_service.get_linkage_issues(
            page=page,
            per_page=per_page,
            account_ids=account_id_list,
            issue_types=issue_type_list,
        )
        
        import math
        return LinkageIssuesResponse(
            issues=issues_list,
            pagination=PaginationMetadata(
                page=page,
                per_page=per_page,
                total_count=total_count,
                total_pages=math.ceil(total_count / per_page) if total_count > 0 else 1,
            ),
        )
        
    except Exception as e:
        print(f"Error fetching linkage issues: {e}")
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/data-health-check/transfer-issues", response_model=TransferIssuesResponse)
def get_transfer_issues(
    account_ids: Optional[str] = Query(
        None,
        description="Optional comma-separated account IDs to filter scope"
    ),
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(50, ge=1, le=200, description="Items per page"),
    include_dismissed: bool = Query(
        False,
        description="Include dismissed transfer issues"
    ),
    session: Session = Depends(get_db),
):
    """
    Get paginated transfer issues (missing from/to account mappings).
    
    Returns transfer transactions missing source_from_account (inflows) or
    source_to_account (outflows).
    
    Issue types included:
    - missing_transfer_from_account: Inflow transfers missing source_from_account
    - missing_transfer_to_account: Outflow transfers missing source_to_account  
    - unlinked_transfer_from_account: Inflow transfers with source_from_account but no from_account_id
    - unlinked_transfer_to_account: Outflow transfers with source_to_account but no to_account_id
    
    By default, dismissed issues are excluded. Use include_dismissed=true to show them.
    """
    try:
        # Parse account IDs filter
        account_id_list: Optional[List[int]] = None
        if account_ids:
            account_id_list = [
                int(a.strip()) for a in account_ids.split(',') 
                if a.strip().isdigit()
            ]
        
        # Use IssueService to fetch transfer issues
        from backend.services.data_health import IssueService
        issue_service = IssueService(session)
        issues_list, total_count = issue_service.get_transfer_issues(
            page=page,
            per_page=per_page,
            account_ids=account_id_list,
            include_dismissed=include_dismissed,
        )
        
        return TransferIssuesResponse(
            issues=issues_list,
            pagination=PaginationMetadata(
                page=page,
                per_page=per_page,
                total_count=total_count,
            ),
        )
        
    except Exception as e:
        print(f"Error fetching transfer issues: {e}")
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
        
        


# =============================================================================
# Transfer Issue Dismissal Endpoints
# =============================================================================


class DismissTransferIssueRequest(BaseModel):
    """Request model for dismissing a transfer issue."""
    field: str = Field(..., description="Field name: 'source_from_account' or 'source_to_account'")
    reason: Optional[str] = Field(None, description="Optional reason for dismissal")


class BulkDismissTransferIssuesRequest(BaseModel):
    """Request model for bulk dismissing transfer issues."""
    transaction_ids: List[int] = Field(..., description="Transaction IDs to dismiss")
    field: str = Field(..., description="Field name: 'source_from_account' or 'source_to_account'")
    reason: Optional[str] = Field(None, description="Optional reason for dismissal")


@router.post("/{transaction_id}/dismiss-transfer-issue")
def dismiss_transfer_issue(
    transaction_id: int,
    request: DismissTransferIssueRequest = Body(...),
    session: Session = Depends(get_db),
):
    """
    Dismiss a transfer issue for a specific transaction.
    
    Adds system tags to mark the issue as dismissed:
    - sys_transfer_dismissed: "true"
    - sys_dismissed_field: field name
    - sys_dismissed_reason: reason (if provided)
    - sys_dismissed_at: timestamp
    """
    from sqlalchemy.orm.attributes import flag_modified
    
    # Validate field name
    if request.field not in ['source_from_account', 'source_to_account']:
        raise HTTPException(status_code=400, detail="Field must be 'source_from_account' or 'source_to_account'")
    
    # Get transaction
    tx = session.get(NormalizedTransaction, transaction_id)
    if not tx:
        raise HTTPException(status_code=404, detail=f"Transaction {transaction_id} not found")
    
    # Validate transaction type
    if tx.transaction_type != 'transfer':
        raise HTTPException(status_code=400, detail="Transaction is not a transfer")
    
    # Remove any existing dismissal tags for this field
    tags = list(tx.tags or [])
    tags = [
        tag for tag in tags
        if not (tag.get("sys_transfer_dismissed") == "true" and 
                any(t.get("sys_dismissed_field") == request.field for t in tags))
    ]
    
    # Add new dismissal tags
    dismissal_tags = [
        {"sys_transfer_dismissed": "true"},
        {"sys_dismissed_field": request.field},
        {"sys_dismissed_at": datetime.now().isoformat()},
    ]
    if request.reason:
        dismissal_tags.append({"sys_dismissed_reason": request.reason})
    
    tags.extend(dismissal_tags)
    
    tx.tags = tags if tags else None
    flag_modified(tx, "tags")
    session.add(tx)
    session.commit()
    
    return {
        "success": True,
        "transaction_id": transaction_id,
        "field": request.field,
        "dismissed": True,
    }


@router.delete("/{transaction_id}/dismiss-transfer-issue/{field}")
def undismiss_transfer_issue(
    transaction_id: int,
    field: str,
    session: Session = Depends(get_db),
):
    """
    Un-dismiss a transfer issue for a specific transaction.
    
    Removes system dismissal tags for the specified field.
    """
    from sqlalchemy.orm.attributes import flag_modified
    
    # Validate field name
    if field not in ['source_from_account', 'source_to_account']:
        raise HTTPException(status_code=400, detail="Field must be 'source_from_account' or 'source_to_account'")
    
    # Get transaction
    tx = session.get(NormalizedTransaction, transaction_id)
    if not tx:
        raise HTTPException(status_code=404, detail=f"Transaction {transaction_id} not found")
    
    # Remove dismissal tags for this field
    tags = list(tx.tags or [])
    
    # First, find if this field is dismissed
    is_dismissed = any(
        tag.get("sys_transfer_dismissed") == "true" 
        for tag in tags
    ) and any(
        tag.get("sys_dismissed_field") == field
        for tag in tags
    )
    
    if not is_dismissed:
        raise HTTPException(status_code=404, detail=f"No dismissal found for field '{field}'")
    
    # Remove all sys_transfer_dismissed, sys_dismissed_field, sys_dismissed_reason, sys_dismissed_at tags
    # that are associated with this field
    tags = [
        tag for tag in tags
        if not (tag.get("sys_transfer_dismissed") or 
                tag.get("sys_dismissed_field") == field or
                (tag.get("sys_dismissed_reason") and any(t.get("sys_dismissed_field") == field for t in tags)) or
                (tag.get("sys_dismissed_at") and any(t.get("sys_dismissed_field") == field for t in tags)))
    ]
    
    tx.tags = tags if tags else None
    flag_modified(tx, "tags")
    session.add(tx)
    session.commit()
    
    return {
        "success": True,
        "transaction_id": transaction_id,
        "field": field,
        "dismissed": False,
    }


@router.post("/bulk-dismiss-transfer-issues")
def bulk_dismiss_transfer_issues(
    request: BulkDismissTransferIssuesRequest = Body(...),
    session: Session = Depends(get_db),
):
    """
    Bulk dismiss transfer issues for multiple transactions.
    
    Stores a single dismissal tag per field:
      {"sys_transfer_dismissed": "<field>"}
    """
    from sqlalchemy.orm.attributes import flag_modified
    
    # Validate field name
    if request.field not in ['source_from_account', 'source_to_account']:
        raise HTTPException(status_code=400, detail="Field must be 'source_from_account' or 'source_to_account'")
    
    dismissed_count = 0
    errors = []
    
    for tx_id in request.transaction_ids:
        try:
            tx = session.get(NormalizedTransaction, tx_id)
            if not tx:
                errors.append(f"Transaction {tx_id} not found")
                continue
            
            if tx.transaction_type != 'transfer':
                errors.append(f"Transaction {tx_id} is not a transfer")
                continue
            
            # Build clean tags list: remove any existing sys_transfer_dismissed for this field
            tags = [
                tag for tag in (tx.tags or [])
                if not (isinstance(tag, dict) and tag.get("sys_transfer_dismissed") == request.field)
            ]
            
            # Add single dismissal tag
            tags.append({"sys_transfer_dismissed": request.field})
            
            tx.tags = tags
            flag_modified(tx, "tags")
            session.add(tx)
            dismissed_count += 1
            
        except Exception as e:
            errors.append(f"Error processing transaction {tx_id}: {str(e)}")
    
    session.commit()
    
    return {
        "success": True,
        "dismissed_count": dismissed_count,
        "total_requested": len(request.transaction_ids),
        "errors": errors,
    }


@router.get("", response_model=TransactionListResponse)
def list_transactions(
    review_status: Optional[str] = Query(
        None, description="Filter by review status (valid/pending/invalid)"
    ),
    taxability: Optional[str] = Query(
        None, description="Filter by taxability status (taxable/non_taxable/unknown)"
    ),
    source: Optional[str] = Query(None, description="Filter by source (comma-separated for multiple)"),
    account_id: Optional[str] = Query(None, description="Filter by account IDs (comma-separated, 'unmapped' for NULL)"),
    from_account_id: Optional[str] = Query(None, description="Filter by from account IDs (comma-separated, 'unmapped' for NULL)"),
    to_account_id: Optional[str] = Query(None, description="Filter by to account IDs (comma-separated, 'unmapped' for NULL)"),
    related_account_id: Optional[str] = Query(None, description="Filter by related account IDs — matches account, from account, or to account (comma-separated, 'unmapped' for NULL)"),
    unit_id: Optional[int] = Query(None, description="Filter by unit ID"),
    ids: Optional[str] = Query(None, description="Filter by transaction IDs (comma-separated for multiple)"),
    # New filter parameters
    date_from: Optional[str] = Query(None, description="Filter transactions from this date (ISO format)"),
    date_to: Optional[str] = Query(None, description="Filter transactions until this date (ISO format)"),
    asset_id: Optional[str] = Query(None, description="Filter by asset IDs (comma-separated for multiple)"),
    related_asset_id: Optional[str] = Query(None, description="Filter by related asset IDs — matches base asset, price quote, or fee quote (comma-separated for multiple)"),
    category_id: Optional[str] = Query(None, description="Filter by category IDs (comma-separated for multiple)"),
    transaction_type: Optional[str] = Query(None, description="Filter by transaction type (comma-separated for multiple)"),
    direction: Optional[str] = Query(None, description="Filter by direction (comma-separated for multiple)"),
    connector_run_id: Optional[str] = Query(None, description="Filter by connector run IDs (comma-separated for multiple)"),
    connector_run_outcome: Optional[str] = Query(None, description="Filter by outcome within connector run: synced, updated, or skipped. Requires connector_run_id."),
    source_transaction_id: Optional[str] = Query(None, description="Filter by source transaction IDs (comma-separated for multiple)"),
    tag_key: Optional[str] = Query(None, description="Filter by tag keys (comma-separated for multiple)"),
    network: Optional[str] = Query(None, description="Filter by network/chain (comma-separated for multiple)"),
    # P&L audit filters
    pnl_cal_version: Optional[int] = Query(None, description="Filter by P&L calculation version ID"),
    pnl_cal_inclusions_status: Optional[str] = Query(None, description="Filter by inclusion status in P&L version (included/excluded)"),
    # Counterparty filter
    non_owned: bool = Query(False, description="Filter to transactions with non-owned or unmapped counterparties"),
    # Fee filter
    has_fee: Optional[bool] = Query(None, description="Filter by fee presence: true = fee > 0, false = no fee"),
    # New filters: quote assets, include_fee, bundles
    price_quote_asset_id: Optional[str] = Query(None, description="Filter by price quote asset IDs (comma-separated for multiple)"),
    fee_quote_asset_id: Optional[str] = Query(None, description="Filter by fee quote asset IDs (comma-separated for multiple)"),
    attributed_asset_id: Optional[str] = Query(None, description="Filter by attributed asset IDs (comma-separated for multiple)"),
    include_fee: Optional[bool] = Query(None, description="Filter by include_fee flag (true/false)"),
    has_bundle: Optional[bool] = Query(None, description="Filter by whether transaction has a bundle assigned"),
    bundle_pattern: Optional[str] = Query(None, description="Filter by bundle pattern (comma-separated: internal_transfer, swap, flow, split, custom, unknown)"),
    limit: int = Query(5000, ge=1, le=10000, description="Maximum number of results"),
    offset: int = Query(0, ge=0, description="Number of results to skip"),
    sort_by: Optional[str] = Query("date_time", description="Column to sort by (date_time, id, source, direction, transaction_type, quantity, price, total, fee, review_status, taxability_status)"),
    sort_dir: Optional[str] = Query("desc", description="Sort direction: asc or desc"),
    session: Session = Depends(get_db),
):
    """
    List all normalized transactions with optional filtering.

    Returns a wrapped response with transaction results and metadata including:
    - Applied filters (after validation)
    - Validation warnings for invalid/skipped filters
    - Total count (without filters)
    - Filtered count (with filters applied)
    - Pagination info

    - **review_status**: Filter by review status (valid, pending, invalid)
    - **taxability**: Filter by taxability_status (taxable, non_taxable, unknown)
    - **source**: Filter by source exchange (comma-separated for multiple)
    - **account_id**: Filter by account IDs (comma-separated for multiple)
    - **unit_id**: Filter to transactions in a specific unit
    - **date_from**: Filter transactions from this date (ISO format)
    - **date_to**: Filter transactions until this date (ISO format)
    - **asset_id**: Filter by asset IDs (comma-separated for multiple)
    - **category_id**: Filter by category IDs (comma-separated for multiple)
    - **transaction_type**: Filter by transaction type (comma-separated for multiple)
    - **direction**: Filter by direction (comma-separated for multiple)
    - **limit**: Maximum number of results to return
    - **offset**: Number of results to skip for pagination
    """
    try:
        from backend.api.routes.filter_validator import validate_transaction_filters
        
        # When connector_run_outcome is specified, don't pass connector_run_id
        # to the shared filter builder — sync_connector_run_id tracks the LAST
        # run that touched a transaction, which may differ from the run we're
        # inspecting.  The outcome filter handles the correct filtering via
        # source_transaction_id resolved from the run's JSON columns.
        effective_connector_run_id = (
            None if connector_run_outcome else connector_run_id
        )

        # Validate filters
        applied_filters, warnings = validate_transaction_filters(
            session=session,
            review_status=review_status,
            taxability=taxability,
            source=source,
            account_id=account_id,
            from_account_id=from_account_id,
            to_account_id=to_account_id,
            related_account_id=related_account_id,
            asset_id=asset_id,
            related_asset_id=related_asset_id,
            category_id=category_id,
            transaction_type=transaction_type,
            direction=direction,
            connector_run_id=effective_connector_run_id,
            tag_key=tag_key,
            network=network,
            date_from=date_from,
            date_to=date_to,
            price_quote_asset_id=price_quote_asset_id,
            fee_quote_asset_id=fee_quote_asset_id,
            attributed_asset_id=attributed_asset_id,
            include_fee=include_fee,
            has_bundle=has_bundle,
            bundle_pattern=bundle_pattern,
        )
        
        # Add P&L audit filters to applied_filters
        if pnl_cal_version is not None:
            applied_filters.pnl_cal_version = pnl_cal_version
        if pnl_cal_inclusions_status:
            applied_filters.pnl_cal_inclusions_status = pnl_cal_inclusions_status
        
        # Get total count (without filters, except unit_id if provided)
        count_statement = select(func.count(NormalizedTransaction.id))
        if unit_id is not None:
            count_statement = count_statement.where(
                NormalizedTransaction.user_calculation_unit_id == unit_id
            )
        total_count = session.exec(count_statement).one()
        
        # Build query with validated filters
        statement = select(NormalizedTransaction).options(
            joinedload(NormalizedTransaction.asset),
            joinedload(NormalizedTransaction.price_quote_asset),
            joinedload(NormalizedTransaction.fee_quote_asset),
            joinedload(NormalizedTransaction.attributed_asset),
            joinedload(NormalizedTransaction.account_rel),
            joinedload(NormalizedTransaction.from_account),
            joinedload(NormalizedTransaction.to_account),
            joinedload(NormalizedTransaction.sync_connector_run),
        )

        # Apply shared transaction filter predicates (handles all standard filters:
        # review_statuses, taxability, sources, accounts, assets, categories,
        # transaction_types, directions, connector_runs, dates, tags, networks)
        from backend.services.filters.transaction_filter import build_transaction_filter_predicates
        for predicate in build_transaction_filter_predicates(applied_filters, non_owned=non_owned):
            statement = statement.where(predicate)

        if unit_id is not None:
            statement = statement.where(
                NormalizedTransaction.user_calculation_unit_id == unit_id
            )

        # Filter by specific transaction IDs
        if ids:
            id_list = [int(i.strip()) for i in ids.split(',') if i.strip().isdigit()]
            if id_list:
                if len(id_list) == 1:
                    statement = statement.where(NormalizedTransaction.id == id_list[0])
                else:
                    statement = statement.where(NormalizedTransaction.id.in_(id_list))

        # Has fee filter
        if has_fee is True:
            statement = statement.where(
                NormalizedTransaction.fee.isnot(None),
                NormalizedTransaction.fee > 0,
            )
        elif has_fee is False:
            statement = statement.where(
                or_(NormalizedTransaction.fee.is_(None), NormalizedTransaction.fee == 0)
            )

        # P&L version inclusion/exclusion filter
        if pnl_cal_version is not None and pnl_cal_inclusions_status:
            from sqlalchemy import exists
            
            # Subquery to get transaction IDs in this version
            version_tx_subquery = (
                select(CalculationUnitLeg.transaction_id)
                .join(CalculationUnit, CalculationUnit.id == CalculationUnitLeg.unit_id)
                .where(CalculationUnit.version_id == pnl_cal_version)
                .distinct()
            )
            
            if pnl_cal_inclusions_status == "included":
                # Only transactions IN this version
                statement = statement.where(
                    NormalizedTransaction.id.in_(version_tx_subquery)
                )
            elif pnl_cal_inclusions_status == "excluded":
                # Transactions NOT IN this version
                statement = statement.where(
                    ~NormalizedTransaction.id.in_(version_tx_subquery)
                )

        # Date range, asset, category, transaction_type, direction, connector_run,
        # tag, and network filters are already applied by build_transaction_filter_predicates above.

        # Source transaction ID filter (not part of shared builder — transaction-table-specific)
        if source_transaction_id:
            source_ids = [sid.strip() for sid in source_transaction_id.split(',') if sid.strip()]
            if source_ids:
                if len(source_ids) == 1:
                    statement = statement.where(
                        NormalizedTransaction.source_transaction_id == source_ids[0]
                    )
                else:
                    statement = statement.where(
                        NormalizedTransaction.source_transaction_id.in_(source_ids)
                    )

        # Connector run outcome filter — resolves IDs server-side from the
        # SyncJobConnectorRun JSON columns (synced_ids / updated_ids / skipped_ids)
        # so the frontend doesn't need to send potentially hundreds of IDs in the URL.
        if connector_run_outcome and connector_run_id:
            outcome = connector_run_outcome.strip().lower()
            if outcome in ('synced', 'updated', 'skipped'):
                run_id_list = [int(r.strip()) for r in connector_run_id.split(',') if r.strip().isdigit()]
                if run_id_list:
                    run = session.get(SyncJobConnectorRun, run_id_list[0])
                    if run:
                        outcome_ids: List[str] = []
                        if outcome == 'synced':
                            outcome_ids = run.synced_ids or []
                        elif outcome == 'updated':
                            outcome_ids = run.updated_ids or []
                        elif outcome == 'skipped':
                            outcome_ids = run.skipped_ids or []

                        if outcome_ids:
                            if len(outcome_ids) == 1:
                                statement = statement.where(
                                    NormalizedTransaction.source_transaction_id == outcome_ids[0]
                                )
                            else:
                                statement = statement.where(
                                    NormalizedTransaction.source_transaction_id.in_(outcome_ids)
                                )
                        else:
                            # Empty outcome list → no results
                            statement = statement.where(literal_column('1') == literal_column('0'))
                    else:
                        # Connector run not found → no results
                        statement = statement.where(literal_column('1') == literal_column('0'))

        # Get filtered count (before pagination)
        filtered_count_statement = select(func.count()).select_from(statement.subquery())
        filtered_count = session.exec(filtered_count_statement).one()

        # Apply sorting
        SORTABLE_COLUMNS = {
            'date_time': NormalizedTransaction.date_time,
            'date': NormalizedTransaction.date_time,  # alias
            'id': NormalizedTransaction.id,
            'source': NormalizedTransaction.source,
            'direction': NormalizedTransaction.direction,
            'transaction_type': NormalizedTransaction.transaction_type,
            'type': NormalizedTransaction.transaction_type,  # alias
            'quantity': NormalizedTransaction.quantity,
            'qty': NormalizedTransaction.quantity,  # alias
            'price': NormalizedTransaction.price,
            'total': (NormalizedTransaction.quantity * NormalizedTransaction.price),
            'fee': NormalizedTransaction.fee,
            'review_status': NormalizedTransaction.review_status,
            'status': NormalizedTransaction.review_status,  # alias
            'disposal_taxable': NormalizedTransaction.taxability_status,
            'taxability': NormalizedTransaction.taxability_status,  # alias
            'taxability_status': NormalizedTransaction.taxability_status,
            'include_fee': NormalizedTransaction.include_fee,
            'source_transaction_id': NormalizedTransaction.source_transaction_id,
        }
        sort_column = SORTABLE_COLUMNS.get(sort_by or 'date_time', NormalizedTransaction.date_time)
        if sort_dir and sort_dir.lower() == 'asc':
            statement = statement.order_by(sort_column.asc())
        else:
            statement = statement.order_by(sort_column.desc())

        # Apply pagination
        statement = (
            statement
            .offset(offset)
            .limit(limit)
        )

        transactions = session.exec(statement).all()

        # Batch-load FR tax overrides for this page of transactions
        tx_ids = [tx.id for tx in transactions]
        fr_override_tx_ids: set = set()
        if tx_ids:
            override_rows = session.exec(
                select(TransactionTaxOverride.transaction_id)
                .where(TransactionTaxOverride.jurisdiction == "fr")
                .where(TransactionTaxOverride.transaction_id.in_(tx_ids))
            ).all()
            fr_override_tx_ids = set(override_rows)

        # Build response with metadata
        return TransactionListResponse(
            results=[_build_transaction_response(tx, session, fr_override_tx_ids=fr_override_tx_ids) for tx in transactions],
            metadata=FilterMetadata(
                applied_filters=applied_filters,
                validation_warnings=warnings,
                total_count=total_count,
                filtered_count=filtered_count,
                limit=limit,
                offset=offset,
            )
        )

    except Exception as e:
        print(e)
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/inbox", response_model=Dict)
def get_inbox(
    limit: int = Query(200, ge=1, le=1000, description="Maximum number of results"),
    session: Session = Depends(get_db),
):
    """
    Get inbox view with pending transactions.
    
    Returns:
    - pending_transactions: List of pending transactions
    - needs_taxability_review_count: Count of transactions with unknown taxability
    - total_pending_count: Total pending transactions
    """
    try:
        # Get pending transactions (review_status=pending)
        statement = (
            select(NormalizedTransaction)
            .options(
                joinedload(NormalizedTransaction.asset),
                joinedload(NormalizedTransaction.price_quote_asset),
                joinedload(NormalizedTransaction.fee_quote_asset),
            joinedload(NormalizedTransaction.attributed_asset),
                joinedload(NormalizedTransaction.account_rel),
                joinedload(NormalizedTransaction.from_account),
                joinedload(NormalizedTransaction.to_account),
                joinedload(NormalizedTransaction.sync_connector_run),
            )
            .where(NormalizedTransaction.review_status == ReviewStatus.PENDING.value)
            .order_by(NormalizedTransaction.date_time.desc())
            .limit(limit)
        )
        
        pending_txs = session.exec(statement).all()
        
        # Count transactions needing taxability review
        taxability_count = session.exec(
            select(func.count(NormalizedTransaction.id))
            .where(NormalizedTransaction.review_status == ReviewStatus.PENDING.value)
            .where(NormalizedTransaction.taxability_status == TaxabilityStatus.UNKNOWN.value)
        ).first() or 0
        
        # Total pending count
        total_pending = session.exec(
            select(func.count(NormalizedTransaction.id))
            .where(NormalizedTransaction.review_status == ReviewStatus.PENDING.value)
        ).first() or 0
        
        return {
            "pending_transactions": [_build_transaction_response(tx, session) for tx in pending_txs],
            "needs_taxability_review_count": taxability_count,
            "total_pending_count": total_pending,
        }
    
    except Exception as e:
        print(e)
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/reviewed", response_model=List[TransactionResponse])
def get_reviewed_transactions(
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of results"),
    offset: int = Query(0, ge=0, description="Number of results to skip"),
    session: Session = Depends(get_db),
):
    """
    Get reviewed transactions (review_status='valid').
    
    Returns transactions that have been reviewed and approved by the user.
    """
    try:
        statement = (
            select(NormalizedTransaction)
            .options(
                joinedload(NormalizedTransaction.asset),
                joinedload(NormalizedTransaction.price_quote_asset),
                joinedload(NormalizedTransaction.fee_quote_asset),
            joinedload(NormalizedTransaction.attributed_asset),
                joinedload(NormalizedTransaction.account_rel),
                joinedload(NormalizedTransaction.from_account),
                joinedload(NormalizedTransaction.to_account),
            )
            .where(NormalizedTransaction.review_status == ReviewStatus.VALID.value)
            .order_by(NormalizedTransaction.date_time.desc())
            .offset(offset)
            .limit(limit)
        )
        
        transactions = session.exec(statement).all()
        return [_build_transaction_response(tx, session) for tx in transactions]
    
    except Exception as e:
        print(e)
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/tags", response_model=List[Dict[str, Any]])
def list_tags(
    session: Session = Depends(get_db),
):
    """
    List all unique tags used across transactions.

    Tags are stored as list of {key: value} dicts.
    Returns a deduplicated list of all unique tag key-value pairs.
    """
    try:
        # Get all transactions with tags
        statement = select(NormalizedTransaction.tags).where(
            NormalizedTransaction.tags != None
        )
        results = session.exec(statement).all()

        # Collect unique tags (using tuple for hashability)
        unique_tags_set = set()
        for tags in results:
            if tags and isinstance(tags, list):
                for tag in tags:
                    if isinstance(tag, dict):
                        # Convert dict to tuple of items for hashability
                        for k, v in tag.items():
                            unique_tags_set.add((k, str(v)))
            elif tags and isinstance(tags, dict):
                # Handle legacy dict format
                for k, v in tags.items():
                    unique_tags_set.add((k, str(v)))

        # Convert back to list of dicts
        return [{"key": k, "value": v} for k, v in sorted(unique_tags_set)]

    except Exception as e:
        print(e)
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


# ============================================================================
# V2 Workflow Endpoints (Inbox/Reviewed/Excluded)
# ============================================================================


@router.get("/inbox", response_model=List[TransactionResponse])
def get_inbox(
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_db),
):
    """
    Get pending transactions (Inbox view).

    Returns transactions with review_status='pending'.
    These are transactions that need user review.
    """
    statement = (
        select(NormalizedTransaction)
        .options(
            joinedload(NormalizedTransaction.asset),
            joinedload(NormalizedTransaction.price_quote_asset),
            joinedload(NormalizedTransaction.fee_quote_asset),
            joinedload(NormalizedTransaction.attributed_asset),
            joinedload(NormalizedTransaction.account_rel),
            joinedload(NormalizedTransaction.from_account),
            joinedload(NormalizedTransaction.to_account),
        )
        .where(NormalizedTransaction.review_status == ReviewStatus.PENDING.value)
        .order_by(NormalizedTransaction.date_time.desc())
        .offset(offset)
        .limit(limit)
    )

    transactions = session.exec(statement).all()
    return [_build_transaction_response(tx, session) for tx in transactions]


@router.get("/reviewed", response_model=List[TransactionResponse])
def get_reviewed(
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_db),
):
    """
    Get reviewed standalone transactions.

    Returns transactions with review_status='valid'.
    """
    statement = (
        select(NormalizedTransaction)
        .options(
            joinedload(NormalizedTransaction.asset),
            joinedload(NormalizedTransaction.price_quote_asset),
            joinedload(NormalizedTransaction.fee_quote_asset),
            joinedload(NormalizedTransaction.attributed_asset),
            joinedload(NormalizedTransaction.account_rel),
            joinedload(NormalizedTransaction.from_account),
            joinedload(NormalizedTransaction.to_account),
        )
        .where(NormalizedTransaction.review_status == ReviewStatus.VALID.value)
        .order_by(NormalizedTransaction.date_time.desc())
        .offset(offset)
        .limit(limit)
    )

    transactions = session.exec(statement).all()
    return [_build_transaction_response(tx, session) for tx in transactions]


@router.post("/bulk-status", response_model=BulkOperationResponse)
def bulk_update_status(
    request: BulkStatusUpdate,
    session: Session = Depends(get_db),
):
    """
    Bulk update transaction status and taxability.

    Use this to mark multiple transactions as reviewed/excluded.
    """
    updated = 0
    errors = []

    for tx_id in request.transaction_ids:
        tx = session.get(NormalizedTransaction, tx_id)
        if not tx:
            errors.append(f"Transaction {tx_id} not found")
            continue

        tx.review_status = request.review_status.value
        if request.taxability_status:
            tx.taxability_status = request.taxability_status.value

        session.add(tx)
        updated += 1

    session.commit()

    return BulkOperationResponse(
        success=len(errors) == 0,
        affected_count=updated,
        message=f"Updated {updated} transactions",
        errors=errors,
    )


@router.get("/{transaction_id}", response_model=TransactionResponse)
def get_transaction(
    transaction_id: int,
    session: Session = Depends(get_db),
):
    """
    Get a specific transaction by ID.

    - **transaction_id**: The ID of the transaction to retrieve
    """
    try:
        statement = (
            select(NormalizedTransaction)
            .options(
                joinedload(NormalizedTransaction.asset),
                joinedload(NormalizedTransaction.price_quote_asset),
                joinedload(NormalizedTransaction.fee_quote_asset),
            joinedload(NormalizedTransaction.attributed_asset),
                joinedload(NormalizedTransaction.account_rel),
                joinedload(NormalizedTransaction.from_account),
                joinedload(NormalizedTransaction.to_account),
            )
            .where(NormalizedTransaction.id == transaction_id)
        )
        tx = session.exec(statement).first()

        if not tx:
            raise HTTPException(status_code=404, detail="Transaction not found")

        return _build_transaction_response(tx, session)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


def _upsert_raw_account_mappings(
    session: Session,
    tx: NormalizedTransaction,
    update_data: dict,
):
    """
    Auto-create or update RawAccount mappings when account FKs are set on a transaction.
    
    Maps: (source, source_from_account) → from_account_id
          (source, source_to_account)   → to_account_id
          (source, source_account)      → account_id
    """
    mapping_pairs = [
        ("from_account_id", "source_from_account"),
        ("to_account_id", "source_to_account"),
        ("account_id", "source_account"),
    ]
    source = tx.source
    if not source:
        return

    for fk_field, source_field in mapping_pairs:
        if fk_field not in update_data:
            continue
        new_account_id = update_data[fk_field]
        source_label = getattr(tx, source_field, None)
        if not source_label or not new_account_id:
            continue

        # Try to find existing raw_account (FOR UPDATE to prevent deadlocks)
        existing = session.exec(
            select(RawAccount)
            .where(
                RawAccount.source == source,
                RawAccount.label == source_label,
            )
            .with_for_update()
        ).first()

        if existing:
            existing.account_id = new_account_id
            session.add(existing)
        else:
            session.add(RawAccount(
                source=source,
                label=source_label,
                account_id=new_account_id,
            ))


@router.patch("/{transaction_id}", response_model=TransactionResponse)
def update_transaction(
    transaction_id: int,
    update: TransactionUpdate = Body(...),
    session: Session = Depends(get_db),
):
    """
    Update review fields of a transaction.

    - **transaction_id**: The ID of the transaction to update
    - **update**: Fields to update (only provided fields will be changed)
    """
    max_retries = 3
    for attempt in range(max_retries):
        try:
            statement = (
                select(NormalizedTransaction)
                .options(
                    joinedload(NormalizedTransaction.asset),
                    joinedload(NormalizedTransaction.price_quote_asset),
                    joinedload(NormalizedTransaction.fee_quote_asset),
            joinedload(NormalizedTransaction.attributed_asset),
                    joinedload(NormalizedTransaction.account_rel),
                    joinedload(NormalizedTransaction.from_account),
                    joinedload(NormalizedTransaction.to_account),
                )
                .where(NormalizedTransaction.id == transaction_id)
            )
            tx = session.exec(statement).first()

            if not tx:
                raise HTTPException(status_code=404, detail="Transaction not found")

            # Update only provided fields
            update_data = update.model_dump(exclude_unset=True)
            
            for key, value in update_data.items():
                setattr(tx, key, value)

            # Auto-create/update raw_account mappings when account FKs are set
            _upsert_raw_account_mappings(session, tx, update_data)

            session.add(tx)
            session.commit()
            session.refresh(tx)

            return _build_transaction_response(tx, session)

        except OperationalError as e:
            session.rollback()
            if "deadlock detected" in str(e).lower() and attempt < max_retries - 1:
                time.sleep(0.1 * (attempt + 1))  # backoff: 100ms, 200ms
                continue
            raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
        except HTTPException:
            raise
        except Exception as e:
            session.rollback()
            raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


class CreateTransactionResponse(BaseModel):
    """Response model for transaction creation (may return multiple if split)."""

    transactions: List[TransactionResponse]
    split: bool = False
    message: str


@router.post("", response_model=CreateTransactionResponse)
def create_transaction(
    transaction: TransactionCreate = Body(...),
    session: Session = Depends(get_db),
):
    """
    Create a new manual transaction.

    If the transaction is a buy/sell, it will be split into atomic legs
    (outflow for what you give, inflow for what you receive).
    Both legs will be linked via a group.

    - **transaction**: Transaction data to create

    Returns:
        CreateTransactionResponse with list of created transactions
    """
    try:
        # Parse datetime from ISO string
        try:
            dt = datetime.fromisoformat(transaction.date_time.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(
                status_code=400, detail="Invalid datetime format. Use ISO format."
            )

        # Generate unique source_transaction_id for manual transactions
        source_tx_id = f"manual_{uuid.uuid4().hex[:12]}"

        # Create NormalizedTransaction model for pipeline processing
        # SQLModel is also Pydantic, so it works as a DTO
        pydantic_tx = NormalizedTransaction(
            source=transaction.source or "manual",
            source_transaction_id=source_tx_id,
            source_transaction_type=transaction.source_transaction_type
            or "manual_entry",
            source_asset_symbol=transaction.source_asset_symbol,
            source_price_quote_asset_symbol=transaction.source_price_quote_asset_symbol,
            source_fee_quote_asset_symbol=transaction.source_fee_quote_asset_symbol,
            account_id=transaction.account_id,
            asset_id=transaction.asset_id,
            price_quote_asset_id=transaction.price_quote_asset_id,
            fee_quote_asset_id=transaction.fee_quote_asset_id,
            date_time=dt,
            direction=transaction.direction,
            transaction_type=transaction.transaction_type,
            quantity=transaction.quantity,
            price=transaction.price,
            total=transaction.total,
            fee=transaction.fee,
            include_fee=transaction.include_fee,
            taxability_status=transaction.taxability_status,
            source_from_account=transaction.source_from_account,
            source_to_account=transaction.source_to_account,
            from_account_id=transaction.from_account_id,
            to_account_id=transaction.to_account_id,
            network_transaction_id=transaction.network_transaction_id,
            token_contract_address=transaction.token_contract_address,
            review_status=transaction.review_status,
            review_notes=transaction.review_notes,
            tags=transaction.tags or [],
        )

        # Use the default pipeline (split, transfer detection, asset enrichment, persistence)
        pipeline = create_default_pipeline(session)
        context = PipelineContext(session=session, source=pydantic_tx.source)

        # Process through pipeline - this handles everything including persistence
        result = pipeline.process(pydantic_tx, context)

        if not result.success:
            raise HTTPException(
                status_code=500, detail=f"Pipeline error: {'; '.join(result.errors)}"
            )

        # Query persisted transactions to build response
        created_transactions = []
        for pydantic_tx in result.pydantic_transactions:
            statement = (
                select(NormalizedTransaction)
                .options(
                    joinedload(NormalizedTransaction.asset),
                    joinedload(NormalizedTransaction.price_quote_asset),
                    joinedload(NormalizedTransaction.fee_quote_asset),
            joinedload(NormalizedTransaction.attributed_asset),
                    joinedload(NormalizedTransaction.account_rel),
                    joinedload(NormalizedTransaction.from_account),
                    joinedload(NormalizedTransaction.to_account),
                )
                .where(
                    NormalizedTransaction.source == pydantic_tx.source,
                    NormalizedTransaction.source_transaction_id == pydantic_tx.source_transaction_id,
                )
            )
            db_tx = session.exec(statement).first()
            if db_tx:
                created_transactions.append(db_tx)

        # Build response using helper
        response_transactions = [
            _build_transaction_response(tx, session) for tx in created_transactions
        ]

        # Build message
        was_split = len(created_transactions) > 1

        if was_split:
            message = f"Transaction split into {len(created_transactions)} legs"
        else:
            message = "Transaction created successfully"

        return CreateTransactionResponse(
            transactions=response_transactions,
            split=was_split,
            message=message,
        )

    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


# ============================================================================
# Bulk Operations
# ============================================================================


@router.post("/bulk/update", response_model=BulkOperationResponse)
def bulk_update_transactions(
    request: BulkUpdateRequest = Body(...),
    session: Session = Depends(get_db),
):
    """
    Bulk update multiple transactions at once.

    - **transaction_ids**: List of transaction IDs to update
    - **review_status**: New review status to set (optional)
    - **transaction_type**: New transaction type to set (optional)
    """
    if not request.transaction_ids:
        raise HTTPException(status_code=400, detail="No transaction IDs provided")

    has_update = (
        request.review_status is not None
        or request.transaction_type is not None
        or request.taxability_status is not None
        or request.include_fee is not None
        or request.clear_from_account is True
        or request.clear_to_account is True
    )
    if not has_update:
        raise HTTPException(
            status_code=400,
            detail="At least one field to update must be provided",
        )

    try:
        updated_count = 0
        errors = []

        for tx_id in request.transaction_ids:
            tx = session.get(NormalizedTransaction, tx_id)
            if not tx:
                errors.append(f"Transaction {tx_id} not found")
                continue

            if request.review_status:
                tx.review_status = request.review_status.value
            if request.transaction_type:
                tx.transaction_type = request.transaction_type
            if request.taxability_status is not None:
                tx.taxability_status = request.taxability_status.value
            if request.include_fee is not None:
                tx.include_fee = request.include_fee
            if request.clear_from_account:
                tx.from_account_id = None
            if request.clear_to_account:
                tx.to_account_id = None

            session.add(tx)
            updated_count += 1

        session.commit()

        return BulkOperationResponse(
            success=True,
            affected_count=updated_count,
            message=f"Updated {updated_count} transaction(s)",
            errors=errors,
        )

    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.post("/bulk/check-linked", response_model=Dict[str, int])
def check_bulk_delete_impact(
    request: BulkDeleteRequest = Body(...),
    session: Session = Depends(get_db),
):
    """
    Check for linked objects that will be deleted along with these transactions.
    Returns counts of affected objects grouped by type.
    """
    if not request.transaction_ids:
        return {}

    impact = {
        "pnl_warnings": 0,
        "cost_lots": 0,
        "calculation_legs": 0,
        "realized_pnl": 0,
        "lot_settlements": 0,
        "cost_lot_events": 0,
    }

    # Count affected records in dependent tables
    # (Using individual counts for better clarity in the response)
    impact["pnl_warnings"] = session.exec(
        select(func.count(PnlWarning.id)).where(PnlWarning.transaction_id.in_(request.transaction_ids))
    ).first() or 0

    impact["cost_lots"] = session.exec(
        select(func.count(CostLot.cost_lot_id)).where(CostLot.origin_transaction_id.in_(request.transaction_ids))
    ).first() or 0

    impact["calculation_legs"] = session.exec(
        select(func.count(CalculationUnitLeg.id)).where(CalculationUnitLeg.transaction_id.in_(request.transaction_ids))
    ).first() or 0

    impact["realized_pnl"] = session.exec(
        select(func.count(RealizedPnl.pnl_id)).where(RealizedPnl.transaction_id.in_(request.transaction_ids))
    ).first() or 0

    impact["lot_settlements"] = session.exec(
        select(func.count(LotSettlement.settlement_id)).where(LotSettlement.settling_transaction_id.in_(request.transaction_ids))
    ).first() or 0

    impact["cost_lot_events"] = session.exec(
        select(func.count(CostLotEvent.event_id)).where(CostLotEvent.triggered_by_transaction_id.in_(request.transaction_ids))
    ).first() or 0

    # Filter out zeros for cleaner response
    return {k: v for k, v in impact.items() if v > 0}


@router.post("/bulk/delete", response_model=BulkOperationResponse)
def bulk_delete_transactions(
    request: BulkDeleteRequest = Body(...),
    session: Session = Depends(get_db),
):
    """
    Bulk delete multiple transactions at once.

    - **transaction_ids**: List of transaction IDs to delete
    """
    if not request.transaction_ids:
        raise HTTPException(status_code=400, detail="No transaction IDs provided")

    try:
        deleted_count = 0
        errors = []

        # Collect valid transaction IDs first
        valid_tx_ids = []
        for tx_id in request.transaction_ids:
            tx = session.get(NormalizedTransaction, tx_id)
            if not tx:
                errors.append(f"Transaction {tx_id} not found")
            else:
                valid_tx_ids.append(tx_id)

        if valid_tx_ids:
            # Detach P&L children that reference these transactions
            # (mirrors data_cleanup_service pattern)
            # CalculationUnitLeg has NOT NULL transaction_id — must delete, not nullify
            legs = session.exec(
                select(CalculationUnitLeg).where(CalculationUnitLeg.transaction_id.in_(valid_tx_ids))
            ).all()
            leg_ids = [leg.id for leg in legs]

            # Nullify consumed_lot_slices FK before deleting legs
            if leg_ids:
                session.execute(
                    update(ConsumedLotSlice)
                    .where(ConsumedLotSlice.consumed_by_leg_id.in_(leg_ids))
                    .values(consumed_by_leg_id=None)
                )

            for leg in legs:
                session.delete(leg)

            # Nullable FK references — set to NULL
            session.execute(
                update(CostLot)
                .where(CostLot.origin_transaction_id.in_(valid_tx_ids))
                .values(origin_transaction_id=None)
            )
            session.execute(
                update(RealizedPnl)
                .where(RealizedPnl.transaction_id.in_(valid_tx_ids))
                .values(transaction_id=None)
            )
            session.execute(
                update(LotSettlement)
                .where(LotSettlement.settling_transaction_id.in_(valid_tx_ids))
                .values(settling_transaction_id=None)
            )
            session.execute(
                update(PnlWarning)
                .where(PnlWarning.transaction_id.in_(valid_tx_ids))
                .values(transaction_id=None)
            )
            session.execute(
                update(CostLotEvent)
                .where(CostLotEvent.triggered_by_transaction_id.in_(valid_tx_ids))
                .values(triggered_by_transaction_id=None)
            )
            session.flush()

            # Now delete the transactions
            for tx_id in valid_tx_ids:
                tx = session.get(NormalizedTransaction, tx_id)
                if tx:
                    session.delete(tx)
                    deleted_count += 1

        session.commit()

        return BulkOperationResponse(
            success=True,
            affected_count=deleted_count,
            message=f"Deleted {deleted_count} transaction(s)",
            errors=errors,
        )

    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.post("/bulk/add-to-unit", response_model=BulkOperationResponse)
def bulk_add_to_unit(
    request: BulkAddToUnitRequest = Body(...),
    session: Session = Depends(get_db),
):
    """
    Add multiple transactions to a unit.

    Either provide an existing unit_id, or a unit_label to create a new unit.

    - **transaction_ids**: List of transaction IDs to add to unit
    - **unit_id**: Existing unit ID (optional)
    - **unit_label**: New unit label - creates new unit (optional)
    """
    if not request.transaction_ids:
        raise HTTPException(status_code=400, detail="No transaction IDs provided")

    if not request.unit_id and not request.unit_label:
        raise HTTPException(
            status_code=400,
            detail="Either unit_id or unit_label must be provided",
        )

    try:
        # Get or create unit
        if request.unit_id:
            unit = session.get(CalculationUnit, request.unit_id)
            if not unit:
                raise HTTPException(
                    status_code=404, detail=f"Unit {request.unit_id} not found"
                )
        else:
            # Create new unit
            unit = CalculationUnit(label=request.unit_label or "Bulk Unit")
            session.add(unit)
            session.flush()  # Get ID

        updated_count = 0
        errors = []

        for tx_id in request.transaction_ids:
            tx = session.get(NormalizedTransaction, tx_id)
            if not tx:
                errors.append(f"Transaction {tx_id} not found")
                continue

            tx.user_calculation_unit_id = unit.id
            session.add(tx)
            updated_count += 1

        session.commit()

        return BulkOperationResponse(
            success=True,
            affected_count=updated_count,
            message=f"Added {updated_count} transaction(s) to unit {unit.id}",
            errors=errors,
        )

    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


# ============================================================================
# CSV Import Endpoints
# ============================================================================


from fastapi import UploadFile, File
from backend.file_loaders.trades_csv_loader import TradesCSVLoader
from backend.services.trade_import_service import TradeImportService


class TradeImportResponse(BaseModel):
    """Response model for trade import operations."""
    transactions: Dict
    raw_accounts: Dict
    raw_assets: Dict
    pending_review_count: int
    parse_errors: List[Dict]
    warnings: List[str]
    dry_run: bool
    summary: Dict


@router.post("/import-csv/preview")
async def preview_trades_csv_import(
    file: UploadFile = File(...),
):
    """
    Preview trades CSV file contents without importing.
    
    Returns parsed transactions, accounts, and assets that would be created.
    Useful for validation before actual import.
    """
    try:
        if not file.filename or not file.filename.endswith('.csv'):
            raise HTTPException(status_code=400, detail="File must be a CSV file")
        
        content = await file.read()
        
        loader = TradesCSVLoader()
        load_result = loader.load_from_content(content)
        
        # Build preview response
        return {
            "filename": file.filename,
            "transactions_count": len(load_result.transactions),
            "accounts_count": len(load_result.unique_accounts),
            "assets_count": len(load_result.unique_assets),
            "fee_transactions_count": sum(1 for t in load_result.transactions if t.is_fee_transaction),
            "errors": load_result.errors,
            "warnings": load_result.warnings,
            "transactions": [
                {
                    "date_time": t.date_time.replace(tzinfo=timezone.utc).isoformat() if t.date_time else None,
                    "transaction_type": t.transaction_type,
                    "asset_ticker": t.asset_ticker,
                    "asset_label": t.asset_label,
                    "quantity": float(t.quantity) if t.quantity else None,
                    "price": float(t.price) if t.price else None,
                    "fee": float(t.fee) if t.fee else None,
                    "account_code": t.account_code,
                    "is_fee_transaction": t.is_fee_transaction,
                }
                for t in load_result.transactions[:100]  # Limit preview to first 100
            ],
            "accounts": list(load_result.unique_accounts),
            "assets": list(load_result.unique_assets),
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Preview failed: {str(e)}")


@router.post("/import-csv", response_model=TradeImportResponse)
async def import_trades_from_csv(
    file: UploadFile = File(...),
    dry_run: bool = Query(False, description="Preview changes without committing"),
    session: Session = Depends(get_db),
):
    """
    Import trades from a CSV file.
    
    Creates:
    - RawAccount entries for unknown accounts (pending user mapping)
    - RawAsset entries for unknown assets (pending user mapping)
    - NormalizedTransaction records
    
    Transactions with unmapped accounts/assets will have review_status='pending'.
    
    Args:
        file: CSV file to import
        dry_run: If true, preview changes without committing
    """
    try:
        if not file.filename:
            raise HTTPException(status_code=400, detail="No file provided")
        
        if not file.filename.endswith('.csv'):
            raise HTTPException(status_code=400, detail="File must be a CSV file")
        
        # Read file content
        content = await file.read()
        
        # Parse CSV
        loader = TradesCSVLoader()
        load_result = loader.load_from_content(content)
        
        # Check for critical parse errors
        if load_result.errors and not load_result.transactions:
            raise HTTPException(
                status_code=400, 
                detail=f"CSV parsing failed: {load_result.errors}"
            )
        
        # Import data
        import_service = TradeImportService(session)
        result = import_service.import_from_load_result(
            load_result,
            dry_run=dry_run
        )
        
        return TradeImportResponse(**result.to_dict())
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Import failed: {str(e)}")
