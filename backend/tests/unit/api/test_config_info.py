from unittest.mock import MagicMock

from backend.api.routes import config


def _session(name, has_alembic, provenance, revision=None):
    session = MagicMock()
    first = MagicMock()
    first.one.return_value = (name, has_alembic, provenance)
    second = MagicMock()
    second.scalar.return_value = revision
    session.execute.side_effect = [first, second]
    return session


def test_db_info_returns_revision_and_restore_provenance():
    session = _session(
        "trades_db_prod",
        True,
        "restored_from=prod_20261106T142608Z_initial.dump; rev=065_active_sync_job_guard",
        "065_active_sync_job_guard",
    )

    assert config.db_info(session) == (
        "trades_db_prod",
        "065_active_sync_job_guard",
        "restored_from=prod_20261106T142608Z_initial.dump; rev=065_active_sync_job_guard",
    )


def test_db_info_skips_revision_query_without_alembic_table():
    session = _session("trades_db_scenario", False, None)

    assert config.db_info(session) == ("trades_db_scenario", None, None)
    assert session.execute.call_count == 1


def test_backend_version_prefers_deployed_app_version(monkeypatch):
    config.backend_version.cache_clear()
    monkeypatch.setenv("APP_VERSION", "backend-v1.4.0")
    try:
        assert config.backend_version() == "backend-v1.4.0"
    finally:
        config.backend_version.cache_clear()
