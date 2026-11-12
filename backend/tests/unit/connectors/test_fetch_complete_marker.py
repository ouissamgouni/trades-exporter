"""Hub FETCH_COMPLETE marker and BaseConnector handling of None normalization results."""

from unittest.mock import MagicMock

from backend.connectors.base.base_connector import FETCH_COMPLETE, BaseConnector
from backend.connectors.base.base_hub_connector import BaseHubConnector


class _Leaf(BaseConnector):
    def __init__(self, raws, mapping):
        self._raws = raws
        self._mapping = mapping
        super().__init__(config={"test_mode": False, "disable_file_output": True})

    @property
    def connector_name(self):
        return "leaf"

    def yield_raws(self):
        yield from self._raws

    def raw_to_normalized(self, raw_item):
        return self._mapping(raw_item)

    def dump_trades_to_json(self, trades):
        return ""


class _Hub(BaseHubConnector):
    @property
    def connector_name(self):
        return "hub"


def test_none_results_are_dropped_not_reported_as_errors():
    tx = MagicMock(date_time=None)
    leaf = _Leaf([{"id": "ok"}, {"id": "canceled"}], lambda r: tx if r["id"] == "ok" else None)

    out = list(leaf.yield_normalized())

    assert out == [({"id": "ok"}, tx, None)]


def test_fetch_complete_marker_is_falsy_and_passes_through_hub():
    hub = _Hub(child_connectors=[], config={"test_mode": False, "disable_file_output": True})
    marker = {"connector_name": "x", "_connector_id": 3, "_master_source": "x", "_fetch_complete": True}

    assert hub.raw_to_normalized(marker) is FETCH_COMPLETE
    assert not FETCH_COMPLETE


def test_hub_yields_marker_tuple():
    hub = _Hub(child_connectors=[], config={"test_mode": False, "disable_file_output": True})
    marker = {"connector_name": "x", "_connector_id": 3, "_master_source": "x", "_fetch_complete": True}
    hub.yield_raws = lambda: iter([marker])
    hub.dump_trades_to_json = lambda trades: ""

    assert list(hub.yield_normalized()) == [(marker, FETCH_COMPLETE, None)]
