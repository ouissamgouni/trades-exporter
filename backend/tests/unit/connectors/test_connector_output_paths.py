"""
Unit tests for connector output path and logging functionality.
Tests the recursive path building and file logging features.
"""

import pytest
import json
import os
from pathlib import Path
from unittest.mock import patch

from backend.connectors.base.base_connector import BaseConnector
from backend.connectors.base.base_hub_connector import BaseHubConnector
from backend.db.models import NormalizedTransaction
from typing import Any, Dict, List


# ============================================================================
# Test Connector Classes
# ============================================================================


class TestConnector(BaseConnector):
    """Simple test connector for testing."""

    __test__ = False  # Not a pytest test class despite the name

    @property
    def connector_name(self) -> str:
        return "test_connector"

    def yield_raws(self):
        yield {"id": "1", "data": "test"}

    def raw_to_normalized(self, raw_item: dict) -> NormalizedTransaction:
        return NormalizedTransaction(
            source_id=raw_item.get("id", "test"),
            timestamp="2024-01-15T10:00:00Z",
            direction="in",
            source=self.connector_name,
            raw_data=raw_item,
        )


class TestHubConnector(BaseHubConnector):
    """Simple hub connector for testing."""

    __test__ = False  # Not a pytest test class despite the name

    @property
    def connector_name(self) -> str:
        return "test_hub"

    def raw_to_normalized(self, raw_item: dict) -> NormalizedTransaction:
        return NormalizedTransaction(
            source_id="test",
            timestamp="2024-01-15T10:00:00Z",
            direction="in",
            source=self.connector_name,
            raw_data=raw_item,
        )


# ============================================================================
# Test Output Path Building
# ============================================================================


class TestOutputPathBuilding:
    """Tests for output path construction."""

    def test_output_path_without_parent_uses_default(self, tmp_path, monkeypatch):
        """Connector without parent_output_path uses default base path."""
        # Mock get_connectors_output_path to use tmp_path
        monkeypatch.setattr(
            "backend.connectors.base.base_connector.get_connectors_output_path",
            lambda: str(tmp_path),
        )

        connector = TestConnector()

        # Should use tmp_path as base
        assert connector.output_path.startswith(str(tmp_path))
        assert "test_connector" in connector.output_path

        # Cleanup
        connector.cleanup()

    def test_output_path_with_parent(self, tmp_path):
        """Connector with parent_output_path builds path under parent."""
        parent_path = str(tmp_path / "parent_session")
        config = {"parent_output_path": parent_path}
        connector = TestConnector(config=config)

        # Should build under parent_path
        assert connector.output_path.startswith(parent_path)
        assert "test_connector" in connector.output_path

        # Cleanup
        connector.cleanup()

    def test_output_path_includes_timestamp(self, tmp_path):
        """Output path includes timestamp directory."""
        config = {"parent_output_path": str(tmp_path)}
        connector = TestConnector(config=config)

        # Extract timestamp part (last directory component)
        path_parts = connector.output_path.split(os.sep)
        timestamp_part = path_parts[-1]

        # Should match YYYYMMDD_HHMMSS format (15 chars)
        assert len(timestamp_part) == 15
        assert "_" in timestamp_part
        assert timestamp_part[:8].isdigit()  # YYYYMMDD
        assert timestamp_part[9:].isdigit()  # HHMMSS

        # Cleanup
        connector.cleanup()

    def test_different_connectors_get_different_paths(self, tmp_path):
        """Different connectors get different output paths."""
        parent = str(tmp_path)
        config = {"parent_output_path": parent}

        connector1 = TestConnector(config=config)

        # Create another connector with different name
        class OtherConnector(TestConnector):
            @property
            def connector_name(self) -> str:
                return "other_connector"

        connector2 = OtherConnector(config=config)

        # Paths should differ by connector_name
        assert "test_connector" in connector1.output_path
        assert "other_connector" in connector2.output_path
        assert connector1.output_path != connector2.output_path

        # Cleanup
        connector1.cleanup()
        connector2.cleanup()


# ============================================================================
# Test File Logging Setup
# ============================================================================


class TestFileLogging:
    """Tests for file logger setup and configuration."""

    def test_file_logger_created_by_default(self, tmp_path):
        """File logger is created when file output is enabled."""
        config = {"parent_output_path": str(tmp_path)}
        connector = TestConnector(config=config)

        assert connector.file_logger is not None
        assert connector.file_logger.name == "connector.test_connector"

        # Cleanup
        connector.cleanup()

    def test_log_directory_created(self, tmp_path):
        """Log directory is created in output path."""
        config = {"parent_output_path": str(tmp_path)}
        connector = TestConnector(config=config)

        log_dir = Path(connector.output_path) / "log"
        assert log_dir.exists()
        assert log_dir.is_dir()

        # Cleanup
        connector.cleanup()

    def test_log_file_created(self, tmp_path):
        """Log file is created in log directory."""
        config = {"parent_output_path": str(tmp_path)}
        connector = TestConnector(config=config)

        log_file = Path(connector.output_path) / "log" / "connector.log"
        assert log_file.exists()

        # Cleanup
        connector.cleanup()

    def test_logger_uses_rotating_handler(self, tmp_path):
        """File logger uses RotatingFileHandler."""
        from logging.handlers import RotatingFileHandler

        config = {"parent_output_path": str(tmp_path)}
        connector = TestConnector(config=config)

        # Check that logger has a RotatingFileHandler
        handlers = connector.file_logger.handlers
        assert len(handlers) > 0
        assert any(isinstance(h, RotatingFileHandler) for h in handlers)

        # Cleanup
        connector.cleanup()

    def test_rotating_handler_configuration(self, tmp_path):
        """RotatingFileHandler has correct size and backup settings."""
        from logging.handlers import RotatingFileHandler

        config = {"parent_output_path": str(tmp_path)}
        connector = TestConnector(config=config)

        # Find the RotatingFileHandler
        rotating_handler = None
        for handler in connector.file_logger.handlers:
            if isinstance(handler, RotatingFileHandler):
                rotating_handler = handler
                break

        assert rotating_handler is not None
        assert rotating_handler.maxBytes == 10 * 1024 * 1024  # 10MB
        assert rotating_handler.backupCount == 3

        # Cleanup
        connector.cleanup()

    def test_cleanup_closes_file_handlers(self, tmp_path):
        """cleanup() method properly closes and removes file handlers."""
        config = {"parent_output_path": str(tmp_path)}
        connector = TestConnector(config=config)

        # Verify logger exists
        assert connector.file_logger is not None
        initial_handlers = len(connector.file_logger.handlers)
        assert initial_handlers > 0

        # Cleanup
        connector.cleanup()

        # Verify logger is cleaned up
        assert connector.file_logger is None

    def test_logger_does_not_propagate(self, tmp_path):
        """File logger has propagate=False to prevent duplicate logs."""
        config = {"parent_output_path": str(tmp_path)}
        connector = TestConnector(config=config)

        assert connector.file_logger.propagate is False

        # Cleanup
        connector.cleanup()


# ============================================================================
# Test Raw Data Dumping
# ============================================================================


class TestRawDataDumping:
    """Tests for raw data JSON file creation."""

    def test_dump_creates_raw_json_file(self, tmp_path):
        """dump_trades_to_json creates raw.json in output path."""
        config = {"parent_output_path": str(tmp_path)}
        connector = TestConnector(config=config)

        trades = [{"id": "1", "amount": 100}, {"id": "2", "amount": 200}]
        result_path = connector.dump_trades_to_json(trades)

        assert result_path.endswith("raw.json")
        assert Path(result_path).exists()

        # Cleanup
        connector.cleanup()

    def test_dump_saves_correct_data(self, tmp_path):
        """Dumped JSON contains the correct trade data."""
        config = {"parent_output_path": str(tmp_path)}
        connector = TestConnector(config=config)

        trades = [
            {"id": "1", "symbol": "BTC", "amount": 100},
            {"id": "2", "symbol": "ETH", "amount": 200},
        ]
        result_path = connector.dump_trades_to_json(trades)

        with open(result_path, "r") as f:
            saved_trades = json.load(f)

        assert len(saved_trades) == 2
        assert saved_trades[0]["id"] == "1"
        assert saved_trades[0]["symbol"] == "BTC"
        assert saved_trades[1]["amount"] == 200

        # Cleanup
        connector.cleanup()

    def test_dump_returns_empty_when_disabled(self, tmp_path):
        """dump_trades_to_json returns empty string when disabled."""
        config = {"parent_output_path": str(tmp_path), "disable_file_output": True}
        connector = TestConnector(config=config)

        trades = [{"id": "1", "amount": 100}]
        result_path = connector.dump_trades_to_json(trades)

        assert result_path == ""

        # Cleanup
        connector.cleanup()

    def test_dump_returns_empty_for_empty_trades(self, tmp_path):
        """dump_trades_to_json returns empty string for empty list."""
        config = {"parent_output_path": str(tmp_path)}
        connector = TestConnector(config=config)

        result_path = connector.dump_trades_to_json([])
        assert result_path == ""

        # Cleanup
        connector.cleanup()

    def test_hub_connector_skips_dump(self, tmp_path):
        """Hub connectors skip raw data dumping."""
        config = {"parent_output_path": str(tmp_path)}
        hub = TestHubConnector(child_connectors=[], config=config)

        trades = [{"id": "1", "amount": 100}]
        result_path = hub.dump_trades_to_json(trades)

        # Should return empty string (skipped)
        assert result_path == ""

        # Verify raw.json was NOT created
        raw_file = Path(hub.output_path) / "raw.json"
        assert not raw_file.exists()

        # Cleanup
        hub.cleanup()

    def test_hub_logs_only_no_raw_data(self, tmp_path):
        """Hub connectors create log directory but no raw.json."""
        config = {"parent_output_path": str(tmp_path)}
        hub = TestHubConnector(child_connectors=[], config=config)

        # Log directory should exist
        log_dir = Path(hub.output_path) / "log"
        assert log_dir.exists()

        # But raw.json should NOT exist after dump attempt
        hub.dump_trades_to_json([{"id": "1"}])
        raw_file = Path(hub.output_path) / "raw.json"
        assert not raw_file.exists()

        # Cleanup
        hub.cleanup()

    def test_is_hub_connector_flag(self, tmp_path):
        """Test is_hub_connector flag correctly identifies connectors."""
        config = {"parent_output_path": str(tmp_path)}

        # Regular connector
        connector = TestConnector(config=config)
        assert connector.is_hub_connector is False

        # Hub connector
        hub = TestHubConnector(child_connectors=[], config=config)
        assert hub.is_hub_connector is True

        # Cleanup
        connector.cleanup()
        hub.cleanup()


# ============================================================================
# Test Path Propagation Through Hierarchy
# ============================================================================


class TestPathPropagation:
    """Tests for parent_output_path propagation through connector hierarchy."""

    def test_parent_to_child_propagation(self, tmp_path):
        """Parent connector's output_path becomes child's parent_output_path."""
        # Create parent connector
        parent_config = {"parent_output_path": str(tmp_path)}
        parent = TestConnector(config=parent_config)

        # Create child with parent's output_path
        child_config = {"parent_output_path": parent.output_path}
        child = TestConnector(config=child_config)

        # Child's path should be under parent's path
        assert child.output_path.startswith(parent.output_path)

        # Cleanup
        parent.cleanup()
        child.cleanup()

    def test_three_level_hierarchy(self, tmp_path):
        """Test path propagation through three levels."""
        # Level 1: Sync session
        session_path = str(tmp_path / "20240115_100000")

        # Level 2: Hub connector
        hub_config = {"parent_output_path": session_path}

        class HubConnector(TestConnector):
            @property
            def connector_name(self):
                return "connector_hub"

        hub = HubConnector(config=hub_config)

        # Level 3: Child connector
        child_config = {"parent_output_path": hub.output_path}
        child = TestConnector(config=child_config)

        # Verify hierarchy
        assert hub.output_path.startswith(session_path)
        assert "connector_hub" in hub.output_path
        assert child.output_path.startswith(hub.output_path)
        assert "test_connector" in child.output_path

        # Cleanup
        hub.cleanup()
        child.cleanup()

    def test_multiple_children_under_same_parent(self, tmp_path):
        """Multiple children under same parent get separate directories."""
        parent_path = str(tmp_path / "parent")

        # Create two child connectors
        child1_config = {"parent_output_path": parent_path}
        child1 = TestConnector(config=child1_config)

        child2_config = {"parent_output_path": parent_path}

        class SecondConnector(TestConnector):
            @property
            def connector_name(self):
                return "second_connector"

        child2 = SecondConnector(config=child2_config)

        # Both should be under parent but in different directories
        assert child1.output_path.startswith(parent_path)
        assert child2.output_path.startswith(parent_path)
        assert "test_connector" in child1.output_path
        assert "second_connector" in child2.output_path
        assert child1.output_path != child2.output_path

        # Cleanup
        child1.cleanup()
        child2.cleanup()


# ============================================================================
# Test Integration Scenarios
# ============================================================================


class TestIntegrationScenarios:
    """Integration tests for realistic usage scenarios."""

    def test_sync_job_directory_structure(self, tmp_path):
        """Test that sync job creates expected directory structure."""
        # Simulate sync job
        sync_timestamp = "20240115_100000"
        sync_path = str(tmp_path / sync_timestamp)

        # Hub connector
        hub_config = {"parent_output_path": sync_path}

        class Hub(TestConnector):
            @property
            def connector_name(self):
                return "connector_hub"

        hub = Hub(config=hub_config)

        # Child connector
        child_config = {"parent_output_path": hub.output_path}
        child = TestConnector(config=child_config)

        # Verify structure
        # sync_path/connector_hub/{timestamp}/log/connector.log
        hub_log = Path(hub.output_path) / "log" / "connector.log"
        assert hub_log.exists()

        # sync_path/connector_hub/{timestamp}/test_connector/{timestamp}/log/connector.log
        child_log = Path(child.output_path) / "log" / "connector.log"
        assert child_log.exists()

        # Child can dump data
        child.dump_trades_to_json([{"id": "1"}])
        child_raw = Path(child.output_path) / "raw.json"
        assert child_raw.exists()

        # Cleanup
        hub.cleanup()
        child.cleanup()

    def test_standalone_invocation_structure(self, tmp_path, monkeypatch):
        """Test that standalone connector creates flat structure."""
        # Mock default path
        monkeypatch.setattr(
            "backend.connectors.base.base_connector.get_connectors_output_path",
            lambda: str(tmp_path),
        )

        # Connector without parent_output_path (standalone)
        connector = TestConnector()

        # Should create: {tmp_path}/test_connector/{timestamp}/
        assert connector.output_path.startswith(str(tmp_path))
        assert "test_connector" in connector.output_path

        # Can dump data
        connector.dump_trades_to_json([{"id": "1", "amount": 100}])
        raw_file = Path(connector.output_path) / "raw.json"
        assert raw_file.exists()

        # Cleanup
        connector.cleanup()

    def test_multiple_connectors_cleanup(self, tmp_path):
        """Test that multiple connectors can be cleaned up properly."""
        config = {"parent_output_path": str(tmp_path)}

        connectors = []
        for i in range(5):

            class TestConn(TestConnector):
                @property
                def connector_name(self):
                    return f"test_connector_{i}"

            conn = TestConn(config=config)
            connectors.append(conn)

        # All should have file loggers
        for conn in connectors:
            assert conn.file_logger is not None

        # Cleanup all
        for conn in connectors:
            conn.cleanup()

        # All should have cleaned up file loggers
        for conn in connectors:
            assert conn.file_logger is None


# ============================================================================
# Test Environment Variable Override
# ============================================================================


class TestEnvironmentVariableOverride:
    """Tests for CONNECTORS_OUTPUT_PATH environment variable."""

    def test_custom_output_path_from_env(self, tmp_path, monkeypatch):
        """Test that CONNECTORS_OUTPUT_PATH env var is used."""
        custom_path = str(tmp_path / "custom_output")
        monkeypatch.setenv("CONNECTORS_OUTPUT_PATH", custom_path)

        # Force reload of get_connectors_output_path
        from backend.config import loader
        import importlib

        importlib.reload(loader)

        # Now test
        from backend.config.loader import get_connectors_output_path

        result = get_connectors_output_path()

        # Should return absolute path of custom_path
        assert result == os.path.abspath(custom_path)
