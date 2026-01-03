/**
 * Asset P&L Table
 * 
 * Primary view showing P&L by asset.
 * Principle 1: Results first - see all assets at a glance
 * Principle 2: Groups are primary - click to drill down
 */

import React, { useState } from 'react';
import {
    Badge,
    Box,
    Button,
    Card,
    Flex,
    Input,
    Table,
    Text,
} from '@chakra-ui/react';
import { FiChevronRight, FiSearch, FiAlertCircle } from 'react-icons/fi';
import { AssetPnLRow } from './types';
import { Tooltip } from '../ui/tooltip';

interface AssetPnLTableProps {
    assets: AssetPnLRow[];
    baseCurrency: string;
    onAssetClick: (assetId: number) => void;
    loading?: boolean;
}

const formatCurrency = (value: number, currency: string): string => {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);
};

const formatQty = (value: number): string => {
    if (Math.abs(value) < 0.00001) return '0';
    if (Math.abs(value) < 1) return value.toFixed(8).replace(/\.?0+$/, '');
    if (Math.abs(value) < 1000) return value.toFixed(4).replace(/\.?0+$/, '');
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

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

/** Format datetime for display */
const formatDateTime = (isoString?: string): string => {
    if (!isoString) return 'N/A';
    // Backend returns naive UTC datetime - append 'Z' if missing to ensure UTC parsing
    const normalized = isoString.endsWith('Z') ? isoString : isoString + 'Z';
    return new Date(normalized).toLocaleString();
};

type SortField = 'asset_symbol' | 'quantity' | 'market_value' | 'cost_basis' | 'unrealized_pnl' | 'realized_pnl';
type SortDirection = 'asc' | 'desc';

export const AssetPnLTable: React.FC<AssetPnLTableProps> = ({
    assets,
    baseCurrency,
    onAssetClick,
    loading = false,
}) => {
    const [search, setSearch] = useState('');
    const [sortField, setSortField] = useState<SortField>('market_value');
    const [sortDir, setSortDir] = useState<SortDirection>('desc');
    const [filter, setFilter] = useState<'all' | 'with-position' | 'with-realized'>('with-position');

    // Filter and sort
    const filtered = assets
        .filter((a) => {
            if (search && !a.asset_symbol.toLowerCase().includes(search.toLowerCase())) {
                return false;
            }
            if (filter === 'with-position' && a.quantity === 0) return false;
            if (filter === 'with-realized' && a.realized_pnl === 0) return false;
            return true;
        })
        .sort((a, b) => {
            const aVal = a[sortField];
            const bVal = b[sortField];
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
                                filtered.map((asset) => {
                                    const stale = isPriceStale(asset.price_fetched_at);
                                    const hasPrice = asset.unit_value != null;
                                    const hasError = !!asset.price_error;

                                    return (
                                        <Table.Row
                                            key={asset.asset_id}
                                            cursor="pointer"
                                            _hover={{ bg: 'blue.50' }}
                                            onClick={() => onAssetClick(asset.asset_id)}
                                        >
                                            <Table.Cell>
                                                <Flex align="center" gap={2}>
                                                    <Badge colorPalette="blue" fontWeight="bold">
                                                        {asset.asset_symbol}
                                                    </Badge>
                                                    {asset.asset_label && (
                                                        <Text fontSize="xs" color="gray.500">
                                                            {asset.asset_label}
                                                        </Text>
                                                    )}
                                                </Flex>
                                            </Table.Cell>
                                            <Table.Cell>
                                                {formatQty(asset.quantity)}
                                            </Table.Cell>
                                            {/* Unit Cost (average cost basis per unit) */}
                                            <Table.Cell>
                                                {asset.unit_cost != null
                                                    ? formatCurrency(asset.unit_cost, baseCurrency)
                                                    : '—'}
                                            </Table.Cell>
                                            {/* Unit Value (current market price) with tooltip */}
                                            <Table.Cell>
                                                <Tooltip
                                                    content={
                                                        <Box p={2} fontSize="xs">
                                                            <Flex justify="space-between" gap={4} mb={1}>
                                                                <Text color="gray.400">Source</Text>
                                                                <Text fontWeight="medium">
                                                                    {asset.price_source || 'N/A'}
                                                                </Text>
                                                            </Flex>
                                                            <Flex justify="space-between" gap={4} mb={1}>
                                                                <Text color="gray.400">Updated</Text>
                                                                <Text fontWeight="medium">
                                                                    {formatDateTime(asset.price_fetched_at)}
                                                                </Text>
                                                            </Flex>
                                                            {hasError && (
                                                                <Flex justify="space-between" gap={4}>
                                                                    <Text color="red.400">Error</Text>
                                                                    <Text color="red.300" maxW="200px" wordBreak="break-word">
                                                                        {asset.price_error}
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
                                                                {formatCurrency(asset.unit_value!, baseCurrency)}
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
                                            </Table.Cell>
                                            <Table.Cell>
                                                {formatCurrency(asset.market_value, baseCurrency)}
                                            </Table.Cell>
                                            <Table.Cell>
                                                {formatCurrency(asset.cost_basis, baseCurrency)}
                                            </Table.Cell>
                                            <Table.Cell>
                                                <Flex direction="column">
                                                    <Text
                                                        fontWeight="medium"
                                                        color={asset.unrealized_pnl >= 0 ? 'green.600' : 'red.600'}
                                                    >
                                                        {formatCurrency(asset.unrealized_pnl, baseCurrency)}
                                                    </Text>
                                                    <Text fontSize="xs" color="gray.500">
                                                        {formatPct(asset.unrealized_pnl_pct)}
                                                    </Text>
                                                </Flex>
                                            </Table.Cell>
                                            <Table.Cell>
                                                <Text
                                                    fontWeight="medium"
                                                    color={asset.realized_pnl >= 0 ? 'green.600' : 'red.600'}
                                                >
                                                    {formatCurrency(asset.realized_pnl, baseCurrency)}
                                                </Text>
                                            </Table.Cell>
                                            <Table.Cell>
                                                <Text fontSize="sm" color="gray.600">
                                                    {formatCurrency(asset.total_fees, baseCurrency)}
                                                </Text>
                                            </Table.Cell>
                                            <Table.Cell textAlign="center">
                                                <Flex gap={1} justify="center">
                                                    <Badge size="sm" variant="subtle">
                                                        {asset.lot_count} lots
                                                    </Badge>
                                                    {asset.warning_count > 0 && (
                                                        <Badge size="sm" colorPalette="orange">
                                                            {asset.warning_count} ⚠
                                                        </Badge>
                                                    )}
                                                </Flex>
                                            </Table.Cell>
                                            <Table.Cell>
                                                <FiChevronRight color="gray" />
                                            </Table.Cell>
                                        </Table.Row>
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
