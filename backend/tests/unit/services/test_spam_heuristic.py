"""Unit tests for the unsolicited-unpriced spam heuristic."""

import pytest

from backend.db.models import NormalizedTransaction
from backend.services.spam_heuristic_service import (
    ALLOW,
    BLOCK,
    BLOCKLISTED_REASON,
    SUSPECTED_REASON,
    _mark,
    classify,
    spam_tag,
    tx_hash_of,
)


def _tx(**kw):
    defaults = dict(
        source="ankr_bsc",
        source_transaction_id="0xabc_erc20_3",
        network_transaction_id="0xABC",
        direction="inflow",
        token_contract_address="0xtoken",
        network="bsc",
        tags=[],
    )
    defaults.update(kw)
    return NormalizedTransaction(**defaults)


class TestClassify:
    def test_unsolicited_unpriced_inflow_is_suspected(self):
        assert (
            classify(_tx(), rule=None, wallet_initiated=False, priced=False)
            == SUSPECTED_REASON
        )

    @pytest.mark.parametrize(
        "tx_kw, wallet_initiated, priced",
        [
            ({}, True, False),  # wallet sent something in the same tx (swap, claim)
            ({}, False, True),  # token has a price source
            ({"direction": "outflow"}, False, False),
            (
                {"from_account_id": 7},
                False,
                False,
            ),  # sent from one of the user's accounts
        ],
    )
    def test_legit_cases_not_flagged(self, tx_kw, wallet_initiated, priced):
        assert (
            classify(
                _tx(**tx_kw),
                rule=None,
                wallet_initiated=wallet_initiated,
                priced=priced,
            )
            is None
        )

    def test_rules_override_heuristic(self):
        assert classify(_tx(), rule=ALLOW, wallet_initiated=False, priced=False) is None
        assert (
            classify(
                _tx(direction="outflow"), rule=BLOCK, wallet_initiated=True, priced=True
            )
            == BLOCKLISTED_REASON
        )


def test_tx_hash_falls_back_to_source_id_prefix():
    assert tx_hash_of(_tx()) == "0xabc"
    assert (
        tx_hash_of(
            _tx(network_transaction_id=None, source_transaction_id="0xDEF_0xa_0xb")
        )
        == "0xdef"
    )


def test_mark_suspected_then_confirmed_replaces_tag():
    tx = _tx(tags=[{"contract_address": "0xtoken"}], review_status="pending")
    _mark(tx, SUSPECTED_REASON)
    assert tx.review_status == "invalid"
    assert tx.review_notes.startswith("⚠️ Auto-flagged as suspected spam")
    assert spam_tag(tx.tags) == {
        "spam": True,
        "spam_reasons": [SUSPECTED_REASON],
        "spam_level": "suspected",
    }

    _mark(tx, BLOCKLISTED_REASON)
    spam_tags = [t for t in tx.tags if t.get("spam")]
    assert spam_tags == [{"spam": True, "spam_reasons": [BLOCKLISTED_REASON]}]
    assert {"contract_address": "0xtoken"} in tx.tags
