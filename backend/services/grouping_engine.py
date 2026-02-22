"""
Transaction Grouping Engine - Suggests logical groupings for ungrouped transactions.

This engine analyzes ungrouped transactions and suggests CalculationUnit groupings:
- Rule 1: Network TX ID match (transfer with exact hash match)
- Rule 2: Same asset transfer between owned accounts
- Rule 3: Same source_transaction_id grouping (swap detection)
- Rule 4: Swap detection (different assets, same account, short time window)
- Rule 4b: Split detection (same asset, different quantities, same total value)
- Rule 5: Bridge detection (same asset, different accounts)
- Rule 5b: Same-account cross-chain bridge (same asset, same account, different networks)
- Rule 6: Catch-all for remaining ungrouped transactions

Returns GroupingSuggestion objects that can be converted to CalculationUnit for persistence.
"""

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import List, Dict, Any, Optional, Set, TYPE_CHECKING

from backend.config.loader import configure_logging, load_settings
from backend.db.models import CalculationUnit, UnitPattern, NormalizedTransaction

log = configure_logging("grouping_engine")


# Pattern constants (use UnitPattern values)
PATTERN_INTERNAL_TRANSFER = UnitPattern.INTERNAL_TRANSFER.value
PATTERN_SWAP = UnitPattern.SWAP.value
PATTERN_UNKNOWN = UnitPattern.UNKNOWN.value


@dataclass
class GroupingConfig:
    """Configuration for the grouping engine."""

    # Time windows (in seconds)
    transfer_time_window: int = 300  # 5 minutes
    swap_time_window: int = 60  # 1 minute
    bridge_time_window: int = 300  # 5 minutes

    # Tolerances
    quantity_tolerance: float = 0.05  # 5% tolerance for quantity matching
    value_tolerance: float = 0.10  # 10% tolerance for value matching

    # Confidence thresholds
    exact_match_confidence: float = 1.0
    high_confidence: float = 0.95
    medium_confidence: float = 0.85
    low_confidence: float = 0.70

    @classmethod
    def from_settings(cls) -> "GroupingConfig":
        """Load configuration from settings.yaml."""
        settings = load_settings()
        config_dict = settings.get("grouping_engine", {})

        return cls(
            transfer_time_window=config_dict.get("transfer_time_window", 300),
            swap_time_window=config_dict.get("swap_time_window", 60),
            bridge_time_window=config_dict.get("bridge_time_window", 300),
            quantity_tolerance=config_dict.get("quantity_tolerance", 0.05),
            value_tolerance=config_dict.get("value_tolerance", 0.10),
            exact_match_confidence=config_dict.get("exact_match_confidence", 1.0),
            high_confidence=config_dict.get("high_confidence", 0.95),
            medium_confidence=config_dict.get("medium_confidence", 0.85),
            low_confidence=config_dict.get("low_confidence", 0.70),
        )


@dataclass
class GroupingSuggestion:
    """
    Grouping suggestion result.
    
    Can be converted to CalculationUnit (DB model) for persistence.
    """
    
    pattern: str  # transfer, swap, unknown (uses UnitPattern values)
    label: str
    reason: str
    confidence: float
    transactions: List[Dict[str, Any]] = field(default_factory=list)
    
    @property
    def transaction_ids(self) -> List[int]:
        """Get transaction IDs from transactions list."""
        return [tx["id"] for tx in self.transactions]
    



class GroupingEngine:
    """
    Engine for suggesting transaction groupings.

    Analyzes ungrouped transactions and applies rules to suggest logical groups.
    Returns GroupingSuggestion objects that can be converted to CalculationUnit.
    """

    def __init__(self, config: Optional[GroupingConfig] = None):
        self.config = config or GroupingConfig()
        self._used_tx_ids: Set[int] = set()

    def suggest_groups(
        self, transactions: List[NormalizedTransaction]
    ) -> List[GroupingSuggestion]:
        """
        Analyze transactions and suggest groupings.

        Rules are applied in priority order:
        1. Network TX ID exact match (highest confidence)
        2. Same asset transfer between accounts
        3. Same source_transaction_id grouping
        4. Swap detection (different assets, same account)
        4b. Split detection (same asset, different qty, same value)
        5. Bridge detection (same asset, different chains/accounts)
        5b. Same-account cross-chain bridge (same asset, same account, different networks)
        6. Catch-all for remaining transactions

        Args:
            transactions: List of ungrouped NormalizedTransaction to analyze

        Returns:
            List of GroupingSuggestion objects
        """
        self._used_tx_ids = set()
        suggestions: List[GroupingSuggestion] = []

        # Separate inflows and outflows
        inflows = [tx for tx in transactions if tx.direction == "inflow"]
        outflows = [tx for tx in transactions if tx.direction == "outflow"]

        # Rule 1: Network TX ID exact match
        suggestions.extend(self._rule1_network_tx_match(outflows, inflows))

        # Rule 4b: Split detection (same asset, different qty, same value)
        suggestions.extend(self._rule4b_split_detection(outflows, inflows))

        # Rule 3: Same source_transaction_id grouping
        suggestions.extend(self._rule3_same_source_tx_id(transactions))

        # Rule 2: Same asset transfer between owned accounts
        suggestions.extend(self._rule2_same_asset_transfer(outflows, inflows))

    
        # Rule 4: Swap detection
        suggestions.extend(self._rule4_swap_detection(outflows, inflows))


        # Rule 5b: Same-account cross-chain bridge (higher priority - more specific match)
        suggestions.extend(self._rule5b_same_account_bridge(outflows, inflows))

        # Rule 5: Bridge detection (different accounts)
        suggestions.extend(self._rule5_bridge_detection(outflows, inflows))

        # Rule 6: Catch-all for remaining ungrouped
        remaining = [tx for tx in transactions if tx.id not in self._used_tx_ids]
        if remaining:
            suggestions.append(self._rule6_review_group(remaining))

        # Sort by confidence (highest first)
        suggestions.sort(key=lambda x: x.confidence, reverse=True)

        return suggestions

    def _rule1_network_tx_match(
        self, outflows: List[NormalizedTransaction], inflows: List[NormalizedTransaction]
    ) -> List[GroupingSuggestion]:
        """
        Rule 1: If outflow has network_transaction_id, find inflow where
        source_transaction_id == network_transaction_id.

        This indicates a direct on-chain transfer where the receiving side
        references the same transaction hash.

        Confidence: 1.0 (exact hash match)
        """
        suggestions = []

        for outflow in outflows:
            if outflow.id in self._used_tx_ids:
                continue
            if not outflow.network_transaction_id:
                continue

            # Find matching inflow by source_transaction_id
            for inflow in inflows:
                if inflow.id in self._used_tx_ids:
                    continue
                if inflow.source_transaction_id == outflow.network_transaction_id:
                    # Found exact match
                    self._used_tx_ids.add(outflow.id)
                    self._used_tx_ids.add(inflow.id)

                    symbol = outflow.source_asset_symbol or inflow.source_asset_symbol
                    suggestions.append(
                        GroupingSuggestion(
                            pattern=PATTERN_INTERNAL_TRANSFER,
                            label=f"{symbol} Transfer",
                            reason=f"Exact network TX hash match: outflow.network_tx_id == inflow.source_tx_id",
                            confidence=self.config.exact_match_confidence,
                            transactions=[
                                self._make_tx_summary(outflow),
                                self._make_tx_summary(inflow),
                            ],
                        )
                    )
                    break

        return suggestions

    def _rule2_same_asset_transfer(
        self, outflows: List[NormalizedTransaction], inflows: List[NormalizedTransaction]
    ) -> List[GroupingSuggestion]:
        """
        Rule 2: Same asset transfer between owned accounts.

        Conditions:
        - outflow.asset_id == inflow.asset_id (or same canonical symbol)
        - inflow.account_id != outflow.account_id
        - inflow.account_id == outflow.to_account_id
        - |qty_out - qty_in| / qty_out <= tolerance
        - time difference <= configurable window

        Confidence: 0.8-0.95 depending on quantity closeness
        """
        suggestions = []

        for outflow in outflows:
            if outflow.id in self._used_tx_ids:
                continue

            for inflow in inflows:
                if inflow.id in self._used_tx_ids:
                    continue

                # Check asset match
                if not self._assets_match(outflow, inflow):
                    continue

                # Check different accounts
                if outflow.account_id == inflow.account_id:
                    continue

                # Check inflow.account == outflow.to_account
                if (
                    outflow.to_account_id is None
                    or inflow.account_id != outflow.to_account_id
                ):
                    continue

                # Check time window
                time_diff = abs((inflow.date_time - outflow.date_time).total_seconds())
                if time_diff > self.config.transfer_time_window:
                    continue

                # Check quantity tolerance
                qty_ratio = self._quantity_diff_ratio(outflow.quantity, inflow.quantity)
                if qty_ratio > self.config.quantity_tolerance:
                    continue

                # Calculate confidence based on quantity closeness
                confidence = self._calculate_transfer_confidence(qty_ratio, time_diff)

                self._used_tx_ids.add(outflow.id)
                self._used_tx_ids.add(inflow.id)

                symbol = outflow.source_asset_symbol or inflow.source_asset_symbol
                suggestions.append(
                    GroupingSuggestion(
                        pattern=PATTERN_INTERNAL_TRANSFER,
                        label=f"{symbol} Transfer",
                        reason=f"Same asset transfer between owned accounts (qty diff: {qty_ratio:.2%}, time: {time_diff:.0f}s)",
                        confidence=confidence,
                        transactions=[
                            self._make_tx_summary(outflow),
                            self._make_tx_summary(inflow),
                        ],
                    )
                )
                break

        return suggestions

    def _rule3_same_source_tx_id(
        self, transactions: List[NormalizedTransaction]
    ) -> List[GroupingSuggestion]:
        """
        Rule 3: Group all transactions with same source_transaction_id.

        If exactly 1 inflow + 1 outflow → suggest "swap"
        Otherwise → suggest generic group for review

        Confidence: 0.9 for swap, 0.8 for other groupings
        """
        suggestions = []

        # Group by source_transaction_id
        by_source_tx: Dict[str, List[NormalizedTransaction]] = {}
        for tx in transactions:
            if tx.id in self._used_tx_ids:
                continue
            if not tx.source_transaction_id:
                continue

            if tx.source_transaction_id not in by_source_tx:
                by_source_tx[tx.source_transaction_id] = []
            by_source_tx[tx.source_transaction_id].append(tx)

        for source_tx_id, group_txs in by_source_tx.items():
            if len(group_txs) < 2:
                continue

            # Check if already used
            if any(tx.id in self._used_tx_ids for tx in group_txs):
                continue

            inflows = [tx for tx in group_txs if tx.direction == "inflow"]
            outflows = [tx for tx in group_txs if tx.direction == "outflow"]

            # Mark all as used
            for tx in group_txs:
                self._used_tx_ids.add(tx.id)

            if len(inflows) == 1 and len(outflows) == 1:
                # Exactly 1 in + 1 out = swap
                in_symbol = inflows[0].source_asset_symbol
                out_symbol = outflows[0].source_asset_symbol
                suggestions.append(
                    GroupingSuggestion(
                        pattern=PATTERN_SWAP,
                        label=f"{out_symbol} → {in_symbol} Swap",
                        reason=f"Same source_transaction_id with 1 inflow + 1 outflow",
                        confidence=0.9,
                        transactions=[self._make_tx_summary(tx) for tx in group_txs],
                    )
                )
            else:
                # Multiple transactions with same source_tx_id
                symbols = set(tx.source_asset_symbol for tx in group_txs)
                suggestions.append(
                    GroupingSuggestion(
                        pattern=PATTERN_SWAP,
                        label=f"Multi-leg Trade ({', '.join(symbols)})",
                        reason=f"Multiple transactions with same source_transaction_id ({len(inflows)} in, {len(outflows)} out)",
                        confidence=0.8,
                        transactions=[self._make_tx_summary(tx) for tx in group_txs],
                    )
                )

        return suggestions

    def _rule4_swap_detection(
        self, outflows: List[NormalizedTransaction], inflows: List[NormalizedTransaction]
    ) -> List[GroupingSuggestion]:
        """
        Rule 4: Swap detection for different assets on same account.

        Conditions:
        - inflow.account_id == outflow.account_id
        - asset_out != asset_in (different canonical assets)
        - time difference <= 1 minute (configurable)

        Confidence:
        - Value match (total diff <= 10%) = 0.9
        - Only time match = 0.7
        """
        suggestions = []

        for outflow in outflows:
            if outflow.id in self._used_tx_ids:
                continue

            for inflow in inflows:
                if inflow.id in self._used_tx_ids:
                    continue

                # Must be same account
                if outflow.account_id != inflow.account_id:
                    continue

                # Must be different assets
                if self._assets_match(outflow, inflow):
                    continue

                # Check time window
                time_diff = abs((inflow.date_time - outflow.date_time).total_seconds())
                if time_diff > self.config.swap_time_window:
                    continue

                # Calculate confidence based on value match
                confidence = self._calculate_swap_confidence(outflow, inflow)

                self._used_tx_ids.add(outflow.id)
                self._used_tx_ids.add(inflow.id)

                suggestions.append(
                    GroupingSuggestion(
                        pattern=PATTERN_SWAP,
                        label=f"{outflow.source_asset_symbol} → {inflow.source_asset_symbol} Swap",
                        reason=f"Different assets exchanged on same account within {time_diff:.0f}s",
                        confidence=confidence,
                        transactions=[
                            self._make_tx_summary(outflow),
                            self._make_tx_summary(inflow),
                        ],
                    )
                )
                break

        return suggestions

    def _rule4b_split_detection(
        self, outflows: List[NormalizedTransaction], inflows: List[NormalizedTransaction]
    ) -> List[GroupingSuggestion]:
        """
        Rule 4b: Split detection - same asset with different quantities but same total value.

        This detects stock/crypto splits where you receive a different quantity of the
        same asset (e.g., 2-for-1 split: send 100 shares, receive 200 shares, same total value).

        Conditions:
        - Same asset (asset_id or symbol match)
        - Same account
        - 1 outflow + 1 inflow
        - Different quantities
        - Same total value (within tolerance)
        - Time difference <= swap_time_window

        Pattern: SWAP (P&L handles splits as swaps - non-taxable same-asset exchange)
        Confidence: 0.85-0.90 depending on value match closeness
        """
        suggestions = []

        for outflow in outflows:
            if outflow.id in self._used_tx_ids:
                continue

            for inflow in inflows:
                if inflow.id in self._used_tx_ids:
                    continue

                # Must be same account
                if outflow.account_id != inflow.account_id:
                    continue

                # Must be same asset
                if not self._assets_match(outflow, inflow):
                    continue

                # Must have different quantities (otherwise it's a transfer, not a split)
                if outflow.quantity == inflow.quantity:
                    continue

                # Check time window (use swap_time_window)
                time_diff = abs((inflow.date_time - outflow.date_time).total_seconds())
                if time_diff > self.config.swap_time_window:
                    continue

                # Must have same total value (qty * unit_price) within tolerance
                if not outflow.total or not inflow.total:
                    continue

                out_val = float(outflow.total)
                in_val = float(inflow.total)

                if out_val == 0:
                    continue

                value_diff = abs(out_val - in_val) / out_val
                if value_diff > self.config.value_tolerance:
                    continue

                # Calculate confidence based on value match closeness
                confidence = 0.90 - (value_diff * 0.5)
                confidence = max(self.config.medium_confidence, confidence)

                self._used_tx_ids.add(outflow.id)
                self._used_tx_ids.add(inflow.id)

                # Determine split ratio for label
                out_qty = float(outflow.quantity)
                in_qty = float(inflow.quantity)
                if out_qty > 0 and in_qty > 0:
                    if in_qty > out_qty:
                        ratio = in_qty / out_qty
                        label = f"{outflow.source_asset_symbol} Split ({ratio:.2g}:1)"
                    else:
                        ratio = out_qty / in_qty
                        label = f"{outflow.source_asset_symbol} Reverse Split (1:{ratio:.2g})"
                else:
                    label = f"{outflow.source_asset_symbol} Split"

                suggestions.append(
                    GroupingSuggestion(
                        pattern=PATTERN_SWAP,  # Reuse swap pattern for P&L compatibility
                        label=label,
                        reason=f"Same asset with different quantities but same total value (qty: {out_qty:.4g} → {in_qty:.4g}, value diff: {value_diff:.2%})",
                        confidence=confidence,
                        transactions=[
                            self._make_tx_summary(outflow),
                            self._make_tx_summary(inflow),
                        ],
                    )
                )
                break

        return suggestions

    def _rule5_bridge_detection(
        self, outflows: List[NormalizedTransaction], inflows: List[NormalizedTransaction]
    ) -> List[GroupingSuggestion]:
        """
        Rule 5: Bridge detection for same asset across different chains/accounts.
        
        Bridges are treated as TRANSFERS (same asset, non-taxable).

        Conditions:
        - outflow.asset_id == inflow.asset_id
        - inflow.account_id != outflow.account_id
        - inflow.account_id != outflow.to_account_id (NOT a direct transfer)
        - |qty_out - qty_in| / qty_out <= tolerance
        - time difference <= configurable window

        This catches cross-chain bridges where the destination is a new account
        not previously linked to the outflow.

        Confidence: 0.8-0.95 depending on closeness
        """
        suggestions = []

        for outflow in outflows:
            if outflow.id in self._used_tx_ids:
                continue

            for inflow in inflows:
                if inflow.id in self._used_tx_ids:
                    continue

                # Check asset match
                if not self._assets_match(outflow, inflow):
                    continue

                # Must be different accounts
                if outflow.account_id == inflow.account_id:
                    continue

                # Must NOT be outflow.to_account (that would be Rule 2 transfer)
                if (
                    outflow.to_account_id is not None
                    and inflow.account_id == outflow.to_account_id
                ):
                    continue

                # Check time window
                time_diff = abs((inflow.date_time - outflow.date_time).total_seconds())
                if time_diff > self.config.bridge_time_window:
                    continue

                # Check quantity tolerance
                qty_ratio = self._quantity_diff_ratio(outflow.quantity, inflow.quantity)
                if qty_ratio > self.config.quantity_tolerance:
                    continue

                # Calculate confidence
                confidence = self._calculate_transfer_confidence(qty_ratio, time_diff)
                # Slightly lower confidence than direct transfer since it's a bridge guess
                confidence = max(0.8, confidence - 0.05)

                self._used_tx_ids.add(outflow.id)
                self._used_tx_ids.add(inflow.id)

                symbol = outflow.source_asset_symbol or inflow.source_asset_symbol

                # Check if different networks (case-insensitive comparison)
                networks = []
                if outflow.network:
                    networks.append(outflow.network)
                if inflow.network and (not outflow.network or inflow.network.lower() != outflow.network.lower()):
                    networks.append(inflow.network)

                if len(networks) >= 2:
                    # Cross-chain bridge detected
                    label = f"{symbol} Bridge ({' → '.join(networks)})"
                    reason = (
                        f"Same asset bridged across networks ({', '.join(networks)})"
                    )
                else:
                    # Same network or no network info - just a regular transfer
                    label = f"{symbol} Transfer"
                    reason = f"Same asset transfer between accounts (no explicit link)"

                # Bridges/transfers are internal transfers (same asset, non-taxable)
                suggestions.append(
                    GroupingSuggestion(
                        pattern=PATTERN_INTERNAL_TRANSFER,
                        label=label,
                        reason=f"{reason} (qty diff: {qty_ratio:.2%}, time: {time_diff:.0f}s)",
                        confidence=confidence,
                        transactions=[
                            self._make_tx_summary(outflow),
                            self._make_tx_summary(inflow),
                        ],
                    )
                )
                break

        return suggestions

    def _rule5b_same_account_bridge(
        self, outflows: List[NormalizedTransaction], inflows: List[NormalizedTransaction]
    ) -> List[GroupingSuggestion]:
        """
        Rule 5b: Same-account cross-chain bridge.

        Detects bridges where the user sends and receives on the same account
        (same wallet address tracked across multiple chains).

        Conditions:
        - outflow.asset_id == inflow.asset_id (or same canonical symbol)
        - outflow.account_id == inflow.account_id (same account)
        - outflow.network != inflow.network (different chains)
        - Both networks must be present (non-empty)
        - |qty_out - qty_in| / qty_out <= tolerance
        - time difference <= bridge_time_window

        Confidence: 0.85-0.95 depending on quantity closeness
        """
        suggestions = []

        for outflow in outflows:
            if outflow.id in self._used_tx_ids:
                continue

            for inflow in inflows:
                if inflow.id in self._used_tx_ids:
                    continue

                # Check asset match
                if not self._assets_match(outflow, inflow):
                    continue

                # Must be same account
                if outflow.account_id != inflow.account_id:
                    continue

                # Both must have a network set
                if not outflow.network or not inflow.network:
                    continue

                # Must be different networks (case-insensitive)
                if outflow.network.lower() == inflow.network.lower():
                    continue

                # Check time window
                time_diff = abs((inflow.date_time - outflow.date_time).total_seconds())
                if time_diff > self.config.bridge_time_window:
                    continue

                # Check quantity tolerance
                qty_ratio = self._quantity_diff_ratio(outflow.quantity, inflow.quantity)
                if qty_ratio > self.config.quantity_tolerance:
                    continue

                # Calculate confidence — same account + different network is strong bridge signal
                confidence = self._calculate_transfer_confidence(qty_ratio, time_diff)

                self._used_tx_ids.add(outflow.id)
                self._used_tx_ids.add(inflow.id)

                symbol = outflow.source_asset_symbol or inflow.source_asset_symbol
                label = f"{symbol} Bridge ({outflow.network} \u2192 {inflow.network})"
                reason = f"Same asset bridged across networks on same account ({outflow.network} \u2192 {inflow.network})"

                suggestions.append(
                    GroupingSuggestion(
                        pattern=PATTERN_INTERNAL_TRANSFER,
                        label=label,
                        reason=f"{reason} (qty diff: {qty_ratio:.2%}, time: {time_diff:.0f}s)",
                        confidence=confidence,
                        transactions=[
                            self._make_tx_summary(outflow),
                            self._make_tx_summary(inflow),
                        ],
                    )
                )
                break

        return suggestions

    def _rule6_review_group(
        self, remaining: List[NormalizedTransaction]
    ) -> GroupingSuggestion:
        """
        Rule 6: Catch-all group for remaining ungrouped transactions.

        Creates a single "review" group for manual inspection.
        """
        for tx in remaining:
            self._used_tx_ids.add(tx.id)

        return GroupingSuggestion(
            pattern=PATTERN_UNKNOWN,
            label="Ungrouped Transactions",
            reason=f"{len(remaining)} transaction(s) could not be automatically grouped - requires manual review",
            confidence=0.0,
            transactions=[self._make_tx_summary(tx) for tx in remaining],
        )

    # =========================================================================
    # Helper methods
    # =========================================================================

    def _assets_match(self, tx1: NormalizedTransaction, tx2: NormalizedTransaction) -> bool:
        """Check if two transactions have matching assets."""
        # First check by asset_id if both have it
        if tx1.asset_id is not None and tx2.asset_id is not None:
            return tx1.asset_id == tx2.asset_id

        # Fall back to symbol comparison (case-insensitive)
        return (tx1.source_asset_symbol or "").upper() == (
            tx2.source_asset_symbol or ""
        ).upper()

    def _quantity_diff_ratio(self, qty1: Decimal, qty2: Decimal) -> float:
        """Calculate the relative difference between two quantities."""
        if qty1 == 0:
            return 1.0 if qty2 != 0 else 0.0
        return float(abs(qty1 - qty2) / qty1)

    def _calculate_transfer_confidence(
        self, qty_ratio: float, time_diff: float
    ) -> float:
        """Calculate confidence for transfer grouping."""
        # Start with high confidence
        confidence = self.config.high_confidence

        # Reduce based on quantity difference
        if qty_ratio > 0.01:  # > 1% difference
            confidence -= qty_ratio * 0.5

        # Reduce based on time difference
        max_time = self.config.transfer_time_window
        if time_diff > 60:  # > 1 minute
            time_penalty = (time_diff / max_time) * 0.1
            confidence -= time_penalty

        return max(
            self.config.medium_confidence, min(self.config.high_confidence, confidence)
        )

    def _calculate_swap_confidence(
        self, outflow: NormalizedTransaction, inflow: NormalizedTransaction
    ) -> float:
        """Calculate confidence for swap grouping based on value match."""
        # Check if we have value data
        if outflow.total and inflow.total:
            out_val = float(outflow.total)
            in_val = float(inflow.total)

            if out_val > 0:
                value_diff = abs(out_val - in_val) / out_val
                if value_diff <= self.config.value_tolerance:
                    return 0.9  # Value match

        # Only time match
        return self.config.low_confidence

    def _make_tx_summary(self, tx: NormalizedTransaction) -> Dict[str, Any]:
        """Create a summary dict for displaying in UI."""
        return {
            "id": tx.id,
            "date_time": tx.date_time.strftime("%Y-%m-%d %H:%M")
            if tx.date_time
            else "unknown",
            "symbol": tx.source_asset_symbol or "",
            "asset_symbol": tx.source_asset_symbol or "",
            "source": tx.source or "",
            "source_transaction_id": tx.source_transaction_id or "",
            "direction": tx.direction or "",
            "transaction_type": tx.transaction_type or "",
            "quantity": float(tx.quantity) if tx.quantity else 0,
            "price": float(tx.price) if tx.price else None,
            "total": float(tx.total) if tx.total else None,
            "network": tx.network or "",
            "account_id": tx.account_id,
            "from_account_id": tx.from_account_id,
            "to_account_id": tx.to_account_id,
            "source_from_account": tx.source_from_account or "",
            "source_to_account": tx.source_to_account or "",
        }
