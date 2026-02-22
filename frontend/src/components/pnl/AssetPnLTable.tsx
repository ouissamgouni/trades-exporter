/**
 * Asset P&L Table
 * 
 * Primary view showing P&L by asset.
 * Principle 1: Results first - see all assets at a glance
 * Principle 2: Groups are primary - click to drill down
 * 
 * Features:
 * - Expandable rows showing per-account balance breakdown
 * - Account color indicators for visual grouping
 */

import React, { useState, Fragment } from 'react';
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
import { FiChevronRight, FiChevronDown, FiSearch, FiAlertCircle } from 'react-icons/fi';
import { AssetPnLRow, AccountBalanceBreakdown } from './types';
import { Account } from '../../types';
import { Tooltip } from '../ui/tooltip';
import { formatDateTimeLocale } from '../../utils/dateUtils';
import { formatQuantity } from '../../utils/numberUtils';
import { ValueDisplay } from '../ValueDisplay';
import { getAccountColor } from '../../utils/accountColors';

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
}

const formatPct = (value: number): string => {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${(value * 100).toFixed(2)}%`;
};

/** Check if price is stale (older than 1 hour) */
const isPriceStale = (fetchedAt?: string): boolean => {
    if (!fetchedAt) return false;
    // Backend returns naive UTC datetime - append 'Z' if missing to ensure UTC parsing
    const isoString = fetchedAt.endsWith('Z') ? fetchedAt : fetchedAt + 'Z';
    const fetchedTime = new Date(isoString).getTime();
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    return fetchedTime < oneHourAgo;
};

// Using formatDateTimeLocale from utils/dateUtils for datetime formatting

type SortField = 'asset_symbol' | 'quantity' | 'market_value' | 'cost_basis' | 'unrealized_pnl' | 'realized_pnl';
type SortDirection = 'asc' | 'desc';

export const AssetPnLTable: React.FC<AssetPnLTableProps> = ({
    assets,
    baseCurrency,
    onAssetClick,
    loading = false,
    accountBalances,
    accounts = [],
    onLoadAccountBalances,
}) => {
    const [search, setSearch] = useState('');
    const [sortField, setSortField] = useState<SortField>('market_value');
    const [sortDir, setSortDir] = useState<SortDirection>('desc');
    const [filter, setFilter] = useState<'all' | 'with-position' | 'with-realized'>('with-position');
    const [expandedAssetIds, setExpandedAssetIds] = useState<Set<number>>(new Set());

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

    // Filter and sort
    const filtered = assets
        .filter((a) => {
            if (search && (!a.asset.symbol || !a.asset.symbol.toLowerCase().includes(search.toLowerCase()))) {
                return false;
            }
            if (filter === 'with-position' && a.quantity === 0) return false;
            if (filter === 'with-realized' && a.realized_pnl === 0) return false;
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
                    <Text fontWeight="bold" fontSize="lg">
                        Asset P&L ({filtered.length} assets)
                    </Text>

                    <Flex gap={2} align="center">
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

                        <Flex gap={1}>
                            <Button
                                size="xs"
                                variant={filter === 'all' ? 'solid' : 'outline'}
                                onClick={() => setFilter('all')}
                            >
                                All
                            </Button>
                            <Button
                                size="xs"
                                variant={filter === 'with-position' ? 'solid' : 'outline'}
                                onClick={() => setFilter('with-position')}
                            >
                                With Position
                            </Button>
                            <Button
                                size="xs"
                                variant={filter === 'with-realized' ? 'solid' : 'outline'}
                                onClick={() => setFilter('with-realized')}
                            >
                                Realized Only
                            </Button>
                        </Flex>
                    </Flex>
                </Flex>
            </Card.Header>

            <Card.Body p={0}>
                <Box overflowX="auto">
                    <Table.Root size="sm">
                        <Table.Header>
                            <Table.Row>
                                <SortHeader field="asset_symbol">Asset</SortHeader>
                                <SortHeader field="quantity">Qty</SortHeader>
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
                                    <Table.Cell colSpan={11}>
                                        <Text textAlign="center" py={8} color="gray.500">
                                            Loading...
                                        </Text>
                                    </Table.Cell>
                                </Table.Row>
                            ) : filtered.length === 0 ? (
                                <Table.Row>
                                    <Table.Cell colSpan={11}>
                                        <Text textAlign="center" py={8} color="gray.500">
                                            No assets match your criteria
                                        </Text>
                                    </Table.Cell>
                                </Table.Row>
                            ) : (
                                filtered.map((assetpnlrow) => {
                                    const stale = isPriceStale(assetpnlrow.price_fetched_at);
                                    const hasPrice = assetpnlrow.unit_value != null;
                                    const hasError = !!assetpnlrow.price_error;
                                    const isLoadingPrice = !!assetpnlrow.price_loading;
                                    const assetId = assetpnlrow.asset.id;
                                    const isExpandable = hasMultipleAccounts(assetId);
                                    const isExpanded = assetId != null && expandedAssetIds.has(assetId);
                                    const assetAccountBalances = assetId != null ? accountBalances?.get(assetId) : undefined;

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
                                                        {/* Expand/collapse button for multi-account assets */}
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
                                                            <Box w="22px" /> // Spacer for alignment
                                                        )}
                                                        <Badge colorPalette="blue" fontWeight="bold">
                                                            {assetpnlrow.asset.symbol}
                                                        </Badge>
                                                    </Flex>
                                                </Table.Cell>
                                                <Table.Cell>
                                                    <ValueDisplay value={assetpnlrow.quantity} />
                                                </Table.Cell>
                                                {/* Unit Cost (average cost basis per unit) */}
                                                <Table.Cell>
                                                    {assetpnlrow.unit_cost != null
                                                        ? <ValueDisplay value={assetpnlrow.unit_cost} currency={baseCurrency} />
                                                        : '—'}
                                                </Table.Cell>
                                                {/* Unit Value (current market price) with tooltip */}
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
                                                        {/* Account color dots */}
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
                                })
                            )}
                        </Table.Body>
                    </Table.Root>
                </Box>
            </Card.Body>
        </Card.Root>
    );
};

export default AssetPnLTable;
