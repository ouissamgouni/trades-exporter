"""
Config endpoints for the Trade Exporter API.
Provides endpoints for retrieving application configuration and status.
"""

import os
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select, func

from backend.db.database import get_db
from backend.db.models import Account, Asset, AssetPriceGetter, AccountConnector, AppSettings, PriceSnapshot


router = APIRouter(prefix="/config", tags=["Config"])


class AppInfoResponse(BaseModel):
    """Response model for application information."""

    environment: str
    backend_version: str
    frontend_version: str | None = None
    db_schema_version: str | None = None
    qa_scenarios: list[str] = []


class AppSettingsResponse(BaseModel):
    """Response model for app settings."""

    base_currency: str
    mock_mode_enabled: bool = False
    # P&L default configuration
    pnl_lot_method: str = "FIFO"
    pnl_lot_mode: str = "LOT_TRAVEL"
    pnl_residual_tolerance_pct: float = 0.05
    pnl_allow_negative_balances: bool = True
    pnl_crypto_swap_taxable: bool = False
    pnl_fee_taxable: bool = False
    pnl_use_price_fallback: bool = True
    pnl_price_staleness_days: int = 7


class AppSettingsUpdate(BaseModel):
    """Request model for updating app settings."""

    base_currency: str | None = None
    mock_mode_enabled: bool | None = None
    # P&L default configuration
    pnl_lot_method: str | None = None
    pnl_lot_mode: str | None = None
    pnl_residual_tolerance_pct: float | None = None
    pnl_allow_negative_balances: bool | None = None
    pnl_crypto_swap_taxable: bool | None = None
    pnl_fee_taxable: bool | None = None
    pnl_use_price_fallback: bool | None = None
    pnl_price_staleness_days: int | None = None


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
def get_app_info(session: Session = Depends(get_db)):
    """
    Get application information including environment and versions.
    """
    environment = os.getenv("ENV_NAME", "unknown")
    backend_version = "1.0.0"

    settings = get_or_create_app_settings(session)
    qa_scenarios = [
        p["scenario"] for p in (settings.qa_test_plans or [])
        if isinstance(p, dict) and "scenario" in p
    ]

    return AppInfoResponse(
        environment=environment,
        backend_version=backend_version,
        frontend_version=None,
        db_schema_version=None,
        qa_scenarios=qa_scenarios,
    )


@router.get("/test-plan")
def get_test_plan(scenario: str, session: Session = Depends(get_db)):
    """
    Get the QA test plan for a given scenario.
    Served from test plans ingested into DB at seed time.
    """
    if not scenario:
        raise HTTPException(status_code=400, detail="scenario parameter required")

    settings = get_or_create_app_settings(session)
    for plan in (settings.qa_test_plans or []):
        if isinstance(plan, dict) and plan.get("scenario") == scenario:
            return plan

    raise HTTPException(status_code=404, detail=f"No test plan found for scenario '{scenario}'")


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
        pnl_lot_method=settings.pnl_lot_method,
        pnl_lot_mode=settings.pnl_lot_mode,
        pnl_residual_tolerance_pct=float(settings.pnl_residual_tolerance_pct),
        pnl_allow_negative_balances=settings.pnl_allow_negative_balances,
        pnl_crypto_swap_taxable=settings.pnl_crypto_swap_taxable,
        pnl_fee_taxable=settings.pnl_fee_taxable,
        pnl_use_price_fallback=settings.pnl_use_price_fallback,
        pnl_price_staleness_days=settings.pnl_price_staleness_days,
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

        # When disabling mock mode, purge cached mock price snapshots
        # so the price service doesn't keep serving stale mock prices
        if not update.mock_mode_enabled:
            mock_snapshots = session.exec(
                select(PriceSnapshot).where(PriceSnapshot.source == "mock")
            ).all()
            for snap in mock_snapshots:
                session.delete(snap)

    # Update P&L default configuration fields
    pnl_fields = [
        'pnl_lot_method', 'pnl_lot_mode', 'pnl_residual_tolerance_pct',
        'pnl_allow_negative_balances', 'pnl_crypto_swap_taxable', 'pnl_fee_taxable',
        'pnl_use_price_fallback', 'pnl_price_staleness_days',
    ]
    for field_name in pnl_fields:
        value = getattr(update, field_name, None)
        if value is not None:
            # Validate enum values
            if field_name == 'pnl_lot_method' and value not in ('FIFO', 'LIFO', 'HIFO'):
                raise HTTPException(status_code=400, detail=f"Invalid lot method: {value}")
            if field_name == 'pnl_lot_mode' and value not in ('LOT_TRAVEL', 'MEGA_WALLET'):
                raise HTTPException(status_code=400, detail=f"Invalid lot mode: {value}")
            setattr(settings, field_name, value)

    from datetime import datetime, timezone
    settings.updated_at = datetime.now(timezone.utc)
    
    session.add(settings)
    session.commit()
    session.refresh(settings)
    
    return AppSettingsResponse(
        base_currency=settings.base_currency,
        mock_mode_enabled=settings.mock_mode_enabled,
        pnl_lot_method=settings.pnl_lot_method,
        pnl_lot_mode=settings.pnl_lot_mode,
        pnl_residual_tolerance_pct=float(settings.pnl_residual_tolerance_pct),
        pnl_allow_negative_balances=settings.pnl_allow_negative_balances,
        pnl_crypto_swap_taxable=settings.pnl_crypto_swap_taxable,
        pnl_fee_taxable=settings.pnl_fee_taxable,
        pnl_use_price_fallback=settings.pnl_use_price_fallback,
        pnl_price_staleness_days=settings.pnl_price_staleness_days,
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
