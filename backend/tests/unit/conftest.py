import pytest


@pytest.fixture(autouse=True)
def _no_global_test_mode(monkeypatch):
    """Unit tests mock live connector paths; a shell-level TEST_MODE=1 would switch them to fixture files."""
    monkeypatch.delenv("TEST_MODE", raising=False)
