"""
Utilities for E2E testing.
Provides helpers for database setup, test data loading, and verification.
Uses PostgreSQL with SQLModel.
"""

import os
import json
from typing import List, Dict, Any, Optional
from contextlib import contextmanager

from sqlmodel import Session

from backend.config.loader import set_test_mode
from backend.db.database import get_engine, init_db
from backend.db.models import NormalizedTransaction, RawTransaction
from backend.db.repositories import (
    NormalizedTransactionRepository,
)


class E2EDatabaseManager:
    """Manages test database lifecycle for E2E tests using PostgreSQL."""

    def __init__(self):
        """Initialize test database manager."""
        self._session: Optional[Session] = None
        self._engine = None

    def setup(self):
        """
        Setup test database with schema.
        Ensures TEST_MODE is set and initializes PostgreSQL tables.
        """
        # Ensure test mode is active
        os.environ["TEST_MODE"] = "true"
        set_test_mode(True)

        # Initialize test database
        init_db()

        # Get engine for test database
        self._engine = get_engine(test_mode=True)

    def teardown(self):
        """Clean up test database session."""
        if self._session:
            self._session.close()
            self._session = None

    @property
    def session(self) -> Session:
        """Get or create a database session."""
        if self._session is None:
            self._session = Session(self._engine)
        return self._session

    def count_records(self, table_name: str) -> int:
        """
        Count records in a table.

        Args:
            table_name: Name of the table

        Returns:
            int: Number of records
        """
        from sqlalchemy import text

        result = self.session.execute(text(f"SELECT COUNT(*) FROM {table_name}"))
        return result.scalar()

    def get_normalized_transactions(self) -> List[NormalizedTransaction]:
        """
        Get all normalized transactions from the database.

        Returns:
            List of NormalizedTransaction SQLModel objects
        """
        repo = NormalizedTransactionRepository(self.session)
        return repo.list_all(limit=1000)

    def get_raw_transactions(self) -> List[RawTransaction]:
        """
        Get all raw transactions from the database.

        Returns:
            List of RawTransaction SQLModel objects
        """
        from sqlmodel import select

        statement = select(RawTransaction)
        return list(self.session.exec(statement).all())

    def verify_normalized_structure(self, transaction: NormalizedTransaction) -> bool:
        """
        Verify that a normalized transaction has the expected structure.

        Args:
            transaction: NormalizedTransaction SQLModel object

        Returns:
            bool: True if structure is valid
        """
        required_fields = [
            "source",
            "source_transaction_id",
            "date_time",
            "transaction_type",
        ]

        return all(
            getattr(transaction, field, None) is not None for field in required_fields
        )

    def clear_tables(self):
        """Clear all test data from tables."""
        from sqlalchemy import text

        tables = [
            "normalized_transactions",
            "raw_transactions",
            "raw_assets",
            "assets",
            "groups",
        ]
        for table in tables:
            try:
                self.session.execute(text(f"TRUNCATE TABLE {table} CASCADE"))
            except Exception:
                pass  # Table may not exist
        self.session.commit()


@contextmanager
def e2e_database():
    """
    Context manager for test database.

    Usage:
        with e2e_database() as db_manager:
            # Use db_manager for testing
            pass
        # Database session is automatically closed
    """
    manager = E2EDatabaseManager()
    manager.setup()
    try:
        yield manager
    finally:
        manager.teardown()


def load_expected_output(
    fixture_name: str, fixtures_dir: str = None
) -> List[Dict[str, Any]]:
    """
    Load expected normalized output from fixture file.

    Args:
        fixture_name: Name of the fixture file (e.g., 'binance_expected.json')
        fixtures_dir: Path to fixtures directory (defaults to tests/e2e/expected_outputs)

    Returns:
        List of expected normalized transactions
    """
    if fixtures_dir is None:
        # Default to expected_outputs directory
        script_dir = os.path.dirname(os.path.abspath(__file__))
        fixtures_dir = os.path.join(script_dir, "expected_outputs")

    fixture_path = os.path.join(fixtures_dir, fixture_name)

    with open(fixture_path, "r") as f:
        return json.load(f)


def assert_normalized_matches_expected(
    actual: List[NormalizedTransaction],
    expected: List[Dict[str, Any]],
    ignore_fields: Optional[List[str]] = None,
):
    """
    Assert that actual normalized transactions match expected output.

    Args:
        actual: Actual NormalizedTransaction SQLModel objects
        expected: Expected normalized transactions as dictionaries
        ignore_fields: List of field names to ignore in comparison
    """
    if ignore_fields is None:
        ignore_fields = [
            "id",
            "created_at",
            "updated_at",
            "synced_at",
            "raw_transaction_id",
        ]

    assert len(actual) == len(expected), (
        f"Transaction count mismatch: expected {len(expected)}, got {len(actual)}"
    )

    for i, (act, exp) in enumerate(zip(actual, expected)):
        for key in exp.keys():
            if key not in ignore_fields:
                act_val = getattr(act, key, None)
                assert act_val == exp[key], (
                    f"Transaction {i}: field '{key}' mismatch: "
                    f"expected {exp[key]}, got {act_val}"
                )
