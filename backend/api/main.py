"""
Trade Exporter API

FastAPI application for managing and reviewing cryptocurrency transactions.
"""

import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.routes import (
    transactions,
    bundles,
    assets,
    price_snapshots,
    raw_assets,
    raw_accounts,
    raw_transactions,
    sync_job,
    config,
    pnl,
    accounts,
    account_connectors,
    connectors,
    categories,
)
from backend.config.loader import set_test_mode, is_test_mode
from backend.db import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup and shutdown events."""
    # Startup: Set test mode from environment variable if provided
    test_mode_env = os.environ.get("TEST_MODE", "").lower()
    if test_mode_env in ("1", "true", "yes"):
        set_test_mode(True)
    elif test_mode_env in ("0", "false", "no"):
        set_test_mode(False)
    # else: use value from settings.yaml (no override)

    print(
        f"🚀 Trade Exporter API starting in {'TEST' if is_test_mode() else 'LIVE'} mode"
    )

    # Initialize database (creates tables + seeds default data)
    init_db()

    yield
    # Shutdown: nothing to do - connections are closed per-request


app = FastAPI(
    title="Trade Exporter API",
    description="API for managing and reviewing cryptocurrency transactions",
    version="1.0.0",
    lifespan=lifespan,
    redirect_slashes=False,  # Don't redirect /path/ to /path (avoid 307)
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify allowed origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(config.router)
app.include_router(transactions.router)
app.include_router(bundles.router)
app.include_router(assets.router)
app.include_router(price_snapshots.router)
app.include_router(raw_assets.router)
app.include_router(raw_accounts.router)
app.include_router(raw_transactions.router)
app.include_router(sync_job.router)
app.include_router(pnl.router)
app.include_router(accounts.router)
app.include_router(account_connectors.router)
app.include_router(connectors.router)
app.include_router(categories.router)


@app.get("/")
def root():
    """API root endpoint"""
    return {
        "name": "Trade Exporter API",
        "version": "1.0.0",
        "docs": "/docs",
        "openapi": "/openapi.json",
    }
