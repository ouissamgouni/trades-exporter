"""
Tests for seed_prices_from_yaml — verifying that prices.yaml is correctly
parsed into AssetPriceGetter rows with deterministic mock price maps.

Uses a mock Session to validate logic without a real database.
"""

import pytest
import yaml
from pathlib import Path
from unittest.mock import MagicMock, patch, PropertyMock

from backend.db.models import Asset, AssetPriceGetter, AppSettings
from backend.db.seed import DatabaseSeeder


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_session():
    session = MagicMock()
    # Default: no existing rows found by queries
    mock_exec = MagicMock()
    mock_exec.first.return_value = None
    session.exec.return_value = mock_exec
    return session


@pytest.fixture
def seeder(mock_session):
    return DatabaseSeeder(mock_session)


@pytest.fixture
def prices_yaml(tmp_path) -> Path:
    """Create a temporary prices.yaml with BTC and EUR entries."""
    content = {
        "prices": [
            {
                "asset_symbol": "BTC",
                "quote_currency": "EUR",
                "entries": [
                    {"at": "2025-01-15T10:00:00", "price": "40000.00"},
                    {"at": "2025-06-15T10:00:00", "price": "60000.00"},
                    {"at": "current", "price": "55000.00"},
                ],
            },
            {
                "asset_symbol": "EUR",
                "quote_currency": "USD",
                "entries": [
                    {"at": "current", "price": "1.08"},
                ],
            },
        ],
    }
    p = tmp_path / "prices.yaml"
    p.write_text(yaml.dump(content))
    return p


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestSeedPricesFromYaml:
    """Tests for DatabaseSeeder.seed_prices_from_yaml()."""

    def test_returns_zero_when_no_path(self, seeder):
        assert seeder.seed_prices_from_yaml(None) == 0

    def test_returns_zero_when_file_missing(self, seeder, tmp_path):
        assert seeder.seed_prices_from_yaml(tmp_path / "nope.yaml") == 0

    def test_returns_zero_for_empty_file(self, seeder, tmp_path):
        p = tmp_path / "empty.yaml"
        p.write_text("")
        assert seeder.seed_prices_from_yaml(p) == 0

    def test_returns_zero_for_empty_prices_list(self, seeder, tmp_path):
        p = tmp_path / "prices.yaml"
        p.write_text(yaml.dump({"prices": []}))
        assert seeder.seed_prices_from_yaml(p) == 0

    def test_processes_valid_entries(self, seeder, mock_session, prices_yaml):
        # Mock _resolve_asset_id to return sequential IDs
        resolve_calls = {"BTC": 1, "EUR": 2}
        seeder._resolve_asset_id = lambda sym: resolve_calls.get(sym)

        # No existing rows, no AppSettings
        mock_exec = MagicMock()
        mock_exec.first.return_value = None
        mock_session.exec.return_value = mock_exec
        mock_session.get.return_value = None

        result = seeder.seed_prices_from_yaml(prices_yaml)

        assert result == 2
        # 2 AssetPriceGetter + 1 AppSettings = 3 adds
        assert mock_session.add.call_count == 3
        mock_session.commit.assert_called_once()

    def test_creates_correct_params_for_btc(self, seeder, mock_session, prices_yaml):
        resolve_calls = {"BTC": 1, "EUR": 2}
        seeder._resolve_asset_id = lambda sym: resolve_calls.get(sym)

        mock_exec = MagicMock()
        mock_exec.first.return_value = None
        mock_session.exec.return_value = mock_exec
        mock_session.get.return_value = None

        seeder.seed_prices_from_yaml(prices_yaml)

        # Check the first add call (BTC AssetPriceGetter)
        first_add = mock_session.add.call_args_list[0][0][0]
        assert isinstance(first_add, AssetPriceGetter)
        assert first_add.asset_id == 1
        assert first_add.price_getter == "mock"
        assert first_add.priority == 0
        assert first_add.enabled is True
        assert first_add.params["quote_currency"] == "EUR"
        assert first_add.params["prices"]["2025-01-15T10:00:00"] == 40000.0
        assert first_add.params["prices"]["2025-06-15T10:00:00"] == 60000.0
        assert first_add.params["prices"]["current"] == 55000.0

    def test_creates_correct_params_for_eur_usd(self, seeder, mock_session, prices_yaml):
        resolve_calls = {"BTC": 1, "EUR": 2}
        seeder._resolve_asset_id = lambda sym: resolve_calls.get(sym)

        mock_exec = MagicMock()
        mock_exec.first.return_value = None
        mock_session.exec.return_value = mock_exec
        mock_session.get.return_value = None

        seeder.seed_prices_from_yaml(prices_yaml)

        # Second add = EUR entry
        eur_add = mock_session.add.call_args_list[1][0][0]
        assert isinstance(eur_add, AssetPriceGetter)
        assert eur_add.asset_id == 2
        assert eur_add.params["quote_currency"] == "USD"
        assert eur_add.params["prices"]["current"] == 1.08

    def test_enables_mock_mode(self, seeder, mock_session, prices_yaml):
        resolve_calls = {"BTC": 1, "EUR": 2}
        seeder._resolve_asset_id = lambda sym: resolve_calls.get(sym)

        mock_exec = MagicMock()
        mock_exec.first.return_value = None
        mock_session.exec.return_value = mock_exec
        mock_session.get.return_value = None

        seeder.seed_prices_from_yaml(prices_yaml)

        # Third add = AppSettings with mock_mode_enabled=True
        settings_add = mock_session.add.call_args_list[2][0][0]
        assert isinstance(settings_add, AppSettings)
        assert settings_add.mock_mode_enabled is True

    def test_updates_existing_mock_getter(self, seeder, mock_session, prices_yaml):
        resolve_calls = {"BTC": 1, "EUR": 2}
        seeder._resolve_asset_id = lambda sym: resolve_calls.get(sym)

        # Simulate existing AssetPriceGetter for BTC
        existing_row = MagicMock(spec=AssetPriceGetter)
        existing_row.params = {"min_price": 100, "max_price": 50000}

        call_count = [0]
        def mock_exec_side_effect(stmt):
            result = MagicMock()
            if call_count[0] == 0:
                # First exec = select for BTC → existing row
                result.first.return_value = existing_row
            else:
                # Second exec = select for EUR → no existing
                result.first.return_value = None
            call_count[0] += 1
            return result

        mock_session.exec.side_effect = mock_exec_side_effect
        mock_session.get.return_value = None

        result = seeder.seed_prices_from_yaml(prices_yaml)
        assert result == 2

        # Existing row should have been updated
        assert existing_row.params["prices"]["current"] == 55000.0
        assert existing_row.enabled is True
        assert existing_row.priority == 0

    def test_skips_unknown_asset(self, seeder, mock_session, prices_yaml):
        # Only BTC resolves, EUR doesn't
        seeder._resolve_asset_id = lambda sym: 1 if sym == "BTC" else None

        mock_exec = MagicMock()
        mock_exec.first.return_value = None
        mock_session.exec.return_value = mock_exec
        mock_session.get.return_value = None

        result = seeder.seed_prices_from_yaml(prices_yaml)
        assert result == 1  # Only BTC

    def test_updates_existing_app_settings(self, seeder, mock_session, prices_yaml):
        resolve_calls = {"BTC": 1, "EUR": 2}
        seeder._resolve_asset_id = lambda sym: resolve_calls.get(sym)

        mock_exec = MagicMock()
        mock_exec.first.return_value = None
        mock_session.exec.return_value = mock_exec

        # AppSettings already exists
        existing_settings = MagicMock(spec=AppSettings)
        existing_settings.mock_mode_enabled = False
        mock_session.get.return_value = existing_settings

        seeder.seed_prices_from_yaml(prices_yaml)

        assert existing_settings.mock_mode_enabled is True


class TestSeedAllIncludesPrices:
    """Verify seed_all() wires prices correctly."""

    def test_seed_all_results_include_prices_key(self, seeder, mock_session):
        # Stub all sub-methods
        seeder.seed_assets_from_yaml = MagicMock(return_value=3)
        seeder.seed_prices_from_yaml = MagicMock(return_value=2)
        seeder.seed_from_yaml = MagicMock(return_value={"accounts": 1, "connectors": 1, "assets": 0})
        seeder.seed_bundles_from_yaml = MagicMock(return_value=1)
        seeder.seed_transactions_from_yaml = MagicMock(return_value=5)

        results = seeder.seed_all(seed_data_dir=Path("/fake/dir"))

        assert results["prices"] == 2
        assert results["assets"] == 3

    def test_seed_all_passes_prices_path(self, seeder, mock_session):
        seeder.seed_assets_from_yaml = MagicMock(return_value=0)
        seeder.seed_prices_from_yaml = MagicMock(return_value=0)
        seeder.seed_from_yaml = MagicMock(return_value={})
        seeder.seed_bundles_from_yaml = MagicMock(return_value=0)
        seeder.seed_transactions_from_yaml = MagicMock(return_value=0)

        seeder.seed_all(seed_data_dir=Path("/my/scenario"))

        seeder.seed_prices_from_yaml.assert_called_once_with(
            Path("/my/scenario/prices.yaml")
        )

    def test_seed_all_no_dir_passes_none_for_prices(self, seeder, mock_session):
        seeder.seed_assets_from_yaml = MagicMock(return_value=0)
        seeder.seed_prices_from_yaml = MagicMock(return_value=0)
        seeder.seed_from_yaml = MagicMock(return_value={})
        seeder.seed_bundles_from_yaml = MagicMock(return_value=0)
        seeder.seed_transactions_from_yaml = MagicMock(return_value=0)

        seeder.seed_all()

        seeder.seed_prices_from_yaml.assert_called_once_with(None)
