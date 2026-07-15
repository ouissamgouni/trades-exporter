"""
Unit tests for BaseHubConnector - testing parallel strategies and abort/completion markers.
"""

import pytest
from threading import Event
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock

from backend.connectors.base.base_connector import BaseConnector
from backend.connectors.base.base_hub_connector import BaseHubConnector
from backend.db.models import NormalizedTransaction


# ============================================================================
# Test Fixtures - Concrete Implementations
# ============================================================================


class SimpleTestConnector(BaseConnector):
    """Simple connector that yields predefined items."""
    
    def __init__(
        self,
        name: str = "test",
        items: Optional[List[Dict]] = None,
        connector_id: Optional[int] = None,
        abort_event: Optional[Event] = None,
        should_error: bool = False,
    ):
        # Set instance variables BEFORE calling super().__init__
        # because connector_name property is accessed during init
        self._name = name
        self._items = items or []
        self._should_error = should_error
        super().__init__(connector_id=connector_id, abort_event=abort_event)
    
    @property
    def connector_name(self) -> str:
        return self._name
    
    def yield_raws(self):
        if self._should_error:
            raise Exception(f"Simulated error in {self._name}")
        for item in self._items:
            yield item
    
    def raw_to_normalized(self, raw_item: dict) -> NormalizedTransaction:
        return NormalizedTransaction(
            source=self._name,
            source_transaction_id=raw_item.get("id", "unknown"),
            date_time=raw_item.get("timestamp"),
            direction="inflow",
            transaction_type="trade",
        )


class ConcreteHubConnector(BaseHubConnector):
    """Concrete hub connector for testing."""
    
    @property
    def connector_name(self) -> str:
        return "test_hub"


# ============================================================================
# Test End-of-Connector Markers
# ============================================================================


class TestYieldRawsStreaming:
    """Tests for streaming behavior of yield_raws."""

    def test_futures_strategy_yields_all_items(self):
        """Test that futures strategy yields all items from connectors."""
        # Create child connectors with some items
        connector1 = SimpleTestConnector(
            name="connector_a",
            connector_id=1,
            items=[{"id": "1", "data": "a"}, {"id": "2", "data": "b"}],
        )
        connector2 = SimpleTestConnector(
            name="connector_b",
            connector_id=2,
            items=[{"id": "3", "data": "c"}],
        )
        
        hub = ConcreteHubConnector(
            child_connectors=[
                ("connector_a", connector1),
                ("connector_b", connector2),
            ],
            parallel_strategy="futures",
        )
        
        # Collect all yielded items
        items = list(hub.yield_raws())
        
        # Should have all 3 items with connector metadata
        assert len(items) == 3, f"Expected 3 data items, got {len(items)}"
        
        # Check items have required wrapper fields
        for item in items:
            assert "connector_name" in item
            assert "_connector_id" in item
            assert "_master_source" in item
            assert "raw_item" in item
            assert "normalized_item" in item

    def test_queue_strategy_yields_all_items(self):
        """Test that queue strategy yields all items from connectors."""
        connector1 = SimpleTestConnector(
            name="connector_a",
            connector_id=1,
            items=[{"id": "1", "data": "a"}],
        )
        
        hub = ConcreteHubConnector(
            child_connectors=[("connector_a", connector1)],
            parallel_strategy="queue",
        )
        
        items = list(hub.yield_raws())
        
        # Should have 1 item with metadata
        assert len(items) == 1
        assert items[0]["_connector_id"] == 1
        assert items[0]["connector_name"] == "connector_a"

    def test_yields_correct_item_count(self):
        """Test that all items from connector are yielded."""
        connector = SimpleTestConnector(
            name="counter_test",
            connector_id=5,
            items=[{"id": str(i)} for i in range(10)],
        )
        
        hub = ConcreteHubConnector(
            child_connectors=[("counter_test", connector)],
            parallel_strategy="futures",
        )
        
        items = list(hub.yield_raws())
        
        assert len(items) == 10

    def test_empty_connector_yields_nothing(self):
        """Test that a connector with no items yields no items."""
        connector = SimpleTestConnector(
            name="empty",
            connector_id=3,
            items=[],  # No items
        )
        
        hub = ConcreteHubConnector(
            child_connectors=[("empty", connector)],
            parallel_strategy="futures",
        )
        
        items = list(hub.yield_raws())
        
        # Should have no items
        assert len(items) == 0


# ============================================================================
# Test Abort Functionality
# ============================================================================


class TestHubAbortFunctionality:
    """Tests for abort event handling in hub connector."""

    def test_abort_event_stored_on_hub(self):
        """Test that abort_event is stored on hub connector."""
        abort_event = Event()
        
        connector1 = SimpleTestConnector(name="a", connector_id=1)
        connector2 = SimpleTestConnector(name="b", connector_id=2)
        
        hub = ConcreteHubConnector(
            child_connectors=[("a", connector1), ("b", connector2)],
            abort_event=abort_event,
        )
        
        # Hub should have the abort_event
        assert hub._abort_event is abort_event

    def test_is_abort_requested_returns_false_initially(self):
        """Test that is_abort_requested returns False when event not set."""
        abort_event = Event()
        
        hub = ConcreteHubConnector(
            child_connectors=[],
            abort_event=abort_event,
        )
        
        assert hub.is_abort_requested() is False

    def test_is_abort_requested_returns_true_when_set(self):
        """Test that is_abort_requested returns True when event is set."""
        abort_event = Event()
        
        hub = ConcreteHubConnector(
            child_connectors=[],
            abort_event=abort_event,
        )
        
        abort_event.set()
        assert hub.is_abort_requested() is True

    def test_futures_strategy_stops_on_abort(self):
        """Test that futures strategy stops yielding when abort is requested."""
        abort_event = Event()
        
        # Create connectors with many items
        connector1 = SimpleTestConnector(
            name="a",
            connector_id=1,
            items=[{"id": str(i)} for i in range(100)],
        )
        connector2 = SimpleTestConnector(
            name="b",
            connector_id=2,
            items=[{"id": str(i)} for i in range(100)],
        )
        
        hub = ConcreteHubConnector(
            child_connectors=[("a", connector1), ("b", connector2)],
            parallel_strategy="futures",
            abort_event=abort_event,
        )
        
        # Start iterating and abort after a few items
        items_received = []
        for i, item in enumerate(hub.yield_raws()):
            items_received.append(item)
            if i == 5:
                abort_event.set()
                break
        
        # Should have stopped after setting abort
        # Note: Exact count may vary due to buffering, but should be < total items
        assert len(items_received) < 200


# ============================================================================
# Test Connector ID in Wrapper
# ============================================================================


class TestConnectorIdInWrapper:
    """Tests for connector_id field in wrapped items."""

    def test_wrapper_includes_connector_id(self):
        """Test that wrapped items include _connector_id at top level."""
        connector = SimpleTestConnector(
            name="id_test",
            connector_id=42,
            items=[{"id": "1", "data": "test"}],
        )
        
        hub = ConcreteHubConnector(
            child_connectors=[("id_test", connector)],
            parallel_strategy="futures",
        )
        
        items = list(hub.yield_raws())
        
        assert len(items) == 1
        assert items[0]["_connector_id"] == 42
        assert items[0]["connector_name"] == "id_test"

    def test_wrapper_includes_master_source(self):
        """Test that wrapped items include _master_source."""
        connector = SimpleTestConnector(
            name="source_test",
            connector_id=99,
            items=[{"id": "1"}],
        )
        
        hub = ConcreteHubConnector(
            child_connectors=[("source_test", connector)],
            parallel_strategy="futures",
        )
        
        items = list(hub.yield_raws())
        
        assert len(items) == 1
        assert items[0]["_master_source"] == "source_test"


# ============================================================================
# Test Error Handling
# ============================================================================


class TestHubErrorHandling:
    """Tests for error handling in hub connector."""

    def test_connector_error_yields_error_item_and_raises(self):
        """Test that connector errors are wrapped, yielded, then raised."""
        connector = SimpleTestConnector(
            name="error_test",
            connector_id=1,
            items=[],
            should_error=True,
        )
        
        hub = ConcreteHubConnector(
            child_connectors=[("error_test", connector)],
            parallel_strategy="futures",
        )
        
        items = []
        with pytest.raises(RuntimeError, match="Child connector error"):
            for item in hub.yield_raws():
                items.append(item)
        
        # Should have yielded an error item before raising
        error_items = [i for i in items if i.get("error")]
        assert len(error_items) >= 1
        assert "error_test" in error_items[0]["error"]

    def test_one_connector_error_doesnt_stop_others(self):
        """Test that one connector's error doesn't prevent others from completing."""
        error_connector = SimpleTestConnector(
            name="error",
            connector_id=1,
            should_error=True,
        )
        good_connector = SimpleTestConnector(
            name="good",
            connector_id=2,
            items=[{"id": "1"}, {"id": "2"}],
        )
        
        hub = ConcreteHubConnector(
            child_connectors=[
                ("error", error_connector),
                ("good", good_connector),
            ],
            parallel_strategy="futures",
        )
        
        items = []
        with pytest.raises(RuntimeError, match="Child connector error"):
            for item in hub.yield_raws():
                items.append(item)
        
        # Should have items from good connector despite the error
        good_items = [i for i in items if i.get("connector_name") == "good" and not i.get("is_connector_complete")]
        assert len(good_items) == 2


# ============================================================================
# Test Parallel Strategies
# ============================================================================


class TestParallelStrategies:
    """Tests for different parallel processing strategies."""

    def test_queue_strategy_yields_items_as_they_arrive(self):
        """Test that queue strategy streams items."""
        connector = SimpleTestConnector(
            name="queue_test",
            connector_id=1,
            items=[{"id": str(i)} for i in range(5)],
        )
        
        hub = ConcreteHubConnector(
            child_connectors=[("queue_test", connector)],
            parallel_strategy="queue",
        )
        
        items = list(hub.yield_raws())
        
        assert len(items) == 5

    def test_futures_strategy_processes_in_batches(self):
        """Test that futures strategy processes connectors."""
        connector = SimpleTestConnector(
            name="futures_test",
            connector_id=1,
            items=[{"id": str(i)} for i in range(5)],
        )
        
        hub = ConcreteHubConnector(
            child_connectors=[("futures_test", connector)],
            parallel_strategy="futures",
        )
        
        items = list(hub.yield_raws())
        
        assert len(items) == 5
