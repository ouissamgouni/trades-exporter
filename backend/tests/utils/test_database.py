"""
Test database utilities for integration tests.
"""

import os
import logging
import tempfile
import shutil
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def test_database_context():
    """
    Context manager that provides isolated test database.
    Creates temporary database file with both raw and normalized tables.
    Uses environment variable to ensure all database instances use the test database.
    """
    import sqlite3

    # Create temporary directory for test database
    temp_dir = tempfile.mkdtemp(prefix="trades_test_db_")
    temp_path = Path(temp_dir)

    # Single database file for both raw and normalized tables
    test_db_path = temp_path / "test_trades.db"

    # Store original environment variable
    original_db_path = os.environ.get("TRADES_DB_PATH")

    try:
        # Set environment variable to force all database instances to use test database
        os.environ["TRADES_DB_PATH"] = str(test_db_path)

        # Create and initialize the database with proper settings for concurrent access
        conn = sqlite3.connect(str(test_db_path), timeout=30.0)
        conn.execute(
            "PRAGMA journal_mode=WAL"
        )  # Enable WAL mode for better concurrency
        conn.execute("PRAGMA synchronous=NORMAL")  # Balance between safety and speed
        conn.execute(
            "PRAGMA busy_timeout=30000"
        )  # 30 second timeout for locked database

        # Initialize both tables by creating temporary instances
        try:
            # Import here to avoid circular imports
            from backend.db.raw_transaction_db import RawTransactionDB
            from backend.db.normalized_transactions_db import (
                NormalizedTransactionDB,
            )

            # Create instances to initialize tables, then close them immediately
            temp_raw = RawTransactionDB(db_path=str(test_db_path))
            temp_norm = NormalizedTransactionDB(db_path=str(test_db_path))
            temp_raw.close()
            temp_norm.close()
        except Exception as e:
            logging.warning(f"Could not initialize database tables: {e}")

        conn.close()

        yield {"db_path": test_db_path, "temp_dir": temp_dir}

    finally:
        # Restore original environment variable
        if original_db_path is not None:
            os.environ["TRADES_DB_PATH"] = original_db_path
        elif "TRADES_DB_PATH" in os.environ:
            del os.environ["TRADES_DB_PATH"]

        # Remove temporary directory (with retry for locked files)
        import time

        for attempt in range(3):
            try:
                shutil.rmtree(temp_dir)
                break
            except (OSError, PermissionError):
                if attempt < 2:
                    time.sleep(0.1)  # Brief pause before retry
                    continue
                # Final attempt, ignore errors
                try:
                    shutil.rmtree(temp_dir, ignore_errors=True)
                except Exception:
                    pass


@contextmanager
def mock_database_context():
    """
    Context manager that mocks database operations.
    No actual database files are created.
    """
    from unittest.mock import patch, MagicMock

    mock_raw_db = MagicMock()
    mock_norm_db = MagicMock()

    # Configure mocks to return reasonable values
    mock_raw_db.insert_raw_transaction.return_value = 1
    mock_norm_db.insert_normalized_transaction.return_value = 1
    mock_norm_db.exists.return_value = False

    with (
        patch(
            "backend.core.raw_transaction_db.RawTransactionDB",
            return_value=mock_raw_db,
        ),
        patch(
            "backend.core.normalized_transaction_db.NormalizedTransactionDB",
            return_value=mock_norm_db,
        ),
    ):
        yield {"raw_db": mock_raw_db, "norm_db": mock_norm_db}
