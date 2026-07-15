"""
Unit tests for UX improvement changes:
- ConnectorRegistry: start_datetime in configs, no start_block, is_file_connector
- FileImportStatus.DEFAULT enum value
- ConnectorProgress: account_type and account_group fields
- accounts.yaml seed: groups, tags format, start_datetime
"""

import pytest
import yaml
from pathlib import Path
from dataclasses import fields as dataclass_fields

from backend.connectors.connector_registry import get_connector_registry, ConnectorInfo
from backend.db.models import FileImportStatus
from backend.services.sync_job_service import ConnectorProgress


class TestConnectorRegistryStartDatetime:
    """Verify start_date was renamed to start_datetime and start_block removed."""

    @pytest.fixture
    def registry(self):
        return get_connector_registry()

    def test_no_start_block_in_any_connector(self, registry):
        """Ensure start_block is not in any connector's config fields."""
        for connector_type in registry.list_types():
            info = registry.get(connector_type)
            assert info is not None
            all_config_keys = (info.required_config or []) + (
                info.optional_config or []
            )
            assert "start_block" not in all_config_keys, (
                f"Connector {connector_type} still has 'start_block' in config"
            )

    def test_start_datetime_in_onchain_connectors(self, registry):
        """On-chain connectors that previously had start_date should now have start_datetime."""
        onchain_types = ["blockscout", "etherscan"]
        for ct in onchain_types:
            info = registry.get(ct)
            if info is None:
                continue
            all_config_keys = (info.required_config or []) + (
                info.optional_config or []
            )
            assert "start_datetime" in all_config_keys, (
                f"Connector {ct} missing 'start_datetime' in config"
            )
            assert "start_date" not in all_config_keys, (
                f"Connector {ct} still has old 'start_date' in config"
            )

    def test_no_start_date_in_any_connector(self, registry):
        """Ensure the old 'start_date' field is completely removed."""
        for connector_type in registry.list_types():
            info = registry.get(connector_type)
            assert info is not None
            all_config_keys = (info.required_config or []) + (
                info.optional_config or []
            )
            assert "start_date" not in all_config_keys, (
                f"Connector {connector_type} still has old 'start_date' in config"
            )


class TestConnectorRegistryFileConnector:
    """Verify is_file_connector flag."""

    @pytest.fixture
    def registry(self):
        return get_connector_registry()

    def test_file_connectors_marked(self, registry):
        """File-based connectors should have is_file_connector=True."""
        file_connector_types = [
            "mexc-transactions-file",
            "mexc-deposits-file",
            "mexc-withdrawals-file",
            "okx-file",
        ]
        for ct in file_connector_types:
            info = registry.get(ct)
            if info is None:
                continue  # May not be registered in test env
            assert info.is_file_connector is True, (
                f"File connector {ct} should have is_file_connector=True"
            )

    def test_api_connectors_not_marked_as_file(self, registry):
        """API-based connectors should have is_file_connector=False."""
        api_connector_types = [
            "binance-transactions",
            "blockscout",
            "etherscan",
            "solana",
        ]
        for ct in api_connector_types:
            info = registry.get(ct)
            if info is None:
                continue
            assert info.is_file_connector is False, (
                f"API connector {ct} should have is_file_connector=False"
            )

    def test_connector_info_has_is_file_connector_field(self):
        """ConnectorInfo dataclass should include is_file_connector."""
        field_names = [f.name for f in dataclass_fields(ConnectorInfo)]
        assert "is_file_connector" in field_names

    def test_connector_info_to_api_dict_includes_is_file_connector(self):
        """ConnectorInfo.to_api_dict() should include is_file_connector."""
        info = ConnectorInfo(
            type="test-connector",
            connector_class=None,
            category="test",
            display_name="Test",
            is_file_connector=True,
        )
        d = info.to_api_dict()
        assert "is_file_connector" in d
        assert d["is_file_connector"] is True


class TestFileImportStatusDefault:
    """Verify the new DEFAULT status in FileImportStatus enum."""

    def test_default_status_exists(self):
        """FileImportStatus should have a DEFAULT member."""
        assert hasattr(FileImportStatus, "DEFAULT")
        assert FileImportStatus.DEFAULT.value == "default"

    def test_all_expected_statuses(self):
        """All expected statuses should be present."""
        expected = {"pending", "processing", "completed", "failed", "default"}
        actual = {status.value for status in FileImportStatus}
        assert expected == actual


class TestConnectorProgressFields:
    """Verify ConnectorProgress has account_type and account_group fields."""

    def test_has_account_type_field(self):
        """ConnectorProgress should have account_type field."""
        field_names = [f.name for f in dataclass_fields(ConnectorProgress)]
        assert "account_type" in field_names

    def test_has_account_group_field(self):
        """ConnectorProgress should have account_group field."""
        field_names = [f.name for f in dataclass_fields(ConnectorProgress)]
        assert "account_group" in field_names

    def test_default_values_are_none(self):
        """account_type and account_group should default to None."""
        cp = ConnectorProgress(
            connector_id=1,
            connector_type="test",
            account_name="test",
        )
        assert cp.account_type is None
        assert cp.account_group is None

    def test_to_dict_includes_account_fields(self):
        """to_dict() should include account_type and account_group."""
        cp = ConnectorProgress(
            connector_id=1,
            connector_type="test",
            account_name="test",
            account_type="cex",
            account_group="Trading",
        )
        d = cp.to_dict()
        assert d["account_type"] == "cex"
        assert d["account_group"] == "Trading"


class TestAccountsYamlSeed:
    """Verify accounts.yaml seed file structure."""

    @pytest.fixture
    def accounts_yaml(self):
        yaml_path = (
            Path(__file__).parents[4] / "scenarios" / "default" / "accounts.yaml"
        )
        with open(yaml_path) as f:
            return yaml.safe_load(f)

    def test_all_accounts_have_group(self, accounts_yaml):
        """Every account should have a group field."""
        for account in accounts_yaml["accounts"]:
            assert "group" in account, (
                f"Account '{account['name']}' is missing 'group' field"
            )
            assert account["group"] is not None and account["group"] != "", (
                f"Account '{account['name']}' has empty group"
            )

    def test_tags_are_list_of_dicts(self, accounts_yaml):
        """Tags should be lists of dicts (not strings)."""
        for account in accounts_yaml["accounts"]:
            tags = account.get("tags")
            if tags is None:
                continue
            assert isinstance(tags, list), (
                f"Account '{account['name']}' tags should be a list"
            )
            for tag in tags:
                assert isinstance(tag, dict), (
                    f"Account '{account['name']}' has non-dict tag: {tag}"
                )

    def test_no_start_date_in_configs(self, accounts_yaml):
        """No connector config should use old 'start_date' key."""
        for account in accounts_yaml["accounts"]:
            for connector in account.get("connectors", []):
                config = connector.get("config", {})
                if config:
                    assert "start_date" not in config, (
                        f"Connector {connector['connector_type']} in account "
                        f"'{account['name']}' still uses 'start_date'"
                    )

    def test_start_datetime_format(self, accounts_yaml):
        """start_datetime values should use ISO format."""
        for account in accounts_yaml["accounts"]:
            for connector in account.get("connectors", []):
                config = connector.get("config", {})
                if config and "start_datetime" in config:
                    val = config["start_datetime"]
                    assert "T" in val, (
                        f"start_datetime '{val}' should be ISO format with T separator"
                    )

    def test_cex_accounts_have_trading_or_onramp_group(self, accounts_yaml):
        """CEX accounts should have meaningful groups."""
        cex_accounts = [
            a for a in accounts_yaml["accounts"] if a["account_type"] == "cex"
        ]
        for account in cex_accounts:
            assert account["group"] in ("Trading", "On-Ramp"), (
                f"CEX account '{account['name']}' has unexpected group: {account['group']}"
            )

    def test_wallet_accounts_have_group(self, accounts_yaml):
        """All wallet accounts should have a group."""
        wallet_accounts = [
            a for a in accounts_yaml["accounts"] if a["account_type"] == "wallet"
        ]
        for account in wallet_accounts:
            assert account.get("group"), (
                f"Wallet account '{account['name']}' is missing group"
            )
