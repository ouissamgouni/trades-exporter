/**
 * Asset P&L Table
 *
 * Primary view showing P&L by asset with live balance comparison.
 * Principle 1: Results first – see all assets at a glance
 * Principle 2: Groups are primary – click to drill down
 *
 * Features:
 * - Combined Δ column (delta % with live balance on hover)
 * - Combined Cost column (cost basis + unit cost on hover)
 * - Combined Value column (market value + unit value on hover)
 * - Market-value slider to filter dust (default $5)
 * - Show-unmapped toggle (Switch)
 * - Expandable rows showing per-account balance breakdown
 * - Account color indicators for visual grouping
 * - Unmapped live-only assets shown at bottom when toggle on
 */

import React, { useContext, useState, useMemo, useCallback, useEffect, Fragment } from 'react';
import { Badge, Button, Input, Spinner, type BadgeColorScheme } from '../ui/primitives';
import { FiChevronRight, FiChevronDown, FiChevronLeft, FiChevronsLeft, FiChevronsRight, FiSearch, FiAlertCircle, FiGrid, FiFilter, FiX, FiList, FiCheck, FiDollarSign, FiTrendingUp, FiTrendingDown, FiColumns } from 'react-icons/fi';
import { LuInfo, LuReceipt } from 'react-icons/lu';
import { AssetDetailPanelContext } from '../../contexts/AssetDetailPanelContext';
import { AssetPnLCard } from './AssetPnLCard';
import { AccountPnLCard } from './AccountPnLCard';
import { AssetPnLRow, AccountBalanceBreakdown, UnmappedLiveAsset } from './types';
import { Account, DimensionWithCategories } from '../../types';
import type { AssetPeriodDelta } from '../../hooks/useChartData';
import { Tooltip } from '../ui/tooltip';
import { formatDateTimeLocale } from '../../utils/dateUtils';
import { ValueDisplay } from '../ValueDisplay';
import { getAccountColor } from '../../utils/accountColors';
import { DeltaBar } from './DeltaBar';
import { PnLBreakdownBar } from './PnLBreakdownBar';
import { HeroMetricsBar } from './HeroMetricsBar';
import { MetricItem, fmtCurrency, fmtCurrencySigned, realizedSubLines } from './TotalReturnScorecard';
import { TERM_HELP } from './pnlTerms';
import { computeDelta, formatPct } from './deltaUtils';
import { PRICE_STATE_LABELS } from './priceState';

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const TOTAL_COLUMNS_BY_ASSET = 10;
const TOTAL_COLUMNS_BY_ACCOUNT = 7;

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 10;

type GroupBy = 'asset' | 'account';
type DisplayMode = 'cards' | 'table';

/** Filter values for the unified filter section */
export type PnlStatusFilter = 'all' | 'with_pnl' | 'no_pnl';
export type BalanceStatusFilter = 'all' | 'mapped' | 'unmapped';

/** Aggregated row for "by account" view – one row per account */
interface AggregatedAccountRow {
    account_id: number;
    account_name: string;
    asset_count: number;
    total_cost_basis: number;
    total_market_value: number;
    total_unrealized_pnl: number;
    total_lot_count: number;
}

/** Per-asset detail row shown when an account row is expanded */
interface AccountAssetDetail {
    asset_symbol: string;
    asset_id: number | null;
    qty: number;
    cost_basis: number;
    unit_cost: number;
    market_value: number;
    unrealized_pnl: number;
    lot_count: number;
}

// ------------------------------------------------------------------
// Props
// ------------------------------------------------------------------

interface AssetPnLTableProps {
    assets: AssetPnLRow[];
    baseCurrency: string;
    onAssetClick: (assetId: number | undefined | null) => void;
    /** Callback when user clicks an account name in expanded row: navigate to asset transactions filtered by account */
    onAccountClick?: (assetId: number, accountId: number) => void;
    loading?: boolean;
    /** Per-account balance breakdown, keyed by asset ID */
    accountBalances?: Map<number, AccountBalanceBreakdown[]>;
    /** All accounts for name lookup */
    accounts?: Account[];
    /** Available dimensions with their categories (from /categories/tree) */
    dimensions?: DimensionWithCategories[];
    /** Account IDs present in current P&L results */
    availableAccountIds?: Set<number>;
    /** Category IDs present in current P&L results */
    availableCategoryIds?: Set<number>;
    /** Optional callback to load account balances on-demand when row is expanded */
    onLoadAccountBalances?: () => void;

    // --- Live balance comparison props ---
    /** Aggregated live balance by symbol (uppercase) → total qty */
    liveBalances?: Map<string, number>;
    /** Per-account live balance: symbol (uppercase) → (accountId → qty) */
    liveAccountBalances?: Map<string, Map<number, number>>;
    /** True while live balances are being fetched */
    liveBalanceLoading?: boolean;
    /** Assets that appear in live balance but have no P&L data */
    unmappedLiveAssets?: UnmappedLiveAsset[];
    /** Per-account connector error messages */
    liveAccountErrors?: Map<number, string[]>;
    /** Account IDs that were successfully fetched for live balances */
    liveFetchedAccountIds?: Set<number>;

    // --- Controlled filter props (lifted to parent for shared filtering) ---
    search?: string;
    onSearchChange?: (v: string) => void;
    minMarketValue?: number;
    onMinMarketValueChange?: (v: number) => void;
    pnlStatus?: PnlStatusFilter;
    onPnlStatusChange?: (v: PnlStatusFilter) => void;
    balanceStatus?: BalanceStatusFilter;
    onBalanceStatusChange?: (v: BalanceStatusFilter) => void;
    selectedAccountIds?: number[];
    onSelectedAccountIdsChange?: (v: number[]) => void;
    selectedCategoryIds?: number[];
    onSelectedCategoryIdsChange?: (v: number[]) => void;
    /** Hide the built-in filter section (when parent renders filters externally) */
    hideFilters?: boolean;
    /** Content to render between filters and table (e.g. view toggle, PnL bar) */
    renderAfterFilters?: React.ReactNode;
    /** When true, render only Card.Header (filters + renderAfterFilters) and hide table/cards content */
    contentHidden?: boolean;
    /** Callback when filtered count changes (so parent can display it) */
    onFilteredCountChange?: (count: number) => void;
    /** Backend-computed portfolio totals (authoritative, not affected by dust filter) */
    backendSummary?: { totalCost: number; totalUnrealized: number; totalRealized: number; totalFees: number; totalValue: number };
    /** Period delta map: assetId → AssetPeriodDelta */
    periodDeltaMap?: Map<number, AssetPeriodDelta>;
    /** Period label (e.g. "1W") for delta display */
    periodLabel?: string;
    /** PnL version ID to pass when opening asset detail panel */
    pnlVersionId?: number;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Check if price is stale (older than 1 hour) */
const isPriceStale = (fetchedAt?: string): boolean => {
    if (!fetchedAt) return false;
    const isoString = fetchedAt.endsWith('Z') ? fetchedAt : fetchedAt + 'Z';
    const fetchedTime = new Date(isoString).getTime();
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    return fetchedTime < oneHourAgo;
};

type SortField = 'asset_symbol' | 'quantity' | 'market_value' | 'cost_basis' | 'unrealized_pnl' | 'realized_pnl' | 'total_return' | 'efficiency';
type SortDirection = 'asc' | 'desc';

const SORT_FIELD_LABELS: Record<SortField, string> = {
    total_return: 'Return', market_value: 'Value', cost_basis: 'Cost',
    unrealized_pnl: 'Unrealized', realized_pnl: 'Realized', efficiency: 'Efficiency',
    asset_symbol: 'Symbol', quantity: 'Qty',
};

// ------------------------------------------------------------------
// Render helpers (combined columns)
// ------------------------------------------------------------------

/** Combined "Cost" cell: cost basis (primary) + total acquired & unit cost on hover */
export const renderCost = (
    costBasis: number,
    unitCost: number | undefined | null,
    baseCurrency: string,
    totalInvested?: number,
) => {
    const showInvested = totalInvested != null && Math.abs(totalInvested - costBasis) > 0.01;
    return (
        <Tooltip
            content={
                <div className="p-1 text-xs">
                    <div className="flex justify-between gap-3">
                        <span className="text-gray-400">Unit cost</span>
                        <span className="font-medium">
                            {unitCost != null
                                ? <ValueDisplay value={unitCost} currency={baseCurrency} />
                                : '—'}
                        </span>
                    </div>
                </div>
            }
            openDelay={200}
        >
            <div className="cursor-help">
                <span className="text-xs">
                    <ValueDisplay value={costBasis} currency={baseCurrency} />
                </span>
                {showInvested && (
                    <div className="text-[10px] leading-none text-gray-400" title={TERM_HELP.totalBought}>
                        bought <ValueDisplay value={totalInvested} currency={baseCurrency} />
                    </div>
                )}
            </div>
        </Tooltip>
    );
};

/** Combined "Value" cell: market value (primary) + unit value / price info on hover */
export const renderValue = (
    row: AssetPnLRow,
    baseCurrency: string,
) => {
    const stale = isPriceStale(row.price_fetched_at);
    const hasPrice = row.unit_value != null;
    const hasError = !!row.price_error;
    const isLoadingPrice = !!row.price_loading;
    const stateLabel = row.price_state ? PRICE_STATE_LABELS[row.price_state] : null;
    const usingFallback = row.price_state === 'failed_with_last_known' || row.price_state === 'fallback' || row.price_state === 'stale';

    if (isLoadingPrice && !hasPrice) return <Spinner size="xs" className="text-gray-400" />;

    return (
        <Tooltip
            content={
                <div className="p-2 text-xs">
                    {stateLabel && (
                        <div className="mb-1 flex justify-between gap-4">
                            <span className="text-gray-400">Status</span>
                            <span className="font-medium">{isLoadingPrice ? `${stateLabel} · refreshing…` : stateLabel}</span>
                        </div>
                    )}
                    <div className="mb-1 flex justify-between gap-4">
                        <span className="text-gray-400">Unit price</span>
                        <span className="font-medium">
                            {hasPrice
                                ? <ValueDisplay value={row.unit_value!} currency={baseCurrency} />
                                : '—'}
                        </span>
                    </div>
                    <div className="mb-1 flex justify-between gap-4">
                        <span className="text-gray-400">Source</span>
                        <span className="font-medium">{row.price_source || 'N/A'}</span>
                    </div>
                    <div className="mb-1 flex justify-between gap-4">
                        <span className="text-gray-400">Updated</span>
                        <span className="font-medium">{formatDateTimeLocale(row.price_fetched_at)}</span>
                    </div>
                    {hasError && (
                        <div className="flex justify-between gap-4">
                            <span className="text-red-400">Error</span>
                            <span className="max-w-[200px] break-words text-red-300">{row.price_error}</span>
                        </div>
                    )}
                    {stale && (
                        <div className="mt-1 text-orange-400">⚠ Price is stale (over 1 hour old)</div>
                    )}
                </div>
            }
            openDelay={200}
            closeDelay={100}
        >
            <div className="flex cursor-help items-center gap-1">
                <span className={`text-xs ${stale ? 'text-orange-500' : ''} ${hasPrice ? 'underline decoration-dotted' : ''}`}>
                    {hasPrice
                        ? <ValueDisplay value={row.market_value} currency={baseCurrency} />
                        : '—'}
                </span>
                {(stale || hasError || usingFallback) && (
                    <FiAlertCircle size={10} color={hasError ? '#E53E3E' : '#DD6B20'} />
                )}
                {isLoadingPrice && <Spinner size="xs" className="text-gray-400" />}
            </div>
        </Tooltip>
    );
};

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

export const AssetPnLTable: React.FC<AssetPnLTableProps> = ({
    assets,
    baseCurrency,
    onAssetClick,
    onAccountClick,
    loading = false,
    accountBalances,
    accounts = [],
    dimensions = [],
    availableAccountIds,
    availableCategoryIds,
    onLoadAccountBalances,
    liveBalances,
    liveAccountBalances,
    liveBalanceLoading = false,
    unmappedLiveAssets = [],
    liveAccountErrors,
    liveFetchedAccountIds,
    // Controlled filter props
    search: controlledSearch,
    onSearchChange,
    minMarketValue: controlledMinMarketValue,
    onMinMarketValueChange,
    pnlStatus: controlledPnlStatus,
    onPnlStatusChange,
    balanceStatus: controlledBalanceStatus,
    onBalanceStatusChange,
    selectedAccountIds: controlledAccountIds,
    onSelectedAccountIdsChange,
    selectedCategoryIds: controlledCategoryIds,
    onSelectedCategoryIdsChange,
    hideFilters = false,
    renderAfterFilters,
    contentHidden = false,
    onFilteredCountChange,
    backendSummary,
    periodDeltaMap,
    periodLabel,
    pnlVersionId,
}) => {
    const assetPanelCtx = useContext(AssetDetailPanelContext);
    const [sortField, setSortField] = useState<SortField>('total_return');
    const [sortDir, setSortDir] = useState<SortDirection>('desc');
    const [expandedAssetIds, setExpandedAssetIds] = useState<Set<number>>(new Set());
    const [expandedAccountIds, setExpandedAccountIds] = useState<Set<number>>(new Set());
    const [groupBy, setGroupBy] = useState<GroupBy>('asset');
    const [displayMode, setDisplayMode] = useState<DisplayMode>('cards');
    const [splitView, setSplitView] = useState(true);
    const [splitLeftPage, setSplitLeftPage] = useState(0);
    const [splitRightPage, setSplitRightPage] = useState(0);
    const [splitLeftPageSize, setSplitLeftPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
    const [splitRightPageSize, setSplitRightPageSize] = useState<number>(DEFAULT_PAGE_SIZE);

    // --- Unified filter state (internal fallback when not controlled) ---
    const [_search, _setSearch] = useState('');
    const [_minMarketValue, _setMinMarketValue] = useState(0);
    const [_pnlStatus, _setPnlStatus] = useState<PnlStatusFilter>('with_pnl');
    const [_balanceStatus, _setBalanceStatus] = useState<BalanceStatusFilter>('all');
    const [_selectedAccountIds, _setSelectedAccountIds] = useState<number[]>([]);
    const [_selectedCategoryIds, _setSelectedCategoryIds] = useState<number[]>([]);
    const [filtersExpanded, setFiltersExpanded] = useState(false);
    const [accountFilterSearch, setAccountFilterSearch] = useState('');
    const [catFilterSearch, setCatFilterSearch] = useState('');

    // Resolve controlled vs internal
    const search = controlledSearch ?? _search;
    const setSearch = onSearchChange ?? _setSearch;
    const minMarketValue = controlledMinMarketValue ?? _minMarketValue;
    const setMinMarketValue = onMinMarketValueChange ?? _setMinMarketValue;
    const pnlStatus = controlledPnlStatus ?? _pnlStatus;
    const setPnlStatus = onPnlStatusChange ?? _setPnlStatus;
    const balanceStatus = controlledBalanceStatus ?? _balanceStatus;
    const setBalanceStatus = onBalanceStatusChange ?? _setBalanceStatus;
    const selectedAccountIds = controlledAccountIds ?? _selectedAccountIds;
    const setSelectedAccountIds = onSelectedAccountIdsChange ?? _setSelectedAccountIds;
    const selectedCategoryIds = controlledCategoryIds ?? _selectedCategoryIds;
    const setSelectedCategoryIds = onSelectedCategoryIdsChange ?? _setSelectedCategoryIds;

    // --- Pagination state ---
    const [page, setPage] = useState(0);
    const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);

    // Filter to only show accounts present in results
    const availableAccounts = useMemo(() => {
        if (!availableAccountIds || availableAccountIds.size === 0) return [];
        return accounts.filter(acc => availableAccountIds.has(acc.id));
    }, [accounts, availableAccountIds]);

    // Filter to only show dimensions/categories present in results
    const relevantDimensions = useMemo(() => {
        if (!availableCategoryIds || availableCategoryIds.size === 0) return [];
        return dimensions
            .map(dim => ({
                ...dim,
                categories: dim.categories.filter(cat => availableCategoryIds.has(cat.id)),
            }))
            .filter(dim => dim.categories.length > 0);
    }, [dimensions, availableCategoryIds]);

    // Active filter count
    const activeFilterCount = useMemo(() => {
        let count = 0;
        if (search) count++;
        if (minMarketValue > 0) count++;
        if (pnlStatus !== 'all') count++;
        if (balanceStatus !== 'all') count++;
        if (selectedAccountIds.length > 0) count++;
        if (selectedCategoryIds.length > 0) count++;
        return count;
    }, [search, minMarketValue, pnlStatus, balanceStatus, selectedAccountIds, selectedCategoryIds]);

    const hasAccountOrCategoryFilter = selectedAccountIds.length > 0 || selectedCategoryIds.length > 0;

    // Build active filter chips for display when collapsed
    const activeFilterChips = useMemo(() => {
        const chips: { id: string; label: string; color: BadgeColorScheme; onRemove: () => void }[] = [];
        if (search) {
            chips.push({ id: 'search', label: `"${search}"`, color: 'purple', onRemove: () => setSearch('') });
        }
        if (minMarketValue > 0) {
            chips.push({ id: 'minValue', label: `Min $${minMarketValue}`, color: 'gray', onRemove: () => setMinMarketValue(0) });
        }
        if (pnlStatus !== 'all') {
            chips.push({ id: 'pnlStatus', label: pnlStatus === 'with_pnl' ? 'With P&L' : 'No P&L', color: 'green', onRemove: () => setPnlStatus('all') });
        }
        if (balanceStatus !== 'all') {
            chips.push({ id: 'balanceStatus', label: balanceStatus === 'mapped' ? 'Has balance' : 'No balance', color: 'yellow', onRemove: () => setBalanceStatus('all') });
        }
        for (const accId of selectedAccountIds) {
            const acc = accounts.find(a => a.id === accId);
            chips.push({ id: `acc-${accId}`, label: acc?.name ?? `Account ${accId}`, color: 'blue', onRemove: () => setSelectedAccountIds(selectedAccountIds.filter(id => id !== accId)) });
        }
        for (const catId of selectedCategoryIds) {
            const cat = dimensions.flatMap(d => d.categories).find(c => c.id === catId);
            chips.push({ id: `cat-${catId}`, label: cat?.label ?? `Category ${catId}`, color: 'orange', onRemove: () => setSelectedCategoryIds(selectedCategoryIds.filter(id => id !== catId)) });
        }
        return chips;
    }, [search, minMarketValue, pnlStatus, balanceStatus, selectedAccountIds, selectedCategoryIds, accounts, dimensions]);

    const clearAllFilters = () => {
        setSearch('');
        setMinMarketValue(0);
        setPnlStatus('all');
        setBalanceStatus('all');
        setSelectedAccountIds([]);
        setSelectedCategoryIds([]);
        setPage(0);
    };

    // Reset to first page when filters, search, sort, or groupBy change
    const resetPage = useCallback(() => setPage(0), []);

    // Toggle expanded state for an asset
    const toggleExpanded = (assetId: number, e: React.MouseEvent) => {
        e.stopPropagation();
        setExpandedAssetIds(prev => {
            const next = new Set(prev);
            if (next.has(assetId)) {
                next.delete(assetId);
            } else {
                next.add(assetId);
                if (onLoadAccountBalances && !accountBalances?.has(assetId)) {
                    onLoadAccountBalances();
                }
            }
            return next;
        });
    };

    // Toggle expanded state for an account (by-account view)
    const toggleAccountExpanded = (accountId: number, e: React.MouseEvent) => {
        e.stopPropagation();
        setExpandedAccountIds(prev => {
            const next = new Set(prev);
            if (next.has(accountId)) {
                next.delete(accountId);
            } else {
                next.add(accountId);
            }
            return next;
        });
    };

    // Check if asset has account breakdown data (expandable)
    const hasAccountData = (row: AssetPnLRow): boolean => {
        return row.account_ids != null && row.account_ids.length >= 1;
    };

    // --- Build full asset list (mapped PnL assets only — unmapped live assets surfaced in BalanceHealthCard) ---
    const allAssets = useMemo((): AssetPnLRow[] => {
        return [...assets];
    }, [assets]);

    const totalAssetCount = allAssets.length;

    // --- Filter + sort ---
    const { filtered, dustHiddenCount } = useMemo(() => {
        let dustCount = 0;

        const result = allAssets
            .filter((a) => {
                // Text search
                if (search) {
                    const q = search.toLowerCase();
                    const matches = [a.asset.symbol, a.asset.label].some(v => v?.toLowerCase().includes(q));
                    if (!matches) return false;
                }

                // Account filter
                if (selectedAccountIds.length > 0) {
                    if (!a.account_ids || a.account_ids.length === 0) return false;
                    if (!a.account_ids.some(id => selectedAccountIds.includes(id))) return false;
                }

                // Category filter
                if (selectedCategoryIds.length > 0) {
                    if (!a.category_ids || a.category_ids.length === 0) return false;
                    if (!a.category_ids.some(id => selectedCategoryIds.includes(id))) return false;
                }

                // P&L status filter
                if (pnlStatus === 'with_pnl' && !a.has_lots) return false;
                if (pnlStatus === 'no_pnl' && a.has_lots) return false;

                // Balance status filter
                const sym = a.asset.symbol?.toUpperCase() ?? '';
                const liveQty = liveBalances?.get(sym);
                if (balanceStatus === 'mapped' && (liveQty == null || liveQty === 0)) return false;
                if (balanceStatus === 'unmapped' && liveQty != null && liveQty > 0) return false;

                // Market-value slider filter — skip for assets without P&L data (N/A)
                // Also skip when price hasn't been fetched yet (unit_value is null)
                // to prevent cards from disappearing while prices are loading
                if (minMarketValue > 0 && a.has_lots && a.unit_value != null) {
                    const pnlValue = Math.abs(a.market_value);
                    const liveValue = liveQty != null && a.unit_value != null
                        ? Math.abs(liveQty * a.unit_value)
                        : pnlValue;
                    if (pnlValue < minMarketValue && liveValue < minMarketValue) {
                        dustCount++;
                        return false;
                    }
                }

                return true;
            })
            .sort((a, b) => {
                let aVal: string | number;
                let bVal: string | number;
                if (sortField === 'asset_symbol') {
                    aVal = a.asset.symbol ?? '';
                    bVal = b.asset.symbol ?? '';
                } else if (sortField === 'total_return') {
                    aVal = a.unrealized_pnl + a.realized_pnl;
                    bVal = b.unrealized_pnl + b.realized_pnl;
                } else if (sortField === 'efficiency') {
                    // Efficiency = |total return / cost basis| * 100, same as treemap
                    const atr = (a.unrealized_pnl + a.realized_pnl);
                    const btr = (b.unrealized_pnl + b.realized_pnl);
                    aVal = a.cost_basis > 1 ? (atr / a.cost_basis) * 100 : 0;
                    bVal = b.cost_basis > 1 ? (btr / b.cost_basis) * 100 : 0;
                } else {
                    aVal = a[sortField];
                    bVal = b[sortField];
                }
                if (typeof aVal === 'string') {
                    return sortDir === 'asc'
                        ? aVal.localeCompare(bVal as string)
                        : (bVal as string).localeCompare(aVal);
                }
                return sortDir === 'asc'
                    ? (aVal as number) - (bVal as number)
                    : (bVal as number) - (aVal as number);
            });

        return { filtered: result, dustHiddenCount: dustCount };
    }, [allAssets, search, sortField, sortDir, minMarketValue, liveBalances, pnlStatus, balanceStatus, selectedAccountIds, selectedCategoryIds]);

    // Report filtered count to parent
    useEffect(() => {
        onFilteredCountChange?.(filtered.length);
    }, [filtered.length, onFilteredCountChange]);

    // Compute filtered totals for summary bar
    const filteredTotals = useMemo(() => {
        let totalCost = 0;
        let totalUnrealized = 0;
        let totalRealized = 0;
        let totalTaxable = 0;
        let totalDeferred = 0;
        let totalFees = 0;
        let totalValue = 0;
        for (const row of filtered) {
            if (!row.has_lots) continue;
            totalCost += row.cost_basis;
            totalUnrealized += row.unrealized_pnl;
            totalRealized += row.realized_pnl;
            totalTaxable += row.taxable_realized_pnl;
            totalDeferred += row.tax_cost_basis != null ? row.cost_basis - row.tax_cost_basis : 0;
            totalFees += row.total_fees;
            totalValue += row.market_value;
        }
        return { totalCost, totalUnrealized, totalRealized, totalTaxable, totalDeferred, totalFees, totalValue };
    }, [filtered]);

    // Compute unrealized PnL range for heatmap coloring across all visible cards
    const unrealizedPnlRange = useMemo(() => {
        const vals = filtered.filter(a => a.has_lots).map(a => a.unrealized_pnl);
        if (vals.length === 0) return { min: 0, max: 0 };
        return { min: Math.min(...vals), max: Math.max(...vals) };
    }, [filtered]);

    // --- Aggregated "by account" rows ---
    const byAccountRows = useMemo((): AggregatedAccountRow[] => {
        if (groupBy !== 'account') return [];
        const map = new Map<number, AggregatedAccountRow>();

        for (const assetRow of filtered) {
            const assetId = assetRow.asset.id;
            const breakdowns = assetId != null ? accountBalances?.get(assetId) : undefined;

            if (breakdowns && breakdowns.length > 0) {
                for (const b of breakdowns) {
                    const unitPrice = assetRow.unit_value;
                    const mv = unitPrice != null ? b.qty * unitPrice : 0;
                    const unrealized = mv - b.cost_basis_in_base;
                    const existing = map.get(b.account_id);
                    if (existing) {
                        existing.asset_count++;
                        existing.total_cost_basis += b.cost_basis_in_base;
                        existing.total_market_value += mv;
                        existing.total_unrealized_pnl += unrealized;
                        existing.total_lot_count += b.lot_count;
                    } else {
                        map.set(b.account_id, {
                            account_id: b.account_id,
                            account_name: b.account_name,
                            asset_count: 1,
                            total_cost_basis: b.cost_basis_in_base,
                            total_market_value: mv,
                            total_unrealized_pnl: unrealized,
                            total_lot_count: b.lot_count,
                        });
                    }
                }
            } else {
                // No per-account breakdown yet – attribute to unknown
                const existing = map.get(0);
                if (existing) {
                    existing.asset_count++;
                    existing.total_cost_basis += assetRow.cost_basis;
                    existing.total_market_value += assetRow.market_value;
                    existing.total_unrealized_pnl += assetRow.unrealized_pnl;
                    existing.total_lot_count += assetRow.lot_count;
                } else {
                    map.set(0, {
                        account_id: 0,
                        account_name: '—',
                        asset_count: 1,
                        total_cost_basis: assetRow.cost_basis,
                        total_market_value: assetRow.market_value,
                        total_unrealized_pnl: assetRow.unrealized_pnl,
                        total_lot_count: assetRow.lot_count,
                    });
                }
            }
        }

        // Sort by total market value descending
        return Array.from(map.values()).sort(
            (a, b) => Math.abs(b.total_market_value) - Math.abs(a.total_market_value)
        );
    }, [groupBy, filtered, accountBalances]);

    // Per-account asset detail rows (for drill-down in by-account view)
    const accountAssetDetails = useMemo((): Map<number, AccountAssetDetail[]> => {
        if (groupBy !== 'account' || expandedAccountIds.size === 0) return new Map();
        const result = new Map<number, AccountAssetDetail[]>();

        for (const accountId of expandedAccountIds) {
            const details: AccountAssetDetail[] = [];
            for (const assetRow of filtered) {
                const assetId = assetRow.asset.id;
                const breakdowns = assetId != null ? accountBalances?.get(assetId) : undefined;
                if (breakdowns) {
                    const match = breakdowns.find(b => b.account_id === accountId);
                    if (match) {
                        const unitPrice = assetRow.unit_value;
                        const mv = unitPrice != null ? match.qty * unitPrice : 0;
                        details.push({
                            asset_symbol: assetRow.asset.symbol ?? '?',
                            asset_id: assetRow.asset.id ?? null,
                            qty: match.qty,
                            cost_basis: match.cost_basis_in_base,
                            unit_cost: match.avg_unit_cost_in_base,
                            market_value: mv,
                            unrealized_pnl: mv - match.cost_basis_in_base,
                            lot_count: match.lot_count,
                        });
                    }
                }
            }
            // Sort by market value descending
            details.sort((a, b) => Math.abs(b.market_value) - Math.abs(a.market_value));
            result.set(accountId, details);
        }
        return result;
    }, [groupBy, expandedAccountIds, filtered, accountBalances]);

    // --- Pagination ---
    const totalRows = groupBy === 'account' ? byAccountRows.length : filtered.length;
    const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
    // Clamp page if it goes out of bounds (e.g. after filtering)
    const safePage = Math.min(page, pageCount - 1);

    const paginatedFiltered = useMemo(() => {
        const start = safePage * pageSize;
        return filtered.slice(start, start + pageSize);
    }, [filtered, safePage, pageSize]);

    const paginatedByAccount = useMemo(() => {
        const start = safePage * pageSize;
        return byAccountRows.slice(start, start + pageSize);
    }, [byAccountRows, safePage, pageSize]);

    // --- Split view data ---
    // Split filtered array at midpoint: top half stays desc, bottom half reversed to asc
    const splitMid = Math.ceil(filtered.length / 2);
    const topHalf = useMemo(() => filtered.slice(0, splitMid), [filtered, splitMid]);
    const bottomHalf = useMemo(() => filtered.slice(splitMid).reverse(), [filtered, splitMid]);

    const splitLeftPageCount = Math.max(1, Math.ceil(topHalf.length / splitLeftPageSize));
    const safeSplitLeftPage = Math.min(splitLeftPage, splitLeftPageCount - 1);
    const paginatedTopPerformers = useMemo(() => {
        const start = safeSplitLeftPage * splitLeftPageSize;
        return topHalf.slice(start, start + splitLeftPageSize);
    }, [topHalf, safeSplitLeftPage, splitLeftPageSize]);

    const splitRightPageCount = Math.max(1, Math.ceil(bottomHalf.length / splitRightPageSize));
    const safeSplitRightPage = Math.min(splitRightPage, splitRightPageCount - 1);
    const paginatedBottomPerformers = useMemo(() => {
        const start = safeSplitRightPage * splitRightPageSize;
        return bottomHalf.slice(start, start + splitRightPageSize);
    }, [bottomHalf, safeSplitRightPage, splitRightPageSize]);

    // Compute per-account aggregated live balance value (for card mode)
    const accountLiveBalanceValues = useMemo((): Map<number, number> => {
        if (!liveAccountBalances) return new Map();
        const result = new Map<number, number>();

        // Iterate all symbols in liveAccountBalances: symbol → (accountId → qty)
        for (const [sym, accountMap] of liveAccountBalances.entries()) {
            // Find the asset row to get unit_value for this symbol
            const assetRow = allAssets.find(a => (a.asset.symbol?.toUpperCase() ?? '') === sym);
            const unitPrice = assetRow?.unit_value;
            if (unitPrice == null) continue;

            for (const [accountId, qty] of accountMap.entries()) {
                const value = qty * unitPrice;
                result.set(accountId, (result.get(accountId) ?? 0) + value);
            }
        }
        return result;
    }, [liveAccountBalances, allAssets]);

    // Reset page when filters/sort/grouping change
    useEffect(() => { resetPage(); setSplitLeftPage(0); setSplitRightPage(0); }, [search, minMarketValue, pnlStatus, balanceStatus, selectedAccountIds, selectedCategoryIds, sortField, sortDir, groupBy, displayMode, resetPage]);

    // Trigger load of per-account data when switching to "by account" mode
    const handleGroupByChange = (newGroupBy: GroupBy) => {
        setGroupBy(newGroupBy);
        if (newGroupBy === 'account' && onLoadAccountBalances && (!accountBalances || accountBalances.size === 0)) {
            onLoadAccountBalances();
        }
    };

    const handleSort = (field: SortField) => {
        if (sortField === field) {
            setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortDir('desc');
        }
    };

    const SortHeader: React.FC<{ field: SortField; children: React.ReactNode }> = ({ field, children }) => (
        <th
            className="cursor-pointer hover:bg-gray-50"
            onClick={() => handleSort(field)}
        >
            <div className="flex items-center gap-1">
                {children}
                {sortField === field && (
                    <span className="text-xs">{sortDir === 'asc' ? '↑' : '↓'}</span>
                )}
            </div>
        </th>
    );

    /** Segmented control helper for filter options */
    const SegmentedControl: React.FC<{
        value: string;
        options: { value: string; label: string }[];
        onChange: (value: string) => void;
    }> = ({ value, options, onChange }) => (
        <div className="inline-flex overflow-hidden border border-gray-200">
            {options.map((opt) => (
                <Button
                    key={opt.value}
                    variant={value === opt.value ? 'subtle' : 'ghost'}
                    colorScheme={value === opt.value ? 'blue' : 'gray'}
                    onClick={() => onChange(opt.value)}
                    className="h-6 px-2 text-xs"
                >
                    {opt.label}
                </Button>
            ))}
        </div>
    );

    // ── Pagination bar (reusable for top + bottom) ──
    const renderPaginationBar = (
        pPage: number, setPPage: (v: number | ((p: number) => number)) => void,
        pPageSize: number, setPPageSize: (v: number) => void,
        pTotalRows: number,
    ) => {
        const pPageCount = Math.max(1, Math.ceil(pTotalRows / pPageSize));
        const pSafePage = Math.min(pPage, pPageCount - 1);
        if (pTotalRows <= PAGE_SIZE_OPTIONS[0]) return null;
        return (
            <div className="flex w-full items-center justify-between px-3 py-2">
                <div className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-500">Rows:</span>
                    <div className="inline-flex overflow-hidden border border-gray-200">
                        {PAGE_SIZE_OPTIONS.map((size) => (
                            <Button
                                key={size}
                                variant={pPageSize === size ? 'subtle' : 'ghost'}
                                colorScheme={pPageSize === size ? 'blue' : 'gray'}
                                onClick={() => { setPPageSize(size); setPPage(0); }}
                                className="h-6 px-2 text-xs"
                            >
                                {size}
                            </Button>
                        ))}
                    </div>
                </div>
                <span className="text-[10px] text-gray-500">
                    {pSafePage * pPageSize + 1}–{Math.min((pSafePage + 1) * pPageSize, pTotalRows)} of {pTotalRows}
                </span>
                <div className="flex items-center gap-1">
                    <Button variant="ghost" onClick={() => setPPage(0)} disabled={pSafePage === 0} className="h-6 px-1">
                        <FiChevronsLeft size={12} />
                    </Button>
                    <Button variant="ghost" onClick={() => setPPage((p: number) => Math.max(0, p - 1))} disabled={pSafePage === 0} className="h-6 px-1">
                        <FiChevronLeft size={14} />
                    </Button>
                    <span className="mx-1 text-xs text-gray-600">
                        {pSafePage + 1} / {pPageCount}
                    </span>
                    <Button variant="ghost" onClick={() => setPPage((p: number) => Math.min(pPageCount - 1, p + 1))} disabled={pSafePage >= pPageCount - 1} className="h-6 px-1">
                        <FiChevronRight size={14} />
                    </Button>
                    <Button variant="ghost" onClick={() => setPPage(pPageCount - 1)} disabled={pSafePage >= pPageCount - 1} className="h-6 px-1">
                        <FiChevronsRight size={12} />
                    </Button>
                </div>
            </div>
        );
    };

    const paginationBar = renderPaginationBar(safePage, setPage, pageSize, setPageSize, totalRows);

    // ── Helper: render a grid of asset cards from an array ──
    const renderAssetCardGrid = (rows: AssetPnLRow[], columns?: Record<string, number>) => {
        const isSplitGrid = columns?.md === 1 && columns?.lg === 2 && columns?.xl === 3;
        const gridClassName = isSplitGrid
            ? 'grid grid-cols-1 gap-3 sm:grid-cols-1 md:grid-cols-1 lg:grid-cols-2 xl:grid-cols-3'
            : 'grid grid-cols-1 gap-3 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-5 xl:grid-cols-5';

        return (
            <div className={gridClassName}>
                {rows.map((assetpnlrow) => {
                    const assetId = assetpnlrow.asset.id;
                    const sym = assetpnlrow.asset.symbol?.toUpperCase() ?? '';
                    const liveQty = liveBalances?.get(sym);
                    const deltaInfo = computeDelta(assetpnlrow.quantity, liveQty);
                    const assetErrorAccounts = liveAccountErrors && assetpnlrow.account_ids.length > 0
                        ? assetpnlrow.account_ids.filter(id => liveAccountErrors.has(id))
                        : [];
                    const isUnmapped = !!assetpnlrow.is_unmapped;
                    const hasLiveErrors = assetErrorAccounts.length > 0 || (isUnmapped && liveAccountErrors && liveAccountErrors.size > 0);
                    return (
                        <AssetPnLCard
                            key={assetpnlrow.asset.id ?? `nopnl-${assetpnlrow.asset.symbol}`}
                            row={assetpnlrow}
                            baseCurrency={baseCurrency}
                            onAssetClick={onAssetClick}
                            onAccountClick={onAccountClick}
                            isExpanded={assetId != null && expandedAssetIds.has(assetId)}
                            onToggleExpand={toggleExpanded}
                            accountBalances={assetId != null ? accountBalances?.get(assetId) : undefined}
                            accounts={accounts}
                            liveQty={liveQty}
                            deltaInfo={deltaInfo}
                            liveBalanceLoading={liveBalanceLoading}
                            liveAccountBalanceMap={liveAccountBalances?.get(sym)}
                            liveAccountErrors={liveAccountErrors}
                            assetErrorAccounts={assetErrorAccounts}
                            hasLiveErrors={!!hasLiveErrors}
                            unrealizedPnlRange={unrealizedPnlRange}
                            periodDelta={assetId != null ? periodDeltaMap?.get(assetId) : undefined}
                            periodLabel={periodLabel}
                            pnlVersionId={pnlVersionId}
                        />
                    );
                })}
            </div>
        );
    };

    // ── Helper: render asset table rows from an array ──
    const renderAssetTableRows = (rows: AssetPnLRow[]) => (
        <>
            {rows.map((assetpnlrow) => {
                const assetId = assetpnlrow.asset.id;
                const isNoPnl = !assetpnlrow.has_lots;
                const isUnmapped = !!assetpnlrow.is_unmapped;
                const isExpandable = !isNoPnl && hasAccountData(assetpnlrow);
                const isExpanded = assetId != null && expandedAssetIds.has(assetId);
                const assetAccountBalances = assetId != null ? accountBalances?.get(assetId) : undefined;
                const sym = assetpnlrow.asset.symbol?.toUpperCase() ?? '';
                const liveQty = liveBalances?.get(sym);
                const deltaInfo = computeDelta(assetpnlrow.quantity, liveQty);
                const assetErrorAccounts = liveAccountErrors && assetpnlrow.account_ids.length > 0
                    ? assetpnlrow.account_ids.filter(id => liveAccountErrors.has(id))
                    : [];
                const hasLiveErrors = assetErrorAccounts.length > 0 || (isUnmapped && liveAccountErrors && liveAccountErrors.size > 0);
                const rowClassName = [
                    'transition-colors',
                    isNoPnl ? 'cursor-default hover:bg-gray-100' : 'cursor-pointer hover:bg-blue-50',
                    isExpanded ? 'bg-blue-50' : isNoPnl ? 'bg-gray-50' : '',
                    isUnmapped ? 'opacity-60' : '',
                ].join(' ');
                return (
                    <Fragment key={assetpnlrow.asset.id ?? `nopnl-${assetpnlrow.asset.symbol}`}>
                        <tr className={rowClassName} onClick={isNoPnl ? undefined : () => onAssetClick(assetpnlrow.asset.id)}>
                            <td className="px-1 py-0.5">
                                <div className="flex items-center gap-1">
                                    {isExpandable ? (
                                        <button
                                            type="button"
                                            onClick={(e: React.MouseEvent) => assetId != null && toggleExpanded(assetId, e)}
                                            className="p-0.5 hover:bg-gray-200"
                                        >
                                            {isExpanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                                        </button>
                                    ) : <span className="inline-block w-[18px]" />}
                                    <Tooltip content={assetpnlrow.asset.label ? `${assetpnlrow.asset.label} (${assetpnlrow.asset.symbol})` : (assetpnlrow.asset.symbol || '')} openDelay={300}>
                                        <Badge colorScheme={isUnmapped ? 'gray' : 'blue'} className="max-w-[120px] truncate font-bold">
                                            {assetpnlrow.asset.label ? `${assetpnlrow.asset.label} (${assetpnlrow.asset.symbol})` : assetpnlrow.asset.symbol}
                                        </Badge>
                                    </Tooltip>
                                </div>
                            </td>
                            <td className="px-1 py-0.5">{isNoPnl ? <span className="text-xs text-gray-400">—</span> : <span className="text-xs"><ValueDisplay value={assetpnlrow.quantity} /></span>}</td>
                            <td className="px-1 py-0.5">{renderCost(assetpnlrow.cost_basis, assetpnlrow.unit_cost, baseCurrency, assetpnlrow.total_invested)}</td>
                            <td className="px-1 py-0.5">{renderValue(assetpnlrow, baseCurrency)}</td>
                            <td className="px-1 py-0.5">
                                {isNoPnl ? <span className="text-xs text-gray-400">N/A</span>
                                    : assetpnlrow.unit_value == null ? <span className="text-xs text-gray-400">—</span>
                                        : <span className={`text-xs font-medium ${assetpnlrow.unrealized_pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}><ValueDisplay value={assetpnlrow.unrealized_pnl} currency={baseCurrency} /></span>}
                            </td>
                            <td className="px-1 py-0.5">
                                {isNoPnl ? <span className="text-xs text-gray-400">N/A</span>
                                    : <span className={`text-xs font-medium ${assetpnlrow.realized_pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}><ValueDisplay value={assetpnlrow.realized_pnl} currency={baseCurrency} /></span>}
                            </td>
                        </tr>
                    </Fragment>
                );
            })}
        </>
    );

    // ── Split view metric label ──
    const splitMetricLabel = SORT_FIELD_LABELS[sortField];

    // ── When contentHidden, render only filters + injected content (no card wrapper) ──
    // (contentHidden path removed — unified into main return below)

    return (
        <div className="border border-gray-200 bg-white">
            <div className="pb-2">
                {/* Top row: Search + filters header */}
                <div className="mb-2 flex items-center gap-3">
                    {!hideFilters && (
                        <div className="relative w-full max-w-[220px] shrink-0">
                            <Input
                                placeholder="Search asset or label..."
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                className="h-7 pl-7 text-xs"
                            />
                            <div className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2">
                                <FiSearch size={12} color="gray" />
                            </div>
                        </div>
                    )}
                </div>

                {/* Filter section — collapsible (hidden when parent manages filters) */}
                {!hideFilters && (
                    <div className={`border px-2 py-1 transition-colors ${filtersExpanded ? 'border-blue-200' : 'border-gray-200'}`}>
                        {/* Filter header row */}
                        <div
                            className="flex cursor-pointer select-none items-center justify-between py-1 hover:bg-gray-50"
                            onClick={() => setFiltersExpanded(prev => !prev)}
                        >
                            <div className="flex items-center gap-2">
                                {filtersExpanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                                <FiFilter size={12} color="gray" />
                                <span className="text-xs font-medium text-gray-600">
                                    Filters
                                    {filtered.length < totalAssetCount && (
                                        <span className="font-normal text-gray-400">
                                            {' '}— showing {filtered.length} of {totalAssetCount}
                                        </span>
                                    )}
                                </span>
                                {activeFilterCount > 0 && (
                                    <Badge colorScheme="blue">{activeFilterCount}</Badge>
                                )}
                                {/* Active filter chips — inline in header */}
                                {!filtersExpanded && activeFilterChips.length > 0 && (
                                    <div className="ml-1 flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
                                        {activeFilterChips.map(chip => (
                                            <Badge
                                                key={chip.id}
                                                colorScheme={chip.color}
                                                className="cursor-pointer gap-0.5 px-1.5 text-[10px] transition hover:opacity-80"
                                                onClick={(e) => { e.stopPropagation(); chip.onRemove(); }}
                                            >
                                                <span className="text-[10px]">{chip.label}</span>
                                                <span className="flex items-center">
                                                    <FiX size={8} />
                                                </span>
                                            </Badge>
                                        ))}
                                    </div>
                                )}
                            </div>
                            {activeFilterCount > 0 && (
                                <Button
                                    variant="ghost"
                                    colorScheme="gray"
                                    onClick={(e) => { e.stopPropagation(); clearAllFilters(); }}
                                    className="h-6 gap-1 px-2 text-xs font-normal"
                                >
                                    <FiX size={10} />
                                    Clear all
                                </Button>
                            )}
                        </div>

                        {filtersExpanded && (
                            <>
                                <div className="mt-2 grid grid-cols-1 gap-3 pb-1 md:grid-cols-2 lg:grid-cols-3">
                                    {/* Min value */}
                                    <div>
                                        <div className="mb-1 text-[10px] font-medium text-gray-500">Min value</div>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="range"
                                                min={0}
                                                max={100}
                                                step={1}
                                                value={minMarketValue}
                                                onChange={(e) => setMinMarketValue(Number(e.target.value))}
                                                className="h-1 w-full accent-blue-500"
                                            />
                                            <span className="min-w-[28px] whitespace-nowrap text-right text-xs text-gray-600">
                                                ${minMarketValue}
                                            </span>
                                        </div>
                                    </div>

                                    {/* P&L status */}
                                    <div>
                                        <div className="mb-1 text-[10px] font-medium text-gray-500">P&L status</div>
                                        <SegmentedControl
                                            value={pnlStatus}
                                            options={[
                                                { value: 'all', label: 'All' },
                                                { value: 'with_pnl', label: 'With P&L' },
                                                { value: 'no_pnl', label: 'No P&L' },
                                            ]}
                                            onChange={(v) => setPnlStatus(v as PnlStatusFilter)}
                                        />
                                    </div>

                                    {/* Balance status */}
                                    <div>
                                        <div className="mb-1 text-[10px] font-medium text-gray-500">Live balance</div>
                                        <SegmentedControl
                                            value={balanceStatus}
                                            options={[
                                                { value: 'all', label: 'All' },
                                                { value: 'mapped', label: 'Has balance' },
                                                { value: 'unmapped', label: 'No balance' },
                                            ]}
                                            onChange={(v) => setBalanceStatus(v as BalanceStatusFilter)}
                                        />
                                    </div>
                                </div>

                                {/* Account / Category filter cards */}
                                {(availableAccounts.length > 0 || relevantDimensions.length > 0) && (
                                    <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                                        {/* Accounts card */}
                                        {availableAccounts.length > 0 && (() => {
                                            const filteredAccounts = accountFilterSearch
                                                ? availableAccounts.filter(a => a.name.toLowerCase().includes(accountFilterSearch.toLowerCase()))
                                                : availableAccounts;
                                            return (
                                                <div className={`border-2 p-2 ${selectedAccountIds.length > 0 ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white'}`}>
                                                    <div className="mb-1 flex items-center gap-2">
                                                        <span className={`text-[10px] font-semibold ${selectedAccountIds.length > 0 ? 'text-blue-700' : 'text-gray-700'}`}>
                                                            Accounts
                                                        </span>
                                                        <Badge colorScheme={selectedAccountIds.length > 0 ? 'blue' : 'gray'} className="ml-auto">
                                                            {selectedAccountIds.length || 'All'}/{availableAccounts.length}
                                                        </Badge>
                                                    </div>
                                                    <div className="relative mb-1">
                                                        <Input
                                                            placeholder="Search accounts..."
                                                            value={accountFilterSearch}
                                                            onChange={(e) => setAccountFilterSearch(e.target.value)}
                                                            className="h-7 pl-7 text-xs"
                                                        />
                                                        <div className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2">
                                                            <FiSearch size={10} color="gray" />
                                                        </div>
                                                    </div>
                                                    <div className="max-h-[100px] overflow-y-auto">
                                                        <div className="flex flex-wrap gap-1">
                                                            {filteredAccounts.map((account) => {
                                                                const isSelected = selectedAccountIds.includes(account.id);
                                                                const color = getAccountColor(account.id);
                                                                return (
                                                                    <Button
                                                                        key={account.id}
                                                                        variant={isSelected ? 'solid' : 'outline'}
                                                                        onClick={() => setSelectedAccountIds(
                                                                            selectedAccountIds.includes(account.id)
                                                                                ? selectedAccountIds.filter(id => id !== account.id)
                                                                                : [...selectedAccountIds, account.id]
                                                                        )}
                                                                        className="h-6 gap-1 px-2 text-xs hover:opacity-90"
                                                                        style={{
                                                                            backgroundColor: isSelected ? color : '#ffffff',
                                                                            color: isSelected ? '#ffffff' : '#374151',
                                                                            borderColor: color,
                                                                        }}
                                                                    >
                                                                        <span
                                                                            className="inline-block h-[6px] w-[6px] rounded-full"
                                                                            style={{ backgroundColor: isSelected ? 'currentColor' : color, opacity: isSelected ? 0.7 : 1 }}
                                                                        />
                                                                        {account.name}
                                                                    </Button>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })()}

                                        {/* Category dimension cards */}
                                        {relevantDimensions.map((dimension) => {
                                            const selectedInDim = dimension.categories.filter(
                                                cat => selectedCategoryIds.includes(cat.id)
                                            ).length;
                                            const filteredCats = catFilterSearch
                                                ? dimension.categories.filter(c => c.label.toLowerCase().includes(catFilterSearch.toLowerCase()))
                                                : dimension.categories;
                                            return (
                                                <div key={dimension.id} className={`border-2 p-2 ${selectedInDim > 0 ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white'}`}>
                                                    <div className="mb-1 flex items-center gap-2">
                                                        <span className={`text-[10px] font-semibold ${selectedInDim > 0 ? 'text-blue-700' : 'text-gray-700'}`}>
                                                            {dimension.label}
                                                        </span>
                                                        <Badge colorScheme={selectedInDim > 0 ? 'blue' : 'gray'} className="ml-auto">
                                                            {selectedInDim || 'All'}/{dimension.categories.length}
                                                        </Badge>
                                                    </div>
                                                    <div className="relative mb-1">
                                                        <Input
                                                            placeholder={`Search ${dimension.label.toLowerCase()}...`}
                                                            value={catFilterSearch}
                                                            onChange={(e) => setCatFilterSearch(e.target.value)}
                                                            className="h-7 pl-7 text-xs"
                                                        />
                                                        <div className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2">
                                                            <FiSearch size={10} color="gray" />
                                                        </div>
                                                    </div>
                                                    <div className="max-h-[100px] overflow-y-auto">
                                                        <div className="flex flex-wrap gap-1">
                                                            {filteredCats.map((category) => {
                                                                const isSelected = selectedCategoryIds.includes(category.id);
                                                                return (
                                                                    <Button
                                                                        key={category.id}
                                                                        variant={isSelected ? 'solid' : 'outline'}
                                                                        colorScheme={isSelected ? 'blue' : 'gray'}
                                                                        onClick={() => setSelectedCategoryIds(
                                                                            selectedCategoryIds.includes(category.id)
                                                                                ? selectedCategoryIds.filter(id => id !== category.id)
                                                                                : [...selectedCategoryIds, category.id]
                                                                        )}
                                                                        className="h-6 px-2 text-xs hover:opacity-90"
                                                                        style={{
                                                                            borderColor: category.color || undefined,
                                                                            backgroundColor: isSelected && category.color ? category.color : undefined,
                                                                            color: isSelected && category.color ? '#ffffff' : undefined,
                                                                        }}
                                                                    >
                                                                        {category.label}
                                                                    </Button>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}

                            </>
                        )}
                    </div>
                )}

                {/* Portfolio totals summary bar (only when list view) */}
                {!contentHidden && (() => {
                    const totals = filteredTotals;
                    const showDustNote = dustHiddenCount > 0;
                    const totalReturn = totals.totalUnrealized + totals.totalRealized;
                    const roi = totals.totalCost > 0 ? (totalReturn / totals.totalCost) * 100 : 0;
                    const colorFn = (v: number) => (v >= 0 ? 'green.600' : 'red.600');
                    return filtered.length > 0 && totals.totalCost > 0 && (
                        <div className="mt-2">
                            <HeroMetricsBar
                                totalReturn={totalReturn}
                                roi={roi}
                                baseCurrency={baseCurrency}
                                costBasisInPeriod={totals.totalCost}
                                unrealizedInPeriod={totals.totalUnrealized}
                                realizedInPeriod={totals.totalRealized}
                                feesInPeriod={totals.totalFees}
                                fmtCurrencySigned={fmtCurrencySigned}
                                color={colorFn}
                            >
                                <MetricItem label="Value" value={fmtCurrency(totals.totalValue, baseCurrency)} color="gray.800" icon={<FiDollarSign size={14} />} bg="blue.50" />
                                <MetricItem label="Cost" value={fmtCurrency(totals.totalCost, baseCurrency)} color="gray.700" icon={<LuReceipt size={14} />} bg="gray.100" info={TERM_HELP.cost} />
                                <MetricItem label="Unrealized" value={fmtCurrencySigned(totals.totalUnrealized, baseCurrency)} color={colorFn(totals.totalUnrealized)} icon={totals.totalUnrealized >= 0 ? <FiTrendingUp size={14} /> : <FiTrendingDown size={14} />} bg={totals.totalUnrealized >= 0 ? 'green.50' : 'red.50'} />
                                <MetricItem label="Realized" value={fmtCurrencySigned(totals.totalRealized, baseCurrency)} color={colorFn(totals.totalRealized)} icon={totals.totalRealized >= 0 ? <FiTrendingUp size={14} /> : <FiTrendingDown size={14} />} bg={totals.totalRealized >= 0 ? 'green.50' : 'red.50'} info={TERM_HELP.realized} subLines={realizedSubLines({ taxableRealizedPnl: totals.totalTaxable, deferredGain: totals.totalDeferred }, baseCurrency, fmtCurrencySigned)} />
                                <MetricItem label="Fees" value={fmtCurrency(totals.totalFees, baseCurrency)} color="orange.700" icon={<LuReceipt size={14} />} bg="orange.50" />
                            </HeroMetricsBar>
                            {showDustNote && (
                                <div className="mt-1 text-right text-[10px] text-gray-400">
                                    {dustHiddenCount} small-value asset{dustHiddenCount !== 1 ? 's' : ''} hidden by dust filter
                                </div>
                            )}
                        </div>
                    );
                })()}

                {/* List / Treemap toggle — injected by parent, after PnL bar */}
                {renderAfterFilters && (
                    <div className="mt-2">{renderAfterFilters}</div>
                )}
            </div>

            {/* ── List content — highlighted border to separate from shared filters/PnL bar above ── */}
            {!contentHidden && (
                <div className="mx-3 mb-3 mt-1 overflow-hidden border-2 border-blue-100">
                    {/* View controls: display mode, group-by, sort */}
                    <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 bg-gray-50 px-3 py-2">
                        {/* Display mode toggle — Cards vs Table */}
                        <div className="flex items-center gap-1">
                            <span className="text-[10px] font-medium text-gray-500">View</span>
                            <div className="overflow-hidden border border-gray-200">
                                <Button
                                    variant={displayMode === 'cards' ? 'subtle' : 'ghost'}
                                    colorScheme={displayMode === 'cards' ? 'blue' : 'gray'}
                                    onClick={() => setDisplayMode('cards')}
                                    className="h-6 px-2"
                                    title="Card view"
                                >
                                    <FiGrid size={12} />
                                </Button>
                                <Button
                                    variant={displayMode === 'table' ? 'subtle' : 'ghost'}
                                    colorScheme={displayMode === 'table' ? 'blue' : 'gray'}
                                    onClick={() => setDisplayMode('table')}
                                    className="h-6 px-2"
                                    title="Table view"
                                >
                                    <FiList size={12} />
                                </Button>
                            </div>
                        </div>

                        {/* Split view toggle (only for by-asset) */}
                        {groupBy === 'asset' && (
                            <div className="flex items-center gap-1">
                                <Button
                                    variant={splitView ? 'subtle' : 'ghost'}
                                    colorScheme={splitView ? 'blue' : 'gray'}
                                    onClick={() => setSplitView(v => !v)}
                                    title="Split view: top vs bottom performers"
                                    className="h-6 gap-1 px-2 text-xs"
                                >
                                    <FiColumns size={12} />
                                    <span>Split</span>
                                </Button>
                            </div>
                        )}

                        {/* Group by toggle */}
                        <div className="flex items-center gap-1">
                            <span className="text-[10px] font-medium text-gray-500">Group</span>
                            <div className="overflow-hidden border border-gray-200">
                                <Button
                                    variant={groupBy === 'asset' ? 'subtle' : 'ghost'}
                                    colorScheme={groupBy === 'asset' ? 'blue' : 'gray'}
                                    onClick={() => handleGroupByChange('asset')}
                                    className="h-6 px-2 text-xs"
                                >
                                    By Asset
                                </Button>
                                <Button
                                    variant={groupBy === 'account' ? 'subtle' : 'ghost'}
                                    colorScheme={groupBy === 'account' ? 'blue' : 'gray'}
                                    onClick={() => handleGroupByChange('account')}
                                    className="h-6 px-2 text-xs"
                                >
                                    By Account
                                </Button>
                            </div>
                        </div>

                        {/* Sort-by */}
                        <div className="flex items-center gap-1">
                            <span className="text-[10px] font-medium text-gray-500">Sort</span>
                            <div className="inline-flex overflow-hidden border border-gray-200">
                                {[
                                    { value: 'total_return', label: 'Return' },
                                    { value: 'market_value', label: 'Value' },
                                    { value: 'cost_basis', label: 'Cost' },
                                    { value: 'unrealized_pnl', label: 'Unrealized' },
                                    { value: 'realized_pnl', label: 'Realized' },
                                    { value: 'efficiency', label: 'Efficiency' },
                                ].map((opt) => (
                                    <Button
                                        key={opt.value}
                                        variant={sortField === opt.value ? 'subtle' : 'ghost'}
                                        colorScheme={sortField === opt.value ? 'blue' : 'gray'}
                                        onClick={() => handleSort(opt.value as SortField)}
                                        className="h-6 px-2 text-xs"
                                    >
                                        {opt.label}
                                        {sortField === opt.value && (
                                            <span className="ml-0.5">{sortDir === 'asc' ? '↑' : '↓'}</span>
                                        )}
                                    </Button>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Top pagination */}
                    {/* Top pagination (hidden in split mode — each half has its own) */}
                    {!splitView && paginationBar && (
                        <div className="border-b border-gray-100">
                            {paginationBar}
                        </div>
                    )}
                    {/* ── Card mode ── */}
                    {displayMode === 'cards' ? (
                        <div className="p-3">
                            {loading ? (
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-5 xl:grid-cols-5">
                                    {Array.from({ length: 8 }).map((_, i) => (
                                        <div key={i} className="border border-gray-200 bg-white py-6">
                                            <div className="text-center text-xs text-gray-400">Loading...</div>
                                        </div>
                                    ))}
                                </div>
                            ) : groupBy === 'account' ? (
                                byAccountRows.length === 0 ? (
                                    <div className="py-8 text-center text-gray-500">
                                        {accountBalances && accountBalances.size > 0
                                            ? 'No rows match your criteria'
                                            : 'Loading account breakdown...'}
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-5 xl:grid-cols-5">
                                        {paginatedByAccount.map((row) => (
                                            <AccountPnLCard
                                                key={row.account_id}
                                                row={row}
                                                baseCurrency={baseCurrency}
                                                isExpanded={expandedAccountIds.has(row.account_id)}
                                                onToggleExpand={toggleAccountExpanded}
                                                onAssetClick={onAssetClick}
                                                details={accountAssetDetails.get(row.account_id) ?? []}
                                                liveBalanceValue={accountLiveBalanceValues.get(row.account_id)}
                                                liveBalanceLoading={liveBalanceLoading}
                                            />
                                        ))}
                                    </div>
                                )
                            ) : splitView ? (
                                /* ── Split card view: desc (left) vs asc (right) ── */
                                filtered.length === 0 ? (
                                    <div className="py-8 text-center text-gray-500">No assets match your criteria</div>
                                ) : (
                                    <div className="flex flex-col gap-3 md:flex-row">
                                        {/* Left: sorted desc */}
                                        <div className="min-w-0 flex-1 border-b border-gray-200 pb-3 md:border-b-0 md:border-r md:pb-0 md:pr-3">
                                            <div className="mb-2 flex items-center gap-2">
                                                <span className="text-sm font-semibold text-green-700">↓ {splitMetricLabel}</span>
                                                <Badge colorScheme="gray">{topHalf.length}</Badge>
                                            </div>
                                            {renderAssetCardGrid(paginatedTopPerformers, { base: 1, sm: 1, md: 1, lg: 2, xl: 3 })}
                                            {renderPaginationBar(safeSplitLeftPage, setSplitLeftPage, splitLeftPageSize, setSplitLeftPageSize, topHalf.length) && (
                                                <div className="mt-2">{renderPaginationBar(safeSplitLeftPage, setSplitLeftPage, splitLeftPageSize, setSplitLeftPageSize, topHalf.length)}</div>
                                            )}
                                        </div>
                                        {/* Right: sorted asc */}
                                        <div className="min-w-0 flex-1 md:pl-3">
                                            <div className="mb-2 flex items-center gap-2">
                                                <span className="text-sm font-semibold text-red-700">↑ {splitMetricLabel}</span>
                                                <Badge colorScheme="gray">{bottomHalf.length}</Badge>
                                            </div>
                                            {renderAssetCardGrid(paginatedBottomPerformers, { base: 1, sm: 1, md: 1, lg: 2, xl: 3 })}
                                            {renderPaginationBar(safeSplitRightPage, setSplitRightPage, splitRightPageSize, setSplitRightPageSize, bottomHalf.length) && (
                                                <div className="mt-2">{renderPaginationBar(safeSplitRightPage, setSplitRightPage, splitRightPageSize, setSplitRightPageSize, bottomHalf.length)}</div>
                                            )}
                                        </div>
                                    </div>
                                )
                            ) : (
                                filtered.length === 0 ? (
                                    <div className="py-8 text-center text-gray-500">No assets match your criteria</div>
                                ) : renderAssetCardGrid(paginatedFiltered)
                            )}
                        </div>
                    ) : splitView && groupBy === 'asset' ? (
                        /* ── Split table mode ── */
                        filtered.length === 0 ? (
                            <div className="p-3">
                                <div className="py-8 text-center text-gray-500">No assets match your criteria</div>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-0 md:flex-row">
                                {/* Left: sorted desc */}
                                <div className="min-w-0 flex-1 border-b border-gray-200 md:border-b-0 md:border-r">
                                    <div className="flex items-center gap-2 border-b border-gray-100 bg-green-50 px-3 py-2">
                                        <span className="text-sm font-semibold text-green-700">↓ {splitMetricLabel}</span>
                                        <Badge colorScheme="gray">{topHalf.length}</Badge>
                                    </div>
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr>
                                                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Asset</th>
                                                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Qty</th>
                                                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Cost</th>
                                                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Value</th>
                                                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Unrealized</th>
                                                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Realized</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {renderAssetTableRows(paginatedTopPerformers)}
                                            </tbody>
                                        </table>
                                    </div>
                                    {renderPaginationBar(safeSplitLeftPage, setSplitLeftPage, splitLeftPageSize, setSplitLeftPageSize, topHalf.length) && (
                                        <div className="border-t border-gray-100">
                                            {renderPaginationBar(safeSplitLeftPage, setSplitLeftPage, splitLeftPageSize, setSplitLeftPageSize, topHalf.length)}
                                        </div>
                                    )}
                                </div>
                                {/* Right: sorted asc */}
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 border-b border-gray-100 bg-red-50 px-3 py-2">
                                        <span className="text-sm font-semibold text-red-700">↑ {splitMetricLabel}</span>
                                        <Badge colorScheme="gray">{bottomHalf.length}</Badge>
                                    </div>
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr>
                                                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Asset</th>
                                                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Qty</th>
                                                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Cost</th>
                                                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Value</th>
                                                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Unrealized</th>
                                                    <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Realized</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {renderAssetTableRows(paginatedBottomPerformers)}
                                            </tbody>
                                        </table>
                                    </div>
                                    {renderPaginationBar(safeSplitRightPage, setSplitRightPage, splitRightPageSize, setSplitRightPageSize, bottomHalf.length) && (
                                        <div className="border-t border-gray-100">
                                            {renderPaginationBar(safeSplitRightPage, setSplitRightPage, splitRightPageSize, setSplitRightPageSize, bottomHalf.length)}
                                        </div>
                                    )}
                                </div>
                            </div>
                        )
                    ) : (
                        /* ── Table mode (original) ── */
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr>
                                        {groupBy === 'account' ? (
                                            <>
                                                <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Account</th>
                                                <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Assets</th>
                                                <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Cost</th>
                                                <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Value</th>
                                                <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Unrealized</th>
                                                <th className="px-2 py-2 text-center text-xs font-medium text-gray-600">Info</th>
                                                <th className="px-2 py-2 text-left text-xs font-medium text-gray-600"></th>
                                            </>
                                        ) : (
                                            <>
                                                <SortHeader field="asset_symbol">Asset</SortHeader>
                                                <SortHeader field="quantity">Qty</SortHeader>
                                                <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">
                                                    <div className="flex items-center gap-1">
                                                        Δ
                                                        {liveBalanceLoading && <Spinner size="xs" className="text-gray-400" />}
                                                    </div>
                                                </th>
                                                <SortHeader field="cost_basis">Cost</SortHeader>
                                                <SortHeader field="market_value">Value</SortHeader>
                                                <SortHeader field="unrealized_pnl">Unrealized</SortHeader>
                                                <SortHeader field="realized_pnl">Realized</SortHeader>
                                                <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Fees</th>
                                                <th className="px-2 py-2 text-center text-xs font-medium text-gray-600">Info</th>
                                                <th className="px-2 py-2 text-left text-xs font-medium text-gray-600"></th>
                                            </>
                                        )}
                                    </tr>
                                </thead>
                                <tbody>
                                    {(() => {
                                        const colSpan = groupBy === 'account' ? TOTAL_COLUMNS_BY_ACCOUNT : TOTAL_COLUMNS_BY_ASSET;
                                        if (loading) {
                                            return (
                                                <tr>
                                                    <td colSpan={colSpan} className="py-8 text-center text-gray-500">Loading...</td>
                                                </tr>
                                            );
                                        }
                                        if (groupBy === 'account' && byAccountRows.length === 0) {
                                            return (
                                                <tr>
                                                    <td colSpan={colSpan} className="py-8 text-center text-gray-500">
                                                        {accountBalances && accountBalances.size > 0
                                                            ? 'No rows match your criteria'
                                                            : 'Loading account breakdown...'}
                                                    </td>
                                                </tr>
                                            );
                                        }
                                        if (groupBy === 'asset' && filtered.length === 0) {
                                            return (
                                                <tr>
                                                    <td colSpan={colSpan} className="py-8 text-center text-gray-500">No assets match your criteria</td>
                                                </tr>
                                            );
                                        }

                                        // ---- By Account view (aggregated) ----
                                        if (groupBy === 'account') {
                                            return paginatedByAccount.map((row) => {
                                                const { account_id, account_name, asset_count, total_cost_basis, total_market_value, total_unrealized_pnl, total_lot_count } = row;
                                                const accountColor = getAccountColor(account_id);
                                                const unrealizedPct = total_cost_basis > 0 ? total_unrealized_pnl / total_cost_basis : 0;
                                                const isAcctExpanded = expandedAccountIds.has(account_id);
                                                const details = accountAssetDetails.get(account_id) ?? [];

                                                return (
                                                    <Fragment key={account_id}>
                                                        <tr
                                                            className={`cursor-pointer [&>td]:px-1 [&>td]:py-0.5 hover:bg-blue-50 ${isAcctExpanded ? 'bg-blue-50' : ''}`}
                                                            onClick={(e) => toggleAccountExpanded(account_id, e)}
                                                        >
                                                            {/* Account */}
                                                            <td>
                                                                <div className="flex items-center gap-1">
                                                                    <button
                                                                        type="button"
                                                                        className="p-0.5 hover:bg-gray-200"
                                                                        onClick={(e: React.MouseEvent) => toggleAccountExpanded(account_id, e)}
                                                                    >
                                                                        {isAcctExpanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                                                                    </button>
                                                                    <span className="inline-block h-[8px] w-[8px] shrink-0 rounded-full" style={{ backgroundColor: accountColor }} />
                                                                    <span className="max-w-[140px] truncate text-xs font-medium" title={account_name}>
                                                                        {account_name}
                                                                    </span>
                                                                </div>
                                                            </td>
                                                            {/* Assets count */}
                                                            <td>
                                                                <Badge>{asset_count}</Badge>
                                                            </td>
                                                            {/* Cost */}
                                                            <td>
                                                                <span className="text-xs"><ValueDisplay value={total_cost_basis} currency={baseCurrency} /></span>
                                                            </td>
                                                            {/* Value */}
                                                            <td>
                                                                <span className="text-xs font-medium">
                                                                    <ValueDisplay value={total_market_value} currency={baseCurrency} />
                                                                </span>
                                                            </td>
                                                            {/* Unrealized P&L */}
                                                            <td>
                                                                <div className="flex flex-col">
                                                                    <span className={`text-xs ${total_unrealized_pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                                        <ValueDisplay value={total_unrealized_pnl} currency={baseCurrency} />
                                                                    </span>
                                                                    <span className="text-[10px] text-gray-500">{formatPct(unrealizedPct)}</span>
                                                                </div>
                                                            </td>
                                                            {/* Info */}
                                                            <td className="text-center">
                                                                <Badge>{total_lot_count} lots</Badge>
                                                            </td>
                                                            {/* Chevron */}
                                                            <td></td>
                                                        </tr>

                                                        {/* Expanded asset detail rows */}
                                                        {isAcctExpanded && details.map((d) => {
                                                            const dUnrealizedPct = d.cost_basis > 0 ? d.unrealized_pnl / d.cost_basis : 0;
                                                            return (
                                                                <tr
                                                                    key={`${account_id}-${d.asset_symbol}`}
                                                                    className="cursor-pointer bg-gray-50 [&>td]:px-1 [&>td]:py-px hover:bg-gray-100"
                                                                    onClick={() => onAssetClick(d.asset_id)}
                                                                >
                                                                    {/* Asset (indented) */}
                                                                    <td className="pl-10">
                                                                        <div className="flex items-center gap-1">
                                                                            <Badge colorScheme="blue" className="max-w-[80px] truncate font-bold">
                                                                                {d.asset_symbol}
                                                                            </Badge>
                                                                            {d.asset_id != null && assetPanelCtx && (
                                                                                <button
                                                                                    type="button"
                                                                                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); assetPanelCtx.openAssetPanel(d.asset_id!, { pnlVersionId }); }}
                                                                                    className="p-0.5 text-gray-400 hover:bg-blue-50 hover:text-blue-500"
                                                                                    title="Asset details"
                                                                                >
                                                                                    <LuInfo size={10} />
                                                                                </button>
                                                                            )}
                                                                        </div>
                                                                    </td>
                                                                    {/* Qty */}
                                                                    <td>
                                                                        <span className="text-xs text-gray-600"><ValueDisplay value={d.qty} /></span>
                                                                    </td>
                                                                    {/* Cost */}
                                                                    <td>
                                                                        {renderCost(d.cost_basis, d.unit_cost, baseCurrency)}
                                                                    </td>
                                                                    {/* Value */}
                                                                    <td>
                                                                        <span className="text-xs text-gray-600">
                                                                            <ValueDisplay value={d.market_value} currency={baseCurrency} />
                                                                        </span>
                                                                    </td>
                                                                    {/* Unrealized */}
                                                                    <td>
                                                                        <div className="flex flex-col">
                                                                            <span className={`text-xs ${d.unrealized_pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                                                <ValueDisplay value={d.unrealized_pnl} currency={baseCurrency} />
                                                                            </span>
                                                                            <span className="text-[10px] text-gray-500">{formatPct(dUnrealizedPct)}</span>
                                                                        </div>
                                                                    </td>
                                                                    {/* Info */}
                                                                    <td className="text-center">
                                                                        <Badge>{d.lot_count} lots</Badge>
                                                                    </td>
                                                                    {/* Chevron */}
                                                                    <td>
                                                                        <FiChevronRight size={12} color="gray" />
                                                                    </td>
                                                                </tr>
                                                            );
                                                        })}
                                                    </Fragment>
                                                );
                                            });
                                        }

                                        // ---- By Asset view (default) ----
                                        return (
                                            <>
                                                {paginatedFiltered.map((assetpnlrow) => {
                                                    const assetId = assetpnlrow.asset.id;
                                                    const isNoPnl = !assetpnlrow.has_lots;
                                                    const isUnmapped = !!assetpnlrow.is_unmapped;
                                                    const isExpandable = !isNoPnl && hasAccountData(assetpnlrow);
                                                    const isExpanded = assetId != null && expandedAssetIds.has(assetId);
                                                    const assetAccountBalances = assetId != null ? accountBalances?.get(assetId) : undefined;

                                                    // Live balance data
                                                    const sym = assetpnlrow.asset.symbol?.toUpperCase() ?? '';
                                                    const liveQty = liveBalances?.get(sym);
                                                    const deltaInfo = computeDelta(assetpnlrow.quantity, liveQty);

                                                    // Check if any of this asset's accounts had live balance errors
                                                    const assetErrorAccounts = liveAccountErrors && assetpnlrow.account_ids.length > 0
                                                        ? assetpnlrow.account_ids.filter(id => liveAccountErrors.has(id))
                                                        : [];
                                                    const hasLiveErrors = assetErrorAccounts.length > 0 || (isUnmapped && liveAccountErrors && liveAccountErrors.size > 0);

                                                    const assetRowClassName = [
                                                        '[&>td]:px-1 [&>td]:py-0.5',
                                                        isNoPnl ? 'cursor-default hover:bg-gray-100' : 'cursor-pointer hover:bg-blue-50',
                                                        isExpanded ? 'bg-blue-50' : isNoPnl ? 'bg-gray-50' : '',
                                                        isUnmapped ? 'opacity-60' : '',
                                                    ].join(' ');

                                                    return (
                                                        <Fragment key={assetpnlrow.asset.id ?? `nopnl-${assetpnlrow.asset.symbol}`}>
                                                            <tr
                                                                className={assetRowClassName}
                                                                onClick={isNoPnl ? undefined : () => onAssetClick(assetpnlrow.asset.id)}
                                                            >
                                                                {/* Asset */}
                                                                <td>
                                                                    <div className="flex items-center gap-1">
                                                                        {isExpandable ? (
                                                                            <button
                                                                                type="button"
                                                                                onClick={(e: React.MouseEvent) => assetId != null && toggleExpanded(assetId, e)}
                                                                                className="p-0.5 hover:bg-gray-200"
                                                                            >
                                                                                {isExpanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                                                                            </button>
                                                                        ) : (
                                                                            <span className="inline-block w-[18px]" />
                                                                        )}
                                                                        <Tooltip content={assetpnlrow.asset.label ? `${assetpnlrow.asset.label} (${assetpnlrow.asset.symbol})` : (assetpnlrow.asset.symbol || '')} openDelay={300}>
                                                                            <Badge
                                                                                colorScheme={isUnmapped ? 'gray' : 'blue'}
                                                                                className="max-w-[120px] truncate font-bold"
                                                                            >
                                                                                {assetpnlrow.asset.label ? `${assetpnlrow.asset.label} (${assetpnlrow.asset.symbol})` : assetpnlrow.asset.symbol}
                                                                            </Badge>
                                                                        </Tooltip>
                                                                        {assetpnlrow.asset.id != null && assetPanelCtx && (
                                                                            <button
                                                                                type="button"
                                                                                onClick={(e: React.MouseEvent) => { e.stopPropagation(); assetPanelCtx.openAssetPanel(assetpnlrow.asset.id!, { pnlVersionId }); }}
                                                                                className="p-0.5 text-gray-400 hover:bg-blue-50 hover:text-blue-500"
                                                                                title="Asset details"
                                                                            >
                                                                                <LuInfo size={12} />
                                                                            </button>
                                                                        )}
                                                                        {isUnmapped && (
                                                                            <Tooltip content="This asset is not mapped in the database" openDelay={200}>
                                                                                <span className="cursor-help text-xs text-orange-500">⚠</span>
                                                                            </Tooltip>
                                                                        )}
                                                                    </div>
                                                                </td>
                                                                {/* Qty */}
                                                                <td>
                                                                    {isNoPnl
                                                                        ? <span className="text-xs text-gray-400">—</span>
                                                                        : <span className="text-xs"><ValueDisplay value={assetpnlrow.quantity} /></span>
                                                                    }
                                                                </td>
                                                                {/* Δ (combined) */}
                                                                <td>
                                                                    {liveBalanceLoading
                                                                        ? <Spinner size="xs" className="text-gray-400" />
                                                                        : (
                                                                            <div className="flex items-center gap-0.5">
                                                                                <DeltaBar delta={deltaInfo} liveQty={liveQty} pnlQty={assetpnlrow.quantity} size="xs" />
                                                                                {hasLiveErrors && (
                                                                                    <Tooltip
                                                                                        content={
                                                                                            <div className="text-xs">
                                                                                                <div className="mb-1 font-medium">Some accounts had fetch errors — balance may be incomplete</div>
                                                                                                {assetErrorAccounts.map(accId => {
                                                                                                    const errs = liveAccountErrors!.get(accId) ?? [];
                                                                                                    const accName = accounts.find(a => a.id === accId)?.name ?? `Account ${accId}`;
                                                                                                    return errs.map((err, i) => (
                                                                                                        <div key={`${accId}-${i}`} className="text-red-300">{accName}: {err}</div>
                                                                                                    ));
                                                                                                })}
                                                                                            </div>
                                                                                        }
                                                                                        openDelay={200}
                                                                                    >
                                                                                        <span className="shrink-0 cursor-help text-xs text-orange-500">⚠</span>
                                                                                    </Tooltip>
                                                                                )}
                                                                            </div>
                                                                        )
                                                                    }
                                                                </td>
                                                                {/* Cost (combined) */}
                                                                <td>
                                                                    {isNoPnl
                                                                        ? <span className="text-xs text-gray-400">N/A</span>
                                                                        : renderCost(assetpnlrow.cost_basis, assetpnlrow.unit_cost, baseCurrency)
                                                                    }
                                                                </td>
                                                                {/* Value (combined) */}
                                                                <td>
                                                                    {renderValue(assetpnlrow, baseCurrency)}
                                                                </td>
                                                                {/* Unrealized P&L */}
                                                                <td>
                                                                    {isNoPnl ? (
                                                                        <span className="text-xs text-gray-400">N/A</span>
                                                                    ) : assetpnlrow.unit_value == null ? (
                                                                        <div className="flex items-center gap-1">
                                                                            <span className="text-xs text-gray-400">—</span>
                                                                            {assetpnlrow.price_error && <FiAlertCircle size={10} color="#E53E3E" />}
                                                                        </div>
                                                                    ) : (
                                                                        <div className="flex flex-col">
                                                                            <span className={`text-xs font-medium ${assetpnlrow.unrealized_pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                                                <ValueDisplay value={assetpnlrow.unrealized_pnl} currency={baseCurrency} />
                                                                            </span>
                                                                            <span className="text-[10px] text-gray-500">{formatPct(assetpnlrow.unrealized_pnl_pct)}</span>
                                                                        </div>
                                                                    )}
                                                                </td>
                                                                {/* Realized P&L */}
                                                                <td>
                                                                    {isNoPnl ? (
                                                                        <span className="text-xs text-gray-400">N/A</span>
                                                                    ) : (
                                                                        <span className={`text-xs font-medium ${assetpnlrow.realized_pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                                            <ValueDisplay value={assetpnlrow.realized_pnl} currency={baseCurrency} />
                                                                        </span>
                                                                    )}
                                                                </td>
                                                                {/* Fees */}
                                                                <td>
                                                                    {isNoPnl ? (
                                                                        <span className="text-xs text-gray-400">N/A</span>
                                                                    ) : (
                                                                        <span className="text-xs text-gray-600">
                                                                            <ValueDisplay value={assetpnlrow.total_fees} currency={baseCurrency} />
                                                                        </span>
                                                                    )}
                                                                </td>
                                                                {/* Info */}
                                                                <td className="text-center">
                                                                    {isNoPnl ? (
                                                                        isUnmapped
                                                                            ? <Badge colorScheme="orange">Unmapped</Badge>
                                                                            : <Badge colorScheme="yellow">No P&L</Badge>
                                                                    ) : (
                                                                        <div className="flex items-center justify-center gap-0.5">
                                                                            {assetAccountBalances && assetAccountBalances.length > 1 && (
                                                                                <div className="mr-0.5 flex gap-0.5">
                                                                                    {assetAccountBalances.slice(0, 3).map((bal) => (
                                                                                        <span
                                                                                            key={bal.account_id}
                                                                                            className="inline-block h-[6px] w-[6px] rounded-full"
                                                                                            style={{ backgroundColor: getAccountColor(bal.account_id) }}
                                                                                            title={bal.account_name}
                                                                                        />
                                                                                    ))}
                                                                                    {assetAccountBalances.length > 3 && (
                                                                                        <span className="text-[10px] text-gray-500">+{assetAccountBalances.length - 3}</span>
                                                                                    )}
                                                                                </div>
                                                                            )}
                                                                            <Badge>{assetpnlrow.lot_count} lots</Badge>
                                                                            {assetpnlrow.warning_count > 0 && (
                                                                                <Badge colorScheme="orange">{assetpnlrow.warning_count} ⚠</Badge>
                                                                            )}
                                                                        </div>
                                                                    )}
                                                                </td>
                                                                {/* Chevron */}
                                                                <td>
                                                                    {!isNoPnl && <FiChevronRight size={12} color="gray" />}
                                                                </td>
                                                            </tr>

                                                            {/* Expanded account breakdown rows */}
                                                            {isExpanded && assetAccountBalances && assetAccountBalances.map((balance) => {
                                                                const accountColor = getAccountColor(balance.account_id);
                                                                const unitPrice = assetpnlrow.unit_value;
                                                                const marketValue = unitPrice != null ? balance.qty * unitPrice : 0;
                                                                const unrealizedPnl = marketValue - balance.cost_basis_in_base;
                                                                const unrealizedPnlPct = balance.cost_basis_in_base > 0
                                                                    ? unrealizedPnl / balance.cost_basis_in_base
                                                                    : 0;

                                                                const acctLiveQty = liveAccountBalances?.get(sym)?.get(balance.account_id);
                                                                const acctDelta = computeDelta(balance.qty, acctLiveQty);
                                                                const acctErrors = liveAccountErrors?.get(balance.account_id);
                                                                const acctHasError = acctErrors && acctErrors.length > 0 && acctLiveQty == null;

                                                                return (
                                                                    <tr
                                                                        key={`${assetpnlrow.asset.id}-${balance.account_id}`}
                                                                        className="bg-gray-50 [&>td]:px-1 [&>td]:py-px hover:bg-gray-100"
                                                                    >
                                                                        {/* Account name (indented, border starts right of parent asset name) */}
                                                                        <td className="pl-7" style={{ borderLeft: `2px solid ${accountColor}` }}>
                                                                            <div className="flex items-center gap-1">
                                                                                <span className="inline-block h-[8px] w-[8px] shrink-0 rounded-full" style={{ backgroundColor: accountColor }} />
                                                                                <span
                                                                                    className={`text-xs text-gray-700 ${onAccountClick ? 'cursor-pointer hover:text-blue-600 hover:underline' : ''}`}
                                                                                    onClick={(e) => {
                                                                                        if (onAccountClick && assetId != null) {
                                                                                            e.stopPropagation();
                                                                                            onAccountClick(assetId, balance.account_id);
                                                                                        }
                                                                                    }}
                                                                                >
                                                                                    {balance.account_name}
                                                                                </span>
                                                                            </div>
                                                                        </td>
                                                                        {/* Qty */}
                                                                        <td>
                                                                            <span className="text-xs text-gray-600"><ValueDisplay value={balance.qty} /></span>
                                                                        </td>
                                                                        {/* Δ (combined) */}
                                                                        <td>
                                                                            {acctHasError ? (
                                                                                <Tooltip
                                                                                    content={
                                                                                        <div className="text-xs">
                                                                                            <div className="mb-1 font-medium">Fetch error:</div>
                                                                                            {acctErrors!.map((err, i) => <div key={i} className="text-red-300">{err}</div>)}
                                                                                        </div>
                                                                                    }
                                                                                    openDelay={200}
                                                                                >
                                                                                    <span className="cursor-help text-xs text-red-500">⚠ err</span>
                                                                                </Tooltip>
                                                                            ) : (
                                                                                <DeltaBar delta={acctDelta} liveQty={acctLiveQty} pnlQty={balance.qty} size="xs" />
                                                                            )}
                                                                        </td>
                                                                        {/* Cost (combined) */}
                                                                        <td>
                                                                            {renderCost(balance.cost_basis_in_base, balance.avg_unit_cost_in_base, baseCurrency)}
                                                                        </td>
                                                                        {/* Value (combined) */}
                                                                        <td>
                                                                            <span className="text-xs text-gray-600">
                                                                                {unitPrice != null
                                                                                    ? <ValueDisplay value={marketValue} currency={baseCurrency} />
                                                                                    : '—'}
                                                                            </span>
                                                                        </td>
                                                                        {/* Unrealized */}
                                                                        <td>
                                                                            {unitPrice != null ? (
                                                                                <div className="flex flex-col">
                                                                                    <span className={`text-xs ${unrealizedPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                                                        <ValueDisplay value={unrealizedPnl} currency={baseCurrency} />
                                                                                    </span>
                                                                                    <span className="text-[10px] text-gray-500">{formatPct(unrealizedPnlPct)}</span>
                                                                                </div>
                                                                            ) : (
                                                                                <span className="text-xs text-gray-500">—</span>
                                                                            )}
                                                                        </td>
                                                                        {/* Realized */}
                                                                        <td><span className="text-xs text-gray-500">—</span></td>
                                                                        {/* Fees */}
                                                                        <td><span className="text-xs text-gray-500">—</span></td>
                                                                        {/* Info */}
                                                                        <td className="text-center">
                                                                            <Badge>{balance.lot_count} lots</Badge>
                                                                        </td>
                                                                        {/* Chevron */}
                                                                        <td></td>
                                                                    </tr>
                                                                );
                                                            })}
                                                        </Fragment>
                                                    );
                                                })}
                                            </>
                                        );
                                    })()}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {/* Bottom pagination (hidden in split mode) */}
                    {!splitView && paginationBar && (
                        <div className="border-t border-gray-100">
                            {paginationBar}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default AssetPnLTable;
