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
    PATTERN_INTERNAL_TRANSFER,
    PATTERN_SWAP,
    PATTERN_UNKNOWN,
)
from backend.db.models import Account, NormalizedTransaction


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
    source_transaction_type: str = None,
    transaction_type: str = None,
) -> NormalizedTransaction:
    """Helper to create test transaction data."""
    tx = NormalizedTransaction(
        id=id,
        source=source,
        source_transaction_id=source_transaction_id,
        network_transaction_id=network_transaction_id,
        source_transaction_type=source_transaction_type,
        date_time=dt or datetime.now(),
        direction=direction,
        transaction_type=transaction_type or ("disposal" if direction == "outflow" else "acquisition"),
        asset_id=asset_id,
        source_asset_symbol=symbol,
        quantity=quantity,
        account_id=account_id,
        to_account_id=to_account_id,
        from_account_id=from_account_id,
        source_to_account=None,
        source_from_account=None,
        network=network,
    )
    # Set total property (which derives price from total/quantity)
    # The grouping engine uses total property for value matching
    if total_in_base is not None:
        tx.total = total_in_base
    # Set account_rel for owned check in grouping engine
    if account_id is not None:
        tx.account_rel = Account(id=account_id, name=f"Account{account_id}", account_type="cex", owned=True)
    return tx


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
            account_id=1,
            network_transaction_id=tx_hash,
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="ETH",
            dt=now + timedelta(minutes=1),
            account_id=2,
            source_transaction_id=tx_hash,
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        assert len(suggestions) == 1
        assert suggestions[0].pattern == PATTERN_INTERNAL_TRANSFER
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
            s for s in suggestions if s.pattern == PATTERN_INTERNAL_TRANSFER
        ]
        assert len(transfer_suggestions) == 0

    def test_same_network_tx_id_different_source_tx_id(self, engine):
        """Should match when both sides share the same network_transaction_id
        even if source_transaction_id differs (e.g. Moralis appends _erc20_6).

        Real-world case: Binance withdrawal + Moralis wallet inflow both record
        the same on-chain tx hash, but Moralis uses a derived source_transaction_id.
        """
        now = datetime.now()
        tx_hash = "0x589f340766cc5d5b2bb8bff0d12644f3669b63b823ef5c57b6ee898bb7c4107c"

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="USDC",
            asset_id=226,
            account_id=310,
            dt=now,
            quantity=Decimal("132.540760"),
            network="arbitrum",
            network_transaction_id=tx_hash,
            source_transaction_id="e68b2a8d66464925880c0626fcd309f0",  # CEX internal ID
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="USDC",
            asset_id=226,
            account_id=318,
            dt=now + timedelta(seconds=41),
            quantity=Decimal("132.540760"),
            network="arbitrum",
            network_transaction_id=tx_hash,  # Same on-chain hash
            source_transaction_id=f"{tx_hash}_erc20_6",  # Moralis-derived ID with suffix
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        transfer_suggestions = [
            s for s in suggestions if s.pattern == PATTERN_INTERNAL_TRANSFER
        ]
        assert len(transfer_suggestions) == 1
        assert transfer_suggestions[0].confidence == 1.0
        assert set(transfer_suggestions[0].transaction_ids) == {1, 2}
        assert "network tx hash match" in transfer_suggestions[0].reason.lower()

    def test_same_network_tx_id_requires_same_asset(self, engine):
        """network_transaction_id match should not pair transactions with different assets."""
        now = datetime.now()
        tx_hash = "0xabc123"

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="USDC",
            asset_id=100,
            account_id=1,
            dt=now,
            network_transaction_id=tx_hash,
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="ETH",
            asset_id=200,
            account_id=2,
            dt=now + timedelta(seconds=10),
            network_transaction_id=tx_hash,
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        # Should NOT match via Rule 1 (different assets)
        rule1_matches = [
            s for s in suggestions
            if s.pattern == PATTERN_INTERNAL_TRANSFER and s.confidence == 1.0
        ]
        assert len(rule1_matches) == 0

    def test_same_network_tx_id_requires_different_accounts(self, engine):
        """network_transaction_id match should not pair transactions on the same account."""
        now = datetime.now()
        tx_hash = "0xabc123"

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            asset_id=100,
            account_id=1,
            dt=now,
            network_transaction_id=tx_hash,
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="ETH",
            asset_id=100,
            account_id=1,  # Same account
            dt=now + timedelta(seconds=10),
            network_transaction_id=tx_hash,
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        # Should NOT match via Rule 1 strategy (b) — same account
        rule1_matches = [
            s for s in suggestions
            if s.pattern == PATTERN_INTERNAL_TRANSFER and s.confidence == 1.0
        ]
        assert len(rule1_matches) == 0


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
            s for s in suggestions if s.pattern == PATTERN_INTERNAL_TRANSFER
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
            s for s in suggestions if s.pattern == PATTERN_INTERNAL_TRANSFER
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
            s for s in suggestions if s.pattern == PATTERN_INTERNAL_TRANSFER
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
            s for s in suggestions if s.pattern == PATTERN_INTERNAL_TRANSFER
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
            s for s in suggestions if s.pattern == PATTERN_INTERNAL_TRANSFER
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
# Rule 3b: On-chain Swap by network_transaction_id Tests
# =============================================================================


class TestRule3bOnchainSwapByNetworkTx:
    """Tests for Rule 3b: On-chain swap grouping by network_transaction_id."""

    def test_solana_swap_grouped_by_network_tx(self, engine):
        """Should group Solana SWAP legs sharing the same network_transaction_id."""
        now = datetime.now()
        sig = "4zBe3FcgABC123"  # single on-chain signature

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="SOL",
            source="solana_helius",
            source_transaction_id=f"{sig}_token_0",  # wSOL leg
            network_transaction_id=sig,
            source_transaction_type="SWAP",
            quantity=Decimal("0.5"),
            account_id=10,
            dt=now,
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="AVO",
            source="solana_helius",
            source_transaction_id=f"{sig}_token_1",
            network_transaction_id=sig,
            source_transaction_type="SWAP",
            quantity=Decimal("19424.5"),
            account_id=10,
            dt=now,
        )
        fee = make_tx(
            id=3,
            direction="outflow",
            symbol="SOL",
            source="solana_helius",
            source_transaction_id=f"{sig}_fee",
            network_transaction_id=sig,
            source_transaction_type="SWAP",
            quantity=Decimal("0.000005"),
            account_id=10,
            transaction_type="technical",
            dt=now,
        )

        suggestions = engine.suggest_groups([outflow, inflow, fee])

        swap_suggestions = [s for s in suggestions if s.pattern == PATTERN_SWAP]
        assert len(swap_suggestions) == 1
        sg = swap_suggestions[0]
        assert sg.confidence == 0.95
        assert set(sg.transaction_ids) == {1, 2, 3}
        assert "SOL" in sg.label
        assert "AVO" in sg.label
        assert "Swap" in sg.label

    def test_non_swap_type_not_grouped(self, engine):
        """TRANSFER type is now eligible for Rule 3b.
        
        With TRANSFER in the eligible types, two TRANSFER-typed legs with
        different assets on the same account should be grouped as a swap by
        Rule 3b (confidence 0.95).
        """
        now = datetime.now()
        sig = "0xdef456"

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="SOL",
            source="solana_helius",
            source_transaction_id=f"{sig}_token_0",
            network_transaction_id=sig,
            source_transaction_type="TRANSFER",
            quantity=Decimal("1.0"),
            account_id=10,
            dt=now,
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="USDC",
            source="solana_helius",
            source_transaction_id=f"{sig}_token_1",
            network_transaction_id=sig,
            source_transaction_type="TRANSFER",
            quantity=Decimal("100"),
            account_id=10,
            dt=now,
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        # Rule 3b should NOW match (TRANSFER is eligible)
        rule3b_swap = [
            s for s in suggestions
            if s.pattern == PATTERN_SWAP and s.confidence == 0.95
        ]
        assert len(rule3b_swap) == 1
        assert set(rule3b_swap[0].transaction_ids) == {1, 2}

    def test_non_eligible_type_not_grouped(self, engine):
        """Should NOT group transactions whose source_transaction_type is not eligible."""
        now = datetime.now()
        sig = "0xdef456"

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="SOL",
            source="solana_helius",
            source_transaction_id=f"{sig}_token_0",
            network_transaction_id=sig,
            source_transaction_type="STAKE",  # Not eligible for Rule 3b
            quantity=Decimal("1.0"),
            account_id=10,
            dt=now,
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="USDC",
            source="solana_helius",
            source_transaction_id=f"{sig}_token_1",
            network_transaction_id=sig,
            source_transaction_type="STAKE",  # Not eligible for Rule 3b
            quantity=Decimal("100"),
            account_id=10,
            dt=now,
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        rule3b_swap = [
            s for s in suggestions
            if s.pattern == PATTERN_SWAP and s.confidence == 0.95
        ]
        assert len(rule3b_swap) == 0

    def test_different_accounts_not_grouped(self, engine):
        """Should NOT group legs from different accounts."""
        now = datetime.now()
        sig = "sigABC"

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="SOL",
            source="solana_helius",
            source_transaction_id=f"{sig}_token_0",
            network_transaction_id=sig,
            source_transaction_type="SWAP",
            quantity=Decimal("1.0"),
            account_id=10,
            dt=now,
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="USDC",
            source="solana_helius",
            source_transaction_id=f"{sig}_token_1",
            network_transaction_id=sig,
            source_transaction_type="SWAP",
            quantity=Decimal("100"),
            account_id=20,  # Different account
            dt=now,
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        rule3b_swap = [
            s for s in suggestions
            if s.pattern == PATTERN_SWAP and s.confidence == 0.95
        ]
        assert len(rule3b_swap) == 0

    def test_same_asset_both_directions_not_grouped(self, engine):
        """Should NOT group when all inflows and outflows have the same asset."""
        now = datetime.now()
        sig = "sigDEF"

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="SOL",
            source="solana_helius",
            source_transaction_id=f"{sig}_token_0",
            network_transaction_id=sig,
            source_transaction_type="SWAP",
            quantity=Decimal("1.0"),
            account_id=10,
            dt=now,
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="SOL",  # Same asset — not a swap
            source="solana_helius",
            source_transaction_id=f"{sig}_token_1",
            network_transaction_id=sig,
            source_transaction_type="SWAP",
            quantity=Decimal("1.0"),
            account_id=10,
            dt=now,
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        rule3b_swap = [
            s for s in suggestions
            if s.pattern == PATTERN_SWAP and s.confidence == 0.95
        ]
        assert len(rule3b_swap) == 0

    def test_multi_leg_swap_with_extras(self, engine):
        """Should label multi-leg swaps correctly (tip + fee + swap legs)."""
        now = datetime.now()
        sig = "sig_multi"

        txs = [
            # Swap outflow (wSOL)
            make_tx(
                id=1, direction="outflow", symbol="SOL", account_id=10,
                source_transaction_id=f"{sig}_token_0",
                network_transaction_id=sig, source_transaction_type="SWAP",
                quantity=Decimal("0.5"), dt=now,
            ),
            # Swap inflow (token)
            make_tx(
                id=2, direction="inflow", symbol="BONK", account_id=10,
                source_transaction_id=f"{sig}_token_1",
                network_transaction_id=sig, source_transaction_type="SWAP",
                quantity=Decimal("500000"), dt=now,
            ),
            # Tip (native outflow, not technical)
            make_tx(
                id=3, direction="outflow", symbol="SOL", account_id=10,
                source_transaction_id=f"{sig}_native_0",
                network_transaction_id=sig, source_transaction_type="SWAP",
                quantity=Decimal("0.000003"), dt=now,
            ),
            # Fee (technical)
            make_tx(
                id=4, direction="outflow", symbol="SOL", account_id=10,
                source_transaction_id=f"{sig}_fee",
                network_transaction_id=sig, source_transaction_type="SWAP",
                quantity=Decimal("0.000005"), transaction_type="technical",
                dt=now,
            ),
        ]

        suggestions = engine.suggest_groups(txs)

        swap_suggestions = [s for s in suggestions if s.pattern == PATTERN_SWAP]
        assert len(swap_suggestions) == 1
        sg = swap_suggestions[0]
        assert set(sg.transaction_ids) == {1, 2, 3, 4}
        assert "SOL" in sg.label and "BONK" in sg.label
        assert "Swap" in sg.label
        assert "3 legs" in sg.label  # 3 transfer legs (ids 1,2,3) — fee excluded from leg count
        assert "1 fee" in sg.label

    def test_already_used_transactions_excluded(self, engine):
        """Transactions already consumed by an earlier rule should not appear in 3b."""
        now = datetime.now()
        sig = "sig_already_used"

        # These share the same source_transaction_id → Rule 3 will consume them first
        tx_id_shared = f"{sig}_token_0"  # Give them the SAME source_transaction_id
        outflow = make_tx(
            id=1, direction="outflow", symbol="SOL", account_id=10,
            source_transaction_id=tx_id_shared,
            network_transaction_id=sig, source_transaction_type="SWAP",
            quantity=Decimal("0.5"), dt=now,
        )
        inflow = make_tx(
            id=2, direction="inflow", symbol="BONK", account_id=10,
            source_transaction_id=tx_id_shared,
            network_transaction_id=sig, source_transaction_type="SWAP",
            quantity=Decimal("500000"), dt=now,
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        # Rule 3 should consume them (same source_transaction_id)
        rule3 = [s for s in suggestions if s.confidence == 0.9 and s.pattern == PATTERN_SWAP]
        rule3b = [s for s in suggestions if s.confidence == 0.95 and s.pattern == PATTERN_SWAP]
        assert len(rule3) == 1
        assert len(rule3b) == 0  # Already consumed by Rule 3


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
            s for s in suggestions if s.pattern == PATTERN_INTERNAL_TRANSFER
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
            s for s in suggestions if s.pattern == PATTERN_INTERNAL_TRANSFER
        ]
        assert len(bridge_suggestions) == 1
        assert "ethereum" in bridge_suggestions[0].label.lower()
        assert "polygon" in bridge_suggestions[0].label.lower()


# =============================================================================
# Rule 5b: Same-Account Cross-Chain Bridge Tests
# =============================================================================


class TestRule5bSameAccountBridge:
    """Tests for Rule 5b: Same-account cross-chain bridge (same account, different networks)."""

    def test_same_account_cross_chain_bridge(self, engine):
        """Should detect bridge when same asset on same account but different networks."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            asset_id=133,
            account_id=151,
            to_account_id=None,
            dt=now,
            quantity=Decimal("0.004200000000000000"),
            network="ethereum",
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="ETH",
            asset_id=133,
            account_id=151,  # Same account
            dt=now + timedelta(seconds=3),
            quantity=Decimal("0.004156374516806778"),  # Bridge fee deducted (~1%)
            network="arbitrum",  # Different network
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        bridge_suggestions = [
            s for s in suggestions if s.pattern == PATTERN_INTERNAL_TRANSFER
        ]
        assert len(bridge_suggestions) == 1
        assert "Bridge" in bridge_suggestions[0].label
        assert "ethereum" in bridge_suggestions[0].label.lower()
        assert "arbitrum" in bridge_suggestions[0].label.lower()
        assert bridge_suggestions[0].confidence >= 0.8
        assert set(bridge_suggestions[0].transaction_ids) == {1, 2}

    def test_same_account_same_network_not_bridge(self, engine):
        """Should NOT detect bridge when same account AND same network."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            asset_id=1,
            account_id=1,
            dt=now,
            quantity=Decimal("1.0"),
            network="ethereum",
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="ETH",
            asset_id=1,
            account_id=1,
            dt=now + timedelta(seconds=10),
            quantity=Decimal("1.0"),
            network="ethereum",  # Same network
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        bridge_suggestions = [
            s for s in suggestions
            if s.pattern == PATTERN_INTERNAL_TRANSFER and "Bridge" in s.label
        ]
        assert len(bridge_suggestions) == 0

    def test_same_account_bridge_no_network_not_matched(self, engine):
        """Should NOT match when network info is missing."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            asset_id=1,
            account_id=1,
            dt=now,
            quantity=Decimal("1.0"),
            network=None,
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="ETH",
            asset_id=1,
            account_id=1,
            dt=now + timedelta(seconds=10),
            quantity=Decimal("1.0"),
            network="arbitrum",
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        bridge_suggestions = [
            s for s in suggestions
            if s.pattern == PATTERN_INTERNAL_TRANSFER and "Bridge" in s.label
        ]
        assert len(bridge_suggestions) == 0

    def test_same_account_bridge_quantity_outside_tolerance(self, engine):
        """Should NOT match when quantity difference exceeds tolerance."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            asset_id=1,
            account_id=1,
            dt=now,
            quantity=Decimal("1.0"),
            network="ethereum",
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="ETH",
            asset_id=1,
            account_id=1,
            dt=now + timedelta(seconds=10),
            quantity=Decimal("0.8"),  # 20% difference, exceeds 5% tolerance
            network="arbitrum",
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        bridge_suggestions = [
            s for s in suggestions
            if s.pattern == PATTERN_INTERNAL_TRANSFER and "Bridge" in s.label
        ]
        assert len(bridge_suggestions) == 0

    def test_same_account_bridge_outside_time_window(self, engine):
        """Should NOT match when time difference exceeds bridge_time_window."""
        now = datetime.now()

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            asset_id=1,
            account_id=1,
            dt=now,
            quantity=Decimal("1.0"),
            network="ethereum",
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="ETH",
            asset_id=1,
            account_id=1,
            dt=now + timedelta(minutes=10),  # 600s > 300s default
            quantity=Decimal("0.99"),
            network="arbitrum",
        )

        suggestions = engine.suggest_groups([outflow, inflow])

        bridge_suggestions = [
            s for s in suggestions
            if s.pattern == PATTERN_INTERNAL_TRANSFER and "Bridge" in s.label
        ]
        assert len(bridge_suggestions) == 0


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
            s for s in suggestions if s.pattern == PATTERN_INTERNAL_TRANSFER
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


# =============================================================================
# Multi-Collect Related Transactions Tests
# =============================================================================


class TestMultiCollectRelated:
    """Tests for _collect_related_by_network_tx: pulling fees and related
    transactions into a matched group by shared network_transaction_id."""

    def test_bridge_with_fee_all_grouped(self, engine):
        """Bridge (outflow Solana + inflow Base) + SOL fee sharing
        network_transaction_id with the outflow → all 3 in one group.

        This is the exact scenario from TX #5565, #5573, #5574.
        """
        now = datetime.now()
        solana_sig = "5HCZ66XeoLCnYAd5KZE9hXrvKSrwDNcwjmBHykCstbDLhYBWW1Sff98TMoxAd6UjnfYkqAQzTxEKzkh8iY6DrfXS"
        base_hash = "0x98bc62c106a133ef7072412e46d1fe2c107413cab87eeb073a356f47e1eb368c"

        # USDC outflow on Solana
        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="USDC",
            asset_id=226,
            account_id=321,
            source_transaction_id=f"{solana_sig}_token_0",
            network_transaction_id=solana_sig,
            source_transaction_type="TRANSFER",
            transaction_type="transfer",
            quantity=Decimal("289.3"),
            network="solana",
            dt=now,
        )

        # SOL fee on Solana (same network_transaction_id as outflow)
        fee = make_tx(
            id=2,
            direction="outflow",
            symbol="SOL",
            asset_id=253,
            account_id=321,
            source_transaction_id=f"{solana_sig}_fee",
            network_transaction_id=solana_sig,
            source_transaction_type="TRANSFER",
            transaction_type="technical",
            quantity=Decimal("0.000005"),
            network="solana",
            dt=now,
        )

        # USDC inflow on Base (different network_transaction_id)
        inflow = make_tx(
            id=3,
            direction="inflow",
            symbol="USDC",
            asset_id=226,
            account_id=316,
            source_transaction_id=f"{base_hash}_451",
            network_transaction_id=base_hash,
            source_transaction_type="token-transfer",
            transaction_type="transfer",
            quantity=Decimal("288.9"),
            network="base",
            dt=now + timedelta(seconds=95),
        )

        config = GroupingConfig(
            bridge_time_window=300,
            quantity_tolerance=0.10,
        )
        eng = GroupingEngine(config)
        suggestions = eng.suggest_groups([outflow, fee, inflow])

        # Should produce a bridge suggestion containing all 3 transactions
        bridge = [
            s for s in suggestions
            if s.pattern == PATTERN_INTERNAL_TRANSFER and "Bridge" in s.label
        ]
        assert len(bridge) == 1
        assert set(bridge[0].transaction_ids) == {1, 2, 3}
        assert "fee" in bridge[0].label.lower()

    def test_transfer_with_fee_grouped(self, engine):
        """Rule 1 transfer match + technical fee sharing network_tx_id → 3-tx group."""
        now = datetime.now()
        tx_hash = "0xabc_transfer_hash"

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            account_id=1,
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
        fee = make_tx(
            id=3,
            direction="outflow",
            symbol="ETH",
            account_id=1,
            network_transaction_id=tx_hash,
            transaction_type="technical",
            quantity=Decimal("0.001"),
            dt=now,
        )

        suggestions = engine.suggest_groups([outflow, inflow, fee])

        transfer = [
            s for s in suggestions if s.pattern == PATTERN_INTERNAL_TRANSFER
        ]
        assert len(transfer) == 1
        assert set(transfer[0].transaction_ids) == {1, 2, 3}
        assert transfer[0].confidence == 1.0

    def test_swap_with_fee_grouped(self, engine):
        """Rule 4 swap + fee sharing network_tx_id → 3-tx group."""
        now = datetime.now()
        net_hash = "sol_swap_sig_123"

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            asset_id=1,
            account_id=5,
            network_transaction_id=net_hash,
            dt=now,
        )
        inflow = make_tx(
            id=2,
            direction="inflow",
            symbol="USDC",
            asset_id=2,
            account_id=5,
            dt=now + timedelta(seconds=10),
        )
        fee = make_tx(
            id=3,
            direction="outflow",
            symbol="SOL",
            asset_id=3,
            account_id=5,
            network_transaction_id=net_hash,
            transaction_type="technical",
            quantity=Decimal("0.00001"),
            dt=now,
        )

        suggestions = engine.suggest_groups([outflow, inflow, fee])

        swap = [s for s in suggestions if s.pattern == PATTERN_SWAP]
        assert len(swap) == 1
        assert set(swap[0].transaction_ids) == {1, 2, 3}
        assert "fee" in swap[0].label.lower()

    def test_no_false_expansion_different_net_tx_id(self, engine):
        """Transactions with different network_transaction_id should NOT be pulled in."""
        now = datetime.now()
        tx_hash = "0xabc"

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            account_id=1,
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
        unrelated = make_tx(
            id=3,
            direction="outflow",
            symbol="ETH",
            account_id=1,
            network_transaction_id="0xdifferent",
            transaction_type="technical",
            quantity=Decimal("0.001"),
            dt=now,
        )

        suggestions = engine.suggest_groups([outflow, inflow, unrelated])

        transfer = [
            s for s in suggestions if s.pattern == PATTERN_INTERNAL_TRANSFER
        ]
        assert len(transfer) == 1
        # Only the matching pair, not the unrelated tx
        assert set(transfer[0].transaction_ids) == {1, 2}

    def test_no_expansion_on_empty_network_tx_id(self, engine):
        """Helper should NOT match on empty/None network_transaction_id."""
        now = datetime.now()
        tx_hash = "0xabc"

        outflow = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            account_id=1,
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
        # This tx has no network_transaction_id
        orphan = make_tx(
            id=3,
            direction="outflow",
            symbol="ETH",
            account_id=1,
            network_transaction_id=None,
            transaction_type="technical",
            quantity=Decimal("0.001"),
            dt=now,
        )

        suggestions = engine.suggest_groups([outflow, inflow, orphan])

        transfer = [
            s for s in suggestions if s.pattern == PATTERN_INTERNAL_TRANSFER
        ]
        assert len(transfer) == 1
        assert set(transfer[0].transaction_ids) == {1, 2}


class TestRule3PartialGrouping:
    """Tests for Rule 3's relaxed bail-out: remaining unused txs should
    still be grouped when some were consumed by earlier rules."""

    def test_partial_grouping_after_rule1_consumes_one(self, engine):
        """If Rule 1 consumes one tx from a source_transaction_id group,
        the remaining unused txs should still be grouped by Rule 3."""
        now = datetime.now()
        shared_source_tx_id = "shared_source_123"
        net_hash = "0xnet_hash_match"

        # tx1: will be consumed by Rule 1 (network_tx match with tx4)
        tx1 = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            account_id=1,
            source_transaction_id=shared_source_tx_id,
            network_transaction_id=net_hash,
            dt=now,
        )
        # tx2 and tx3: share same source_transaction_id as tx1
        tx2 = make_tx(
            id=2,
            direction="outflow",
            symbol="BTC",
            asset_id=10,
            account_id=1,
            source_transaction_id=shared_source_tx_id,
            dt=now,
        )
        tx3 = make_tx(
            id=3,
            direction="inflow",
            symbol="USDC",
            asset_id=20,
            account_id=1,
            source_transaction_id=shared_source_tx_id,
            dt=now,
        )
        # tx4: matches tx1 via Rule 1 (network_tx_id match)
        tx4 = make_tx(
            id=4,
            direction="inflow",
            symbol="ETH",
            account_id=2,
            source_transaction_id=net_hash,  # matches tx1.network_transaction_id
            dt=now,
        )

        suggestions = engine.suggest_groups([tx1, tx2, tx3, tx4])

        # Rule 1 should consume tx1 + tx4 as a transfer
        transfers = [
            s for s in suggestions if s.pattern == PATTERN_INTERNAL_TRANSFER
        ]
        assert len(transfers) == 1
        assert 1 in transfers[0].transaction_ids
        assert 4 in transfers[0].transaction_ids

        # Rule 3 should group remaining tx2 + tx3 (same source_tx_id, 1 in + 1 out)
        swaps = [
            s for s in suggestions if s.pattern == PATTERN_SWAP
        ]
        assert len(swaps) == 1
        assert set(swaps[0].transaction_ids) == {2, 3}

    def test_partial_group_too_small_goes_to_catchall(self, engine):
        """If only 1 tx remains after filtering, it should go to catch-all."""
        now = datetime.now()
        shared_source = "shared_source_456"
        net_hash = "0xhash_for_rule1"

        # tx1: consumed by Rule 1
        tx1 = make_tx(
            id=1,
            direction="outflow",
            symbol="ETH",
            account_id=1,
            source_transaction_id=shared_source,
            network_transaction_id=net_hash,
            dt=now,
        )
        # tx2: will be left alone (only 1 remaining after tx1 consumed)
        tx2 = make_tx(
            id=2,
            direction="inflow",
            symbol="USDC",
            account_id=1,
            source_transaction_id=shared_source,
            dt=now,
        )
        # tx3: matches tx1 via Rule 1
        tx3 = make_tx(
            id=3,
            direction="inflow",
            symbol="ETH",
            account_id=2,
            source_transaction_id=net_hash,
            dt=now,
        )

        suggestions = engine.suggest_groups([tx1, tx2, tx3])

        # Rule 1 consumes tx1 + tx3
        transfers = [
            s for s in suggestions if s.pattern == PATTERN_INTERNAL_TRANSFER
        ]
        assert len(transfers) == 1

        # tx2 alone goes to catch-all (< 2 for Rule 3)
        unknown = [s for s in suggestions if s.pattern == PATTERN_UNKNOWN]
        assert len(unknown) == 1
        assert set(unknown[0].transaction_ids) == {2}
