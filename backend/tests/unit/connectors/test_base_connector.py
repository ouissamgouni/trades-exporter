"""
Unit tests for BaseConnector - specifically testing per-connector test mode.
"""

import pytest
from unittest.mock import MagicMock
from pathlib import Path
from typing import Any, Dict, List

from backend.connectors.base.base_connector import BaseConnector
from backend.db.models import NormalizedTransaction


# ============================================================================
# Concrete Test Connector
# ============================================================================


class ConcreteConnector(BaseConnector):
    """Concrete implementation of BaseConnector for testing."""
    
    @property
    def connector_name(self) -> str:
        return "test-connector"
    
    @property
    def test_data_filename(self) -> str:
        return "test_data.json"
    
    def get_raws(self) -> List[Dict[str, Any]]:
        return []
    
    def raw_to_normalized(self, raw_item: dict) -> NormalizedTransaction:
        return NormalizedTransaction(
            source_id="test-123",
            timestamp="2024-01-15T10:00:00Z",
            direction="in",
            source="test-connector",
            raw_data=raw_item,
        )


# ============================================================================
# Test BaseConnector Config and Test Mode
# ============================================================================


class TestBaseConnectorConfig:
    """Tests for config parameter handling in BaseConnector."""

    def test_connector_accepts_config(self):
        """Test that connector accepts config parameter."""
        config = {"chain": "eth", "address": "0x123"}
        connector = ConcreteConnector(config=config)
        
        assert connector.config == config

    def test_connector_without_config(self):
        """Test that connector works without config (defaults to empty dict)."""
        connector = ConcreteConnector()
        
        assert connector.config == {}

    def test_empty_config(self):
        """Test that connector works with empty config."""
        connector = ConcreteConnector(config={})
        
        assert connector.config == {}


class TestBaseConnectorTestMode:
    """Tests for per-connector test mode functionality."""

    def test_test_mode_from_config_true(self):
        """Test that config test_mode=True sets test mode."""
        config = {"test_mode": True}
        connector = ConcreteConnector(config=config)
        
        assert connector.test_mode is True

    def test_test_mode_from_config_false(self):
        """Test that config test_mode=False disables test mode."""
        config = {"test_mode": False}
        connector = ConcreteConnector(config=config)
        
        assert connector.test_mode is False

    def test_test_mode_defaults_to_false(self):
        """Test that test_mode defaults to False when not in config."""
        connector = ConcreteConnector(config={})
        
        assert connector.test_mode is False

    def test_test_mode_no_config(self):
        """Test that test_mode defaults to False when no config."""
        connector = ConcreteConnector()
        
        assert connector.test_mode is False


class TestBaseConnectorTestFilePath:
    """Tests for test file path resolution."""

    def test_custom_test_file_path_from_config(self):
        """Test that test_file_path from config is used."""
        custom_path = "/custom/fixtures/my_test_data.json"
        config = {"test_mode": True, "test_file_path": custom_path}
        connector = ConcreteConnector(config=config)
        
        result = connector.get_test_data_path()
        
        assert result == custom_path

    def test_default_test_file_path_without_config(self):
        """Test that default path is used when no test_file_path in config."""
        connector = ConcreteConnector(config={})
        
        result = connector.get_test_data_path()
        
        # Should be default fixtures path using connector_name
        assert "fixtures" in result
        assert result.endswith("test-connector.json")

    def test_default_test_file_path_no_config(self):
        """Test that default path is used when no config at all."""
        connector = ConcreteConnector()
        
        result = connector.get_test_data_path()
        
        # Uses connector_name for default filename
        assert result.endswith("test-connector.json")


# ============================================================================
# Test Connector Type Property
# ============================================================================


class TestConnectorType:
    """Tests for connector_name property."""

    def test_connector_name_is_string(self):
        """Test that connector_name returns a string."""
        connector = ConcreteConnector()
        
        assert isinstance(connector.connector_name, str)
        assert connector.connector_name == "test-connector"

    def test_test_data_filename_is_string(self):
        """Test that test_data_filename returns a string."""
        connector = ConcreteConnector()
        
        assert isinstance(connector.test_data_filename, str)
        assert connector.test_data_filename == "test_data.json"


# ============================================================================
# Test Progress Callback
# ============================================================================


class TestProgressCallback:
    """Tests for progress callback functionality."""

    def test_connector_accepts_progress_callback(self):
        """Test that connector accepts progress_callback parameter."""
        callback = MagicMock()
        connector = ConcreteConnector(
            connector_id=42,
            progress_callback=callback,
        )
        
        assert connector._progress_callback == callback

    def test_connector_without_progress_callback(self):
        """Test that connector works without progress callback."""
        connector = ConcreteConnector(connector_id=1)
        
        assert connector._progress_callback is None

    def test_update_progress_calls_callback(self):
        """Test that update_progress invokes the callback."""
        callback = MagicMock()
        connector = ConcreteConnector(
            connector_id=42,
            progress_callback=callback,
        )
        
        connector.update_progress(
            operation="Fetching BTC/USDT",
            current=10,
            total=100,
            log_message="Fetched 50 trades",
        )
        
        callback.assert_called_once_with(
            42, "Fetching BTC/USDT", 10, 100, "Fetched 50 trades"
        )

    def test_update_progress_without_callback(self):
        """Test that update_progress works without a callback (no-op)."""
        connector = ConcreteConnector(connector_id=1)
        
        # Should not raise any exception
        connector.update_progress(
            operation="Test",
            current=1,
            total=10,
        )

    def test_update_progress_without_log_message(self):
        """Test update_progress with optional log_message."""
        callback = MagicMock()
        connector = ConcreteConnector(
            connector_id=5,
            progress_callback=callback,
        )
        
        connector.update_progress(
            operation="Processing",
            current=5,
            total=10,
        )
        
        callback.assert_called_once_with(5, "Processing", 5, 10, None)

    def test_update_progress_with_all_parameters(self):
        """Test update_progress with all parameters."""
        callback = MagicMock()
        connector = ConcreteConnector(
            connector_id=99,
            progress_callback=callback,
        )
        
        connector.update_progress(
            operation="Fetching symbols",
            current=0,
            total=500,
            log_message="Starting to fetch trades for 500 symbols",
        )
        
        callback.assert_called_once()
        args = callback.call_args[0]
        assert args[0] == 99  # connector_id
        assert args[1] == "Fetching symbols"  # operation
        assert args[2] == 0  # current
        assert args[3] == 500  # total
        assert args[4] == "Starting to fetch trades for 500 symbols"  # log_message

    def test_multiple_progress_updates(self):
        """Test multiple progress updates in sequence."""
        callback = MagicMock()
        connector = ConcreteConnector(
            connector_id=1,
            progress_callback=callback,
        )
        
        connector.update_progress(operation="Step 1", current=1, total=3)
        connector.update_progress(operation="Step 2", current=2, total=3)
        connector.update_progress(operation="Step 3", current=3, total=3)
        
        assert callback.call_count == 3