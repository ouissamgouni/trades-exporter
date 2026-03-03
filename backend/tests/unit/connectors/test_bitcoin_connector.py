"""
Simple test to verify Bitcoin connector basic functionality.
"""

import os
import pytest
from backend.connectors.onchain.connector_bitcoin_esplora import ConnectorBitcoinEsplora


def test_bitcoin_connector_initialization():
    """Test that Bitcoin connector initializes correctly in test mode."""
    connector = ConnectorBitcoinEsplora(
        wallet_address="bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
        account_id=1,
        connector_id=1,
        config={"test_mode": True},
    )
    
    assert connector.connector_name == "bitcoin_esplora"
    assert connector.wallet_address == "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
    assert connector.test_mode is True


def test_bitcoin_address_validation():
    """Test Bitcoin address validation."""
    connector = ConnectorBitcoinEsplora(
        wallet_address="bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
        config={"test_mode": True},
    )
    
    # Valid addresses
    assert connector._validate_bitcoin_address("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa") is True  # P2PKH
    assert connector._validate_bitcoin_address("3J98t1WpEZ73CNmYviecrnyiWrnqRhWNLy") is True  # P2SH
    assert connector._validate_bitcoin_address("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh") is True  # Bech32
    
    # Invalid addresses
    assert connector._validate_bitcoin_address("invalid") is False
    assert connector._validate_bitcoin_address("") is False


def test_bitcoin_connector_invalid_address():
    """Test that invalid Bitcoin address raises ValueError."""
    with pytest.raises(ValueError, match="Invalid Bitcoin address format"):
        ConnectorBitcoinEsplora(
            wallet_address="invalid_address",
            config={"test_mode": True},
        )


def test_bitcoin_connector_test_mode():
    """Test that Bitcoin connector loads test fixture in test mode."""
    # Get the fixture path - fixtures are in backend/tests/fixtures/
    test_dir = os.path.dirname(os.path.abspath(__file__))
    fixture_path = os.path.join(
        test_dir, "..", "..", "fixtures", "bitcoin", "blockstream_transactions.json"
    )
    
    connector = ConnectorBitcoinEsplora(
        wallet_address="bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
        config={"test_mode": True, "test_file_path": fixture_path},
    )
    
    # Yield raw transactions
    raw_txs = list(connector.yield_raws())
    
    assert len(raw_txs) > 0
    assert raw_txs[0].get("txid") is not None
    assert raw_txs[0].get("vin") is not None
    assert raw_txs[0].get("vout") is not None


def test_bitcoin_connector_normalization():
    """Test that Bitcoin connector normalizes transactions correctly."""
    test_dir = os.path.dirname(os.path.abspath(__file__))
    fixture_path = os.path.join(
        test_dir, "..", "..", "fixtures", "bitcoin", "blockstream_transactions.json"
    )
    
    connector = ConnectorBitcoinEsplora(
        wallet_address="bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
        config={"test_mode": True, "test_file_path": fixture_path},
    )
    
    # Process transactions
    normalized_txs = []
    for raw_tx in connector.yield_raws():
        for normalized_tx in connector.raw_to_normalized(raw_tx):
            normalized_txs.append(normalized_tx)
    
    assert len(normalized_txs) > 0
    
    # Check first transaction (should be an inflow)
    first_tx = normalized_txs[0]
    assert first_tx.source == "bitcoin_esplora"
    assert first_tx.source_asset_symbol == "BTC"
    assert first_tx.network == "bitcoin"
    assert first_tx.direction in ["inflow", "outflow"]
    
    # Check that transactions have proper IDs (with _in or _out suffix)
    for tx in normalized_txs:
        assert tx.source_transaction_id.endswith("_in") or tx.source_transaction_id.endswith("_out")
