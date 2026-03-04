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

import React, { useState, useMemo, Fragment } from 'react';
import {
    Badge,
    Box,
    Button,
    Card,
    Flex,
    Input,
    Slider,
    Spinner,
    Switch,
    Table,
    Text,
} from '@chakra-ui/react';
import { FiChevronRight, FiChevronDown, FiSearch, FiAlertCircle, FiGrid, FiUsers } from 'react-icons/fi';
import { AssetPnLRow, AccountBalanceBreakdown, UnmappedLiveAsset } from './types';
import { Account } from '../../types';
import { Tooltip } from '../ui/tooltip';
import { formatDateTimeLocale } from '../../utils/dateUtils';
import { formatQuantity } from '../../utils/numberUtils';
import { ValueDisplay } from '../ValueDisplay';
import { getAccountColor } from '../../utils/accountColors';
import { DeltaBar } from './DeltaBar';
import { computeDelta, formatPct, MATCH_TOLERANCE } from './deltaUtils';

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const TOTAL_COLUMNS_BY_ASSET = 10;
const TOTAL_COLUMNS_BY_ACCOUNT = 7;

/** Extra-small font style applied to all table cells */
const XS: { fontSize: string } = { fontSize: 'xs' };

type GroupBy = 'asset' | 'account';

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
    loading = false,
    accountBalances,
    accounts = [],
    onLoadAccountBalances,
    liveBalances,
    liveAccountBalances,
    liveBalanceLoading = false,
    unmappedLiveAssets = [],
}) => {
    const [search, setSearch] = useState('');
    const [sortField, setSortField] = useState<SortField>('market_value');
    const [sortDir, setSortDir] = useState<SortDirection>('desc');
    const [expandedAssetIds, setExpandedAssetIds] = useState<Set<number>>(new Set());
    const [expandedAccountIds, setExpandedAccountIds] = useState<Set<number>>(new Set());
    const [groupBy, setGroupBy] = useState<GroupBy>('asset');

    // --- Filter state ---
    const [minMarketValue, setMinMarketValue] = useState(5);
    const [showUnmapped, setShowUnmapped] = useState(false);

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

    // Check if asset has multiple accounts (expandable)
    const hasMultipleAccounts = (row: AssetPnLRow): boolean => {
        return row.account_ids != null && row.account_ids.length > 1;
    };

    // --- Filter + sort ---
    const { filtered, dustHiddenCount } = useMemo(() => {
        let dustCount = 0;

        const result = assets
            .filter((a) => {
                // Text search
                if (search && (!a.asset.symbol || !a.asset.symbol.toLowerCase().includes(search.toLowerCase()))) {
                    return false;
                }

                const sym = a.asset.symbol?.toUpperCase() ?? '';
                const liveQty = liveBalances?.get(sym);

                // Market-value slider filter
                if (minMarketValue > 0) {
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
    }, [assets, search, sortField, sortDir, minMarketValue, liveBalances]);

    // Filtered unmapped assets (apply search + dust filter)
    const filteredUnmapped = useMemo(() => {
        if (!showUnmapped) return [];
        return unmappedLiveAssets.filter((u) => {
            if (search && !u.symbol.toLowerCase().includes(search.toLowerCase())) return false;
            if (minMarketValue > 0 && u.marketValue != null && Math.abs(u.marketValue) < minMarketValue) return false;
            return true;
        });
    }, [unmappedLiveAssets, showUnmapped, search, minMarketValue]);

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

    return (
        <Card.Root>
            <Card.Header>
                <Flex justify="space-between" align="center" wrap="wrap" gap={2}>
                    <Flex align="center" gap={3}>
                        <Text fontWeight="bold" fontSize="lg">
                            {groupBy === 'asset'
                                ? `Asset P&L (${filtered.length} assets)`
                                : `Asset P&L (${byAccountRows.length} accounts)`
                            }
                        </Text>

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
                                <FiGrid size={12} />
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
                                <FiUsers size={12} />
                                By Account
                            </Button>
                        </Flex>
                    </Flex>

                    <Flex gap={3} align="center">
                        {/* Search */}
                        <Box position="relative">
                            <Input
                                placeholder="Search assets..."
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                size="sm"
                                width="180px"
                                pl={8}
                            />
                            <Box position="absolute" left={2} top="50%" transform="translateY(-50%)">
                                <FiSearch size={14} color="gray" />
                            </Box>
                        </Box>

                        {/* Market-value slider */}
                        <Flex align="center" gap={2} minW="180px">
                            <Text fontSize="xs" color="gray.600" whiteSpace="nowrap">Min value</Text>
                            <Slider.Root
                                size="sm"
                                min={0}
                                max={100}
                                step={1}
                                value={[minMarketValue]}
                                onValueChange={(details) => setMinMarketValue(details.value[0])}
                                width="100px"
                            >
                                <Slider.Control>
                                    <Slider.Track>
                                        <Slider.Range />
                                    </Slider.Track>
                                    <Slider.Thumbs />
                                </Slider.Control>
                            </Slider.Root>
                            <Text fontSize="xs" color="gray.600" whiteSpace="nowrap" minW="24px" textAlign="right">
                                ${minMarketValue}
                            </Text>
                            {dustHiddenCount > 0 && (
                                <Text fontSize="xs" color="gray.400">({dustHiddenCount})</Text>
                            )}
                        </Flex>

                        {/* Show unmapped toggle */}
                        {unmappedLiveAssets.length > 0 && (
                            <Flex align="center" gap={1}>
                                <Switch.Root
                                    size="sm"
                                    checked={showUnmapped}
                                    onCheckedChange={(details) => setShowUnmapped(details.checked)}
                                >
                                    <Switch.HiddenInput />
                                    <Switch.Control>
                                        <Switch.Thumb />
                                    </Switch.Control>
                                </Switch.Root>
                                <Text fontSize="xs" color="gray.600" whiteSpace="nowrap">
                                    Show unmapped ({unmappedLiveAssets.length})
                                </Text>
                            </Flex>
                        )}
                    </Flex>
                </Flex>
            </Card.Header>

            <Card.Body p={0}>
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
                                if (groupBy === 'asset' && filtered.length === 0 && filteredUnmapped.length === 0) {
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
                                    return byAccountRows.map((row) => {
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
                                        {filtered.map((assetpnlrow) => {
                                            const assetId = assetpnlrow.asset.id;
                                            const isExpandable = hasMultipleAccounts(assetpnlrow);
                                            const isExpanded = assetId != null && expandedAssetIds.has(assetId);
                                            const assetAccountBalances = assetId != null ? accountBalances?.get(assetId) : undefined;

                                            // Live balance data
                                            const sym = assetpnlrow.asset.symbol?.toUpperCase() ?? '';
                                            const liveQty = liveBalances?.get(sym);
                                            const deltaInfo = computeDelta(assetpnlrow.quantity, liveQty);

                                            return (
                                                <Fragment key={assetpnlrow.asset.id}>
                                                    <Table.Row
                                                        cursor="pointer"
                                                        _hover={{ bg: 'blue.50' }}
                                                        onClick={() => onAssetClick(assetpnlrow.asset.id)}
                                                        bg={isExpanded ? 'blue.50' : undefined}
                                                        css={{ '& td': { py: '2px', px: '4px' } }}
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
                                                                <Badge size="xs" colorPalette="blue" fontWeight="bold" maxW="80px" truncate>
                                                                    {assetpnlrow.asset.symbol}
                                                                </Badge>
                                                            </Flex>
                                                        </Table.Cell>
                                                        {/* Qty */}
                                                        <Table.Cell>
                                                            <Text {...XS}><ValueDisplay value={assetpnlrow.quantity} /></Text>
                                                        </Table.Cell>
                                                        {/* Δ (combined) */}
                                                        <Table.Cell>
                                                            {liveBalanceLoading
                                                                ? <Spinner size="xs" color="gray.400" />
                                                                : <DeltaBar delta={deltaInfo} liveQty={liveQty} pnlQty={assetpnlrow.quantity} size="xs" />
                                                            }
                                                        </Table.Cell>
                                                        {/* Cost (combined) */}
                                                        <Table.Cell>
                                                            {renderCost(assetpnlrow.cost_basis, assetpnlrow.unit_cost, baseCurrency)}
                                                        </Table.Cell>
                                                        {/* Value (combined) */}
                                                        <Table.Cell>
                                                            {renderValue(assetpnlrow, baseCurrency)}
                                                        </Table.Cell>
                                                        {/* Unrealized P&L */}
                                                        <Table.Cell>
                                                            <Flex direction="column">
                                                                <Text {...XS} fontWeight="medium" color={assetpnlrow.unrealized_pnl >= 0 ? 'green.600' : 'red.600'}>
                                                                    <ValueDisplay value={assetpnlrow.unrealized_pnl} currency={baseCurrency} />
                                                                </Text>
                                                                <Text fontSize="2xs" color="gray.500">{formatPct(assetpnlrow.unrealized_pnl_pct)}</Text>
                                                            </Flex>
                                                        </Table.Cell>
                                                        {/* Realized P&L */}
                                                        <Table.Cell>
                                                            <Text {...XS} fontWeight="medium" color={assetpnlrow.realized_pnl >= 0 ? 'green.600' : 'red.600'}>
                                                                <ValueDisplay value={assetpnlrow.realized_pnl} currency={baseCurrency} />
                                                            </Text>
                                                        </Table.Cell>
                                                        {/* Fees */}
                                                        <Table.Cell>
                                                            <Text {...XS} color="gray.600">
                                                                <ValueDisplay value={assetpnlrow.total_fees} currency={baseCurrency} />
                                                            </Text>
                                                        </Table.Cell>
                                                        {/* Info */}
                                                        <Table.Cell textAlign="center">
                                                            <Flex gap={0.5} justify="center" align="center">
                                                                {isExpandable && assetAccountBalances && (
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
                                                        </Table.Cell>
                                                        {/* Chevron */}
                                                        <Table.Cell><FiChevronRight size={12} color="gray" /></Table.Cell>
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

                                                        return (
                                                            <Table.Row
                                                                key={`${assetpnlrow.asset.id}-${balance.account_id}`}
                                                                bg="gray.50"
                                                                _hover={{ bg: 'gray.100' }}
                                                                css={{ '& td': { py: '1px', px: '4px' } }}
                                                            >
                                                                {/* Account name (indented) */}
                                                                <Table.Cell pl={8}>
                                                                    <Flex align="center" gap={1}>
                                                                        <Box w="8px" h="8px" borderRadius="full" bg={accountColor} flexShrink={0} />
                                                                        <Text {...XS} color="gray.700">{balance.account_name}</Text>
                                                                    </Flex>
                                                                </Table.Cell>
                                                                {/* Qty */}
                                                                <Table.Cell>
                                                                    <Text {...XS} color="gray.600"><ValueDisplay value={balance.qty} /></Text>
                                                                </Table.Cell>
                                                                {/* Δ (combined) */}
                                                                <Table.Cell>
                                                                    <DeltaBar delta={acctDelta} liveQty={acctLiveQty} pnlQty={balance.qty} size="xs" />
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

                                        {/* Unmapped live-only assets (when toggle on) */}
                                        {filteredUnmapped.length > 0 && (
                                            <>
                                                <Table.Row>
                                                    <Table.Cell colSpan={TOTAL_COLUMNS_BY_ASSET} bg="gray.50" py={1}>
                                                        <Text fontSize="2xs" fontWeight="semibold" color="gray.500" textTransform="uppercase" letterSpacing="wide">
                                                            Live-only assets (no P&L data)
                                                        </Text>
                                                    </Table.Cell>
                                                </Table.Row>
                                                {filteredUnmapped.map((u) => (
                                                    <Table.Row
                                                        key={`unmapped-${u.symbol}`}
                                                        bg="gray.25"
                                                        _hover={{ bg: 'gray.100' }}
                                                        opacity={0.7}
                                                        css={{ '& td': { py: '2px', px: '4px' } }}
                                                    >
                                                        {/* Asset */}
                                                        <Table.Cell>
                                                            <Flex align="center" gap={1}>
                                                                <Box w="18px" />
                                                                <Badge size="xs" colorPalette="gray" fontWeight="bold" variant="outline" maxW="80px" truncate>
                                                                    {u.symbol}
                                                                </Badge>
                                                            </Flex>
                                                        </Table.Cell>
                                                        {/* Qty (P&L) — none */}
                                                        <Table.Cell><Text {...XS} color="gray.400">0</Text></Table.Cell>
                                                        {/* Δ — full live qty is the delta */}
                                                        <Table.Cell>
                                                            <Text {...XS} fontWeight="medium" color="red.600">
                                                                +{formatQuantity(u.totalQty)}
                                                            </Text>
                                                        </Table.Cell>
                                                        {/* Cost */}
                                                        <Table.Cell><Text {...XS} color="gray.400">—</Text></Table.Cell>
                                                        {/* Value */}
                                                        <Table.Cell>
                                                            {u.marketValue != null
                                                                ? <Text {...XS}><ValueDisplay value={u.marketValue} currency={baseCurrency} /></Text>
                                                                : <Text {...XS} color="gray.400">—</Text>
                                                            }
                                                        </Table.Cell>
                                                        {/* Unrealized */}
                                                        <Table.Cell><Text {...XS} color="gray.400">—</Text></Table.Cell>
                                                        {/* Realized */}
                                                        <Table.Cell><Text {...XS} color="gray.400">—</Text></Table.Cell>
                                                        {/* Fees */}
                                                        <Table.Cell><Text {...XS} color="gray.400">—</Text></Table.Cell>
                                                        {/* Info */}
                                                        <Table.Cell textAlign="center">
                                                            <Badge size="xs" colorPalette="yellow" variant="subtle">No P&L</Badge>
                                                        </Table.Cell>
                                                        {/* Chevron */}
                                                        <Table.Cell></Table.Cell>
                                                    </Table.Row>
                                                ))}
                                            </>
                                        )}
                                    </>
                                );
                            })()}
                        </Table.Body>
                    </Table.Root>
                </Box>
            </Card.Body>
        </Card.Root>
    );
};

export default AssetPnLTable;
