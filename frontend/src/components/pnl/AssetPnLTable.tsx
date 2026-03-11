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

import React, { useState, useMemo, useCallback, useEffect, Fragment } from 'react';
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
import { FiChevronRight, FiChevronDown, FiChevronLeft, FiChevronsLeft, FiChevronsRight, FiSearch, FiAlertCircle, FiGrid, FiUsers, FiFilter, FiX, FiList } from 'react-icons/fi';
import { AssetPnLCard } from './AssetPnLCard';
import { AccountPnLCard } from './AccountPnLCard';
import { AssetPnLRow, AccountBalanceBreakdown, UnmappedLiveAsset } from './types';
import { Account } from '../../types';
import { Tooltip } from '../ui/tooltip';
import { formatDateTimeLocale } from '../../utils/dateUtils';
import { ValueDisplay } from '../ValueDisplay';
import { getAccountColor } from '../../utils/accountColors';
import { DeltaBar } from './DeltaBar';
import { computeDelta, formatPct } from './deltaUtils';

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const TOTAL_COLUMNS_BY_ASSET = 10;
const TOTAL_COLUMNS_BY_ACCOUNT = 7;

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;

/** Extra-small font style applied to all table cells */
const XS: { fontSize: string } = { fontSize: 'xs' };

type GroupBy = 'asset' | 'account';
type DisplayMode = 'cards' | 'table';

/** Filter values for the unified filter section */
type PnlStatusFilter = 'all' | 'with_pnl' | 'no_pnl';
type BalanceStatusFilter = 'all' | 'mapped' | 'unmapped';

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

type SortField = 'asset_symbol' | 'quantity' | 'market_value' | 'cost_basis' | 'unrealized_pnl' | 'realized_pnl';
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
    onLoadAccountBalances,
    liveBalances,
    liveAccountBalances,
    liveBalanceLoading = false,
    unmappedLiveAssets = [],
    liveAccountErrors,
    liveFetchedAccountIds,
}) => {
    const [sortField, setSortField] = useState<SortField>('market_value');
    const [sortDir, setSortDir] = useState<SortDirection>('desc');
    const [expandedAssetIds, setExpandedAssetIds] = useState<Set<number>>(new Set());
    const [expandedAccountIds, setExpandedAccountIds] = useState<Set<number>>(new Set());
    const [groupBy, setGroupBy] = useState<GroupBy>('asset');
    const [displayMode, setDisplayMode] = useState<DisplayMode>('cards');

    // --- Unified filter state ---
    const [search, setSearch] = useState('');
    const [minMarketValue, setMinMarketValue] = useState(5);
    const [pnlStatus, setPnlStatus] = useState<PnlStatusFilter>('all');
    const [balanceStatus, setBalanceStatus] = useState<BalanceStatusFilter>('all');
    const [filtersExpanded, setFiltersExpanded] = useState(false);

    // --- Pagination state ---
    const [page, setPage] = useState(0);
    const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);

    // Active filter count
    const activeFilterCount = useMemo(() => {
        let count = 0;
        if (search) count++;
        if (minMarketValue > 0) count++;
        if (pnlStatus !== 'all') count++;
        if (balanceStatus !== 'all') count++;
        return count;
    }, [search, minMarketValue, pnlStatus, balanceStatus]);

    const clearAllFilters = () => {
        setSearch('');
        setMinMarketValue(0);
        setPnlStatus('all');
        setBalanceStatus('all');
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

                // P&L status filter
                if (pnlStatus === 'with_pnl' && !a.has_lots) return false;
                if (pnlStatus === 'no_pnl' && a.has_lots) return false;

                // Balance status filter
                const sym = a.asset.symbol?.toUpperCase() ?? '';
                const liveQty = liveBalances?.get(sym);
                if (balanceStatus === 'mapped' && (liveQty == null || liveQty === 0)) return false;
                if (balanceStatus === 'unmapped' && liveQty != null && liveQty > 0) return false;

                // Market-value slider filter — skip for assets without P&L data (N/A)
                if (minMarketValue > 0 && a.has_lots) {
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
    }, [allAssets, search, sortField, sortDir, minMarketValue, liveBalances, pnlStatus, balanceStatus]);

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
    useEffect(() => { resetPage(); }, [search, minMarketValue, pnlStatus, balanceStatus, sortField, sortDir, groupBy, displayMode, resetPage]);

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
                    variant={value === opt.value ? 'solid' : 'ghost'}
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

    return (
        <Card.Root>
            <Card.Header pb={2}>
                {/* Top row: Title (left) + Group-by toggle (right) */}
                <Flex justify="space-between" align="center" mb={2}>
                    <Text fontWeight="bold" fontSize="lg">
                        {groupBy === 'asset'
                            ? `Asset P&L (${filtered.length} assets)`
                            : `Asset P&L (${byAccountRows.length} accounts)`
                        }
                    </Text>

                    <Flex align="center" gap={2}>
                        {/* Display mode toggle — Cards vs Table */}
                        <Flex
                            borderRadius="md"
                            border="1px solid"
                            borderColor="gray.200"
                            overflow="hidden"
                        >
                            <Button
                                size="xs"
                                variant={displayMode === 'cards' ? 'solid' : 'ghost'}
                                colorPalette={displayMode === 'cards' ? 'blue' : 'gray'}
                                borderRadius="0"
                                onClick={() => setDisplayMode('cards')}
                                px={2}
                                title="Card view"
                            >
                                <FiGrid size={12} />
                            </Button>
                            <Button
                                size="xs"
                                variant={displayMode === 'table' ? 'solid' : 'ghost'}
                                colorPalette={displayMode === 'table' ? 'blue' : 'gray'}
                                borderRadius="0"
                                onClick={() => setDisplayMode('table')}
                                px={2}
                                title="Table view"
                            >
                                <FiList size={12} />
                            </Button>
                        </Flex>

                        {/* Group by toggle */}
                        <Flex
                            borderRadius="md"
                            border="1px solid"
                            borderColor="gray.200"
                            overflow="hidden"
                        >
                            <Button
                                size="xs"
                                variant={groupBy === 'asset' ? 'solid' : 'ghost'}
                                colorPalette={groupBy === 'asset' ? 'blue' : 'gray'}
                                borderRadius="0"
                                onClick={() => handleGroupByChange('asset')}
                                gap={1}
                            >
                                By Asset
                            </Button>
                            <Button
                                size="xs"
                                variant={groupBy === 'account' ? 'solid' : 'ghost'}
                                colorPalette={groupBy === 'account' ? 'blue' : 'gray'}
                                borderRadius="0"
                                onClick={() => handleGroupByChange('account')}
                                gap={1}
                            >
                                By Account
                            </Button>
                        </Flex>
                    </Flex>
                </Flex>

                {/* Filter section — collapsible */}
                <Collapsible.Root open={filtersExpanded}>
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

                    <Collapsible.Content>
                        <SimpleGrid columns={{ base: 1, md: 2, lg: 4 }} gap={3} mt={2} pb={1}>
                            {/* Asset name search */}
                            <Box>
                                <Text fontSize="2xs" fontWeight="medium" color="gray.500" mb={1}>Asset name</Text>
                                <Box position="relative">
                                    <Input
                                        placeholder="Search..."
                                        value={search}
                                        onChange={(e) => setSearch(e.target.value)}
                                        size="xs"
                                        pl={7}
                                    />
                                    <Box position="absolute" left={2} top="50%" transform="translateY(-50%)">
                                        <FiSearch size={12} color="gray" />
                                    </Box>
                                </Box>
                            </Box>

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
                        {/* Sort-by dropdown (visible in card mode) */}
                        {displayMode === 'cards' && (
                            <Flex align="center" gap={2} mt={2}>
                                <Text fontSize="2xs" fontWeight="medium" color="gray.500">Sort by</Text>
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
                                        { value: 'asset_symbol', label: 'Symbol' },
                                        { value: 'quantity', label: 'Qty' },
                                    ].map((opt) => (
                                        <Button
                                            key={opt.value}
                                            size="2xs"
                                            variant={sortField === opt.value ? 'solid' : 'ghost'}
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
                        )}
                    </Collapsible.Content>
                </Collapsible.Root>
            </Card.Header>

            <Card.Body p={0}>
                {/* ── Card mode ── */}
                {displayMode === 'cards' ? (
                    <Box p={3}>
                        {loading ? (
                            <SimpleGrid columns={{ base: 1, sm: 1, md: 2, lg: 3, xl: 4 }} gap={3}>
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
                                <SimpleGrid columns={{ base: 1, sm: 1, md: 2, lg: 3, xl: 4 }} gap={3}>
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
                                <SimpleGrid columns={{ base: 1, sm: 1, md: 2, lg: 3, xl: 4 }} gap={3}>
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
                                                                    <Badge size="xs" colorPalette="blue" fontWeight="bold" maxW="80px" truncate>
                                                                        {d.asset_symbol}
                                                                    </Badge>
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
            </Card.Body>

            {/* Pagination footer */}
            {totalRows > PAGE_SIZE_OPTIONS[0] && (
                <Card.Footer py={2} px={3} borderTop="1px solid" borderColor="gray.100">
                    <Flex justify="space-between" align="center" width="100%">
                        {/* Left: page size selector */}
                        <Flex align="center" gap={2}>
                            <Text fontSize="2xs" color="gray.500">Rows:</Text>
                            <Flex
                                borderRadius="md"
                                border="1px solid"
                                borderColor="gray.200"
                                overflow="hidden"
                                display="inline-flex"
                            >
                                {PAGE_SIZE_OPTIONS.map((size) => (
                                    <Button
                                        key={size}
                                        size="2xs"
                                        variant={pageSize === size ? 'solid' : 'ghost'}
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

                        {/* Center: showing range */}
                        <Text fontSize="2xs" color="gray.500">
                            {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, totalRows)} of {totalRows}
                        </Text>

                        {/* Right: page navigation */}
                        <Flex align="center" gap={1}>
                            <Button
                                size="2xs"
                                variant="ghost"
                                onClick={() => setPage(0)}
                                disabled={safePage === 0}
                                px={1}
                            >
                                <FiChevronsLeft size={12} />
                            </Button>
                            <Button
                                size="2xs"
                                variant="ghost"
                                onClick={() => setPage(p => Math.max(0, p - 1))}
                                disabled={safePage === 0}
                                px={1}
                            >
                                <FiChevronLeft size={14} />
                            </Button>
                            <Text fontSize="xs" color="gray.600" mx={1}>
                                {safePage + 1} / {pageCount}
                            </Text>
                            <Button
                                size="2xs"
                                variant="ghost"
                                onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                                disabled={safePage >= pageCount - 1}
                                px={1}
                            >
                                <FiChevronRight size={14} />
                            </Button>
                            <Button
                                size="2xs"
                                variant="ghost"
                                onClick={() => setPage(pageCount - 1)}
                                disabled={safePage >= pageCount - 1}
                                px={1}
                            >
                                <FiChevronsRight size={12} />
                            </Button>
                        </Flex>
                    </Flex>
                </Card.Footer>
            )}
        </Card.Root>
    );
};

export default AssetPnLTable;
