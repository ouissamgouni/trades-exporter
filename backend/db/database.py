"""
Database connection and session management for PostgreSQL using SQLModel.

This module provides:
- Database engine configuration
- Session factory and dependency injection for FastAPI
- Database initialization and table creation
- P&L invalidation via after_flush event listener
"""

import os
from collections import defaultdict
from typing import Generator
from contextlib import contextmanager

from sqlmodel import SQLModel, Session, create_engine
from sqlalchemy import event
from backend.config.loader import get_database_url, configure_logging

log = configure_logging("database")


# Global engine instance (created lazily)
_engine = None

# Whether the after_flush listener has been registered
_pnl_listener_registered = False


def get_engine():
    """
    Get or create the SQLAlchemy engine based on current environment/test mode.

    Returns:
        SQLAlchemy Engine instance
    """
    global _engine
    if _engine is None:
        database_url = get_database_url()
        _engine = create_engine(
            database_url,
            echo=os.getenv("SQL_ECHO", "false").lower() == "true",
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=10,
        )
        log.info("database_engine_created", host=database_url.split('@')[1] if '@' in database_url else 'local')
    return _engine


def init_db():
    """
    Initialize the database by creating all tables.

    Note: This only creates schema. For seeding data (assets, accounts, connectors),
    use `python -m backend.db.seed` or set SEED_DB=1 environment variable.
    """
    # Import models to ensure they are registered with SQLModel

    engine = get_engine()
    SQLModel.metadata.create_all(engine)
    log.info("database_tables_created")


def drop_all_tables():
    """
    Drop all tables. USE WITH CAUTION - mainly for testing.
    """
    engine = get_engine()
    SQLModel.metadata.drop_all(engine)
    log.warning("database_tables_dropped")


@contextmanager
def get_session() -> Generator[Session, None, None]:
    """
    Context manager for database sessions.

    Usage:
        with get_session() as session:
            session.add(model)
            session.commit()

    Yields:
        SQLModel Session
    """
    engine = get_engine()
    with Session(engine) as session:
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise


def get_session_dependency() -> Generator[Session, None, None]:
    """
    FastAPI dependency for database sessions.

    Usage in FastAPI routes:
        @app.get("/items")
        def get_items(session: Session = Depends(get_session_dependency)):
            return session.exec(select(Item)).all()

    Yields:
        SQLModel Session
    """
    engine = get_engine()
    with Session(engine) as session:
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise


# Convenience function for FastAPI Depends
def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency for getting a database session."""
    yield from get_session_dependency()


class DatabaseManager:
    """
    Database manager class for manual session management.
    Provides similar interface to the old SQLite-based DB classes.
    """

    def __init__(self):
        """
        Initialize the database manager.
        """
        self._session = None

    @property
    def session(self) -> Session:
        """Get or create a session."""
        if self._session is None:
            engine = get_engine()
            self._session = Session(engine)
        return self._session

    def commit(self):
        """Commit the current transaction."""
        if self._session:
            self._session.commit()

    def rollback(self):
        """Rollback the current transaction."""
        if self._session:
            self._session.rollback()

    def close(self):
        """Close the session."""
        if self._session:
            self._session.close()
            self._session = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type:
            self.rollback()
        else:
            self.commit()
        self.close()
        return False


# =============================================================================
# P&L Invalidation Listener
# =============================================================================

# Models whose changes should invalidate P&L results
_PNL_RELEVANT_MODELS = None  # Lazy-loaded to avoid circular imports

# Models that are P&L OUTPUT — changes to these must NOT trigger invalidation
_PNL_OUTPUT_MODELS = None


def _get_pnl_model_sets():
    """Lazy-load model sets to avoid circular imports."""
    global _PNL_RELEVANT_MODELS, _PNL_OUTPUT_MODELS
    if _PNL_RELEVANT_MODELS is None:
        from backend.db.models import (
            NormalizedTransaction, UserCalculationBundle, Asset, Account,
            AppSettings, AssetPriceGetter,
            # P&L output models (must be excluded)
            CalculationVersion, CalculationUnit, CalculationUnitLeg,
            CostLot, ConsumedLotSlice, RealizedPnl, FeeEntry,
            PnlWarning, CostLotEvent, LotSettlement,
        )
        _PNL_RELEVANT_MODELS = {
            NormalizedTransaction, UserCalculationBundle, Asset, Account,
            AppSettings, AssetPriceGetter,
        }
        _PNL_OUTPUT_MODELS = {
            CalculationVersion, CalculationUnit, CalculationUnitLeg,
            CostLot, ConsumedLotSlice, RealizedPnl, FeeEntry,
            PnlWarning, CostLotEvent, LotSettlement,
        }
    return _PNL_RELEVANT_MODELS, _PNL_OUTPUT_MODELS


def _pnl_after_flush(session, flush_context):
    """
    SQLAlchemy after_flush event listener.
    
    Inspects session.new, session.dirty, session.deleted for P&L-relevant models.
    If any are found, marks the PnLCalculationService as stale.
    
    This fires INSIDE the flush (before commit), so it catches all ORM changes
    regardless of source (API routes, sync jobs, scripts).
    """
    relevant_models, output_models = _get_pnl_model_sets()
    
    # Collect changes by model class and operation
    changes: dict[str, int] = defaultdict(int)
    
    for obj in session.new:
        model_class = type(obj)
        if model_class in relevant_models:
            changes[f"{model_class.__name__} created"] += 1
    
    for obj in session.dirty:
        model_class = type(obj)
        if model_class in relevant_models:
            # Only count truly modified objects — SQLAlchemy marks objects as
            # "dirty" even on read when defaults are populated or lazy attrs
            # are accessed.  is_modified() compares against the committed state.
            if session.is_modified(obj, include_collections=False):
                changes[f"{model_class.__name__} updated"] += 1
    
    for obj in session.deleted:
        model_class = type(obj)
        if model_class in relevant_models:
            changes[f"{model_class.__name__} deleted"] += 1
    
    if not changes:
        return
    
    # Build human-readable reason
    parts = []
    for desc, count in changes.items():
        if count > 1:
            parts.append(f"{desc} (×{count})")
        else:
            parts.append(desc)
    reason = ", ".join(parts)
    
    # Mark stale (lazy import to avoid circular dependency)
    try:
        from backend.services.pnl_calculation_service import PnLCalculationService
        service = PnLCalculationService.get_instance()
        service.mark_stale(reason)
    except Exception as e:
        # Don't let listener errors break the flush
        log.warning("pnl_invalidation_listener_error", error=str(e))


def register_pnl_invalidation_listener():
    """
    Register the after_flush event listener on the SQLAlchemy engine.
    
    Should be called once during application startup (in FastAPI lifespan).
    Idempotent — safe to call multiple times.
    """
    global _pnl_listener_registered
    if _pnl_listener_registered:
        return
    
    engine = get_engine()
    
    # Listen on Session class events — fires for ALL sessions using this engine
    from sqlalchemy.orm import Session as SASession
    event.listen(SASession, "after_flush", _pnl_after_flush)
    
    _pnl_listener_registered = True
    log.info("pnl_invalidation_listener_registered")
