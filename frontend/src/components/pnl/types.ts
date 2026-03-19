/**
 * P&L Module Types
 * 
 * Following design principles:
 * - Principle 1: Results first, details on demand
 * - Principle 2: Groups are primary, legs are secondary  
 * - Principle 3: Everything must be traceable
 */

import { CostMethod, LotMode, AssetRef, Asset } from '../../types';


// ============================================================================
// P&L Calculation Service Status (polling endpoint)
// ============================================================================

export type PnLCalcStatus = 'idle' | 'stale' | 'calculating' | 'completed' | 'error';

export interface PnLCalculationStatusResponse {
    status: PnLCalcStatus;
    stale_since: string | null;
    stale_reasons: string[];
    current_version_id: number | null;
    last_calculated_at: string | null;
    error: string | null;
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
    // Advanced settings
    compute_residuals: boolean;
    crypto_swap_taxable_by_default: boolean;
    fee_taxable_by_default: boolean;
    // Price fallback settings
    use_price_fallback: boolean;  // Fall back to latest known price when fetch fails
    price_staleness_window_days: number;  // Max days to consider price fresh
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
    trigger?: 'auto' | 'manual' | 'refresh';
    // Config fields
    lot_method: string;
    lot_mode: string;
    base_currency_id?: number;
    base_currency_symbol?: string;
    allow_negative_balances: boolean;
    residual_tolerance_pct: number;
    compute_residuals?: boolean;
    // Full config for history display
    crypto_swap_taxable?: boolean;
    fee_taxable?: boolean;
    use_price_fallback?: boolean;
    price_staleness_window_days?: number;
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
    trigger?: 'auto' | 'manual' | 'refresh';

    // Config
    lot_method: string;
    lot_mode: string;
    base_currency_id?: number;
    base_currency_symbol?: string;
    allow_negative_balances: boolean;
    residual_tolerance_pct: number;
    compute_residuals?: boolean;
    // Full config for reproducibility
    crypto_swap_taxable?: boolean;
    fee_taxable?: boolean;
    use_price_fallback?: boolean;
    price_staleness_window_days?: number;

    // Summary (from metrics_service — authoritative)
    total_realized_pnl: number;
    current_value: number;
    cost_basis: number;
    unrealized_pnl: number;
    taxable_realized_pnl: number;

    // Fee summary (populated for /calculate, for immediate summary card display)
    total_fees_in_base: number;
    fee_entry_count: number;

    // Entity ID lists for frontend count displays (populated for /calculate and /versions/{id})
    calculation_unit_ids: number[];
    warning_ids: number[];
    cost_lot_ids: number[];
    realized_pnl_ids: number[];
    fee_ids: number[];
    cost_lot_event_ids: number[];
}

/**
 * Balance response from GET /versions/{id}/balances?group_by_asset=true
 * Aggregated balance data per asset with realized P&L.
 */
export interface AggregatedBalanceItem {
    asset: AssetRef;
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
    category_ids: number[];  // Category IDs assigned to this asset (for client-side filtering)
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
    asset: AssetRef

    // Account tracking for filtering
    account_ids: number[];  // All accounts holding this asset

    // Category tracking for filtering
    category_ids: number[];  // All category IDs assigned to this asset

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

    // Whether this asset has cost lots in the P&L calculation
    has_lots?: boolean;

    // Whether this asset is unmapped (appears in live balance but has no DB entry)
    is_unmapped?: boolean;

    // Unit values
    unit_cost?: number;              // Average cost basis per unit (from lots)
    unit_value?: number | null;      // Current market price per unit
    price_source?: string;           // e.g., "coingecko", "price_service"
    price_fetched_at?: string;       // ISO datetime when price was fetched
    price_error?: string;            // Error message if price fetch failed
    price_loading?: boolean;         // True if price is currently being fetched
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

    // Cost provenance
    cost_source?: string;  // "fmv" | "proceeds" | "inherited" | "provisional" | "base_currency"
    cost_fmv_price?: number;  // FMV unit price used (if cost_source is fmv/provisional)
    cost_fmv_source?: string;  // Price source (e.g., "coingecko", "fallback:cached")
    cost_fmv_timestamp?: string;  // When the FMV price was snapped
    cost_fmv_stale?: boolean;  // Whether the FMV price was flagged stale

    // Settlement tracking for negative lots
    total_settled?: number;  // Amount already settled
    settlement_count?: number;  // Number of settlements

    // Cost basis chain (for transfers/splits — links to source lot)
    source_lot_id?: number;  // The lot this was created from (if inherited/split)
}

// ============================================================================
// Cost Basis Chain Types (Backward Provenance Trail)
// ============================================================================

export interface CostBasisChainNode {
    lot_id: number;
    transaction_id?: number;
    transaction_type?: string;        // e.g. "buy", "transfer", "swap", "split"
    transaction_source_type?: string; // Source-level type
    timestamp?: string;               // TX date or lot acquired_at
    asset_symbol?: string;
    asset_id?: number;
    account_name?: string;
    account_id?: number;
    qty: number;
    unit_cost: number;
    cost_source?: string;             // "fmv", "inherited", "proceeds", "provisional", "base_currency"
    unit_pattern?: string;            // "transfer", "swap", "split", "flow"
    children: CostBasisChainNode[];   // Source lots (backward, toward origin)
}

export interface CostBasisChainResponse {
    chain: CostBasisChainNode[];
    depth: number;                     // Maximum depth reached
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
    asset: AssetRef;

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
    proceeds_source?: 'fmv_lookup' | 'fmv' | 'provisional' | 'base_currency' | 'transfer';
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
    asset_id?: number;  // Asset involved in the warning (for price errors)
    details?: Record<string, unknown>;  // Additional context (transaction_date, error, etc.)

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

export type LotEventType =
    | 'created'           // Positive lot created
    | 'created-negative'  // Negative lot created (short)
    | 'consumed'          // Lot partially/fully consumed
    | 'settled'           // Lot exhausted (zero balance)
    | 'transferred'       // Lot moved between accounts
    | 'adjusted'          // Manual cost basis adjustment
    | 'merged';           // Multiple lots combined (future)

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

    // Asset and account-level balances after this event
    balance_after?: number;  // Total asset balance across all accounts
    account_balance_after?: number;  // Balance for this specific account

    related_lot_id?: number;
    triggered_by_transaction_id?: number;
    triggered_by_unit_id?: number;
    triggered_by_unit_label?: string;
    triggered_by_unit_pattern?: string;

    timestamp: string;

    // FMV details for 'created' events where cost basis used FMV
    cost_source?: string;  // 'fmv' | 'provisional' | 'inherited' | 'proceeds' | 'base_currency'
    cost_fmv_price?: number;  // FMV unit price used
    cost_fmv_source?: string;  // Price provider (e.g., 'coingecko', 'fallback')
    cost_fmv_timestamp?: string;  // When price was snapped
    cost_fmv_stale?: boolean;  // Whether the FMV price was flagged stale
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

    // Proceeds tracking - how FMV was determined (for transparency)
    proceeds_source?: 'fmv_lookup' | 'fmv' | 'provisional' | 'base_currency' | 'transfer';
    proceeds_price?: number;  // Unit price used
    proceeds_price_source?: string;  // 'coingecko', 'manual', 'fallback'
    proceeds_price_timestamp?: string;  // When price was fetched/valid
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
// Paginated Response Types (for P&L Audit tabs)
// ============================================================================

/**
 * Generic paginated response wrapper.
 * Backend returns { items, total, page, limit } for paginated endpoints.
 */
export interface PaginatedResponse<T> {
    items: T[];
    total: number;
    page: number;
    limit: number;
}

/** Paginated calculation units response */
export type PaginatedUnitsResponse = PaginatedResponse<PnLCalculationUnit>;

/** Paginated cost lots response */
export type PaginatedLotsResponse = PaginatedResponse<CostLot>;

/** Paginated consumed slices response */
export type PaginatedConsumedSlicesResponse = PaginatedResponse<ConsumedSliceDetail>;

/** Paginated realized P&L entries response */
export type PaginatedRealizedPnLResponse = PaginatedResponse<RealizedPnLRow>;

/** Paginated fee entries response */
export type PaginatedFeesResponse = PaginatedResponse<FeeEntry>;

/** Paginated warnings response */
export type PaginatedWarningsResponse = PaginatedResponse<PnLWarningItem>;

/** Paginated cost lot events response */
export type PaginatedEventsResponse = PaginatedResponse<CostLotEventEntry>;

/** Paginated settlements response */
export type PaginatedSettlementsResponse = PaginatedResponse<Settlement>;

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

    // Base asset - nested ref (preferred) + legacy flat fields
    linked_asset?: AssetRef | null;
    asset_id?: number;
    asset_symbol?: string;
    source_asset_symbol?: string;
    quantity?: number;

    // Pricing - nested ref (preferred) + legacy flat fields
    price_quote_asset?: AssetRef | null;
    price?: number;
    price_quote_asset_id?: number;
    price_quote_asset_symbol?: string;
    source_price_quote_asset_symbol?: string;
    total?: number;

    // Fee - nested ref (preferred) + legacy flat fields
    fee_quote_asset?: AssetRef | null;
    fee?: number;
    fee_quote_asset_id?: number;
    fee_quote_asset_symbol?: string;
    source_fee_quote_asset_symbol?: string;
}

/**
 * Minimal leg detail for embedded display in transactions.
 * Also exported as LegSummary for backward compatibility with backend naming.
 */
export interface LegDetail {
    asset: AssetRef;
    qty: number;
    leg_type: 'inflow' | 'outflow' | 'fee';
    transaction_id: number;
}



/**
 * Full transaction with embedded legs for Unit → Transaction → Legs structure.
 * Display format: [TX#1234] 01/08 10:30 [Account] [source] [source_tx_type] [BTC] 0.5 → 24K [USD] | Fee 0.001 [BTC]
 */
export interface PnLTransaction {
    transaction_id: number;
    date_time?: string;

    // Account
    account_id?: number;
    account_name?: string;

    // Source info
    source?: string;
    transaction_type?: string;  // "trade", "transfer", "margin", "cost"
    source_transaction_type?: string;  // From source: "SPOT_TRADE", "deposit", etc.
    direction?: string;  // "inflow", "outflow", "neutral"

    // Primary asset (from transaction)
    asset?: AssetRef;
    quantity?: number;

    // Pricing
    price?: number;
    total?: number;
    price_quote_asset?: AssetRef;

    // Fee (from origin transaction)
    fee?: number;
    fee_quote_asset?: AssetRef;
}



/**
 * P&L Calculation Unit (display model for P&L panels).
 * Different from global CalculationUnit which represents user-created bundles.
 * Mapped from backend ProcessedUnitResponse via mapProcessedUnitToCalculationUnit().
 */
export interface AssetBalanceSnapshot {
    asset: { id: number; symbol: string };
    balance: number;
    accounts?: Array<{ account_id: number; account_name: string; balance: number }>;
}

export interface PnLCalculationUnit {
    // Core fields (from backend)
    unit_id: number;
    unit_label?: string;  // Human-readable label (e.g., "SWAP BTC → ETH")
    pattern?: string | null;    // Pattern: transfer, swap, split, unknown
    date: string;  // Mapped from backend's timestamp field

    // Transaction structure (from backend)
    transactions: Array<{
        id: number;
        date_time?: string | null;
        account_id?: number | null;
        account_name?: string | null;
        source?: string | null;
        transaction_type?: string | null;
        source_transaction_type?: string | null;
        source_transaction_id?: string | null;
        direction?: string | null;
        asset_symbol?: string | null;
        symbol?: string | null;
        quantity?: number | null;
        price?: number | null;
        price_quote_asset_symbol?: string | null;
        total?: number | null;
        fee?: number | null;
        fee_quote_asset_symbol?: string | null;
        from_account_name?: string | null;
        to_account_name?: string | null;
        source_from_account?: string | null;
        source_to_account?: string | null;
        network?: string | null;
        network_transaction_id?: string | null;
        source_asset_symbol?: string | null;
    }>;
    legs: LegDetail[];

    // P&L results (from backend)
    realized_entries?: RealizedEntryDetail[];
    realized_pnl_in_base?: number;
    is_disposal_taxable?: boolean;

    // Fee indicator (from backend)
    has_fees?: boolean;
    total_fees_in_base?: number;  // Total fee value in base currency

    // Warnings (from backend)
    warnings?: PnLWarningItem[];

    // Event IDs (from backend - for lazy loading)
    event_ids?: number[];

    // Balance snapshots (computed client-side for Activity Feed)
    balance_snapshots?: AssetBalanceSnapshot[];
}

// Backward compatibility alias
export type CalculationUnit = PnLCalculationUnit;

// Deprecated - use PnLCalculationUnit instead
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

// ============================================================================
// Pie Chart Types (Market Value by Category)
// ============================================================================

/**
 * Data point for the market value pie chart.
 * Represents a single slice of the pie (one category or "Uncategorized").
 */
export interface PieChartDataPoint {
    categoryId: number | null;  // null = uncategorized
    label: string;
    color: string;
    value: number;  // Market value in base currency
    percentage: number;  // Percentage of total
    assetCount: number;  // Number of assets in this category
}

/**
 * Aggregates market value by category within a selected dimension.
 *
 * @param assets - Array of AssetPnLRow with market_value and category_ids
 * @param dimensionId - The dimension to group by (e.g., "Asset Class")
 * @param categories - All categories (will be filtered to the selected dimension)
 * @returns Array of PieChartDataPoint sorted by value descending
 */
export function aggregateMarketValueByCategory(
    assets: AssetPnLRow[],
    dimensionId: number,
    categories: { id: number; dimension_id: number; label: string; color?: string | null }[]
): PieChartDataPoint[] {
    // Filter categories to the selected dimension
    const dimensionCategories = categories.filter(c => c.dimension_id === dimensionId);

    // Build a map: categoryId -> { label, color, value, assetIds }
    const categoryMap = new Map<number, {
        label: string;
        color: string;
        value: number;
        assetIds: Set<number>;
    }>();

    // Initialize all categories in this dimension
    for (const cat of dimensionCategories) {
        categoryMap.set(cat.id, {
            label: cat.label,
            color: cat.color || '#888888',
            value: 0,
            assetIds: new Set(),
        });
    }

    // Track uncategorized assets (no category in selected dimension)
    let uncategorizedValue = 0;
    const uncategorizedAssetIds = new Set<number>();

    // Aggregate market value by category
    for (const assetpnlrow of assets) {
        // Find categories for this asset within the selected dimension
        const matchingCategoryIds = assetpnlrow.category_ids.filter(catId =>
            dimensionCategories.some(c => c.id === catId)
        );

        if (matchingCategoryIds.length === 0) {
            // Asset has no category in this dimension -> uncategorized
            uncategorizedValue += assetpnlrow.market_value;
            if (assetpnlrow.asset.id != null) {
                uncategorizedAssetIds.add(assetpnlrow.asset.id);
            }
        } else {
            // Asset belongs to one or more categories in this dimension
            // Split value evenly if multiple categories (rare edge case)
            const valuePerCategory = assetpnlrow.market_value / matchingCategoryIds.length;
            for (const catId of matchingCategoryIds) {
                const entry = categoryMap.get(catId);
                if (entry) {
                    entry.value += valuePerCategory;
                    if (assetpnlrow.asset.id != null) {
                        entry.assetIds.add(assetpnlrow.asset.id);
                    }
                }
            }
        }
    }

    // Calculate total for percentages
    const totalValue = assets.reduce((sum, a) => sum + a.market_value, 0);

    // Build result array
    const result: PieChartDataPoint[] = [];

    // Add category entries (filter out zero values)
    for (const [catId, entry] of categoryMap.entries()) {
        if (entry.value > 0) {
            result.push({
                categoryId: catId,
                label: entry.label,
                color: entry.color,
                value: entry.value,
                percentage: totalValue > 0 ? (entry.value / totalValue) * 100 : 0,
                assetCount: entry.assetIds.size,
            });
        }
    }

    // Add uncategorized if any
    if (uncategorizedValue > 0) {
        result.push({
            categoryId: null,
            label: 'Uncategorized',
            color: '#9CA3AF',  // Gray-400
            value: uncategorizedValue,
            percentage: totalValue > 0 ? (uncategorizedValue / totalValue) * 100 : 0,
            assetCount: uncategorizedAssetIds.size,
        });
    }

    // Sort by value descending
    result.sort((a, b) => b.value - a.value);

    return result;
}

/**
 * Backend response model for processed calculation units (NEW refactored structure).
 * Matches ProcessedUnitResponse from backend/api/routes/pnl.py
 */
export interface ProcessedUnitResponse {
    unit_id?: number;
    unit_label: string;
    pattern?: string;
    timestamp: string;  // ISO string from backend

    // NEW: Deduplicated transaction structure
    transactions: Array<{
        id: number;
        date_time?: string | null;
        account_id?: number | null;
        account_name?: string | null;
        source?: string | null;
        transaction_type?: string | null;
        source_transaction_type?: string | null;
        source_transaction_id?: string | null;
        direction?: string | null;
        asset_symbol?: string | null;
        symbol?: string | null;
        quantity?: number | null;
        price?: number | null;
        price_quote_asset_symbol?: string | null;
        total?: number | null;
        fee?: number | null;
        fee_quote_asset_symbol?: string | null;
        from_account_name?: string | null;
        to_account_name?: string | null;
        source_from_account?: string | null;
        source_to_account?: string | null;
        network?: string | null;
        network_transaction_id?: string | null;
        source_asset_symbol?: string | null;
    }>;  // Dict keyed by transaction ID
    legs: LegDetail[];
    has_fees: boolean;
    total_fees_in_base?: number;  // Total fee value in base currency

    // Cost basis tracking
    cost_basis?: {
        lots?: Array<{ cost_lot_id: string }>;
        consumed?: ConsumedSliceDetail[];
        settlements?: Settlement[];
    };

    // P&L results
    realized_entries: RealizedEntryDetail[];
    warnings: PnLWarningItem[];
    event_ids: number[];
    realized_pnl_in_base: number;
    is_disposal_taxable: boolean;
}

/**
 * Helper function to map backend ProcessedUnitResponse to frontend PnLCalculationUnit.
 * Directly maps the NEW backend structure (transactions dict + legs array).
 */
export function mapProcessedUnitToCalculationUnit(unit: ProcessedUnitResponse): PnLCalculationUnit {
    return {
        unit_id: unit.unit_id ?? 0,
        unit_label: unit.unit_label || '',
        pattern: unit.pattern || 'unknown',
        date: unit.timestamp,
        transactions: unit.transactions,
        legs: unit.legs,
        has_fees: unit.has_fees,
        total_fees_in_base: unit.total_fees_in_base,
        realized_entries: unit.realized_entries || [],
        warnings: unit.warnings || [],
        realized_pnl_in_base: unit.realized_pnl_in_base || 0,
        is_disposal_taxable: unit.is_disposal_taxable || false,
        event_ids: unit.event_ids || [],
    };
}

// ============================================================================
// Filter Types (Display-time filtering in Portfolio View)
// ============================================================================

/**
 * State for P&L display-time filters.
 * Applied client-side to filter the Portfolio View (summary, charts, table).
 * Does not affect Full Audit view.
 */
export interface PnLFilterState {
    selectedAccountIds: number[];    // Empty = all accounts (no filter)
    selectedCategoryIds: number[];   // Empty = all categories (no filter)
    includeUnsettledNegative: boolean;
}

/**
 * Per-account balance breakdown for a single asset.
 * Used for expandable rows in the Asset P&L table.
 */
export interface AccountBalanceBreakdown {
    account_id: number;
    account_name: string;
    qty: number;
    cost_basis_in_base: number;
    avg_unit_cost_in_base: number;
    lot_count: number;
    // Computed with live prices
    market_value?: number;
    unrealized_pnl?: number;
    unrealized_pnl_pct?: number;
}

/**
 * Raw balance response from GET /versions/{id}/balances?group_by_asset=false
 * One entry per (asset, account) pair.
 */
export interface PerAccountBalanceItem {
    asset: AssetRef;
    account_id: number;
    account_name: string;
    qty: number;
    cost_basis_in_base: number;
    avg_unit_cost_in_base: number;
    lot_count: number;
    realized_pnl_in_base: number;
    realized_event_count: number;
    warning_count: number;
    unsettled_negative_count: number;
    total_fees_in_base?: number;
    category_ids: number[];
}

// ============================================================================
// Live Balance Comparison Types
// ============================================================================

/**
 * An asset that appears in live connector balances but has no matching
 * AssetPnLRow (no P&L data). Typically dust, spam, or un-imported tokens.
 */
export interface UnmappedLiveAsset {
    symbol: string;
    totalQty: number;
    /** Market value in base currency, null if no price available */
    marketValue: number | null;
}

