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
# Safety Validation (Prevent Dev Database Access)
# =============================================================================

def pytest_configure(config):
    """
    Pytest hook to validate configuration and prevent accidental dev database usage.
    """
    # Check if TEST_DATABASE_URL is set and points to dev database
    test_db_url = os.getenv("TEST_DATABASE_URL", "")
    postgres_db = os.getenv("POSTGRES_DB", "")
    
    # Dangerous database names that should never be used for testing
    dangerous_names = ["trades_db_dev", "trades_db_prod", "trades_db_production"]
    
    if any(name in test_db_url for name in dangerous_names):
        raise ValueError(
            f"❌ DANGER: TEST_DATABASE_URL points to a dev/prod database!\n"
            f"Found: {test_db_url}\n"
            f"Integration tests use pytest-postgresql with isolated databases.\n"
            f"You can remove TEST_DATABASE_URL from your environment."
        )
    
    if postgres_db in dangerous_names:
        # This is OK if we're not using the old fixtures
        # Just log a warning
        pass
