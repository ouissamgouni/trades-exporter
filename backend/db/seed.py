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
from pathlib import Path
from typing import Optional, List, Dict, Any

from sqlmodel import Session, select

from backend.db.models import Account, AccountConnector, Asset
from backend.db.database import get_session
from backend.config.loader import configure_logging

log = configure_logging("db_seed")

# Default config path: backend/db/seed_data/accounts.yaml
DEFAULT_CONFIG_PATH = Path(__file__).parent / "seed_data" / "accounts.yaml"


class DatabaseSeeder:
    """Service to seed database with initial data."""

    # Default assets to seed
    DEFAULT_ASSETS = [
        {"symbol": "EUR", "label": "Euro", "price_type": "fiat"},
        {"symbol": "USD", "label": "US Dollar", "price_type": "fiat"},
        {"symbol": "BTC", "label": "Bitcoin", "price_type": "crypto"},
        {"symbol": "ETH", "label": "Ethereum", "price_type": "crypto"},
        {"symbol": "USDT", "label": "Tether", "price_type": "crypto"},
        {"symbol": "USDC", "label": "USD Coin", "price_type": "crypto"},
    ]

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
        Seed default assets (EUR, USD, BTC, ETH, etc.).

        Returns:
            Number of assets created
        """
        return self.seed_assets(self.DEFAULT_ASSETS)

    def seed_assets(self, assets_config: List[Dict[str, Any]]) -> int:
        """
        Seed assets from configuration.

        Args:
            assets_config: List of asset configurations

        Returns:
            Number of assets created
        """
        created = 0
        for asset_data in assets_config:
            symbol = asset_data.get("symbol")
            if not symbol:
                continue

            existing = self.session.exec(
                select(Asset).where(Asset.symbol == symbol)
            ).first()

            if not existing:
                asset = Asset(
                    symbol=symbol,
                    label=asset_data.get("label"),
                    price_type=asset_data.get("price_type"),
                    tags=asset_data.get("tags"),
                )
                self.session.add(asset)
                created += 1
                log.debug(f"➕ Created asset: {symbol}")

        self.session.commit()
        if created > 0:
            log.info(f"✅ Seeded {created} assets")
        return created

    def seed_all(self, config_path: Optional[Path] = None) -> Dict[str, int]:
        """
        Run all seeding operations.

        Args:
            config_path: Optional path to accounts.yaml

        Returns:
            Dict with counts of all seeded entities
        """
        results = {"accounts": 0, "connectors": 0, "assets": 0}

        # Seed default assets first
        results["assets"] = self.seed_default_assets()

        # Seed from YAML config
        yaml_results = self.seed_from_yaml(config_path)
        results["accounts"] = yaml_results.get("accounts", 0)
        results["connectors"] = yaml_results.get("connectors", 0)
        results["assets"] += yaml_results.get("assets", 0)

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
        description="Seed the database with accounts and connectors from YAML configuration."
    )
    parser.add_argument(
        "--config",
        "-c",
        type=str,
        default=None,
        help=f"Path to YAML config file (default: {DEFAULT_CONFIG_PATH})",
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

    args = parser.parse_args()

    # Set test mode if requested
    if args.test:
        from backend.config.loader import set_test_mode

        set_test_mode(True)
        print("🧪 Using TEST database")
    else:
        print("🔐 Using PRODUCTION database")

    # Resolve config path
    config_path = Path(args.config) if args.config else DEFAULT_CONFIG_PATH

    if not config_path.exists():
        print(f"❌ ERROR: Config file not found: {config_path}")
        print("   Edit backend/db/seed_data/accounts.yaml to configure accounts")
        import sys

        sys.exit(1)

    print(f"📄 Config: {config_path}")

    if args.dry_run:
        # Dry run: just parse and display the config
        with open(config_path, "r") as f:
            config = yaml.safe_load(f) or {}

        accounts = config.get("accounts") or []
        print(f"\n📋 DRY RUN - Would seed {len(accounts)} accounts:")

        if not accounts:
            print("   (no accounts configured - edit the YAML file to add accounts)")

        for account_config in accounts:
            name = account_config.get("name", "unnamed")
            account_type = account_config.get("account_type", "unknown")
            connectors = account_config.get("connectors") or []
            print(f"\n  📦 Account: {name} (type: {account_type})")
            for connector in connectors:
                connector_type = connector.get("connector_type", "unknown")
                enabled = connector.get("enabled", True)
                status = "✓" if enabled else "○"
                print(f"      {status} Connector: {connector_type}")

        print("\n✅ Dry run complete. No changes were made.")
    else:
        result = seed_database(config_path)
        print(
            f"\n✅ Done! Accounts: {result.get('accounts', 0)}, Connectors: {result.get('connectors', 0)}"
        )
