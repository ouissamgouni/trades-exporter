"""
Integration test for database seeding and connector initialization.

Tests that:
1. Accounts and connectors are correctly seeded from YAML
2. Connectors can be loaded from database
3. Each connector type can be properly instantiated
4. Connectors can connect to their respective APIs (with rate limiting)
"""

import pytest
import logging

from sqlmodel import select

from backend.config.loader import has_exchange_credentials
from backend.db.models import Account, AccountConnector
from backend.services.connector_loader_service import ConnectorLoaderService
from backend.connectors.connector_registry import get_connector_registry

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)


# Integration tests use pg_session fixture from conftest.py
# which connects to the dedicated scenario test DB via TEST_DATABASE_URL

# Public test wallet used by on-chain connector tests (no credentials required)
TEST_WALLET = "0x1111111111111111111111111111111111111111"


@pytest.fixture
def loader_service(pg_session):
    """Get connector loader service."""
    return ConnectorLoaderService(session=pg_session)


def _make_account_with_connector(
    pg_session, *, name, account_type, connector_type, address=None, config=None
):
    """Create a self-contained Account + AccountConnector pair for a test.

    Used so connector instantiation tests don't depend on the shared
    scenarios/default seed data (which only seeds Binance/Coinbase/Degiro/
    Ledger Ethereum accounts, not every connector type).
    """
    account = Account(
        name=name,
        account_type=account_type,
        address_or_identifier=address,
        owned=True,
    )
    pg_session.add(account)
    pg_session.commit()
    pg_session.refresh(account)

    connector_record = AccountConnector(
        account_id=account.id,
        connector_type=connector_type,
        config=config or {},
    )
    pg_session.add(connector_record)
    pg_session.commit()
    pg_session.refresh(connector_record)

    return account, connector_record


@pytest.fixture
def mexc_test_account(pg_session):
    return _make_account_with_connector(
        pg_session,
        name="Test MEXC",
        account_type="cex",
        connector_type="mexc-transactions",
    )


@pytest.fixture
def okx_test_account(pg_session):
    return _make_account_with_connector(
        pg_session,
        name="Test OKX",
        account_type="cex",
        connector_type="okx-transactions",
    )


@pytest.fixture
def blockscout_test_account(pg_session):
    return _make_account_with_connector(
        pg_session,
        name="Test Base Wallet",
        account_type="wallet",
        connector_type="blockscout",
        address=TEST_WALLET,
        config={"chain": "base"},
    )


@pytest.fixture
def etherscan_test_account(pg_session):
    return _make_account_with_connector(
        pg_session,
        name="Test ETH Wallet",
        account_type="wallet",
        connector_type="etherscan",
        address=TEST_WALLET,
        config={"chain": "ethereum"},
    )


class TestDatabaseSeeding:
    """Test database seeding from accounts.yaml."""

    def test_accounts_exist(self, pg_session):
        """Test that expected accounts were seeded."""
        accounts = pg_session.exec(select(Account)).all()
        account_names = [a.name for a in accounts]

        # Check expected accounts exist
        expected_accounts = [
            "Binance",
            "MEXC",
            "OKX",
            "Coinbase",
            "Degiro",
            "Base Wallet",
            "ETH Wallet",
        ]

        for name in expected_accounts:
            assert name in account_names, f"Account '{name}' should exist"

        log.info(f"✅ Found {len(accounts)} accounts: {account_names}")

    def test_connectors_exist(self, pg_session):
        """Test that expected connectors were seeded."""
        connectors = pg_session.exec(select(AccountConnector)).all()
        connector_types = [c.connector_type for c in connectors]

        # Check expected connector types exist
        expected_types = [
            "binance-transactions",
            "binance-deposits",
            "binance-withdrawals",
            "mexc-transactions",
            "okx-transactions",
            "okx-convert",
            "coinbase-transactions",
            "blockscout",
            "etherscan",
        ]

        for ctype in expected_types:
            assert ctype in connector_types, f"Connector type '{ctype}' should exist"

        log.info(f"✅ Found {len(connectors)} connectors: {connector_types}")

    def test_connector_account_relationships(self, pg_session):
        """Test that connectors are linked to correct accounts."""
        # Check Binance account has all 3 connectors
        binance = pg_session.exec(
            select(Account).where(Account.name == "Binance")
        ).first()
        assert binance is not None

        binance_connectors = pg_session.exec(
            select(AccountConnector).where(AccountConnector.account_id == binance.id)
        ).all()
        assert len(binance_connectors) == 3
        binance_types = {c.connector_type for c in binance_connectors}
        assert binance_types == {
            "binance-transactions",
            "binance-deposits",
            "binance-withdrawals",
        }

        log.info(f"✅ Binance account has correct connectors: {binance_types}")


class TestConnectorLoader:
    """Test connector loading from database."""

    def test_get_enabled_connectors(self, loader_service):
        """Test that enabled connectors can be retrieved."""
        enabled = loader_service.get_enabled_connectors()
        assert len(enabled) > 0, "Should have enabled connectors"

        log.info(f"✅ Found {len(enabled)} enabled connectors")

        for connector, account in enabled:
            log.info(
                f"  - {connector.connector_type} for {account.name} (priority={connector.sync_priority})"
            )

    def test_build_connector_config(self, loader_service, pg_session):
        """Test that connector config is properly built."""
        # Get a connector
        connector, account = loader_service.get_enabled_connectors()[0]

        config = loader_service.build_connector_config(connector, account)

        # Should have account context
        assert "_account_id" in config
        assert "_account_name" in config
        assert "_connector_id" in config
        assert config["_account_id"] == account.id

        log.info(
            f"✅ Config built for {connector.connector_type}: {list(config.keys())}"
        )


class TestConnectorInstantiation:
    """Test that each connector type can be instantiated."""

    @pytest.mark.integration
    @pytest.mark.skipif(
        not has_exchange_credentials("binance"),
        reason="BINANCE_API_KEY/BINANCE_API_SECRET not configured — skipping live Binance integration test",
    )
    def test_instantiate_binance_connector(self, loader_service, pg_session):
        """Test Binance connector instantiation."""
        binance = pg_session.exec(
            select(Account).where(Account.name == "Binance")
        ).first()
        assert binance is not None

        connector_record = pg_session.exec(
            select(AccountConnector).where(
                AccountConnector.account_id == binance.id,
                AccountConnector.connector_type == "binance-transactions",
            )
        ).first()
        assert connector_record is not None

        connector = loader_service.instantiate_connector(connector_record, binance)
        assert connector is not None
        assert hasattr(connector, "yield_normalized")

        log.info(f"✅ Binance connector instantiated: {type(connector).__name__}")

    @pytest.mark.integration
    @pytest.mark.skipif(
        not has_exchange_credentials("mexc"),
        reason="MEXC_API_KEY/MEXC_API_SECRET not configured — skipping live MEXC integration test",
    )
    def test_instantiate_mexc_connector(self, loader_service, mexc_test_account):
        """Test MEXC connector instantiation."""
        mexc, connector_record = mexc_test_account

        connector = loader_service.instantiate_connector(connector_record, mexc)
        assert connector is not None
        assert hasattr(connector, "yield_normalized")

        log.info(f"✅ MEXC connector instantiated: {type(connector).__name__}")

    @pytest.mark.integration
    @pytest.mark.skipif(
        not has_exchange_credentials("okx"),
        reason="OKX_API_KEY/OKX_API_SECRET not configured — skipping live OKX integration test",
    )
    def test_instantiate_okx_connector(self, loader_service, okx_test_account):
        """Test OKX connector instantiation."""
        okx, connector_record = okx_test_account

        connector = loader_service.instantiate_connector(connector_record, okx)
        assert connector is not None
        assert hasattr(connector, "yield_normalized")

        log.info(f"✅ OKX connector instantiated: {type(connector).__name__}")

    @pytest.mark.integration
    @pytest.mark.skipif(
        not has_exchange_credentials("coinbase"),
        reason="COINBASE_API_KEY/COINBASE_API_SECRET not configured — skipping live Coinbase integration test",
    )
    def test_instantiate_coinbase_connector(self, loader_service, pg_session):
        """Test Coinbase connector instantiation."""
        coinbase = pg_session.exec(
            select(Account).where(Account.name == "Coinbase")
        ).first()
        assert coinbase is not None

        connector_record = pg_session.exec(
            select(AccountConnector).where(
                AccountConnector.account_id == coinbase.id,
                AccountConnector.connector_type == "coinbase-transactions",
            )
        ).first()
        assert connector_record is not None

        connector = loader_service.instantiate_connector(connector_record, coinbase)
        assert connector is not None
        assert hasattr(connector, "yield_normalized")

        log.info(f"✅ Coinbase connector instantiated: {type(connector).__name__}")

    @pytest.mark.integration
    def test_instantiate_blockscout_connector(
        self, loader_service, blockscout_test_account
    ):
        """Test Blockscout (Base) connector instantiation."""
        base_wallet, connector_record = blockscout_test_account

        connector = loader_service.instantiate_connector(connector_record, base_wallet)
        assert connector is not None
        assert hasattr(connector, "yield_normalized")

        log.info(f"✅ Blockscout connector instantiated: {type(connector).__name__}")

    @pytest.mark.integration
    def test_instantiate_etherscan_connector(
        self, loader_service, etherscan_test_account
    ):
        """Test Etherscan connector instantiation."""
        eth_wallet, connector_record = etherscan_test_account

        connector = loader_service.instantiate_connector(connector_record, eth_wallet)
        assert connector is not None
        assert hasattr(connector, "yield_normalized")

        log.info(f"✅ Etherscan connector instantiated: {type(connector).__name__}")


class TestConnectorApiConnection:
    """Test that connectors can connect to their APIs."""

    # Test symbols to limit API calls for faster tests
    BINANCE_TEST_SYMBOLS = ["BTC/USDT", "ETH/USDT"]
    MEXC_TEST_SYMBOLS = ["BTC_USDT", "ETH_USDT"]
    OKX_TEST_SYMBOLS = ["BTC-USDT", "ETH-USDT"]
    COINBASE_TEST_SYMBOLS = ["BTC/USD", "ETH/USD"]

    @pytest.mark.integration
    @pytest.mark.slow
    @pytest.mark.skipif(
        not has_exchange_credentials("binance"),
        reason="BINANCE_API_KEY/BINANCE_API_SECRET not configured — skipping live Binance integration test",
    )
    def test_binance_api_connection(self, loader_service, pg_session):
        """Test Binance connector can fetch data (limited)."""
        binance = pg_session.exec(
            select(Account).where(Account.name == "Binance")
        ).first()
        connector_record = pg_session.exec(
            select(AccountConnector).where(
                AccountConnector.account_id == binance.id,
                AccountConnector.connector_type == "binance-transactions",
            )
        ).first()

        # Add test symbols to config for faster test execution
        connector_record.config = connector_record.config or {}
        connector_record.config["symbols"] = self.BINANCE_TEST_SYMBOLS

        connector = loader_service.instantiate_connector(connector_record, binance)
        assert connector is not None

        # Try to fetch a small number of records
        count = 0
        for raw, mapped, error in connector.yield_normalized():
            if count >= 3:
                break
            if error:
                log.warning(f"Mapping error: {error}")
            else:
                count += 1
                log.info(f"  Binance trade: {mapped.source_asset_symbol}")

        log.info(f"✅ Binance API connected, fetched {count} records")

    @pytest.mark.integration
    @pytest.mark.slow
    @pytest.mark.skipif(
        not has_exchange_credentials("mexc"),
        reason="MEXC_API_KEY/MEXC_API_SECRET not configured — skipping live MEXC integration test",
    )
    def test_mexc_api_connection(self, loader_service, mexc_test_account):
        """Test MEXC connector can fetch data (limited)."""
        mexc, connector_record = mexc_test_account

        # Add test symbols to config for faster test execution
        connector_record.config = connector_record.config or {}
        connector_record.config["symbols"] = self.MEXC_TEST_SYMBOLS

        connector = loader_service.instantiate_connector(connector_record, mexc)
        assert connector is not None

        # Try to fetch a small number of records
        count = 0
        for raw, mapped, error in connector.yield_normalized():
            if count >= 3:
                break
            if error:
                log.warning(f"Mapping error: {error}")
            else:
                count += 1
                log.info(f"  MEXC trade: {mapped.source_asset_symbol}")

        log.info(f"✅ MEXC API connected, fetched {count} records")

    @pytest.mark.integration
    @pytest.mark.slow
    @pytest.mark.skipif(
        not has_exchange_credentials("okx"),
        reason="OKX_API_KEY/OKX_API_SECRET not configured — skipping live OKX integration test",
    )
    def test_okx_api_connection(self, loader_service, okx_test_account):
        """Test OKX connector can fetch data (limited)."""
        okx, connector_record = okx_test_account

        # Add test symbols to config for faster test execution
        connector_record.config = connector_record.config or {}
        connector_record.config["symbols"] = self.OKX_TEST_SYMBOLS

        connector = loader_service.instantiate_connector(connector_record, okx)
        assert connector is not None

        # Try to fetch a small number of records
        count = 0
        for raw, mapped, error in connector.yield_normalized():
            if count >= 3:
                break
            if error:
                log.warning(f"Mapping error: {error}")
            else:
                count += 1
                log.info(f"  OKX trade: {mapped.source_asset_symbol}")

        log.info(f"✅ OKX API connected, fetched {count} records")

    @pytest.mark.integration
    @pytest.mark.slow
    @pytest.mark.skipif(
        not has_exchange_credentials("coinbase"),
        reason="COINBASE_API_KEY/COINBASE_API_SECRET not configured — skipping live Coinbase integration test",
    )
    def test_coinbase_api_connection(self, loader_service, pg_session):
        """Test Coinbase connector can fetch data (limited)."""
        coinbase = pg_session.exec(
            select(Account).where(Account.name == "Coinbase")
        ).first()
        connector_record = pg_session.exec(
            select(AccountConnector).where(
                AccountConnector.account_id == coinbase.id,
                AccountConnector.connector_type == "coinbase-transactions",
            )
        ).first()

        # Add test symbols to config for faster test execution
        connector_record.config = connector_record.config or {}
        connector_record.config["symbols"] = self.COINBASE_TEST_SYMBOLS

        connector = loader_service.instantiate_connector(connector_record, coinbase)
        assert connector is not None

        # Try to fetch a small number of records
        count = 0
        for raw, mapped, error in connector.yield_normalized():
            if count >= 3:
                break
            if error:
                log.warning(f"Mapping error: {error}")
            else:
                count += 1
                log.info(f"  Coinbase trade: {mapped.source_asset_symbol}")

        log.info(f"✅ Coinbase API connected, fetched {count} records")

    @pytest.mark.integration
    @pytest.mark.slow
    def test_blockscout_api_connection(self, loader_service, blockscout_test_account):
        """Test Blockscout connector can fetch data (limited)."""
        base_wallet, connector_record = blockscout_test_account

        connector = loader_service.instantiate_connector(connector_record, base_wallet)
        assert connector is not None

        # Try to fetch a small number of records
        count = 0
        for raw, mapped, error in connector.yield_normalized():
            if count >= 3:
                break
            if error:
                log.warning(f"Mapping error: {error}")
            else:
                count += 1
                log.info(f"  Blockscout tx: {mapped.source_transaction_type}")

        log.info(f"✅ Blockscout API connected, fetched {count} records")


class TestConnectorRegistryIntegration:
    """Test that all seeded connector types are in the registry."""

    def test_all_seeded_types_in_registry(self, pg_session):
        """Test that all connector types in DB are registered."""
        registry = get_connector_registry()
        connectors = pg_session.exec(select(AccountConnector)).all()

        for connector in connectors:
            info = registry.get(connector.connector_type)
            assert info is not None, (
                f"Connector type '{connector.connector_type}' should be in registry"
            )

        log.info(f"✅ All {len(connectors)} connector types found in registry")
