/**
 * Asset P&L Table
 * 
 * Primary view showing P&L by asset with live balance comparison.
 * Principle 1: Results first - see all assets at a glance
 * Principle 2: Groups are primary - click to drill down
 * 
 * Features:
 * - Live balance column with delta indicator (P&L qty vs connector balance)
 * - Smart filters: hide dust, hide unmapped, show discrepancies only
 * - Expandable rows showing per-account balance breakdown
 * - Account color indicators for visual grouping
 * - Unmapped live-only assets shown at bottom when filter toggled off
 */

import React, { useState, useMemo, Fragment } from 'react';
import {
    Badge,
    Box,
    Button,
    Card,
    Flex,
    Input,
    Spinner,
    Table,
    Text,
} from '@chakra-ui/react';
import { FiChevronRight, FiChevronDown, FiSearch, FiAlertCircle, FiEyeOff } from 'react-icons/fi';
import { AssetPnLRow, AccountBalanceBreakdown, UnmappedLiveAsset } from './types';
import { Account } from '../../types';
import { Tooltip } from '../ui/tooltip';
import { formatDateTimeLocale } from '../../utils/dateUtils';
import { formatQuantity } from '../../utils/numberUtils';
import { ValueDisplay } from '../ValueDisplay';
import { getAccountColor } from '../../utils/accountColors';

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/** Market value threshold below which an asset is considered "dust" (in base currency) */
const DUST_THRESHOLD = 5;

/** Percentage delta below which balances are considered matching */
const MATCH_TOLERANCE = 0.0001; // 0.01%

const TOTAL_COLUMNS = 13;

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

const formatPct = (value: number): string => {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${(value * 100).toFixed(2)}%`;
};

/** Check if price is stale (older than 1 hour) */
const isPriceStale = (fetchedAt?: string): boolean => {
    if (!fetchedAt) return false;
    const isoString = fetchedAt.endsWith('Z') ? fetchedAt : fetchedAt + 'Z';
    const fetchedTime = new Date(isoString).getTime();
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    return fetchedTime < oneHourAgo;
};

/** Compute the delta between live and P&L quantities */
const computeDelta = (pnlQty: number, liveQty: number | undefined): { delta: number; pct: number; matched: boolean } | null => {
    if (liveQty == null) return null;
    const delta = liveQty - pnlQty;
    const maxQty = Math.max(Math.abs(liveQty), Math.abs(pnlQty));
    const pct = maxQty > 0 ? delta / maxQty : 0;
    const matched = Math.abs(pct) < MATCH_TOLERANCE;
    return { delta, pct, matched };
};

/** Color for delta display */
const deltaColor = (pct: number): string => {
    const absPct = Math.abs(pct);
    if (absPct < MATCH_TOLERANCE) return 'green.600';
    if (absPct < 0.01) return 'orange.500'; // < 1%
    return 'red.600';
};

type SortField = 'asset_symbol' | 'quantity' | 'market_value' | 'cost_basis' | 'unrealized_pnl' | 'realized_pnl';
type SortDirection = 'asc' | 'desc';

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

    // --- New filter state ---
    const [hideDust, setHideDust] = useState(true);
    const [hideUnmapped, setHideUnmapped] = useState(true);
    const [hideMatched, setHideMatched] = useState(false);

    // Toggle expanded state for an asset
    const toggleExpanded = (assetId: number, e: React.MouseEvent) => {
        e.stopPropagation();
        setExpandedAssetIds(prev => {
            const next = new Set(prev);
            if (next.has(assetId)) {
                next.delete(assetId);
            } else {
                next.add(assetId);
                // Load account balances on-demand when first expanded
                if (onLoadAccountBalances && !accountBalances?.has(assetId)) {
                    onLoadAccountBalances();
                }
            }
            return next;
        });
    };

    // Check if asset has multiple accounts (expandable)
    const hasMultipleAccounts = (assetId: number | undefined | null): boolean => {
        if (assetId == null || !accountBalances) return false;
        const balances = accountBalances.get(assetId);
        return balances != null && balances.length > 1;
    };

    // --- Filter + sort with hidden counts ---
    const { filtered, dustHiddenCount, matchedHiddenCount } = useMemo(() => {
        let dustCount = 0;
        let matchedCount = 0;

        const result = assets
            .filter((a) => {
                // Text search
                if (search && (!a.asset.symbol || !a.asset.symbol.toLowerCase().includes(search.toLowerCase()))) {
                    return false;
                }

                const sym = a.asset.symbol?.toUpperCase() ?? '';
                const liveQty = liveBalances?.get(sym);
                const deltaInfo = computeDelta(a.quantity, liveQty);

                // Dust filter: hide if BOTH live and P&L values are below threshold
                if (hideDust) {
                    const pnlValue = Math.abs(a.market_value);
                    const liveValue = liveQty != null && a.unit_value != null
                        ? Math.abs(liveQty * a.unit_value)
                        : pnlValue; // If no live data, use pnl value for dust check
                    if (pnlValue < DUST_THRESHOLD && liveValue < DUST_THRESHOLD) {
                        dustCount++;
                        return false;
                    }
                }

                // Matched filter: hide rows where balances match
                if (hideMatched && deltaInfo && deltaInfo.matched) {
                    matchedCount++;
                    return false;
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

        return { filtered: result, dustHiddenCount: dustCount, matchedHiddenCount: matchedCount };
    }, [assets, search, sortField, sortDir, hideDust, hideMatched, liveBalances]);

    // Count unmapped hidden
    const unmappedHiddenCount = hideUnmapped ? unmappedLiveAssets.length : 0;

    // Filtered unmapped assets (apply search + dust filter)
    const filteredUnmapped = useMemo(() => {
        if (hideUnmapped) return [];
        return unmappedLiveAssets.filter((u) => {
            if (search && !u.symbol.toLowerCase().includes(search.toLowerCase())) return false;
            if (hideDust && u.marketValue != null && Math.abs(u.marketValue) < DUST_THRESHOLD) return false;
            return true;
        });
    }, [unmappedLiveAssets, hideUnmapped, search, hideDust]);

    const totalHidden = dustHiddenCount + matchedHiddenCount + unmappedHiddenCount;

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

    // Has any live balance data at all?
    const hasLiveData = liveBalances != null && liveBalances.size > 0;

    return (
        <Card.Root>
            <Card.Header>
                <Flex justify="space-between" align="center" wrap="wrap" gap={2}>
                    <Text fontWeight="bold" fontSize="lg">
                        Asset P&L ({filtered.length} assets)
                    </Text>

                    <Flex gap={2} align="center">
                        {/* Search */}
                        <Box position="relative">
                            <Input
                                placeholder="Search assets..."
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                size="sm"
                                width="200px"
                                pl={8}
                            />
                            <Box position="absolute" left={2} top="50%" transform="translateY(-50%)">
                                <FiSearch size={14} color="gray" />
                            </Box>
                        </Box>

                        {/* Filter chips */}
                        <Flex gap={1}>
                            <Button
                                size="xs"
                                variant={hideMatched ? 'solid' : 'outline'}
                                colorPalette={hideMatched ? 'orange' : 'gray'}
                                onClick={() => setHideMatched(!hideMatched)}
                                disabled={!hasLiveData}
                            >
                                🔍 Discrepancies only
                                {hideMatched && matchedHiddenCount > 0 && ` (${matchedHiddenCount})`}
                            </Button>
                            <Button
                                size="xs"
                                variant={hideDust ? 'solid' : 'outline'}
                                colorPalette={hideDust ? 'gray' : 'gray'}
                                onClick={() => setHideDust(!hideDust)}
                            >
                                Hide dust
                                {hideDust && dustHiddenCount > 0 && ` (${dustHiddenCount})`}
                            </Button>
                            <Button
                                size="xs"
                                variant={hideUnmapped ? 'solid' : 'outline'}
                                colorPalette={hideUnmapped ? 'gray' : 'gray'}
                                onClick={() => setHideUnmapped(!hideUnmapped)}
                                disabled={unmappedLiveAssets.length === 0}
                            >
                                Hide unmapped
                                {hideUnmapped && unmappedLiveAssets.length > 0 && ` (${unmappedLiveAssets.length})`}
                            </Button>
                        </Flex>
                    </Flex>
                </Flex>

                {/* Hidden assets info bar */}
                {totalHidden > 0 && (
                    <Flex
                        mt={2}
                        px={3}
                        py={1.5}
                        bg="gray.50"
                        borderRadius="md"
                        align="center"
                        gap={1}
                        fontSize="xs"
                        color="gray.600"
                    >
                        <FiEyeOff size={12} />
                        <Text>{totalHidden} assets hidden:</Text>
                        {dustHiddenCount > 0 && (
                            <Text
                                as="span"
                                cursor="pointer"
                                textDecoration="underline"
                                _hover={{ color: 'blue.600' }}
                                onClick={() => setHideDust(false)}
                            >
                                {dustHiddenCount} dust
                            </Text>
                        )}
                        {dustHiddenCount > 0 && (unmappedHiddenCount > 0 || matchedHiddenCount > 0) && (
                            <Text as="span">·</Text>
                        )}
                        {unmappedHiddenCount > 0 && (
                            <Text
                                as="span"
                                cursor="pointer"
                                textDecoration="underline"
                                _hover={{ color: 'blue.600' }}
                                onClick={() => setHideUnmapped(false)}
                            >
                                {unmappedHiddenCount} unmapped
                            </Text>
                        )}
                        {unmappedHiddenCount > 0 && matchedHiddenCount > 0 && (
                            <Text as="span">·</Text>
                        )}
                        {matchedHiddenCount > 0 && (
                            <Text
                                as="span"
                                cursor="pointer"
                                textDecoration="underline"
                                _hover={{ color: 'blue.600' }}
                                onClick={() => setHideMatched(false)}
                            >
                                {matchedHiddenCount} matched
                            </Text>
                        )}
                    </Flex>
                )}
            </Card.Header>

            <Card.Body p={0}>
                <Box overflowX="auto">
                    <Table.Root size="sm">
                        <Table.Header>
                            <Table.Row>
                                <SortHeader field="asset_symbol">Asset</SortHeader>
                                <SortHeader field="quantity">Qty</SortHeader>
                                <Table.ColumnHeader>
                                    <Flex align="center" gap={1}>
                                        Live Bal
                                        {liveBalanceLoading && <Spinner size="xs" color="gray.400" />}
                                    </Flex>
                                </Table.ColumnHeader>
                                <Table.ColumnHeader>Δ</Table.ColumnHeader>
                                <Table.ColumnHeader>Unit Cost</Table.ColumnHeader>
                                <Table.ColumnHeader>Unit Value</Table.ColumnHeader>
                                <SortHeader field="market_value">Market Value</SortHeader>
                                <SortHeader field="cost_basis">Cost Basis</SortHeader>
                                <SortHeader field="unrealized_pnl">Unrealized P&L</SortHeader>
                                <SortHeader field="realized_pnl">Realized P&L</SortHeader>
                                <Table.ColumnHeader>Fees</Table.ColumnHeader>
                                <Table.ColumnHeader textAlign="center">Info</Table.ColumnHeader>
                                <Table.ColumnHeader></Table.ColumnHeader>
                            </Table.Row>
                        </Table.Header>
                        <Table.Body>
                            {loading ? (
                                <Table.Row>
                                    <Table.Cell colSpan={TOTAL_COLUMNS}>
                                        <Text textAlign="center" py={8} color="gray.500">
                                            Loading...
                                        </Text>
                                    </Table.Cell>
                                </Table.Row>
                            ) : filtered.length === 0 && filteredUnmapped.length === 0 ? (
                                <Table.Row>
                                    <Table.Cell colSpan={TOTAL_COLUMNS}>
                                        <Text textAlign="center" py={8} color="gray.500">
                                            No assets match your criteria
                                        </Text>
                                    </Table.Cell>
                                </Table.Row>
                            ) : (
                                <>
                                    {filtered.map((assetpnlrow) => {
                                        const stale = isPriceStale(assetpnlrow.price_fetched_at);
                                        const hasPrice = assetpnlrow.unit_value != null;
                                        const hasError = !!assetpnlrow.price_error;
                                        const isLoadingPrice = !!assetpnlrow.price_loading;
                                        const assetId = assetpnlrow.asset.id;
                                        const isExpandable = hasMultipleAccounts(assetId);
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
                                                >
                                                    <Table.Cell>
                                                        <Flex align="center" gap={2}>
                                                            {isExpandable ? (
                                                                <Box
                                                                    as="button"
                                                                    onClick={(e: React.MouseEvent) => assetId != null && toggleExpanded(assetId, e)}
                                                                    p={1}
                                                                    borderRadius="sm"
                                                                    _hover={{ bg: 'gray.200' }}
                                                                >
                                                                    {isExpanded ? (
                                                                        <FiChevronDown size={14} />
                                                                    ) : (
                                                                        <FiChevronRight size={14} />
                                                                    )}
                                                                </Box>
                                                            ) : (
                                                                <Box w="22px" />
                                                            )}
                                                            <Badge colorPalette="blue" fontWeight="bold">
                                                                {assetpnlrow.asset.symbol}
                                                            </Badge>
                                                        </Flex>
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <ValueDisplay value={assetpnlrow.quantity} />
                                                    </Table.Cell>

                                                    {/* Live Balance */}
                                                    <Table.Cell>
                                                        {liveBalanceLoading ? (
                                                            <Spinner size="xs" color="gray.400" />
                                                        ) : liveQty != null ? (
                                                            <Text fontSize="sm" color="gray.700">
                                                                <ValueDisplay value={liveQty} />
                                                            </Text>
                                                        ) : hasLiveData ? (
                                                            <Tooltip content="No balance-capable connector for this asset">
                                                                <Text fontSize="sm" color="gray.400" cursor="help">N/A</Text>
                                                            </Tooltip>
                                                        ) : (
                                                            <Text fontSize="sm" color="gray.400">—</Text>
                                                        )}
                                                    </Table.Cell>

                                                    {/* Delta */}
                                                    <Table.Cell>
                                                        {liveBalanceLoading ? (
                                                            <Spinner size="xs" color="gray.400" />
                                                        ) : deltaInfo ? (
                                                            <Tooltip
                                                                content={
                                                                    <Box p={1} fontSize="xs">
                                                                        <Text>Live: {liveQty?.toLocaleString(undefined, { maximumFractionDigits: 8 })}</Text>
                                                                        <Text>P&L: {assetpnlrow.quantity.toLocaleString(undefined, { maximumFractionDigits: 8 })}</Text>
                                                                        <Text>Delta: {deltaInfo.delta >= 0 ? '+' : ''}{deltaInfo.delta.toLocaleString(undefined, { maximumFractionDigits: 8 })}</Text>
                                                                        <Text>({formatPct(deltaInfo.pct)})</Text>
                                                                    </Box>
                                                                }
                                                                openDelay={200}
                                                            >
                                                                <Text
                                                                    fontSize="sm"
                                                                    fontWeight="medium"
                                                                    color={deltaColor(deltaInfo.pct)}
                                                                    cursor="help"
                                                                >
                                                                    {deltaInfo.matched
                                                                        ? '✓'
                                                                        : `${deltaInfo.delta >= 0 ? '+' : ''}${deltaInfo.delta.toLocaleString(undefined, { maximumFractionDigits: 4 })}`
                                                                    }
                                                                </Text>
                                                            </Tooltip>
                                                        ) : (
                                                            <Text fontSize="sm" color="gray.400">—</Text>
                                                        )}
                                                    </Table.Cell>

                                                    {/* Unit Cost */}
                                                    <Table.Cell>
                                                        {assetpnlrow.unit_cost != null
                                                            ? <ValueDisplay value={assetpnlrow.unit_cost} currency={baseCurrency} />
                                                            : '—'}
                                                    </Table.Cell>
                                                    {/* Unit Value with tooltip */}
                                                    <Table.Cell>
                                                        {isLoadingPrice ? (
                                                            <Spinner size="xs" color="gray.400" />
                                                        ) : (
                                                            <Tooltip
                                                                content={
                                                                    <Box p={2} fontSize="xs">
                                                                        <Flex justify="space-between" gap={4} mb={1}>
                                                                            <Text color="gray.400">Source</Text>
                                                                            <Text fontWeight="medium">
                                                                                {assetpnlrow.price_source || 'N/A'}
                                                                            </Text>
                                                                        </Flex>
                                                                        <Flex justify="space-between" gap={4} mb={1}>
                                                                            <Text color="gray.400">Updated</Text>
                                                                            <Text fontWeight="medium">
                                                                                {formatDateTimeLocale(assetpnlrow.price_fetched_at)}
                                                                            </Text>
                                                                        </Flex>
                                                                        {hasError && (
                                                                            <Flex justify="space-between" gap={4}>
                                                                                <Text color="red.400">Error</Text>
                                                                                <Text color="red.300" maxW="200px" wordBreak="break-word">
                                                                                    {assetpnlrow.price_error}
                                                                                </Text>
                                                                            </Flex>
                                                                        )}
                                                                        {stale && (
                                                                            <Text color="orange.400" mt={1}>
                                                                                ⚠ Price is stale (over 1 hour old)
                                                                            </Text>
                                                                        )}
                                                                    </Box>
                                                                }
                                                                openDelay={200}
                                                                closeDelay={100}
                                                            >
                                                                <Flex align="center" gap={1} cursor="help">
                                                                    {hasPrice ? (
                                                                        <Text
                                                                            textDecoration="underline dotted"
                                                                            color={stale ? 'orange.500' : undefined}
                                                                        >
                                                                            <ValueDisplay value={assetpnlrow.unit_value!} currency={baseCurrency} />
                                                                        </Text>
                                                                    ) : (
                                                                        <Text color="gray.400">
                                                                            —
                                                                        </Text>
                                                                    )}
                                                                    {(stale || hasError) && (
                                                                        <FiAlertCircle
                                                                            size={12}
                                                                            color={hasError ? '#E53E3E' : '#DD6B20'}
                                                                        />
                                                                    )}
                                                                </Flex>
                                                            </Tooltip>
                                                        )}
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <ValueDisplay value={assetpnlrow.market_value} currency={baseCurrency} />
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <ValueDisplay value={assetpnlrow.cost_basis} currency={baseCurrency} />
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <Flex direction="column">
                                                            <Text
                                                                fontWeight="medium"
                                                                color={assetpnlrow.unrealized_pnl >= 0 ? 'green.600' : 'red.600'}
                                                            >
                                                                <ValueDisplay value={assetpnlrow.unrealized_pnl} currency={baseCurrency} />
                                                            </Text>
                                                            <Text fontSize="xs" color="gray.500">
                                                                {formatPct(assetpnlrow.unrealized_pnl_pct)}
                                                            </Text>
                                                        </Flex>
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <Text
                                                            fontWeight="medium"
                                                            color={assetpnlrow.realized_pnl >= 0 ? 'green.600' : 'red.600'}
                                                        >
                                                            <ValueDisplay value={assetpnlrow.realized_pnl} currency={baseCurrency} />
                                                        </Text>
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <Text fontSize="sm" color="gray.600">
                                                            <ValueDisplay value={assetpnlrow.total_fees} currency={baseCurrency} />
                                                        </Text>
                                                    </Table.Cell>
                                                    <Table.Cell textAlign="center">
                                                        <Flex gap={1} justify="center">
                                                            {isExpandable && assetAccountBalances && (
                                                                <Flex gap={0.5} mr={1}>
                                                                    {assetAccountBalances.slice(0, 3).map((bal) => (
                                                                        <Box
                                                                            key={bal.account_id}
                                                                            w="8px"
                                                                            h="8px"
                                                                            borderRadius="full"
                                                                            bg={getAccountColor(bal.account_id)}
                                                                            title={bal.account_name}
                                                                        />
                                                                    ))}
                                                                    {assetAccountBalances.length > 3 && (
                                                                        <Text fontSize="xs" color="gray.500">+{assetAccountBalances.length - 3}</Text>
                                                                    )}
                                                                </Flex>
                                                            )}
                                                            <Badge size="sm" variant="subtle">
                                                                {assetpnlrow.lot_count} lots
                                                            </Badge>
                                                            {assetpnlrow.warning_count > 0 && (
                                                                <Badge size="sm" colorPalette="orange">
                                                                    {assetpnlrow.warning_count} ⚠
                                                                </Badge>
                                                            )}
                                                        </Flex>
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <FiChevronRight color="gray" />
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

                                                    // Per-account live balance
                                                    const acctLiveQty = liveAccountBalances?.get(sym)?.get(balance.account_id);
                                                    const acctDelta = computeDelta(balance.qty, acctLiveQty);

                                                    return (
                                                        <Table.Row
                                                            key={`${assetpnlrow.asset.id}-${balance.account_id}`}
                                                            bg="gray.50"
                                                            _hover={{ bg: 'gray.100' }}
                                                            fontSize="sm"
                                                        >
                                                            <Table.Cell pl={10}>
                                                                <Flex align="center" gap={2}>
                                                                    <Box
                                                                        w="10px"
                                                                        h="10px"
                                                                        borderRadius="full"
                                                                        bg={accountColor}
                                                                        flexShrink={0}
                                                                    />
                                                                    <Text color="gray.700" fontSize="sm">
                                                                        {balance.account_name}
                                                                    </Text>
                                                                </Flex>
                                                            </Table.Cell>
                                                            <Table.Cell>
                                                                <Text color="gray.600"><ValueDisplay value={balance.qty} /></Text>
                                                            </Table.Cell>
                                                            {/* Per-account live balance */}
                                                            <Table.Cell>
                                                                {acctLiveQty != null ? (
                                                                    <Text fontSize="sm" color="gray.600">
                                                                        <ValueDisplay value={acctLiveQty} />
                                                                    </Text>
                                                                ) : (
                                                                    <Text fontSize="sm" color="gray.400">—</Text>
                                                                )}
                                                            </Table.Cell>
                                                            {/* Per-account delta */}
                                                            <Table.Cell>
                                                                {acctDelta ? (
                                                                    <Text
                                                                        fontSize="sm"
                                                                        color={deltaColor(acctDelta.pct)}
                                                                    >
                                                                        {acctDelta.matched
                                                                            ? '✓'
                                                                            : `${acctDelta.delta >= 0 ? '+' : ''}${acctDelta.delta.toLocaleString(undefined, { maximumFractionDigits: 4 })}`
                                                                        }
                                                                    </Text>
                                                                ) : (
                                                                    <Text fontSize="sm" color="gray.400">—</Text>
                                                                )}
                                                            </Table.Cell>
                                                            <Table.Cell>
                                                                <Text color="gray.600">
                                                                    <ValueDisplay value={balance.avg_unit_cost_in_base} currency={baseCurrency} />
                                                                </Text>
                                                            </Table.Cell>
                                                            <Table.Cell>
                                                                <Text color="gray.500">—</Text>
                                                            </Table.Cell>
                                                            <Table.Cell>
                                                                <Text color="gray.600">
                                                                    {unitPrice != null
                                                                        ? <ValueDisplay value={marketValue} currency={baseCurrency} />
                                                                        : '—'
                                                                    }
                                                                </Text>
                                                            </Table.Cell>
                                                            <Table.Cell>
                                                                <Text color="gray.600">
                                                                    <ValueDisplay value={balance.cost_basis_in_base} currency={baseCurrency} />
                                                                </Text>
                                                            </Table.Cell>
                                                            <Table.Cell>
                                                                {unitPrice != null ? (
                                                                    <Flex direction="column">
                                                                        <Text
                                                                            fontSize="sm"
                                                                            color={unrealizedPnl >= 0 ? 'green.600' : 'red.600'}
                                                                        >
                                                                            <ValueDisplay value={unrealizedPnl} currency={baseCurrency} />
                                                                        </Text>
                                                                        <Text fontSize="xs" color="gray.500">
                                                                            {formatPct(unrealizedPnlPct)}
                                                                        </Text>
                                                                    </Flex>
                                                                ) : (
                                                                    <Text color="gray.500">—</Text>
                                                                )}
                                                            </Table.Cell>
                                                            <Table.Cell>
                                                                <Text color="gray.500">—</Text>
                                                            </Table.Cell>
                                                            <Table.Cell>
                                                                <Text color="gray.500">—</Text>
                                                            </Table.Cell>
                                                            <Table.Cell textAlign="center">
                                                                <Badge size="xs" variant="subtle">
                                                                    {balance.lot_count} lots
                                                                </Badge>
                                                            </Table.Cell>
                                                            <Table.Cell></Table.Cell>
                                                        </Table.Row>
                                                    );
                                                })}
                                            </Fragment>
                                        );
                                    })}

                                    {/* Unmapped live-only assets (when filter toggled off) */}
                                    {filteredUnmapped.length > 0 && (
                                        <>
                                            <Table.Row>
                                                <Table.Cell colSpan={TOTAL_COLUMNS} bg="gray.50" py={1}>
                                                    <Text fontSize="xs" fontWeight="semibold" color="gray.500" textTransform="uppercase" letterSpacing="wide">
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
                                                >
                                                    <Table.Cell>
                                                        <Flex align="center" gap={2}>
                                                            <Box w="22px" />
                                                            <Badge colorPalette="gray" fontWeight="bold" variant="outline">
                                                                {u.symbol}
                                                            </Badge>
                                                        </Flex>
                                                    </Table.Cell>
                                                    {/* Qty (P&L) — none */}
                                                    <Table.Cell>
                                                        <Text fontSize="sm" color="gray.400">0</Text>
                                                    </Table.Cell>
                                                    {/* Live Balance */}
                                                    <Table.Cell>
                                                        <Text fontSize="sm" color="gray.700">
                                                            <ValueDisplay value={u.totalQty} />
                                                        </Text>
                                                    </Table.Cell>
                                                    {/* Delta = liveQty itself */}
                                                    <Table.Cell>
                                                        <Text fontSize="sm" fontWeight="medium" color="red.600">
                                                            +{u.totalQty.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                                                        </Text>
                                                    </Table.Cell>
                                                    {/* Unit Cost */}
                                                    <Table.Cell><Text color="gray.400">—</Text></Table.Cell>
                                                    {/* Unit Value */}
                                                    <Table.Cell><Text color="gray.400">—</Text></Table.Cell>
                                                    {/* Market Value */}
                                                    <Table.Cell>
                                                        {u.marketValue != null ? (
                                                            <ValueDisplay value={u.marketValue} currency={baseCurrency} />
                                                        ) : (
                                                            <Text color="gray.400">—</Text>
                                                        )}
                                                    </Table.Cell>
                                                    {/* Cost Basis */}
                                                    <Table.Cell><Text color="gray.400">—</Text></Table.Cell>
                                                    {/* Unrealized */}
                                                    <Table.Cell><Text color="gray.400">—</Text></Table.Cell>
                                                    {/* Realized */}
                                                    <Table.Cell><Text color="gray.400">—</Text></Table.Cell>
                                                    {/* Fees */}
                                                    <Table.Cell><Text color="gray.400">—</Text></Table.Cell>
                                                    {/* Info */}
                                                    <Table.Cell textAlign="center">
                                                        <Badge size="xs" colorPalette="yellow" variant="subtle">
                                                            No P&L data
                                                        </Badge>
                                                    </Table.Cell>
                                                    {/* Chevron */}
                                                    <Table.Cell></Table.Cell>
                                                </Table.Row>
                                            ))}
                                        </>
                                    )}
                                </>
                            )}
                        </Table.Body>
                    </Table.Root>
                </Box>
            </Card.Body>
        </Card.Root>
    );
};

export default AssetPnLTable;
