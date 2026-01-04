/**
 * P&L Module Types
 * 
 * Following design principles:
 * - Principle 1: Results first, details on demand
 * - Principle 2: Groups are primary, legs are secondary  
 * - Principle 3: Everything must be traceable
 */

import { CostMethod, LotMode } from '../../types';

// ============================================================================
// Core Reference Types
// ============================================================================

/**
 * Asset reference containing both ID and display name.
 * Used throughout P&L responses for asset identification.
 */
export interface AssetRef {
    id: number;
    name: string;  // Asset symbol/name for display
}

// ============================================================================
// Calculation Context Types
// ============================================================================

export type CalculationStatus = 'idle' | 'calculating' | 'preview' | 'persisted' | 'error';

export interface CalculationConfig {
    id?: string;
    lot_method: CostMethod;
    lot_mode: LotMode;
    base_currency_symbol: string;
    base_currency_id?: number | null;
    residual_tolerance_pct: number;
    allow_negative_balances: boolean;
    account_ids?: number[];  // Filter by account IDs. Empty = all accounts
}

export interface CalculationVersion {
    version_id: string;
    calculated_at: string;
    status: 'preview' | 'persisted';
    config: CalculationConfig;
    summary: PnLSummary;
}

// ============================================================================
// Option D: CQRS-Lite Response Types (New API)
// ============================================================================
// These types correspond to the new /pnl/calculate and /pnl/versions/* endpoints

/**
 * Balance item for Asset P&L view
 */
export interface BalanceItem {
    asset: { id: number; name: string };
    qty: number;
    cost_basis_in_base: number;
    avg_unit_cost_in_base: number;
    lot_count?: number;
}

/**
 * Lightweight version item for list endpoint (CQRS-lite: IDs only).
 * 
 * Used by GET /pnl/versions to return minimal metadata.
 * Use GET /pnl/versions/{id} to get full details (balances, total_realized_pnl).
 */
export interface VersionListItem {
    version_id: number;
    description?: string;
    created_at?: string;
    expires_at?: string;
    status: 'draft' | 'committed' | 'active';
    // Config fields
    lot_method: string;
    lot_mode: string;
    base_currency_id?: number;
    base_currency_symbol?: string;
    allow_negative_balances: boolean;
    residual_tolerance_pct: number;
}

/**
 * Unified response for P&L calculation versions.
 * 
 * Used by:
 * - POST /pnl/calculate (fresh calculation)
 * - GET /pnl/versions/{id} (detail)
 * 
 * ID arrays are populated for /calculate, empty for version retrieval.
 * Balances should be fetched separately via GET /versions/{id}/balances.
 */
export interface PnLVersionResponse {
    // Identity
    version_id: number;
    description?: string;
    created_at?: string;  // Optional for fresh calculation
    expires_at?: string;
    status: 'draft' | 'committed' | 'active' | 'not_persisted';

    // Config
    lot_method: string;
    lot_mode: string;
    base_currency_id?: number;
    base_currency_symbol?: string;
    allow_negative_balances: boolean;
    residual_tolerance_pct: number;

    // Summary
    total_realized_pnl: number;

    // Fee summary (populated for /calculate, for immediate summary card display)
    total_fees_in_base: number;
    fee_entry_count: number;

    // ID arrays for tab title counts (derive count from length)
    // Populated for /calculate, empty for version retrieval
    unit_ids: number[];
    cost_lot_ids: number[];
    consumed_slice_ids: number[];
    realized_pnl_ids: number[];
    warning_ids: number[];
    settlement_ids: number[];
    cost_lot_event_ids: number[];
}

/**
 * Balance response from GET /versions/{id}/balances?group_by_asset=true
 * Aggregated balance data per asset with realized P&L.
 */
export interface AggregatedBalanceItem {
    asset: { id: number; name: string };
    account_ids: number[];  // All account IDs holding this asset (for filtering)
    qty: number;
    cost_basis_in_base: number;
    avg_unit_cost_in_base: number;
    lot_count: number;
    realized_pnl_in_base: number;
    realized_event_count: number;
    warning_count: number;
    unsettled_negative_count: number;  // Count of unsettled negative lots (excluded when filter active)
    total_fees_in_base?: number;  // Total fees at FMV (proceeds from fee disposals)
}

// ============================================================================
// Summary Types (Principle 1: Results first)
// ============================================================================

export interface PnLSummary {
    total_portfolio_value: number;
    total_unrealized_pnl: number;
    total_realized_pnl: number;
    total_fees: number;
    fee_entry_count: number;  // Number of fee entries
    warning_count: number;  // Derived from warnings.length
    error_count: number;    // Derived from warnings.filter(error).length

    // Breakdown
    taxable_realized_pnl: number;
    non_taxable_realized_pnl: number;

    // Processing stats (derived from ID array lengths)
    units_count: number;           // From unit_ids.length
    lots_created_count: number;    // From cost_lot_ids.length
    consumed_slices_count: number; // From consumed_slice_ids.length
}

// ============================================================================
// Asset-Level P&L Types (Primary View)
// ============================================================================

export interface AssetPnLRow {
    asset_id: number;
    asset_symbol: string;
    asset_label?: string;

    // Account tracking for filtering
    account_ids: number[];  // All accounts holding this asset

    // Current position
    quantity: number;
    market_value: number;
    cost_basis: number;

    // P&L
    unrealized_pnl: number;
    unrealized_pnl_pct: number;
    realized_pnl: number;

    // Fees for this asset
    total_fees: number;

    // Counts for drill-down
    lot_count: number;
    realized_event_count: number;
    warning_count: number;

    // Unit values
    unit_cost?: number;              // Average cost basis per unit (from lots)
    unit_value?: number | null;      // Current market price per unit
    price_source?: string;           // e.g., "coingecko", "price_service"
    price_fetched_at?: string;       // ISO datetime when price was fetched
    price_error?: string;            // Error message if price fetch failed
}

// ============================================================================
// Cost Lot Types (Core Audit View)
// ============================================================================

export interface CostLot {
    cost_lot_id: number;
    asset: AssetRef;  // Asset reference with id and name
    // Deprecated: use asset.id and asset.name instead
    asset_id?: number;
    asset_symbol?: string;
    account_id?: number;
    account_name?: string;

    // Quantities
    qty_original: number;
    qty_remaining: number;
    qty_consumed: number;

    // Cost basis
    unit_cost_in_base: number;
    total_cost_in_base: number;
    remaining_cost_in_base: number;

    // Origin traceability (Principle 3)
    acquired_at: string;
    origin_transaction_id?: number;
    origin_unit_id?: number;  // CalculationUnit that created this lot
    origin_unit_label?: string;  // Human-readable label of origin unit
    origin_label?: string;

    // Origin transaction quick details
    origin_tx_type?: string;
    origin_tx_source?: string;
    origin_tx_date?: string;

    // Status
    is_zero_cost: boolean;
    is_negative?: boolean;  // True if this is a negative lot (debt)
    is_fully_settled?: boolean;  // True if negative lot is fully settled
    notes?: string;  // Additional info (e.g., settlement details)
    holding_days?: number;
    is_long_term?: boolean;

    // Settlement tracking for negative lots
    total_settled?: number;  // Amount already settled
    settlement_count?: number;  // Number of settlements
}

// ============================================================================
// Settlement Types (Audit Trail for Negative Lots)
// ============================================================================

export interface Settlement {
    settlement_id: number;
    negative_lot_id: number;  // The debt being settled
    settling_lot_id: number;  // The lot providing funds
    settling_transaction_id?: number;  // Which transaction triggered this
    qty_settled: number;  // How much was settled
    cost_basis_applied?: number;  // For non-base: cost applied
    settled_at: string;

    // Enriched fields for UI
    negative_lot_origin_tx_id?: number;
    settling_tx_label?: string;
}

// ============================================================================
// Realized P&L Types (With full traceability)
// ============================================================================

export interface RealizedPnLRow {
    id: string;
    asset: AssetRef;  // Asset reference with id and name
    // Deprecated: use asset.id and asset.name instead
    asset_id?: number;
    asset_symbol?: string;

    // Event details
    realized_at: string;
    event_type: 'disposal' | 'fee' | 'swap' | 'transfer';

    // P&L calculation
    qty: number;
    proceeds_in_base: number;
    cost_basis_in_base: number;
    pnl_in_base: number;
    pnl_pct: number;

    // Price used for P&L calculation
    disposal_price_in_base?: number;
    cost_price_in_base?: number;

    // Proceeds tracking - how FMV was determined (for transparency)
    proceeds_source?: 'fmv_lookup' | 'base_currency' | 'transfer';
    proceeds_price?: number;  // Unit price used (if applicable)
    proceeds_price_source?: string;  // 'price_service', 'coingecko', 'manual', 'fallback'
    proceeds_price_timestamp?: string;  // When price was fetched/valid

    // Tax status - disposal_taxable indicates if this disposal is a taxable event
    disposal_taxable: boolean;
    holding_period_days?: number;
    is_long_term?: boolean;

    // Traceability (Principle 3)
    transaction_id?: number;
    unit_id?: number;  // CalculationUnit that triggered this P&L
    consumed_lot_count: number;

    // Origin transaction quick details
    origin_tx_type?: string;
    origin_tx_source?: string;
    origin_tx_date?: string;

    // Linked warnings
    warnings?: PnLWarningItem[];

    // Notes
    notes?: string;
}

// ============================================================================
// P&L Impact Panel Types (Economic Event Detail)
// ============================================================================

export interface PnLImpactEvent {
    id: string;
    event_type: string;
    event_date: string;
    disposal_taxable: boolean;

    // Summary
    total_pnl: number;
    total_proceeds: number;
    total_cost_basis: number;
    total_fees: number;

    // Lots consumed
    consumed_lots: ConsumedLotDetail[];

    // Related transactions
    transactions: EventTransaction[];

    // CalculationUnit info if applicable
    unit_id?: number;
    unit_label?: string;
    unit_pattern?: string;
}

export interface ConsumedLotDetail {
    cost_lot_id: number;
    qty_consumed: number;
    cost_basis: number;
    unit_cost: number;
    acquired_at: string;
    holding_days: number;
    origin_transaction_id?: number;
}

export interface EventTransaction {
    transaction_id: number;
    source: string;
    date_time: string;
    direction: string;
    transaction_type: string;
    asset_symbol: string;
    quantity: number;
    price?: number;
    total?: number;
    fee?: number;
}

// ============================================================================
// Fee Panel Types
// ============================================================================

/**
 * Fee entry for display in the FeesPanel.
 * This is a UI model - data is derived from FeeEntry -> RealizedPnl join on backend.
 * FeeEntry is just an index; all fee data lives in the linked RealizedPnl record.
 */
export interface FeeEntry {
    id: string;
    date: string;
    asset_id: number;
    asset_symbol: string;
    fee_amount: number;      // quantity from RealizedPnl
    fee_in_base: number;     // proceeds_in_base from RealizedPnl

    // Source
    transaction_id?: number;
    unit_id?: number;  // CalculationUnit that processed this fee
    source: string;
    transaction_type: string;

    // Cost basis impact (from RealizedPnl)
    cost_basis_consumed?: number;  // cost_basis_in_base from RealizedPnl
    realized_pnl?: number;         // realized_pnl from RealizedPnl

    // Related asset - the primary asset this fee relates to (non-base-currency side of trade)
    // Used for linking fee P&L to asset-level P&L summary
    related_asset_id?: number;
    related_asset_symbol?: string;
}

export interface FeeSummary {
    total_fees_in_base: number;
    fees_by_asset: Record<string, number>;
    fees_by_source: Record<string, number>;
    disposal_taxable_fee_count: number;
}

// ============================================================================
// Warning Types
// ============================================================================

export type WarningLevel = 'info' | 'warning' | 'error';

export interface PnLWarningItem {
    id: string;
    level: WarningLevel;
    warning_type: string;
    message: string;  // Self-sufficient message with all context (including asset names)
    timestamp?: string;  // For sorting by date

    // Context
    transaction_id?: number;
    unit_id?: number;  // CalculationUnit where warning occurred
    unit_label?: string;

    // Action
    action_label?: string;
    action_link?: string;
}

// ============================================================================
// Consumed Slice Detail (for audit drill-down)
// ============================================================================

export interface ConsumedSliceDetail {
    cost_lot_id: number;
    asset?: AssetRef;  // Asset of the consumed lot
    quantity: number;
    unit_cost_in_base: number;
    total_cost_in_base: number;
    acquired_at: string;
    holding_period_days?: number;
    consumed_by_transaction_id?: number;  // Transaction that consumed this slice
    consumed_by_unit_label?: string;  // Human-readable label of consuming unit
    consumed_at?: string;  // When the slice was consumed
}

// ============================================================================
// Cost Lot Event (audit trail for lot lifecycle)
// ============================================================================

export type LotEventType = 'created' | 'consumed' | 'settled' | 'transferred' | 'adjusted';

export interface CostLotEventEntry {
    event_id: number;
    event_type: LotEventType;

    lot_id: number;
    asset?: AssetRef;
    account_id?: number;
    account_name?: string;

    quantity_delta: number;
    cost_basis_delta?: number;
    qty_remaining_after: number;
    cost_basis_remaining_after?: number;

    related_lot_id?: number;
    triggered_by_transaction_id?: number;
    triggered_by_unit_id?: number;
    triggered_by_unit_label?: string;

    timestamp: string;
    event_metadata?: Record<string, any>;
}

// ============================================================================
// Realized Entry Detail (for audit drill-down)
// ============================================================================

export interface RealizedEntryDetail {
    asset: AssetRef;
    qty: number;
    proceeds_in_base: number;
    cost_basis_in_base: number;
    pnl_in_base: number;
    disposal_taxable: boolean;
    is_fee?: boolean;  // True if this entry is from a fee disposal
}

// ============================================================================
// View State Types
// ============================================================================

export type PnLView =
    | 'summary'           // Top-level summary cards
    | 'assets'            // Asset-level P&L table
    | 'asset-detail'      // Single asset detail with lots
    | 'fees'              // Fees panel
    | 'warnings';         // Warnings panel

export interface PnLViewState {
    currentView: PnLView;
    selectedAssetId?: number;
    selectedPnLEntryId?: string;
    showImpactPanel: boolean;
    impactPanelEvent?: PnLImpactEvent;
}

// ============================================================================
// API Response Types (Extended)
// ============================================================================

export interface AssetPnLResponse {
    assets: AssetPnLRow[];
    summary: PnLSummary;
}

export interface AssetDetailResponse {
    asset: AssetPnLRow;
    lots: CostLot[];
    realized_entries: RealizedPnLRow[];
    warnings: PnLWarningItem[];
}

// ============================================================================
// Version Management Types
// ============================================================================

export interface SavedPnLVersion {
    version_id: string;
    calculated_at: string;
    saved_at: string;
    config: CalculationConfig;
    summary: PnLSummary;
    notes?: string;
}

// ============================================================================
// Data Explorer Types (Calculation Units, Bundles, Transactions)
// ============================================================================

// Origin Transaction Detail (for unit expanded view)
export interface OriginTransactionDetail {
    transaction_id: number;
    date_time?: string;
    account_id?: number;
    account_name?: string;
    source?: string;
    source_transaction_type?: string;
    transaction_type?: string;  // Normalized transaction type
    direction?: string;

    // Transfer fields
    from_account_id?: number;
    from_account_name?: string;
    to_account_id?: number;
    to_account_name?: string;
    source_from_account?: string;
    source_to_account?: string;

    // Base asset
    asset_id?: number;
    asset_symbol?: string;
    quantity?: number;

    // Pricing
    price?: number;
    price_quote_asset_id?: number;
    price_quote_asset_symbol?: string;
    total?: number;

    // Fee
    fee?: number;
    fee_quote_asset_id?: number;
    fee_quote_asset_symbol?: string;
}

export interface CalculationUnit {
    unit_id: number;
    unit_label?: string;  // Human-readable label (e.g., "SWAP BTC → ETH")
    pattern?: string | null;    // Pattern: transfer, swap, split, unknown
    date: string;

    // Primary asset (for display - first outflow or inflow)
    asset_id: number;
    asset_symbol: string;

    // All assets involved
    outflow_asset_ids?: number[];
    inflow_asset_ids?: number[];
    fee_asset_ids?: number[];
    outflow_asset_symbols?: string[];
    inflow_asset_symbols?: string[];
    fee_asset_symbols?: string[];

    // Transaction references (all transactions that make up this unit)
    transaction_ids?: number[];

    // Lot references (for audit linking)
    lots_created_uuids?: string[];
    lots_consumed_uuids?: string[];

    // Detailed consumption info (for audit drill-down)
    consumed_slices?: ConsumedSliceDetail[];
    realized_entries?: RealizedEntryDetail[];
    settlements?: Settlement[];  // Unit-level settlements for negative lots

    // P&L impact
    realized_pnl_in_base?: number;
    is_disposal_taxable?: boolean;

    // Fee indicator
    has_fees?: boolean;  // True if unit has fee legs
    fee_count?: number;  // Number of fee entries in this unit
    total_fees_in_base?: number;  // Total fee value in base currency

    // Warnings specific to this unit
    warnings?: PnLWarningItem[];

    // Counts for summary
    member_count?: number;
    lots_created_count?: number;
    lots_consumed_count?: number;
    realized_entry_count?: number;

    // Event IDs for counting (avoids loading full lot events)
    event_ids?: number[];

    // Legacy fields (for backward compat with old transaction display)
    quantity?: number;
    value_in_base?: number;
    account_id?: number;
    account_name?: string;
    transaction_id?: number;
    cost_lot_id?: number;
}

// Deprecated - use CalculationUnit instead
export interface BundleSummary {
    bundle_id: number;  // Legacy - maps to calculation_unit_id
    pattern?: string;
    label?: string;
    date: string;
    leg_count: number;
    transaction_ids: number[];
    total_value_in_base: number;
    pnl_impact: number;
    is_disposal_taxable: boolean;
}

export interface TransactionSummary {
    transaction_id: number;
    date: string;
    source: string;
    direction: string;
    transaction_type: string;
    asset_symbol: string;
    quantity: number;
    price_in_base?: number;
    total_in_base?: number;
    fee_in_base?: number;
    unit_id?: number;  // CalculationUnit this transaction belongs to
    pnl_impact?: number;
}
