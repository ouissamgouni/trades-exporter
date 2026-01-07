"""
Unit tests for the GroupingEngine service.

Tests the transaction grouping rules:
- Rule 1: Network TX ID match (transfer)
- Rule 2: Same asset transfer between owned accounts
- Rule 3: Same source_transaction_id grouping (swap)
- Rule 4: Swap detection (different assets, same account)
- Rule 5: Bridge detection (same asset, different accounts)
- Rule 6: Review group for remaining transactions
"""

import pytest
from datetime import datetime, timedelta
from decimal import Decimal

from backend.services.grouping_engine import (
    GroupingEngine,
    GroupingConfig,
    TransactionData,
    PATTERN_TRANSFER,
    PATTERN_SWAP,
    PATTERN_UNKNOWN,
)


# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def engine():
    """Create a grouping engine with default config."""
    return GroupingEngine(GroupingConfig())


@pytest.fixture
def custom_engine():
    """Create a grouping engine with custom config for testing."""
    config = GroupingConfig(
        transfer_time_window=600,  # 10 minutes
        swap_time_window=120,  # 2 minutes
        quantity_tolerance=0.10,  # 10%
    )
    return GroupingEngine(config)


def make_tx(
    id: int,
    direction: str,
    symbol: str = "ETH",
    source: str = "test",
    dt: datetime = None,
    asset_id: int = None,
    account_id: int = None,
    to_account_id: int = None,
    from_account_id: int = None,
    source_transaction_id: str = None,
    network_transaction_id: str = None,
    quantity: Decimal = Decimal("1.0"),
    total_in_base: Decimal = None,
    network: str = None,
) -> TransactionData:
    """Helper to create test transaction data."""
    return TransactionData(
        id=id,
        source=source,
        source_transaction_id=source_transaction_id,
        network_transaction_id=network_transaction_id,
        date_time=dt or datetime.now(),
        direction=direction,
        transaction_type="disposal" if direction == "outflow" else "acquisition",
        asset_id=asset_id,
        source_asset_symbol=symbol,
        quantity=quantity,
        total_in_base=total_in_base,
        account_id=account_id,
        to_account_id=to_account_id,
        from_account_id=from_account_id,
        source_to_account=None,
        source_from_account=None,
        network=network,
    )


# =============================================================================
# Rule 1: Network TX ID Match Tests
# =============================================================================


class TestRule1NetworkTxMatch:
    """Tests for Rule 1: Network TX ID exact match."""

    def test_exact_network_tx_match(self, engine):
        """Should group when outflow.network_transaction_id == inflow.source_transaction_id."""
        now = datetime.now()
        tx_hash = "0xabc123"

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            dt=now,
            network_transaction_id=tx_hash,
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="ETH",
            dt=now + timedelta(minutes=1),
            source_transaction_id=tx_hash,
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        assert len(suggestions) == 1
        assert suggestions[0].pattern == PATTERN_TRANSFER
        assert suggestions[0].confidence == 1.0
        assert set(suggestions[0].transaction_ids) == {1, 2}
        assert "network tx hash match" in suggestions[0].reason.lower()

    def test_no_match_when_hash_differs(self, engine):
        """Should not match when hashes are different."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            network_transaction_id="0xabc",
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            source_transaction_id="0xdef",
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        # Should fall through to review group
        transfer_suggestions = [
            s for s in suggestions if s.pattern == PATTERN_TRANSFER
        ]
        assert len(transfer_suggestions) == 0


# =============================================================================
# Rule 2: Same Asset Transfer Tests
# =============================================================================


class TestRule2SameAssetTransfer:
    """Tests for Rule 2: Same asset transfer between owned accounts."""

    def test_same_asset_transfer_by_asset_id(self, engine):
        """Should group transfer when asset_id matches and account relationship is correct."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            asset_id=100,
            account_id=1,
            to_account_id=2,
            dt=now,
            quantity=Decimal("1.0"),
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="ETH",
            asset_id=100,
            account_id=2,  # Must match outflow.to_account_id
            dt=now + timedelta(minutes=2),
            quantity=Decimal("1.0"),
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        transfer_suggestions = [
            s for s in suggestions if s.pattern == PATTERN_TRANSFER
        ]
        assert len(transfer_suggestions) == 1
        assert transfer_suggestions[0].confidence >= 0.8
        assert set(transfer_suggestions[0].transaction_ids) == {1, 2}

    def test_same_asset_transfer_by_symbol(self, engine):
        """Should match by symbol when asset_id is None."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            account_id=1,
            to_account_id=2,
            dt=now,
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="ETH",
            account_id=2,
            dt=now + timedelta(minutes=1),
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        transfer_suggestions = [
            s for s in suggestions if s.pattern == PATTERN_TRANSFER
        ]
        assert len(transfer_suggestions) == 1

    def test_no_transfer_when_same_account(self, engine):
        """Should not suggest transfer when both transactions are on same account."""
        now = datetime.now()

        outflow = make_tx(id=1, direction="outflow", account_id=1, dt=now)
        inflow = make_tx(id=2, direction="inflow", account_id=1, dt=now)

        suggestions = engine.suggest_groups([outflow, inflow])

        # Should be swap or review, not transfer
        transfer_suggestions = [
            s for s in suggestions if s.pattern == PATTERN_TRANSFER
        ]
        assert len(transfer_suggestions) == 0

    def test_no_transfer_when_quantity_differs_too_much(self, engine):
        """Should not suggest transfer when quantity difference exceeds tolerance."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            account_id=1,
            to_account_id=2,
            quantity=Decimal("1.0"),
            dt=now,
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            account_id=2,
            quantity=Decimal("0.5"),  # 50% difference
            dt=now,
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        transfer_suggestions = [
            s for s in suggestions if s.pattern == PATTERN_TRANSFER
        ]
        assert len(transfer_suggestions) == 0

    def test_no_transfer_when_time_exceeds_window(self, engine):
        """Should not suggest transfer when time difference exceeds window."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            account_id=1,
            to_account_id=2,
            dt=now,
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            account_id=2,
            dt=now + timedelta(minutes=10),  # Exceeds 5 min default
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        transfer_suggestions = [
            s for s in suggestions if s.pattern == PATTERN_TRANSFER
        ]
        assert len(transfer_suggestions) == 0


# =============================================================================
# Rule 3: Same Source TX ID Tests
# =============================================================================


class TestRule3SameSourceTxId:
    """Tests for Rule 3: Same source_transaction_id grouping."""

    def test_swap_from_same_source_tx_id(self, engine):
        """Should suggest swap when 1 inflow + 1 outflow share source_tx_id."""
        now = datetime.now()
        tx_id = "swap-123"

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            source_transaction_id=tx_id,
            dt=now,
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="USDC",
            source_transaction_id=tx_id,
            dt=now,
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        swap_suggestions = [s for s in suggestions if s.pattern == PATTERN_SWAP]
        assert len(swap_suggestions) == 1
        assert swap_suggestions[0].confidence == 0.9
        assert set(swap_suggestions[0].transaction_ids) == {1, 2}
        assert "ETH" in swap_suggestions[0].label
        assert "USDC" in swap_suggestions[0].label

    def test_multi_leg_trade(self, engine):
        """Should group multiple transactions with same source_tx_id."""
        now = datetime.now()
        tx_id = "multi-leg-123"

        transactions = [
            make_tx(
                id=1,
                direction="outflow",
                symbol="ETH",
                source_transaction_id=tx_id,
                dt=now,
            ),
            make_tx(
                id=2,
                direction="inflow",
                symbol="USDC",
                source_transaction_id=tx_id,
                dt=now,
            ),
            make_tx(
                id=3,
                direction="inflow",
                symbol="WBTC",
                source_transaction_id=tx_id,
                dt=now,
            ),
        ]

        suggestions = engine.suggest_groups(transactions)

        swap_suggestions = [s for s in suggestions if s.pattern == PATTERN_SWAP]
        assert len(swap_suggestions) == 1
        assert swap_suggestions[0].confidence == 0.8  # Lower confidence for multi-leg
        assert set(swap_suggestions[0].transaction_ids) == {1, 2, 3}
        assert "Multi-leg" in swap_suggestions[0].label


# =============================================================================
# Rule 4: Swap Detection Tests
# =============================================================================


class TestRule4SwapDetection:
    """Tests for Rule 4: Swap detection (different assets, same account)."""

    def test_swap_different_assets_same_account(self, engine):
        """Should detect swap when different assets exchanged on same account."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            asset_id=1,
            account_id=1,
            dt=now,
            total_in_base=Decimal("1000"),
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="USDC",
            asset_id=2,
            account_id=1,
            dt=now + timedelta(seconds=30),
            total_in_base=Decimal("1000"),
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        swap_suggestions = [s for s in suggestions if s.pattern == PATTERN_SWAP]
        assert len(swap_suggestions) == 1
        assert "ETH" in swap_suggestions[0].label
        assert "USDC" in swap_suggestions[0].label

    def test_swap_value_match_high_confidence(self, engine):
        """Should have higher confidence when values match."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            asset_id=1,
            account_id=1,
            dt=now,
            total_in_base=Decimal("1000"),
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="USDC",
            asset_id=2,
            account_id=1,
            dt=now + timedelta(seconds=30),
            total_in_base=Decimal("990"),  # Within 10% tolerance
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        swap_suggestions = [s for s in suggestions if s.pattern == PATTERN_SWAP]
        assert len(swap_suggestions) == 1
        assert swap_suggestions[0].confidence == 0.9

    def test_swap_time_only_lower_confidence(self, engine):
        """Should have lower confidence when only time matches (no value data)."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            asset_id=1,
            account_id=1,
            dt=now,
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="USDC",
            asset_id=2,
            account_id=1,
            dt=now + timedelta(seconds=30),
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        swap_suggestions = [s for s in suggestions if s.pattern == PATTERN_SWAP]
        assert len(swap_suggestions) == 1
        assert swap_suggestions[0].confidence == 0.7

    def test_no_swap_when_same_asset(self, engine):
        """Should not detect swap when assets are the same (that's a transfer)."""
        now = datetime.now()

        outflow = make_tx(
            id=1, direction="outflow", symbol="ETH", asset_id=1, account_id=1, dt=now
        )
        inflow = make_tx(
            id=2, direction="inflow", symbol="ETH", asset_id=1, account_id=1, dt=now
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        swap_suggestions = [s for s in suggestions if s.pattern == PATTERN_SWAP]
        assert len(swap_suggestions) == 0


# =============================================================================
# Rule 4b: Split Detection Tests
# =============================================================================


class TestRule4bSplitDetection:
    """Tests for Rule 4b: Split detection (same asset, different qty, same value)."""

    def test_basic_split_detection(self, engine):
        """Should detect a 2-for-1 split: same asset, different qty, same total value."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="AAPL",
            dt=now,
            account_id=1,
            asset_id=100,
            quantity=Decimal("100"),
            total_in_base=Decimal("10000"),  # $100 per share
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="AAPL",
            dt=now + timedelta(seconds=30),
            account_id=1,
            asset_id=100,
            quantity=Decimal("200"),  # 2x quantity
            total_in_base=Decimal("10000"),  # Same total value
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        assert len(suggestions) == 1
        assert suggestions[0].pattern == PATTERN_SWAP
        assert "Split" in suggestions[0].label
        assert "2:1" in suggestions[0].label
        assert suggestions[0].confidence >= 0.85
        assert set(suggestions[0].transaction_ids) == {1, 2}

    def test_reverse_split_detection(self, engine):
        """Should detect a reverse split: more shares out, fewer in."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="AAPL",
            dt=now,
            account_id=1,
            asset_id=100,
            quantity=Decimal("200"),
            total_in_base=Decimal("10000"),
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="AAPL",
            dt=now + timedelta(seconds=30),
            account_id=1,
            asset_id=100,
            quantity=Decimal("100"),  # Half quantity
            total_in_base=Decimal("10000"),  # Same total value
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        assert len(suggestions) == 1
        assert suggestions[0].pattern == PATTERN_SWAP
        assert "Reverse Split" in suggestions[0].label
        assert set(suggestions[0].transaction_ids) == {1, 2}

    def test_no_split_when_same_quantity(self, engine):
        """Should NOT detect split when quantities are equal (that's a transfer)."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="AAPL",
            dt=now,
            account_id=1,
            asset_id=100,
            quantity=Decimal("100"),
            total_in_base=Decimal("10000"),
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="AAPL",
            dt=now + timedelta(seconds=30),
            account_id=1,
            asset_id=100,
            quantity=Decimal("100"),  # Same quantity
            total_in_base=Decimal("10000"),
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        # Should not be detected as split
        split_suggestions = [s for s in suggestions if "Split" in s.label]
        assert len(split_suggestions) == 0

    def test_no_split_when_different_assets(self, engine):
        """Should NOT detect split when assets differ (that's a swap)."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="AAPL",
            dt=now,
            account_id=1,
            asset_id=100,
            quantity=Decimal("100"),
            total_in_base=Decimal("10000"),
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="GOOG",  # Different asset
            dt=now + timedelta(seconds=30),
            account_id=1,
            asset_id=200,
            quantity=Decimal("50"),
            total_in_base=Decimal("10000"),
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        # Should be detected as swap, not split
        split_suggestions = [s for s in suggestions if "Split" in s.label]
        assert len(split_suggestions) == 0

    def test_no_split_when_different_accounts(self, engine):
        """Should NOT detect split when accounts differ (that's a transfer/bridge)."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="AAPL",
            dt=now,
            account_id=1,  # Different account
            asset_id=100,
            quantity=Decimal("100"),
            total_in_base=Decimal("10000"),
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="AAPL",
            dt=now + timedelta(seconds=30),
            account_id=2,  # Different account
            asset_id=100,
            quantity=Decimal("200"),
            total_in_base=Decimal("10000"),
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        # Should not be detected as split
        split_suggestions = [s for s in suggestions if "Split" in s.label]
        assert len(split_suggestions) == 0

    def test_no_split_when_values_differ(self, engine):
        """Should NOT detect split when total values differ significantly."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="AAPL",
            dt=now,
            account_id=1,
            asset_id=100,
            quantity=Decimal("100"),
            total_in_base=Decimal("10000"),
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="AAPL",
            dt=now + timedelta(seconds=30),
            account_id=1,
            asset_id=100,
            quantity=Decimal("200"),
            total_in_base=Decimal("15000"),  # 50% different value
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        # Should not be detected as split (value diff > 10% tolerance)
        split_suggestions = [s for s in suggestions if "Split" in s.label]
        assert len(split_suggestions) == 0

    def test_no_split_when_no_value_data(self, engine):
        """Should NOT detect split when total_in_base is missing."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="AAPL",
            dt=now,
            account_id=1,
            asset_id=100,
            quantity=Decimal("100"),
            # No total_in_base
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="AAPL",
            dt=now + timedelta(seconds=30),
            account_id=1,
            asset_id=100,
            quantity=Decimal("200"),
            # No total_in_base
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        # Should not be detected as split without value data
        split_suggestions = [s for s in suggestions if "Split" in s.label]
        assert len(split_suggestions) == 0


# =============================================================================
# Rule 5: Bridge Detection Tests
# =============================================================================


class TestRule5BridgeDetection:
    """Tests for Rule 5: Bridge detection (same asset, different accounts, not to_account)."""

    def test_bridge_same_asset_different_accounts(self, engine):
        """Should detect bridge when same asset on different accounts (not to_account)."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            asset_id=1,
            account_id=1,
            to_account_id=None,  # No known destination
            dt=now,
            quantity=Decimal("1.0"),
            network="ethereum",
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="ETH",
            asset_id=1,
            account_id=3,  # Different account, not matched to to_account
            dt=now + timedelta(minutes=2),
            quantity=Decimal("0.98"),  # Small fee deducted
            network="arbitrum",
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        bridge_suggestions = [
            s for s in suggestions if s.pattern == PATTERN_TRANSFER
        ]
        assert len(bridge_suggestions) == 1
        assert "Bridge" in bridge_suggestions[0].label
        assert bridge_suggestions[0].confidence >= 0.8

    def test_bridge_with_different_networks(self, engine):
        """Should include network names in bridge label when available."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="USDC",
            account_id=1,
            dt=now,
            network="ethereum",
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="USDC",
            account_id=2,
            dt=now + timedelta(minutes=1),
            network="polygon",
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        bridge_suggestions = [
            s for s in suggestions if s.pattern == PATTERN_TRANSFER
        ]
        assert len(bridge_suggestions) == 1
        assert "ethereum" in bridge_suggestions[0].label.lower()
        assert "polygon" in bridge_suggestions[0].label.lower()


# =============================================================================
# Rule 6: Review Group Tests
# =============================================================================


class TestRule6ReviewGroup:
    """Tests for Rule 6: Catch-all review group."""

    def test_remaining_transactions_in_review(self, engine):
        """Should place ungrouped transactions in review group."""
        now = datetime.now()

        # These don't match any rules
        tx1 = make_tx(
            id=1,
            direction="inflow",
            symbol="RANDOM1",
            account_id=1,
            dt=now,
        )
        tx2 = make_tx(
            id=2,
            direction="inflow",
            symbol="RANDOM2",
            account_id=2,
            dt=now + timedelta(hours=1),
        )

        suggestions = engine.suggest_groups([tx1, tx2])

        review_suggestions = [
            s for s in suggestions if s.pattern == PATTERN_UNKNOWN
        ]
        assert len(review_suggestions) == 1
        assert review_suggestions[0].confidence == 0.0
        assert set(review_suggestions[0].transaction_ids) == {1, 2}
        assert "manual review" in review_suggestions[0].reason.lower()

    def test_empty_transactions_no_suggestions(self, engine):
        """Should return empty list when no transactions provided."""
        suggestions = engine.suggest_groups([])
        assert suggestions == []


# =============================================================================
# Priority and Edge Cases
# =============================================================================


class TestPriorityAndEdgeCases:
    """Tests for rule priority and edge cases."""

    def test_rules_applied_in_priority_order(self, engine):
        """Higher priority rules should take precedence."""
        now = datetime.now()
        tx_hash = "0xabc123"

        # This pair matches both Rule 1 (network TX match) and Rule 2 (transfer)
        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            account_id=1,
            to_account_id=2,
            network_transaction_id=tx_hash,
            dt=now,
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="ETH",
            account_id=2,
            source_transaction_id=tx_hash,
            dt=now,
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        # Should only have one suggestion (Rule 1 wins)
        transfer_suggestions = [
            s for s in suggestions if s.pattern == PATTERN_TRANSFER
        ]
        assert len(transfer_suggestions) == 1
        assert transfer_suggestions[0].confidence == 1.0  # Rule 1's confidence

    def test_transactions_used_only_once(self, engine):
        """Each transaction should only appear in one group."""
        now = datetime.now()

        # Create 3 ETH transactions that could potentially form multiple groups
        tx1 = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            account_id=1,
            to_account_id=2,
            dt=now,
        )
        tx2 = make_tx(id=2, direction="inflow", symbol="ETH", account_id=2, dt=now)
        tx3 = make_tx(
            id=3,
            direction="inflow",
            symbol="ETH",
            account_id=2,
            dt=now + timedelta(seconds=30),
        )

        suggestions = engine.suggest_groups([tx1, tx2, tx3])

        # Collect all transaction IDs used
        all_used_ids = []
        for s in suggestions:
            all_used_ids.extend(s.transaction_ids)

        # Each ID should appear exactly once
        assert len(all_used_ids) == len(set(all_used_ids))

    def test_suggestions_sorted_by_confidence(self, engine):
        """Suggestions should be sorted by confidence (highest first)."""
        now = datetime.now()
        tx_hash = "0xabc"

        # High confidence transfer (Rule 1)
        tx1 = make_tx(id=1, direction="outflow", network_transaction_id=tx_hash, dt=now)
        tx2 = make_tx(id=2, direction="inflow", source_transaction_id=tx_hash, dt=now)

        # Lower confidence swap (Rule 4)
        tx3 = make_tx(
            id=3, direction="outflow", symbol="BTC", asset_id=10, account_id=5, dt=now
        )
        tx4 = make_tx(
            id=4,
            direction="inflow",
            symbol="USDC",
            asset_id=20,
            account_id=5,
            dt=now + timedelta(seconds=30),
        )

        suggestions = engine.suggest_groups([tx1, tx2, tx3, tx4])

        confidences = [s.confidence for s in suggestions]
        assert confidences == sorted(confidences, reverse=True)
