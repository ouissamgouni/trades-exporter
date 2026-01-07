"""
Unit tests for BaseConnector - specifically testing per-connector test mode.
"""

import pytest
from unittest.mock import MagicMock, patch
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

    @patch("backend.connectors.base.base_connector.is_test_mode")
    def test_test_mode_from_config_true(self, mock_global_test_mode):
        """Test that config test_mode=True overrides global setting."""
        mock_global_test_mode.return_value = False
        
        config = {"test_mode": True}
        connector = ConcreteConnector(config=config)
        
        assert connector.test_mode is True

    @patch("backend.connectors.base.base_connector.is_test_mode")
    def test_test_mode_from_config_false(self, mock_global_test_mode):
        """Test that config test_mode=False overrides global setting."""
        mock_global_test_mode.return_value = True
        
        config = {"test_mode": False}
        connector = ConcreteConnector(config=config)
        
        assert connector.test_mode is False

    @patch("backend.connectors.base.base_connector.is_test_mode")
    def test_test_mode_fallback_to_global_true(self, mock_global_test_mode):
        """Test that test_mode falls back to global when not in config."""
        mock_global_test_mode.return_value = True
        
        connector = ConcreteConnector(config={})
        
        assert connector.test_mode is True

    @patch("backend.connectors.base.base_connector.is_test_mode")
    def test_test_mode_fallback_to_global_false(self, mock_global_test_mode):
        """Test that test_mode falls back to global when not in config."""
        mock_global_test_mode.return_value = False
        
        connector = ConcreteConnector(config={})
        
        assert connector.test_mode is False

    @patch("backend.connectors.base.base_connector.is_test_mode")
    def test_test_mode_no_config(self, mock_global_test_mode):
        """Test that test_mode falls back to global when no config."""
        mock_global_test_mode.return_value = True
        
        connector = ConcreteConnector()
        
        assert connector.test_mode is True


class TestBaseConnectorTestFilePath:
    """Tests for test file path resolution."""

    @patch("backend.connectors.base.base_connector.is_test_mode")
    def test_custom_test_file_path_from_config(self, mock_global_test_mode):
        """Test that test_file_path from config is used."""
        mock_global_test_mode.return_value = True
        
        custom_path = "/custom/fixtures/my_test_data.json"
        config = {"test_mode": True, "test_file_path": custom_path}
        connector = ConcreteConnector(config=config)
        
        result = connector.get_test_data_path()
        
        assert result == custom_path

    @patch("backend.connectors.base.base_connector.is_test_mode")
    def test_default_test_file_path_without_config(self, mock_global_test_mode):
        """Test that default path is used when no test_file_path in config."""
        mock_global_test_mode.return_value = True
        
        connector = ConcreteConnector(config={})
        
        result = connector.get_test_data_path()
        
        # Should be default fixtures path using connector_name
        assert "fixtures" in result
        assert result.endswith("test-connector.json")

    @patch("backend.connectors.base.base_connector.is_test_mode")
    def test_default_test_file_path_no_config(self, mock_global_test_mode):
        """Test that default path is used when no config at all."""
        mock_global_test_mode.return_value = True
        
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
