"""
Shared fixtures for P&L unit tests.
"""

import pytest
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import Mock
from typing import Optional, List

from backend.services.pnl.config import PnLConfig, CostMethod, LotMode
from backend.services.pnl.models import RuntimeUnitType
from backend.db.models import CostLot, Asset, Account, CalculationUnit, CalculationUnitLeg, NormalizedTransaction


# ============================================================================
# Mock Classes
# ============================================================================


class MockTransaction:
    """Mock transaction for testing."""
    def __init__(self, id: int, direction: str = None, asset_id: int = None, quantity: Decimal = None, 
                 date_time: datetime = None, total_in_base: Decimal = None, **kwargs):
        self.id = id
        self.direction = direction
        self.asset_id = asset_id
        self.quantity = quantity
        self.date_time = date_time
        self.total_in_base = total_in_base
        for k, v in kwargs.items():
            setattr(self, k, v)



# ============================================================================
# Configuration Fixtures
# ============================================================================


@pytest.fixture
def base_datetime():
    """Base datetime for tests - timezone-aware."""
    return datetime(2024, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def fifo_config():
    """FIFO configuration with EUR as base currency."""
    return PnLConfig(
        lot_method=CostMethod.FIFO,
        lot_mode=LotMode.LOT_TRAVEL,
        base_currency_id=1,  # EUR
        base_currency_symbol="EUR",
        residual_tolerance_pct=Decimal("0.05"),
        allow_negative_balances=False,
    )


@pytest.fixture
def lifo_config():
    """LIFO configuration."""
    return PnLConfig(
        lot_method=CostMethod.LIFO,
        lot_mode=LotMode.LOT_TRAVEL,
        base_currency_id=1,
        base_currency_symbol="EUR",
    )


@pytest.fixture
def hifo_config():
    """HIFO configuration."""
    return PnLConfig(
        lot_method=CostMethod.HIFO,
        lot_mode=LotMode.LOT_TRAVEL,
        base_currency_id=1,
        base_currency_symbol="EUR",
    )


@pytest.fixture
def mega_wallet_config():
    """MEGA_WALLET configuration (lots aggregated across accounts)."""
    return PnLConfig(
        lot_method=CostMethod.FIFO,
        lot_mode=LotMode.MEGA_WALLET,
        base_currency_id=1,
        base_currency_symbol="EUR",
    )


@pytest.fixture
def taxable_swap_config():
    """Configuration where crypto swaps ARE taxable (e.g., US jurisdiction)."""
    return PnLConfig(
        lot_method=CostMethod.FIFO,
        lot_mode=LotMode.LOT_TRAVEL,
        base_currency_id=1,
        base_currency_symbol="EUR",
        crypto_swap_taxable=True,
    )


# ============================================================================
# Mock Services
# ============================================================================


@pytest.fixture
def mock_price_service():
    """Mock price service that returns configurable prices."""
    service = Mock()

    # Default prices
    prices = {
        1: Decimal("1"),  # EUR (base)
        2: Decimal("40000"),  # BTC
        3: Decimal("2500"),  # ETH
        4: Decimal("1"),  # USDT
        5: Decimal("100"),  # AAPL
        6: Decimal("0.90"),  # CHF
        7: Decimal("0.0067"),  # JPY
    }

    def get_price(asset_id, dt=None, price_quote=None):
        return prices.get(asset_id, Decimal("10"))

    service.get_price = Mock(side_effect=get_price)
    service.prices = prices  # Allow test modification
    return service


@pytest.fixture
def mock_asset_service():
    """Mock asset service for asset metadata."""
    service = Mock()

    assets = {
        1: Mock(asset_id=1, symbol="EUR", asset_type="fiat"),
        2: Mock(asset_id=2, symbol="BTC", asset_type="crypto"),
        3: Mock(asset_id=3, symbol="ETH", asset_type="crypto"),
        4: Mock(asset_id=4, symbol="USDT", asset_type="crypto"),
        5: Mock(asset_id=5, symbol="AAPL", asset_type="stock"),
        6: Mock(asset_id=6, symbol="CHF", asset_type="fiat"),
        7: Mock(asset_id=7, symbol="JPY", asset_type="fiat"),
    }

    def get_asset(asset_id):
        return assets.get(asset_id)

    service.get_asset = Mock(side_effect=get_asset)
    return service


# ============================================================================
# Test Data Factories - Uses Real Models
# ============================================================================

# Standard asset/symbol mappings for tests
ASSET_SYMBOL_MAP = {1: "EUR", 2: "BTC", 3: "ETH", 4: "USDT", 5: "AAPL", 6: "CHF", 7: "JPY"}
ASSET_TYPE_MAP = {1: "fiat", 2: "crypto", 3: "crypto", 4: "crypto", 5: "stock", 6: "fiat", 7: "fiat"}


def make_asset(asset_id: int, symbol: str = None) -> Asset:
    """Create an Asset for testing."""
    if symbol is None:
        symbol = ASSET_SYMBOL_MAP.get(asset_id, f"ASSET{asset_id}")
    return Asset(
        asset_id=asset_id,
        symbol=symbol,
        price_type=ASSET_TYPE_MAP.get(asset_id, "crypto"),
    )


def make_account(account_id: int = 1, name: str = None) -> Account:
    """Create an Account for testing."""
    if name is None:
        name = f"Account{account_id}"
    return Account(id=account_id, name=name, account_type="cex")


def make_transaction(
    id: int,
    asset_id: int,
    quantity: Decimal,
    account_id: int = 1,
    date_time: datetime = None,
    disposal_taxable: bool = False,  # User input override flag
) -> NormalizedTransaction:
    """Create a NormalizedTransaction for testing (minimal fields)."""
    if date_time is None:
        date_time = datetime(2024, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    
    tx = NormalizedTransaction(
        id=id,
        asset_id=asset_id,
        quantity=quantity,
        account_id=account_id,
        date_time=date_time,
        disposal_taxable=disposal_taxable,
        source_transaction_id=f"test-{id}",
    )
    # Set relationship objects for property access
    tx.asset = make_asset(asset_id)
    tx.account_rel = make_account(account_id)
    return tx


def make_leg(
    asset_id: int,
    leg_type: str,
    quantity: Decimal,
    transaction: NormalizedTransaction = None,
    tx_disposal_taxable: bool = False,
) -> CalculationUnitLeg:
    """
    Create a CalculationUnitLeg for testing.
    
    Args:
        asset_id: Asset being moved
        leg_type: "inflow", "outflow", or "fee"
        quantity: Amount
        transaction: Optional NormalizedTransaction (creates one if not provided)
        tx_disposal_taxable: User override flag from transaction
    """
    if transaction is None:
        # Create a minimal transaction for relationship
        transaction = make_transaction(
            id=1,
            asset_id=asset_id,
            quantity=quantity,
            disposal_taxable=tx_disposal_taxable,
        )
    
    leg = CalculationUnitLeg(
        asset_id=asset_id,
        leg_type=leg_type,
        quantity=quantity,
        transaction_id=transaction.id or 1,
    )
    # Set relationships manually (no DB session)
    leg.transaction = transaction
    leg.asset = make_asset(asset_id)
    return leg


def make_unit(
    legs: List[CalculationUnitLeg],
    pattern: str = None,
    bundle_taxability_override: str = None,
    unit_label: str = None,
) -> CalculationUnit:
    """
    Create a CalculationUnit with legs for testing.
    
    Args:
        legs: List of CalculationUnitLeg objects
        pattern: "transfer", "swap", "split", or None (auto-computed)
        bundle_taxability_override: "taxable" | "non_taxable" | None
        unit_label: Optional human-readable label
    """
    unit = CalculationUnit(
        version_id=1,
        unit_origin="tx:1",
        pattern=pattern,
        unit_label=unit_label,
        bundle_taxability_override=bundle_taxability_override,
    )
    # Set legs relationship and back-references
    unit.legs = legs
    for leg in legs:
        leg.unit = unit
    
    return unit


# ============================================================================
# Helper Functions
# ============================================================================


def create_lot(
    asset_id: int,
    account_id: int,
    qty: Decimal,
    unit_cost: Decimal,
    acquired_at: datetime,
    asset_name: str = "",
) -> CostLot:
    """Helper to create CostLot for testing."""
    return CostLot(
        asset_id=asset_id,
        account_id=account_id,
        qty=qty,
        qty_remaining=qty,
        unit_cost_in_base=unit_cost,
        acquired_at=acquired_at,
    )


def seed_lot(lot_manager, lot: CostLot) -> None:
    """
    Add a pre-existing lot to lot manager without requiring transaction context.
    
    Use this for seeding lots that represent prior holdings (e.g., test setup).
    These lots don't emit events since they represent historical state, not new creations.
    """
    lot_manager.add_lot(lot, emit_event=False)


def create_buy_group(
    base_dt: datetime,
    asset_id: int,
    qty: Decimal,
    cost_in_base: Decimal,
    account_id: int = 1,
    base_currency_id: int = 1,
) -> CalculationUnit:
    """Create a BUY group: EUR → Asset."""
    outflow_tx = make_transaction(id=1, asset_id=base_currency_id, quantity=cost_in_base)
    inflow_tx = make_transaction(id=2, asset_id=asset_id, quantity=qty)
    
    legs = [
        make_leg(asset_id=base_currency_id, leg_type="outflow", quantity=cost_in_base, transaction=outflow_tx),
        make_leg(asset_id=asset_id, leg_type="inflow", quantity=qty, transaction=inflow_tx),
    ]
    
    return make_unit(legs=legs, pattern="swap", unit_label=f"Buy {qty} of asset {asset_id}")


def create_sell_group(
    base_dt: datetime,
    asset_id: int,
    qty: Decimal,
    proceeds_in_base: Decimal,
    account_id: int = 1,
    base_currency_id: int = 1,
) -> CalculationUnit:
    """Create a SELL group: Asset → EUR."""
    outflow_tx = make_transaction(id=3, asset_id=asset_id, quantity=qty)
    inflow_tx = make_transaction(id=4, asset_id=base_currency_id, quantity=proceeds_in_base)
    
    legs = [
        make_leg(asset_id=asset_id, leg_type="outflow", quantity=qty, transaction=outflow_tx),
        make_leg(asset_id=base_currency_id, leg_type="inflow", quantity=proceeds_in_base, transaction=inflow_tx),
    ]
    
    return make_unit(legs=legs, pattern="swap", unit_label=f"Sell {qty} of asset {asset_id}")


def create_swap_group(
    base_dt: datetime,
    from_asset_id: int,
    from_qty: Decimal,
    to_asset_id: int,
    to_qty: Decimal,
    from_value_in_base: Decimal,
    to_value_in_base: Decimal,
    account_id: int = 1,
) -> CalculationUnit:
    """Create a SWAP group: Asset1 → Asset2."""
    outflow_tx = make_transaction(id=5, asset_id=from_asset_id, quantity=from_qty)
    inflow_tx = make_transaction(id=6, asset_id=to_asset_id, quantity=to_qty)
    
    legs = [
        make_leg(asset_id=from_asset_id, leg_type="outflow", quantity=from_qty, transaction=outflow_tx),
        make_leg(asset_id=to_asset_id, leg_type="inflow", quantity=to_qty, transaction=inflow_tx),
    ]
    
    return make_unit(legs=legs, pattern="swap", unit_label=f"Swap {from_qty} asset {from_asset_id} for {to_qty} asset {to_asset_id}")


def create_transfer_group(
    base_dt: datetime,
    asset_id: int,
    qty: Decimal,
    from_account_id: int,
    to_account_id: int,
    fee_qty: Optional[Decimal] = None,
) -> CalculationUnit:
    """Create a TRANSFER group: same asset, different accounts."""
    inflow_qty = qty - fee_qty if fee_qty else qty

    outflow_tx = make_transaction(id=7, asset_id=asset_id, quantity=qty)
    inflow_tx = make_transaction(id=8, asset_id=asset_id, quantity=inflow_qty)
    
    legs = [
        make_leg(asset_id=asset_id, leg_type="outflow", quantity=qty, transaction=outflow_tx),
        make_leg(asset_id=asset_id, leg_type="inflow", quantity=inflow_qty, transaction=inflow_tx),
    ]

    # Add fee leg if specified
    if fee_qty:
        fee_tx = make_transaction(id=9, asset_id=asset_id, quantity=fee_qty, is_fee=True)
        legs.append(make_leg(asset_id=asset_id, leg_type="fee", quantity=fee_qty, transaction=fee_tx))

    return make_unit(legs=legs, pattern="transfer", unit_label=f"Transfer {qty} of asset {asset_id}")


def create_split_group(
    base_dt: datetime,
    asset_id: int,
    from_qty: Decimal,
    to_qty: Decimal,
    account_id: int = 1,
) -> CalculationUnit:
    """Create a SPLIT group: same asset, qty multiplies (e.g., 2:1 split)."""
    outflow_tx = make_transaction(id=10, asset_id=asset_id, quantity=from_qty)
    inflow_tx = make_transaction(id=11, asset_id=asset_id, quantity=to_qty)
    
    legs = [
        make_leg(asset_id=asset_id, leg_type="outflow", quantity=from_qty, transaction=outflow_tx),
        make_leg(asset_id=asset_id, leg_type="inflow", quantity=to_qty, transaction=inflow_tx),
    ]
    
    return make_unit(legs=legs, pattern="split", unit_label=f"Split {from_qty} → {to_qty} of asset {asset_id}")


def create_airdrop_group(
    base_dt: datetime,
    asset_id: int,
    qty: Decimal,
    fmv_in_base: Decimal,
    account_id: int = 1,
) -> CalculationUnit:
    """Create an AIRDROP group: inflow only."""
    inflow_tx = make_transaction(id=12, asset_id=asset_id, quantity=qty)
    
    legs = [
        make_leg(asset_id=asset_id, leg_type="inflow", quantity=qty, transaction=inflow_tx),
    ]
    
    return make_unit(legs=legs, pattern=None, unit_label=f"Airdrop {qty} of asset {asset_id}")


def create_payment_group(
    base_dt: datetime,
    asset_id: int,
    qty: Decimal,
    fmv_in_base: Decimal,
    account_id: int = 1,
) -> CalculationUnit:
    """Create a PAYMENT group: outflow only."""
    outflow_tx = make_transaction(id=13, asset_id=asset_id, quantity=qty)
    
    legs = [
        make_leg(asset_id=asset_id, leg_type="outflow", quantity=qty, transaction=outflow_tx),
    ]
    
    return make_unit(legs=legs, pattern=None, unit_label=f"Payment {qty} of asset {asset_id}")


def create_sell_with_fee_group(
    base_dt: datetime,
    asset_id: int,
    qty: Decimal,
    proceeds_in_base: Decimal,
    fee_asset_id: int,
    fee_qty: Decimal,
    account_id: int = 1,
    base_currency_id: int = 1,
) -> CalculationUnit:
    """
    Create a SELL group with a separate fee leg: Asset → EUR, with fee in any asset.
    
    Example: Sell 1 BTC for 50,000 EUR, with 0.001 BTC fee
    """
    outflow_tx = make_transaction(id=20, asset_id=asset_id, quantity=qty, date_time=base_dt)
    inflow_tx = make_transaction(id=21, asset_id=base_currency_id, quantity=proceeds_in_base, date_time=base_dt)
    fee_tx = make_transaction(id=22, asset_id=fee_asset_id, quantity=fee_qty, date_time=base_dt)
    
    legs = [
        make_leg(asset_id=asset_id, leg_type="outflow", quantity=qty, transaction=outflow_tx),
        make_leg(asset_id=base_currency_id, leg_type="inflow", quantity=proceeds_in_base, transaction=inflow_tx),
        make_leg(asset_id=fee_asset_id, leg_type="fee", quantity=fee_qty, transaction=fee_tx),
    ]
    
    return make_unit(legs=legs, pattern="swap", unit_label=f"Sell {qty} of asset {asset_id} with {fee_qty} fee")


def create_multi_asset_sell_group(
    base_dt: datetime,
    outflows: List[tuple],  # [(asset_id, qty), ...]
    total_proceeds_in_base: Decimal,
    account_id: int = 1,
    base_currency_id: int = 1,
) -> CalculationUnit:
    """
    Create a multi-asset sell group: multiple assets → EUR.
    
    Example: Sell 1 BTC + 10 ETH for 80,000 EUR total
    """
    legs = []
    tx_id = 30
    
    for asset_id, qty in outflows:
        outflow_tx = make_transaction(id=tx_id, asset_id=asset_id, quantity=qty, date_time=base_dt)
        legs.append(make_leg(asset_id=asset_id, leg_type="outflow", quantity=qty, transaction=outflow_tx))
        tx_id += 1
    
    inflow_tx = make_transaction(id=tx_id, asset_id=base_currency_id, quantity=total_proceeds_in_base, date_time=base_dt)
    legs.append(make_leg(asset_id=base_currency_id, leg_type="inflow", quantity=total_proceeds_in_base, transaction=inflow_tx))
    
    return make_unit(legs=legs, pattern="swap", unit_label=f"Multi-asset sell for {total_proceeds_in_base} EUR")

