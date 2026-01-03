"""
Repository classes for database operations.

All repositories use SQLModel ORM with PostgreSQL.
"""

from backend.db.repositories.base import make_json_serializable
from backend.db.repositories.asset_repository import AssetRepository
from backend.db.repositories.raw_asset_repository import RawAssetRepository
from backend.db.repositories.raw_account_repository import RawAccountRepository
from backend.db.repositories.raw_transaction_repository import RawTransactionRepository
from backend.db.repositories.normalized_transaction_repository import (
    NormalizedTransactionRepository,
)

# GroupRepository: DEPRECATED - use calculation_unit_id on transactions
from backend.db.repositories.cost_lot_repository import CostLotRepository
from backend.db.repositories.realized_pnl_repository import RealizedPnlRepository
from backend.db.repositories.account_connector_repository import (
    AccountConnectorRepository,
)

__all__ = [
    "make_json_serializable",
    "AssetRepository",
    "RawAssetRepository",
    "RawAccountRepository",
    "RawTransactionRepository",
    "NormalizedTransactionRepository",
    # GroupRepository: DEPRECATED
    "CostLotRepository",
    "RealizedPnlRepository",
    "AccountConnectorRepository",
]
