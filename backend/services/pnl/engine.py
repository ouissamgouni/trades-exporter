"""
P&L Engine - Main orchestration for P&L calculation.

This is the entry point that ties together all components:
- LotManager for cost lot tracking
- FMVService for price lookups
- handle_unit for processing
- CalculationUnit for unified runtime + persistence

Architecture:
- UserCalculationBundle (DB model): User-defined transaction groupings (bundles table)
- CalculationUnit (DB model): Unified runtime + persistence model (calculation_units table)
  - Stores processing record with unit_origin ("bundle:{id}" or "tx:{id}")
  - Has members populated at runtime for P&L calculation

The engine handles:
1. Building CalculationUnits from transactions (expansion + aggregation)
2. Processing units chronologically
3. Managing lot consumption and creation
"""

from collections import defaultdict
from datetime import datetime
from decimal import Decimal
from typing import Optional, List, Any, Dict
import uuid

from sqlmodel import Session, select
from sqlalchemy.orm import selectinload

from backend.config.loader import configure_logging
from backend.db.models import CalculationUnitLeg, CalculationVersion, CalculationUnit, NormalizedTransaction, Asset, UserCalculationBundle, PnlWarning, UnitPattern
from backend.services.pnl.config import PnLConfig, WarningType
from backend.services.pnl.models import (
    PnLResult,
    RuntimeUnitType,
)
from backend.services.pnl.lot_manager import LotManager
from backend.services.pnl.fmv_service import FMVService
from backend.services.pnl.group_handler import handle_unit
from backend.services.pnl.leg_expander import expand_transactions


log = configure_logging("pnl_engine")


class PnLEngine:
    """
    P&L calculation engine.

    Processes RuntimeCalculationUnits to calculate:
    - Cost lots (acquisitions)
    - Consumed lot slices (disposals)
    - Realized P&L
    - Fee consumption
    - Unrealized P&L (preview)
    """

    def __init__(
        self,
        session: Session,
        price_service: Optional[Any] = None,
        config: Optional[PnLConfig] = None,
    ):
        """
        Initialize P&L Engine.

        Args:
            session: Database session
            price_service: Service for fetching prices
            config: P&L calculation configuration
        """
        self.session = session
        self.config = config or PnLConfig()

        # Initialize components
        self.lot_manager = LotManager(self.config)
        self.fmv_service = FMVService(price_service, self.config)

        self._base_currency_symbol: Optional[str] = None

    def aggregate_legs_to_units(
        self,
        all_legs: list[CalculationUnitLeg],
        version: Optional[Any] = None,
    ) -> List["CalculationUnit"]:
        """
        Aggregate ExpandedLegs into CalculationUnits.
        Gets UserCalculationBundle from legs (already loaded with transaction).

        Args:
            all_legs: List of ExpandedLeg objects.
            version: Optional CalculationVersion to attach to each unit.

        Returns:
            List of CalculationUnit objects with legs populated.
        """
        from backend.db.models import CalculationUnitLeg
        
        units_by_key: Dict[tuple, List[Any]] = defaultdict(list)
        for leg in all_legs:
            unit_id = leg.unit_id
            origin_id = leg.origin_transaction_id
            key = ("unit", unit_id) if unit_id else ("tx", origin_id)
            units_by_key[key].append(leg)
        
        units = []
        for (key_type, key_id), members in units_by_key.items():
            # Determine unit_origin based on key type
            if key_type == "unit":
                unit_origin = f"bundle:{key_id}"
                # Get bundle from first member (all members have same bundle)
                bundle = members[0].transaction.user_calculation_unit if members else None
            else:
                unit_origin = f"tx:{key_id}"
                bundle = None
            
            # Get earliest timestamp from members for the unit
            timestamps = [m.date_time for m in members if hasattr(m, 'date_time') and m.date_time]
            timestamp = min(timestamps) if timestamps else datetime.utcnow()
            
            # Create CalculationUnit with runtime attributes from bundle
            unit_data = {
                'unit_origin': unit_origin,
                'timestamp': timestamp,
            }
            
            # Copy properties from bundle if available
            if bundle:
                unit_data['pattern'] = bundle.pattern
                unit_data['bundle_taxability_override'] = bundle.taxability_override
            
            unit = CalculationUnit(**unit_data)
            if version:
                unit.version = version
                # Explicitly add unit to version's collection for proper cascade
                if version.calculation_units is None:
                    version.calculation_units = []
                version.calculation_units.append(unit)
            
            # Create CalculationUnitLeg records from members (for persistence)
            unit.legs = members
            
            # Recompute pattern and label now that legs are assigned
            # (pattern computation in __init__ ran with empty legs)
            if unit.pattern is None or unit.pattern == UnitPattern.UNKNOWN.value:
                computed_pattern, reason = unit._compute_pattern_from_legs()
                unit.pattern = computed_pattern
                log.debug(f"Unit {unit.id}: Pattern recomputed after legs: {computed_pattern} ({reason})")
            
            if not unit.unit_label:
                unit.unit_label = unit._generate_label()
                log.debug(f"Unit {unit.id}: Label generated: {unit.unit_label}")
            
            units.append(unit)
        
        return units

    def build_runtime_units(
        self, 
        version: Optional[CalculationVersion] = None,
        account_ids: Optional[List[int]] = None,
    ) -> List[CalculationUnit]:
        """
        Build CalculationUnits from valid transactions.
        
        Account filtering:
        - If account_ids is None or empty: include all transactions
        - If account_ids is provided: filter transactions by account_id at DB level
        
        Args:
            version: Optional CalculationVersion to attach to each unit
            account_ids: Optional list of account IDs to filter by. None or empty means all accounts.
        
        Returns:
            List of CalculationUnit objects ready for P&L processing
        """
        
        # Build base query with eager loading
        query = (
            select(NormalizedTransaction)
            .where(NormalizedTransaction.review_status == "valid")
            .options(
                selectinload(NormalizedTransaction.asset),
                selectinload(NormalizedTransaction.price_quote_asset),
                selectinload(NormalizedTransaction.fee_quote_asset),
                selectinload(NormalizedTransaction.user_calculation_unit),
                selectinload(NormalizedTransaction.from_account),
                selectinload(NormalizedTransaction.to_account),
            )
        )
        
        # Apply account filter at DB level if specified
        if account_ids:
            query = query.where(NormalizedTransaction.account_id.in_(account_ids))
            log.info("applying_account_filter", account_ids=account_ids)
        
        transactions = list(self.session.exec(query).all())
        
        if not transactions:
            log.info("no_transactions_found", account_ids=account_ids)
            return []
        
        log.info("building_runtime_units", transaction_count=len(transactions), account_ids=account_ids)
        
        # Expand all transactions into CalculationUnitLeg objects
        all_legs = expand_transactions(transactions)

        # Aggregate into CalculationUnits
        units = self.aggregate_legs_to_units(all_legs, version=version)
        
        log.info("calculation_units_built", unit_count=len(units), leg_count=len(all_legs))
        return units

    def process_calculation_units(
        self,
        units: List[CalculationUnit],
        version: Optional[CalculationVersion] = None,
    ) -> PnLResult:
        """
        Process a list of calculation units to calculate P&L.

        Args:
            units: List of CalculationUnit objects (sorted chronologically)
            base_version_id: Optional version ID to load prior lots from
            version: Optional pre-created CalculationVersion (for setting relationships)

        Returns:
            PnLResult with all calculation results
        """
        if not version:
            raise ValueError("version is required for P&L calculation")
            
        # Initialize result with version reference
        result = PnLResult(
            config=self.config,
            version=version,
        )

        # Set version on lot_manager so new lots have version relationship
        self.lot_manager.set_version(version)

        # Sort units by earliest transaction timestamp
        # Note: Asset symbols should already be enriched in build_runtime_units()
        sorted_units = sorted(units, key=self._get_earliest_timestamp)

        log.info(
            "calculation_started",
            unit_count=len(sorted_units),
            method=self.config.lot_method.value,
            mode=self.config.lot_mode.value,
            base_currency_id=self.config.base_currency_id,
        )

        # Process each calculation unit
        for idx, unit in enumerate(sorted_units):
            try:
                # Process unit - entities are attached directly to unit relationships
                handle_unit(
                    unit=unit,
                    lot_manager=self.lot_manager,
                    fmv_service=self.fmv_service,
                    config=self.config,
                )
                


            except Exception as e:
                log.exception("unit_processing_failed", unit_id=unit.id, error=str(e))
                # Create warning attached to unit
                warning = PnlWarning(
                    warning_type=WarningType.UNMATCHED_GROUP.value,
                    message=f"Failed to process calculation unit: {str(e)}",
                    unit=unit,
                )
                if unit.warnings is None:
                    unit.warnings = []
                unit.warnings.append(warning)

        log.info(
            "calculation_completed",
            units_processed=len(result.calculation_units),
            realized_entries=len(result.realized_pnl_entries),
            total_pnl=float(result.total_realized_pnl),
            lots_created=len(self.lot_manager.get_all_lots()),
            warnings=len(result.warnings),
        )

        return result
    
    def calculate(self, account_ids: Optional[List[int]] = None) -> PnLResult:
        """
        Complete P&L calculation: build units and process them.
        
        This is the main entry point for P&L calculation. It:
        1. Creates CalculationVersion upfront (for entity relationships)
        2. Builds RuntimeCalculationUnits from valid transactions
        3. Processes them to calculate P&L
        
        Args:
            account_ids: Optional list of account IDs to filter by.
                        If provided, only transactions from these accounts are included.
                        Cross-account transfers are preserved (if ANY leg matches, whole unit included).
                        None means all accounts.
            
        Returns:
            PnLResult with all calculation results, or empty result if no units
        """
        from backend.db.models import CalculationVersion
                # Create CalculationVersion upfront so all entities have version reference
        version = CalculationVersion(
            id=uuid.uuid4(),
            description=f"P&L calculation {datetime.utcnow().isoformat()}",
            method=self.config.lot_method.value,
            lot_mode=self.config.lot_mode.value,
            base_currency_id=self.config.base_currency_id,
            allow_negative_balances=self.config.allow_negative_balances,
            residual_tolerance_pct=self.config.residual_tolerance_pct,
            account_ids=account_ids,  # Store which accounts were included
            status="draft",  # Will be updated on persist
        )
        
        # Add version to session immediately so cascade relationships work during processing
        self.session.add(version)
        self.session.flush()  # Flush to get version_id without committing
        
        # Build calculation units from valid transactions (with optional account filter)
        units = self.build_runtime_units(version=version, account_ids=account_ids)
        
        if not units:
            log.info("no_calculation_units", account_ids=account_ids)
            return PnLResult(config=self.config, version=version)
        
        # Flush units to session before processing so cascade relationships work
        self.session.flush()
        
        log.info("calculation_units_built", unit_count=len(units), account_ids=account_ids)
        
        # Process units with version reference
        return self.process_calculation_units(units, version)

    def _get_earliest_timestamp(self, unit: CalculationUnit) -> datetime:
        """Get earliest transaction timestamp in a calculation unit."""
        if not unit.legs:
            raise ValueError(f"CalculationUnit {unit.id or unit.unit_origin} has no legs")

        timestamps = [leg.date_time for leg in unit.legs if leg.date_time]
        if not timestamps:
            raise ValueError(f"CalculationUnit {unit.id or unit.unit_origin} has no legs with date_time")
        return min(timestamps)

    def persist_results(
        self, 
        result: PnLResult, 
        status: str = "draft",
        expires_in_hours: int = 1,
    ) -> CalculationVersion:
        """
        Persist calculation results to database.
        
        All entities in PnLResult are already SQLModel objects created during
        calculation with version relationships set at creation time.
        Legs are populated on units during aggregate_legs_to_units.

        Args:
            result: PnLResult to persist
            status: Version status - 'draft' (auto-expires) or 'committed' (permanent)
            expires_in_hours: Hours until draft expires (only for draft status)

        Returns:
            Created version ID
        """
        from datetime import timedelta
        
        version = result.version
        if version is None:
            raise ValueError("PnLResult has no version - was calculate() called?")

        # Calculate expiry for drafts
        expires_at = None
        if status == "draft":
            expires_at = datetime.utcnow() + timedelta(hours=expires_in_hours)

        # Update version metadata
        version.status = status
        version.expires_at = expires_at
        
        self.session.add(version)
        self.session.commit()
        
        log.info("results_persisted", version_id=version.version_id, status=status)

        return version
    
    
    def save_draft(self, result: PnLResult, expires_in_hours: int = 1) -> CalculationVersion:
        """
        Save calculation results as a draft (auto-expires).
        
        Args:
            result: PnLResult to persist
            expires_in_hours: Hours until draft expires
            
        Returns:
            Created version ID
        """
        return self.persist_results(result, status="draft", expires_in_hours=expires_in_hours)
    
    def commit_draft(self, version_id: int) -> bool:
        """
        Promote a draft version to committed status.
        
        Args:
            version_id: Draft version ID to commit
            
        Returns:
            True if successful, False if version not found or not a draft
        """
        from backend.db.models import CalculationVersion
        
        version = self.session.get(CalculationVersion, version_id)
        if not version:
            log.warning("version_not_found", version_id=version_id)
            return False
        
        if version.status != "draft":
            log.warning("version_not_draft", version_id=version_id, status=version.status)
            return False
        
        version.status = "committed"
        version.expires_at = None
        self.session.commit()
        
        log.info("draft_committed", version_id=version_id)
        return True
    
    def discard_draft(self, version_id: int) -> bool:
        """
        Delete a draft version and all its data.
        
        Uses cascade delete - deleting the CalculationVersion automatically
        deletes all related child entities (lots, slices, entries, etc.).
        
        Args:
            version_id: Draft version ID to delete
            
        Returns:
            True if successful
        """
        from backend.db.models import CalculationVersion
        
        version = self.session.get(CalculationVersion, version_id)
        if not version:
            return False
        
        # Cascade delete handles all related records automatically
        self.session.delete(version)
        self.session.commit()
        
        log.info("draft_discarded", version_id=version_id)
        return True


    def get_all_lots(self) -> List[Any]:
        """Get all cost lots from lot manager."""
        return self.lot_manager.get_all_lots()

    def reset(self):
        """Reset engine state (clear lots, caches)."""
        self.lot_manager.clear()
        self.fmv_service.clear_cache()
