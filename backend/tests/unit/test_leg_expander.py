"""
Unit tests for LegExpander service.
Tests the expansion of transactions into atomic legs for P&L calculation.
"""

from datetime import datetime
from decimal import Decimal


from backend.db.models import CalculationUnitLeg, NormalizedTransaction
from backend.services.pnl.leg_expander import (
    expand_transaction,
    should_expand_as_trade,
    has_fee,
    is_neutral_transaction,
)
from backend.services.pnl.trade_splitter import prepare_transactions_for_pnl
from backend.services.pnl.models import RuntimeUnitType


# =============================================================================
# Test Fixtures
# =============================================================================


def make_tx(**kwargs) -> NormalizedTransaction:
    """Create a NormalizedTransaction with default required fields."""
    defaults = {
        "source": "binance",
        "source_transaction_id": "test123",
        "source_transaction_type": "buy",
        "date_time": datetime(2024, 1, 1, 12, 0, 0),
        "direction": "inflow",
        "transaction_type": "acquisition",
        "source_asset_symbol": "SOL",
        "source_price_quote_asset_symbol": "USDT",
        "quantity": Decimal("5.0"),
        "price": Decimal("20.0"),
        "total": Decimal("100.0"),
        "fee": Decimal("0.5"),
        "source_fee_quote_asset_symbol": "USDT",
        "account_id": 1,
        "asset_id": 10,  # SOL
        "price_quote_asset_id": 2,  # USDT
        "fee_quote_asset_id": 2,  # USDT
        "include_fee": True,
        "taxable": True,
    }
    defaults.update(kwargs)
    return NormalizedTransaction(**defaults)


# =============================================================================
# Test: should_expand_as_trade
# =============================================================================


class TestShouldExpandAsTrade:
    """Tests for should_expand_as_trade function."""

    def test_should_expand_buy_trade(self):
        """Buy trades should be expanded when they have base and quote assets."""
        tx = make_tx(source_transaction_type="buy")
        assert should_expand_as_trade(tx) is True

    def test_should_expand_sell_trade(self):
        """Sell trades should be expanded."""
        tx = make_tx(source_transaction_type="sell", direction="outflow")
        assert should_expand_as_trade(tx) is True

    def test_should_not_expand_deposit(self):
        """Deposits should not be expanded as trades."""
        tx = make_tx(source_transaction_type="deposit")
        assert should_expand_as_trade(tx) is False

    def test_should_not_expand_withdrawal(self):
        """Withdrawals should not be expanded as trades."""
        tx = make_tx(source_transaction_type="withdrawal", direction="outflow")
        assert should_expand_as_trade(tx) is False

    def test_should_not_expand_transfer(self):
        """Transfers should not be expanded as trades."""
        tx = make_tx(source_transaction_type="transfer")
        assert should_expand_as_trade(tx) is False

    def test_should_not_expand_zero_quantity(self):
        """Zero quantity should not be expanded."""
        tx = make_tx(quantity=Decimal("0"))
        assert should_expand_as_trade(tx) is False

    def test_should_not_expand_same_base_and_quote(self):
        """Same base and quote asset should not be expanded."""
        tx = make_tx(
            source_asset_symbol="USDT",
            source_price_quote_asset_symbol="USDT",
        )
        assert should_expand_as_trade(tx) is False


# =============================================================================
# Test: has_fee
# =============================================================================


class TestHasFee:
    """Tests for has_fee function."""

    def test_has_fee_with_valid_fee(self):
        """Transaction with fee and fee_asset_id should return True."""
        tx = make_tx(fee=Decimal("0.5"), fee_quote_asset_id=2)
        assert has_fee(tx) is True

    def test_has_fee_with_zero_fee(self):
        """Zero fee should return False."""
        tx = make_tx(fee=Decimal("0"), fee_quote_asset_id=2)
        assert has_fee(tx) is False

    def test_has_fee_without_asset_id(self):
        """Fee without asset_id should return False."""
        tx = make_tx(fee=Decimal("0.5"), fee_quote_asset_id=None)
        assert has_fee(tx) is False

    def test_has_fee_with_no_fee(self):
        """No fee should return False."""
        tx = make_tx(fee=None, fee_quote_asset_id=None)
        assert has_fee(tx) is False


# =============================================================================
# Test: is_neutral_transaction
# =============================================================================


class TestIsNeutralTransaction:
    """Tests for is_neutral_transaction function."""

    def test_approval_is_neutral(self):
        """Token approval should be neutral."""
        tx = make_tx(
            source_transaction_type="approval",
            quantity=Decimal("0"),
        )
        assert is_neutral_transaction(tx) is True

    def test_failed_tx_is_neutral(self):
        """Failed transaction should be neutral."""
        tx = make_tx(
            source_transaction_type="failed",
            quantity=Decimal("0"),
        )
        assert is_neutral_transaction(tx) is True

    def test_zero_quantity_with_fee_is_neutral(self):
        """Zero quantity with fee should be neutral."""
        tx = make_tx(
            source_transaction_type="contract_call",
            quantity=Decimal("0"),
            fee=Decimal("0.001"),
            fee_quote_asset_id=1,
        )
        assert is_neutral_transaction(tx) is True

    def test_buy_is_not_neutral(self):
        """Buy transaction is not neutral."""
        tx = make_tx(source_transaction_type="buy")
        assert is_neutral_transaction(tx) is False

    def test_sell_is_not_neutral(self):
        """Sell transaction is not neutral."""
        tx = make_tx(source_transaction_type="sell", direction="outflow")
        assert is_neutral_transaction(tx) is False


# =============================================================================
# Test: expand_transaction - Trade expansion
# =============================================================================


class TestExpandTrade:
    """Tests for expanding buy/sell trades."""

    def test_expand_buy_creates_outflow_and_inflow(self):
        """Buy trade should create outflow (quote) and inflow (base) legs."""
        tx = make_tx(
            source_transaction_id="buy123",
            source_transaction_type="buy",
            source_asset_symbol="SOL",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("5.0"),
            price=Decimal("20.0"),
            total=Decimal("100.0"),
            direction="inflow",
        )

        result = expand_transaction(tx)

        assert result is not None
        assert result.expansion_type == "trade"
        assert result.outflow is not None
        assert result.inflow is not None

        # Outflow: 100 USDT disposal
        assert result.outflow.asset_symbol == "USDT"
        assert result.outflow.quantity == 100.0
        assert result.outflow.transaction_type == "disposal"
        assert result.outflow.direction == "outflow"

        # Inflow: 5 SOL acquisition
        assert result.inflow.asset_symbol == "SOL"
        assert result.inflow.quantity == 5.0
        assert result.inflow.transaction_type == "acquisition"
        assert result.inflow.direction == "inflow"

    def test_expand_sell_creates_outflow_and_inflow(self):
        """Sell trade should create outflow (base) and inflow (quote) legs."""
        tx = make_tx(
            source_transaction_id="sell123",
            source_transaction_type="sell",
            source_asset_symbol="ETH",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("3.0"),
            price=Decimal("2000.0"),
            total=Decimal("6000.0"),
            direction="outflow",
        )

        result = expand_transaction(tx)

        assert result is not None
        assert result.expansion_type == "trade"

        # Outflow: 3 ETH disposal
        assert result.outflow.asset_symbol == "ETH"
        assert result.outflow.quantity == 3.0
        assert result.outflow.transaction_type == "disposal"

        # Inflow: 6000 USDT acquisition
        assert result.inflow.asset_symbol == "USDT"
        assert result.inflow.quantity == 6000.0
        assert result.inflow.transaction_type == "acquisition"

    def test_expand_trade_creates_fee_leg(self):
        """Trade with fee should include fee leg."""
        tx = make_tx(
            source_transaction_id="buy456",
            source_transaction_type="buy",
            fee=Decimal("0.5"),
            fee_quote_asset_id=2,
            source_fee_quote_asset_symbol="USDT",
        )

        result = expand_transaction(tx)

        assert result is not None
        assert result.fee_leg is not None
        assert result.fee_leg.quantity == 0.5
        assert result.fee_leg.asset_symbol == "USDT"
        assert result.fee_leg.transaction_type == "fee"
        assert result.fee_leg.direction == "outflow"

    def test_expand_trade_without_fee(self):
        """Trade without fee should have no fee leg."""
        tx = make_tx(
            source_transaction_id="buy789",
            source_transaction_type="buy",
            fee=None,
            fee_quote_asset_id=None,
        )

        result = expand_transaction(tx)

        assert result is not None
        assert result.fee_leg is None

    def test_expand_preserves_metadata(self):
        """Expanded legs should preserve original transaction metadata."""
        tx = make_tx(
            source="coinbase",
            account_id=5,
            taxable=True,
            include_fee=True,
            date_time=datetime(2024, 6, 15, 10, 30),
        )

        result = expand_transaction(tx)

        assert result.outflow.account_id == 5
        assert result.outflow.taxable is True
        assert result.outflow.date_time == datetime(2024, 6, 15, 10, 30)


# =============================================================================
# Test: expand_transaction - Fee-only expansion
# =============================================================================


class TestExpandFeeOnly:
    """Tests for expanding fee-only transactions."""

    def test_expand_approval_creates_fee_leg(self):
        """Token approval should create fee-only leg."""
        tx = make_tx(
            source_transaction_id="approval123",
            source_transaction_type="approval",
            quantity=Decimal("0"),
            fee=Decimal("0.001"),
            fee_quote_asset_id=1,
            source_fee_quote_asset_symbol="ETH",
        )

        result = expand_transaction(tx)

        assert result is not None
        assert result.expansion_type == "fee_only"
        assert result.outflow is None
        assert result.inflow is None
        assert result.fee_leg is not None
        assert result.fee_leg.quantity == Decimal("0.001")
        assert result.fee_leg.asset_symbol == "ETH"
        assert result.fee_leg.transaction_type == "fee"

    def test_expand_failed_tx_creates_fee_leg(self):
        """Failed transaction should create fee-only leg."""
        tx = make_tx(
            source_transaction_id="failed456",
            source_transaction_type="failed",
            quantity=Decimal("0"),
            fee=Decimal("0.002"),
            fee_quote_asset_id=1,
            source_fee_quote_asset_symbol="ETH",
        )

        result = expand_transaction(tx)

        assert result is not None
        assert result.expansion_type == "fee_only"
        assert result.fee_leg is not None
        assert result.fee_leg.quantity == Decimal("0.002")


# =============================================================================
# Test: expand_transaction - No expansion needed
# =============================================================================


class TestNoExpansion:
    """Tests for transactions that don't need expansion."""

    def test_deposit_without_fee_not_expanded(self):
        """Deposit without fee should not be expanded."""
        tx = make_tx(
            source_transaction_type="deposit",
            fee=None,
            fee_quote_asset_id=None,
        )

        result = expand_transaction(tx)
        assert result is None

    def test_withdrawal_without_fee_not_expanded(self):
        """Withdrawal without fee should not be expanded."""
        tx = make_tx(
            source_transaction_type="withdrawal",
            direction="outflow",
            fee=None,
            fee_quote_asset_id=None,
        )

        result = expand_transaction(tx)
        assert result is None


# =============================================================================
# Test: prepare_transactions_for_pnl
# =============================================================================


class TestPrepareTransactionsForPnl:
    """Tests for prepare_transactions_for_pnl function."""

    def test_returns_tuple(self):
        """Should return tuple of (pass_through, units)."""
        tx = make_tx(source_transaction_type="buy")
        pass_through, units = prepare_transactions_for_pnl([tx])

        assert isinstance(pass_through, list)
        assert isinstance(units, list)

    def test_trade_creates_paired_unit(self):
        """Trade should create a SWAP unit."""
        tx = make_tx(source_transaction_type="buy")
        _, units = prepare_transactions_for_pnl([tx])

        assert len(units) == 1
        assert units[0].unit_type == RuntimeUnitType.SWAP

    def test_fee_only_creates_single_unit(self):
        """Fee-only tx should create a SWAP unit."""
        tx = make_tx(
            source_transaction_type="approval",
            quantity=Decimal("0"),
            fee=Decimal("0.001"),
            fee_quote_asset_id=1,
        )
        _, units = prepare_transactions_for_pnl([tx])

        assert len(units) == 1
        assert units[0].unit_type == RuntimeUnitType.SWAP

    def test_non_expandable_goes_to_pass_through(self):
        """Non-expandable tx should go to pass_through as ExpandedLeg."""
        tx = make_tx(
            source_transaction_type="deposit",
            fee=None,
            fee_quote_asset_id=None,
        )
        tx.id = 42
        pass_through, units = prepare_transactions_for_pnl([tx])

        assert len(pass_through) == 1
        assert len(units) == 0
        # Pass-through is converted to ExpandedLeg to ensure origin_transaction_id exists
        assert isinstance(pass_through[0], CalculationUnitLeg)
        assert pass_through[0].origin_transaction_id == 42
        assert pass_through[0]._original_id == 42

    def test_unit_has_correct_members(self):
        """Unit should have correct members (outflow, inflow, fee_leg)."""
        tx = make_tx(
            source_transaction_type="buy",
            fee=Decimal("0.5"),
            fee_quote_asset_id=2,
        )
        _, units = prepare_transactions_for_pnl([tx])

        assert len(units) == 1
        # Buy with fee: outflow + inflow + fee_leg = 3 members
        assert len(units[0].members) == 3

    def test_mixed_transactions(self):
        """Should handle mix of expandable and non-expandable."""
        buy_tx = make_tx(
            source_transaction_id="buy1",
            source_transaction_type="buy",
        )
        deposit_tx = make_tx(
            source_transaction_id="deposit1",
            source_transaction_type="deposit",
            fee=None,
            fee_quote_asset_id=None,
        )
        approval_tx = make_tx(
            source_transaction_id="approval1",
            source_transaction_type="approval",
            quantity=Decimal("0"),
            fee=Decimal("0.001"),
            fee_quote_asset_id=1,
        )

        pass_through, units = prepare_transactions_for_pnl(
            [buy_tx, deposit_tx, approval_tx]
        )

        assert len(pass_through) == 1  # deposit
        assert len(units) == 2  # buy + approval

    def test_empty_list(self):
        """Empty list should return empty results."""
        pass_through, units = prepare_transactions_for_pnl([])
        assert pass_through == []
        assert units == []


# =============================================================================
# Test: ExpandedLeg properties
# =============================================================================


class TestExpandedLeg:
    """Tests for ExpandedLeg class."""

    def test_has_virtual_flag(self):
        """ExpandedLeg should have _is_virtual=True."""
        tx = make_tx()
        result = expand_transaction(tx)
        assert result.outflow._is_virtual is True
        assert result.inflow._is_virtual is True

    def test_has_original_id_reference(self):
        """ExpandedLeg should reference original transaction ID."""
        tx = make_tx()
        tx.id = 42
        result = expand_transaction(tx)
        assert result.outflow._original_id == 42
        assert result.inflow._original_id == 42

    def test_id_is_leg_identifier(self):
        """ExpandedLeg.id should be a leg identifier (for tracking)."""
        tx = make_tx()
        tx.id = 123
        result = expand_transaction(tx)
        # Leg IDs include original tx ID and leg type suffix
        assert result.outflow.id == "123_out"
        assert result.inflow.id == "123_in"
        assert result.fee_leg.id == "123_fee"

    def test_fee_is_none_on_main_legs(self):
        """Main legs should have fee=None (fee is separate leg)."""
        tx = make_tx(fee=Decimal("0.5"), fee_quote_asset_id=2)
        result = expand_transaction(tx)
        assert result.outflow.fee is None
        assert result.inflow.fee is None


# =============================================================================
# Test: Fee legs always created (regardless of base currency)
# =============================================================================


class TestFeeLegsAlwaysCreated:
    """Tests that fee legs are created regardless of base currency."""

    def test_fee_leg_created_even_for_base_currency(self):
        """Fee leg should be created even if fee is in base currency (EUR)."""
        tx = make_tx(
            source_transaction_type="buy",
            fee=Decimal("5.0"),
            fee_quote_asset_id=100,  # Let's say 100 is EUR (base currency)
            source_fee_quote_asset_symbol="EUR",
        )

        # Call with base_currency_id=100 (same as fee asset)
        # Fee leg should STILL be created because fees consume lots
        result = expand_transaction(tx)

        assert result is not None
        assert result.fee_leg is not None
        assert result.fee_leg.quantity == 5.0
        assert result.fee_leg.asset_symbol == "EUR"

    def test_prepare_ignores_base_currency_id(self):
        """prepare_transactions_for_pnl should create fee legs regardless of base_currency_id."""
        tx = make_tx(
            source_transaction_type="buy",
            fee=Decimal("5.0"),
            fee_quote_asset_id=100,
            source_fee_quote_asset_symbol="EUR",
        )

        # Even with base_currency_id matching fee asset, fee leg should exist
        _, units = prepare_transactions_for_pnl([tx], base_currency_id=100)

        assert len(units) == 1
        # Should have 3 members: outflow, inflow, fee_leg
        assert len(units[0].members) == 3
        fee_legs = [m for m in units[0].members if m.transaction_type == "fee"]
        assert len(fee_legs) == 1
