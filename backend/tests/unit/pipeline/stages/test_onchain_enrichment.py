"""
Tests for OnChainAddressLookupService and OnChainAddressEnrichmentStage.
"""

import pytest
from datetime import datetime
from unittest.mock import MagicMock, patch

from backend.db.models import NormalizedTransaction
from backend.services.onchain_address_lookup import (
    OnChainAddressLookupService,
    NETWORK_TO_MORALIS_CHAIN,
)
from backend.services.pipeline.stages.onchain_enrichment import (
    OnChainAddressEnrichmentStage,
)
from backend.services.pipeline.context import PipelineContext


# ===== Fixtures =====


@pytest.fixture
def lookup_service():
    """Create a lookup service with minimal delay for tests."""
    svc = OnChainAddressLookupService(request_delay=0, max_retries=1)
    svc.api_key = "test-api-key"
    return svc


@pytest.fixture
def stage():
    return OnChainAddressEnrichmentStage()


@pytest.fixture
def mock_context():
    return PipelineContext(session=MagicMock())


@pytest.fixture
def moralis_success_response():
    """Moralis Transaction API successful response."""
    return {
        "hash": "0xabc123",
        "from_address": "0x1234567890abcdef1234567890abcdef12345678",
        "to_address": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        "block_number": "1",
        "from_address_entity": "Binance",
        "from_address_label": "Binance: Withdrawal Hot Wallet",
    }


@pytest.fixture
def deposit_tx_missing_from():
    return NormalizedTransaction(
        source="mexc-deposits",
        source_transaction_id="dep_001",
        source_transaction_type="deposit",
        source_asset_symbol="USDT",
        date_time=datetime(2024, 6, 15, 12, 0, 0),
        direction="inflow",
        transaction_type="transfer",
        quantity=100.0,
        network="bsc",
        network_transaction_id="0xabc123def456",
        source_from_account=None,
        source_to_account="mexc_deposits",
    )


@pytest.fixture
def withdrawal_tx_missing_to():
    return NormalizedTransaction(
        source="binance-withdrawals",
        source_transaction_id="wd_001",
        source_transaction_type="withdrawal",
        source_asset_symbol="BNB",
        date_time=datetime(2024, 6, 15, 14, 0, 0),
        direction="outflow",
        transaction_type="transfer",
        quantity=1.5,
        network="bep20",
        network_transaction_id="0xdef789abc012",
        source_from_account="binance_withdrawals",
        source_to_account=None,
    )


# ===== OnChainAddressLookupService Tests =====


class TestOnChainAddressLookupService:
    """Critical tests for the lookup service."""

    def test_unsupported_network_returns_none(self, lookup_service):
        assert lookup_service.lookup_address("ethereum", "0xabc", "inflow") is None

    def test_empty_inputs_return_none(self, lookup_service):
        assert lookup_service.lookup_address("bsc", "", "inflow") is None
        assert lookup_service.lookup_address("", "0xabc", "inflow") is None

    def test_network_aliases_all_resolve_to_bsc(self):
        for alias in ["bsc", "bep20", "bnb", "BNB", "BEP20", "BSC"]:
            assert NETWORK_TO_MORALIS_CHAIN.get(alias.lower().strip()) == "bsc"

    def test_network_aliases_all_resolve_to_arbitrum(self):
        for alias in ["arbitrum", "ARBITRUM", "arb", "ARB", "arb1", "ARB1", "arbitrum one"]:
            assert NETWORK_TO_MORALIS_CHAIN.get(alias.lower().strip()) == "arbitrum"

    @patch("backend.services.onchain_address_lookup.requests.get")
    def test_bsc_lookup_returns_from_and_to(
        self, mock_get, lookup_service, moralis_success_response
    ):
        """Single Moralis call should resolve both from (inflow) and to (outflow)."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = moralis_success_response
        mock_get.return_value = mock_response

        from_addr = lookup_service.lookup_address("bsc", "0xabc123", "inflow")
        to_addr = lookup_service.lookup_address("bsc", "0xabc123", "outflow")

        assert from_addr == "0x1234567890abcdef1234567890abcdef12345678"
        assert to_addr == "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
        # Cache should prevent second HTTP call
        assert mock_get.call_count == 1

    @patch("backend.services.onchain_address_lookup.requests.get")
    def test_api_error_returns_none(self, mock_get, lookup_service):
        mock_get.side_effect = Exception("Network error")
        assert lookup_service.lookup_address("bsc", "0xabc123", "inflow") is None

    @patch("backend.services.onchain_address_lookup.requests.get")
    def test_empty_response_returns_none(self, mock_get, lookup_service):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {}
        mock_get.return_value = mock_response

        assert lookup_service.lookup_address("bsc", "0xnotfound", "inflow") is None


# ===== OnChainAddressEnrichmentStage Tests =====


class TestOnChainAddressEnrichmentStage:
    """Critical tests for the pipeline stage."""

    def test_skip_flag(self, stage):
        ctx = PipelineContext(session=MagicMock(), skip_onchain_enrichment=True)
        assert stage.should_skip(ctx) is True
        assert stage.should_skip(PipelineContext(session=MagicMock())) is False

    @patch(
        "backend.services.pipeline.stages.onchain_enrichment.OnChainAddressLookupService"
    )
    def test_enriches_deposit_missing_from(
        self, MockService, stage, mock_context, deposit_tx_missing_from
    ):
        MockService.return_value.lookup_address.return_value = "0xsender"

        result_txs, success = stage.process([deposit_tx_missing_from], mock_context)

        assert success is True
        assert result_txs[0].source_from_account == "0xsender"

    @patch(
        "backend.services.pipeline.stages.onchain_enrichment.OnChainAddressLookupService"
    )
    def test_enriches_withdrawal_missing_to(
        self, MockService, stage, mock_context, withdrawal_tx_missing_to
    ):
        MockService.return_value.lookup_address.return_value = "0xrecipient"

        result_txs, success = stage.process([withdrawal_tx_missing_to], mock_context)

        assert success is True
        assert result_txs[0].source_to_account == "0xrecipient"

    @patch(
        "backend.services.pipeline.stages.onchain_enrichment.OnChainAddressLookupService"
    )
    def test_skips_complete_tx_and_tx_without_hash(
        self, MockService, stage, mock_context
    ):
        """Transactions that already have addresses or lack tx hash should not trigger lookup."""
        complete = NormalizedTransaction(
            source="test", source_transaction_id="c1",
            source_transaction_type="deposit", source_asset_symbol="ETH",
            date_time=datetime(2024, 1, 1), direction="inflow",
            transaction_type="transfer", quantity=1.0, network="bsc",
            network_transaction_id="0xfull",
            source_from_account="0xalready_known",
            source_to_account="okx",
        )
        no_hash = NormalizedTransaction(
            source="test", source_transaction_id="n1",
            source_transaction_type="deposit", source_asset_symbol="USDT",
            date_time=datetime(2024, 1, 1), direction="inflow",
            transaction_type="transfer", quantity=50.0, network="bsc",
            network_transaction_id=None, source_from_account=None,
        )

        result_txs, success = stage.process([complete, no_hash], mock_context)

        assert success is True
        MockService.return_value.lookup_address.assert_not_called()

    @patch(
        "backend.services.pipeline.stages.onchain_enrichment.OnChainAddressLookupService"
    )
    def test_graceful_failure_adds_warning(
        self, MockService, stage, mock_context, deposit_tx_missing_from
    ):
        MockService.return_value.lookup_address.side_effect = RuntimeError("boom")

        result_txs, success = stage.process([deposit_tx_missing_from], mock_context)

        assert success is True
        assert result_txs[0].source_from_account is None
        assert len(mock_context.warnings) == 1
        assert "dep_001" in mock_context.warnings[0]
