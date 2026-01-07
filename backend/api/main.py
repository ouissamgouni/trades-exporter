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
    fixtures,
)
from backend.config.loader import get_database_url
from backend.db import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup and shutdown events."""
    # Log current database connection
    db_url = get_database_url()
    # Mask password in log output
    masked_url = db_url.replace(db_url.split('@')[0].split(':')[-1], '****') if '@' in db_url else db_url
    print(f"🚀 Trade Exporter API starting")
    print(f"   Database: {masked_url}")

    # Initialize database (creates tables + seeds default data)
    init_db()

    yield
    # Shutdown: nothing to do - connections are closed per-request


app = FastAPI(
    title="Trade Exporter API",
    description="API for managing and reviewing cryptocurrency transactions",
    version="1.0.0",
    lifespan=lifespan,
    redirect_slashes=True,  # Redirect /path to /path/ (consistent trailing slashes)
)

# Configure CORS
# Get allowed origins from environment, default to allowing all in dev
cors_origins_env = os.environ.get("CORS_ORIGINS", "*")
if cors_origins_env == "*":
    allow_origins = ["*"]
else:
    allow_origins = [origin.strip() for origin in cors_origins_env.split(",")]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
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
app.include_router(fixtures.router)


@app.get("/")
def root():
    """API root endpoint"""
    return {
        "name": "Trade Exporter API",
        "version": "1.0.0",
        "docs": "/docs",
        "openapi": "/openapi.json",
    }


@app.get("/api/v1/health")
def health_check():
    """Health check endpoint for Docker/load balancer health probes"""
    return {"status": "healthy"}
