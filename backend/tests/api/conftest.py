"""
Shared fixtures for API tests.

Patches init_db so that TestClient(app) doesn't trigger a real
PostgreSQL connection during the FastAPI lifespan startup.
"""

from unittest.mock import patch

import pytest


@pytest.fixture(autouse=True)
def _no_db_init():
    """Prevent lifespan handler from connecting to a real database."""
    with patch("backend.api.main.init_db"), \
         patch("backend.api.main.get_database_url", return_value="postgresql://test@localhost/test"):
        yield
