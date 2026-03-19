"""
Unit tests for SimilarityService – network-aware account suggestion filtering.
"""

from types import SimpleNamespace

from backend.services.similarity_service import get_best_account_suggestion


def _account(id, name, address=None):
    """Create a minimal account-like object."""
    return SimpleNamespace(id=id, name=name, address_or_identifier=address)


def _connector(connector_type, chain=None):
    """Create a minimal connector-like object."""
    return SimpleNamespace(connector_type=connector_type, config={"chain": chain} if chain else {})


class TestNetworkAwareSuggestions:
    """Verify that network filtering narrows suggestions to chain-matching accounts."""

    def test_filters_to_matching_chain(self):
        """When network is provided, only accounts with matching chain connectors should be considered."""
        tangem_base = _account(1, "Tangem Base", "0xABC123")
        tangem_bsc = _account(2, "Tangem BSC", "0xABC123")

        connectors_map = {
            1: [_connector("blockscout", chain="base")],
            2: [_connector("bscscan", chain="bsc")],
        }

        # Should suggest Tangem Base for network='base'
        suggestion = get_best_account_suggestion(
            label="0xABC123",
            accounts=[tangem_base, tangem_bsc],
            network="base",
            account_connectors_map=connectors_map,
        )
        assert suggestion is not None
        assert suggestion.id == 1
        assert suggestion.name == "Tangem Base"

        # Should suggest Tangem BSC for network='bsc'
        suggestion = get_best_account_suggestion(
            label="0xABC123",
            accounts=[tangem_base, tangem_bsc],
            network="bsc",
            account_connectors_map=connectors_map,
        )
        assert suggestion is not None
        assert suggestion.id == 2
        assert suggestion.name == "Tangem BSC"

    def test_fallback_when_no_chain_match(self):
        """When no account matches the network, should fall back to all accounts."""
        tangem_base = _account(1, "Tangem Base", "0xABC123")

        connectors_map = {
            1: [_connector("blockscout", chain="base")],
        }

        # No account has chain='polygon', should fall back and still match
        suggestion = get_best_account_suggestion(
            label="0xABC123",
            accounts=[tangem_base],
            network="polygon",
            account_connectors_map=connectors_map,
        )
        assert suggestion is not None
        assert suggestion.id == 1

    def test_no_network_returns_best_overall(self):
        """When network is empty/None, all accounts should be considered."""
        tangem_base = _account(1, "Tangem Base", "0xABC123")
        tangem_bsc = _account(2, "Tangem BSC", "0xABC123")

        connectors_map = {
            1: [_connector("blockscout", chain="base")],
            2: [_connector("bscscan", chain="bsc")],
        }

        # Without network, should pick one of the two (both 100% match)
        suggestion = get_best_account_suggestion(
            label="0xABC123",
            accounts=[tangem_base, tangem_bsc],
            network="",
            account_connectors_map=connectors_map,
        )
        assert suggestion is not None
        # Either is valid since both are 100% match
        assert suggestion.id in (1, 2)

    def test_connector_boost_with_network(self):
        """Source connector boost should still apply after network filtering."""
        tangem_base = _account(1, "Tangem Base", "0xABC123")
        other = _account(3, "Other Base", "0xDEF456")

        connectors_map = {
            1: [_connector("blockscout", chain="base")],
            3: [_connector("blockscout", chain="base")],
        }

        # Both match chain, but tangem_base has exact address match
        suggestion = get_best_account_suggestion(
            label="0xABC123",
            accounts=[tangem_base, other],
            source="blockscout",
            network="base",
            account_connectors_map=connectors_map,
        )
        assert suggestion is not None
        assert suggestion.id == 1
