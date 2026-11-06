"""
Data Cleanup Service for purging connector and account data.

Provides a shared cascade-delete implementation that handles the full FK dependency tree
for connectors and accounts. Replaces the inline cascade SQL previously in the accounts
route and fixes the broken connector delete (which had no cascade logic).

Usage:
    from backend.services.data_cleanup_service import DataCleanupService

    service = DataCleanupService(session)
    preview = service.preview_connector_cleanup([connector_id])
    service.execute_connector_cleanup([connector_id], delete_connectors=True)
"""

from dataclasses import dataclass
from typing import List, Optional

from sqlmodel import Session
from sqlalchemy import text

from backend.db.models import Account, AccountConnector, Asset
from backend.config.loader import configure_logging

log = configure_logging("data_cleanup_service")


@dataclass
class CleanupPreview:
    """Impact preview for a cleanup operation."""
    connector_ids: List[int]
    connector_names: List[str]
    transactions: int = 0
    raw_transactions: int = 0
    cost_lots: int = 0
    sync_runs: int = 0
    file_imports: int = 0
    transfer_references: int = 0
    derivative_positions: int = 0
    pnl_legs_affected: int = 0


@dataclass
class CleanupResult:
    """Result of a cleanup operation."""
    connectors_deleted: int = 0
    connectors_reset: int = 0
    transactions_deleted: int = 0
    raw_transactions_deleted: int = 0
    cost_lots_deleted: int = 0
    sync_runs_deleted: int = 0
    file_imports_deleted: int = 0
    derivative_positions_deleted: int = 0


class DataCleanupService:
    """
    Service for previewing and executing data cleanup operations.

    Handles the full FK dependency tree in correct order to avoid FK violations.
    Supports cleanup scoped by connector IDs or by account ID.
    """

    def __init__(self, session: Session):
        self.session = session

    def _count(self, sql: str, params: dict) -> int:
        """Execute a COUNT query and return the scalar result."""
        return self.session.exec(text(sql), params=params).one()[0]

    def _exec(self, sql: str, params: dict) -> int:
        """Execute a DML statement and return rowcount."""
        result = self.session.exec(text(sql), params=params)
        return result.rowcount  # type: ignore[union-attr]

    # =========================================================================
    # Preview
    # =========================================================================

    def preview_connector_cleanup(self, connector_ids: List[int]) -> CleanupPreview:
        """
        Preview the impact of cleaning up data for the given connectors.
        Does NOT modify any data.
        """
        if not connector_ids:
            return CleanupPreview(connector_ids=[], connector_names=[])

        # Resolve connector display names
        connector_names = []
        for cid in connector_ids:
            conn = self.session.get(AccountConnector, cid)
            if conn:
                account = self.session.get(Account, conn.account_id)
                account_name = account.name if account else "?"
                connector_names.append(f"{account_name} / {conn.connector_type}")

        ids_tuple = tuple(connector_ids)
        p = {"ids": ids_tuple}

        transactions = self._count(
            "SELECT COUNT(*) FROM normalized_transactions WHERE connector_id IN :ids", p
        )
        raw_transactions = self._count(
            "SELECT COUNT(*) FROM raw_transactions WHERE connector_id IN :ids", p
        )
        sync_runs = self._count(
            "SELECT COUNT(*) FROM sync_job_connector_runs WHERE connector_id IN :ids", p
        )
        file_imports = self._count(
            "SELECT COUNT(*) FROM file_imports WHERE connector_id IN :ids", p
        )

        # Transfer references: txs from OTHER connectors that reference accounts
        # owning these connectors via from_account_id / to_account_id
        # We count txs produced by these connectors that are referenced as transfer
        # counterparts by txs from other connectors.
        tx_sub = "(SELECT id FROM normalized_transactions WHERE connector_id IN :ids)"
        transfer_references = self._count(
            f"SELECT COUNT(*) FROM normalized_transactions "
            f"WHERE (from_account_id IN (SELECT DISTINCT account_id FROM account_connectors WHERE id IN :ids) "
            f"OR to_account_id IN (SELECT DISTINCT account_id FROM account_connectors WHERE id IN :ids)) "
            f"AND (connector_id IS NULL OR connector_id NOT IN :ids)",
            p,
        )

        # Cost lots whose origin_transaction_id is in affected transactions
        cost_lots = self._count(
            f"SELECT COUNT(*) FROM cost_lots WHERE origin_transaction_id IN {tx_sub}", p
        )

        # Derivative positions referencing affected transactions
        derivative_positions = self._count(
            f"SELECT COUNT(*) FROM derivative_positions WHERE open_transaction_id IN {tx_sub}", p
        )

        # P&L calculation legs referencing affected transactions
        pnl_legs_affected = self._count(
            f"SELECT COUNT(*) FROM calculation_unit_legs WHERE transaction_id IN {tx_sub}", p
        )

        return CleanupPreview(
            connector_ids=list(connector_ids),
            connector_names=connector_names,
            transactions=transactions,
            raw_transactions=raw_transactions,
            cost_lots=cost_lots,
            sync_runs=sync_runs,
            file_imports=file_imports,
            transfer_references=transfer_references,
            derivative_positions=derivative_positions,
            pnl_legs_affected=pnl_legs_affected,
        )

    def preview_account_cleanup(self, account_id: int) -> CleanupPreview:
        """
        Preview the impact of cleaning up ALL data for an account.
        Convenience wrapper that resolves all connector IDs for the account.
        """
        connector_ids = [
            row[0]
            for row in self.session.exec(
                text("SELECT id FROM account_connectors WHERE account_id = :aid"),
                params={"aid": account_id},
            ).all()
        ]
        preview = self.preview_connector_cleanup(connector_ids)

        # Add account-level counts not tied to connectors
        p = {"aid": account_id}
        # Transactions not tied to any connector (e.g. manually created)
        orphan_txs = self._count(
            "SELECT COUNT(*) FROM normalized_transactions WHERE account_id = :aid AND connector_id IS NULL", p
        )
        preview.transactions += orphan_txs

        # Cost lots owned by account (may not be tied to connector transactions)
        account_cost_lots = self._count(
            "SELECT COUNT(*) FROM cost_lots WHERE account_id = :aid", p
        )
        # Use the larger of the two counts (account-level is superset)
        preview.cost_lots = max(preview.cost_lots, account_cost_lots)

        derivative_positions = self._count(
            "SELECT COUNT(*) FROM derivative_positions WHERE account_id = :aid", p
        )
        preview.derivative_positions = max(preview.derivative_positions, derivative_positions)

        return preview

    # =========================================================================
    # Execute
    # =========================================================================

    def execute_connector_cleanup(
        self,
        connector_ids: List[int],
        delete_connectors: bool = False,
    ) -> CleanupResult:
        """
        Execute data cleanup for the given connectors.

        Cascade order matches the previously inline account delete logic.
        Handles all FK constraints in the correct order.

        Args:
            connector_ids: List of AccountConnector IDs to clean up.
            delete_connectors: If True, delete the connector rows themselves.
                             If False, keep connector config but reset sync status.
        """
        if not connector_ids:
            return CleanupResult()

        ids_tuple = tuple(connector_ids)
        p = {"ids": ids_tuple}
        result = CleanupResult()

        tx_sub = "(SELECT id FROM normalized_transactions WHERE connector_id IN :ids)"
        lot_sub = f"(SELECT cost_lot_id FROM cost_lots WHERE origin_transaction_id IN {tx_sub})"

        log.info("cleanup_start", connector_ids=connector_ids, delete_connectors=delete_connectors)

        # ── 1. Delete derivative positions owned by these connectors ──
        # (Now trivial thanks to the connector_id FK on derivative_positions)
        result.derivative_positions_deleted = self._exec(
            "DELETE FROM derivative_positions WHERE connector_id IN :ids", p
        )

        # ── 2. Detach P&L children of affected transactions ──
        # Nullify consumed_lot_slices FK to legs before deleting legs
        leg_sub = f"(SELECT id FROM calculation_unit_legs WHERE transaction_id IN {tx_sub})"
        self._exec(f"UPDATE consumed_lot_slices SET consumed_by_leg_id = NULL WHERE consumed_by_leg_id IN {leg_sub}", p)
        self._exec(f"DELETE FROM calculation_unit_legs WHERE transaction_id IN {tx_sub}", p)
        self._exec(f"UPDATE cost_lots SET origin_transaction_id = NULL WHERE origin_transaction_id IN {tx_sub}", p)
        self._exec(f"UPDATE realized_pnl SET transaction_id = NULL WHERE transaction_id IN {tx_sub}", p)
        self._exec(f"UPDATE lot_settlements SET settling_transaction_id = NULL WHERE settling_transaction_id IN {tx_sub}", p)
        self._exec(f"UPDATE pnl_warnings SET transaction_id = NULL WHERE transaction_id IN {tx_sub}", p)
        self._exec(f"UPDATE cost_lot_events SET triggered_by_transaction_id = NULL WHERE triggered_by_transaction_id IN {tx_sub}", p)

        # ── 3. Detach cost lot children ──
        self._exec(f"UPDATE cost_lots SET settled_by_lot_id = NULL WHERE settled_by_lot_id IN {lot_sub}", p)
        self._exec(f"UPDATE cost_lots SET source_lot_id = NULL WHERE source_lot_id IN {lot_sub}", p)
        self._exec(f"DELETE FROM consumed_lot_slices WHERE cost_lot_id IN {lot_sub}", p)
        self._exec(f"UPDATE lot_settlements SET negative_lot_id = NULL WHERE negative_lot_id IN {lot_sub}", p)
        self._exec(f"UPDATE lot_settlements SET settling_lot_id = NULL WHERE settling_lot_id IN {lot_sub}", p)
        self._exec(f"UPDATE cost_lot_events SET lot_id = NULL WHERE lot_id IN {lot_sub}", p)
        self._exec(f"UPDATE cost_lot_events SET related_lot_id = NULL WHERE related_lot_id IN {lot_sub}", p)

        # ── 4. Delete cost lots whose origin was in affected transactions ──
        result.cost_lots_deleted = self._exec(
            f"DELETE FROM cost_lots WHERE cost_lot_id IN {lot_sub}", p
        )

        # ── 5. Delete connector run children ──
        run_sub = "(SELECT id FROM sync_job_connector_runs WHERE connector_id IN :ids)"

        result.file_imports_deleted = self._exec(
            "DELETE FROM file_imports WHERE connector_id IN :ids", p
        )
        # Nullify sync_connector_run_id on transactions (before deleting runs)
        self._exec(
            f"UPDATE normalized_transactions SET sync_connector_run_id = NULL WHERE sync_connector_run_id IN {run_sub}", p
        )
        result.sync_runs_deleted = self._exec(
            "DELETE FROM sync_job_connector_runs WHERE connector_id IN :ids", p
        )

        # ── 6. Detach raw_transaction FK on ALL normalized_transactions referencing these raws ──
        raw_sub = "(SELECT id FROM raw_transactions WHERE connector_id IN :ids)"
        self._exec(
            f"UPDATE normalized_transactions SET raw_transaction_id = NULL WHERE raw_transaction_id IN {raw_sub}", p
        )

        # ── 7. Delete raw transactions ──
        result.raw_transactions_deleted = self._exec(
            "DELETE FROM raw_transactions WHERE connector_id IN :ids", p
        )

        # ── 8. Delete normalized transactions ──
        result.transactions_deleted = self._exec(
            "DELETE FROM normalized_transactions WHERE connector_id IN :ids", p
        )

        # ── 9. Handle connector rows ──
        if delete_connectors:
            # Delete fixture files
            for cid in connector_ids:
                try:
                    from backend.api.routes.fixtures import delete_fixture_file
                    delete_fixture_file(cid)
                except Exception:
                    pass  # fixture file cleanup is best-effort

            result.connectors_deleted = self._exec(
                "DELETE FROM account_connectors WHERE id IN :ids", p
            )
        else:
            # Reset sync status but keep config
            result.connectors_reset = self._exec(
                "UPDATE account_connectors SET last_sync_at = NULL, last_sync_status = 'pending', "
                "last_error = NULL WHERE id IN :ids", p
            )

        log.info("cleanup_complete", result=result)
        return result

    def execute_account_cleanup(
        self,
        account_id: int,
        delete_connectors: bool = False,
    ) -> CleanupResult:
        """
        Execute data cleanup for ALL connectors under an account,
        plus account-level data not tied to specific connectors.
        """
        p = {"aid": account_id}

        # Get all connector IDs for this account
        connector_ids = [
            row[0]
            for row in self.session.exec(
                text("SELECT id FROM account_connectors WHERE account_id = :aid"),
                params=p,
            ).all()
        ]

        # Clean connector data (also handles derivative positions via connector_id)
        result = self.execute_connector_cleanup(connector_ids, delete_connectors=delete_connectors)

        # Clean account-level orphaned transactions (not tied to any connector)
        orphan_tx_sub = "(SELECT id FROM normalized_transactions WHERE account_id = :aid AND connector_id IS NULL)"

        # Detach P&L refs for orphan transactions
        orphan_leg_sub = f"(SELECT id FROM calculation_unit_legs WHERE transaction_id IN {orphan_tx_sub})"
        self._exec(f"UPDATE consumed_lot_slices SET consumed_by_leg_id = NULL WHERE consumed_by_leg_id IN {orphan_leg_sub}", p)
        self._exec(f"DELETE FROM calculation_unit_legs WHERE transaction_id IN {orphan_tx_sub}", p)
        self._exec(f"UPDATE cost_lots SET origin_transaction_id = NULL WHERE origin_transaction_id IN {orphan_tx_sub}", p)
        self._exec(f"UPDATE realized_pnl SET transaction_id = NULL WHERE transaction_id IN {orphan_tx_sub}", p)
        self._exec(f"UPDATE lot_settlements SET settling_transaction_id = NULL WHERE settling_transaction_id IN {orphan_tx_sub}", p)
        self._exec(f"UPDATE pnl_warnings SET transaction_id = NULL WHERE transaction_id IN {orphan_tx_sub}", p)
        self._exec(f"UPDATE cost_lot_events SET triggered_by_transaction_id = NULL WHERE triggered_by_transaction_id IN {orphan_tx_sub}", p)

        # Delete derivative positions referencing orphan transactions
        self._exec(
            f"DELETE FROM derivative_positions WHERE open_transaction_id IN {orphan_tx_sub}", p
        )

        # Detach raw_transaction FK on orphan NTs and delete their raw_transactions
        # raw_transactions has no account_id — find orphan raws via the orphan NTs
        orphan_raw_sub = f"(SELECT raw_transaction_id FROM normalized_transactions WHERE account_id = :aid AND connector_id IS NULL AND raw_transaction_id IS NOT NULL)"
        self._exec(
            f"UPDATE normalized_transactions SET raw_transaction_id = NULL WHERE raw_transaction_id IN {orphan_raw_sub}", p
        )
        self._exec(
            f"DELETE FROM raw_transactions WHERE id IN {orphan_raw_sub}", p
        )

        # Delete orphan transactions
        self._exec(
            "DELETE FROM normalized_transactions WHERE account_id = :aid AND connector_id IS NULL", p
        )

        # Delete remaining account-level cost lots
        lot_sub = "(SELECT cost_lot_id FROM cost_lots WHERE account_id = :aid)"
        self._exec(f"UPDATE cost_lots SET settled_by_lot_id = NULL WHERE settled_by_lot_id IN {lot_sub}", p)
        self._exec(f"UPDATE cost_lots SET source_lot_id = NULL WHERE source_lot_id IN {lot_sub}", p)
        self._exec(f"DELETE FROM consumed_lot_slices WHERE cost_lot_id IN {lot_sub}", p)
        self._exec(f"UPDATE lot_settlements SET negative_lot_id = NULL WHERE negative_lot_id IN {lot_sub}", p)
        self._exec(f"UPDATE lot_settlements SET settling_lot_id = NULL WHERE settling_lot_id IN {lot_sub}", p)
        self._exec(f"UPDATE cost_lot_events SET lot_id = NULL WHERE lot_id IN {lot_sub}", p)
        self._exec(f"UPDATE cost_lot_events SET related_lot_id = NULL WHERE related_lot_id IN {lot_sub}", p)
        self._exec("DELETE FROM cost_lots WHERE account_id = :aid", p)

        # Delete any remaining derivative positions (e.g. with NULL connector_id)
        result.derivative_positions_deleted += self._exec(
            "DELETE FROM derivative_positions WHERE account_id = :aid", p
        )

        # Nullify raw_accounts references
        self._exec("UPDATE raw_accounts SET account_id = NULL WHERE account_id = :aid", p)

        return result

    def execute_account_delete(self, account_id: int) -> CleanupResult:
        """
        Delete an account and ALL its data. Full replacement for the
        previously inline cascade SQL in the accounts route.
        """
        account = self.session.get(Account, account_id)
        if not account:
            raise ValueError(f"Account {account_id} not found")

        p = {"aid": account_id}

        # Nullify transfer-counterparty FKs first (refs from ANY account's txs)
        self._exec("UPDATE normalized_transactions SET from_account_id = NULL WHERE from_account_id = :aid", p)
        self._exec("UPDATE normalized_transactions SET to_account_id = NULL WHERE to_account_id = :aid", p)

        # Clean all connector + account data
        result = self.execute_account_cleanup(account_id, delete_connectors=True)

        # Delete the account itself
        self.session.delete(account)

        return result

    # =========================================================================
    # Asset deletion
    # =========================================================================

    def preview_asset_delete(self, asset_id: int) -> dict:
        """
        Preview the impact of deleting an asset.
        Returns counts of all dependent rows without modifying anything.
        """
        p = {"aid": asset_id}

        return {
            # Cascade deletions (light children deleted with the asset)
            "asset_categories": self._count(
                "SELECT COUNT(*) FROM asset_categories WHERE asset_id = :aid", p
            ),
            "price_getters": self._count(
                "SELECT COUNT(*) FROM asset_price_getters WHERE asset_id = :aid", p
            ),
            "raw_assets": self._count(
                "SELECT COUNT(*) FROM raw_assets WHERE asset_id = :aid", p
            ),
            "price_snapshots": self._count(
                "SELECT COUNT(*) FROM price_snapshots WHERE asset_id = :aid", p
            ),
            # Heavy data (require force=true)
            "transactions": self._count(
                "SELECT COUNT(*) FROM normalized_transactions "
                "WHERE asset_id = :aid OR price_quote_asset_id = :aid OR fee_quote_asset_id = :aid", p
            ),
            "cost_lots": self._count(
                "SELECT COUNT(*) FROM cost_lots WHERE asset_id = :aid", p
            ),
            "realized_pnl": self._count(
                "SELECT COUNT(*) FROM realized_pnl WHERE asset_id = :aid", p
            ),
            "calculation_unit_legs": self._count(
                "SELECT COUNT(*) FROM calculation_unit_legs WHERE asset_id = :aid", p
            ),
            "fee_entries": self._count(
                "SELECT COUNT(*) FROM fee_entries WHERE related_asset_id = :aid", p
            ),
            "pnl_warnings": self._count(
                "SELECT COUNT(*) FROM pnl_warnings WHERE asset_id = :aid", p
            ),
        }

    def execute_asset_delete(self, asset_id: int) -> dict:
        """
        Force-delete an asset and ALL its dependent data.
        Handles the full FK dependency tree in correct order.
        """
        asset = self.session.get(Asset, asset_id)
        if not asset:
            raise ValueError(f"Asset {asset_id} not found")

        p = {"aid": asset_id}
        result = {}

        log.info("asset_delete_start", asset_id=asset_id, symbol=asset.symbol)

        # ── 1. Delete P&L warnings referencing this asset ──
        result["pnl_warnings_deleted"] = self._exec(
            "DELETE FROM pnl_warnings WHERE asset_id = :aid", p
        )

        # ── 2. Delete fee entries referencing this asset ──
        result["fee_entries_deleted"] = self._exec(
            "DELETE FROM fee_entries WHERE related_asset_id = :aid", p
        )

        # ── 3. Delete calculation unit legs referencing this asset ──
        asset_leg_sub = "(SELECT id FROM calculation_unit_legs WHERE asset_id = :aid)"
        self._exec(
            f"UPDATE consumed_lot_slices SET consumed_by_leg_id = NULL WHERE consumed_by_leg_id IN {asset_leg_sub}", p
        )
        result["calc_legs_deleted"] = self._exec(
            "DELETE FROM calculation_unit_legs WHERE asset_id = :aid", p
        )

        # ── 4. Handle realized P&L referencing this asset ──
        # First detach consumed_lot_slices that reference these realized_pnl rows
        pnl_sub = "(SELECT pnl_id FROM realized_pnl WHERE asset_id = :aid)"
        self._exec(
            f"DELETE FROM consumed_lot_slices WHERE pnl_id IN {pnl_sub}", p
        )
        result["realized_pnl_deleted"] = self._exec(
            "DELETE FROM realized_pnl WHERE asset_id = :aid", p
        )

        # ── 5. Handle cost lots referencing this asset ──
        lot_sub = "(SELECT cost_lot_id FROM cost_lots WHERE asset_id = :aid)"
        # Detach self-references and children
        self._exec(f"UPDATE cost_lots SET settled_by_lot_id = NULL WHERE settled_by_lot_id IN {lot_sub}", p)
        self._exec(f"UPDATE cost_lots SET source_lot_id = NULL WHERE source_lot_id IN {lot_sub}", p)
        self._exec(f"DELETE FROM consumed_lot_slices WHERE cost_lot_id IN {lot_sub}", p)
        self._exec(f"UPDATE lot_settlements SET negative_lot_id = NULL WHERE negative_lot_id IN {lot_sub}", p)
        self._exec(f"UPDATE lot_settlements SET settling_lot_id = NULL WHERE settling_lot_id IN {lot_sub}", p)
        self._exec(f"UPDATE cost_lot_events SET lot_id = NULL WHERE lot_id IN {lot_sub}", p)
        self._exec(f"UPDATE cost_lot_events SET related_lot_id = NULL WHERE related_lot_id IN {lot_sub}", p)
        result["cost_lots_deleted"] = self._exec(
            "DELETE FROM cost_lots WHERE asset_id = :aid", p
        )

        # ── 6. Handle transactions referencing this asset ──
        # Transactions can reference asset via asset_id, price_quote_asset_id, fee_quote_asset_id
        # We nullify the FK columns rather than deleting the whole transaction,
        # unless the transaction's primary asset_id matches.
        # First: nullify quote/fee references
        result["txs_quote_cleared"] = self._exec(
            "UPDATE normalized_transactions SET price_quote_asset_id = NULL WHERE price_quote_asset_id = :aid", p
        )
        result["txs_fee_cleared"] = self._exec(
            "UPDATE normalized_transactions SET fee_quote_asset_id = NULL WHERE fee_quote_asset_id = :aid", p
        )

        # For transactions whose primary asset IS this asset, we need to delete them
        # (they become meaningless without an asset)
        tx_sub = "(SELECT id FROM normalized_transactions WHERE asset_id = :aid)"

        # Detach P&L children of these transactions
        self._exec(f"DELETE FROM calculation_unit_legs WHERE transaction_id IN {tx_sub}", p)
        self._exec(f"UPDATE cost_lots SET origin_transaction_id = NULL WHERE origin_transaction_id IN {tx_sub}", p)
        self._exec(f"UPDATE realized_pnl SET transaction_id = NULL WHERE transaction_id IN {tx_sub}", p)
        self._exec(f"UPDATE lot_settlements SET settling_transaction_id = NULL WHERE settling_transaction_id IN {tx_sub}", p)
        self._exec(f"UPDATE pnl_warnings SET transaction_id = NULL WHERE transaction_id IN {tx_sub}", p)
        self._exec(f"UPDATE cost_lot_events SET triggered_by_transaction_id = NULL WHERE triggered_by_transaction_id IN {tx_sub}", p)

        # Detach derivative positions opening on these transactions
        self._exec(f"UPDATE derivative_positions SET open_transaction_id = NULL WHERE open_transaction_id IN {tx_sub}", p)

        # Detach raw_transaction FK
        raw_sub = f"(SELECT raw_transaction_id FROM normalized_transactions WHERE asset_id = :aid AND raw_transaction_id IS NOT NULL)"
        self._exec(f"UPDATE normalized_transactions SET raw_transaction_id = NULL WHERE raw_transaction_id IN {raw_sub}", p)

        # Delete raw transactions linked to these normalized transactions
        self._exec(f"DELETE FROM raw_transactions WHERE id IN {raw_sub}", p)

        # Nullify sync_connector_run_id before deleting
        self._exec(
            f"UPDATE normalized_transactions SET sync_connector_run_id = NULL WHERE asset_id = :aid AND sync_connector_run_id IS NOT NULL", p
        )

        # Delete the transactions themselves
        result["transactions_deleted"] = self._exec(
            "DELETE FROM normalized_transactions WHERE asset_id = :aid", p
        )

        # ── 7. Nullify calculation_versions base_currency_id ──
        self._exec(
            "UPDATE calculation_versions SET base_currency_id = NULL WHERE base_currency_id = :aid", p
        )

        # ── 8. Delete light children (handled by DB cascade, but explicit for safety) ──
        self._exec("DELETE FROM asset_categories WHERE asset_id = :aid", p)
        self._exec("DELETE FROM asset_price_getters WHERE asset_id = :aid", p)
        self._exec("UPDATE raw_assets SET asset_id = NULL WHERE asset_id = :aid", p)
        self._exec("DELETE FROM price_snapshots WHERE asset_id = :aid", p)
        # Also nullify price_snapshots quote_asset_id references
        self._exec("UPDATE price_snapshots SET quote_asset_id = NULL WHERE quote_asset_id = :aid", p)

        # ── 9. Delete the asset itself (raw SQL to avoid SQLAlchemy cascade setting NULLs) ──
        self._exec("DELETE FROM assets WHERE asset_id = :aid", p)

        log.info("asset_delete_complete", asset_id=asset_id, result=result)
        return result
