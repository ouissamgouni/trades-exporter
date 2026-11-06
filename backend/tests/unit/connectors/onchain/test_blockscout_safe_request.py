from unittest.mock import MagicMock, patch

import pytest

from backend.connectors.onchain.blockscout.base_blockscout_connector import (
    BlockscoutClientError,
)
from backend.connectors.onchain.blockscout.connector_blockscout_normal_tx import (
    ConnectorBlockscoutNormalTx,
)


def _bare_connector():
    c = object.__new__(ConnectorBlockscoutNormalTx)
    c.base_url = "https://explorer.example/api/v2"
    c.request_delay = 0
    c.max_retries = 3
    return c


def _response(status, text="", payload=None):
    r = MagicMock(status_code=status, text=text, url="https://explorer.example/api/v2/x")
    r.json.return_value = payload or {}
    return r


@patch("backend.connectors.onchain.blockscout.base_blockscout_connector.time.sleep")
@patch("backend.connectors.onchain.blockscout.base_blockscout_connector.requests.get")
def test_client_error_fails_fast_with_url(mock_get, _sleep):
    mock_get.return_value = _response(404, "<html>Redirecting to hl.eco</html>")
    with pytest.raises(BlockscoutClientError, match="HTTP 404 from https://explorer.example"):
        _bare_connector().safe_request("/x")
    assert mock_get.call_count == 1


@patch("backend.connectors.onchain.blockscout.base_blockscout_connector.time.sleep")
@patch("backend.connectors.onchain.blockscout.base_blockscout_connector.requests.get")
def test_server_error_is_retried(mock_get, _sleep):
    mock_get.side_effect = [_response(502), _response(200, payload={"items": []})]
    assert _bare_connector().safe_request("/x") == {"items": []}
    assert mock_get.call_count == 2
