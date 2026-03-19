/**
 * PriceHealthTable — Per-asset price health summary table.
 *
 * Shows freshness status for every asset that has price data:
 * - Status badges (Healthy / Warning / Stale)
 * - Flat-line detection badge
 * - Sortable by any column (default: days_stale descending)
 * - Summary cards at top showing counts per status
 * - Row click selects asset for investigation chart
 */
import React, { useMemo, useState } from 'react';
import {
    Badge, Box, Button, Flex, Heading, Spinner, Table, Text,
} from '@chakra-ui/react';
import { usePriceHealth } from '../hooks/usePriceHealth';
import { AssetBadge } from './AssetBadge';
import type { PriceHealthRow } from '../types';
import { Tooltip } from './ui/tooltip';

// ---------------------------------------------------------------------------
// Status config
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<string, { color: string; label: string; emoji: string }> = {
    healthy: { color: 'green', label: 'Healthy', emoji: '✅' },
    warning: { color: 'yellow', label: 'Warning', emoji: '⚠️' },
    stale: { color: 'red', label: 'Stale', emoji: '🔴' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(isoString: string): string {
    if (!isoString) return 'Never';
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60_000);
    const diffHours = Math.floor(diffMs / 3_600_000);
    const diffDays = Math.floor(diffMs / 86_400_000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 30) return `${diffDays}d ago`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
    return `${Math.floor(diffDays / 365)}y ago`;
}

function formatAbsoluteDate(isoString: string): string {
    if (!isoString) return '';
    try {
        return new Date(isoString).toLocaleString(undefined, {
            year: 'numeric', month: 'short', day: '2-digit',
            hour: '2-digit', minute: '2-digit',
        });
    } catch {
        return isoString;
    }
}

function formatPrice(price: number): string {
    if (price >= 1) return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (price >= 0.01) return price.toFixed(4);
    if (price >= 0.0001) return price.toFixed(6);
    return price.toFixed(8);
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

type SortField = 'symbol' | 'last_price' | 'days_stale' | 'total_snapshots' | 'status';
type SortDir = 'asc' | 'desc';

const STATUS_ORDER: Record<string, number> = { stale: 0, warning: 1, healthy: 2 };

function sortRows(rows: PriceHealthRow[], field: SortField, dir: SortDir): PriceHealthRow[] {
    const sorted = [...rows];
    sorted.sort((a, b) => {
        let cmp = 0;
        switch (field) {
            case 'symbol': cmp = a.symbol.localeCompare(b.symbol); break;
            case 'last_price': cmp = a.last_price - b.last_price; break;
            case 'days_stale': cmp = a.days_stale - b.days_stale; break;
            case 'total_snapshots': cmp = a.total_snapshots - b.total_snapshots; break;
            case 'status': cmp = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9); break;
        }
        return dir === 'asc' ? cmp : -cmp;
    });
    return sorted;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const PriceHealthTable: React.FC = () => {
    const { data, isLoading, error, refetch } = usePriceHealth();
    const [sortField, setSortField] = useState<SortField>('days_stale');
    const [sortDir, setSortDir] = useState<SortDir>('desc');

    const sortedItems = useMemo(() => {
        if (!data?.items) return [];
        return sortRows(data.items, sortField, sortDir);
    }, [data?.items, sortField, sortDir]);

    const handleSort = (field: SortField) => {
        if (sortField === field) {
            setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortDir(field === 'symbol' ? 'asc' : 'desc');
        }
    };

    const sortIndicator = (field: SortField) => {
        if (sortField !== field) return '';
        return sortDir === 'asc' ? ' ↑' : ' ↓';
    };

    if (isLoading) {
        return (
            <Box textAlign="center" py={10} bg="gray.50" borderRadius="md">
                <Spinner size="xl" color="blue.500" />
                <Text mt={4}>Loading price health data...</Text>
            </Box>
        );
    }

    if (error) {
        return (
            <Box textAlign="center" py={10} bg="red.50" borderRadius="md" borderWidth={1} borderColor="red.200">
                <Text color="red.600">Error: {error}</Text>
                <Button size="sm" mt={3} onClick={() => refetch()}>Retry</Button>
            </Box>
        );
    }

    if (!data || data.items.length === 0) {
        return (
            <Box textAlign="center" py={10} bg="gray.50" borderRadius="md">
                <Text color="gray.500">No price snapshot data found. Import prices first.</Text>
            </Box>
        );
    }

    const { summary, staleness_threshold_days } = data;

    return (
        <Box>
            {/* Summary cards */}
            <Flex gap={4} mb={5} flexWrap="wrap">
                {(['healthy', 'warning', 'stale'] as const).map(status => {
                    const cfg = STATUS_CONFIG[status];
                    const count = summary[status];
                    return (
                        <Box
                            key={status}
                            flex="1"
                            minW="120px"
                            p={3}
                            bg="white"
                            borderRadius="md"
                            border="1px solid"
                            borderColor={`${cfg.color}.200`}
                            boxShadow="sm"
                        >
                            <Flex align="center" gap={2} mb={1}>
                                <Text fontSize="lg">{cfg.emoji}</Text>
                                <Text fontSize="sm" fontWeight="medium" color="gray.600">{cfg.label}</Text>
                            </Flex>
                            <Text fontSize="2xl" fontWeight="bold" color={`${cfg.color}.600`}>
                                {count}
                            </Text>
                        </Box>
                    );
                })}
                <Box
                    flex="1"
                    minW="120px"
                    p={3}
                    bg="white"
                    borderRadius="md"
                    border="1px solid"
                    borderColor="gray.200"
                    boxShadow="sm"
                >
                    <Flex align="center" gap={2} mb={1}>
                        <Text fontSize="lg">📊</Text>
                        <Text fontSize="sm" fontWeight="medium" color="gray.600">Total Assets</Text>
                    </Flex>
                    <Text fontSize="2xl" fontWeight="bold" color="gray.700">
                        {data.items.length}
                    </Text>
                </Box>
            </Flex>

            {/* Info bar */}
            <Flex mb={3} justify="space-between" align="center">
                <Text fontSize="xs" color="gray.500">
                    Stale threshold: {staleness_threshold_days} days (configurable in P&L settings).
                </Text>
                <Button size="xs" variant="outline" onClick={() => refetch()}>
                    🔄 Refresh
                </Button>
            </Flex>

            {/* Health table */}
            <Box overflowX="auto" bg="white" borderRadius="md" boxShadow="sm">
                <Table.Root size="sm">
                    <Table.Header>
                        <Table.Row>
                            <Table.ColumnHeader
                                cursor="pointer"
                                onClick={() => handleSort('status')}
                                userSelect="none"
                            >
                                Status{sortIndicator('status')}
                            </Table.ColumnHeader>
                            <Table.ColumnHeader
                                cursor="pointer"
                                onClick={() => handleSort('symbol')}
                                userSelect="none"
                            >
                                Asset{sortIndicator('symbol')}
                            </Table.ColumnHeader>
                            <Table.ColumnHeader
                                cursor="pointer"
                                onClick={() => handleSort('last_price')}
                                userSelect="none"
                                textAlign="right"
                            >
                                Last Price{sortIndicator('last_price')}
                            </Table.ColumnHeader>
                            <Table.ColumnHeader>Last Updated</Table.ColumnHeader>
                            <Table.ColumnHeader
                                cursor="pointer"
                                onClick={() => handleSort('days_stale')}
                                userSelect="none"
                                textAlign="right"
                            >
                                Days Stale{sortIndicator('days_stale')}
                            </Table.ColumnHeader>
                            <Table.ColumnHeader
                                cursor="pointer"
                                onClick={() => handleSort('total_snapshots')}
                                userSelect="none"
                                textAlign="right"
                            >
                                Snapshots{sortIndicator('total_snapshots')}
                            </Table.ColumnHeader>
                            <Table.ColumnHeader>Source</Table.ColumnHeader>
                        </Table.Row>
                    </Table.Header>
                    <Table.Body>
                        {sortedItems.map(row => {
                            const cfg = STATUS_CONFIG[row.status];
                            return (
                                <Table.Row
                                    key={row.asset_id}
                                    _hover={{ bg: 'gray.50' }}
                                >
                                    <Table.Cell>
                                        <Flex gap={1.5} align="center">
                                            <Badge
                                                size="xs"
                                                colorPalette={cfg.color}
                                                fontSize="10px"
                                            >
                                                {cfg.label}
                                            </Badge>
                                            {row.is_flatline && (
                                                <Tooltip content="Last 5+ prices are identical — possible broken feed">
                                                    <Badge
                                                        size="xs"
                                                        colorPalette="orange"
                                                        fontSize="10px"
                                                    >
                                                        Flat
                                                    </Badge>
                                                </Tooltip>
                                            )}
                                        </Flex>
                                    </Table.Cell>
                                    <Table.Cell>
                                        <AssetBadge
                                            asset={{
                                                id: row.asset_id,
                                                symbol: row.symbol,
                                                label: row.label,
                                            }}
                                            colorPalette="blue"
                                            size="xs"
                                        />
                                    </Table.Cell>
                                    <Table.Cell textAlign="right">
                                        <Text fontWeight="medium" fontFamily="mono" fontSize="xs">
                                            {formatPrice(row.last_price)}
                                        </Text>
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Tooltip content={formatAbsoluteDate(row.last_updated)}>
                                            <Text
                                                fontSize="xs"
                                                color={row.days_stale >= staleness_threshold_days ? 'red.600' : 'gray.600'}
                                            >
                                                {formatRelativeTime(row.last_updated)}
                                            </Text>
                                        </Tooltip>
                                    </Table.Cell>
                                    <Table.Cell textAlign="right">
                                        <Text
                                            fontSize="xs"
                                            fontWeight="bold"
                                            color={
                                                row.days_stale >= staleness_threshold_days
                                                    ? 'red.600'
                                                    : row.days_stale >= staleness_threshold_days / 2
                                                        ? 'yellow.600'
                                                        : 'gray.600'
                                            }
                                        >
                                            {row.days_stale}
                                        </Text>
                                    </Table.Cell>
                                    <Table.Cell textAlign="right">
                                        <Text fontSize="xs" color="gray.600">{row.total_snapshots}</Text>
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Text fontSize="xs" color="gray.500">{row.last_source || '-'}</Text>
                                    </Table.Cell>
                                </Table.Row>
                            );
                        })}
                    </Table.Body>
                </Table.Root>
            </Box>
        </Box>
    );
};
