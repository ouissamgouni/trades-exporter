"""Unit tests for connector type picker metadata and the switch-provider endpoint."""

from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from backend.api.routes.account_connectors import (
    ConnectorSwitchRequest,
    get_available_connectors,
    switch_connector_type,
)
from backend.db.models import Account, AccountConnector


class TestConnectorTypeMetadata:
    def test_chain_options_normalize_moralis_eth(self):
        moralis = get_available_connectors()["moralis"]
        eth = next(c for c in moralis.chains if c.value == "eth")
        assert eth.canonical == "ethereum"
        assert eth.label == "Ethereum"

    def test_status_and_recommendations(self):
        available = get_available_connectors()
        assert available["moralis"].status == "legacy"
        assert available["blockscout"].status == "degraded"
        assert set(available["blockscout"].degraded_chains) == {
            "base",
            "polygon",
            "arbitrum",
            "hyperevm",
        }
        assert "hyperevm" in available["etherscan"].recommended_for
        assert "bsc" in available["ankr"].recommended_for
        assert available["ankr"].required_env == ["ANKR_API_KEY"]

    def test_groups(self):
        available = get_available_connectors()
        assert available["ankr"].group == "evm"
        assert available["sui"].group == "chain"
        assert available["polymarket"].group == "app"
        assert available["binance-transactions"].group == "exchange"
        assert available["okx-file"].group == "file"

    def test_missing_env_reports_names_only(self, monkeypatch):
        monkeypatch.delenv("ANKR_API_KEY", raising=False)
        assert get_available_connectors()["ankr"].missing_env == ["ANKR_API_KEY"]
        monkeypatch.setenv("ANKR_API_KEY", "secret-value")
        info = get_available_connectors()["ankr"]
        assert info.missing_env == []
        assert "secret-value" not in info.model_dump_json()


class _FakeRepo:
    def __init__(self, connectors):
        self.connectors = connectors

    def get_by_account_and_type(self, account_id, connector_type):
        return next(
            (
                c
                for c in self.connectors
                if c.account_id == account_id and c.connector_type == connector_type
            ),
            None,
        )

    def update(self, connector):
        return connector


def _connector(connector_type, config, connector_id=1):
    return AccountConnector(
        id=connector_id,
        account_id=1,
        connector_type=connector_type,
        enabled=True,
        config=config,
        sync_priority=100,
        created_at=datetime(2024, 1, 1),
        updated_at=datetime(2024, 1, 1),
    )


def _switch(connectors, current, new, last_tx=None):
    session = MagicMock()
    session.get.return_value = Account(id=1, name="W", account_type="wallet")
    with (
        patch(
            "backend.api.routes.account_connectors.get_repo",
            return_value=_FakeRepo(connectors),
        ),
        patch(
            "backend.api.routes.account_connectors.NormalizedTransactionRepository"
        ) as tx_repo,
    ):
        tx_repo.return_value.get_max_datetime_by_connector.return_value = last_tx
        return switch_connector_type(
            account_id=1,
            connector_type=current,
            request=ConnectorSwitchRequest(new_connector_type=new),
            session=session,
        )


class TestSwitchConnectorType:
    def test_moralis_to_ankr_maps_chain_and_keeps_row(self):
        conn = _connector(
            "moralis", {"chain": "eth", "address": "0xabc"}, connector_id=687
        )
        result = _switch([conn], "moralis", "ankr")
        assert result.id == 687
        assert result.connector_type == "ankr"
        assert result.config == {"chain": "ethereum", "address": "0xabc"}

    def test_history_cutoff_set_to_last_transaction(self):
        conn = _connector("blockscout", {"chain": "base", "address": "0xabc"})
        result = _switch(
            [conn], "blockscout", "ankr", last_tx=datetime(2026, 2, 5, 7, 23, 51)
        )
        assert result.config["history_cutoff"] == "2026-02-05T07:23:51+00:00"
        assert result.config["chain"] == "base"

    def test_history_cutoff_never_moves_back(self):
        conn = _connector(
            "ankr", {"chain": "base", "history_cutoff": "2026-02-05T07:23:51+00:00"}
        )
        result = _switch([conn], "ankr", "blockscout", last_tx=datetime(2026, 1, 1))
        assert result.config["history_cutoff"] == "2026-02-05T07:23:51+00:00"

    def test_ankr_to_moralis_maps_back_to_eth(self):
        conn = _connector("ankr", {"chain": "ethereum"})
        assert _switch([conn], "ankr", "moralis").config["chain"] == "eth"

    def test_unsupported_chain_rejected(self):
        conn = _connector("ankr", {"chain": "bsc"})
        with pytest.raises(HTTPException) as exc:
            _switch([conn], "ankr", "blockscout")
        assert exc.value.status_code == 400

    def test_existing_target_type_rejected(self):
        conns = [
            _connector("ankr", {"chain": "base"}, connector_id=1),
            _connector("blockscout", {"chain": "ethereum"}, connector_id=2),
        ]
        with pytest.raises(HTTPException) as exc:
            _switch(conns, "ankr", "blockscout")
        assert "already exists" in exc.value.detail

    @pytest.mark.parametrize(
        "current,new,config",
        [
            ("binance-transactions", "ankr", {}),
            ("blockscout", "polymarket", {"chain": "polygon"}),
        ],
    )
    def test_non_generic_onchain_rejected(self, current, new, config):
        with pytest.raises(HTTPException) as exc:
            _switch([_connector(current, config)], current, new)
        assert exc.value.status_code == 400

    def test_missing_connector_404(self):
        with pytest.raises(HTTPException) as exc:
            _switch([], "moralis", "ankr")
        assert exc.value.status_code == 404
