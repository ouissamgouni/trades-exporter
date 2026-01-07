"""
Raw Accounts endpoints for the Trade Exporter API.
Maps source-specific account labels/addresses to normalized accounts.
"""

from fastapi import APIRouter, HTTPException, Query, Depends
from typing import List, Optional
from pydantic import BaseModel, Field
from sqlmodel import Session, select
from sqlalchemy import update

from backend.db.database import get_db
from backend.db.models import RawAccount, NormalizedTransaction

router = APIRouter(prefix="/raw-accounts", tags=["Raw Accounts"])


class RawAccountCreate(BaseModel):
    """Request model for creating a raw account."""

    source: str
    label: str
    account_id: Optional[int] = None


class RawAccountUpdate(BaseModel):
    """Request model for updating a raw account."""

    account_id: Optional[int] = None


class RawAccountResponse(BaseModel):
    """Response model for raw account."""

    id: int
    source: str
    label: str
    account_id: Optional[int] = None


class BulkMapAccountItem(BaseModel):
    """Single item for bulk account mapping."""
    raw_account_id: int = Field(..., description="Raw account ID")
    account_id: int = Field(..., description="Target account_id to map to")


class BulkMapAccountRequest(BaseModel):
    """Request model for bulk account mapping."""
    mappings: List[BulkMapAccountItem] = Field(..., description="List of mappings to apply")


class BulkMapAccountResponse(BaseModel):
    """Response model for bulk mapping operations."""
    success_count: int = Field(..., description="Number of successful mappings")
    failed_count: int = Field(..., description="Number of failed mappings")
    errors: List[str] = Field(default_factory=list, description="Error messages for failed mappings")


@router.post("/bulk-map", response_model=BulkMapAccountResponse)
def bulk_map_accounts(
    request: BulkMapAccountRequest,
    session: Session = Depends(get_db),
):
    """
    Bulk map multiple raw accounts to normalized accounts.
    
    Each mapping updates the raw_account record and propagates to all linked transactions.
    Used by "Apply All Suggestions" feature in Data Health Check.
    """
    success_count = 0
    failed_count = 0
    errors = []
    
    try:
        for item in request.mappings:
            try:
                # Find the raw account by ID
                raw_account = session.get(RawAccount, item.raw_account_id)
                
                if not raw_account:
                    failed_count += 1
                    errors.append(f"Raw account ID {item.raw_account_id} not found")
                    continue
                
                source = raw_account.source
                label = raw_account.label
                raw_account.account_id = item.account_id
                
                # Propagate to transactions
                # Update from_account_id for transactions matching source_from_account
                stmt_from = (
                    update(NormalizedTransaction)
                    .where(
                        NormalizedTransaction.source == source,
                        NormalizedTransaction.source_from_account == label,
                    )
                    .values(from_account_id=item.account_id)
                )
                session.exec(stmt_from)
                
                # Update to_account_id for transactions matching source_to_account
                stmt_to = (
                    update(NormalizedTransaction)
                    .where(
                        NormalizedTransaction.source == source,
                        NormalizedTransaction.source_to_account == label,
                    )
                    .values(to_account_id=item.account_id)
                )
                session.exec(stmt_to)
                
                # Update account_id for transactions matching source_account
                stmt_account = (
                    update(NormalizedTransaction)
                    .where(
                        NormalizedTransaction.source == source,
                        NormalizedTransaction.source_account == label,
                    )
                    .values(account_id=item.account_id)
                )
                session.exec(stmt_account)
                
                success_count += 1
                
            except Exception as e:
                failed_count += 1
                errors.append(f"Raw account ID {item.raw_account_id}: {str(e)}")
        
        session.commit()
        
        return BulkMapAccountResponse(
            success_count=success_count,
            failed_count=failed_count,
            errors=errors
        )
        
    except Exception as e:
        session.rollback()
        raise HTTPException(status_code=500, detail=f"Bulk mapping failed: {str(e)}")


@router.get("", response_model=List[RawAccountResponse])
def list_raw_accounts(
    source: Optional[str] = Query(None, description="Filter by source"),
    has_account_id: Optional[bool] = Query(
        None, description="Filter by whether account_id is set"
    ),
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of results"),
    offset: int = Query(0, ge=0, description="Number of results to skip"),
    session: Session = Depends(get_db),
):
    """
    List raw accounts with optional filtering.

    - **source**: Filter by source exchange/platform
    - **has_account_id**: Filter by whether account_id is linked
    - **limit**: Maximum number of results to return
    - **offset**: Number of results to skip for pagination
    """
    try:
        statement = select(RawAccount)

        if source:
            statement = statement.where(RawAccount.source == source)

        if has_account_id is True:
            statement = statement.where(RawAccount.account_id != None)
        elif has_account_id is False:
            statement = statement.where(RawAccount.account_id == None)

        statement = (
            statement.order_by(RawAccount.source, RawAccount.label)
            .offset(offset)
            .limit(limit)
        )

        raw_accounts = session.exec(statement).all()

        return [
            RawAccountResponse(
                id=ra.id,
                source=ra.source,
                label=ra.label,
                account_id=ra.account_id,
            )
            for ra in raw_accounts
        ]

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/count")
def count_raw_accounts(
    source: Optional[str] = Query(None, description="Filter by source"),
    has_account_id: Optional[bool] = Query(
        None, description="Filter by whether account_id is set"
    ),
    session: Session = Depends(get_db),
):
    """
    Count raw accounts with optional filtering.
    """
    try:
        from sqlmodel import func

        statement = select(func.count()).select_from(RawAccount)

        if source:
            statement = statement.where(RawAccount.source == source)

        if has_account_id is True:
            statement = statement.where(RawAccount.account_id != None)
        elif has_account_id is False:
            statement = statement.where(RawAccount.account_id == None)

        count = session.exec(statement).one()
        return {"count": count}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.get("/{source}/{label}", response_model=RawAccountResponse)
def get_raw_account(
    source: str,
    label: str,
    session: Session = Depends(get_db),
):
    """
    Get a specific raw account by composite key.

    - **source**: Source exchange/platform name
    - **label**: Account label/address from the source
    """
    try:
        statement = select(RawAccount).where(
            RawAccount.source == source,
            RawAccount.label == label,
        )
        raw_account = session.exec(statement).first()

        if not raw_account:
            raise HTTPException(status_code=404, detail="Raw account not found")

        return RawAccountResponse(
            id=raw_account.id,
            source=raw_account.source,
            label=raw_account.label,
            account_id=raw_account.account_id,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.post("", response_model=RawAccountResponse)
def create_raw_account(
    raw_account_data: RawAccountCreate,
    session: Session = Depends(get_db),
):
    """
    Create a new raw account mapping.

    - **raw_account_data**: The raw account data to create
    """
    try:
        # Check if raw account already exists
        statement = select(RawAccount).where(
            RawAccount.source == raw_account_data.source,
            RawAccount.label == raw_account_data.label,
        )
        existing = session.exec(statement).first()

        if existing:
            raise HTTPException(
                status_code=400,
                detail=f"Raw account ({raw_account_data.source}, {raw_account_data.label}) already exists",
            )

        raw_account = RawAccount(
            source=raw_account_data.source,
            label=raw_account_data.label,
            account_id=raw_account_data.account_id,
        )

        session.add(raw_account)
        session.commit()
        session.refresh(raw_account)

        return RawAccountResponse(
            id=raw_account.id,
            source=raw_account.source,
            label=raw_account.label,
            account_id=raw_account.account_id,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.patch("/{source}/{label}", response_model=RawAccountResponse)
def update_raw_account(
    source: str,
    label: str,
    account_update: RawAccountUpdate,
    session: Session = Depends(get_db),
):
    """
    Update a raw account's account_id.
    When account_id is updated, propagates to all linked transactions.

    - **source**: Source exchange/platform name
    - **label**: Account label/address from the source
    - **update**: Fields to update
    """
    try:
        statement = select(RawAccount).where(
            RawAccount.source == source,
            RawAccount.label == label,
        )
        existing = session.exec(statement).first()

        if not existing:
            raise HTTPException(status_code=404, detail="Raw account not found")

        # Update account_id
        update_data = account_update.model_dump(exclude_unset=True)
        if "account_id" in update_data:
            new_account_id = update_data["account_id"]
            existing.account_id = new_account_id

            # Propagate account_id to transactions where this raw account is used
            # Use bulk updates for efficiency and reliability

            # Update account_id for transactions matching source_from_account
            stmt_from = (
                update(NormalizedTransaction)
                .where(
                    NormalizedTransaction.source == source,
                    NormalizedTransaction.source_from_account == label,
                )
                .values(from_account_id=new_account_id)
            )
            session.exec(stmt_from)

            # Update account_id for transactions matching source_to_account
            stmt_to = (
                update(NormalizedTransaction)
                .where(
                    NormalizedTransaction.source == source,
                    NormalizedTransaction.source_to_account == label,
                )
                .values(to_account_id=new_account_id)
            )
            session.exec(stmt_to)

            # Update account_id for transactions matching source_account (ownership)
            stmt_account = (
                update(NormalizedTransaction)
                .where(
                    NormalizedTransaction.source == source,
                    NormalizedTransaction.source_account == label,
                )
                .values(account_id=new_account_id)
            )
            session.exec(stmt_account)

        session.add(existing)
        session.commit()
        session.refresh(existing)

        return RawAccountResponse(
            id=existing.id,
            source=existing.source,
            label=existing.label,
            account_id=existing.account_id,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@router.delete("/{source}/{label}")
def delete_raw_account(
    source: str,
    label: str,
    session: Session = Depends(get_db),
):
    """
    Delete a raw account by composite key.

    - **source**: Source exchange/platform name
    - **label**: Account label/address from the source
    """
    try:
        statement = select(RawAccount).where(
            RawAccount.source == source,
            RawAccount.label == label,
        )
        existing = session.exec(statement).first()

        if not existing:
            raise HTTPException(status_code=404, detail="Raw account not found")

        session.delete(existing)
        session.commit()

        return {
            "message": "Raw account deleted successfully",
            "source": source,
            "label": label,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
