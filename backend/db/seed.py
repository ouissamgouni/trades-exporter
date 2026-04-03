"""
Database seeding module for accounts and connectors.

Provides functionality to:
- Seed accounts and connectors from YAML configuration
- Seed default assets (EUR, USD, BTC, ETH)
- Upsert logic (create if not exists, update if exists)

Usage:
    python -m backend.db.seed [--config path/to/accounts.yaml] [--test] [--dry-run]

Examples:
    python -m backend.db.seed                    # Seed using default config
    python -m backend.db.seed --test             # Seed test database
    python -m backend.db.seed --dry-run          # Preview without changes
    python -m backend.db.seed --config my.yaml   # Use custom config file
"""

import argparse
import os
import shutil
import yaml
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Optional, List, Dict, Any

from sqlmodel import Session, select

from backend.db.models import (
    Account,
    AccountConnector,
    AppSettings,
    Asset,
    AssetPriceGetter,
    FileImport,
    FileImportStatus,
    NormalizedTransaction,
    UserCalculationBundle,
)
from backend.db.database import get_session
from backend.config.loader import configure_logging

log = configure_logging("db_seed")

# Default config paths
SEED_DATA_DIR = Path(__file__).parent / "seed_data"
DEFAULT_SCENARIO_DIR = SEED_DATA_DIR / "scenarios" / "default"
EXPORT_DATA_DIR = SEED_DATA_DIR / "exports"
BROKER_EXPORTS_DIR = Path(__file__).parent.parent / "data" / "input" / "brokers-exports"
DEFAULT_FILES_DIR = Path(__file__).parent.parent / "data" / "input" / "defaults"
DEFAULT_CONFIG_PATH = DEFAULT_SCENARIO_DIR / "accounts.yaml"
DEFAULT_ASSETS_PATH = DEFAULT_SCENARIO_DIR / "assets.yaml"
DEFAULT_BUNDLES_PATH = DEFAULT_SCENARIO_DIR / "bundles.yaml"
DEFAULT_TRANSACTIONS_PATH = DEFAULT_SCENARIO_DIR / "transactions.yaml"


class DatabaseSeeder:
    """Service to seed database with initial data."""

    def __init__(self, session: Session):
        """
        Initialize the seeder.

        Args:
            session: Database session to use for operations
        """
        self.session = session

    def _validate_tags(self, tags: Any, entity_name: str) -> Optional[List[Dict[str, Any]]]:
        """
        Validate tags format: must be array of dictionaries [{key: val}, ...].
        Reject dictionary format {key: val} and string arrays ["tag1", "tag2"].

        Args:
            tags: Tags value from config (can be None, dict, list)
            entity_name: Name of entity for error messages

        Returns:
            Validated tags list or None if invalid/empty
        """
        if tags is None:
            return None

        if not isinstance(tags, list):
            log.error(
                f"❌ {entity_name}: tags must be an array of dictionaries, not {type(tags).__name__}. "
                f"Got: {tags}. Expected format: [{{'key': 'value'}}, ...]"
            )
            raise ValueError(f"Tags must be array format for {entity_name}")

        if len(tags) == 0:
            return None

        # Validate each element is a dict
        for i, tag in enumerate(tags):
            if not isinstance(tag, dict):
                log.error(
                    f"❌ {entity_name}: tag at index {i} must be a dictionary, not {type(tag).__name__}. "
                    f"Got: {tag}. Expected format: {{'key': 'value'}}"
                )
                raise ValueError(f"Each tag must be a dictionary for {entity_name}")

        return tags

    def seed_from_yaml(self, config_path: Optional[Path] = None) -> Dict[str, int]:
        """
        Seed database from YAML configuration.

        Args:
            config_path: Path to YAML config file. Uses default if not provided.

        Returns:
            Dict with counts of created/updated entities
        """
        config_path = config_path or DEFAULT_CONFIG_PATH

        if not config_path.exists():
            log.warning(f"⚠️ Seed config not found: {config_path}")
            return {"accounts": 0, "connectors": 0}

        log.info(f"📖 Loading seed config from: {config_path}")

        with open(config_path) as f:
            config = yaml.safe_load(f) or {}

        results = {"accounts": 0, "connectors": 0, "assets": 0}

        # Seed accounts and connectors
        accounts_result = self.seed_accounts(config.get("accounts", []))
        results["accounts"] = accounts_result.get("accounts", 0)
        results["connectors"] = accounts_result.get("connectors", 0)

        # Seed custom assets if provided
        if "assets" in config:
            results["assets"] = self.seed_assets(config["assets"])

        return results

    def seed_accounts(self, accounts_config: List[Dict[str, Any]]) -> Dict[str, int]:
        """
        Seed accounts and their connectors.

        Uses upsert logic: creates if not exists, updates if exists.

        Args:
            accounts_config: List of account configurations

        Returns:
            Dict with counts of created/updated accounts and connectors
        """
        if not accounts_config:
            log.info("ℹ️ No accounts to seed")
            return {"accounts": 0, "connectors": 0}

        processed_accounts = 0
        created_connectors = 0
        updated_connectors = 0

        for account_data in accounts_config:
            account = self._upsert_account(account_data)
            if account:
                processed_accounts += 1

                connectors = account_data.get("connectors", [])
                for connector_data in connectors:
                    result = self._upsert_connector(account.id, connector_data)
                    if result == "created":
                        created_connectors += 1
                    elif result == "updated":
                        updated_connectors += 1

        self.session.commit()

        total_connectors = created_connectors + updated_connectors
        log.info(
            f"✅ Seeded {processed_accounts} accounts, "
            f"{total_connectors} connectors "
            f"({created_connectors} new, {updated_connectors} updated)"
        )
        return {"accounts": processed_accounts, "connectors": total_connectors}

    def _upsert_account(self, data: Dict[str, Any]) -> Optional[Account]:
        """
        Create or update an account.

        Args:
            data: Account data dictionary

        Returns:
            Account instance or None if invalid
        """
        name = data.get("name")
        if not name:
            log.warning("⚠️ Account missing name, skipping")
            return None

        # Validate tags format
        tags = self._validate_tags(data.get("tags"), f"Account '{name}'")

        # Check if exists by name
        existing = self.session.exec(
            select(Account).where(Account.name == name)
        ).first()

        if existing:
            # Update existing account
            log.debug(f"📝 Updating existing account: {name}")
            existing.account_type = data.get("account_type", existing.account_type)
            existing.address_or_identifier = data.get(
                "address_or_identifier", existing.address_or_identifier
            )
            existing.tags = tags if tags is not None else existing.tags
            existing.owned = data.get("owned", existing.owned)
            existing.group = data.get("group", existing.group)
            existing.color = data.get("color", existing.color)
            self.session.add(existing)
            return existing

        # Create new account
        log.debug(f"➕ Creating new account: {name}")
        account_type = data.get("account_type", "unknown")
        # Auto-default envelope to CTO for taxable account types
        envelope = data.get("envelope")
        if envelope is None and account_type in ("cex", "broker", "investment"):
            envelope = "cto"
        account = Account(
            name=name,
            account_type=account_type,
            envelope=envelope,
            address_or_identifier=data.get("address_or_identifier"),
            tags=tags,
            owned=data.get("owned", True),
            group=data.get("group"),
            color=data.get("color"),
        )
        self.session.add(account)
        self.session.flush()  # Get ID assigned
        return account

    def _upsert_connector(
        self, account_id: int, data: Dict[str, Any]
    ) -> Optional[str]:
        """
        Create or update a connector (idempotent).

        Uses (account_id, connector_type, chain) as the composite identity.
        For connector types that support multiple chains (e.g. blockscout,
        moralis), the chain from config is included in the lookup query so
        each chain is treated as a separate connector.

        Args:
            account_id: Parent account ID
            data: Connector data dictionary

        Returns:
            "created" if a new connector was inserted,
            "updated" if an existing connector was modified,
            None if the entry was invalid and skipped.
        """
        connector_type = data.get("connector_type")
        if not connector_type:
            log.warning("⚠️ Connector missing type, skipping")
            return None

        # Get chain from config for uniqueness (multi-chain connectors like
        # blockscout and moralis can appear multiple times per account with
        # different chains).
        config = data.get("config", {})
        chain = config.get("chain")

        # Build query — always filter by (account_id, connector_type)
        query = select(AccountConnector).where(
            AccountConnector.account_id == account_id,
            AccountConnector.connector_type == connector_type,
        )

        if chain:
            # For multi-chain connectors, also match by chain inside the
            # JSON config column so each chain is a distinct row.
            query = query.where(
                AccountConnector.config["chain"].as_string() == chain
            )

        existing = self.session.exec(query).first()

        if existing:
            # Update existing connector
            log.debug(
                f"📝 Updating connector: {connector_type}"
                f"{f' ({chain})' if chain else ''}"
                f" for account {account_id}"
            )
            existing.enabled = data.get("enabled", existing.enabled)
            existing.config = data.get("config", existing.config)
            existing.credentials_ref = data.get(
                "credentials_ref", existing.credentials_ref
            )
            existing.sync_priority = data.get("sync_priority", existing.sync_priority)
            existing.color = data.get("color", existing.color)
            self.session.add(existing)
            self.session.flush()

            # Seed default file if specified and not already set
            default_file = data.get("default_file")
            config = existing.config or {}
            if default_file and not config.get("default_file_path"):
                self._seed_default_file(existing, default_file)

            return "updated"

        # Create new connector
        log.debug(
            f"➕ Creating connector: {connector_type}"
            f"{f' ({chain})' if chain else ''}"
            f" for account {account_id}"
        )
        connector = AccountConnector(
            account_id=account_id,
            connector_type=connector_type,
            enabled=data.get("enabled", True),
            config=data.get("config", {}),
            credentials_ref=data.get("credentials_ref"),
            sync_priority=data.get("sync_priority", 100),
            color=data.get("color"),
        )
        self.session.add(connector)
        self.session.flush()  # Get ID assigned

        # Seed default file if specified
        default_file = data.get("default_file")
        if default_file:
            self._seed_default_file(connector, default_file)

        return "created"

    def _seed_default_file(
        self, connector: AccountConnector, default_file_path: str
    ) -> None:
        """
        Seed a default file for a file connector.

        Copies the source file to data/input/defaults/{connector_id}/ and creates
        a FileImport record with DEFAULT status. Updates the connector config
        with default_file_path, default_file_import_id, default_file_name.

        The default_file_path in YAML can be:
        - Relative to broker-exports dir: "mexc/filename.xlsx"
        - Relative to seed_data dir: "../seed_data/files/filename.csv"
        - Absolute path

        Args:
            connector: AccountConnector instance (must have .id assigned)
            default_file_path: Path to the source file
        """
        # Resolve the source file path
        source = Path(default_file_path)
        if not source.is_absolute():
            # Try relative to broker-exports dir first
            candidate = BROKER_EXPORTS_DIR / default_file_path
            if candidate.exists():
                source = candidate
            else:
                # Try relative to seed_data dir
                candidate = SEED_DATA_DIR / default_file_path
                if candidate.exists():
                    source = candidate

        if not source.exists():
            log.warning(
                f"⚠️ Default file not found for connector {connector.connector_type} "
                f"(id={connector.id}): {default_file_path}"
            )
            return

        # Prepare destination
        dest_dir = DEFAULT_FILES_DIR / str(connector.id)
        dest_dir.mkdir(parents=True, exist_ok=True)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        # Sanitize filename (replace spaces with underscores)
        safe_name = source.name.replace(" ", "_")
        dest_filename = f"default_{timestamp}_{safe_name}"
        dest_path = dest_dir / dest_filename

        # Copy file
        shutil.copy2(str(source), str(dest_path))
        file_size = dest_path.stat().st_size

        log.info(
            f"📌 Seeding default file for {connector.connector_type} "
            f"(id={connector.id}): {source.name}"
        )

        # Create FileImport record
        file_import = FileImport(
            connector_id=connector.id,
            filename=dest_filename,
            original_filename=source.name,
            file_path=str(dest_path),
            file_size=file_size,
            status=FileImportStatus.DEFAULT,
            uploaded_at=datetime.now(timezone.utc),
            row_count=0,  # Unknown at seed time
            new_count=0,
            updated_count=0,
            skipped_count=0,
        )
        self.session.add(file_import)
        self.session.flush()

        # Update connector config
        config = dict(connector.config or {})
        config["default_file_path"] = str(dest_path)
        config["default_file_import_id"] = file_import.id
        config["default_file_name"] = source.name
        connector.config = config
        self.session.add(connector)

    def seed_default_assets(self) -> int:
        """
        Seed default assets from assets.yaml.

        Returns:
            Number of assets created
        """
        return self.seed_assets_from_yaml()

    def seed_assets(self, assets_config: List[Dict[str, Any]]) -> int:
        """
        Seed assets from configuration (idempotent upsert by symbol).

        Args:
            assets_config: List of asset configurations

        Returns:
            Number of assets created or updated
        """
        processed = 0
        new_assets: List[Asset] = []
        for asset_data in assets_config:
            symbol = asset_data.get("symbol")
            if not symbol:
                continue

            # Validate tags format
            tags = self._validate_tags(asset_data.get("tags"), f"Asset '{symbol}'")

            existing = self.session.exec(
                select(Asset).where(Asset.symbol == symbol)
            ).first()

            if existing:
                # Update existing asset
                existing.label = asset_data.get("label", existing.label)
                existing.price_type = asset_data.get("price_type", existing.price_type)
                existing.tags = tags if tags is not None else existing.tags
                self.session.add(existing)
                log.debug(f"📝 Updated asset: {symbol}")
            else:
                # Create new asset
                asset = Asset(
                    symbol=symbol,
                    label=asset_data.get("label"),
                    price_type=asset_data.get("price_type"),
                    tags=tags,
                )
                self.session.add(asset)
                new_assets.append(asset)
                log.debug(f"➕ Created asset: {symbol}")
            processed += 1

        self.session.commit()

        # Auto-create mock price getters for newly created assets
        if new_assets:
            self._ensure_mock_getters(new_assets)
            self.session.commit()
        if processed > 0:
            log.info(f"✅ Seeded {processed} assets")
        return processed

    # ------------------------------------------------------------------
    # Mock getter helpers
    # ------------------------------------------------------------------
    _MOCK_RANGES = {
        "crypto": {"min_price": 100.0, "max_price": 50000.0},
        "stock": {"min_price": 10.0, "max_price": 500.0},
        "fiat": {"min_price": 0.5, "max_price": 2.0},
    }
    _MOCK_DEFAULT = {"min_price": 1.0, "max_price": 1000.0}

    def _ensure_mock_getters(self, assets: List[Asset]) -> None:
        """Create disabled mock price getter rows for a batch of assets (idempotent)."""
        settings = self.session.get(AppSettings, 1)
        mock_enabled = settings.mock_mode_enabled if settings else False
        for asset in assets:
            existing = self.session.exec(
                select(AssetPriceGetter).where(
                    AssetPriceGetter.asset_id == asset.asset_id,
                    AssetPriceGetter.price_getter == "mock",
                )
            ).first()
            if existing:
                continue
            pt = (asset.price_type or "crypto").lower()
            params = dict(self._MOCK_RANGES.get(pt, self._MOCK_DEFAULT))
            self.session.add(
                AssetPriceGetter(
                    asset_id=asset.asset_id,
                    price_getter="mock",
                    priority=0,
                    enabled=mock_enabled,
                    params=params,
                )
            )

    # ------------------------------------------------------------------
    # Deterministic mock prices from YAML
    # ------------------------------------------------------------------

    def seed_prices_from_yaml(
        self, prices_path: Optional[Path] = None
    ) -> int:
        """
        Seed deterministic mock prices from prices.yaml.

        Reads a prices.yaml file and upserts AssetPriceGetter rows with
        ``price_getter="mock"``, ``enabled=True``, ``priority=0`` and a
        ``params`` dict containing the price map.

        Also enables ``AppSettings.mock_mode_enabled`` when prices are seeded.

        Args:
            prices_path: Path to prices.yaml. Skips silently if not provided
                         or if file does not exist.

        Returns:
            Number of assets with prices configured.
        """
        if prices_path is None or not prices_path.exists():
            return 0

        log.info(f"📖 Loading prices from: {prices_path}")

        with open(prices_path) as f:
            config = yaml.safe_load(f) or {}

        price_entries = config.get("prices", [])
        if not price_entries:
            return 0

        processed = 0
        for entry in price_entries:
            symbol = entry.get("asset_symbol")
            if not symbol:
                continue

            asset_id = self._resolve_asset_id(symbol)
            if asset_id is None:
                continue

            # Build the prices dict: {"2025-01-15T10:00:00": 40000.0, "current": 55000.0}
            prices_map: Dict[str, Any] = {}
            for price_entry in entry.get("entries", []):
                at_key = str(price_entry.get("at", ""))
                price_val = price_entry.get("price")
                if at_key and price_val is not None:
                    prices_map[at_key] = float(price_val)

            if not prices_map:
                continue

            params: Dict[str, Any] = {"prices": prices_map}
            quote_currency = entry.get("quote_currency")
            if quote_currency:
                params["quote_currency"] = quote_currency

            # Upsert AssetPriceGetter row
            existing = self.session.exec(
                select(AssetPriceGetter).where(
                    AssetPriceGetter.asset_id == asset_id,
                    AssetPriceGetter.price_getter == "mock",
                )
            ).first()

            if existing:
                existing.params = params
                existing.enabled = True
                existing.priority = 0
                self.session.add(existing)
                log.debug(f"📝 Updated mock prices: {symbol}")
            else:
                self.session.add(
                    AssetPriceGetter(
                        asset_id=asset_id,
                        price_getter="mock",
                        priority=0,
                        enabled=True,
                        params=params,
                    )
                )
                log.debug(f"➕ Created mock prices: {symbol}")
            processed += 1

        if processed > 0:
            # Enable mock mode
            settings = self.session.get(AppSettings, 1)
            if settings:
                settings.mock_mode_enabled = True
                self.session.add(settings)
            else:
                self.session.add(AppSettings(id=1, mock_mode_enabled=True))
            self.session.commit()
            log.info(f"✅ Seeded prices for {processed} assets (mock_mode enabled)")

        return processed

    def seed_assets_from_yaml(
        self, assets_path: Optional[Path] = None
    ) -> int:
        """
        Seed assets from YAML file.

        Args:
            assets_path: Path to assets.yaml. Uses default if not provided.

        Returns:
            Number of assets processed
        """
        assets_path = assets_path or DEFAULT_ASSETS_PATH

        if not assets_path.exists():
            log.debug(f"ℹ️ Assets config not found: {assets_path}")
            return 0

        log.info(f"📖 Loading assets from: {assets_path}")

        with open(assets_path) as f:
            config = yaml.safe_load(f) or {}

        assets = config.get("assets", [])
        return self.seed_assets(assets)

    def seed_bundles(self, bundles_config: List[Dict[str, Any]]) -> int:
        """
        Seed bundles from configuration (idempotent upsert by explicit ID).

        Args:
            bundles_config: List of bundle configurations

        Returns:
            Number of bundles created or updated
        """
        processed = 0
        for bundle_data in bundles_config:
            bundle_id = bundle_data.get("id")
            if bundle_id is None:
                log.warning("⚠️ Bundle missing explicit ID, skipping")
                continue

            existing = self.session.exec(
                select(UserCalculationBundle).where(
                    UserCalculationBundle.id == bundle_id
                )
            ).first()

            if existing:
                # Update existing bundle
                existing.label = bundle_data.get("label", existing.label)
                existing.pattern = bundle_data.get("pattern", existing.pattern)
                existing.notes = bundle_data.get("notes", existing.notes)
                existing.taxability_override = bundle_data.get(
                    "taxability_override", existing.taxability_override
                )
                existing.confidence = bundle_data.get("confidence", existing.confidence)
                existing.reason = bundle_data.get("reason", existing.reason)
                self.session.add(existing)
                log.debug(f"📝 Updated bundle: {bundle_id} - {existing.label}")
            else:
                # Create new bundle with explicit ID
                bundle = UserCalculationBundle(
                    id=bundle_id,
                    label=bundle_data.get("label"),
                    pattern=bundle_data.get("pattern"),
                    notes=bundle_data.get("notes"),
                    taxability_override=bundle_data.get("taxability_override"),
                    confidence=bundle_data.get("confidence"),
                    reason=bundle_data.get("reason"),
                )
                self.session.add(bundle)
                log.debug(f"➕ Created bundle: {bundle_id} - {bundle.label}")
            processed += 1

        self.session.commit()
        if processed > 0:
            log.info(f"✅ Seeded {processed} bundles")
        return processed

    def seed_bundles_from_yaml(
        self, bundles_path: Optional[Path] = None
    ) -> int:
        """
        Seed bundles from YAML file.

        Args:
            bundles_path: Path to bundles.yaml. Uses default if not provided.

        Returns:
            Number of bundles processed
        """
        bundles_path = bundles_path or DEFAULT_BUNDLES_PATH

        if not bundles_path.exists():
            log.debug(f"ℹ️ Bundles config not found: {bundles_path}")
            return 0

        log.info(f"📖 Loading bundles from: {bundles_path}")

        with open(bundles_path) as f:
            config = yaml.safe_load(f) or {}

        bundles = config.get("bundles", [])
        return self.seed_bundles(bundles)

    def _resolve_asset_id(self, symbol: str) -> Optional[int]:
        """Resolve asset symbol to asset_id."""
        if not symbol:
            return None
        asset = self.session.exec(
            select(Asset).where(Asset.symbol == symbol)
        ).first()
        if asset:
            return asset.asset_id
        log.warning(f"⚠️ Asset not found: {symbol}")
        return None

    def _resolve_account_id(self, name: str) -> Optional[int]:
        """Resolve account name to account_id."""
        if not name:
            return None
        account = self.session.exec(
            select(Account).where(Account.name == name)
        ).first()
        if account:
            return account.id
        log.warning(f"⚠️ Account not found: {name}")
        return None

    def seed_transactions(
        self, transactions_config: List[Dict[str, Any]]
    ) -> int:
        """
        Seed transactions from configuration (idempotent upsert).

        Idempotency is ensured by:
        1. Explicit 'id' field (preferred) - matches by primary key
        2. Fallback to 'source' + 'source_transaction_id' combination

        Args:
            transactions_config: List of transaction configurations

        Returns:
            Number of transactions created or updated
        """
        processed = 0
        for tx_data in transactions_config:
            # Get identifiers for idempotency
            explicit_id = tx_data.get("id")
            source = tx_data.get("source", "")
            source_tx_id = tx_data.get("source_transaction_id")

            # Require either explicit id or source_transaction_id
            if explicit_id is None and not source_tx_id:
                log.warning("⚠️ Transaction missing both 'id' and 'source_transaction_id', skipping")
                continue

            # Resolve foreign keys
            account_id = self._resolve_account_id(tx_data.get("account_name"))
            asset_id = self._resolve_asset_id(tx_data.get("asset_symbol"))
            price_quote_asset_id = self._resolve_asset_id(
                tx_data.get("price_quote_asset_symbol")
            )
            fee_quote_asset_id = self._resolve_asset_id(
                tx_data.get("fee_quote_asset_symbol")
            )
            from_account_id = self._resolve_account_id(tx_data.get("source_from_account"))
            to_account_id = self._resolve_account_id(tx_data.get("source_to_account"))

            # Parse datetime
            date_time_str = tx_data.get("date_time")
            date_time = None
            if date_time_str:
                try:
                    date_time = datetime.fromisoformat(
                        date_time_str.replace("Z", "+00:00")
                    )
                except ValueError:
                    log.warning(f"⚠️ Invalid date_time format: {date_time_str}")

            # Parse decimal fields
            quantity = Decimal(str(tx_data.get("quantity", "0")))
            price = None
            if tx_data.get("price") is not None:
                price = Decimal(str(tx_data["price"]))
            fee = None
            if tx_data.get("fee") is not None:
                fee = Decimal(str(tx_data["fee"]))
            total = None
            if tx_data.get("total") is not None:
                total = Decimal(str(tx_data["total"]))

            # Validate tags format
            tx_identifier = f"id={explicit_id}" if explicit_id else f"{source}/{source_tx_id}"
            tags = self._validate_tags(tx_data.get("tags"), f"Transaction {tx_identifier}")

            # Check for existing transaction - first by explicit id, then by source + source_tx_id
            existing = None
            if explicit_id is not None:
                existing = self.session.exec(
                    select(NormalizedTransaction).where(
                        NormalizedTransaction.id == explicit_id
                    )
                ).first()
            if existing is None and source_tx_id:
                existing = self.session.exec(
                    select(NormalizedTransaction).where(
                        NormalizedTransaction.source == source,
                        NormalizedTransaction.source_transaction_id == source_tx_id,
                    )
                ).first()

            if existing:
                # Update existing transaction
                existing.account_id = account_id
                existing.asset_id = asset_id
                existing.quantity = quantity
                existing.direction = tx_data.get("direction", existing.direction)
                existing.transaction_type = tx_data.get(
                    "transaction_type", existing.transaction_type
                )
                existing.source_transaction_type = tx_data.get(
                    "source_transaction_type", existing.source_transaction_type
                )
                existing.date_time = date_time or existing.date_time
                existing.price = price if price is not None else existing.price
                existing.price_quote_asset_id = (
                    price_quote_asset_id or existing.price_quote_asset_id
                )
                existing.source_price_quote_asset_symbol = tx_data.get(
                    "price_quote_asset_symbol",
                    existing.source_price_quote_asset_symbol,
                )
                existing.fee = fee if fee is not None else existing.fee
                existing.fee_quote_asset_id = (
                    fee_quote_asset_id or existing.fee_quote_asset_id
                )
                existing.source_fee_quote_asset_symbol = tx_data.get(
                    "fee_quote_asset_symbol", existing.source_fee_quote_asset_symbol
                )
                existing.review_status = tx_data.get(
                    "review_status", existing.review_status
                )
                existing.taxability_status = tx_data.get(
                    "taxability_status", existing.taxability_status
                )
                existing.from_account_id = from_account_id or existing.from_account_id
                existing.to_account_id = to_account_id or existing.to_account_id
                existing.user_calculation_unit_id = tx_data.get(
                    "bundle_id", existing.user_calculation_unit_id
                )
                existing.total = total if total is not None else existing.total
                existing.tags = tags if tags is not None else existing.tags
                existing.review_notes = tx_data.get(
                    "review_notes", existing.review_notes
                )
                existing.source_asset_symbol = tx_data.get(
                    "asset_symbol", existing.source_asset_symbol
                )
                existing.updated_at = datetime.now(timezone.utc)
                self.session.add(existing)
                tx_identifier = f"id={existing.id}" if explicit_id else f"{source}/{source_tx_id}"
                log.debug(f"📝 Updated transaction: {tx_identifier}")
            else:
                # Create new transaction with explicit id if provided
                tx = NormalizedTransaction(
                    id=explicit_id,  # Use explicit id for idempotency
                    source=source,
                    source_transaction_id=source_tx_id,
                    source_transaction_type=tx_data.get("source_transaction_type", ""),
                    source_asset_symbol=tx_data.get("asset_symbol", ""),
                    account_id=account_id,
                    asset_id=asset_id,
                    quantity=quantity,
                    direction=tx_data.get("direction", ""),
                    transaction_type=tx_data.get("transaction_type", ""),
                    date_time=date_time,
                    price=price,
                    price_quote_asset_id=price_quote_asset_id,
                    source_price_quote_asset_symbol=tx_data.get(
                        "price_quote_asset_symbol", ""
                    ),
                    fee=fee,
                    fee_quote_asset_id=fee_quote_asset_id,
                    source_fee_quote_asset_symbol=tx_data.get(
                        "fee_quote_asset_symbol", ""
                    ),
                    review_status=tx_data.get("review_status", "pending"),
                    taxability_status=tx_data.get("taxability_status", "unknown"),
                    from_account_id=from_account_id,
                    to_account_id=to_account_id,
                    user_calculation_unit_id=tx_data.get("bundle_id"),
                    total=total,
                    tags=tags,
                    review_notes=tx_data.get("review_notes"),
                    # raw_transaction_id is intentionally left null for seeded data
                )
                self.session.add(tx)
                tx_identifier = f"id={explicit_id}" if explicit_id else f"{source}/{source_tx_id}"
                log.debug(f"➕ Created transaction: {tx_identifier}")
            processed += 1

        self.session.commit()
        if processed > 0:
            log.info(f"✅ Seeded {processed} transactions")
        return processed

    def seed_transactions_from_yaml(
        self, transactions_path: Optional[Path] = None
    ) -> int:
        """
        Seed transactions from YAML file.

        Args:
            transactions_path: Path to transactions.yaml. Uses default if not provided.

        Returns:
            Number of transactions processed
        """
        transactions_path = transactions_path or DEFAULT_TRANSACTIONS_PATH

        if not transactions_path.exists():
            log.debug(f"ℹ️ Transactions config not found: {transactions_path}")
            return 0

        log.info(f"📖 Loading transactions from: {transactions_path}")

        with open(transactions_path) as f:
            config = yaml.safe_load(f) or {}

        transactions = config.get("transactions", [])
        return self.seed_transactions(transactions)

    def seed_all(
        self,
        config_path: Optional[Path] = None,
        seed_data_dir: Optional[Path] = None,
    ) -> Dict[str, int]:
        """
        Run all seeding operations in dependency order (idempotent).

        Order:
        1. Assets from assets.yaml (includes all default assets)
        2. Prices from prices.yaml (deterministic mock prices, optional)
        3. Accounts and connectors from accounts.yaml
        4. Bundles from bundles.yaml
        5. Transactions from transactions.yaml

        Args:
            config_path: Optional path to accounts.yaml
            seed_data_dir: Optional directory containing YAML seed files.
                           When provided, assets.yaml / accounts.yaml / bundles.yaml /
                           transactions.yaml are resolved from this directory instead
                           of the default seed_data/ directory. Files that don't exist
                           in the custom directory are silently skipped.

        Returns:
            Dict with counts of all seeded entities
        """
        results = {
            "assets": 0,
            "accounts": 0,
            "connectors": 0,
            "bundles": 0,
            "transactions": 0,
            "prices": 0,
        }

        # Resolve paths from custom directory if provided
        assets_path = (seed_data_dir / "assets.yaml") if seed_data_dir else None
        accounts_path = (seed_data_dir / "accounts.yaml") if seed_data_dir else config_path
        bundles_path = (seed_data_dir / "bundles.yaml") if seed_data_dir else None
        transactions_path = (seed_data_dir / "transactions.yaml") if seed_data_dir else None
        prices_path = (seed_data_dir / "prices.yaml") if seed_data_dir else None

        if seed_data_dir:
            log.info(f"📂 Using seed data directory: {seed_data_dir}")

        # 1. Seed all assets from assets.yaml (includes defaults like EUR, USD, BTC, etc.)
        results["assets"] = self.seed_assets_from_yaml(assets_path)

        # 2. Seed deterministic mock prices (if prices.yaml exists)
        results["prices"] = self.seed_prices_from_yaml(prices_path)

        # 3. Seed accounts/connectors from accounts.yaml (may include custom assets)
        yaml_results = self.seed_from_yaml(accounts_path)
        results["accounts"] = yaml_results.get("accounts", 0)
        results["connectors"] = yaml_results.get("connectors", 0)
        results["assets"] += yaml_results.get("assets", 0)

        # 4. Seed bundles from bundles.yaml
        results["bundles"] = self.seed_bundles_from_yaml(bundles_path)

        # 5. Seed transactions from transactions.yaml
        results["transactions"] = self.seed_transactions_from_yaml(transactions_path)

        return results

    def export_seed_data(
        self,
        output_dir: Optional[Path] = None,
    ) -> Dict[str, int]:
        """
        Export current database data to YAML files for review.

        Exports to exports/ subdirectory to avoid overwriting seed files:
        - assets.yaml: All assets referenced by transactions
        - bundles.yaml: All bundles referenced by transactions
        - transactions.yaml: All normalized transactions

        Args:
            output_dir: Output directory for YAML files. Uses exports/ if not provided.

        Returns:
            Dict with counts of exported entities
        """
        output_dir = output_dir or EXPORT_DATA_DIR
        output_dir.mkdir(parents=True, exist_ok=True)

        results = {"assets": 0, "bundles": 0, "transactions": 0, "accounts": 0}

        # Get all transactions
        transactions = self.session.exec(select(NormalizedTransaction)).all()

        if not transactions:
            log.warning("⚠️ No transactions found to export")
            return results

        # Collect unique asset IDs and account IDs from transactions
        asset_ids: set[int] = set()
        account_ids: set[int] = set()
        bundle_ids: set[int] = set()

        for tx in transactions:
            if tx.asset_id:
                asset_ids.add(tx.asset_id)
            if tx.price_quote_asset_id:
                asset_ids.add(tx.price_quote_asset_id)
            if tx.fee_quote_asset_id:
                asset_ids.add(tx.fee_quote_asset_id)
            if tx.account_id:
                account_ids.add(tx.account_id)
            if tx.from_account_id:
                account_ids.add(tx.from_account_id)
            if tx.to_account_id:
                account_ids.add(tx.to_account_id)
            if tx.user_calculation_unit_id:
                bundle_ids.add(tx.user_calculation_unit_id)

        # Export assets
        assets_data = self._export_assets(asset_ids)
        assets_path = output_dir / "assets.yaml"
        with open(assets_path, "w") as f:
            yaml.dump({"assets": assets_data}, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
        results["assets"] = len(assets_data)
        log.info(f"📤 Exported {len(assets_data)} assets to {assets_path}")

        # Export bundles
        bundles_data = self._export_bundles(bundle_ids)
        bundles_path = output_dir / "bundles.yaml"
        with open(bundles_path, "w") as f:
            yaml.dump({"bundles": bundles_data}, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
        results["bundles"] = len(bundles_data)
        log.info(f"📤 Exported {len(bundles_data)} bundles to {bundles_path}")

        # Export accounts (update existing file)
        accounts_data = self._export_accounts(account_ids)
        results["accounts"] = len(accounts_data)
        # Note: Not overwriting accounts.yaml automatically to preserve connectors config
        # Just log the accounts that need to be added
        if accounts_data:
            log.info(f"📋 Found {len(accounts_data)} accounts referenced by transactions")

        # Export transactions
        transactions_data = self._export_transactions(transactions)
        transactions_path = output_dir / "transactions.yaml"
        with open(transactions_path, "w") as f:
            yaml.dump({"transactions": transactions_data}, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
        results["transactions"] = len(transactions_data)
        log.info(f"📤 Exported {len(transactions_data)} transactions to {transactions_path}")

        return results

    def _export_assets(self, asset_ids: set[int]) -> List[Dict[str, Any]]:
        """Export assets by IDs to YAML format."""
        if not asset_ids:
            return []

        assets = self.session.exec(
            select(Asset).where(Asset.asset_id.in_(asset_ids))
        ).all()

        assets_data = []
        for asset in assets:
            data = {
                "symbol": asset.symbol,
                "label": asset.label,
                "price_type": asset.price_type,
            }
            if asset.tags:
                data["tags"] = asset.tags
            assets_data.append(data)

        return assets_data

    def _export_bundles(self, bundle_ids: set[int]) -> List[Dict[str, Any]]:
        """Export bundles by IDs to YAML format."""
        if not bundle_ids:
            return []

        bundles = self.session.exec(
            select(UserCalculationBundle).where(UserCalculationBundle.id.in_(bundle_ids))
        ).all()

        bundles_data = []
        for bundle in bundles:
            data = {
                "id": bundle.id,
                "label": bundle.label,
                "pattern": bundle.pattern,
            }
            if bundle.notes:
                data["notes"] = bundle.notes
            if bundle.taxability_override:
                data["taxability_override"] = bundle.taxability_override
            if bundle.confidence is not None:
                data["confidence"] = bundle.confidence
            if bundle.reason:
                data["reason"] = bundle.reason
            bundles_data.append(data)

        return bundles_data

    def _export_accounts(self, account_ids: set[int]) -> List[Dict[str, Any]]:
        """Export accounts by IDs to YAML format."""
        if not account_ids:
            return []

        accounts = self.session.exec(
            select(Account).where(Account.id.in_(account_ids))
        ).all()

        accounts_data = []
        for account in accounts:
            data = {
                "name": account.name,
                "account_type": account.account_type,
            }
            if account.address_or_identifier:
                data["address_or_identifier"] = account.address_or_identifier
            if account.tags:
                data["tags"] = account.tags
            data["owned"] = account.owned
            accounts_data.append(data)

        return accounts_data

    def _export_transactions(
        self, transactions: List[NormalizedTransaction]
    ) -> List[Dict[str, Any]]:
        """Export transactions to YAML format."""
        # Build lookup maps
        asset_map = self._build_asset_symbol_map()
        account_map = self._build_account_name_map()

        transactions_data = []
        for tx in transactions:
            data: Dict[str, Any] = {
                "id": tx.id,  # Include id for idempotent re-seeding
                "source": tx.source,
                "source_transaction_id": tx.source_transaction_id,
            }

            # Resolve account name
            if tx.account_id and tx.account_id in account_map:
                data["account_name"] = account_map[tx.account_id]

            # Resolve asset symbol
            if tx.asset_id and tx.asset_id in asset_map:
                data["asset_symbol"] = asset_map[tx.asset_id]

            # Core fields
            data["quantity"] = str(tx.quantity)
            data["direction"] = tx.direction
            data["transaction_type"] = tx.transaction_type

            # DateTime
            if tx.date_time:
                data["date_time"] = tx.date_time.isoformat()

            # Price
            if tx.price is not None:
                data["price"] = str(tx.price)
            if tx.price_quote_asset_id and tx.price_quote_asset_id in asset_map:
                data["price_quote_asset_symbol"] = asset_map[tx.price_quote_asset_id]

            # Fee
            if tx.fee is not None:
                data["fee"] = str(tx.fee)
            if tx.fee_quote_asset_id and tx.fee_quote_asset_id in asset_map:
                data["fee_quote_asset_symbol"] = asset_map[tx.fee_quote_asset_id]

            # Status fields
            data["review_status"] = tx.review_status
            data["taxability_status"] = tx.taxability_status

            # Transfer accounts
            data["source_from_account"] = tx.source_from_account
            data["source_to_account"] = tx.source_to_account

            # Bundle
            if tx.user_calculation_unit_id:
                data["bundle_id"] = tx.user_calculation_unit_id

            # Total
            if tx.total is not None:
                data["total"] = str(tx.total)

            # Optional fields
            if tx.tags:
                data["tags"] = tx.tags
            if tx.review_notes:
                data["review_notes"] = tx.review_notes

            transactions_data.append(data)

        return transactions_data

    def _build_asset_symbol_map(self) -> Dict[int, str]:
        """Build asset_id -> symbol mapping."""
        assets = self.session.exec(select(Asset)).all()
        return {a.asset_id: a.symbol for a in assets if a.asset_id}

    def _build_account_name_map(self) -> Dict[int, str]:
        """Build account_id -> name mapping."""
        accounts = self.session.exec(select(Account)).all()
        return {a.id: a.name for a in accounts if a.id}


def export_database_to_yaml(output_dir: Optional[str | Path] = None) -> Dict[str, int]:
    """
    Export current database to YAML seed files.

    Args:
        output_dir: Output directory (defaults to seed_data/)

    Returns:
        Dict with counts of exported entities
    """
    log.info("📤 Exporting database to YAML seed files...")

    if output_dir and isinstance(output_dir, str):
        output_dir = Path(output_dir)

    with get_session() as session:
        seeder = DatabaseSeeder(session)
        results = seeder.export_seed_data(output_dir)

        log.info(
            f"🎉 Export complete: {results['assets']} assets, "
            f"{results['bundles']} bundles, {results['transactions']} transactions"
        )

        return results


def seed_database(
    config_path: Optional[str | Path] = None,
    include_defaults: bool = True,
    seed_data_dir: Optional[str | Path] = None,
):
    """
    Main entry point for database seeding.

    Args:
        config_path: Optional path to accounts.yaml configuration (str or Path)
        include_defaults: Whether to seed default assets
        seed_data_dir: Optional directory containing YAML seed files.
                       When provided, seed files are resolved from this directory.

    Usage:
        python -m backend.db.seed
        python -m backend.db.seed --seed-dir path/to/scenario/
        # or
        from backend.db.seed import seed_database
        seed_database(seed_data_dir="path/to/scenario/")
    """
    log.info("🌱 Starting database seeding...")

    # Convert string paths to Path objects
    if config_path and isinstance(config_path, str):
        config_path = Path(config_path)
    if seed_data_dir and isinstance(seed_data_dir, str):
        seed_data_dir = Path(seed_data_dir)

    with get_session() as session:
        seeder = DatabaseSeeder(session)

        # Use seed_all to seed everything: assets, accounts, bundles, and transactions
        results = seeder.seed_all(config_path, seed_data_dir=seed_data_dir)

        prices_count = results.get('prices', 0)
        log.info(
            f"🎉 Seeding complete: {results.get('assets', 0)} assets, "
            f"{results.get('accounts', 0)} accounts, "
            f"{results.get('connectors', 0)} connectors, "
            f"{results.get('bundles', 0)} bundles, "
            f"{results.get('transactions', 0)} transactions"
            + (f", {prices_count} prices" if prices_count else "")
        )

        return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Seed the database with accounts, assets, bundles and transactions from YAML configuration."
    )
    parser.add_argument(
        "--config",
        "-c",
        type=str,
        default=None,
        help=f"Path to accounts YAML config file (default: {DEFAULT_CONFIG_PATH})",
    )
    parser.add_argument(
        "--test",
        "-t",
        action="store_true",
        help="Use test database instead of production",
    )
    parser.add_argument(
        "--dry-run",
        "-d",
        action="store_true",
        help="Show what would be seeded without making changes",
    )
    parser.add_argument(
        "--export",
        "-e",
        action="store_true",
        help="Export existing database to YAML seed files",
    )
    parser.add_argument(
        "--output-dir",
        "-o",
        type=str,
        default=None,
        help=f"Output directory for export (default: {EXPORT_DATA_DIR})",
    )
    parser.add_argument(
        "--all",
        "-a",
        action="store_true",
        help="Seed all data (assets, accounts, bundles, transactions)",
    )

    args = parser.parse_args()

    # Handle export mode
    if args.export:
        output_dir = Path(args.output_dir) if args.output_dir else None
        print(f"📤 Exporting to: {output_dir or EXPORT_DATA_DIR}")
        results = export_database_to_yaml(output_dir)
        print(
            f"\n✅ Export complete! "
            f"Assets: {results['assets']}, "
            f"Bundles: {results['bundles']}, "
            f"Transactions: {results['transactions']}"
        )
        import sys
        sys.exit(0)

    # Resolve config path
    config_path = Path(args.config) if args.config else DEFAULT_CONFIG_PATH

    if not config_path.exists():
        print(f"❌ ERROR: Config file not found: {config_path}")
        print("   Edit backend/db/seed_data/scenarios/default/accounts.yaml to configure accounts")
        import sys

        sys.exit(1)

    print(f"📄 Config: {config_path}")

    if args.dry_run:
        # Dry run: just parse and display all configs
        print("\n📋 DRY RUN - Previewing seed data:\n")

        # Accounts
        with open(config_path, "r") as f:
            config = yaml.safe_load(f) or {}
        accounts = config.get("accounts") or []
        print(f"  📦 Accounts: {len(accounts)}")
        for account_config in accounts:
            name = account_config.get("name", "unnamed")
            account_type = account_config.get("account_type", "unknown")
            connectors = account_config.get("connectors") or []
            print(f"      - {name} ({account_type}) with {len(connectors)} connectors")

        # Assets
        if DEFAULT_ASSETS_PATH.exists():
            with open(DEFAULT_ASSETS_PATH, "r") as f:
                assets_config = yaml.safe_load(f) or {}
            assets = assets_config.get("assets") or []
            print(f"\n  💰 Assets: {len(assets)}")

        # Bundles
        if DEFAULT_BUNDLES_PATH.exists():
            with open(DEFAULT_BUNDLES_PATH, "r") as f:
                bundles_config = yaml.safe_load(f) or {}
            bundles = bundles_config.get("bundles") or []
            print(f"  📦 Bundles: {len(bundles)}")

        # Transactions
        if DEFAULT_TRANSACTIONS_PATH.exists():
            with open(DEFAULT_TRANSACTIONS_PATH, "r") as f:
                tx_config = yaml.safe_load(f) or {}
            transactions = tx_config.get("transactions") or []
            print(f"  📝 Transactions: {len(transactions)}")

        print("\n✅ Dry run complete. No changes were made.")

    elif args.all:
        # Seed everything
        print("\n🌱 Seeding all data...")
        with get_session() as session:
            seeder = DatabaseSeeder(session)
            results = seeder.seed_all(config_path)
        print(
            f"\n✅ Done! "
            f"Assets: {results['assets']}, "
            f"Accounts: {results['accounts']}, "
            f"Connectors: {results['connectors']}, "
            f"Bundles: {results['bundles']}, "
            f"Transactions: {results['transactions']}"
        )

    else:
        # Default: seed accounts only (legacy behavior)
        result = seed_database(config_path)
        print(
            f"\n✅ Done! Accounts: {result.get('accounts', 0)}, Connectors: {result.get('connectors', 0)}"
        )
