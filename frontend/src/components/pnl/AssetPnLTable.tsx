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
import {
    Badge,
    Box,
    Button,
    Card,
    Collapsible,
    Flex,
    Input,
    SimpleGrid,
    Slider,
    Spinner,
    Table,
    Text,
} from '@chakra-ui/react';
import { FiChevronRight, FiChevronDown, FiChevronLeft, FiChevronsLeft, FiChevronsRight, FiSearch, FiAlertCircle, FiGrid, FiFilter, FiX, FiList, FiCheck, FiDollarSign, FiTrendingUp, FiTrendingDown } from 'react-icons/fi';
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
import { MetricItem, fmtCurrency, fmtCurrencySigned } from './TotalReturnScorecard';
import { computeDelta, formatPct } from './deltaUtils';

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const TOTAL_COLUMNS_BY_ASSET = 10;
const TOTAL_COLUMNS_BY_ACCOUNT = 7;

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 10;

/** Extra-small font style applied to all table cells */
const XS: { fontSize: string } = { fontSize: 'xs' };

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

type SortField = 'asset_symbol' | 'quantity' | 'market_value' | 'cost_basis' | 'unrealized_pnl' | 'realized_pnl' | 'efficiency';
type SortDirection = 'asc' | 'desc';

// ------------------------------------------------------------------
// Render helpers (combined columns)
// ------------------------------------------------------------------

/** Combined "Cost" cell: cost basis (primary) + unit cost on hover */
const renderCost = (
    costBasis: number,
    unitCost: number | undefined | null,
    baseCurrency: string,
) => (
    <Tooltip
        content={
            <Box p={1} fontSize="xs">
                <Flex justify="space-between" gap={3}>
                    <Text color="gray.400">Unit cost</Text>
                    <Text fontWeight="medium">
                        {unitCost != null
                            ? <ValueDisplay value={unitCost} currency={baseCurrency} />
                            : '—'}
                    </Text>
                </Flex>
            </Box>
        }
        openDelay={200}
    >
        <Text {...XS} cursor="help">
            <ValueDisplay value={costBasis} currency={baseCurrency} />
        </Text>
    </Tooltip>
);

/** Combined "Value" cell: market value (primary) + unit value / price info on hover */
const renderValue = (
    row: AssetPnLRow,
    baseCurrency: string,
) => {
    const stale = isPriceStale(row.price_fetched_at);
    const hasPrice = row.unit_value != null;
    const hasError = !!row.price_error;
    const isLoadingPrice = !!row.price_loading;

    if (isLoadingPrice) return <Spinner size="xs" color="gray.400" />;

    return (
        <Tooltip
            content={
                <Box p={2} fontSize="xs">
                    <Flex justify="space-between" gap={4} mb={1}>
                        <Text color="gray.400">Unit price</Text>
                        <Text fontWeight="medium">
                            {hasPrice
                                ? <ValueDisplay value={row.unit_value!} currency={baseCurrency} />
                                : '—'}
                        </Text>
                    </Flex>
                    <Flex justify="space-between" gap={4} mb={1}>
                        <Text color="gray.400">Source</Text>
                        <Text fontWeight="medium">{row.price_source || 'N/A'}</Text>
                    </Flex>
                    <Flex justify="space-between" gap={4} mb={1}>
                        <Text color="gray.400">Updated</Text>
                        <Text fontWeight="medium">{formatDateTimeLocale(row.price_fetched_at)}</Text>
                    </Flex>
                    {hasError && (
                        <Flex justify="space-between" gap={4}>
                            <Text color="red.400">Error</Text>
                            <Text color="red.300" maxW="200px" wordBreak="break-word">{row.price_error}</Text>
                        </Flex>
                    )}
                    {stale && (
                        <Text color="orange.400" mt={1}>⚠ Price is stale (over 1 hour old)</Text>
                    )}
                </Box>
            }
            openDelay={200}
            closeDelay={100}
        >
            <Flex align="center" gap={1} cursor="help">
                <Text {...XS} color={stale ? 'orange.500' : undefined} textDecoration={hasPrice ? 'underline dotted' : undefined}>
                    {hasPrice
                        ? <ValueDisplay value={row.market_value} currency={baseCurrency} />
                        : '—'}
                </Text>
                {(stale || hasError) && (
                    <FiAlertCircle size={10} color={hasError ? '#E53E3E' : '#DD6B20'} />
                )}
            </Flex>
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
    const [sortField, setSortField] = useState<SortField>('market_value');
    const [sortDir, setSortDir] = useState<SortDirection>('desc');
    const [expandedAssetIds, setExpandedAssetIds] = useState<Set<number>>(new Set());
    const [expandedAccountIds, setExpandedAccountIds] = useState<Set<number>>(new Set());
    const [groupBy, setGroupBy] = useState<GroupBy>('asset');
    const [displayMode, setDisplayMode] = useState<DisplayMode>('cards');

    // --- Unified filter state (internal fallback when not controlled) ---
    const [_search, _setSearch] = useState('');
    const [_minMarketValue, _setMinMarketValue] = useState(5);
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
        const chips: { id: string; label: string; color: string; onRemove: () => void }[] = [];
        if (search) {
            chips.push({ id: 'search', label: `"${search}"`, color: 'purple', onRemove: () => setSearch('') });
        }
        if (minMarketValue > 0) {
            chips.push({ id: 'minValue', label: `Min $${minMarketValue}`, color: 'gray', onRemove: () => setMinMarketValue(0) });
        }
        if (pnlStatus !== 'all') {
            chips.push({ id: 'pnlStatus', label: pnlStatus === 'with_pnl' ? 'With P&L' : 'No P&L', color: 'teal', onRemove: () => setPnlStatus('all') });
        }
        if (balanceStatus !== 'all') {
            chips.push({ id: 'balanceStatus', label: balanceStatus === 'mapped' ? 'Has balance' : 'No balance', color: 'cyan', onRemove: () => setBalanceStatus('all') });
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

    // --- Build full asset list (include unmapped live assets as rows) ---
    const allAssets = useMemo((): AssetPnLRow[] => {
        const unmappedRows: AssetPnLRow[] = unmappedLiveAssets.map(u => ({
            asset: { id: null, symbol: u.symbol, label: null },
            account_ids: [],
            category_ids: [],
            quantity: 0,
            market_value: u.marketValue ?? 0,
            cost_basis: 0,
            unrealized_pnl: 0,
            unrealized_pnl_pct: 0,
            realized_pnl: 0,
            taxable_realized_pnl: 0,
            total_fees: 0,
            lot_count: 0,
            realized_event_count: 0,
            warning_count: 0,
            has_lots: false,
            is_unmapped: true,
        }));
        return [...assets, ...unmappedRows];
    }, [assets, unmappedLiveAssets]);

    const totalAssetCount = allAssets.length;

    // --- Filter + sort ---
    const { filtered, dustHiddenCount } = useMemo(() => {
        let dustCount = 0;

        const result = allAssets
            .filter((a) => {
                // Text search
                if (search && (!a.asset.symbol || !a.asset.symbol.toLowerCase().includes(search.toLowerCase()))) {
                    return false;
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

                // Exclude unmapped rows when account/category filters are active
                if (hasAccountOrCategoryFilter && a.is_unmapped) return false;

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
    }, [allAssets, search, sortField, sortDir, minMarketValue, liveBalances, pnlStatus, balanceStatus, selectedAccountIds, selectedCategoryIds, hasAccountOrCategoryFilter]);

    // Report filtered count to parent
    useEffect(() => {
        onFilteredCountChange?.(filtered.length);
    }, [filtered.length, onFilteredCountChange]);

    // Compute filtered totals for summary bar
    const filteredTotals = useMemo(() => {
        let totalCost = 0;
        let totalUnrealized = 0;
        let totalRealized = 0;
        let totalFees = 0;
        let totalValue = 0;
        for (const row of filtered) {
            if (!row.has_lots) continue;
            totalCost += row.cost_basis;
            totalUnrealized += row.unrealized_pnl;
            totalRealized += row.realized_pnl;
            totalFees += row.total_fees;
            totalValue += row.market_value;
        }
        return { totalCost, totalUnrealized, totalRealized, totalFees, totalValue };
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
    useEffect(() => { resetPage(); }, [search, minMarketValue, pnlStatus, balanceStatus, selectedAccountIds, selectedCategoryIds, sortField, sortDir, groupBy, displayMode, resetPage]);

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
        <Table.ColumnHeader
            cursor="pointer"
            onClick={() => handleSort(field)}
            _hover={{ bg: 'gray.50' }}
        >
            <Flex align="center" gap={1}>
                {children}
                {sortField === field && (
                    <Text fontSize="xs">{sortDir === 'asc' ? '↑' : '↓'}</Text>
                )}
            </Flex>
        </Table.ColumnHeader>
    );

    /** Segmented control helper for filter options */
    const SegmentedControl: React.FC<{
        value: string;
        options: { value: string; label: string }[];
        onChange: (value: string) => void;
    }> = ({ value, options, onChange }) => (
        <Flex
            borderRadius="md"
            border="1px solid"
            borderColor="gray.200"
            overflow="hidden"
            display="inline-flex"
        >
            {options.map((opt) => (
                <Button
                    key={opt.value}
                    size="2xs"
                    variant={value === opt.value ? 'subtle' : 'ghost'}
                    colorPalette={value === opt.value ? 'blue' : 'gray'}
                    borderRadius="0"
                    onClick={() => onChange(opt.value)}
                    px={2}
                    fontSize="xs"
                >
                    {opt.label}
                </Button>
            ))}
        </Flex>
    );

    // ── Pagination bar (reusable for top + bottom) ──
    const paginationBar = totalRows > PAGE_SIZE_OPTIONS[0] ? (
        <Flex justify="space-between" align="center" width="100%" py={2} px={3}>
            <Flex align="center" gap={2}>
                <Text fontSize="2xs" color="gray.500">Rows:</Text>
                <Flex borderRadius="md" border="1px solid" borderColor="gray.200" overflow="hidden" display="inline-flex">
                    {PAGE_SIZE_OPTIONS.map((size) => (
                        <Button
                            key={size}
                            size="2xs"
                            variant={pageSize === size ? 'subtle' : 'ghost'}
                            colorPalette={pageSize === size ? 'blue' : 'gray'}
                            borderRadius="0"
                            onClick={() => { setPageSize(size); setPage(0); }}
                            px={2}
                            fontSize="xs"
                        >
                            {size}
                        </Button>
                    ))}
                </Flex>
            </Flex>
            <Text fontSize="2xs" color="gray.500">
                {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, totalRows)} of {totalRows}
            </Text>
            <Flex align="center" gap={1}>
                <Button size="2xs" variant="ghost" onClick={() => setPage(0)} disabled={safePage === 0} px={1}>
                    <FiChevronsLeft size={12} />
                </Button>
                <Button size="2xs" variant="ghost" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0} px={1}>
                    <FiChevronLeft size={14} />
                </Button>
                <Text fontSize="xs" color="gray.600" mx={1}>
                    {safePage + 1} / {pageCount}
                </Text>
                <Button size="2xs" variant="ghost" onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1} px={1}>
                    <FiChevronRight size={14} />
                </Button>
                <Button size="2xs" variant="ghost" onClick={() => setPage(pageCount - 1)} disabled={safePage >= pageCount - 1} px={1}>
                    <FiChevronsRight size={12} />
                </Button>
            </Flex>
        </Flex>
    ) : null;

    // ── When contentHidden, render only filters + injected content (no card wrapper) ──
    // (contentHidden path removed — unified into main return below)

    return (
        <Card.Root>
            <Card.Header pb={2}>
                {/* Top row: Title + asset search */}
                <Flex justify="space-between" align="center" mb={2} gap={3}>
                    <Text fontWeight="bold" fontSize="lg" flexShrink={0}>
                        {groupBy === 'asset'
                            ? `Asset P&L (${filtered.length} assets)`
                            : `Asset P&L (${byAccountRows.length} accounts)`
                        }
                    </Text>
                    {!hideFilters && (
                        <Box position="relative" maxW="220px" w="100%">
                            <Input
                                placeholder="Search asset..."
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                size="xs"
                                pl={7}
                            />
                            <Box position="absolute" left={2} top="50%" transform="translateY(-50%)">
                                <FiSearch size={12} color="gray" />
                            </Box>
                        </Box>
                    )}
                </Flex>

                {/* Filter section — collapsible (hidden when parent manages filters) */}
                {!hideFilters && (
                    <Collapsible.Root open={filtersExpanded}>
                        <Box border="1px solid" borderColor={filtersExpanded ? 'blue.200' : 'gray.200'} borderRadius="md" px={2} py={1} transition="border-color 0.15s">
                            {/* Filter header row */}
                            <Flex
                                align="center"
                                justify="space-between"
                                cursor="pointer"
                                py={1}
                                onClick={() => setFiltersExpanded(prev => !prev)}
                                _hover={{ bg: 'gray.50' }}
                                borderRadius="sm"
                                userSelect="none"
                            >
                                <Flex align="center" gap={2}>
                                    {filtersExpanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                                    <FiFilter size={12} color="gray" />
                                    <Text fontSize="xs" fontWeight="medium" color="gray.600">
                                        Filters
                                        {filtered.length < totalAssetCount && (
                                            <Text as="span" color="gray.400" fontWeight="normal">
                                                {' '}— showing {filtered.length} of {totalAssetCount}
                                            </Text>
                                        )}
                                    </Text>
                                    {activeFilterCount > 0 && (
                                        <Badge size="xs" colorPalette="blue" variant="solid">{activeFilterCount}</Badge>
                                    )}
                                </Flex>
                                {activeFilterCount > 0 && (
                                    <Button
                                        size="2xs"
                                        variant="ghost"
                                        colorPalette="gray"
                                        onClick={(e) => { e.stopPropagation(); clearAllFilters(); }}
                                        gap={1}
                                    >
                                        <FiX size={10} />
                                        Clear all
                                    </Button>
                                )}
                            </Flex>

                            {/* Active filter chips — shown when filters are collapsed */}
                            {!filtersExpanded && activeFilterChips.length > 0 && (
                                <Flex flexWrap="wrap" gap={1.5} pt={1} pb={1}>
                                    {activeFilterChips.map(chip => (
                                        <Badge
                                            key={chip.id}
                                            size="sm"
                                            colorPalette={chip.color}
                                            display="inline-flex"
                                            alignItems="center"
                                            gap={1}
                                            px={2}
                                            py={0.5}
                                            borderRadius="md"
                                            cursor="pointer"
                                            transition="all 0.15s"
                                            _hover={{ transform: 'scale(0.95)', opacity: 0.8 }}
                                            onClick={(e) => { e.stopPropagation(); chip.onRemove(); }}
                                        >
                                            <Text fontSize="xs">{chip.label}</Text>
                                            <Box as="span" display="flex" alignItems="center">
                                                <FiX size={10} />
                                            </Box>
                                        </Badge>
                                    ))}
                                </Flex>
                            )}

                            <Collapsible.Content>
                                <SimpleGrid columns={{ base: 1, md: 2, lg: 3 }} gap={3} mt={2} pb={1}>
                                    {/* Min value */}
                                    <Box>
                                        <Text fontSize="2xs" fontWeight="medium" color="gray.500" mb={1}>Min value</Text>
                                        <Flex align="center" gap={2}>
                                            <Slider.Root
                                                size="sm"
                                                min={0}
                                                max={100}
                                                step={1}
                                                value={[minMarketValue]}
                                                onValueChange={(details) => setMinMarketValue(details.value[0])}
                                                width="100%"
                                            >
                                                <Slider.Control>
                                                    <Slider.Track>
                                                        <Slider.Range />
                                                    </Slider.Track>
                                                    <Slider.Thumbs />
                                                </Slider.Control>
                                            </Slider.Root>
                                            <Text fontSize="xs" color="gray.600" whiteSpace="nowrap" minW="28px" textAlign="right">
                                                ${minMarketValue}
                                            </Text>
                                        </Flex>
                                    </Box>

                                    {/* P&L status */}
                                    <Box>
                                        <Text fontSize="2xs" fontWeight="medium" color="gray.500" mb={1}>P&L status</Text>
                                        <SegmentedControl
                                            value={pnlStatus}
                                            options={[
                                                { value: 'all', label: 'All' },
                                                { value: 'with_pnl', label: 'With P&L' },
                                                { value: 'no_pnl', label: 'No P&L' },
                                            ]}
                                            onChange={(v) => setPnlStatus(v as PnlStatusFilter)}
                                        />
                                    </Box>

                                    {/* Balance status */}
                                    <Box>
                                        <Text fontSize="2xs" fontWeight="medium" color="gray.500" mb={1}>Live balance</Text>
                                        <SegmentedControl
                                            value={balanceStatus}
                                            options={[
                                                { value: 'all', label: 'All' },
                                                { value: 'mapped', label: 'Has balance' },
                                                { value: 'unmapped', label: 'No balance' },
                                            ]}
                                            onChange={(v) => setBalanceStatus(v as BalanceStatusFilter)}
                                        />
                                    </Box>
                                </SimpleGrid>

                                {/* Account / Category filter cards */}
                                {(availableAccounts.length > 0 || relevantDimensions.length > 0) && (
                                    <SimpleGrid columns={{ base: 1, md: 2, lg: Math.min(1 + relevantDimensions.length, 3) }} gap={3} mt={3}>
                                        {/* Accounts card */}
                                        {availableAccounts.length > 0 && (() => {
                                            const filteredAccounts = accountFilterSearch
                                                ? availableAccounts.filter(a => a.name.toLowerCase().includes(accountFilterSearch.toLowerCase()))
                                                : availableAccounts;
                                            return (
                                                <Card.Root size="sm" variant="outline" borderColor={selectedAccountIds.length > 0 ? 'blue.200' : 'gray.200'} bg={selectedAccountIds.length > 0 ? 'blue.50' : 'white'}>
                                                    <Card.Body p={2}>
                                                        <Flex align="center" gap={2} mb={1}>
                                                            <Text fontSize="2xs" fontWeight="semibold" color={selectedAccountIds.length > 0 ? 'blue.700' : 'gray.700'}>
                                                                Accounts
                                                            </Text>
                                                            <Badge size="xs" colorPalette={selectedAccountIds.length > 0 ? 'blue' : 'gray'} ml="auto">
                                                                {selectedAccountIds.length || 'All'}/{availableAccounts.length}
                                                            </Badge>
                                                        </Flex>
                                                        <Box position="relative" mb={1}>
                                                            <Input
                                                                placeholder="Search accounts..."
                                                                value={accountFilterSearch}
                                                                onChange={(e) => setAccountFilterSearch(e.target.value)}
                                                                size="xs"
                                                                pl={7}
                                                            />
                                                            <Box position="absolute" left={2} top="50%" transform="translateY(-50%)">
                                                                <FiSearch size={10} color="gray" />
                                                            </Box>
                                                        </Box>
                                                        <Box maxH="100px" overflowY="auto">
                                                            <Flex gap={1} flexWrap="wrap">
                                                                {filteredAccounts.map((account) => {
                                                                    const isSelected = selectedAccountIds.includes(account.id);
                                                                    const color = getAccountColor(account.id);
                                                                    return (
                                                                        <Button
                                                                            key={account.id}
                                                                            size="2xs"
                                                                            variant={isSelected ? 'solid' : 'outline'}
                                                                            onClick={() => setSelectedAccountIds(
                                                                                selectedAccountIds.includes(account.id)
                                                                                    ? selectedAccountIds.filter(id => id !== account.id)
                                                                                    : [...selectedAccountIds, account.id]
                                                                            )}
                                                                            bg={isSelected ? color : 'white'}
                                                                            color={isSelected ? 'white' : 'gray.700'}
                                                                            borderColor={color}
                                                                            _hover={{ bg: isSelected ? color : `${color}15`, opacity: 0.9 }}
                                                                            gap={1}
                                                                            fontSize="xs"
                                                                        >
                                                                            <Box w="6px" h="6px" borderRadius="full" bg={isSelected ? 'currentColor' : color} opacity={isSelected ? 0.7 : 1} />
                                                                            {account.name}
                                                                        </Button>
                                                                    );
                                                                })}
                                                            </Flex>
                                                        </Box>
                                                    </Card.Body>
                                                </Card.Root>
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
                                                <Card.Root key={dimension.id} size="sm" variant="outline" borderColor={selectedInDim > 0 ? 'blue.200' : 'gray.200'} bg={selectedInDim > 0 ? 'blue.50' : 'white'}>
                                                    <Card.Body p={2}>
                                                        <Flex align="center" gap={2} mb={1}>
                                                            <Text fontSize="2xs" fontWeight="semibold" color={selectedInDim > 0 ? 'blue.700' : 'gray.700'}>
                                                                {dimension.label}
                                                            </Text>
                                                            <Badge size="xs" colorPalette={selectedInDim > 0 ? 'blue' : 'gray'} ml="auto">
                                                                {selectedInDim || 'All'}/{dimension.categories.length}
                                                            </Badge>
                                                        </Flex>
                                                        <Box position="relative" mb={1}>
                                                            <Input
                                                                placeholder={`Search ${dimension.label.toLowerCase()}...`}
                                                                value={catFilterSearch}
                                                                onChange={(e) => setCatFilterSearch(e.target.value)}
                                                                size="xs"
                                                                pl={7}
                                                            />
                                                            <Box position="absolute" left={2} top="50%" transform="translateY(-50%)">
                                                                <FiSearch size={10} color="gray" />
                                                            </Box>
                                                        </Box>
                                                        <Box maxH="100px" overflowY="auto">
                                                            <Flex gap={1} flexWrap="wrap">
                                                                {filteredCats.map((category) => {
                                                                    const isSelected = selectedCategoryIds.includes(category.id);
                                                                    return (
                                                                        <Button
                                                                            key={category.id}
                                                                            size="2xs"
                                                                            variant={isSelected ? 'solid' : 'outline'}
                                                                            colorPalette={isSelected ? 'blue' : 'gray'}
                                                                            onClick={() => setSelectedCategoryIds(
                                                                                selectedCategoryIds.includes(category.id)
                                                                                    ? selectedCategoryIds.filter(id => id !== category.id)
                                                                                    : [...selectedCategoryIds, category.id]
                                                                            )}
                                                                            borderColor={category.color || undefined}
                                                                            bg={isSelected && category.color ? category.color : undefined}
                                                                            color={isSelected && category.color ? 'white' : undefined}
                                                                            _hover={{ bg: isSelected ? undefined : 'gray.100', opacity: 0.9 }}
                                                                            fontSize="xs"
                                                                        >
                                                                            {category.label}
                                                                        </Button>
                                                                    );
                                                                })}
                                                            </Flex>
                                                        </Box>
                                                    </Card.Body>
                                                </Card.Root>
                                            );
                                        })}
                                    </SimpleGrid>
                                )}

                            </Collapsible.Content>
                        </Box>
                    </Collapsible.Root>
                )}

                {/* Portfolio totals summary bar (common — always visible) */}
                {(() => {
                    const hasAccountOrCatFilter = (selectedAccountIds?.length ?? 0) > 0 || (selectedCategoryIds?.length ?? 0) > 0;
                    const totals = (!hasAccountOrCatFilter && backendSummary) ? backendSummary : filteredTotals;
                    const showDustNote = !hasAccountOrCatFilter && backendSummary && dustHiddenCount > 0;
                    const totalReturn = totals.totalUnrealized + totals.totalRealized;
                    const roi = totals.totalCost > 0 ? (totalReturn / totals.totalCost) * 100 : 0;
                    const colorFn = (v: number) => (v >= 0 ? 'green.600' : 'red.600');
                    return filtered.length > 0 && totals.totalCost > 0 && (
                        <Box mt={2}>
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
                                <MetricItem label="Cost" value={fmtCurrency(totals.totalCost, baseCurrency)} color="gray.700" icon={<LuReceipt size={14} />} bg="gray.100" />
                                <MetricItem label="Unrealized" value={fmtCurrencySigned(totals.totalUnrealized, baseCurrency)} color={colorFn(totals.totalUnrealized)} icon={totals.totalUnrealized >= 0 ? <FiTrendingUp size={14} /> : <FiTrendingDown size={14} />} bg={totals.totalUnrealized >= 0 ? 'green.50' : 'red.50'} />
                                <MetricItem label="Realized" value={fmtCurrencySigned(totals.totalRealized, baseCurrency)} color={colorFn(totals.totalRealized)} icon={totals.totalRealized >= 0 ? <FiTrendingUp size={14} /> : <FiTrendingDown size={14} />} bg={totals.totalRealized >= 0 ? 'green.50' : 'red.50'} />
                                <MetricItem label="Fees" value={fmtCurrency(totals.totalFees, baseCurrency)} color="orange.700" icon={<LuReceipt size={14} />} bg="orange.50" />
                            </HeroMetricsBar>
                            {showDustNote && (
                                <Text fontSize="2xs" color="gray.400" mt={1} textAlign="right">
                                    {dustHiddenCount} small-value asset{dustHiddenCount !== 1 ? 's' : ''} hidden by dust filter
                                </Text>
                            )}
                        </Box>
                    );
                })()}

                {/* List / Treemap toggle — injected by parent, after PnL bar */}
                {renderAfterFilters && (
                    <Box mt={2}>{renderAfterFilters}</Box>
                )}
            </Card.Header>

            {/* ── List content — highlighted border to separate from shared filters/PnL bar above ── */}
            {!contentHidden && (
                <Box mx={3} mb={3} mt={1} border="2px solid" borderColor="blue.100" borderRadius="md" overflow="hidden">
                    {/* View controls: display mode, group-by, sort */}
                    <Flex align="center" gap={3} px={3} py={2} bg="gray.50" borderBottom="1px solid" borderColor="gray.100" flexWrap="wrap">
                        {/* Display mode toggle — Cards vs Table */}
                        <Flex align="center" gap={1}>
                            <Text fontSize="2xs" fontWeight="medium" color="gray.500">View</Text>
                            <Flex
                                borderRadius="md"
                                border="1px solid"
                                borderColor="gray.200"
                                overflow="hidden"
                            >
                                <Button
                                    size="2xs"
                                    variant={displayMode === 'cards' ? 'subtle' : 'ghost'}
                                    colorPalette={displayMode === 'cards' ? 'blue' : 'gray'}
                                    borderRadius="0"
                                    onClick={() => setDisplayMode('cards')}
                                    px={2}
                                    title="Card view"
                                >
                                    <FiGrid size={12} />
                                </Button>
                                <Button
                                    size="2xs"
                                    variant={displayMode === 'table' ? 'subtle' : 'ghost'}
                                    colorPalette={displayMode === 'table' ? 'blue' : 'gray'}
                                    borderRadius="0"
                                    onClick={() => setDisplayMode('table')}
                                    px={2}
                                    title="Table view"
                                >
                                    <FiList size={12} />
                                </Button>
                            </Flex>
                        </Flex>

                        {/* Group by toggle */}
                        <Flex align="center" gap={1}>
                            <Text fontSize="2xs" fontWeight="medium" color="gray.500">Group</Text>
                            <Flex
                                borderRadius="md"
                                border="1px solid"
                                borderColor="gray.200"
                                overflow="hidden"
                            >
                                <Button
                                    size="2xs"
                                    variant={groupBy === 'asset' ? 'subtle' : 'ghost'}
                                    colorPalette={groupBy === 'asset' ? 'blue' : 'gray'}
                                    borderRadius="0"
                                    onClick={() => handleGroupByChange('asset')}
                                    px={2}
                                    fontSize="xs"
                                >
                                    By Asset
                                </Button>
                                <Button
                                    size="2xs"
                                    variant={groupBy === 'account' ? 'subtle' : 'ghost'}
                                    colorPalette={groupBy === 'account' ? 'blue' : 'gray'}
                                    borderRadius="0"
                                    onClick={() => handleGroupByChange('account')}
                                    px={2}
                                    fontSize="xs"
                                >
                                    By Account
                                </Button>
                            </Flex>
                        </Flex>

                        {/* Sort-by */}
                        <Flex align="center" gap={1}>
                            <Text fontSize="2xs" fontWeight="medium" color="gray.500">Sort</Text>
                            <Flex
                                borderRadius="md"
                                border="1px solid"
                                borderColor="gray.200"
                                overflow="hidden"
                                display="inline-flex"
                            >
                                {[
                                    { value: 'market_value', label: 'Value' },
                                    { value: 'cost_basis', label: 'Cost' },
                                    { value: 'unrealized_pnl', label: 'Unrealized' },
                                    { value: 'realized_pnl', label: 'Realized' },
                                    { value: 'efficiency', label: 'Efficiency' },
                                ].map((opt) => (
                                    <Button
                                        key={opt.value}
                                        size="2xs"
                                        variant={sortField === opt.value ? 'subtle' : 'ghost'}
                                        colorPalette={sortField === opt.value ? 'blue' : 'gray'}
                                        borderRadius="0"
                                        onClick={() => handleSort(opt.value as SortField)}
                                        px={2}
                                        fontSize="xs"
                                    >
                                        {opt.label}
                                        {sortField === opt.value && (
                                            <Text as="span" ml={0.5}>{sortDir === 'asc' ? '↑' : '↓'}</Text>
                                        )}
                                    </Button>
                                ))}
                            </Flex>
                        </Flex>
                    </Flex>

                    {/* Top pagination */}
                    {paginationBar && (
                        <Box borderBottom="1px solid" borderColor="gray.100">
                            {paginationBar}
                        </Box>
                    )}
                    {/* ── Card mode ── */}
                    {displayMode === 'cards' ? (
                        <Box p={3}>
                            {loading ? (
                                <SimpleGrid columns={{ base: 1, sm: 1, md: 2, lg: 5, xl: 5 }} gap={3}>
                                    {Array.from({ length: 8 }).map((_, i) => (
                                        <Card.Root key={i} size="sm">
                                            <Card.Body py={6}>
                                                <Text textAlign="center" color="gray.400" fontSize="xs">Loading...</Text>
                                            </Card.Body>
                                        </Card.Root>
                                    ))}
                                </SimpleGrid>
                            ) : groupBy === 'account' ? (
                                byAccountRows.length === 0 ? (
                                    <Text textAlign="center" py={8} color="gray.500">
                                        {accountBalances && accountBalances.size > 0
                                            ? 'No rows match your criteria'
                                            : 'Loading account breakdown...'}
                                    </Text>
                                ) : (
                                    <SimpleGrid columns={{ base: 1, sm: 1, md: 2, lg: 5, xl: 5 }} gap={3}>
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
                                    </SimpleGrid>
                                )
                            ) : (
                                filtered.length === 0 ? (
                                    <Text textAlign="center" py={8} color="gray.500">No assets match your criteria</Text>
                                ) : (
                                    <SimpleGrid columns={{ base: 1, sm: 1, md: 2, lg: 5, xl: 5 }} gap={3}>
                                        {paginatedFiltered.map((assetpnlrow) => {
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
                                    </SimpleGrid>
                                )
                            )}
                        </Box>
                    ) : (
                        /* ── Table mode (original) ── */
                        <Box overflowX="auto">
                            <Table.Root size="sm">
                                <Table.Header>
                                    <Table.Row>
                                        {groupBy === 'account' ? (
                                            <>
                                                <Table.ColumnHeader>Account</Table.ColumnHeader>
                                                <Table.ColumnHeader>Assets</Table.ColumnHeader>
                                                <Table.ColumnHeader>Cost</Table.ColumnHeader>
                                                <Table.ColumnHeader>Value</Table.ColumnHeader>
                                                <Table.ColumnHeader>Unrealized</Table.ColumnHeader>
                                                <Table.ColumnHeader textAlign="center">Info</Table.ColumnHeader>
                                                <Table.ColumnHeader></Table.ColumnHeader>
                                            </>
                                        ) : (
                                            <>
                                                <SortHeader field="asset_symbol">Asset</SortHeader>
                                                <SortHeader field="quantity">Qty</SortHeader>
                                                <Table.ColumnHeader>
                                                    <Flex align="center" gap={1}>
                                                        Δ
                                                        {liveBalanceLoading && <Spinner size="xs" color="gray.400" />}
                                                    </Flex>
                                                </Table.ColumnHeader>
                                                <SortHeader field="cost_basis">Cost</SortHeader>
                                                <SortHeader field="market_value">Value</SortHeader>
                                                <SortHeader field="unrealized_pnl">Unrealized</SortHeader>
                                                <SortHeader field="realized_pnl">Realized</SortHeader>
                                                <Table.ColumnHeader>Fees</Table.ColumnHeader>
                                                <Table.ColumnHeader textAlign="center">Info</Table.ColumnHeader>
                                                <Table.ColumnHeader></Table.ColumnHeader>
                                            </>
                                        )}
                                    </Table.Row>
                                </Table.Header>
                                <Table.Body>
                                    {(() => {
                                        const colSpan = groupBy === 'account' ? TOTAL_COLUMNS_BY_ACCOUNT : TOTAL_COLUMNS_BY_ASSET;
                                        if (loading) {
                                            return (
                                                <Table.Row>
                                                    <Table.Cell colSpan={colSpan}>
                                                        <Text textAlign="center" py={8} color="gray.500">Loading...</Text>
                                                    </Table.Cell>
                                                </Table.Row>
                                            );
                                        }
                                        if (groupBy === 'account' && byAccountRows.length === 0) {
                                            return (
                                                <Table.Row>
                                                    <Table.Cell colSpan={colSpan}>
                                                        <Text textAlign="center" py={8} color="gray.500">
                                                            {accountBalances && accountBalances.size > 0
                                                                ? 'No rows match your criteria'
                                                                : 'Loading account breakdown...'}
                                                        </Text>
                                                    </Table.Cell>
                                                </Table.Row>
                                            );
                                        }
                                        if (groupBy === 'asset' && filtered.length === 0) {
                                            return (
                                                <Table.Row>
                                                    <Table.Cell colSpan={colSpan}>
                                                        <Text textAlign="center" py={8} color="gray.500">No assets match your criteria</Text>
                                                    </Table.Cell>
                                                </Table.Row>
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
                                                        <Table.Row
                                                            _hover={{ bg: 'blue.50' }}
                                                            css={{ '& td': { py: '2px', px: '4px' } }}
                                                            bg={isAcctExpanded ? 'blue.50' : undefined}
                                                            cursor="pointer"
                                                            onClick={(e) => toggleAccountExpanded(account_id, e)}
                                                        >
                                                            {/* Account */}
                                                            <Table.Cell>
                                                                <Flex align="center" gap={1}>
                                                                    <Box
                                                                        as="button"
                                                                        p={0.5}
                                                                        borderRadius="sm"
                                                                        _hover={{ bg: 'gray.200' }}
                                                                        onClick={(e: React.MouseEvent) => toggleAccountExpanded(account_id, e)}
                                                                    >
                                                                        {isAcctExpanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                                                                    </Box>
                                                                    <Box w="8px" h="8px" borderRadius="full" bg={accountColor} flexShrink={0} />
                                                                    <Text {...XS} fontWeight="medium" truncate maxW="140px" title={account_name}>
                                                                        {account_name}
                                                                    </Text>
                                                                </Flex>
                                                            </Table.Cell>
                                                            {/* Assets count */}
                                                            <Table.Cell>
                                                                <Badge size="xs" variant="subtle">{asset_count}</Badge>
                                                            </Table.Cell>
                                                            {/* Cost */}
                                                            <Table.Cell>
                                                                <Text {...XS}><ValueDisplay value={total_cost_basis} currency={baseCurrency} /></Text>
                                                            </Table.Cell>
                                                            {/* Value */}
                                                            <Table.Cell>
                                                                <Text {...XS} fontWeight="medium">
                                                                    <ValueDisplay value={total_market_value} currency={baseCurrency} />
                                                                </Text>
                                                            </Table.Cell>
                                                            {/* Unrealized P&L */}
                                                            <Table.Cell>
                                                                <Flex direction="column">
                                                                    <Text {...XS} color={total_unrealized_pnl >= 0 ? 'green.600' : 'red.600'}>
                                                                        <ValueDisplay value={total_unrealized_pnl} currency={baseCurrency} />
                                                                    </Text>
                                                                    <Text fontSize="2xs" color="gray.500">{formatPct(unrealizedPct)}</Text>
                                                                </Flex>
                                                            </Table.Cell>
                                                            {/* Info */}
                                                            <Table.Cell textAlign="center">
                                                                <Badge size="xs" variant="subtle">{total_lot_count} lots</Badge>
                                                            </Table.Cell>
                                                            {/* Chevron */}
                                                            <Table.Cell></Table.Cell>
                                                        </Table.Row>

                                                        {/* Expanded asset detail rows */}
                                                        {isAcctExpanded && details.map((d) => {
                                                            const dUnrealizedPct = d.cost_basis > 0 ? d.unrealized_pnl / d.cost_basis : 0;
                                                            return (
                                                                <Table.Row
                                                                    key={`${account_id}-${d.asset_symbol}`}
                                                                    bg="gray.50"
                                                                    _hover={{ bg: 'gray.100' }}
                                                                    css={{ '& td': { py: '1px', px: '4px' } }}
                                                                    cursor="pointer"
                                                                    onClick={() => onAssetClick(d.asset_id)}
                                                                >
                                                                    {/* Asset (indented) */}
                                                                    <Table.Cell pl={10}>
                                                                        <Flex align="center" gap={1}>
                                                                            <Badge size="xs" colorPalette="blue" fontWeight="bold" maxW="80px" truncate>
                                                                                {d.asset_symbol}
                                                                            </Badge>
                                                                            {d.asset_id != null && assetPanelCtx && (
                                                                                <Box
                                                                                    as="button"
                                                                                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); assetPanelCtx.openAssetPanel(d.asset_id!, { pnlVersionId }); }}
                                                                                    p={0.5}
                                                                                    borderRadius="sm"
                                                                                    color="gray.400"
                                                                                    _hover={{ color: 'blue.500', bg: 'blue.50' }}
                                                                                    title="Asset details"
                                                                                >
                                                                                    <LuInfo size={10} />
                                                                                </Box>
                                                                            )}
                                                                        </Flex>
                                                                    </Table.Cell>
                                                                    {/* Qty */}
                                                                    <Table.Cell>
                                                                        <Text {...XS} color="gray.600"><ValueDisplay value={d.qty} /></Text>
                                                                    </Table.Cell>
                                                                    {/* Cost */}
                                                                    <Table.Cell>
                                                                        {renderCost(d.cost_basis, d.unit_cost, baseCurrency)}
                                                                    </Table.Cell>
                                                                    {/* Value */}
                                                                    <Table.Cell>
                                                                        <Text {...XS} color="gray.600">
                                                                            <ValueDisplay value={d.market_value} currency={baseCurrency} />
                                                                        </Text>
                                                                    </Table.Cell>
                                                                    {/* Unrealized */}
                                                                    <Table.Cell>
                                                                        <Flex direction="column">
                                                                            <Text {...XS} color={d.unrealized_pnl >= 0 ? 'green.600' : 'red.600'}>
                                                                                <ValueDisplay value={d.unrealized_pnl} currency={baseCurrency} />
                                                                            </Text>
                                                                            <Text fontSize="2xs" color="gray.500">{formatPct(dUnrealizedPct)}</Text>
                                                                        </Flex>
                                                                    </Table.Cell>
                                                                    {/* Info */}
                                                                    <Table.Cell textAlign="center">
                                                                        <Badge size="xs" variant="subtle">{d.lot_count} lots</Badge>
                                                                    </Table.Cell>
                                                                    {/* Chevron */}
                                                                    <Table.Cell>
                                                                        <FiChevronRight size={12} color="gray" />
                                                                    </Table.Cell>
                                                                </Table.Row>
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

                                                    return (
                                                        <Fragment key={assetpnlrow.asset.id ?? `nopnl-${assetpnlrow.asset.symbol}`}>
                                                            <Table.Row
                                                                cursor={isNoPnl ? 'default' : 'pointer'}
                                                                _hover={{ bg: isNoPnl ? 'gray.100' : 'blue.50' }}
                                                                onClick={isNoPnl ? undefined : () => onAssetClick(assetpnlrow.asset.id)}
                                                                bg={isExpanded ? 'blue.50' : isNoPnl ? 'gray.50' : undefined}
                                                                css={{ '& td': { py: '2px', px: '4px' } }}
                                                                opacity={isUnmapped ? 0.6 : undefined}
                                                            >
                                                                {/* Asset */}
                                                                <Table.Cell>
                                                                    <Flex align="center" gap={1}>
                                                                        {isExpandable ? (
                                                                            <Box
                                                                                as="button"
                                                                                onClick={(e: React.MouseEvent) => assetId != null && toggleExpanded(assetId, e)}
                                                                                p={0.5}
                                                                                borderRadius="sm"
                                                                                _hover={{ bg: 'gray.200' }}
                                                                            >
                                                                                {isExpanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                                                                            </Box>
                                                                        ) : (
                                                                            <Box w="18px" />
                                                                        )}
                                                                        <Tooltip content={assetpnlrow.asset.label ? `${assetpnlrow.asset.label} (${assetpnlrow.asset.symbol})` : (assetpnlrow.asset.symbol || '')} openDelay={300}>
                                                                            <Badge
                                                                                size="xs"
                                                                                colorPalette={isUnmapped ? 'gray' : 'blue'}
                                                                                variant={isUnmapped ? 'outline' : 'solid'}
                                                                                fontWeight="bold"
                                                                                maxW="120px"
                                                                                truncate
                                                                            >
                                                                                {assetpnlrow.asset.label ? `${assetpnlrow.asset.label} (${assetpnlrow.asset.symbol})` : assetpnlrow.asset.symbol}
                                                                            </Badge>
                                                                        </Tooltip>
                                                                        {assetpnlrow.asset.id != null && assetPanelCtx && (
                                                                            <Box
                                                                                as="button"
                                                                                onClick={(e: React.MouseEvent) => { e.stopPropagation(); assetPanelCtx.openAssetPanel(assetpnlrow.asset.id!, { pnlVersionId }); }}
                                                                                p={0.5}
                                                                                borderRadius="sm"
                                                                                color="gray.400"
                                                                                _hover={{ color: 'blue.500', bg: 'blue.50' }}
                                                                                title="Asset details"
                                                                            >
                                                                                <LuInfo size={12} />
                                                                            </Box>
                                                                        )}
                                                                        {isUnmapped && (
                                                                            <Tooltip content="This asset is not mapped in the database" openDelay={200}>
                                                                                <Text color="orange.500" fontSize="xs" cursor="help">⚠</Text>
                                                                            </Tooltip>
                                                                        )}
                                                                    </Flex>
                                                                </Table.Cell>
                                                                {/* Qty */}
                                                                <Table.Cell>
                                                                    {isNoPnl
                                                                        ? <Text {...XS} color="gray.400">—</Text>
                                                                        : <Text {...XS}><ValueDisplay value={assetpnlrow.quantity} /></Text>
                                                                    }
                                                                </Table.Cell>
                                                                {/* Δ (combined) */}
                                                                <Table.Cell>
                                                                    {liveBalanceLoading
                                                                        ? <Spinner size="xs" color="gray.400" />
                                                                        : (
                                                                            <Flex align="center" gap={0.5}>
                                                                                <DeltaBar delta={deltaInfo} liveQty={liveQty} pnlQty={assetpnlrow.quantity} size="xs" />
                                                                                {hasLiveErrors && (
                                                                                    <Tooltip
                                                                                        content={
                                                                                            <Box fontSize="xs">
                                                                                                <Text fontWeight="medium" mb={1}>Some accounts had fetch errors — balance may be incomplete</Text>
                                                                                                {assetErrorAccounts.map(accId => {
                                                                                                    const errs = liveAccountErrors!.get(accId) ?? [];
                                                                                                    const accName = accounts.find(a => a.id === accId)?.name ?? `Account ${accId}`;
                                                                                                    return errs.map((err, i) => (
                                                                                                        <Text key={`${accId}-${i}`} color="red.300">{accName}: {err}</Text>
                                                                                                    ));
                                                                                                })}
                                                                                            </Box>
                                                                                        }
                                                                                        openDelay={200}
                                                                                    >
                                                                                        <Text fontSize="xs" color="orange.500" cursor="help" flexShrink={0}>⚠</Text>
                                                                                    </Tooltip>
                                                                                )}
                                                                            </Flex>
                                                                        )
                                                                    }
                                                                </Table.Cell>
                                                                {/* Cost (combined) */}
                                                                <Table.Cell>
                                                                    {isNoPnl
                                                                        ? <Text {...XS} color="gray.400">N/A</Text>
                                                                        : renderCost(assetpnlrow.cost_basis, assetpnlrow.unit_cost, baseCurrency)
                                                                    }
                                                                </Table.Cell>
                                                                {/* Value (combined) */}
                                                                <Table.Cell>
                                                                    {renderValue(assetpnlrow, baseCurrency)}
                                                                </Table.Cell>
                                                                {/* Unrealized P&L */}
                                                                <Table.Cell>
                                                                    {isNoPnl ? (
                                                                        <Text {...XS} color="gray.400">N/A</Text>
                                                                    ) : assetpnlrow.unit_value == null ? (
                                                                        <Flex align="center" gap={1}>
                                                                            <Text {...XS} color="gray.400">—</Text>
                                                                            {assetpnlrow.price_error && <FiAlertCircle size={10} color="#E53E3E" />}
                                                                        </Flex>
                                                                    ) : (
                                                                        <Flex direction="column">
                                                                            <Text {...XS} fontWeight="medium" color={assetpnlrow.unrealized_pnl >= 0 ? 'green.600' : 'red.600'}>
                                                                                <ValueDisplay value={assetpnlrow.unrealized_pnl} currency={baseCurrency} />
                                                                            </Text>
                                                                            <Text fontSize="2xs" color="gray.500">{formatPct(assetpnlrow.unrealized_pnl_pct)}</Text>
                                                                        </Flex>
                                                                    )}
                                                                </Table.Cell>
                                                                {/* Realized P&L */}
                                                                <Table.Cell>
                                                                    {isNoPnl ? (
                                                                        <Text {...XS} color="gray.400">N/A</Text>
                                                                    ) : (
                                                                        <Text {...XS} fontWeight="medium" color={assetpnlrow.realized_pnl >= 0 ? 'green.600' : 'red.600'}>
                                                                            <ValueDisplay value={assetpnlrow.realized_pnl} currency={baseCurrency} />
                                                                        </Text>
                                                                    )}
                                                                </Table.Cell>
                                                                {/* Fees */}
                                                                <Table.Cell>
                                                                    {isNoPnl ? (
                                                                        <Text {...XS} color="gray.400">N/A</Text>
                                                                    ) : (
                                                                        <Text {...XS} color="gray.600">
                                                                            <ValueDisplay value={assetpnlrow.total_fees} currency={baseCurrency} />
                                                                        </Text>
                                                                    )}
                                                                </Table.Cell>
                                                                {/* Info */}
                                                                <Table.Cell textAlign="center">
                                                                    {isNoPnl ? (
                                                                        isUnmapped
                                                                            ? <Badge size="xs" colorPalette="orange" variant="subtle">Unmapped</Badge>
                                                                            : <Badge size="xs" colorPalette="yellow" variant="subtle">No P&L</Badge>
                                                                    ) : (
                                                                        <Flex gap={0.5} justify="center" align="center">
                                                                            {assetAccountBalances && assetAccountBalances.length > 1 && (
                                                                                <Flex gap={0.5} mr={0.5}>
                                                                                    {assetAccountBalances.slice(0, 3).map((bal) => (
                                                                                        <Box
                                                                                            key={bal.account_id}
                                                                                            w="6px"
                                                                                            h="6px"
                                                                                            borderRadius="full"
                                                                                            bg={getAccountColor(bal.account_id)}
                                                                                            title={bal.account_name}
                                                                                        />
                                                                                    ))}
                                                                                    {assetAccountBalances.length > 3 && (
                                                                                        <Text fontSize="2xs" color="gray.500">+{assetAccountBalances.length - 3}</Text>
                                                                                    )}
                                                                                </Flex>
                                                                            )}
                                                                            <Badge size="xs" variant="subtle">{assetpnlrow.lot_count} lots</Badge>
                                                                            {assetpnlrow.warning_count > 0 && (
                                                                                <Badge size="xs" colorPalette="orange">{assetpnlrow.warning_count} ⚠</Badge>
                                                                            )}
                                                                        </Flex>
                                                                    )}
                                                                </Table.Cell>
                                                                {/* Chevron */}
                                                                <Table.Cell>
                                                                    {!isNoPnl && <FiChevronRight size={12} color="gray" />}
                                                                </Table.Cell>
                                                            </Table.Row>

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
                                                                    <Table.Row
                                                                        key={`${assetpnlrow.asset.id}-${balance.account_id}`}
                                                                        bg="gray.50"
                                                                        _hover={{ bg: 'gray.100' }}
                                                                        css={{ '& td': { py: '1px', px: '4px' }, '& td:first-of-type': { borderLeft: '2px solid', borderLeftColor: accountColor, pl: '28px' } }}
                                                                    >
                                                                        {/* Account name (indented, border starts right of parent asset name) */}
                                                                        <Table.Cell>
                                                                            <Flex align="center" gap={1}>
                                                                                <Box w="8px" h="8px" borderRadius="full" bg={accountColor} flexShrink={0} />
                                                                                <Text
                                                                                    {...XS}
                                                                                    color="gray.700"
                                                                                    cursor={onAccountClick ? 'pointer' : undefined}
                                                                                    _hover={onAccountClick ? { textDecoration: 'underline', color: 'blue.600' } : undefined}
                                                                                    onClick={(e) => {
                                                                                        if (onAccountClick && assetId != null) {
                                                                                            e.stopPropagation();
                                                                                            onAccountClick(assetId, balance.account_id);
                                                                                        }
                                                                                    }}
                                                                                >
                                                                                    {balance.account_name}
                                                                                </Text>
                                                                            </Flex>
                                                                        </Table.Cell>
                                                                        {/* Qty */}
                                                                        <Table.Cell>
                                                                            <Text {...XS} color="gray.600"><ValueDisplay value={balance.qty} /></Text>
                                                                        </Table.Cell>
                                                                        {/* Δ (combined) */}
                                                                        <Table.Cell>
                                                                            {acctHasError ? (
                                                                                <Tooltip
                                                                                    content={
                                                                                        <Box fontSize="xs">
                                                                                            <Text fontWeight="medium" mb={1}>Fetch error:</Text>
                                                                                            {acctErrors!.map((err, i) => <Text key={i} color="red.300">{err}</Text>)}
                                                                                        </Box>
                                                                                    }
                                                                                    openDelay={200}
                                                                                >
                                                                                    <Text fontSize="xs" color="red.500" cursor="help">⚠ err</Text>
                                                                                </Tooltip>
                                                                            ) : (
                                                                                <DeltaBar delta={acctDelta} liveQty={acctLiveQty} pnlQty={balance.qty} size="xs" />
                                                                            )}
                                                                        </Table.Cell>
                                                                        {/* Cost (combined) */}
                                                                        <Table.Cell>
                                                                            {renderCost(balance.cost_basis_in_base, balance.avg_unit_cost_in_base, baseCurrency)}
                                                                        </Table.Cell>
                                                                        {/* Value (combined) */}
                                                                        <Table.Cell>
                                                                            <Text {...XS} color="gray.600">
                                                                                {unitPrice != null
                                                                                    ? <ValueDisplay value={marketValue} currency={baseCurrency} />
                                                                                    : '—'}
                                                                            </Text>
                                                                        </Table.Cell>
                                                                        {/* Unrealized */}
                                                                        <Table.Cell>
                                                                            {unitPrice != null ? (
                                                                                <Flex direction="column">
                                                                                    <Text {...XS} color={unrealizedPnl >= 0 ? 'green.600' : 'red.600'}>
                                                                                        <ValueDisplay value={unrealizedPnl} currency={baseCurrency} />
                                                                                    </Text>
                                                                                    <Text fontSize="2xs" color="gray.500">{formatPct(unrealizedPnlPct)}</Text>
                                                                                </Flex>
                                                                            ) : (
                                                                                <Text {...XS} color="gray.500">—</Text>
                                                                            )}
                                                                        </Table.Cell>
                                                                        {/* Realized */}
                                                                        <Table.Cell><Text {...XS} color="gray.500">—</Text></Table.Cell>
                                                                        {/* Fees */}
                                                                        <Table.Cell><Text {...XS} color="gray.500">—</Text></Table.Cell>
                                                                        {/* Info */}
                                                                        <Table.Cell textAlign="center">
                                                                            <Badge size="xs" variant="subtle">{balance.lot_count} lots</Badge>
                                                                        </Table.Cell>
                                                                        {/* Chevron */}
                                                                        <Table.Cell></Table.Cell>
                                                                    </Table.Row>
                                                                );
                                                            })}
                                                        </Fragment>
                                                    );
                                                })}
                                            </>
                                        );
                                    })()}
                                </Table.Body>
                            </Table.Root>
                        </Box>
                    )}

                    {/* Bottom pagination */}
                    {paginationBar && (
                        <Box borderTop="1px solid" borderColor="gray.100">
                            {paginationBar}
                        </Box>
                    )}
                </Box>
            )}
        </Card.Root>
    );
};

export default AssetPnLTable;
