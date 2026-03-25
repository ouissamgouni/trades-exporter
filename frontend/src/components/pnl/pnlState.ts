/**
 * PnL State Management
 *
 * Centralizes all PnLPanel state into a single useReducer,
 * replacing 50+ individual useState calls.
 *
 * Grouped by domain:
 *  - Calculation workflow (status, config, flags)
 *  - Version management (currentVersionId, status, created_at)
 *  - Reference data (accounts, dimensions)
 *  - Balance data (account balances, loading flags)
 *  - PnL results (summary, assets, fees, warnings)
 *  - Prices (prices array, refresh state)
 *  - Navigation (viewMode, currentView, selected asset)
 *  - UI panels (drawers, slide panels, dialogs)
 *  - Filters (groupBy, dimension, threshold, timeframe)
 */

import type { Account, PriceResponse, DimensionWithCategories } from '../../types';
import type { Range } from './TotalReturnScorecard';
import type { GroupBy } from '../../hooks/useChartData';
import type { CalculationMode } from './CalculationContext';
import type {
    CalculationConfig,
    CalculationStatus,
    PnLSummary,
    AssetPnLRow,
    RealizedPnLRow,
    PnLImpactEvent,
    FeeEntry,
    PnLWarningItem,
    PnLView,
    AccountBalanceBreakdown,
} from './types';


// ═══════════════════════════════════════════════════════════════════════════
// Drill-Down State — progressive disclosure navigation
// ═══════════════════════════════════════════════════════════════════════════

export type DrillMetric = 'total_return' | 'cost_basis' | 'unrealized' | 'realized' | 'fees' | 'warnings';
export type DrillEntityType = 'asset' | 'category' | 'account';
export type DrillHighlightCard = 'lots' | 'realized' | 'fees' | 'warnings' | 'events' | 'transactions';

export interface DrillBreadcrumb {
    label: string;
    /** Snapshot of drill state at this breadcrumb level (without breadcrumbs to avoid recursion) */
    drillSnapshot: DrillSnapshot;
}

export interface DrillSnapshot {
    level: 0 | 1 | 2;
    period?: Range;
    dateFrom?: string;
    dateTo?: string;
    metric?: DrillMetric;
    entityType?: DrillEntityType;
    entityId?: number;
    entityLabel?: string;
    assetId?: number;
    assetSymbol?: string;
    accountFilter?: number;
    highlightCard?: DrillHighlightCard;
}

export interface DrillDownState {
    /** Current drill depth: 0=portfolio, 1=filtered, 2=asset audit */
    level: 0 | 1 | 2;
    /** Period context */
    period?: Range;
    dateFrom?: string;
    dateTo?: string;
    /** Which metric was clicked to enter L1 */
    metric?: DrillMetric;
    /** Entity filter (category/account performer click) */
    entityType?: DrillEntityType;
    entityId?: number;
    entityLabel?: string;
    /** Asset for L2 */
    assetId?: number;
    assetSymbol?: string;
    /** Optional account scope within L2 */
    accountFilter?: number;
    /** Visual hint: which stats card to highlight at L2 */
    highlightCard?: DrillHighlightCard;
    /** Navigation breadcrumbs */
    breadcrumbs: DrillBreadcrumb[];
}

/** Compute date range from period */
export function computeDateRange(period?: Range): { dateFrom?: string; dateTo?: string } {
    if (!period || period === 'all') return {};
    const now = new Date();
    const daysMap: Record<string, number> = { '3y': 1095, '1y': 365, '6m': 180, '3m': 90, '1m': 30, '1w': 7 };
    const days = daysMap[period];
    if (!days) return {};
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return { dateFrom: from.toISOString().slice(0, 10), dateTo: now.toISOString().slice(0, 10) };
}

/** Map drill metric to highlight card at L2 */
function metricToHighlight(metric?: DrillMetric): DrillHighlightCard | undefined {
    switch (metric) {
        case 'cost_basis': return 'lots';
        case 'realized': return 'realized';
        case 'fees': return 'fees';
        case 'warnings': return 'warnings';
        default: return undefined;
    }
}

export function createInitialDrillState(): DrillDownState {
    return {
        level: 0,
        breadcrumbs: [{ label: 'Portfolio', drillSnapshot: { level: 0 } }],
    };
}

/** Extract a breadcrumb snapshot (no breadcrumbs field) from a DrillDownState */
function toSnapshot(d: DrillDownState | DrillSnapshot): DrillSnapshot {
    return {
        level: d.level,
        period: d.period,
        dateFrom: d.dateFrom,
        dateTo: d.dateTo,
        metric: d.metric,
        entityType: d.entityType,
        entityId: d.entityId,
        entityLabel: d.entityLabel,
        assetId: d.assetId,
        assetSymbol: d.assetSymbol,
        accountFilter: d.accountFilter,
        highlightCard: d.highlightCard,
    };
}


// ═══════════════════════════════════════════════════════════════════════════
// Status Constants — single source of truth for magic strings
// ═══════════════════════════════════════════════════════════════════════════

/** P&L calculation lifecycle statuses */
export const PNL_STATUS = {
    IDLE: 'idle',
    CALCULATING: 'calculating',
    PREVIEW: 'preview',
    PERSISTED: 'persisted',
    ERROR: 'error',
} as const satisfies Record<string, CalculationStatus>;

/** Version persistence statuses */
export const VERSION_STATUS = {
    DRAFT: 'draft',
    COMMITTED: 'committed',
} as const satisfies Record<string, 'draft' | 'committed'>;


// ═══════════════════════════════════════════════════════════════════════════
// State Interface
// ═══════════════════════════════════════════════════════════════════════════

export interface IdCounts {
    unitCount: number;
    lotCount: number;
    consumedCount: number;
    realizedCount: number;
    feeCount: number;
    warningCount: number;
    settlementCount: number;
    eventCount: number;
}

export interface PnLState {
    // ── Calculation workflow ──
    status: CalculationStatus;
    config: CalculationConfig;
    isCalculating: boolean;
    isPersisting: boolean;
    isDeleting: boolean;
    error: string | null;
    calculationMode: CalculationMode;

    // ── Version management ──
    currentVersionId: number | null;
    currentVersionStatus: 'draft' | 'committed' | null;
    loadedVersionCreatedAt: string | null;

    // ── Reference data ──
    accounts: Account[];
    isLoadingAccounts: boolean;
    dimensions: DimensionWithCategories[];
    isLoadingCategories: boolean;

    // ── Balance data ──
    accountBalances: Map<number, AccountBalanceBreakdown[]>;
    isLoadingAccountBalances: boolean;
    isLoadingBalances: boolean;

    // ── PnL results ──
    summary: PnLSummary | null;
    pnlAssets: AssetPnLRow[];
    fees: FeeEntry[];
    warnings: PnLWarningItem[];
    warningTypeCounts: Record<string, number>;
    idCounts: IdCounts;

    // ── Prices ──
    prices: PriceResponse[];
    isRefreshingPrices: boolean;
    lastPriceRefresh: Date | null;
    loadingPriceAssetIds: Set<number>;
    showPriceDrawer: boolean;

    // ── Navigation ──
    viewMode: 'portfolio';
    currentView: PnLView;
    selectedAssetId: number | null;
    selectedAsset: AssetPnLRow | null;
    assetRealizedEntries: RealizedPnLRow[];
    initialAccountFilter: number | undefined;

    // ── UI panels ──
    showHealthConfirm: boolean;
    healthCheckIssueCount: number;
    showCustomCalcDrawer: boolean;
    showHistoryPanel: boolean;
    showImpactPanel: boolean;
    impactEvent: PnLImpactEvent | null;
    selectedTransactionId: number | null;
    isTransactionDrawerOpen: boolean;
    auditDefaultPanel: 'lots' | 'realized' | 'fees' | 'warnings' | 'events' | 'transactions' | null;
    showUnsettledNegative: boolean;
    totalUnsettledNegativeCount: number;

    // ── Filters ──
    performerGroupBy: GroupBy;
    performerDimensionId: number | null;
    deltaThreshold: number;
    timeframeRange: Range;
    showMismatchedOnly: boolean;

    // ── Drill-down navigation ──
    drill: DrillDownState;
}

// ═══════════════════════════════════════════════════════════════════════════
// Actions
// ═══════════════════════════════════════════════════════════════════════════

export type PnLAction =
    // ── Calculation workflow ──
    | { type: 'SET_STATUS'; status: CalculationStatus }
    | { type: 'SET_CONFIG'; config: CalculationConfig }
    | { type: 'PATCH_CONFIG'; partial: Partial<CalculationConfig> }
    | { type: 'SET_IS_CALCULATING'; value: boolean }
    | { type: 'SET_IS_PERSISTING'; value: boolean }
    | { type: 'SET_IS_DELETING'; value: boolean }
    | { type: 'SET_ERROR'; error: string | null }
    | { type: 'SET_CALCULATION_MODE'; mode: CalculationMode }

    // ── Version management ──
    | { type: 'SET_CURRENT_VERSION'; versionId: number | null; status?: 'draft' | 'committed' | null; createdAt?: string | null }
    | { type: 'SET_VERSION_STATUS'; status: 'draft' | 'committed' | null }

    // ── Reference data ──
    | { type: 'SET_ACCOUNTS'; accounts: Account[] }
    | { type: 'SET_IS_LOADING_ACCOUNTS'; value: boolean }
    | { type: 'SET_DIMENSIONS'; dimensions: DimensionWithCategories[] }
    | { type: 'SET_IS_LOADING_CATEGORIES'; value: boolean }

    // ── Balance data ──
    | { type: 'SET_ACCOUNT_BALANCES'; balances: Map<number, AccountBalanceBreakdown[]> }
    | { type: 'SET_IS_LOADING_ACCOUNT_BALANCES'; value: boolean }
    | { type: 'SET_IS_LOADING_BALANCES'; value: boolean }

    // ── PnL results ──
    | { type: 'SET_SUMMARY'; summary: PnLSummary | null }
    | { type: 'SET_PNL_ASSETS'; assets: AssetPnLRow[] }
    | { type: 'SET_FEES'; fees: FeeEntry[] }
    | { type: 'SET_WARNINGS'; warnings: PnLWarningItem[] }
    | { type: 'SET_WARNING_TYPE_COUNTS'; counts: Record<string, number> }
    | { type: 'SET_ID_COUNTS'; counts: IdCounts }

    // ── PnL results batch (load version in one dispatch) ──
    | {
        type: 'LOAD_PNL_RESULTS';
        summary: PnLSummary;
        assets: AssetPnLRow[];
        fees: FeeEntry[];
        warnings: PnLWarningItem[];
        warningTypeCounts: Record<string, number>;
        idCounts: IdCounts;
        versionId: number;
        versionStatus: 'draft' | 'committed';
        createdAt: string | null;
        status: CalculationStatus;
    }

    // ── Prices ──
    | { type: 'SET_PRICES'; prices: PriceResponse[] }
    | { type: 'UPSERT_PRICE'; assetId: number; price: PriceResponse }
    | { type: 'SET_IS_REFRESHING_PRICES'; value: boolean }
    | { type: 'SET_LAST_PRICE_REFRESH'; date: Date | null }
    | { type: 'SET_LOADING_PRICE_ASSET_IDS'; ids: Set<number> }
    | { type: 'REMOVE_LOADING_PRICE_ASSET_ID'; id: number }
    | { type: 'SET_SHOW_PRICE_DRAWER'; value: boolean }

    // ── Navigation ──
    | { type: 'SET_VIEW_MODE'; mode: 'portfolio' }
    | { type: 'SET_CURRENT_VIEW'; view: PnLView }
    | { type: 'NAVIGATE_TO_ASSET'; assetId: number; asset: AssetPnLRow; accountFilter?: number }
    | { type: 'NAVIGATE_BACK_TO_ASSETS' }
    | { type: 'SET_SELECTED_ASSET'; asset: AssetPnLRow | null }
    | { type: 'SET_ASSET_REALIZED_ENTRIES'; entries: RealizedPnLRow[] }

    // ── UI panels ──
    | { type: 'SET_SHOW_HEALTH_CONFIRM'; value: boolean }
    | { type: 'SET_HEALTH_CHECK_ISSUE_COUNT'; count: number }
    | { type: 'SET_SHOW_CUSTOM_CALC_DRAWER'; value: boolean }
    | { type: 'SET_SHOW_HISTORY_PANEL'; value: boolean }
    | { type: 'SET_SHOW_IMPACT_PANEL'; value: boolean; event?: PnLImpactEvent | null }
    | { type: 'SET_TRANSACTION_DRAWER'; transactionId: number | null; isOpen: boolean }
    | { type: 'SET_AUDIT_DEFAULT_PANEL'; panel: PnLState['auditDefaultPanel'] }
    | { type: 'SET_SHOW_UNSETTLED_NEGATIVE'; value: boolean }
    | { type: 'SET_TOTAL_UNSETTLED_NEGATIVE_COUNT'; count: number }

    // ── Filters ──
    | { type: 'SET_PERFORMER_GROUP_BY'; groupBy: GroupBy }
    | { type: 'SET_PERFORMER_DIMENSION_ID'; id: number | null }
    | { type: 'SET_DELTA_THRESHOLD'; threshold: number }
    | { type: 'SET_TIMEFRAME_RANGE'; range: Range }
    | { type: 'SET_SHOW_MISMATCHED_ONLY'; value: boolean }

    // ── Drill-down ──
    | { type: 'DRILL_INTO'; period?: Range; metric?: DrillMetric; entityType?: DrillEntityType; entityId?: number; entityLabel?: string; assetId?: number; assetSymbol?: string; assetLabel?: string; accountFilter?: number }
    | { type: 'DRILL_TO_ASSET'; assetId: number; assetSymbol: string; assetLabel?: string; accountFilter?: number }
    | { type: 'DRILL_BACK' }
    | { type: 'DRILL_TO_BREADCRUMB'; index: number }
    | { type: 'DRILL_RESET' }
    | { type: 'DRILL_SET_ACCOUNT_FILTER'; accountId: number | undefined }

    // ── Reset ──
    | { type: 'RESET_RESULTS' };


// ═══════════════════════════════════════════════════════════════════════════
// Initial State
// ═══════════════════════════════════════════════════════════════════════════

export function createInitialPnLState(baseCurrency: string, baseCurrencyId: number | null, initialAccountIds: number[]): PnLState {
    return {
        // Calculation workflow
        status: 'idle',
        config: {
            lot_method: 'FIFO',
            lot_mode: 'LOT_TRAVEL',
            base_currency_symbol: baseCurrency,
            base_currency_id: baseCurrencyId,
            residual_tolerance_pct: 0.05,
            allow_negative_balances: true,
            account_ids: initialAccountIds,
            compute_residuals: false,
            crypto_swap_taxable_by_default: false,
            fee_taxable_by_default: false,
            use_price_fallback: true,
            price_staleness_window_days: 7,
        },
        isCalculating: false,
        isPersisting: false,
        isDeleting: false,
        error: null,
        calculationMode: 'new',

        // Version management
        currentVersionId: null,
        currentVersionStatus: null,
        loadedVersionCreatedAt: null,

        // Reference data
        accounts: [],
        isLoadingAccounts: false,
        dimensions: [],
        isLoadingCategories: false,

        // Balance data
        accountBalances: new Map(),
        isLoadingAccountBalances: false,
        isLoadingBalances: false,

        // PnL results
        summary: null,
        pnlAssets: [],
        fees: [],
        warnings: [],
        warningTypeCounts: {},
        idCounts: { unitCount: 0, lotCount: 0, consumedCount: 0, realizedCount: 0, feeCount: 0, warningCount: 0, settlementCount: 0, eventCount: 0 },

        // Prices
        prices: [],
        isRefreshingPrices: false,
        lastPriceRefresh: null,
        loadingPriceAssetIds: new Set(),
        showPriceDrawer: false,

        // Navigation
        viewMode: 'portfolio',
        currentView: 'summary',
        selectedAssetId: null,
        selectedAsset: null,
        assetRealizedEntries: [],
        initialAccountFilter: undefined,

        // UI panels
        showHealthConfirm: false,
        healthCheckIssueCount: 0,
        showCustomCalcDrawer: false,
        showHistoryPanel: false,
        showImpactPanel: false,
        impactEvent: null,
        selectedTransactionId: null,
        isTransactionDrawerOpen: false,
        auditDefaultPanel: null,
        showUnsettledNegative: false,
        totalUnsettledNegativeCount: 0,

        // Filters
        performerGroupBy: 'asset',
        performerDimensionId: null,
        deltaThreshold: 5,
        timeframeRange: 'all',
        showMismatchedOnly: false,

        // Drill-down
        drill: createInitialDrillState(),
    };
}


// ═══════════════════════════════════════════════════════════════════════════
// Reducer
// ═══════════════════════════════════════════════════════════════════════════

export function pnlReducer(state: PnLState, action: PnLAction): PnLState {
    switch (action.type) {
        // ── Calculation workflow ──
        case 'SET_STATUS':
            return { ...state, status: action.status };
        case 'SET_CONFIG':
            return { ...state, config: action.config };
        case 'PATCH_CONFIG':
            return { ...state, config: { ...state.config, ...action.partial } };
        case 'SET_IS_CALCULATING':
            return { ...state, isCalculating: action.value };
        case 'SET_IS_PERSISTING':
            return { ...state, isPersisting: action.value };
        case 'SET_IS_DELETING':
            return { ...state, isDeleting: action.value };
        case 'SET_ERROR':
            return { ...state, error: action.error };
        case 'SET_CALCULATION_MODE':
            return { ...state, calculationMode: action.mode };

        // ── Version management ──
        case 'SET_CURRENT_VERSION':
            return {
                ...state,
                currentVersionId: action.versionId,
                currentVersionStatus: action.status ?? state.currentVersionStatus,
                loadedVersionCreatedAt: action.createdAt ?? state.loadedVersionCreatedAt,
            };
        case 'SET_VERSION_STATUS':
            return { ...state, currentVersionStatus: action.status };

        // ── Reference data ──
        case 'SET_ACCOUNTS':
            return { ...state, accounts: action.accounts };
        case 'SET_IS_LOADING_ACCOUNTS':
            return { ...state, isLoadingAccounts: action.value };
        case 'SET_DIMENSIONS':
            return { ...state, dimensions: action.dimensions };
        case 'SET_IS_LOADING_CATEGORIES':
            return { ...state, isLoadingCategories: action.value };

        // ── Balance data ──
        case 'SET_ACCOUNT_BALANCES':
            return { ...state, accountBalances: action.balances };
        case 'SET_IS_LOADING_ACCOUNT_BALANCES':
            return { ...state, isLoadingAccountBalances: action.value };
        case 'SET_IS_LOADING_BALANCES':
            return { ...state, isLoadingBalances: action.value };

        // ── PnL results ──
        case 'SET_SUMMARY':
            return { ...state, summary: action.summary };
        case 'SET_PNL_ASSETS':
            return { ...state, pnlAssets: action.assets };
        case 'SET_FEES':
            return { ...state, fees: action.fees };
        case 'SET_WARNINGS':
            return { ...state, warnings: action.warnings };
        case 'SET_WARNING_TYPE_COUNTS':
            return { ...state, warningTypeCounts: action.counts };
        case 'SET_ID_COUNTS':
            return { ...state, idCounts: action.counts };

        // ── PnL results batch (avoids multiple renders on version load) ──
        case 'LOAD_PNL_RESULTS':
            return {
                ...state,
                summary: action.summary,
                pnlAssets: action.assets,
                fees: action.fees,
                warnings: action.warnings,
                warningTypeCounts: action.warningTypeCounts,
                idCounts: action.idCounts,
                currentVersionId: action.versionId,
                currentVersionStatus: action.versionStatus,
                loadedVersionCreatedAt: action.createdAt,
                status: action.status,
                error: null,
            };

        // ── Prices ──
        case 'SET_PRICES':
            return { ...state, prices: action.prices };
        case 'UPSERT_PRICE': {
            const idx = state.prices.findIndex(p => p.asset.id === action.assetId);
            if (idx >= 0) {
                const next = [...state.prices];
                next[idx] = action.price;
                return { ...state, prices: next };
            }
            return { ...state, prices: [...state.prices, action.price] };
        }
        case 'SET_IS_REFRESHING_PRICES':
            return { ...state, isRefreshingPrices: action.value };
        case 'SET_LAST_PRICE_REFRESH':
            return { ...state, lastPriceRefresh: action.date };
        case 'SET_LOADING_PRICE_ASSET_IDS':
            return { ...state, loadingPriceAssetIds: action.ids };
        case 'REMOVE_LOADING_PRICE_ASSET_ID': {
            const next = new Set(state.loadingPriceAssetIds);
            next.delete(action.id);
            return { ...state, loadingPriceAssetIds: next };
        }
        case 'SET_SHOW_PRICE_DRAWER':
            return { ...state, showPriceDrawer: action.value };

        // ── Navigation ──
        case 'SET_VIEW_MODE':
            return { ...state, viewMode: action.mode };
        case 'SET_CURRENT_VIEW':
            return { ...state, currentView: action.view };
        case 'NAVIGATE_TO_ASSET':
            return {
                ...state,
                currentView: 'asset-detail',
                selectedAssetId: action.assetId,
                selectedAsset: action.asset,
                initialAccountFilter: action.accountFilter,
            };
        case 'NAVIGATE_BACK_TO_ASSETS':
            return {
                ...state,
                currentView: 'assets',
                selectedAssetId: null,
                selectedAsset: null,
                assetRealizedEntries: [],
                initialAccountFilter: undefined,
            };
        case 'SET_SELECTED_ASSET':
            return { ...state, selectedAsset: action.asset };
        case 'SET_ASSET_REALIZED_ENTRIES':
            return { ...state, assetRealizedEntries: action.entries };

        // ── UI panels ──
        case 'SET_SHOW_HEALTH_CONFIRM':
            return { ...state, showHealthConfirm: action.value };
        case 'SET_HEALTH_CHECK_ISSUE_COUNT':
            return { ...state, healthCheckIssueCount: action.count };
        case 'SET_SHOW_CUSTOM_CALC_DRAWER':
            return { ...state, showCustomCalcDrawer: action.value };
        case 'SET_SHOW_HISTORY_PANEL':
            return { ...state, showHistoryPanel: action.value };
        case 'SET_SHOW_IMPACT_PANEL':
            return {
                ...state,
                showImpactPanel: action.value,
                impactEvent: action.event !== undefined ? action.event : (action.value ? state.impactEvent : null),
            };
        case 'SET_TRANSACTION_DRAWER':
            return {
                ...state,
                selectedTransactionId: action.transactionId,
                isTransactionDrawerOpen: action.isOpen,
            };
        case 'SET_AUDIT_DEFAULT_PANEL':
            return { ...state, auditDefaultPanel: action.panel };
        case 'SET_SHOW_UNSETTLED_NEGATIVE':
            return { ...state, showUnsettledNegative: action.value };
        case 'SET_TOTAL_UNSETTLED_NEGATIVE_COUNT':
            return { ...state, totalUnsettledNegativeCount: action.count };

        // ── Filters ──
        case 'SET_PERFORMER_GROUP_BY':
            return { ...state, performerGroupBy: action.groupBy };
        case 'SET_PERFORMER_DIMENSION_ID':
            return { ...state, performerDimensionId: action.id };
        case 'SET_DELTA_THRESHOLD':
            return { ...state, deltaThreshold: action.threshold };
        case 'SET_TIMEFRAME_RANGE':
            return { ...state, timeframeRange: action.range };
        case 'SET_SHOW_MISMATCHED_ONLY':
            return { ...state, showMismatchedOnly: action.value };

        // ── Drill-down ──
        case 'DRILL_INTO': {
            const prev = state.drill;
            const dates = computeDateRange(action.period ?? prev.period);
            const isAssetDirect = action.assetId != null && !action.entityType && !action.metric;
            const level: 0 | 1 | 2 = isAssetDirect ? 2 : 1;
            const newDrill: DrillDownState = {
                level,
                period: action.period ?? prev.period,
                dateFrom: dates.dateFrom,
                dateTo: dates.dateTo,
                metric: action.metric,
                entityType: action.entityType,
                entityId: action.entityId,
                entityLabel: action.entityLabel,
                assetId: isAssetDirect ? action.assetId : undefined,
                assetSymbol: isAssetDirect ? action.assetSymbol : undefined,
                accountFilter: action.accountFilter,
                highlightCard: metricToHighlight(action.metric),
                breadcrumbs: [
                    { label: 'Portfolio', drillSnapshot: { level: 0 } },
                ],
            };
            // Build breadcrumb label for L1
            const l1Label = action.entityLabel
                ?? action.metric?.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
                ?? (action.period ? action.period.toUpperCase() : undefined);
            if (l1Label) {
                newDrill.breadcrumbs.push({
                    label: l1Label,
                    drillSnapshot: toSnapshot(newDrill),
                });
            }
            // If direct to asset, add L2 breadcrumb
            if (isAssetDirect && action.assetSymbol) {
                const assetCrumbLabel = action.assetLabel
                    ? `${action.assetLabel} (${action.assetSymbol})`
                    : action.assetSymbol;
                newDrill.breadcrumbs.push({
                    label: assetCrumbLabel,
                    drillSnapshot: toSnapshot(newDrill),
                });
            }
            return { ...state, drill: newDrill };
        }

        case 'DRILL_TO_ASSET': {
            const prev = state.drill;
            const assetCrumbLabel = action.assetLabel
                ? `${action.assetLabel} (${action.assetSymbol})`
                : action.assetSymbol;
            const newDrill: DrillDownState = {
                ...prev,
                level: 2,
                assetId: action.assetId,
                assetSymbol: action.assetSymbol,
                accountFilter: action.accountFilter,
                highlightCard: metricToHighlight(prev.metric),
                breadcrumbs: [
                    ...prev.breadcrumbs,
                    {
                        label: assetCrumbLabel,
                        drillSnapshot: toSnapshot({
                            ...prev,
                            level: 2,
                            assetId: action.assetId,
                            assetSymbol: action.assetSymbol,
                            accountFilter: action.accountFilter,
                            highlightCard: metricToHighlight(prev.metric),
                        }),
                    },
                ],
            };
            return { ...state, drill: newDrill };
        }

        case 'DRILL_BACK': {
            const crumbs = state.drill.breadcrumbs;
            if (crumbs.length <= 1) return { ...state, drill: createInitialDrillState() };
            const target = crumbs[crumbs.length - 2];
            return {
                ...state,
                drill: {
                    ...target.drillSnapshot,
                    breadcrumbs: crumbs.slice(0, -1),
                },
            };
        }

        case 'DRILL_TO_BREADCRUMB': {
            const idx = action.index;
            const crumbs = state.drill.breadcrumbs;
            if (idx < 0 || idx >= crumbs.length) return state;
            const target = crumbs[idx];
            return {
                ...state,
                drill: {
                    ...target.drillSnapshot,
                    breadcrumbs: crumbs.slice(0, idx + 1),
                },
            };
        }

        case 'DRILL_RESET':
            return { ...state, drill: createInitialDrillState() };

        case 'DRILL_SET_ACCOUNT_FILTER':
            return { ...state, drill: { ...state.drill, accountFilter: action.accountId } };

        // ── Reset ──
        case 'RESET_RESULTS':
            return {
                ...state,
                summary: null,
                pnlAssets: [],
                fees: [],
                warnings: [],
                warningTypeCounts: {},
                idCounts: { unitCount: 0, lotCount: 0, consumedCount: 0, realizedCount: 0, feeCount: 0, warningCount: 0, settlementCount: 0, eventCount: 0 },
                prices: [],
                accountBalances: new Map(),
                currentVersionId: null,
                currentVersionStatus: null,
                loadedVersionCreatedAt: null,
                status: PNL_STATUS.IDLE,
                error: null,
            };

        default:
            return state;
    }
}
