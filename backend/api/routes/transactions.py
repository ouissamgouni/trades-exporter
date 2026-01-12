"""
Transaction endpoints for the Trade Exporter API.
"""

import uuid
from datetime import datetime
from fastapi import APIRouter, HTTPException, Query, Body, Depends
from typing import List, Optional, Dict
from pydantic import BaseModel, Field
from sqlmodel import Session, select
from sqlalchemy import func
from sqlalchemy.orm import joinedload

from backend.api.schemas import TransactionResponse, TransactionUpdate, AssetRef
from backend.db.database import get_db
from backend.db.models import (
    NormalizedTransaction,
    Asset,
    CalculationUnit,
    Account,
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
    disposal_taxable: bool = Field(False, description="Is disposal taxable event")
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
    tags: Optional[List[Dict[str, str]]] = Field(
        None, description="Tags as list of {key: value} pairs"
    )


def _serialize_datetime(value):
    """Convert datetime to ISO string if needed."""
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def _build_transaction_response(
    tx: NormalizedTransaction, session: Session
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

    # Backward-compatible flat symbol fields
    linked_asset_symbol = tx.asset.symbol if tx.asset else None
    linked_price_quote_symbol = tx.price_quote_asset.symbol if tx.price_quote_asset else None
    linked_fee_quote_symbol = tx.fee_quote_asset.symbol if tx.fee_quote_asset else None

    # Resolve account names server-side
    account_name = tx.account_rel.name if tx.account_rel else None
    from_account_name = tx.from_account.name if tx.from_account else None
    to_account_name = tx.to_account.name if tx.to_account else None

    tx_dict = tx.model_dump()
    tx_dict["total"] = tx.total  # Computed property: price * quantity
    
    # Nested asset references
    tx_dict["linked_asset"] = linked_asset
    tx_dict["price_quote_asset"] = price_quote_asset
    tx_dict["fee_quote_asset"] = fee_quote_asset
    
    # Backward-compatible flat fields
    tx_dict["linked_asset_symbol"] = linked_asset_symbol
    tx_dict["linked_price_quote_asset_symbol"] = linked_price_quote_symbol
    tx_dict["linked_fee_quote_asset_symbol"] = linked_fee_quote_symbol
    
    tx_dict["account_name"] = account_name
    tx_dict["from_account_name"] = from_account_name
    tx_dict["to_account_name"] = to_account_name
    tx_dict["synced_at"] = _serialize_datetime(tx_dict.get("synced_at"))

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
    assets: List[FilterOption]
    categories: List[FilterOption]  # Flat list for backward compat
    categories_by_dimension: List[DimensionWithCategories]  # Grouped by dimension
    dimensions: List[FilterOption]
    transaction_types: List[FilterOption]
    directions: List[FilterOption]
    review_statuses: List[FilterOption]
    taxability_statuses: List[FilterOption]


@router.get("/filter-options", response_model=FilterOptionsResponse)
def get_filter_options(session: Session = Depends(get_db)):
    """
    Get all available filter options for the transactions table.
    
    Returns distinct values from the database for dynamic filter dropdowns.
    This ensures filters always show values that actually exist in the data.
    """
    from backend.db.models import Category, Dimension, AssetCategory
    from sqlalchemy import func, distinct
    
    try:
        # Get distinct sources with counts
        source_query = (
            select(
                NormalizedTransaction.source,
                func.count(NormalizedTransaction.id).label('count')
            )
            .group_by(NormalizedTransaction.source)
            .order_by(NormalizedTransaction.source)
        )
        sources = session.exec(source_query).all()
        source_options = [
            FilterOption(value=s[0], label=s[0], count=s[1])
            for s in sources if s[0]
        ]
        
        # Get accounts with counts
        account_query = (
            select(
                Account.id,
                Account.name,
                func.count(NormalizedTransaction.id).label('count')
            )
            .outerjoin(NormalizedTransaction, NormalizedTransaction.account_id == Account.id)
            .group_by(Account.id, Account.name)
            .order_by(Account.name)
        )
        accounts = session.exec(account_query).all()
        account_options = [
            FilterOption(value=str(a[0]), label=a[1], count=a[2] or 0)
            for a in accounts
        ]
        
        # Get assets that have transactions
        asset_query = (
            select(
                Asset.asset_id,
                Asset.symbol,
                Asset.label,
                func.count(NormalizedTransaction.id).label('count')
            )
            .join(NormalizedTransaction, NormalizedTransaction.asset_id == Asset.asset_id)
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
        
        # Get transaction types with counts
        type_query = (
            select(
                NormalizedTransaction.transaction_type,
                func.count(NormalizedTransaction.id).label('count')
            )
            .group_by(NormalizedTransaction.transaction_type)
            .order_by(NormalizedTransaction.transaction_type)
        )
        types = session.exec(type_query).all()
        type_options = [
            FilterOption(value=t[0], label=t[0].title() if t[0] else 'Unknown', count=t[1])
            for t in types if t[0]
        ]
        
        # Get directions with counts
        direction_query = (
            select(
                NormalizedTransaction.direction,
                func.count(NormalizedTransaction.id).label('count')
            )
            .group_by(NormalizedTransaction.direction)
            .order_by(NormalizedTransaction.direction)
        )
        directions = session.exec(direction_query).all()
        direction_options = [
            FilterOption(value=d[0], label=d[0].title() if d[0] else 'Unknown', count=d[1])
            for d in directions if d[0]
        ]
        
        # Static review statuses
        review_status_options = [
            FilterOption(value='pending', label='Pending'),
            FilterOption(value='valid', label='Valid'),
            FilterOption(value='invalid', label='Invalid'),
        ]
        
        # Static taxability statuses
        taxability_options = [
            FilterOption(value='taxable', label='Taxable'),
            FilterOption(value='non_taxable', label='Non-Taxable'),
            FilterOption(value='unknown', label='Unknown'),
        ]
        
        return FilterOptionsResponse(
            sources=source_options,
            accounts=account_options,
            assets=asset_options,
            categories=category_options,
            categories_by_dimension=categories_by_dimension,
            dimensions=dimension_options,
            transaction_types=type_options,
            directions=direction_options,
            review_statuses=review_status_options,
            taxability_statuses=taxability_options,
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


@router.get("/data-health-check", response_model=DataHealthCheckResponse)
def get_data_health_check(
    account_ids: Optional[str] = Query(
        None,
        description="Optional comma-separated account IDs to filter scope (matches P&L calculation filter)"
    ),
    include_details: bool = Query(
        False,
        description="Include detailed raw values needing mapping (for inline fixes)"
    ),
    detail_limit: int = Query(
        20,
        ge=1,
        le=100,
        description="Maximum number of detail items per category"
    ),
    issues_page: int = Query(
        1,
        ge=1,
        description="Page number for transaction issues list"
    ),
    issues_per_page: int = Query(
        50,
        ge=1,
        le=200,
        description="Number of issues per page"
    ),
    session: Session = Depends(get_db),
):
    """
    Get data health check for transactions.
    
    Returns aggregated counts of data completeness issues:
    - Transaction counts by review status (valid, pending, invalid)
    - Missing required data (asset, account, price_quote_asset, fee_quote_asset)
    - Unhandled bundle suggestions count
    
    When include_details=true, also returns detailed lists of raw assets and raw accounts
    needing mapping, with fuzzy match suggestions for inline fixing.
    
    Use optional account_ids filter to match P&L calculation scope.
    Always returns fresh data (no caching).
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
        
        # Total count
        total_query = base_filter(select(func.count(NormalizedTransaction.id)))
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
        
        # Missing asset_id
        missing_asset_query = base_filter(
            select(func.count(NormalizedTransaction.id))
            .where(NormalizedTransaction.asset_id.is_(None))
        )
        missing_asset_count = session.exec(missing_asset_query).one()
        
        # Missing account_id (for trades - check account_id)
        missing_account_query = base_filter(
            select(func.count(NormalizedTransaction.id))
            .where(NormalizedTransaction.account_id.is_(None))
        )
        missing_account_count = session.exec(missing_account_query).one()
        
        # Missing price_quote_asset_id when price > 0
        # Only flag as issue when there IS a price that needs attribution to a quote asset
        missing_price_quote_query = base_filter(
            select(func.count(NormalizedTransaction.id))
            .where(
                NormalizedTransaction.price.isnot(None),
                NormalizedTransaction.price > 0,
                NormalizedTransaction.price_quote_asset_id.is_(None)
            )
        )
        missing_price_quote_count = session.exec(missing_price_quote_query).one()
        
        # Missing fee_quote_asset_id when fee > 0
        missing_fee_quote_query = base_filter(
            select(func.count(NormalizedTransaction.id))
            .where(
                NormalizedTransaction.fee > 0,
                NormalizedTransaction.fee_quote_asset_id.is_(None)
            )
        )
        missing_fee_quote_count = session.exec(missing_fee_quote_query).one()
        
        # Bundle suggestions count (unhandled)
        suggestion_service = SuggestionService(session)
        suggestions = suggestion_service.get_suggestions(max_suggestions=100)
        
        # If account filter, only count suggestions that include transactions from those accounts
        if account_id_list:
            filtered_suggestions = []
            for s in suggestions:
                if any(
                    t.get("account_id") in account_id_list 
                    for t in (s.transactions or [])
                ):
                    filtered_suggestions.append(s)
            bundle_suggestions_count = len(filtered_suggestions)
        else:
            bundle_suggestions_count = len(suggestions)
        
        # Compute aggregate flags
        # Note: pending_count is NOT included in total_issues - pending transactions
        # are awaiting review, not data completeness issues
        total_issues = (
            missing_asset_count + 
            missing_account_count + 
            missing_price_quote_count + 
            missing_fee_quote_count
        )
        has_issues = total_issues > 0 or bundle_suggestions_count > 0
        
        # Build response
        response_data = {
            "total_count": total_count,
            "valid_count": valid_count,
            "pending_count": pending_count,
            "invalid_count": invalid_count,
            "missing_asset_count": missing_asset_count,
            "missing_account_count": missing_account_count,
            "missing_price_quote_count": missing_price_quote_count,
            "missing_fee_quote_count": missing_fee_quote_count,
            "bundle_suggestions_count": bundle_suggestions_count,
            "has_issues": has_issues,
            "total_issues": total_issues,
        }
        
        # Include detailed raw values if requested
        if include_details:
            # Fetch all assets and accounts for fuzzy matching
            all_assets = session.exec(select(Asset)).all()
            all_accounts = session.exec(select(Account)).all()
            
            # Get unique raw assets missing asset_id mapping
            if missing_asset_count > 0:
                missing_assets_query = (
                    select(
                        NormalizedTransaction.source_asset_symbol,
                        NormalizedTransaction.source,
                        func.count(NormalizedTransaction.id).label('count')
                    )
                    .where(
                        NormalizedTransaction.asset_id.is_(None),
                        NormalizedTransaction.source_asset_symbol.isnot(None)
                    )
                    .group_by(
                        NormalizedTransaction.source_asset_symbol,
                        NormalizedTransaction.source
                    )
                    .order_by(func.count(NormalizedTransaction.id).desc())
                    .limit(detail_limit)
                )
                missing_assets_rows = session.exec(missing_assets_query).all()
                response_data["missing_assets_detail"] = [
                    RawAssetIssue(
                        symbol=row[0],
                        source=row[1],
                        affected_count=row[2],
                        suggestion=get_best_asset_suggestion(row[0], all_assets)
                    )
                    for row in missing_assets_rows
                ]
            
            # Get unique raw accounts missing account_id mapping
            if missing_account_count > 0:
                missing_accounts_query = (
                    select(
                        RawAccount.id,
                        RawAccount.label,
                        RawAccount.source,
                    )
                    .where(RawAccount.account_id.is_(None))
                    .limit(detail_limit)
                )
                missing_accounts_rows = session.exec(missing_accounts_query).all()
                
                # For each raw account, count affected transactions
                missing_accounts_detail = []
                for row in missing_accounts_rows:
                    raw_id, label, source = row
                    # Count transactions using this raw account
                    count_query = select(func.count(NormalizedTransaction.id)).where(
                        NormalizedTransaction.source == source,
                        NormalizedTransaction.source_account == label,
                        NormalizedTransaction.account_id.is_(None)
                    )
                    affected_count = session.exec(count_query).one()
                    if affected_count > 0:
                        missing_accounts_detail.append(
                            RawAccountIssue(
                                id=raw_id,
                                label=label,
                                source=source,
                                affected_count=affected_count,
                                suggestion=get_best_account_suggestion(label, all_accounts)
                            )
                        )
                response_data["missing_accounts_detail"] = missing_accounts_detail[:detail_limit]
            
            # Get unique raw assets missing price_quote_asset_id (only when price > 0)
            if missing_price_quote_count > 0:
                missing_price_quotes_query = (
                    select(
                        NormalizedTransaction.source_price_quote_asset_symbol,
                        NormalizedTransaction.source,
                        func.count(NormalizedTransaction.id).label('count')
                    )
                    .where(
                        NormalizedTransaction.price.isnot(None),
                        NormalizedTransaction.price > 0,
                        NormalizedTransaction.price_quote_asset_id.is_(None),
                        NormalizedTransaction.source_price_quote_asset_symbol.isnot(None)
                    )
                    .group_by(
                        NormalizedTransaction.source_price_quote_asset_symbol,
                        NormalizedTransaction.source
                    )
                    .order_by(func.count(NormalizedTransaction.id).desc())
                    .limit(detail_limit)
                )
                missing_price_quotes_rows = session.exec(missing_price_quotes_query).all()
                response_data["missing_price_quotes_detail"] = [
                    RawAssetIssue(
                        symbol=row[0],
                        source=row[1],
                        affected_count=row[2],
                        suggestion=get_best_asset_suggestion(row[0], all_assets)
                    )
                    for row in missing_price_quotes_rows
                ]
            
            # Get unique raw assets missing fee_quote_asset_id
            if missing_fee_quote_count > 0:
                missing_fee_quotes_query = (
                    select(
                        NormalizedTransaction.source_fee_quote_asset_symbol,
                        NormalizedTransaction.source,
                        func.count(NormalizedTransaction.id).label('count')
                    )
                    .where(
                        NormalizedTransaction.fee > 0,
                        NormalizedTransaction.fee_quote_asset_id.is_(None),
                        NormalizedTransaction.source_fee_quote_asset_symbol.isnot(None)
                    )
                    .group_by(
                        NormalizedTransaction.source_fee_quote_asset_symbol,
                        NormalizedTransaction.source
                    )
                    .order_by(func.count(NormalizedTransaction.id).desc())
                    .limit(detail_limit)
                )
                missing_fee_quotes_rows = session.exec(missing_fee_quotes_query).all()
                response_data["missing_fee_quotes_detail"] = [
                    RawAssetIssue(
                        symbol=row[0],
                        source=row[1],
                        affected_count=row[2],
                        suggestion=get_best_asset_suggestion(row[0], all_assets)
                    )
                    for row in missing_fee_quotes_rows
                ]
            
            # Build transaction-centric issues list
            # Query all transactions with any missing mapping, sorted by date desc
            issues_list = []
            
            # Build union of all transactions with issues
            from sqlalchemy import union_all, literal
            
            # Subquery for missing asset
            missing_asset_subq = (
                select(
                    NormalizedTransaction.id.label('tx_id'),
                    literal(IssueType.ASSET.value).label('issue_type'),
                    NormalizedTransaction.source_asset_symbol.label('raw_value'),
                )
                .where(NormalizedTransaction.asset_id.is_(None))
                .where(NormalizedTransaction.source_asset_symbol.isnot(None))
            )
            if account_id_list:
                missing_asset_subq = missing_asset_subq.where(
                    NormalizedTransaction.account_id.in_(account_id_list)
                )
            
            # Subquery for missing account
            missing_account_subq = (
                select(
                    NormalizedTransaction.id.label('tx_id'),
                    literal(IssueType.ACCOUNT.value).label('issue_type'),
                    NormalizedTransaction.source_account.label('raw_value'),
                )
                .where(NormalizedTransaction.account_id.is_(None))
                .where(NormalizedTransaction.source_account.isnot(None))
            )
            if account_id_list:
                # Account filter doesn't apply when account is missing
                pass
            
            # Subquery for missing price quote (only when price > 0)
            missing_price_quote_subq = (
                select(
                    NormalizedTransaction.id.label('tx_id'),
                    literal(IssueType.PRICE_QUOTE.value).label('issue_type'),
                    NormalizedTransaction.source_price_quote_asset_symbol.label('raw_value'),
                )
                .where(NormalizedTransaction.price.isnot(None))
                .where(NormalizedTransaction.price > 0)
                .where(NormalizedTransaction.price_quote_asset_id.is_(None))
                .where(NormalizedTransaction.source_price_quote_asset_symbol.isnot(None))
            )
            if account_id_list:
                missing_price_quote_subq = missing_price_quote_subq.where(
                    NormalizedTransaction.account_id.in_(account_id_list)
                )
            
            # Subquery for missing fee quote (only when fee > 0)
            missing_fee_quote_subq = (
                select(
                    NormalizedTransaction.id.label('tx_id'),
                    literal(IssueType.FEE_QUOTE.value).label('issue_type'),
                    NormalizedTransaction.source_fee_quote_asset_symbol.label('raw_value'),
                )
                .where(NormalizedTransaction.fee.isnot(None))
                .where(NormalizedTransaction.fee > 0)
                .where(NormalizedTransaction.fee_quote_asset_id.is_(None))
                .where(NormalizedTransaction.source_fee_quote_asset_symbol.isnot(None))
            )
            if account_id_list:
                missing_fee_quote_subq = missing_fee_quote_subq.where(
                    NormalizedTransaction.account_id.in_(account_id_list)
                )
            
            # Union all issues
            issues_union = union_all(
                missing_asset_subq,
                missing_account_subq,
                missing_price_quote_subq,
                missing_fee_quote_subq,
            ).subquery()
            
            # Count total issues for pagination
            total_issues_query = select(func.count()).select_from(issues_union)
            issues_total_count = session.exec(total_issues_query).one()
            
            # Get paginated issues with transaction details
            offset = (issues_page - 1) * issues_per_page
            issues_query = (
                select(
                    NormalizedTransaction.id,
                    NormalizedTransaction.date_time,
                    NormalizedTransaction.direction,
                    NormalizedTransaction.quantity,
                    NormalizedTransaction.source_asset_symbol,
                    NormalizedTransaction.source,
                    issues_union.c.issue_type,
                    issues_union.c.raw_value,
                )
                .join(issues_union, NormalizedTransaction.id == issues_union.c.tx_id)
                .order_by(NormalizedTransaction.date_time.desc())
                .offset(offset)
                .limit(issues_per_page)
            )
            issues_rows = session.exec(issues_query).all()
            
            # Build TransactionIssue objects with suggestions
            for row in issues_rows:
                tx_id, date_time, direction, quantity, source_asset_symbol, source, issue_type, raw_value = row
                
                # Get suggestion based on issue type
                suggestion = None
                if raw_value:
                    if issue_type in (IssueType.ASSET.value, IssueType.PRICE_QUOTE.value, IssueType.FEE_QUOTE.value):
                        suggestion = get_best_asset_suggestion(raw_value, all_assets)
                    elif issue_type == IssueType.ACCOUNT.value:
                        suggestion = get_best_account_suggestion(raw_value, all_accounts)
                
                issues_list.append(TransactionIssue(
                    transaction_id=tx_id,
                    date_time=date_time.isoformat() if date_time else "",
                    direction=direction or "unknown",
                    quantity=float(quantity) if quantity else 0.0,
                    source_asset_symbol=source_asset_symbol or "",
                    source=source or "",
                    issue_type=IssueType(issue_type),
                    raw_value=raw_value or "",
                    suggestion=suggestion,
                ))
            
            response_data["issues_list"] = issues_list
            response_data["issues_total_count"] = issues_total_count
            response_data["issues_page"] = issues_page
            response_data["issues_per_page"] = issues_per_page
        
        return DataHealthCheckResponse(**response_data)
        
    except Exception as e:
        print(f"Error fetching data health check: {e}")
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("", response_model=List[TransactionResponse])
def list_transactions(
    review_status: Optional[str] = Query(
        None, description="Filter by review status (valid/pending/invalid)"
    ),
    taxability: Optional[str] = Query(
        None, description="Filter by taxability status (taxable/non_taxable/unknown)"
    ),
    source: Optional[str] = Query(None, description="Filter by source (comma-separated for multiple)"),
    account_id: Optional[str] = Query(None, description="Filter by account IDs (comma-separated for multiple)"),
    unit_id: Optional[int] = Query(None, description="Filter by unit ID"),
    # New filter parameters
    date_from: Optional[str] = Query(None, description="Filter transactions from this date (ISO format)"),
    date_to: Optional[str] = Query(None, description="Filter transactions until this date (ISO format)"),
    asset_id: Optional[str] = Query(None, description="Filter by asset IDs (comma-separated for multiple)"),
    category_id: Optional[str] = Query(None, description="Filter by category IDs (comma-separated for multiple)"),
    transaction_type: Optional[str] = Query(None, description="Filter by transaction type (comma-separated for multiple)"),
    direction: Optional[str] = Query(None, description="Filter by direction (comma-separated for multiple)"),
    limit: int = Query(5000, ge=1, le=10000, description="Maximum number of results"),
    offset: int = Query(0, ge=0, description="Number of results to skip"),
    session: Session = Depends(get_db),
):
    """
    List all normalized transactions with optional filtering.

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
        # Build query with filters
        statement = select(NormalizedTransaction).options(
            joinedload(NormalizedTransaction.asset),
            joinedload(NormalizedTransaction.price_quote_asset),
            joinedload(NormalizedTransaction.fee_quote_asset),
            joinedload(NormalizedTransaction.account_rel),
            joinedload(NormalizedTransaction.from_account),
            joinedload(NormalizedTransaction.to_account),
        )

        if review_status:
            statement = statement.where(NormalizedTransaction.review_status == review_status)

        if taxability:
            statement = statement.where(
                NormalizedTransaction.taxability_status == taxability
            )

        if source:
            source_list = [s.strip() for s in source.split(',') if s.strip()]
            if len(source_list) == 1:
                statement = statement.where(NormalizedTransaction.source == source_list[0])
            elif len(source_list) > 1:
                statement = statement.where(NormalizedTransaction.source.in_(source_list))

        if account_id:
            account_ids = [int(a.strip()) for a in account_id.split(',') if a.strip().isdigit()]
            if len(account_ids) == 1:
                statement = statement.where(NormalizedTransaction.account_id == account_ids[0])
            elif len(account_ids) > 1:
                statement = statement.where(NormalizedTransaction.account_id.in_(account_ids))

        if unit_id is not None:
            statement = statement.where(NormalizedTransaction.user_calculation_unit_id == unit_id)

        # Date range filters
        if date_from:
            try:
                from_dt = datetime.fromisoformat(date_from.replace('Z', '+00:00'))
                statement = statement.where(NormalizedTransaction.date_time >= from_dt)
            except ValueError:
                pass  # Invalid date format, skip filter

        if date_to:
            try:
                to_dt = datetime.fromisoformat(date_to.replace('Z', '+00:00'))
                statement = statement.where(NormalizedTransaction.date_time <= to_dt)
            except ValueError:
                pass  # Invalid date format, skip filter

        # Asset filter (multi-select)
        if asset_id:
            asset_ids = [int(a.strip()) for a in asset_id.split(',') if a.strip().isdigit()]
            if len(asset_ids) == 1:
                statement = statement.where(NormalizedTransaction.asset_id == asset_ids[0])
            elif len(asset_ids) > 1:
                statement = statement.where(NormalizedTransaction.asset_id.in_(asset_ids))

        # Category filter (multi-select) - filter by assets that belong to the category
        if category_id:
            from backend.db.models import AssetCategory
            category_ids = [int(c.strip()) for c in category_id.split(',') if c.strip().isdigit()]
            if category_ids:
                # Subquery to get asset IDs that belong to any of the selected categories
                asset_subquery = select(AssetCategory.asset_id).where(
                    AssetCategory.category_id.in_(category_ids)
                ).distinct()
                statement = statement.where(NormalizedTransaction.asset_id.in_(asset_subquery))

        # Transaction type filter (multi-select)
        if transaction_type:
            types = [t.strip() for t in transaction_type.split(',') if t.strip()]
            if len(types) == 1:
                statement = statement.where(NormalizedTransaction.transaction_type == types[0])
            elif len(types) > 1:
                statement = statement.where(NormalizedTransaction.transaction_type.in_(types))

        # Direction filter (multi-select)
        if direction:
            directions = [d.strip() for d in direction.split(',') if d.strip()]
            if len(directions) == 1:
                statement = statement.where(NormalizedTransaction.direction == directions[0])
            elif len(directions) > 1:
                statement = statement.where(NormalizedTransaction.direction.in_(directions))

        statement = (
            statement.order_by(NormalizedTransaction.date_time.desc())
            .offset(offset)
            .limit(limit)
        )

        transactions = session.exec(statement).all()

        # Build response with linked asset symbols
        return [_build_transaction_response(tx, session) for tx in transactions]

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
                joinedload(NormalizedTransaction.account_rel),
                joinedload(NormalizedTransaction.from_account),
                joinedload(NormalizedTransaction.to_account),
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


@router.get("/tags", response_model=List[Dict[str, str]])
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

        tx.status = request.status
        if request.taxability_status:
            tx.taxability_status = request.taxability_status

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
    try:
        statement = (
            select(NormalizedTransaction)
            .options(
                joinedload(NormalizedTransaction.asset),
                joinedload(NormalizedTransaction.price_quote_asset),
                joinedload(NormalizedTransaction.fee_quote_asset),
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
        print(f"DEBUG: Updating transaction {transaction_id} with data: {update_data}")
        
        for key, value in update_data.items():
            setattr(tx, key, value)

        session.add(tx)
        session.commit()
        session.refresh(tx)

        return _build_transaction_response(tx, session)

    except HTTPException:
        raise
    except Exception as e:
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
            disposal_taxable=transaction.disposal_taxable,
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

    if not request.review_status and not request.transaction_type:
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
                tx.review_status = request.review_status
            if request.transaction_type:
                tx.transaction_type = request.transaction_type

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

        for tx_id in request.transaction_ids:
            tx = session.get(NormalizedTransaction, tx_id)
            if not tx:
                errors.append(f"Transaction {tx_id} not found")
                continue

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
                    "date_time": t.date_time.isoformat() if t.date_time else None,
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
