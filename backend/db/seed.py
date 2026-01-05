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
import yaml
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Optional, List, Dict, Any

from sqlmodel import Session, select

from backend.db.models import (
    Account,
    AccountConnector,
    Asset,
    NormalizedTransaction,
    UserCalculationBundle,
)
from backend.db.database import get_session
from backend.config.loader import configure_logging

log = configure_logging("db_seed")

# Default config paths
SEED_DATA_DIR = Path(__file__).parent / "seed_data"
EXPORT_DATA_DIR = Path(__file__).parent / "seed_data" / "exports"
DEFAULT_CONFIG_PATH = SEED_DATA_DIR / "accounts.yaml"
DEFAULT_ASSETS_PATH = SEED_DATA_DIR / "assets.yaml"
DEFAULT_BUNDLES_PATH = SEED_DATA_DIR / "bundles.yaml"
DEFAULT_TRANSACTIONS_PATH = SEED_DATA_DIR / "transactions.yaml"


class DatabaseSeeder:
    """Service to seed database with initial data."""

    def __init__(self, session: Session):
        """
        Initialize the seeder.

        Args:
            session: Database session to use for operations
        """
        self.session = session

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

        created_accounts = 0
        created_connectors = 0

        for account_data in accounts_config:
            account = self._upsert_account(account_data)
            if account:
                created_accounts += 1

                connectors = account_data.get("connectors", [])
                for connector_data in connectors:
                    if self._upsert_connector(account.id, connector_data):
                        created_connectors += 1

        self.session.commit()

        log.info(
            f"✅ Seeded {created_accounts} accounts, {created_connectors} connectors"
        )
        return {"accounts": created_accounts, "connectors": created_connectors}

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
            existing.tags = data.get("tags", existing.tags)
            existing.owned = data.get("owned", existing.owned)
            self.session.add(existing)
            return existing

        # Create new account
        log.debug(f"➕ Creating new account: {name}")
        account = Account(
            name=name,
            account_type=data.get("account_type", "unknown"),
            address_or_identifier=data.get("address_or_identifier"),
            tags=data.get("tags"),
            owned=data.get("owned", True),
        )
        self.session.add(account)
        self.session.flush()  # Get ID assigned
        return account

    def _upsert_connector(self, account_id: int, data: Dict[str, Any]) -> bool:
        """
        Create or update a connector.

        Args:
            account_id: Parent account ID
            data: Connector data dictionary

        Returns:
            True if connector was created/updated successfully
        """
        connector_type = data.get("connector_type")
        if not connector_type:
            log.warning("⚠️ Connector missing type, skipping")
            return False

        # Get chain from config for uniqueness (important for blockscout multi-chain)
        config = data.get("config", {})
        chain = config.get("chain")

        # Build query for existing connector
        query = select(AccountConnector).where(
            AccountConnector.account_id == account_id,
            AccountConnector.connector_type == connector_type,
        )

        # For on-chain connectors, also match by chain
        existing = self.session.exec(query).first()

        # If blockscout, need to check chain in config
        if existing and connector_type == "blockscout":
            existing_chain = (existing.config or {}).get("chain")
            if existing_chain != chain:
                existing = None  # Different chain, create new connector

        if existing:
            # Update existing connector
            log.debug(
                f"📝 Updating connector: {connector_type} for account {account_id}"
            )
            existing.enabled = data.get("enabled", existing.enabled)
            existing.config = data.get("config", existing.config)
            existing.credentials_ref = data.get(
                "credentials_ref", existing.credentials_ref
            )
            existing.sync_priority = data.get("sync_priority", existing.sync_priority)
            self.session.add(existing)
            return True

        # Create new connector
        log.debug(f"➕ Creating connector: {connector_type} for account {account_id}")
        connector = AccountConnector(
            account_id=account_id,
            connector_type=connector_type,
            enabled=data.get("enabled", True),
            config=data.get("config", {}),
            credentials_ref=data.get("credentials_ref"),
            sync_priority=data.get("sync_priority", 100),
        )
        self.session.add(connector)
        return True

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
        for asset_data in assets_config:
            symbol = asset_data.get("symbol")
            if not symbol:
                continue

            existing = self.session.exec(
                select(Asset).where(Asset.symbol == symbol)
            ).first()

            if existing:
                # Update existing asset
                existing.label = asset_data.get("label", existing.label)
                existing.price_type = asset_data.get("price_type", existing.price_type)
                existing.tags = asset_data.get("tags", existing.tags)
                self.session.add(existing)
                log.debug(f"📝 Updated asset: {symbol}")
            else:
                # Create new asset
                asset = Asset(
                    symbol=symbol,
                    label=asset_data.get("label"),
                    price_type=asset_data.get("price_type"),
                    tags=asset_data.get("tags"),
                )
                self.session.add(asset)
                log.debug(f"➕ Created asset: {symbol}")
            processed += 1

        self.session.commit()
        if processed > 0:
            log.info(f"✅ Seeded {processed} assets")
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
        Seed transactions from configuration (idempotent upsert by source + source_transaction_id).

        Args:
            transactions_config: List of transaction configurations

        Returns:
            Number of transactions created or updated
        """
        processed = 0
        for tx_data in transactions_config:
            source = tx_data.get("source", "")
            source_tx_id = tx_data.get("source_transaction_id")
            if not source_tx_id:
                log.warning("⚠️ Transaction missing source_transaction_id, skipping")
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
            from_account_id = self._resolve_account_id(tx_data.get("from_account_name"))
            to_account_id = self._resolve_account_id(tx_data.get("to_account_name"))

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

            # Check for existing transaction
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
                existing.disposal_taxable = tx_data.get(
                    "disposal_taxable", existing.disposal_taxable
                )
                existing.from_account_id = from_account_id or existing.from_account_id
                existing.to_account_id = to_account_id or existing.to_account_id
                existing.user_calculation_unit_id = tx_data.get(
                    "bundle_id", existing.user_calculation_unit_id
                )
                existing.total = total if total is not None else existing.total
                existing.tags = tx_data.get("tags", existing.tags)
                existing.review_notes = tx_data.get(
                    "review_notes", existing.review_notes
                )
                existing.source_asset_symbol = tx_data.get(
                    "asset_symbol", existing.source_asset_symbol
                )
                existing.updated_at = datetime.now(timezone.utc)
                self.session.add(existing)
                log.debug(f"📝 Updated transaction: {source}/{source_tx_id}")
            else:
                # Create new transaction
                tx = NormalizedTransaction(
                    source=source,
                    source_transaction_id=source_tx_id,
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
                    disposal_taxable=tx_data.get("disposal_taxable", False),
                    from_account_id=from_account_id,
                    to_account_id=to_account_id,
                    user_calculation_unit_id=tx_data.get("bundle_id"),
                    total=total,
                    tags=tx_data.get("tags"),
                    review_notes=tx_data.get("review_notes"),
                    # raw_transaction_id is intentionally left null for seeded data
                )
                self.session.add(tx)
                log.debug(f"➕ Created transaction: {source}/{source_tx_id}")
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

    def seed_all(self, config_path: Optional[Path] = None) -> Dict[str, int]:
        """
        Run all seeding operations in dependency order (idempotent).

        Order:
        1. Assets from assets.yaml (includes all default assets)
        2. Accounts and connectors from accounts.yaml
        3. Bundles from bundles.yaml
        4. Transactions from transactions.yaml

        Args:
            config_path: Optional path to accounts.yaml

        Returns:
            Dict with counts of all seeded entities
        """
        results = {
            "assets": 0,
            "accounts": 0,
            "connectors": 0,
            "bundles": 0,
            "transactions": 0,
        }

        # 1. Seed all assets from assets.yaml (includes defaults like EUR, USD, BTC, etc.)
        results["assets"] = self.seed_assets_from_yaml()

        # 2. Seed accounts/connectors from accounts.yaml (may include custom assets)
        yaml_results = self.seed_from_yaml(config_path)
        results["accounts"] = yaml_results.get("accounts", 0)
        results["connectors"] = yaml_results.get("connectors", 0)
        results["assets"] += yaml_results.get("assets", 0)

        # 3. Seed bundles from bundles.yaml
        results["bundles"] = self.seed_bundles_from_yaml()

        # 4. Seed transactions from transactions.yaml
        results["transactions"] = self.seed_transactions_from_yaml()

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
            data["disposal_taxable"] = tx.disposal_taxable

            # Transfer accounts
            if tx.from_account_id and tx.from_account_id in account_map:
                data["from_account_name"] = account_map[tx.from_account_id]
            if tx.to_account_id and tx.to_account_id in account_map:
                data["to_account_name"] = account_map[tx.to_account_id]

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
    config_path: Optional[str | Path] = None, include_defaults: bool = True
):
    """
    Main entry point for database seeding.

    Args:
        config_path: Optional path to accounts.yaml configuration (str or Path)
        include_defaults: Whether to seed default assets

    Usage:
        python -m backend.db.seed
        # or
        from backend.db.seed import seed_database
        seed_database()
    """
    log.info("🌱 Starting database seeding...")

    # Convert string path to Path object
    if config_path and isinstance(config_path, str):
        config_path = Path(config_path)

    with get_session() as session:
        seeder = DatabaseSeeder(session)

        if include_defaults:
            seeder.seed_default_assets()

        results = seeder.seed_from_yaml(config_path)

        log.info(
            f"🎉 Seeding complete: {results.get('accounts', 0)} accounts, "
            f"{results.get('connectors', 0)} connectors"
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

    # Set test mode if requested
    if args.test:
        from backend.config.loader import set_test_mode

        set_test_mode(True)
        print("🧪 Using TEST database")
    else:
        print("🔐 Using PRODUCTION database")

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
        print("   Edit backend/db/seed_data/accounts.yaml to configure accounts")
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
