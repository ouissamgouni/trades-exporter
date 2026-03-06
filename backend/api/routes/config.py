"""
Config endpoints for the Trade Exporter API.
Provides endpoints for retrieving application configuration and status.
"""

import os
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select, func

from backend.db.database import get_db
from backend.db.models import Account, Asset, AssetPriceGetter, AccountConnector, AppSettings


router = APIRouter(prefix="/config", tags=["Config"])


class AppInfoResponse(BaseModel):
    """Response model for application information."""

    environment: str
    backend_version: str
    frontend_version: str | None = None
    db_schema_version: str | None = None


class AppSettingsResponse(BaseModel):
    """Response model for app settings."""

    base_currency: str
    mock_mode_enabled: bool = False


class AppSettingsUpdate(BaseModel):
    """Request model for updating app settings."""

    base_currency: str | None = None
    mock_mode_enabled: bool | None = None


class SetupStatusResponse(BaseModel):
    """Response model for setup completion status."""

    accounts_configured: bool
    accounts_count: int
    connectors_configured: bool
    connectors_count: int
    assets_configured: bool
    assets_count: int
    base_currency_set: bool
    base_currency_symbol: str | None
    setup_complete: bool
    pending_items: list[str]


def get_or_create_app_settings(session: Session) -> AppSettings:
    """Get app settings from database, creating default if not exists."""
    settings = session.get(AppSettings, 1)
    if not settings:
        settings = AppSettings(id=1, base_currency="EUR")
        session.add(settings)
        session.commit()
        session.refresh(settings)
    return settings


@router.get("/info", response_model=AppInfoResponse)
def get_app_info():
    """
    Get application information including environment and versions.

    Returns:
    - environment: Current environment (dev/test/prod) from ENV_NAME
    - backend_version: Backend API version
    - frontend_version: Frontend app version (if available)
    - db_schema_version: Database schema version from Alembic (if available)
    """
    environment = os.getenv("ENV_NAME", "unknown")
    backend_version = "1.0.0"  # From backend/__init__.py or main.py
    
    # TODO: Add database schema version from Alembic if needed
    # from alembic import script
    # from alembic.runtime import migration
    
    return AppInfoResponse(
        environment=environment,
        backend_version=backend_version,
        frontend_version=None,
        db_schema_version=None,
    )


@router.get("/settings", response_model=AppSettingsResponse)
def get_app_settings(session: Session = Depends(get_db)):
    """
    Get application settings.
    
    Returns the base currency and other app-wide settings.
    """
    settings = get_or_create_app_settings(session)
    return AppSettingsResponse(
        base_currency=settings.base_currency,
        mock_mode_enabled=settings.mock_mode_enabled,
    )


@router.put("/settings", response_model=AppSettingsResponse)
def update_app_settings(
    update: AppSettingsUpdate,
    session: Session = Depends(get_db)
):
    """
    Update application settings.
    
    Allows updating:
    - base_currency: The default currency for P&L calculations
    """
    settings = get_or_create_app_settings(session)
    
    if update.base_currency is not None:
        # Validate that the currency exists as an asset
        currency_asset = session.exec(
            select(Asset).where(Asset.symbol == update.base_currency.upper())
        ).first()
        
        if not currency_asset:
            raise HTTPException(
                status_code=400,
                detail=f"Currency '{update.base_currency}' not found in assets. "
                       f"Add it as a fiat asset first."
            )
        
        settings.base_currency = update.base_currency.upper()
    
    # Handle mock mode toggle — bulk-flip all mock getter rows
    if update.mock_mode_enabled is not None:
        settings.mock_mode_enabled = update.mock_mode_enabled
        mock_getters = session.exec(
            select(AssetPriceGetter).where(AssetPriceGetter.price_getter == "mock")
        ).all()
        for mg in mock_getters:
            mg.enabled = update.mock_mode_enabled
            session.add(mg)

    from datetime import datetime, timezone
    settings.updated_at = datetime.now(timezone.utc)
    
    session.add(settings)
    session.commit()
    session.refresh(settings)
    
    return AppSettingsResponse(
        base_currency=settings.base_currency,
        mock_mode_enabled=settings.mock_mode_enabled,
    )


@router.get("/setup-status", response_model=SetupStatusResponse)
def get_setup_status(session: Session = Depends(get_db)):
    """
    Get the setup completion status.
    
    Checks if user has configured:
    - At least one account
    - At least one connector
    - At least one asset
    - Base currency for P&L (EUR is default)
    
    Returns setup checklist status.
    """
    # Count accounts
    accounts_count = session.exec(select(func.count(Account.id))).one()
    
    # Count connectors
    connectors_count = session.exec(select(func.count(AccountConnector.id))).one()
    
    # Count assets
    assets_count = session.exec(select(func.count(Asset.asset_id))).one()
    
    # Check for EUR or USD (common base currencies)
    base_currency = session.exec(
        select(Asset).where(Asset.symbol.in_(["EUR", "USD"]))
    ).first()
    
    # Determine what's pending
    pending = []
    if accounts_count == 0:
        pending.append("Configure at least one account")
    if connectors_count == 0:
        pending.append("Configure at least one connector")
    if assets_count == 0:
        pending.append("Configure assets")
    if not base_currency:
        pending.append("Add base currency (EUR or USD)")
    
    return SetupStatusResponse(
        accounts_configured=accounts_count > 0,
        accounts_count=accounts_count,
        connectors_configured=connectors_count > 0,
        connectors_count=connectors_count,
        assets_configured=assets_count > 0,
        assets_count=assets_count,
        base_currency_set=base_currency is not None,
        base_currency_symbol=base_currency.symbol if base_currency else None,
        setup_complete=len(pending) == 0,
        pending_items=pending,
    )
