"""
Database connection and session management for PostgreSQL using SQLModel.

This module provides:
- Database engine configuration
- Session factory and dependency injection for FastAPI
- Database initialization and table creation
"""

import os
from typing import Generator
from contextlib import contextmanager

from sqlmodel import SQLModel, Session, create_engine
from dotenv import load_dotenv
from backend.config.loader import get_database_url, configure_logging

# Load environment variables
load_dotenv()

log = configure_logging("database")


# Global engine instance (created lazily)
_engine = None


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

    Args:
        test_mode: Override test mode. If None, uses environment variable.
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

    Args:
        test_mode: Override test mode. If None, uses environment variable.

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

    Args:
        test_mode: Override test mode. If None, uses environment variable.

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
