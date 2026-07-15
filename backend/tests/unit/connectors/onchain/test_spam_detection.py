"""
Tests for phishing / spam detection utilities and their integration with connectors.

Covers:
  - core.spam_detection utility functions (has_suspicious_unicode, detect_moralis_erc20_phishing, detect_blockscout_phishing)
  - Moralis connector ERC-20 mapping with phishing detection
  - Blockscout token-transfers connector with phishing detection
  - Blockscout normal-tx connector with phishing detection
"""

from unittest.mock import patch
from datetime import datetime, timezone

import pytest

from backend.core.spam_detection import (
    has_suspicious_unicode,
    detect_moralis_erc20_phishing,
    detect_blockscout_phishing,
    apply_spam_markers,
)
from backend.connectors.onchain.connector_moralis_wallet_history import (
    ConnectorMoralisWalletHistory,
)
from backend.connectors.onchain.blockscout.connector_blockscout_token_transfers import (
    ConnectorBlockscoutTokenTransfers,
)
from backend.connectors.onchain.blockscout.connector_blockscout_normal_tx import (
    ConnectorBlockscoutNormalTx,
)


# ============================================================================
# Tests for has_suspicious_unicode
# ============================================================================


class TestHasSuspiciousUnicode:
    """Tests for the Unicode confusable character detector."""

    def test_ascii_symbol_is_clean(self):
        assert has_suspicious_unicode("USDC") is False

    def test_ascii_name_is_clean(self):
        assert has_suspicious_unicode("USD Coin") is False

    def test_eth_is_clean(self):
        assert has_suspicious_unicode("ETH") is False

    def test_empty_string_is_clean(self):
        assert has_suspicious_unicode("") is False

    def test_none_is_clean(self):
        assert has_suspicious_unicode(None) is False

    def test_numbers_and_punctuation_clean(self):
        assert has_suspicious_unicode("USDC-2.0") is False

    def test_lisu_characters_detected(self):
        """Lisu script ꓴꓢꓓ looks like USDC but uses non-ASCII codepoints."""
        assert has_suspicious_unicode("ꓴꓢꓓС ") is True

    def test_cyrillic_c_detected(self):
        """Cyrillic С (U+0421) looks identical to Latin C."""
        assert has_suspicious_unicode("USDС") is True  # last char is Cyrillic

    def test_mixed_script_detected(self):
        assert has_suspicious_unicode("ΕΤΗ") is True  # Greek letters

    def test_single_non_ascii_letter(self):
        assert has_suspicious_unicode("а") is True  # Cyrillic 'a'


# ============================================================================
# Tests for detect_moralis_erc20_phishing
# ============================================================================


class TestDetectMoralisErc20Phishing:
    """Tests for Moralis-specific ERC-20 phishing detection."""

    # Real phishing transaction from user's report
    FAKE_TX = {
        "hash": "0x5e21206ce07d097b6483b8b9aae43d0db281065d9f0925c83cd6c9672e5108dd",
        "from_address": "0xdd202e6b7107a849fb50ed928f1756a2f60e4a04",
        "to_address": "0x27117f7e48e07f9e23042931ab39fe02a62ec587",
        "possible_spam": False,
    }

    FAKE_TRANSFER = {
        "token_name": "ꓴꓢꓓС ",
        "token_symbol": "ꓴꓢꓓС ",
        "token_logo": None,
        "token_decimals": "6",
        "from_address": "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
        "to_address": "0x2df17470c5de6a5d2d41feb8fcf5fb0deeb43df7",
        "address": "0xf247ca2d0f8ada063a259972285e31f127639f88",
        "log_index": 3,
        "value": "578200000",
        "possible_spam": False,
        "verified_contract": False,
        "security_score": None,
    }

    # Real legitimate transaction
    LEGIT_TX = {
        "hash": "0x15408e68873c2764a853de9b2a6a99e065ca82ba830c0f718e150346e6eefafa",
        "from_address": "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
        "to_address": "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        "possible_spam": False,
    }

    LEGIT_TRANSFER = {
        "token_name": "USD Coin",
        "token_symbol": "USDC",
        "token_logo": "https://logo.moralis.io/0xa4b1_0xaf88d065e77c8cc2239327c5edb3a432268e5831_55d334b7a54674580fd69d47086979b4.webp",
        "token_decimals": "6",
        "from_address": "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
        "to_address": "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef",
        "address": "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        "log_index": 0,
        "value": "578200000",
        "possible_spam": False,
        "verified_contract": True,
        "security_score": 93,
    }

    WALLET = "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead"

    def test_fake_tx_detected(self):
        """The phishing transaction from the user's report should be detected."""
        reasons = detect_moralis_erc20_phishing(self.FAKE_TX, self.FAKE_TRANSFER, self.WALLET)
        assert len(reasons) > 0
        assert "unverified_contract" in reasons
        assert "confusable_unicode" in reasons
        assert "spoofed_sender" in reasons

    def test_legit_tx_clean(self):
        """The legitimate USDC transaction should NOT be flagged."""
        reasons = detect_moralis_erc20_phishing(self.LEGIT_TX, self.LEGIT_TRANSFER, self.WALLET)
        assert reasons == []

    def test_unverified_contract_only(self):
        """Unverified contract with no security score should trigger."""
        transfer = {
            "token_name": "SomeToken",
            "token_symbol": "STK",
            "verified_contract": False,
            "security_score": None,
            "from_address": "0xwallet",
            "to_address": "0xother",
        }
        tx = {"from_address": "0xwallet", "to_address": "0xcontract"}
        reasons = detect_moralis_erc20_phishing(tx, transfer, "0xwallet")
        assert "unverified_contract" in reasons

    def test_verified_contract_clean(self):
        """Verified contract should NOT trigger unverified_contract signal."""
        transfer = {
            "token_name": "SomeToken",
            "token_symbol": "STK",
            "verified_contract": True,
            "security_score": 80,
            "from_address": "0xwallet",
            "to_address": "0xother",
        }
        tx = {"from_address": "0xwallet", "to_address": "0xcontract"}
        reasons = detect_moralis_erc20_phishing(tx, transfer, "0xwallet")
        assert "unverified_contract" not in reasons

    def test_low_security_score_triggers(self):
        """Unverified contract with low security score should trigger."""
        transfer = {
            "token_name": "SomeToken",
            "token_symbol": "STK",
            "verified_contract": False,
            "security_score": 5,
            "from_address": "0xwallet",
            "to_address": "0xother",
        }
        tx = {"from_address": "0xwallet", "to_address": "0xcontract"}
        reasons = detect_moralis_erc20_phishing(tx, transfer, "0xwallet")
        assert "unverified_contract" in reasons

    def test_spoofed_sender_detected(self):
        """Address poisoning: outer from ≠ wallet but transfer from == wallet."""
        transfer = {
            "token_name": "USDT",
            "token_symbol": "USDT",
            "verified_contract": True,
            "security_score": 90,
            "from_address": "0xMYWALLET",
            "to_address": "0xother",
        }
        tx = {"from_address": "0xATTACKER", "to_address": "0xcontract"}
        reasons = detect_moralis_erc20_phishing(tx, transfer, "0xmywallet")
        assert "spoofed_sender" in reasons

    def test_no_spoofing_when_wallet_initiated(self):
        """When wallet initiated the tx, no spoofed_sender should trigger."""
        transfer = {
            "token_name": "USDT",
            "token_symbol": "USDT",
            "verified_contract": True,
            "security_score": 90,
            "from_address": "0xmywallet",
            "to_address": "0xother",
        }
        tx = {"from_address": "0xmywallet", "to_address": "0xcontract"}
        reasons = detect_moralis_erc20_phishing(tx, transfer, "0xmywallet")
        assert "spoofed_sender" not in reasons


# ============================================================================
# Tests for detect_blockscout_phishing
# ============================================================================


class TestDetectBlockscoutPhishing:
    """Tests for Blockscout-specific phishing detection."""

    def test_is_scam_from_address(self):
        tx = {
            "from": {"hash": "0xscammer", "is_scam": True, "reputation": "scam"},
            "to": {"hash": "0xvictim", "is_scam": False},
        }
        reasons = detect_blockscout_phishing(tx)
        assert "is_scam" in reasons
        assert "scam_reputation" in reasons

    def test_is_scam_to_address(self):
        tx = {
            "from": {"hash": "0xsender"},
            "to": {"hash": "0xscammer", "is_scam": True},
        }
        reasons = detect_blockscout_phishing(tx)
        assert "is_scam" in reasons

    def test_spam_token_tag(self):
        tx = {
            "from": {
                "hash": "0xspam_token",
                "metadata": {
                    "tags": [
                        {
                            "name": "Spam token",
                            "tagType": "token_reputation",
                            "meta": {"data": "spam"},
                        }
                    ]
                },
            },
            "to": {"hash": "0xvictim"},
        }
        reasons = detect_blockscout_phishing(tx)
        assert "spam_token_tag" in reasons

    def test_phish_hack_tag(self):
        tx = {
            "from": {
                "hash": "0xphisher",
                "metadata": {
                    "tags": [{"name": "Phish / Hack", "tagType": "generic"}]
                },
            },
            "to": {"hash": "0xvictim"},
        }
        reasons = detect_blockscout_phishing(tx)
        assert "phish_hack_tag" in reasons

    def test_phishing_contract_name(self):
        tx = {
            "from": {
                "hash": "0xphisher",
                "name": "Visit website ondoprize .com to claim rewards",
            },
            "to": {"hash": "0xvictim"},
        }
        reasons = detect_blockscout_phishing(tx)
        assert "phishing_contract_name" in reasons

    def test_confusable_unicode_token(self):
        tx = {
            "from": {"hash": "0xsender"},
            "to": {"hash": "0xreceiver"},
            "token": {
                "symbol": "ꓴꓢꓓС",
                "name": "ꓴꓢꓓС Token",
                "address_hash": "0xfake_contract",
            },
        }
        reasons = detect_blockscout_phishing(tx)
        assert "confusable_unicode" in reasons

    def test_clean_transaction(self):
        tx = {
            "from": {
                "hash": "0xsender",
                "is_scam": False,
                "is_verified": True,
                "reputation": "ok",
                "metadata": {
                    "tags": [
                        {
                            "name": "Credible token",
                            "tagType": "token_reputation",
                            "meta": {"data": "ok"},
                        }
                    ]
                },
            },
            "to": {
                "hash": "0xreceiver",
                "is_scam": False,
                "is_verified": True,
            },
            "token": {
                "symbol": "USDC",
                "name": "USD Coin",
                "address_hash": "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
            },
        }
        reasons = detect_blockscout_phishing(tx)
        assert reasons == []

    def test_no_from_to_objects(self):
        """Handle transactions where from/to are strings instead of dicts."""
        tx = {
            "from": "0xsender",
            "to": "0xreceiver",
        }
        reasons = detect_blockscout_phishing(tx)
        assert reasons == []

    def test_deduplicates_reasons(self):
        """If both from and to are scam, reason should appear only once."""
        tx = {
            "from": {"hash": "0xa", "is_scam": True},
            "to": {"hash": "0xb", "is_scam": True},
        }
        reasons = detect_blockscout_phishing(tx)
        assert reasons.count("is_scam") == 1


# ============================================================================
# Tests for apply_spam_markers
# ============================================================================


class TestApplySpamMarkers:
    """Tests for the shared apply_spam_markers helper."""

    def test_sets_review_status_and_notes(self):
        from backend.db.models import NormalizedTransaction

        tx = NormalizedTransaction(
            source="test",
            source_transaction_id="0x123",
            date_time=datetime.now(timezone.utc),
            direction="outflow",
            transaction_type="transfer",
            source_asset_symbol="USDC",
            quantity=100.0,
        )
        apply_spam_markers(tx, ["unverified_contract"], [], tx_id="0x123")
        assert tx.review_status == "invalid"
        assert tx.taxability_status == "non_taxable"
        assert tx.source_asset_symbol == "USDC"  # NOT prefixed with SPAM_
        assert any(t.get("spam") is True for t in tx.tags)
        assert any("unverified_contract" in t.get("spam_reasons", []) for t in tx.tags)
        # Check review_notes is human-readable
        assert "Auto-flagged" in tx.review_notes
        assert "unverified" in tx.review_notes.lower()

    def test_handles_dict_tags(self):
        from backend.db.models import NormalizedTransaction

        tx = NormalizedTransaction(
            source="test",
            source_transaction_id="0x456",
            date_time=datetime.now(timezone.utc),
            direction="inflow",
            transaction_type="transfer",
            source_asset_symbol="ETH",
            quantity=1.0,
        )
        existing_tags = {"contract_address": "0xabc"}
        apply_spam_markers(tx, ["is_scam"], existing_tags, tx_id="0x456")
        assert isinstance(tx.tags, list)
        assert len(tx.tags) == 2  # original dict + spam tag
        assert tx.review_notes is not None
        assert "scam" in tx.review_notes.lower()

    def test_multiple_reasons_in_notes(self):
        from backend.db.models import NormalizedTransaction

        tx = NormalizedTransaction(
            source="test",
            source_transaction_id="0x789",
            date_time=datetime.now(timezone.utc),
            direction="outflow",
            transaction_type="transfer",
            source_asset_symbol="USDC",
            quantity=100.0,
        )
        apply_spam_markers(
            tx,
            ["unverified_contract", "confusable_unicode", "spoofed_sender"],
            [],
            tx_id="0x789",
        )
        assert "unverified" in tx.review_notes.lower()
        assert "non-ASCII" in tx.review_notes
        assert "address poisoning" in tx.review_notes.lower()


# ============================================================================
# Integration: Moralis connector with phishing detection
# ============================================================================


class TestMoralisConnectorSpamDetection:
    """Integration tests: Moralis connector marks phishing ERC-20 transfers."""

    WALLET = "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead"

    def _make_connector(self):
        return ConnectorMoralisWalletHistory(
            wallet_address=self.WALLET,
            chain_name="arbitrum",
            config={"test_mode": True},
        )

    def test_phishing_tx_marked_invalid(self):
        """Phishing transaction from user's report should be auto-invalidated."""
        connector = self._make_connector()

        fake_raw_tx = {
            "hash": "0x5e21206ce07d097b6483b8b9aae43d0db281065d9f0925c83cd6c9672e5108dd",
            "from_address": "0xdd202e6b7107a849fb50ed928f1756a2f60e4a04",
            "to_address": "0x27117f7e48e07f9e23042931ab39fe02a62ec587",
            "block_timestamp": "2025-11-26T12:57:24.000Z",
            "transaction_fee": "0.00001143787",
            "category": "token send",
            "possible_spam": False,
            "method_label": "transfer",
            "erc20_transfers": [
                {
                    "token_name": "ꓴꓢꓓС ",
                    "token_symbol": "ꓴꓢꓓС ",
                    "token_logo": None,
                    "token_decimals": "6",
                    "from_address": "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
                    "to_address": "0x2df17470c5de6a5d2d41feb8fcf5fb0deeb43df7",
                    "address": "0xf247ca2d0f8ada063a259972285e31f127639f88",
                    "log_index": 3,
                    "value": "578200000",
                    "possible_spam": False,
                    "verified_contract": False,
                    "security_score": None,
                    "direction": "send",
                    "value_formatted": "578.2",
                }
            ],
            "native_transfers": [],
            "nft_transfers": [],
        }

        results = list(connector.raw_to_normalized(fake_raw_tx))
        assert len(results) == 1
        normalized = results[0]

        assert normalized.review_status == "invalid"
        assert normalized.taxability_status == "non_taxable"
        assert "SPAM_" not in normalized.source_asset_symbol  # no prefix
        assert any(t.get("spam") is True for t in normalized.tags)
        assert normalized.review_notes is not None
        assert "Auto-flagged" in normalized.review_notes

    def test_legit_tx_not_flagged(self):
        """Legitimate USDC transfer should remain normal."""
        connector = self._make_connector()

        legit_raw_tx = {
            "hash": "0x15408e68873c2764a853de9b2a6a99e065ca82ba830c0f718e150346e6eefafa",
            "from_address": "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
            "to_address": "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
            "block_timestamp": "2025-11-26T12:55:23.000Z",
            "transaction_fee": "0.00000045303",
            "category": "token send",
            "possible_spam": False,
            "method_label": "transfer",
            "erc20_transfers": [
                {
                    "token_name": "USD Coin",
                    "token_symbol": "USDC",
                    "token_logo": "https://logo.moralis.io/0xa4b1_0xaf88d065e77c8cc2239327c5edb3a432268e5831.webp",
                    "token_decimals": "6",
                    "from_address": "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
                    "to_address": "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef",
                    "address": "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
                    "log_index": 0,
                    "value": "578200000",
                    "possible_spam": False,
                    "verified_contract": True,
                    "security_score": 93,
                    "direction": "send",
                    "value_formatted": "578.2",
                }
            ],
            "native_transfers": [],
            "nft_transfers": [],
        }

        results = list(connector.raw_to_normalized(legit_raw_tx))
        assert len(results) == 1
        normalized = results[0]

        assert normalized.review_status == "pending"  # default, not "invalid"
        assert normalized.source_asset_symbol == "USDC"
        # No spam tag
        spam_tags = [t for t in (normalized.tags or []) if isinstance(t, dict) and t.get("spam") is True]
        assert spam_tags == []


# ============================================================================
# Integration: Blockscout token transfers connector with phishing detection
# ============================================================================


class TestBlockscoutTokenTransfersSpamDetection:
    """Integration tests: Blockscout token transfers connector marks phishing."""

    def _make_connector(self):
        return ConnectorBlockscoutTokenTransfers(
            wallet_address="0xTEST_WALLET",
            chain_name="base",
        )

    def test_scam_token_transfer_marked_invalid(self):
        connector = self._make_connector()

        scam_raw = {
            "transaction_hash": "0xscam_token_hash",
            "log_index": "5",
            "timestamp": "2025-10-14T20:40:51.000000Z",
            "from": {
                "hash": "0xSCAMMER",
                "is_scam": True,
                "reputation": "scam",
                "name": "Visit ondoprize .com to claim",
                "metadata": {
                    "tags": [
                        {"name": "Phish / Hack", "tagType": "generic"},
                    ]
                },
            },
            "to": {"hash": "0xTEST_WALLET"},
            "total": {"value": "1000000"},
            "token": {
                "address_hash": "0xFAKE_CONTRACT",
                "symbol": "ꓴꓢꓓС",
                "name": "Fake USDC",
                "decimals": 6,
            },
        }

        normalized = connector.raw_to_normalized(scam_raw)
        assert normalized.review_status == "invalid"
        assert normalized.taxability_status == "non_taxable"
        assert "SPAM_" not in normalized.source_asset_symbol  # no prefix
        assert normalized.review_notes is not None
        assert "Auto-flagged" in normalized.review_notes

    def test_clean_token_transfer_not_flagged(self):
        connector = self._make_connector()

        clean_raw = {
            "transaction_hash": "0xclean_hash",
            "log_index": "0",
            "timestamp": "2025-10-14T20:40:51.000000Z",
            "from": {
                "hash": "0xSENDER",
                "is_scam": False,
                "is_verified": True,
                "reputation": "ok",
            },
            "to": {"hash": "0xTEST_WALLET"},
            "total": {"value": "1000000"},
            "token": {
                "address_hash": "0xUSDC_CONTRACT",
                "symbol": "USDC",
                "name": "USD Coin",
                "decimals": 6,
            },
        }

        normalized = connector.raw_to_normalized(clean_raw)
        assert normalized.review_status == "pending"  # default, not "invalid"
        assert "SPAM_" not in (normalized.source_asset_symbol or "")


# ============================================================================
# Integration: Blockscout normal-tx connector with phishing detection
# ============================================================================


class TestBlockscoutNormalTxSpamDetection:
    """Integration tests: Blockscout normal-tx connector marks phishing."""

    def _make_connector(self):
        return ConnectorBlockscoutNormalTx(
            wallet_address="0xTEST_WALLET",
            chain_name="base",
        )

    def test_scam_normal_tx_marked_invalid(self):
        connector = self._make_connector()

        scam_raw = {
            "hash": "0xscam_hash",
            "timestamp": "2025-10-14T20:40:51.000000Z",
            "from": {
                "hash": "0xSCAMMER",
                "is_scam": True,
            },
            "to": {"hash": "0xTEST_WALLET"},
            "value": "0",
            "gas_used": "21000",
            "gas_price": "10000000",
        }

        normalized = connector.raw_to_normalized(scam_raw)
        assert normalized.review_status == "invalid"
        assert normalized.taxability_status == "non_taxable"
        assert "SPAM_" not in normalized.source_asset_symbol  # no prefix
        assert normalized.review_notes is not None
        assert "Auto-flagged" in normalized.review_notes

    def test_clean_normal_tx_not_flagged(self):
        connector = self._make_connector()

        clean_raw = {
            "hash": "0xclean_hash",
            "timestamp": "2025-10-14T20:40:51.000000Z",
            "from": {
                "hash": "0xTEST_WALLET",
                "is_scam": False,
                "reputation": "ok",
            },
            "to": {
                "hash": "0xRECEIVER",
                "is_scam": False,
            },
            "value": "1000000000000000000",
            "gas_used": "21000",
            "gas_price": "10000000",
        }

        normalized = connector.raw_to_normalized(clean_raw)
        assert normalized.review_status == "pending"  # default, not "invalid"
        assert "SPAM_" not in (normalized.source_asset_symbol or "")
