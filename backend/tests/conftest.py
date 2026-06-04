"""
Pytest configuration for backend tests.

Provides fixtures for:
- PostgreSQL test database sessions (for integration tests)
- Temporary file paths

IMPORTANT: All tests using real databases should be marked with @pytest.mark.integration
and should NEVER use the dev or production database.

Integration tests use TEST_DATABASE_URL environment variable (set via Taskfile).
Run integration tests with: task test:int:local
"""

import os
import pytest
from pathlib import Path
from sqlmodel import Session, SQLModel, create_engine


# Load .env file from project root
def load_env_file():
    """Load .env file from project root if it exists."""
    try:
        from dotenv import load_dotenv

        # Find .env in project root (3 levels up from tests/)
        env_path = Path(__file__).parent.parent.parent / ".env"
        if env_path.exists():
            load_dotenv(env_path)
    except ImportError:
        # python-dotenv not installed, environment variables must be set manually
        pass


# Load environment on module import
load_env_file()


# =============================================================================
# PostgreSQL Fixtures (Integration Tests Only)
# =============================================================================
# These fixtures use a dedicated integration test database (trades_db_integ).
# Set up with: task db:setup:integ
# Run with: task test:int:local
#
# The TEST_DATABASE_URL environment variable must point to trades_db_integ.
# This ensures integration tests NEVER touch dev or production databases.
#
# Usage:
#   @pytest.mark.integration
#   def test_something(pg_session):
#       # Your test with real database
#
# NEVER use these fixtures for unit tests - unit tests should mock Session objects.
# =============================================================================


@pytest.fixture(scope="function")
def pg_session():
    """
    Create a PostgreSQL session for integration tests.

    Uses TEST_DATABASE_URL environment variable to connect to trades_db_integ.
    This fixture does NOT create/drop tables - the database should be set up
    via 'task db:setup:integ' before running integration tests.

    SAFETY: Uses dedicated trades_db_integ database and will NEVER
    touch your dev or production database when run via Taskfile.

    Usage:
        @pytest.mark.integration
        def test_database_query(pg_session):
            account = Account(name="Test")
            pg_session.add(account)
            pg_session.commit()
    """
    # Get test database URL from environment (set by Taskfile)
    test_db_url = os.getenv("TEST_DATABASE_URL")

    if not test_db_url:
        pytest.skip(
            "TEST_DATABASE_URL not set. Run integration tests with: task test:int:local"
        )

    # Create engine for integration test database
    engine = create_engine(test_db_url, echo=False)

    # Use transaction rollback for test isolation
    connection = engine.connect()
    transaction = connection.begin()
    session = Session(bind=connection)

    yield session

    # Rollback transaction - leaves database clean for next test
    session.close()
    transaction.rollback()
    connection.close()
    engine.dispose()


# =============================================================================
# Safety Validation (Prevent App Database Access)
# =============================================================================


def _redact_database_url(value: str) -> str:
    if "://" not in value or "@" not in value:
        return value
    scheme, rest = value.split("://", 1)
    host_part = rest.rsplit("@", 1)[1]
    return f"{scheme}://***:***@{host_part}"


def pytest_configure(config):
    """
    Pytest hook to validate configuration and prevent accidental app DB usage.
    """
    database_url = os.getenv("DATABASE_URL", "")
    test_db_url = os.getenv("TEST_DATABASE_URL", "")
    postgres_db = os.getenv("POSTGRES_DB", "")

    dangerous_url_names = [
        "trades_db_dev",
        "trades_db_staging",
        "trades_db_prod",
        "trades_db_production",
    ]
    dangerous_postgres_names = [
        "trades_db_staging",
        "trades_db_prod",
        "trades_db_production",
    ]

    for env_name, value in [
        ("DATABASE_URL", database_url),
        ("TEST_DATABASE_URL", test_db_url),
    ]:
        matched = next((name for name in dangerous_url_names if name in value), None)
        if matched:
            pytest.exit(
                f"DANGER: {env_name} points to an application database ({matched}).\n"
                f"Found: {_redact_database_url(value)}\n"
                "Tests that need PostgreSQL must use the dedicated trades_db_integ database.",
                returncode=4,
            )

    if postgres_db in dangerous_postgres_names and not database_url:
        pytest.exit(
            f"DANGER: POSTGRES_DB points to an application database ({postgres_db}).\n"
            "Set TEST_DATABASE_URL/DATABASE_URL to trades_db_integ before running DB-backed tests.",
            returncode=4,
        )
