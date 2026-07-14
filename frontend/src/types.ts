import {
    ReviewStatus,
    TaxabilityStatus as TaxabilityStatusEnum,
    Direction,
    AccountType,
    ConnectorCategory,
    SyncStatus,
    UnitPattern as UnitPatternEnum,
    CostMethod as CostMethodEnum,
    LotMode as LotModeEnum,
    LegType as LegTypeEnum,
} from './enums';

// Re-export enums for convenience
export {
    ReviewStatus,
    TaxabilityStatusEnum,
    Direction,
    AccountType,
    ConnectorCategory,
    SyncStatus,
    UnitPatternEnum,
    CostMethodEnum,
    LotModeEnum,
    LegTypeEnum,
};

// Type aliases using enum values for backward compatibility
export type TransactionStatus = `${ReviewStatus}`;

// V2 Architecture: Workflow status
export type WorkflowStatus = 'pending' | 'reviewed' | 'excluded';

// V2 Architecture: Taxability status
export type TaxabilityStatus = `${TaxabilityStatusEnum}`;

export interface Account {
    id: number;
    name: string;
    account_type: `${AccountType}`;
    address_or_identifier?: string;
    tags: string[];
    owned: boolean;
    enabled: boolean;
    created_at: string;
}

export interface AccountConnector {
    id: number;
    account_id: number;
    connector_type: string;
    enabled: boolean;
    config: Record<string, any>;
    credentials_ref?: string;
    sync_priority: number;
    last_sync_at?: string;
    last_sync_status?: `${SyncStatus}`;
    last_error?: string;
    created_at: string;
    updated_at: string;
}

export interface ConnectorWithAccount extends AccountConnector {
    account_name: string;
    account_type: string;
}

export interface ConnectorTypeInfo {
    type: string;
    category: `${ConnectorCategory}`;
    display_name: string;
    supported_chains?: string[];
    required_config: string[];
    optional_config: string[];
}

/**
 * Lightweight asset reference for embedding in transaction responses.
 * Contains minimal fields for display without relationships.
 * Different from P&L's AssetRef which uses (id, name) fields.
 */
export interface TransactionAssetRef {
    asset_id?: number | null;
    symbol?: string | null;
    label?: string | null;
}

export interface Transaction {
    id: number;
    raw_transaction_id?: number;
    asset_id?: number | null;
    price_quote_asset_id?: number | null;
    fee_quote_asset_id?: number | null;
    // V2 Architecture fields
    status?: WorkflowStatus;
    taxability_status?: TaxabilityStatus;
    user_calculation_unit_id?: number | null;
    source: string;
    source_transaction_id: string;
    account_id?: number | null;
    date_time: string | number;
    direction: string;
    transaction_type: string;
    source_transaction_type?: string;
    source_asset_symbol?: string;
    source_price_quote_asset_symbol?: string;
    source_fee_quote_asset_symbol?: string;
    // Nested asset references (preferred for display)
    linked_asset?: TransactionAssetRef | null;
    price_quote_asset?: TransactionAssetRef | null;
    fee_quote_asset?: TransactionAssetRef | null;
    // Backward-compatible flat symbol fields (deprecated, prefer nested objects)
    linked_asset_symbol?: string; // From assets table via asset_id FK
    linked_price_quote_asset_symbol?: string; // From assets table via price_quote_asset_id FK
    linked_fee_quote_asset_symbol?: string; // From assets table via fee_quote_asset_id FK
    // Server-side resolved account names
    account_name?: string;
    from_account_name?: string;
    to_account_name?: string;
    quantity: number;
    price?: number;
    total?: number; // Computed: price * quantity
    fee?: number;
    include_fee?: boolean;
    disposal_taxable?: boolean;  // Whether disposing this asset is a taxable event
    source_account?: string;  // Raw account identifier before mapping
    source_from_account?: string;
    source_to_account?: string;
    from_account_id?: number | null;
    to_account_id?: number | null;
    network?: string;
    network_transaction_id?: string;
    token_contract_address?: string;
    review_status: TransactionStatus;
    review_notes?: string;
    tags?: Record<string, any>;
    synced_at?: string;
}

// V2 Architecture: Calculation Unit patterns (unified concept for grouping transactions)
export type UnitPattern = `${UnitPatternEnum}`;
// Backward compatibility alias
export type BundlePattern = 'transfer' | 'swap';

// V2 Architecture: CalculationUnit (replaces Bundle concept)
export interface CalculationUnit {
    id: number;
    label?: string;
    pattern?: UnitPattern;
    notes?: string;
    taxability_override?: TaxabilityStatus;
    confidence?: number;
    reason?: string;
    created_at: string;
    transaction_count: number;
    transactions: TransactionSummary[];
    total_inflow?: Record<string, number>;
    total_outflow?: Record<string, number>;
}

// Backward compatibility alias
export type Bundle = CalculationUnit;

// Grouping suggestion from the suggestion service
export interface GroupingSuggestion {
    pattern: UnitPattern;
    confidence: number;
    label: string;
    reason: string;
    taxability_suggestion: TaxabilityStatus;
    total_quantity?: number;
    asset_symbol?: string;
    date_range?: string;
    transactions: TransactionSummary[];
}

// Backward compatibility alias
export type BundleSuggestion = GroupingSuggestion;

// Leg types for expanded transactions (deprecated - kept for backward compatibility)
export type LegType = `${LegTypeEnum}`;

export interface TransactionLeg extends Transaction {
    leg_type?: LegType;
}

// Classification suggestion from GroupClassifier
export type GroupPattern = 'internal_transfer' | 'swap' | 'unknown';

export interface ClassificationSuggestion {
    pattern: GroupPattern;
    confidence: number;
    reason: string;
    suggested_disposal_taxable: boolean;
    suggested_group_type: string;
    inflow_asset_ids: number[];
    outflow_asset_ids: number[];
}

export interface TransactionSummary {
    id: number;
    date_time: string;
    source: string;
    source_transaction_id: string;
    direction: string;
    quantity: number;
    transaction_type?: string;
    symbol?: string;
    asset_symbol?: string;
    network?: string;
    // Nested asset references (preferred for display)
    linked_asset?: TransactionAssetRef | null;
    price_quote_asset?: TransactionAssetRef | null;
    fee_quote_asset?: TransactionAssetRef | null;
    // Extended fields for enhanced display
    account_id?: number;
    account_name?: string;
    price?: number;
    price_quote_asset_symbol?: string;
    total?: number;
    fee?: number;
    fee_quote_asset_symbol?: string;
    from_account_name?: string;
    to_account_name?: string;
    source_from_account?: string;
    source_to_account?: string;
    source_transaction_type?: string;
    source_asset_symbol?: string;
    network_transaction_id?: string;
}

export interface SuggestedGroup {
    reason: string;
    confidence: number;
    suggested_label: string;
    transactions: TransactionSummary[];
}

export interface AssetPriceGetter {
    id: number;
    asset_id: number;
    price_getter: string;
    external_id?: string | null;  // API identifier: "BTC-USD", "bitcoin", "AAPL"
    priority: number;
    enabled: boolean;
    params: Record<string, any>;  // Extra params: native_quote_currency, source, etc.
    created_at?: string;
    updated_at?: string;
}

// Dimension for asset classification (e.g., "Asset Class", "Sector")
export interface Dimension {
    id: number;
    label: string;           // Display name: "Asset Class", "Sector", "Region"
    ordinal: number;
    category_count?: number; // Number of categories in this dimension
    asset_count?: number;    // Number of unique assets classified in this dimension
}

// Category for flexible asset classification and reporting
export interface Category {
    id: number;
    dimension_id: number;    // FK to Dimension
    dimension_label: string; // Display name from parent dimension (convenience field)
    label: string;           // Display value: "Cryptocurrency", "DeFi", "United States"
    color?: string | null;
    ordinal: number;
    asset_count?: number;    // Number of assets linked to this category
}

// Linked asset (minimal info for display in category drawer)
export interface LinkedAsset {
    asset_id: number;
    symbol: string;
    label?: string;
}

// Response from /categories/{id}/assets endpoint
export interface CategoryAssetsResponse {
    category_id: number;
    category_label: string;
    dimension_id: number;
    dimension_label: string;
    assets: LinkedAsset[];
    count: number;
}

// Response from /categories/dimensions/{dimension_id}/unclassified endpoint
export interface UnclassifiedAssetsResponse {
    dimension_id: number;
    dimension_label: string;
    count: number;
    assets: LinkedAsset[];
}

// Dimension with its categories (from /categories/by-dimension endpoint)
export interface DimensionWithCategories {
    id: number;
    label: string;
    ordinal: number;
    categories: Category[];
}

// Legacy type alias for backward compatibility
export type DimensionCategories = DimensionWithCategories;

export interface AssetCategories {
    asset_id: number;
    categories: Category[];
}

export interface Asset {
    asset_id?: number;
    symbol: string;
    label?: string;
    price_type?: string;  // 'crypto', 'stock', 'fiat' - for price getter
    tags?: string[];
    created_at?: string;
    status?: number;
    price_getters?: AssetPriceGetter[];
    categories?: Category[];  // Categories assigned to this asset
}

export interface PriceSnapshot {
    snapshot_id: number;
    asset_id: number;
    quote_asset_id?: number;
    snapshot_time: string;
    price: number;
    source?: string;
    created_at?: string;
    asset_symbol?: string;
    asset_label?: string;
    quote_asset_symbol?: string;
    quote_asset_label?: string;
}

export interface PaginatedPriceSnapshotsResponse {
    items: PriceSnapshot[];
    total: number;
    limit: number;
    offset: number;
}

export interface RawAsset {
    symbol: string;
    source: string;
    asset_id?: number;
}

export interface RawAccount {
    id: number;
    source: string;
    label: string;
    account_id?: number;
}

// Sync Job Types
export type SyncJobStatus = 'idle' | 'running' | 'completed' | 'aborted' | 'failed';

export type ConnectorSyncStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface ConnectorProgress {
    connector_id: number;
    connector_name: string;
    account_name: string;
    status: ConnectorSyncStatus;
    test_mode: boolean;
    processed: number;
    new_entries: number;
    updated: number;
    duplicates: number;
    errors: number;
    error_message?: string;
    started_at?: string;
    finished_at?: string;
}

export interface SyncJobProgress {
    status: SyncJobStatus;
    started_at?: string;
    finished_at?: string;
    total_processed: number;
    new_entries_added: number;
    entries_updated: number;
    duplicates_skipped: number;
    errors: string[];
    error_count: number;
    current_connector?: string;
    connectors_completed: string[];
    total_connectors: number;
    abort_requested: boolean;
    error_message?: string;
    connector_statuses?: Record<string, ConnectorProgress>;
}

export interface SyncJobStartResponse {
    status: string;
    message: string;
    test_mode?: boolean;
}

export interface ConnectorsInfo {
    available_connectors: string[];
    connector_count: number;
}

// Config Types
export interface ConfigStatus {
    test_mode: boolean;
    mode_label: string;
}

// P&L Types
export type CostMethod = `${CostMethodEnum}`;
export type LotMode = `${LotModeEnum}`;

/**
 * Asset reference containing both ID and display name.
 * Used throughout P&L responses for asset identification.
 */
export interface AssetRef {
    id: number;
    name: string;  // Asset symbol/name for display
}

export interface PnLCalculateRequest {
    lot_method: CostMethod;
    lot_mode: LotMode;
    base_currency_symbol: string;
    residual_tolerance_pct: number;
    allow_negative_balances: boolean;
}

export interface RealizedPnLEntry {
    asset: AssetRef;  // Asset reference with id and name
    // Deprecated: use asset.id and asset.name instead
    asset_id?: number;
    asset_symbol?: string;
    qty: number;
    proceeds_in_base: number;
    cost_basis_in_base: number;
    pnl_in_base: number;
    disposal_taxable: boolean;  // Whether this disposal is a taxable event
    transaction_id?: number;
    unit_id?: number;  // CalculationUnit that triggered this P&L
    realized_at: string;
    holding_period_days?: number;
}

export interface BalanceEntry {
    account_id?: number;
    asset: AssetRef;  // Asset reference with id and name
    // Deprecated: use asset.id and asset.name instead
    asset_id?: number;
    asset_symbol?: string;
    qty: number;  // Current holdings
    cost_basis_in_base: number;
    avg_unit_cost_in_base: number;  // Average cost per unit
    lot_count?: number;  // Number of lots for this balance
}

// Price API types
export interface PriceResponse {
    asset: AssetRef;  // Asset reference with id and name
    // Deprecated - kept for backward compat
    asset_id?: number;
    asset_symbol?: string;
    price: number | null;
    price_quote: string;
    fetched_at?: string;
    source?: string;
    error?: string;  // Error message if price fetch failed
    // Staleness/fallback fields
    is_fallback?: boolean;  // True if fallback price was used
    is_stale?: boolean;  // True if price is outside staleness window
    actual_price_date?: string;  // The actual date of the price used
    staleness_days?: number;  // Days between requested and actual price date
    warning?: string;  // Warning message for stale prices
}

export interface PricesResponse {
    prices: PriceResponse[];
    base_currency: string;
    fetched_at: string;
    successful_count: number;
    failed_count: number;
    warning?: string;
}

// Alias for balances API
export type BalanceResponse = BalanceEntry[];

export interface PnLWarning {
    warning_type: string;
    message: string;
    timestamp?: string;  // When the warning occurred
    transaction_id?: number;
    unit_id?: number;  // CalculationUnit where warning occurred
    unit_label?: string;  // Human-readable unit description
    asset_id?: number;
    asset_symbol?: string;
}

// Cost lot from API
export interface CostLotEntry {
    cost_lot_id: number;
    asset?: AssetRef;  // Asset reference with id and name (new)
    asset_id?: number;  // Deprecated: use asset.id
    asset_symbol?: string;  // Deprecated: use asset.name
    account_id?: number;
    account_name?: string;
    qty_original: number;
    qty_remaining: number;
    qty_consumed: number;
    unit_cost_in_base: number;
    total_cost_in_base: number;
    remaining_cost_in_base: number;
    acquired_at: string;
    origin_transaction_id?: number;  // Transaction that created this lot
    origin_unit_id?: number;  // CalculationUnit that created this lot
    is_zero_cost: boolean;
    is_negative?: boolean;  // True if this is a negative lot (debt)
    is_fully_settled?: boolean;  // True if negative lot is fully settled
    notes?: string;  // Additional info (e.g., settlement details)
    // Settlement tracking for negative lots
    total_settled?: number;  // Amount already settled
    settlement_count?: number;  // Number of settlements
}

// Settlement record from API (audit trail for negative lot settlements)
export interface SettlementEntry {
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

// Cost lot event types for audit trail
export type LotEventType = 'created' | 'consumed' | 'settled' | 'transferred' | 'adjusted';

// Cost lot event from API (audit trail for lot lifecycle)
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

// Consumed slice detail from API
export interface ConsumedSliceEntry {
    cost_lot_id: number;
    quantity: number;
    unit_cost_in_base: number;
    total_cost_in_base: number;
    acquired_at: string;
    holding_period_days?: number;
    consumed_by_transaction_id?: number;  // Transaction that consumed this slice
}

// Realized entry detail from API
export interface RealizedEntryDetailEntry {
    asset?: AssetRef;  // New format from backend
    asset_id?: number;  // Legacy/fallback
    asset_symbol?: string;  // Legacy/fallback
    qty: number;
    proceeds_in_base: number;
    cost_basis_in_base: number;
    pnl_in_base: number;
    disposal_taxable: boolean;
}

// Unit warning from API
export interface UnitWarningEntry {
    warning_type: string;
    message: string;
    transaction_id?: number;
    unit_id?: number;
    unit_label?: string;
    asset_id?: number;
    asset_symbol?: string;
}

// Transaction leg with origin transaction reference
export interface TransactionLegDetail {
    transaction_id: number;
    asset: { id: number; name: string };
    qty: number;
    direction: string; // "outflow", "inflow", "fee"
}

// Cost basis tracking grouping
export interface CostBasisTracking {
    lots: CostLotEntry[];
    consumed: ConsumedSliceEntry[];
    settlements: SettlementEntry[];
}

// Processed calculation unit from API (for audit view)
export interface ProcessedUnitEntry {
    unit_id?: number | null;
    unit_label?: string;
    pattern?: string | null;  // transfer, swap, split, unknown
    timestamp: string;

    // Transaction legs (instead of transaction_ids and asset arrays)
    outflows: TransactionLegDetail[];
    inflows: TransactionLegDetail[];
    fees: TransactionLegDetail[];

    // Cost basis tracking (grouped lots, consumed slices, settlements)
    cost_basis: CostBasisTracking;

    // Realized P&L entries
    realized_entries: RealizedEntryDetailEntry[];

    // Warnings
    warnings: UnitWarningEntry[];

    // P&L summary
    realized_pnl_in_base: number;
    is_disposal_taxable: boolean;
}

export interface PnLPreviewResponse {
    total_realized_pnl: number;
    lot_method: string;
    lot_mode: string;
    base_currency_id: number;
    base_currency_symbol: string;

    // Fee summary (from calculation preview)
    total_fees_in_base: number;
    fee_entry_count: number;

    // ID arrays for tab title counts (before lazy loading full data)
    unit_ids: number[];           // Length = units count
    cost_lot_ids: number[];       // Length = lots created count  
    consumed_slice_ids: number[]; // Length = consumed slices count
    realized_pnl_ids: number[];   // Length = realized P&L entries count
    warning_ids: number[];        // Length = warnings count
    settlement_ids: number[];     // Length = settlements count

    // Full data (populated by lazy loading, empty initially)
    realized_pnl: RealizedPnLEntry[];
    cost_lots: CostLotEntry[];
    consumed_slices: ConsumedSliceEntry[];  // Consumed lot slices
    warnings: PnLWarning[];
    balances: BalanceEntry[];  // Kept for backwards compatibility, now always empty
    settlements: SettlementEntry[];
    calculation_units: ProcessedUnitEntry[];
}

// Draft version response for lazy loading
export interface PnLDraftResponse {
    version_id: number;
    status: 'draft' | 'committed';
    expires_at?: string;
    // Summary only
    total_realized_pnl: number;
    // ID arrays for counts (derive count from length)
    unit_ids: number[];
    cost_lot_ids: number[];
    consumed_slice_ids: number[];
    warning_ids: number[];
    // Config used
    lot_method: string;
    lot_mode: string;
    base_currency_id: number;
    base_currency_symbol: string;
}

// Paginated response for version queries
export interface PaginatedResponse<T> {
    total: number;
    page: number;
    page_size: number;
    items: T[];
}

// =============================================================================
// Validation Summary (Data Health Check)
// =============================================================================

/**
 * Fuzzy match suggestion for inline fixes in Data Health Check
 */
export interface SuggestionInfo {
    id: number;
    name: string;
    confidence: number;
}

/**
 * Raw asset that needs mapping (for inline fixing)
 */
export interface RawAssetIssue {
    symbol: string;
    source: string;
    affected_count: number;
    suggestion?: SuggestionInfo | null;
}

/**
 * Raw account that needs mapping (for inline fixing)
 */
export interface RawAccountIssue {
    id: number;
    label: string;
    source: string;
    affected_count: number;
    suggestion?: SuggestionInfo | null;
}

/**
 * Issue type enum for transaction-centric issues
 */
export type IssueType = 'asset' | 'account' | 'price_quote' | 'fee_quote';

/**
 * A single data issue for a specific transaction.
 * Used for transaction-centric display with inline fix actions.
 */
export interface TransactionIssue {
    // Transaction info (compact display)
    transaction_id: number;
    date_time: string;
    direction: string;
    quantity: number;
    source_asset_symbol: string;
    source: string;
    
    // Issue details
    issue_type: IssueType;
    raw_value: string;
    
    // Fix suggestion
    suggestion?: SuggestionInfo | null;
}

/**
 * Response from /transactions/data-health-check endpoint.
 * Powers "Data Health Check" badges and drawer UI with inline fixing.
 */
export interface DataHealthCheckResponse {
    // Transaction counts by review status
    total_count: number;
    valid_count: number;
    pending_count: number;
    invalid_count: number;
    
    // Missing required data counts
    missing_asset_count: number;
    missing_account_count: number;
    missing_price_quote_count: number;
    missing_fee_quote_count: number;
    
    // Bundle suggestions
    bundle_suggestions_count: number;
    
    // Computed flags
    has_issues: boolean;
    total_issues: number;
    
    // [DEPRECATED] Grouped detail lists - use issues_list instead
    missing_assets_detail?: RawAssetIssue[] | null;
    missing_accounts_detail?: RawAccountIssue[] | null;
    missing_price_quotes_detail?: RawAssetIssue[] | null;
    missing_fee_quotes_detail?: RawAssetIssue[] | null;
    
    // Transaction-centric issue list (preferred)
    issues_list?: TransactionIssue[] | null;
    issues_total_count: number;
    issues_page: number;
    issues_per_page: number;
}

/**
 * @deprecated Use DataHealthCheckResponse instead
 * Kept for backward compatibility during migration
 */
export interface ValidationSummary {
    // Transaction counts by review status
    total_count: number;
    valid_count: number;
    pending_count: number;
    invalid_count: number;
    
    // Missing required data counts
    missing_asset_count: number;
    missing_account_count: number;
    missing_price_quote_count: number;
    missing_fee_quote_count: number;
    
    // Bundle suggestions
    bundle_suggestions_count: number;
    
    // Computed flags
    has_issues: boolean;
    total_issues: number;
}

/**
 * Get the default API URL based on the current frontend port.
 * This provides safe fallback behavior when VITE_API_URL is not set.
 * 
 * Port mapping:
 * - 5173 (Vite dev server) → Backend on 8000 (dev)
 * - 3001 (Docker test) → Backend on 8001 (test)
 * - 3000 (Docker prod) → Backend on 8080 (prod)
 */
const getDefaultApiUrl = (): string => {
    // Server-side rendering guard (not applicable for this SPA, but good practice)
    if (typeof window === 'undefined') {
        return 'http://localhost:8000';
    }

    const port = window.location.port;

    // Map frontend port to corresponding backend port
    switch (port) {
        case '5173': // Vite dev server
            return 'http://localhost:8000';
        case '3001': // Docker test environment
            return 'http://localhost:8001';
        case '3000': // Docker prod environment
            return 'http://localhost:8080';
        default:
            // Fallback for unknown ports (e.g., running on different port)
            console.warn(`Unknown frontend port: ${port}. Defaulting to dev backend (8000).`);
            return 'http://localhost:8000';
    }
};

/**
 * Backend API URL
 * 
 * Priority:
 * 1. VITE_API_URL environment variable (set at Docker build time)
 * 2. Runtime detection based on window.location.port (safe fallback)
 * 
 * This prevents dangerous cross-environment connections (e.g., prod frontend → dev backend)
 */
export const API_URL = import.meta.env.VITE_API_URL || getDefaultApiUrl();

