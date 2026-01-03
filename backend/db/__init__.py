# DB package for backend
"""
Database initialization module.

Provides:
- SQLModel ORM models (backend.db.models)
- Database connection management (backend.db.database)
- Repository classes for CRUD operations (backend.db.repositories)
- Database seeding for accounts and connectors (backend.db.seed)
"""

from backend.config.loader import configure_logging
from backend.db.database import get_session, get_db, DatabaseManager
from backend.db.models import (
    Account,
    AccountConnector,
    Asset,
    PriceSnapshot,
    RawAsset,
    RawAccount,
    RawTransaction,
    NormalizedTransaction,
    CalculationUnit,
    CalculationVersion,
    CostLot,
    RealizedPnl,
    FeeEntry,
)
from backend.db.repositories import (
    AssetRepository,
    RawAssetRepository,
    RawTransactionRepository,
    NormalizedTransactionRepository,
)

log = configure_logging("db_init")


def init_db(test_mode: bool = None):
    """
    Initialize the PostgreSQL database: create tables and seed default data.

    Args:
        test_mode: Override test mode. If None, uses environment variable.
    """
    from backend.db.database import init_db as _init_db, get_database_url
    from backend.db.seed import seed_database

    db_url = get_database_url(test_mode)
    # Mask password in log
    safe_url = db_url.split("@")[-1] if "@" in db_url else db_url
    log.info("db_init_started", db_host=safe_url)

    try:
        _init_db()
        log.info("db_tables_initialized")

        # Seed is idempotent - safe to call every time
        seed_database()

    except Exception as e:
        log.exception("db_init_failed", error=str(e))
        raise


__all__ = [
    # Initialization
    "init_db",
    # Database session management
    "get_session",
    "get_db",
    "DatabaseManager",
    # Models
    "Account",
    "AccountConnector",
    "Asset",
    "PriceSnapshot",
    "RawAsset",
    "RawAccount",
    "RawTransaction",
    "NormalizedTransaction",
    "Bundle",
    "CalculationVersion",
    "CostLot",
    "RealizedPnl",
    "UnrealizedPnl",
    # Repositories
    "AssetRepository",
    "RawAssetRepository",
    "RawTransactionRepository",
    "NormalizedTransactionRepository",
]
