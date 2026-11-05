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
};

// Type aliases using enum values for backward compatibility
export type TransactionStatus = `${ReviewStatus}`;

// V2 Architecture: Workflow status
export type WorkflowStatus = 'pending' | 'reviewed' | 'excluded';

// V2 Architecture: Taxability status
export type TaxabilityStatus = `${TaxabilityStatusEnum}`;

// Filter Response Wrapper Types
export interface ValidationWarning {
    filter_name: string;
    provided_value: string;
    reason: string;
    severity: 'warning' | 'error';
}

export interface AppliedFilters {
    review_statuses: string[];
    taxability?: string;
    sources: string[];
    account_ids: (number | string)[];
    from_account_ids: (number | string)[];
    to_account_ids: (number | string)[];
    related_account_ids: (number | string)[];
    asset_ids: number[];
    related_asset_ids: number[];
    attributed_asset_ids: number[];
    category_ids: number[];
    transaction_types: string[];
    directions: string[];
    connector_run_ids: number[];
    tag_keys: string[];
    networks: string[];
    date_from?: string;
    date_to?: string;
    pnl_cal_version?: number;
    pnl_cal_inclusions_status?: string;
}

export interface FilterMetadata {
    applied_filters: AppliedFilters;
    validation_warnings: ValidationWarning[];
    total_count: number;
    filtered_count: number;
    limit: number;
    offset: number;
}

export interface TransactionListResponse {
    results: Transaction[];
    metadata: FilterMetadata;
}

export interface Account {
    id: number;
    name: string;
    account_type: `${AccountType}`;
    envelope?: string | null;
    address_or_identifier?: string;
    group?: string;
    tags: Record<string, any>[];
    owned: boolean;
    enabled: boolean;
    live_balance_eligible?: boolean;
    color?: string;
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
    color?: string;
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

export interface ConnectorChainOption {
    /** Value stored in connector config.chain (provider-specific, e.g. "eth") */
    value: string;
    canonical: string;
    label: string;
}

export type ConnectorTypeGroup = 'exchange' | 'evm' | 'chain' | 'app' | 'file';

export interface ConnectorTypeInfo {
    type: string;
    category: `${ConnectorCategory}`;
    display_name: string;
    supported_chains?: string[];
    required_config: string[];
    optional_config: string[];
    supports_balance?: boolean;
    is_file_connector?: boolean;
    group?: ConnectorTypeGroup;
    chains?: ConnectorChainOption[];
    status?: 'active' | 'legacy' | 'degraded';
    status_note?: string | null;
    degraded_chains?: string[];
    recommended_for?: string[];
    required_env?: string[];
    missing_env?: string[];
}

/**
 * Lightweight asset reference for embedding in transaction responses.
 * Contains minimal fields for display without relationships.
 * Different from P&L's AssetRef which uses (id, name) fields.
 */
export interface AssetRef {
    id?: number | null;
    symbol?: string | null;
    label?: string | null;
    source_symbol?: string | null;
}

export interface Transaction {
    id: number;
    raw_transaction_id?: number;
    asset_id?: number | null;
    price_quote_asset_id?: number | null;
    fee_quote_asset_id?: number | null;
    attributed_asset_id?: number | null;
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
    source_attributed_asset_symbol?: string;
    // Nested asset references (preferred for display)
    linked_asset?: AssetRef | null;
    price_quote_asset?: AssetRef | null;
    fee_quote_asset?: AssetRef | null;
    attributed_asset?: AssetRef | null;
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
    // Connector metadata
    sync_connector_run_id?: number | null;
    connector_name?: string | null;
    run_datetime?: string | null;
    // FR tax override indicator
    has_fr_tax_override?: boolean;
}

// V2 Architecture: Calculation Unit patterns (unified concept for grouping transactions)
export type UnitPattern = `${UnitPatternEnum}`;
// Backward compatibility alias
export type BundlePattern = 'internal_transfer' | 'swap';

// V2 Architecture: CalculationUnit (replaces Bundle concept)
export interface CalculationUnit {
    id: number;
    label?: string;
    pattern?: UnitPattern;
    notes?: string;
    taxability_override?: TaxabilityStatus;
    confidence?: number;
    reason?: string;
    metadata?: Record<string, any> | null;
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
    fingerprint: string;
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

// Classification suggestion from GroupClassifier
export type GroupPattern = 'internal_transfer' | 'swap' | 'unknown';

export interface ClassificationSuggestion {
    pattern: GroupPattern;
    confidence: number;
    reason: string;
    suggested_taxability_status: string;
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
    network?: string;
    // Nested asset references (preferred for display)
    asset?: AssetRef | null;
    price_quote_asset?: AssetRef | null;
    fee_quote_asset?: AssetRef | null;
    // Extended fields for enhanced display
    account_id?: number;
    account_name?: string;
    price?: number;
    total?: number;
    fee?: number;
    from_account_name?: string;
    to_account_name?: string;
    source_from_account?: string;
    source_to_account?: string;
    source_transaction_type?: string;
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
    isin?: string | null;
    price_type?: string;  // 'crypto', 'stock', 'fiat' - for price getter
    tags?: Record<string, any>[];
    created_at?: string;
    status?: number;
    denomination_currency_id?: number | null;
    denomination_currency?: { asset_id: number; symbol: string; label?: string | null } | null;
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

// ============================================================================
// Price Health Types
// ============================================================================

export interface PriceHealthRow {
    asset_id: number;
    symbol: string;
    label?: string | null;
    last_price: number;
    last_source?: string | null;
    last_updated: string;
    first_snapshot: string;
    total_snapshots: number;
    days_stale: number;
    is_flatline: boolean;
    status: 'healthy' | 'warning' | 'stale' | 'no_transactions';
    has_transactions: boolean;
    sparkline: number[];
    quote_currencies: Array<{ asset_id: number; symbol: string }>;
}

export interface PriceHealthResponse {
    items: PriceHealthRow[];
    staleness_threshold_days: number;
    summary: { healthy: number; warning: number; stale: number };
}

export interface PriceTimeseriesPoint {
    date: string;
    price: number;
}

export interface PriceTimeseriesAsset {
    asset_id: number;
    symbol: string;
    label?: string | null;
    points: PriceTimeseriesPoint[];
}

export interface PriceTimeseriesResponse {
    assets: PriceTimeseriesAsset[];
}

// ── Gap Detection ──

export interface GapRange {
    start_date: string;
    end_date: string;
    missing_days_count: number;
    last_known_price?: number | null;
    last_known_price_date?: string | null;
    last_known_source?: string | null;
}

export interface GapDetectionResponse {
    asset_id: number;
    symbol: string;
    price_type?: string | null;
    total_expected: number;
    total_covered: number;
    coverage_pct: number;
    gaps: GapRange[];
}

export interface GapSummaryItem {
    asset_id: number;
    symbol: string;
    gap_count: number;
    total_missing_days: number;
}

export interface GapSummaryResponse {
    items: GapSummaryItem[];
}

export interface GapCandidatesResponse {
    items: GapDetectionResponse[];
}

export interface BackfillRequest {
    asset_id: number;
    date_from: string;
    date_to: string;
    quote_asset_id?: number | null;
}

export interface BackfillFetchedItem {
    date: string;
    price: number;
    source: string;
}

export interface BackfillFailedItem {
    date: string;
    error: string;
}

export interface BackfillResponse {
    asset_id: number;
    fetched: BackfillFetchedItem[];
    failed: BackfillFailedItem[];
}

export interface BulkManualRequest {
    asset_id: number;
    quote_asset_id?: number | null;
    date_from: string;
    date_to: string;
    price: number;
    source?: string;
    force?: boolean;
    interpolate?: boolean;
    price_start?: number | null;
    price_end?: number | null;
}

export interface BulkManualResponse {
    asset_id: number;
    created_count: number;
    skipped_count: number;
    overwritten_count: number;
}

export interface ExistingPriceItem {
    date: string;
    price: number;
    source?: string | null;
}

export interface CheckExistingResponse {
    asset_id: number;
    count: number;
    items: ExistingPriceItem[];
}

export interface TestFetchResponse {
    asset_id: number;
    date: string;
    price: number;
    source: string;
    quote_currency: string;
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
    network?: string;
    account_id?: number | null;
    transaction_count?: number;
    dismissed?: boolean;
    dismissed_at?: string;
    dismissed_reason?: string;
}

// Sync Job Types
export type SyncJobStatus = 'idle' | 'pending' | 'running' | 'completed' | 'warning' | 'aborted' | 'failed';

export type ConnectorSyncStatus = 'pending' | 'running' | 'completed' | 'warning' | 'failed' | 'skipped' | 'queued';

export type PipelineStage = 'fetch' | 'transfer_detection' | 'asset_enrichment' | 'persistence';

export interface LogEntry {
    timestamp: string;
    level: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
    message: string;
}

export interface StageStats {
    processed: number;
    success: number;
    failed: number;
}

export interface ConnectorProgress {
    connector_id: number;
    connector_run_id?: number;
    connector_type: string;
    account_name: string;
    account_type?: string;
    account_group?: string;
    status: ConnectorSyncStatus;
    test_mode: boolean;
    processed: number;
    fetched_count: number;  // Items fetched from API (updated during fetch phase)
    new_count: number;
    updated_count: number;
    skipped_count: number;
    error_count: number;  // Track error count for real-time display
    error?: string;
    started_at?: string;
    finished_at?: string;
    // New detailed progress fields
    current_operation?: string;
    operation_progress: number;
    operation_total: number;
    pipeline_stage?: PipelineStage;
    stage_stats?: Record<PipelineStage, StageStats>;
    logs?: LogEntry[];
    // Legacy field names for backward compatibility
    new_entries?: number;
    updated?: number;
    duplicates?: number;
    errors?: number;
    error_message?: string;
    connector_name?: string;
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
    job_id?: number; // Persisted job ID
    renormalize?: boolean;
}

// ============================================================================
// Job History Types
// ============================================================================

export interface SyncJobSummary {
    id: number;
    status: SyncJobStatus;
    started_at?: string;
    finished_at?: string;
    total_connectors: number;
    total_processed: number;
    total_new: number;
    total_updated: number;
    total_skipped: number;
    total_errors: number;
    error_message?: string;
    renormalize?: boolean;
    connector_runs?: ConnectorRunSummary[];
}

export interface ConnectorRunSummary {
    id: number;
    connector_id: number;
    connector_type?: string;
    account_name?: string;
    status: ConnectorSyncStatus;
    test_mode: boolean;
    started_at?: string;
    finished_at?: string;
    processed_count: number;
    synced_count: number;
    updated_count: number;
    skipped_count: number;
    error_count: number;
}

export interface SyncJobDetail {
    id: number;
    status: SyncJobStatus;
    started_at?: string;
    finished_at?: string;
    total_connectors: number;
    total_processed: number;
    total_new: number;
    total_updated: number;
    total_skipped: number;
    total_errors: number;
    error_message?: string;
    renormalize?: boolean;
    config_snapshot?: Record<string, any>;
    connector_runs: ConnectorRunSummary[];
}

export interface JobHistoryResponse {
    jobs: SyncJobSummary[];
    total: number;
    limit: number;
    offset: number;
}

export interface ConnectorRunDetail {
    id: number;
    job_id: number;
    connector_id: number;
    connector_type?: string;
    account_name?: string;
    status: ConnectorSyncStatus;
    test_mode: boolean;
    started_at?: string;
    finished_at?: string;
    processed_count: number;
    synced_count: number;
    updated_count: number;
    skipped_count: number;
    error_count: number;
    synced_ids: string[];
    updated_ids: string[];
    skipped_ids: string[];
    error_details: { source_transaction_id: string; error: string }[];
    logs: { timestamp: string; level: string; message: string }[];
}

export interface JobTransactionsResponse {
    transactions: {
        id: number;
        source: string;
        source_transaction_id: string;
        source_transaction_type?: string;
        date_time?: string;
        direction?: string;
        transaction_type?: string;
        source_asset_symbol?: string;
        quantity?: string;
        price?: string;
        fee?: string;
        sync_connector_run_id?: number;
    }[];
    total: number;
    limit: number;
    offset: number;
    job_id: number;
}

// Raw transaction types for viewing original API data
export interface RawTransactionResponse {
    id: number;
    source: string;
    source_transaction_id: string;
    raw_data: Record<string, unknown>;
    ingestion_time: string;
    truncated: boolean;
}

export interface BatchRawTransactionRequest {
    raw_ids: number[];
}

export interface BatchRawTransactionResponse {
    transactions: RawTransactionResponse[];
    total_requested: number;
    total_found: number;
}

export interface LookupSourceIdsRequest {
    source_transaction_ids: string[];
}

export interface LookupSourceIdsResponse {
    mapping: Record<string, number>;  // source_transaction_id -> raw_transaction_id
}

export interface SyncJobStartResponse {
    status: string;
    message: string;
    test_mode?: boolean;
    overrides_count?: number;
}

// Sync configuration types for per-sync overrides
export interface ConnectorOverride {
    connector_id: number;
    enabled?: boolean;
    test_mode?: boolean;
    test_file_path?: string;
    since_datetime?: string | null;  // ISO datetime string or null for full sync
    symbols?: string[] | null;  // Override symbols list for trade connectors
    currencies?: string[] | null;  // Override currencies list for deposit/withdrawal connectors
}

// Connector default info for sync configuration UI
export interface ConnectorDefaultInfo {
    connector_id: number;
    connector_type: string;
    account_name: string;
    display_name: string;
    supports_incremental_sync: boolean;
    default_since_datetime?: string | null;  // ISO datetime from max transaction
}

// Request payload for starting sync job with overrides
export interface SyncJobStartRequest {
    // Explicit manual trigger guard; config changes/uploads must not start sync jobs
    trigger_source: 'manual';
    // Per-connector overrides (enable/disable, test mode, since datetime, symbols/currencies)
    connector_overrides?: ConnectorOverride[];
    // If true, re-normalize from stored raw data instead of fetching from APIs
    renormalize?: boolean;
}

export interface EnabledConnector {
    connector_id: number;
    connector_type: string;
    account_id: number;
    account_name: string;
    account_type: string;
    account_enabled?: boolean;
    account_group?: string;
    enabled: boolean;
    test_mode: boolean;
    test_file_path?: string;
    sync_priority: number;
    last_sync_at?: string;
    last_sync_status?: string;
    supports_incremental_sync?: boolean;
    default_since_datetime?: string | null;
    optional_config?: string[];  // List of optional config params (symbols, currencies, etc.)
    config?: Record<string, any>;  // Full connector config (includes sync_mode, import_history, etc.)
    // File connector metadata (from registry)
    is_file_connector?: boolean;
    connector_family?: string;  // e.g., "mexc-transactions" groups API and file connectors
    display_name?: string;  // e.g., "MEXC Transactions (API)" or "MEXC Transactions (File)"
    // On-chain connector specific fields
    chain_name?: string;  // e.g., "base", "ethereum"
    wallet_address?: string;  // Wallet address for on-chain connectors
    // Last job data
    last_job_status?: string | null;
    last_job_started_at?: string | null;
    last_job_finished_at?: string | null;
    last_job_new?: number;
    last_job_updated?: number;
    last_job_errors?: number;
    last_job_error_message?: string | null;
    last_job_last_transaction?: {
        datetime: string;
        type: string;
        asset: string;
        qty: number | null;
        price: number | null;
    } | null;
    last_synced_transaction?: {
        datetime: string;
        type: string;
        asset: string;
        qty: number | null;
        price: number | null;
    } | null;
    // Start datetime from connector config (default since for sync)
    start_datetime?: string | null;
}

export interface EnabledConnectorsResponse {
    connectors: EnabledConnector[];
    count: number;
}

export interface AccountSummary {
    id: number;
    name: string;
    account_type: string;
    enabled: boolean;
    address_or_identifier?: string;  // Wallet address or exchange identifier
    group?: string;  // Visual grouping label (e.g. "Tangem EVM")
}

export interface AllConnectorsResponse {
    connectors: EnabledConnector[];
    accounts: AccountSummary[];
    connector_count: number;
    account_count: number;
}

export interface ConnectorsInfo {
    available_connectors: string[];
    connector_count: number;
}

// Config Types
export interface AppInfo {
    environment: string;
    backend_version: string;
    frontend_version?: string | null;
    db_schema_version?: string | null;
    qa_scenarios?: string[];
}

// P&L Types
export type CostMethod = `${CostMethodEnum}`;
export type LotMode = `${LotModeEnum}`;


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
    income_total_in_base?: number;  // Gross income from dividends/interest
    income_event_count?: number;  // Number of income events
    has_open_position?: boolean;
    price_fetch_eligible?: boolean;
    valuation_status?: string;
    valuation_note?: string | null;
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
    price_fetch_eligible?: boolean;
    valuation_status?: string | null;
    valuation_note?: string | null;
    skipped?: boolean;
    // Last known price (returned on error so the UI can display it)
    last_known_price?: number | null;
    last_known_price_date?: string | null;
    last_known_source?: string | null;
}


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
export type IssueType =
    | 'missing_source'
    | 'missing_source_asset'
    | 'missing_source_account'
    | 'unlinked_asset'
    | 'unlinked_account'
    | 'unlinked_price_quote'
    | 'unlinked_fee_quote'
    | 'unlinked_attributed_asset'
    | 'missing_transfer_from_account'
    | 'missing_transfer_to_account'
    | 'unlinked_transfer_from_account'
    | 'unlinked_transfer_to_account';

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
    network?: string | null;

    // Issue details
    issue_type: IssueType;
    raw_value: string;

    // Fix suggestion
    suggestion?: SuggestionInfo | null;

    // Account info (for source info column)
    account_id?: number | null;
    account_name?: string | null;
    source_account?: string | null;

    // Connector info (for source info column)
    connector_name?: string | null;
    sync_connector_run_id?: number | null;
    run_datetime?: string | null;
}

/**
 * New split endpoints for data health check
 */

/**
 * Response from /transactions/data-health-check/status endpoint.
 */
export interface TransactionStatusResponse {
    total_count: number;
    valid_count: number;
    pending_count: number;
    invalid_count: number;
    bundle_suggestions_count: number;

    // Data completeness issue counts
    missing_data_issues_count: number;
    linkage_issues_count: number;
    transfer_issues_count: number;
    duplicate_count: number;

    // Aggregated totals
    total_issues: number;
    has_issues: boolean;
}

/**
 * Pagination metadata for list endpoints.
 */
export interface PaginationMetadata {
    page: number;
    per_page: number;
    total_count: number;
}

/**
 * Response from /transactions/data-health-check/linkage-issues endpoint.
 */
export interface LinkageIssuesResponse {
    issues: TransactionIssue[];
    pagination: PaginationMetadata;
}

/**
 * Response from /transactions/data-health-check/transfer-issues endpoint.
 */
export interface TransferIssuesResponse {
    issues: TransactionIssue[];
    pagination: PaginationMetadata;
}

/**
 * Response from /transactions/data-health-check/missing-data-issues endpoint.
 */
export interface MissingDataIssuesResponse {
    issues: TransactionIssue[];
    pagination: PaginationMetadata;
}

/**
 * Response from /transactions/data-health-check/status endpoint.
 * Used by DataHealthContext for the global health badge and summary.
 */
export interface ValidationSummary {
    // Transaction counts by review status
    total_count: number;
    valid_count: number;
    pending_count: number;
    invalid_count: number;

    // Bundle suggestions
    bundle_suggestions_count: number;

    // Data completeness issue counts
    linkage_issues_count: number;
    transfer_issues_count: number;
    duplicate_count: number;

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

// ============================================================================
// Derivative Position Types
// ============================================================================

export interface DerivativePosition {
    id: number;
    account_id: number;
    exchange: string;
    coin: string;
    side: 'long' | 'short';
    status: 'open' | 'closed';
    entry_price: number;
    exit_price: number | null;
    size: number;
    remaining_size: number;
    margin_currency: string;
    realized_pnl: number;
    total_fees: number;
    opened_at: string;
    closed_at: string | null;
    open_transaction_id: number | null;
    close_transaction_ids: number[];
    // Computed fields
    net_pnl: number;
    duration_hours: number | null;
    return_pct: number | null;
    // Optional nested transactions (from detail endpoint)
    open_transaction?: Transaction;
    close_transactions?: Transaction[];
}

// ============================================================================
// File Upload Preview Types
// ============================================================================

export interface NormalizedTransactionSample {
    group_id?: string;
    source_transaction_id: string;
    date_time: string;
    transaction_type: string;
    source_transaction_type?: string;
    direction: string;
    source_asset_symbol: string;
    quantity: number;
    fee: number;
    source_fee_quote_asset_symbol?: string;
    network?: string;
    source_price?: number;
    source_price_quote_asset_symbol?: string;
    source_from_account?: string;
    source_to_account?: string;
}

export interface FileUploadDetailedPreview {
    row_count: number;
    normalized_count: number;
    date_range: {
        min_date: string | null;
        max_date: string | null;
    } | null;
    pairs?: string[];
    currencies?: string[];
    sample_rows: Record<string, unknown>[];
    sample_normalized: NormalizedTransactionSample[];
    normalization_errors: Array<{
        row_index: number;
        error: string;
    }>;
}


// ============================================================================
// Live Balance types (from connector APIs)
// ============================================================================

export interface LiveBalanceEntry {
    asset_symbol: string;
    total: string;       // Decimal as string
    available: string;
    locked: string;
    chain: string | null;
    raw: Record<string, unknown>;
}

export interface ConnectorBalance {
    connector_id: number;
    connector_type: string;
    account_id: number;
    account_name: string;
    chain: string | null;
    entries: LiveBalanceEntry[];
    fetched_at: string;
    error: string | null;
}

export interface AccountBalance {
    account_id: number;
    account_name: string;
    account_type: string;
    group: string | null;
    connector_balances: ConnectorBalance[];
}
