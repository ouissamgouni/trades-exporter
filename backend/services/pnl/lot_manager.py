"""
Lot Manager - Manages cost lots during P&L calculation.

Uses CostLot and ConsumedLotSlice SQLModel entities directly.
Handles FIFO/LIFO/HIFO ordering and lot consumption.
Supports negative lot settlement when acquisitions arrive after disposals.
"""

from collections import deque
from datetime import datetime
from decimal import Decimal
from typing import Optional, List, Dict, Deque, Tuple, Any

from sqlmodel import Session, select
from sqlalchemy.orm import selectinload
from sqlalchemy import and_

from backend.config.loader import configure_logging
from backend.services.pnl.config import PnLConfig, CostMethod, LotMode
from backend.db.models import (
    Account, CalculationVersion, CostLot, ConsumedLotSlice, LotSettlement, 
    Asset, NormalizedTransaction, CostLotEvent, LotEventType
)


log = configure_logging("pnl_lot_manager")


class LotManager:
    """
    Manages cost lots during P&L calculation.
    Uses CostLot SQLModel entities directly.
    Handles FIFO/LIFO/HIFO ordering and consumption.
    
    Supports negative lot tracking and settlement:
    - When disposal exceeds available lots, creates negative lot
    - When acquisition arrives, settles negative lots first
    - Creates adjustment entries to correct provisional P&L
    """

    def __init__(self, config: PnLConfig):
        self.config = config
        # lots_map[(account_id, asset_id)] -> deque of CostLot
        # For MEGA_WALLET mode, account_id is always None
        self.lots_map: Dict[tuple, Deque[CostLot]] = {}
        # Separate tracking for negative lots (for efficient settlement lookup)
        self.negative_lots_map: Dict[tuple, List[CostLot]] = {}
        # Version reference for setting relationships on created entities
        self._version: Optional[CalculationVersion] = None
    
    def set_version(self, version: CalculationVersion) -> None:
        """Set the version reference for new entities.
        
        All entities created after this will have their version relationship set.
        """
        self._version = version

    def _emit_event(
        self,
        event_type: LotEventType,
        lot: CostLot,
        quantity_delta: Decimal,
        cost_basis_delta: Optional[Decimal] = None,
        related_lot: Optional[CostLot] = None,
        triggered_by_transaction: Optional[NormalizedTransaction] = None,
        triggered_by_unit: Optional[Any] = None,
        metadata: Optional[dict] = None,
    ) -> CostLotEvent:
        """
        Emit a cost lot event for audit trail.
        
        Args:
            event_type: Type of event (created, consumed, settled, etc.)
            lot: The primary lot affected
            quantity_delta: Change in quantity (positive=increase, negative=decrease)
            cost_basis_delta: Change in cost basis (optional)
            related_lot: Related lot (for settlements/transfers)
            triggered_by_transaction: Transaction that triggered this event (REQUIRED)
            triggered_by_unit: Calculation unit context (REQUIRED)
            metadata: Additional event-specific data
            
        Returns:
            Created CostLotEvent entity
            
        Raises:
            ValueError: If triggered_by_transaction or triggered_by_unit is None
        """
        # Enforce mandatory context for audit trail integrity
        if triggered_by_transaction is None:
            raise ValueError(
                f"triggered_by_transaction is required for {event_type.value} event on lot #{lot.cost_lot_id}. "
                "All lot events must be traceable to a source transaction."
            )
        if triggered_by_unit is None:
            raise ValueError(
                f"triggered_by_unit is required for {event_type.value} event on lot #{lot.cost_lot_id}. "
                "All lot events must be associated with a calculation unit."
            )
        
        # Compute balances after this event
        # Asset-level balance (across all accounts)
        balance_after = self.get_asset_balance(asset_id=lot.asset_id)
        # Account-level balance (for this specific account)
        account_balance_after = self.get_balance(account_id=lot.account_id, asset_id=lot.asset_id)
        
        # Use transaction datetime for event timestamp (economic time, not system time)
        event_timestamp = triggered_by_transaction.date_time if triggered_by_transaction and triggered_by_transaction.date_time else datetime.utcnow()
        
        event = CostLotEvent(
            event_type=event_type.value,
            lot=lot,
            related_lot=related_lot,
            quantity_delta=quantity_delta,
            cost_basis_delta=cost_basis_delta,
            qty_remaining_after=lot.qty_remaining,
            cost_basis_remaining_after=lot.remaining_cost_in_base,
            balance_after=balance_after,
            account_balance_after=account_balance_after,
            triggered_by_transaction=triggered_by_transaction,
            triggered_by_transaction_id=triggered_by_transaction.id if triggered_by_transaction else None,
            triggered_by_unit=triggered_by_unit,
            triggered_by_unit_id=triggered_by_unit.id if triggered_by_unit else None,
            event_metadata=metadata,
            timestamp=event_timestamp,
        )
        
        # Note: Setting lot=lot in constructor auto-populates lot.events via SQLAlchemy back_populates
        # No need to manually append - the ORM handles the bidirectional relationship
        
        log.debug(
            "lot_event_emitted",
            event_type=event_type.value,
            lot_id=lot.cost_lot_id,
            qty_delta=float(quantity_delta),
            cost_delta=float(cost_basis_delta) if cost_basis_delta else None,
        )
        
        return event

    def _get_key(self, account_id: Optional[int], asset_id: int) -> tuple:
        """Get the key for lots_map based on lot mode."""
        if self.config.lot_mode == LotMode.MEGA_WALLET:
            return (None, asset_id)
        return (account_id, asset_id)

    def get_lots(self, account_id: Optional[int], asset_id: int) -> Deque[CostLot]:
        """Get lots for account/asset. Creates empty deque if not exists."""
        key = self._get_key(account_id, asset_id)
        if key not in self.lots_map:
            self.lots_map[key] = deque()
        return self.lots_map[key]

    def add_lot(
        self,
        lot: CostLot,
        triggered_by_transaction: Optional[NormalizedTransaction] = None,
        triggered_by_unit: Optional[Any] = None,
        emit_event: bool = True,
    ):
        """
        Add a new lot, maintaining proper ordering for the cost method.
        Emits LOT_CREATED event for audit trail (unless emit_event=False).

        For FIFO: append to end (oldest first)
        For LIFO: insert at beginning (newest first)
        For HIFO: insert sorted by unit_cost descending
        
        Note: Negative lots are tracked separately and don't participate in normal consumption.
        They are "filled" when new inflows arrive for the same asset.
        
        Args:
            lot: CostLot to add
            triggered_by_transaction: Transaction that triggered this lot creation
            triggered_by_unit: Calculation unit context
            emit_event: Whether to emit LOT_CREATED event (False for reloaded lots)
        """
        key = self._get_key(lot.account_id, lot.asset_id)
        
        # Track negative lots separately
        if lot.is_negative:
            if key not in self.negative_lots_map:
                self.negative_lots_map[key] = []
            self.negative_lots_map[key].append(lot)
            log.debug(
                "negative_lot_tracked",
                asset_id=lot.asset_id,
                account_id=lot.account_id,
                qty=float(lot.qty),
                lot_id=lot.cost_lot_id,
            )
            # Emit creation event for negative lot (unless reloading from DB)
            if emit_event:
                self._emit_event(
                    event_type=LotEventType.CREATED,
                    lot=lot,
                    quantity_delta=lot.qty,  # Negative
                    cost_basis_delta=Decimal("0"),
                    triggered_by_transaction=triggered_by_transaction,
                    triggered_by_unit=triggered_by_unit,
                    metadata={"is_negative": True, "provisional": True},
                )
            return
        
        if key not in self.lots_map:
            self.lots_map[key] = deque()

        lots = self.lots_map[key]

        if self.config.lot_method == CostMethod.FIFO:
            lots.append(lot)
        elif self.config.lot_method == CostMethod.LIFO:
            lots.appendleft(lot)
        elif self.config.lot_method == CostMethod.HIFO:
            # Insert in position to maintain descending unit cost order
            inserted = False
            for i, existing in enumerate(lots):
                if lot.unit_cost > existing.unit_cost:
                    lots.insert(i, lot)
                    inserted = True
                    break
            if not inserted:
                lots.append(lot)

        log.debug(
            "lot_created",
            asset=lot.asset,
            account_id=lot.account_id,
            qty=float(lot.qty),
            unit_cost=float(lot.unit_cost_in_base),
            acquired_at=str(lot.acquired_at),
            is_negative=lot.is_negative,
            origin_tx=lot.origin_transaction_id,
            unit_id=lot.unit_id,
            method=self.config.lot_method.value,
        )
        
        # Emit creation event for positive lot (unless reloading from DB)
        if emit_event:
            self._emit_event(
                event_type=LotEventType.CREATED,
                lot=lot,
                quantity_delta=lot.qty,
                cost_basis_delta=lot.total_cost_in_base,
                triggered_by_transaction=triggered_by_transaction,
                triggered_by_unit=triggered_by_unit,
                metadata={"method": self.config.lot_method.value},
            )

    def load_from_db(
        self,
        session: Session,
        version_id: int,
        account_ids: Optional[List[int]] = None,
    ):
        """
        Load existing open lots from database for a given version.

        Args:
            session: Database session
            version_id: Version ID to load lots from
            account_ids: Optional list of account IDs to filter by
        """
        statement = (
            select(CostLot)
            .where(
                CostLot.version_id == version_id,
                CostLot.qty_remaining > 0,
            )
            .options(selectinload(CostLot.asset))
        )
        if account_ids:
            statement = statement.where(CostLot.account_id.in_(account_ids))

        db_lots = session.exec(statement).all()

        for db_lot in db_lots:
            # CostLot is already a SQLModel entity, use directly
            # emit_event=False because loaded lots already have persisted events
            self.add_lot(db_lot, emit_event=False)

        log.info(
            event="lots_loaded",
            version_id=version_id,
            count=len(db_lots),
            accounts=account_ids or "all",
        )

    def consume_lots(
        self,
        account_id: Optional[int],
        asset_id: int,
        asset_symbol: str,
        qty: Decimal,
        allow_negative: bool = False,
        triggered_by_transaction: Optional[NormalizedTransaction] = None,
        triggered_by_unit: Optional[Any] = None,
        emit_event: bool = True,
    ) -> Tuple[List[ConsumedLotSlice], Optional[CostLot]]:
        """
        Consume lots for a disposal.

        Args:
            account_id: Account ID (ignored in MEGA_WALLET mode)
            asset_id: Asset ID to consume
            asset_symbol: Asset symbol (for logging and new lots)
            qty: Quantity to consume
            allow_negative: Whether to create negative lot if insufficient
            triggered_by_transaction: Transaction that triggered this consumption (required if emit_event=True)
            triggered_by_unit: Calculation unit context (required if emit_event=True)
            emit_event: Whether to emit CONSUMED events (False for testing)

        Returns:
            Tuple of (consumed_slices, negative_lot if created)

        Raises:
            ValueError: If insufficient lots and allow_negative is False
        """
        lots = self.get_lots(account_id, asset_id)
        slices: List[ConsumedLotSlice] = []
        remaining_qty = qty
        negative_lot: Optional[CostLot] = None
        is_provisional = False  # Track if P&L will be provisional

        # Consume from lots in order (FIFO/LIFO/HIFO ordering maintained by add_lot)
        while remaining_qty > 0 and lots:
            lot = lots[0]
            if lot.qty_remaining <= 0 or lot.is_negative:
                lots.popleft()
                continue

            consume_qty = min(remaining_qty, lot.qty_remaining)
            slice_record = lot.consume(consume_qty)
            slices.append(slice_record)
            remaining_qty -= consume_qty

            log.debug(
                "lot_consumed",
                lot_id=lot.cost_lot_id,
                asset_id=asset_id,
                asset_symbol=asset_symbol,
                consumed_qty=float(consume_qty),
                remaining_qty=float(lot.qty_remaining),
                slice_cost=float(slice_record.total_cost_in_base),
                unit_cost=float(slice_record.unit_cost_in_base),
            )
            
            # Emit consumption event (unless disabled for testing)
            if emit_event:
                self._emit_event(
                    event_type=LotEventType.CONSUMED,
                    lot=lot,
                    quantity_delta=-consume_qty,
                    cost_basis_delta=-slice_record.total_cost_in_base,
                    triggered_by_transaction=triggered_by_transaction,
                    triggered_by_unit=triggered_by_unit,
                )

            # Remove exhausted lot from front
            if lot.qty_remaining <= 0:
                lots.popleft()
                log.debug("lot_exhausted", lot_id=lot.cost_lot_id, asset_id=asset_id)

        # Handle shortfall
        if remaining_qty > 0:
            if allow_negative:
                # For base currency, unit_cost is always 1
                is_base_currency = asset_id == self.config.base_currency_id
                unit_cost = Decimal("1") if is_base_currency else Decimal("0")
                
                # Create negative lot to track the shortfall
                # This will be settled when a later acquisition arrives
                # Both qty and qty_remaining are negative to indicate debt
                negative_lot = CostLot(
                    version=self._version,
                    asset_id=asset_id,
                    account_id=(
                        account_id
                        if self.config.lot_mode == LotMode.LOT_TRAVEL
                        else None
                    ),
                    qty=-remaining_qty,  # Negative qty indicates debt
                    qty_remaining=-remaining_qty,  # Negative - amount of debt outstanding
                    unit_cost=unit_cost,
                    acquired_at=triggered_by_transaction.date_time if triggered_by_transaction and triggered_by_transaction.date_time else datetime.utcnow(),
                    is_zero_cost=not is_base_currency,
                    is_negative=True,
                    is_settled=False,  # Will be settled by later acquisition
                    notes="Negative lot - provisional cost basis until settled",
                )
                # Set version relationship at creation time
                is_provisional = True
                
                # Add negative lot to the separate tracking map
                self.add_lot(
                    negative_lot,
                    triggered_by_transaction=triggered_by_transaction,
                    triggered_by_unit=triggered_by_unit,
                    emit_event=emit_event,
                )
                
                log.warning(
                    "negative_lot_created",
                    asset_id=asset_id,
                    asset_symbol=asset_symbol,
                    account_id=account_id,
                    shortfall_qty=float(remaining_qty),
                    unit_cost=float(unit_cost),
                    lot_id=negative_lot.cost_lot_id,
                )
                # Add slice for the negative portion
                neg_slice = ConsumedLotSlice(
                    quantity=remaining_qty,
                    unit_cost_in_base=unit_cost,
                    total_cost_in_base=remaining_qty * unit_cost,
                    acquired_at=negative_lot.acquired_at,
                )
                # Set cost_lot relationship at creation
                neg_slice.cost_lot = negative_lot
                slices.append(neg_slice)
                
                # Emit CONSUMED event for negative lot slice (provisional consumption)
                if emit_event:
                    self._emit_event(
                        event_type=LotEventType.CONSUMED,
                        lot=negative_lot,
                        quantity_delta=-remaining_qty,
                        cost_basis_delta=-neg_slice.total_cost_in_base,
                        triggered_by_transaction=triggered_by_transaction,
                        triggered_by_unit=triggered_by_unit,
                        metadata={"is_negative_lot": True, "provisional": True},
                    )
            else:
                raise ValueError(
                    f"Insufficient lots for asset {asset_id} ({asset_symbol}): "
                    f"needed {qty}, have {qty - remaining_qty}"
                )

        return slices, negative_lot

    def get_balance(self, account_id: Optional[int], asset_id: int) -> Decimal:
        """
        Get net balance for account/asset (positive lots - unsettled negative lots).
        """
        key = self._get_key(account_id, asset_id)
        
        # Positive balance from regular lots
        positive_lots = self.lots_map.get(key, deque())
        positive_balance = sum(lot.qty_remaining for lot in positive_lots if not lot.is_negative)
        
        # Negative balance from unsettled negative lots
        negative_lots = self.negative_lots_map.get(key, [])
        negative_balance = sum(
            abs(lot.qty) for lot in negative_lots 
            if not lot.is_settled
        )
        
        return positive_balance - negative_balance
    
    def get_asset_balance(self, asset_id: int) -> Decimal:
        """
        Get total balance for an asset across all accounts.
        In MEGA_WALLET mode, this is the same as get_balance(None, asset_id).
        In LOT_TRAVEL mode, this sums balances across all accounts.
        """
        if self.config.lot_mode == LotMode.MEGA_WALLET:
            return self.get_balance(None, asset_id)
        
        # LOT_TRAVEL mode: sum across all accounts for this asset
        total_balance = Decimal("0")
        
        # Sum positive lots across all accounts
        for key, lots in self.lots_map.items():
            _, key_asset_id = key
            if key_asset_id == asset_id:
                total_balance += sum(lot.qty_remaining for lot in lots if not lot.is_negative)
        
        # Subtract unsettled negative lots across all accounts
        for key, neg_lots in self.negative_lots_map.items():
            _, key_asset_id = key
            if key_asset_id == asset_id:
                total_balance -= sum(abs(lot.qty) for lot in neg_lots if not lot.is_settled)
        
        return total_balance

    def get_cost_basis(self, account_id: Optional[int], asset_id: int) -> Decimal:
        """Get total remaining cost basis for account/asset."""
        lots = self.get_lots(account_id, asset_id)
        return sum(lot.cost_remaining_in_base for lot in lots if not lot.is_negative)

    def get_unsettled_negative_lots(
        self,
        account_id: Optional[int],
        asset_id: int,
    ) -> List[CostLot]:
        """Get unsettled negative lots for account/asset."""
        key = self._get_key(account_id, asset_id)
        negative_lots = self.negative_lots_map.get(key, [])
        return [lot for lot in negative_lots if not lot.is_settled]

    def settle_negative_lots(
        self,
        account: Optional[Account],
        asset: Asset,
        available_qty: Decimal,
        unit_cost: Decimal,
        settling_transaction: Optional[NormalizedTransaction] = None,
        settling_lot: Optional[CostLot] = None,
        triggered_by_unit: Optional[Any] = None,
        emit_event: bool = True,
    ) -> Tuple[Decimal, List[LotSettlement]]:
        """
        Settle negative lots with a new acquisition's cost basis.
        
        When an acquisition arrives, it first "fills" any negative lots for the
        same asset, applying its cost basis to correct provisional P&L entries.
        
        Key Design:
        - A positive lot is ALWAYS created for the inflow (caller's responsibility)
        - Settlement records link negative lots to the settling positive lot
        - Both qty_remaining are updated for correct balance calculation
        
        Args:
            account: Account object (None in MEGA_WALLET mode)
            asset: Asset object being settled
            available_qty: Quantity from new acquisition
            unit_cost: Unit cost of new acquisition
            settling_transaction: Transaction that triggered settlement
            settling_lot: CostLot entity for relationship setting (required)
            triggered_by_unit: Calculation unit context (required if emit_event=True)
            emit_event: Whether to emit SETTLED events (False for testing)
            
        Returns:
            (remaining_qty, settlement_records)
        """
        account_id = account.id if account else None
        asset_id = asset.asset_id
        asset_symbol = asset.symbol or f"#{asset_id}"
        
        key = self._get_key(account_id, asset_id)
        negative_lots = self.negative_lots_map.get(key, [])
        settlement_records: List[LotSettlement] = []
        remaining_qty = available_qty
        
        for neg_lot in negative_lots:
            if remaining_qty <= 0:
                break
            if neg_lot.is_settled:
                continue
            
            # For negative lots, qty_remaining is negative (e.g., -2.0 means we owe 2 units)
            # abs() to get the unsettled amount
            unsettled_qty = abs(neg_lot.qty_remaining)
            if unsettled_qty <= 0:
                continue
            
            settle_qty = min(remaining_qty, unsettled_qty)
            cost_applied = settle_qty * unit_cost
            
            # Update negative lot - increase qty_remaining (reduce debt, move toward 0)
            neg_lot.qty_remaining += settle_qty
            
            # Track cost basis applied
            if neg_lot.settled_cost_in_base is None:
                neg_lot.settled_cost_in_base = Decimal("0")
            neg_lot.settled_cost_in_base += cost_applied
            
            # Check if fully settled (qty_remaining == 0)
            if neg_lot.qty_remaining >= 0:
                neg_lot.is_settled = True
                neg_lot.settled_by_lot_id = settling_lot.cost_lot_id if settling_lot else None
            
            # Create settlement record with relationships set
            # Set both FK IDs and relationship objects (IDs needed for runtime access,
            # relationship objects needed for persistence when objects aren't yet persisted)
            settlement = LotSettlement(
                # Negative lot
                negative_lot=neg_lot,
                # Settling lot
                settling_lot=settling_lot,
                # Settling transaction
                settling_transaction=settling_transaction,
                settling_transaction_id=settling_transaction.id if settling_transaction else None,
                # Settlement details
                qty_settled=settle_qty,
                settled_at=datetime.utcnow(),
                cost_basis_applied=cost_applied,
            )

            settlement_records.append(settlement)
            
            # Emit settlement event (unless disabled for testing)
            if emit_event:
                self._emit_event(
                    event_type=LotEventType.SETTLED,
                    lot=neg_lot,
                    quantity_delta=settle_qty,
                    cost_basis_delta=cost_applied,
                    related_lot=settling_lot,
                    triggered_by_transaction=settling_transaction,
                    triggered_by_unit=triggered_by_unit,
                    metadata={
                        "settlement_id": settlement.settlement_id,
                        "is_fully_settled": neg_lot.is_settled,
                    },
                )
            
            remaining_qty -= settle_qty
            
            log.info(
                "negative_lot_settled",
                lot_id=neg_lot.cost_lot_id,
                qty_settled=float(settle_qty),
                cost_applied=float(cost_applied),
                is_fully_settled=neg_lot.is_settled,
                settling_tx=settling_transaction.id if settling_transaction else None,
            )
        
        return remaining_qty, settlement_records

    def get_all_lots(self) -> List[CostLot]:
        """Get all lots including negative lots (for persistence)."""
        all_lots: List[CostLot] = []
        for lots in self.lots_map.values():
            all_lots.extend(lots)
        for lots in self.negative_lots_map.values():
            all_lots.extend(lots)
        return all_lots

    def clear(self):
        """Clear all lots (for testing)."""
        self.lots_map.clear()
        self.negative_lots_map.clear()
