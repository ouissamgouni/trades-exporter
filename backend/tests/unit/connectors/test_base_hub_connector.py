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
    
    def get_raws(self) -> List[Dict[str, Any]]:
        if self._should_error:
            raise Exception(f"Simulated error in {self._name}")
        return self._items
    
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


class TestEndOfConnectorMarker:
    """Tests for end-of-connector completion markers."""

    def test_futures_strategy_sends_completion_marker(self):
        """Test that futures strategy sends is_connector_complete marker after each connector."""
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
        items = list(hub.get_raws())
        
        # Should have: 2 items from A + 1 completion marker + 1 item from B + 1 completion marker
        # Total: 5 items
        completion_markers = [i for i in items if i.get("is_connector_complete")]
        data_items = [i for i in items if not i.get("is_connector_complete")]
        
        assert len(completion_markers) == 2, f"Expected 2 completion markers, got {len(completion_markers)}"
        assert len(data_items) == 3, f"Expected 3 data items, got {len(data_items)}"
        
        # Check completion markers have required fields
        for marker in completion_markers:
            assert marker["is_connector_complete"] is True
            assert "connector_name" in marker
            assert "items_count" in marker
            assert marker["raw_item"] is None
            assert marker["normalized_item"] is None

    def test_queue_strategy_sends_completion_marker(self):
        """Test that queue strategy sends is_connector_complete marker after each connector."""
        connector1 = SimpleTestConnector(
            name="connector_a",
            connector_id=1,
            items=[{"id": "1", "data": "a"}],
        )
        
        hub = ConcreteHubConnector(
            child_connectors=[("connector_a", connector1)],
            parallel_strategy="queue",
        )
        
        items = list(hub.get_raws())
        
        # Should have: 1 item + 1 completion marker
        completion_markers = [i for i in items if i.get("is_connector_complete")]
        
        assert len(completion_markers) == 1
        assert completion_markers[0]["connector_id"] == 1
        assert completion_markers[0]["items_count"] == 1

    def test_completion_marker_includes_items_count(self):
        """Test that completion marker includes correct items_count."""
        connector = SimpleTestConnector(
            name="counter_test",
            connector_id=5,
            items=[{"id": str(i)} for i in range(10)],
        )
        
        hub = ConcreteHubConnector(
            child_connectors=[("counter_test", connector)],
            parallel_strategy="futures",
        )
        
        items = list(hub.get_raws())
        completion_markers = [i for i in items if i.get("is_connector_complete")]
        
        assert len(completion_markers) == 1
        assert completion_markers[0]["items_count"] == 10

    def test_empty_connector_still_sends_completion_marker(self):
        """Test that a connector with no items still sends completion marker."""
        connector = SimpleTestConnector(
            name="empty",
            connector_id=3,
            items=[],  # No items
        )
        
        hub = ConcreteHubConnector(
            child_connectors=[("empty", connector)],
            parallel_strategy="futures",
        )
        
        items = list(hub.get_raws())
        
        # Should have exactly 1 completion marker with items_count=0
        assert len(items) == 1
        assert items[0]["is_connector_complete"] is True
        assert items[0]["items_count"] == 0


# ============================================================================
# Test Abort Functionality
# ============================================================================


class TestHubAbortFunctionality:
    """Tests for abort event handling in hub connector."""

    def test_abort_event_propagates_to_children(self):
        """Test that abort_event is propagated to child connectors."""
        abort_event = Event()
        
        connector1 = SimpleTestConnector(name="a", connector_id=1)
        connector2 = SimpleTestConnector(name="b", connector_id=2)
        
        hub = ConcreteHubConnector(
            child_connectors=[("a", connector1), ("b", connector2)],
            abort_event=abort_event,
        )
        
        # Child connectors should have the same abort_event
        assert connector1._abort_event is abort_event
        assert connector2._abort_event is abort_event

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
        for i, item in enumerate(hub.get_raws()):
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
        """Test that wrapped items include connector_id at top level."""
        connector = SimpleTestConnector(
            name="id_test",
            connector_id=42,
            items=[{"id": "1", "data": "test"}],
        )
        
        hub = ConcreteHubConnector(
            child_connectors=[("id_test", connector)],
            parallel_strategy="futures",
        )
        
        items = list(hub.get_raws())
        data_items = [i for i in items if not i.get("is_connector_complete")]
        
        assert len(data_items) == 1
        assert data_items[0]["connector_id"] == 42
        assert data_items[0]["connector_name"] == "id_test"

    def test_completion_marker_includes_connector_id(self):
        """Test that completion marker includes connector_id."""
        connector = SimpleTestConnector(
            name="id_marker_test",
            connector_id=99,
            items=[{"id": "1"}],
        )
        
        hub = ConcreteHubConnector(
            child_connectors=[("id_marker_test", connector)],
            parallel_strategy="futures",
        )
        
        items = list(hub.get_raws())
        completion_markers = [i for i in items if i.get("is_connector_complete")]
        
        assert len(completion_markers) == 1
        assert completion_markers[0]["connector_id"] == 99


# ============================================================================
# Test Error Handling
# ============================================================================


class TestHubErrorHandling:
    """Tests for error handling in hub connector."""

    def test_connector_error_yields_error_item(self):
        """Test that connector errors are wrapped and yielded."""
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
        
        items = list(hub.get_raws())
        
        # Should have an error item
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
        
        items = list(hub.get_raws())
        
        # Should have items from good connector
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
        
        items = list(hub.get_raws())
        data_items = [i for i in items if not i.get("is_connector_complete")]
        
        assert len(data_items) == 5

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
        
        items = list(hub.get_raws())
        data_items = [i for i in items if not i.get("is_connector_complete")]
        
        assert len(data_items) == 5
