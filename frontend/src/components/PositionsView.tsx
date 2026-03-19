/**
 * PositionsView — Dedicated tab for viewing derivative (perp) positions.
 *
 * Features:
 * - Summary cards: Total P&L, Win Rate, Total Positions, Total Fees
 * - Filters: Status (All/Open/Closed), Coin, Exchange
 * - Sortable table of positions
 * - Row click opens position detail
 */

import React, { useState, useMemo } from 'react';
import {
    Badge,
    Box,
    Card,
    Flex,
    Heading,
    HStack,
    Text,
    VStack,
    Table,
    Spinner,
    Center,
} from '@chakra-ui/react';
import { usePositions } from '../hooks/usePositions';
import type { DerivativePosition } from '../types';

// ============================================================================
// Summary Cards
// ============================================================================

interface SummaryCardsProps {
    positions: DerivativePosition[];
}

const SummaryCards: React.FC<SummaryCardsProps> = ({ positions }) => {
    const closedPositions = positions.filter(p => p.status === 'closed');
    const totalPnl = closedPositions.reduce((sum, p) => sum + (p.net_pnl ?? 0), 0);
    const totalFees = positions.reduce((sum, p) => sum + (p.total_fees ?? 0), 0);
    const wins = closedPositions.filter(p => p.net_pnl > 0).length;
    const winRate = closedPositions.length > 0 ? (wins / closedPositions.length) * 100 : 0;

    const cards = [
        {
            label: 'Total P&L',
            value: `${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} USDC`,
            valueColor: totalPnl >= 0 ? 'green.600' : 'red.600',
            bg: totalPnl >= 0 ? 'green.50' : 'red.50',
            borderColor: totalPnl >= 0 ? 'green.400' : 'red.400',
        },
        {
            label: 'Win Rate',
            value: `${winRate.toFixed(1)}%`,
            subtitle: `${wins}W / ${closedPositions.length - wins}L`,
            valueColor: winRate >= 50 ? 'green.600' : 'orange.600',
            bg: 'gray.50',
            borderColor: winRate >= 50 ? 'green.400' : 'orange.400',
        },
        {
            label: 'Positions',
            value: String(closedPositions.length),
            subtitle: `${positions.filter(p => p.status === 'open').length} open`,
            valueColor: 'blue.600',
            bg: 'blue.50',
            borderColor: 'blue.400',
        },
        {
            label: 'Total Fees',
            value: `${totalFees.toFixed(2)} USDC`,
            valueColor: 'orange.600',
            bg: 'orange.50',
            borderColor: 'orange.400',
        },
    ];

    return (
        <HStack gap={3} mb={4} flexWrap="wrap">
            {cards.map((card) => (
                <Card.Root
                    key={card.label}
                    flex="1"
                    minW="150px"
                    bg={card.bg}
                    borderWidth="1px"
                    borderColor="gray.200"
                    borderLeft="3px solid"
                    borderLeftColor={card.borderColor}
                    p={3}
                >
                    <Card.Body p={0}>
                        <Text fontSize="xs" color="gray.500" mb={1}>
                            {card.label}
                        </Text>
                        <Text fontSize="lg" fontWeight="bold" color={card.valueColor}>
                            {card.value}
                        </Text>
                        {card.subtitle && (
                            <Text fontSize="xs" color="gray.500">
                                {card.subtitle}
                            </Text>
                        )}
                    </Card.Body>
                </Card.Root>
            ))}
        </HStack>
    );
};

// ============================================================================
// Filters
// ============================================================================

type StatusFilter = 'all' | 'open' | 'closed';

interface FiltersProps {
    statusFilter: StatusFilter;
    onStatusChange: (status: StatusFilter) => void;
    coinFilter: string;
    onCoinChange: (coin: string) => void;
    coins: string[];
}

const Filters: React.FC<FiltersProps> = ({
    statusFilter,
    onStatusChange,
    coinFilter,
    onCoinChange,
    coins,
}) => {
    const statuses: StatusFilter[] = ['all', 'open', 'closed'];

    return (
        <Flex gap={3} mb={4} flexWrap="wrap" align="center">
            {/* Status segmented control */}
            <HStack gap={0} borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden">
                {statuses.map((s) => (
                    <Box
                        key={s}
                        as="button"
                        px={3}
                        py={1}
                        fontSize="xs"
                        fontWeight={statusFilter === s ? 'bold' : 'normal'}
                        bg={statusFilter === s ? 'blue.500' : 'white'}
                        color={statusFilter === s ? 'white' : 'gray.600'}
                        _hover={{ bg: statusFilter === s ? 'blue.600' : 'gray.50' }}
                        onClick={() => onStatusChange(s)}
                        cursor="pointer"
                        transition="all 0.15s"
                    >
                        {s.charAt(0).toUpperCase() + s.slice(1)}
                    </Box>
                ))}
            </HStack>

            {/* Coin filter */}
            <select
                value={coinFilter}
                onChange={(e) => onCoinChange(e.target.value)}
                style={{
                    backgroundColor: 'white',
                    color: '#2D3748',
                    border: '1px solid #E2E8F0',
                    borderRadius: '6px',
                    padding: '4px 8px',
                    fontSize: '12px',
                }}
            >
                <option value="">All Coins</option>
                {coins.map((c) => (
                    <option key={c} value={c}>
                        {c}
                    </option>
                ))}
            </select>
        </Flex>
    );
};

// ============================================================================
// Positions Table
// ============================================================================

interface PositionsTableProps {
    positions: DerivativePosition[];
    sortBy: string;
    sortDir: 'asc' | 'desc';
    onSort: (field: string) => void;
    onRowClick?: (position: DerivativePosition) => void;
}

const SortableHeader: React.FC<{
    label: string;
    field: string;
    sortBy: string;
    sortDir: string;
    onSort: (f: string) => void;
}> = ({ label, field, sortBy, sortDir, onSort }) => (
    <Table.ColumnHeader
        cursor="pointer"
        onClick={() => onSort(field)}
        _hover={{ bg: 'gray.200' }}
        fontSize="xs"
        py={2}
    >
        <Flex align="center" gap={1}>
            {label}
            {sortBy === field && (
                <Text fontSize="9px">{sortDir === 'asc' ? '▲' : '▼'}</Text>
            )}
        </Flex>
    </Table.ColumnHeader>
);

const PositionsTable: React.FC<PositionsTableProps> = ({
    positions,
    sortBy,
    sortDir,
    onSort,
    onRowClick,
}) => {
    return (
        <Box overflowX="auto" bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="md" boxShadow="sm">
            <Table.Root size="sm">
                <Table.Header>
                    <Table.Row bg="gray.100">
                        <SortableHeader label="Coin" field="coin" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                        <SortableHeader label="Side" field="side" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                        <SortableHeader label="Entry" field="entry_price" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                        <SortableHeader label="Exit" field="exit_price" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                        <SortableHeader label="Size" field="size" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                        <SortableHeader label="P&L" field="realized_pnl" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                        <SortableHeader label="Fees" field="total_fees" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                        <SortableHeader label="Duration" field="closed_at" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                        <Table.ColumnHeader fontSize="xs" py={2} bg="gray.100">Status</Table.ColumnHeader>
                    </Table.Row>
                </Table.Header>
                <Table.Body>
                    {positions.length === 0 ? (
                        <Table.Row>
                            <Table.Cell colSpan={9}>
                                <Center py={8}>
                                    <Text fontSize="sm" color="gray.500">
                                        No positions found
                                    </Text>
                                </Center>
                            </Table.Cell>
                        </Table.Row>
                    ) : (
                        positions.map((pos) => {
                            const sideColor = pos.side === 'long' ? 'green' : 'red';
                            const pnlColor = pos.net_pnl >= 0 ? 'green.600' : 'red.600';
                            const statusColor = pos.status === 'open' ? 'blue' : 'gray';

                            return (
                                <Table.Row
                                    key={pos.id}
                                    _hover={{ bg: 'blue.50', cursor: 'pointer' }}
                                    onClick={() => onRowClick?.(pos)}
                                    transition="background 0.1s"
                                >
                                    <Table.Cell>
                                        <Badge size="sm" colorPalette="purple" variant="subtle">
                                            {pos.coin}
                                        </Badge>
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Badge size="sm" colorPalette={sideColor} variant="solid">
                                            {pos.side.toUpperCase()}
                                        </Badge>
                                    </Table.Cell>
                                    <Table.Cell fontSize="xs">
                                        ${pos.entry_price?.toFixed(2)}
                                    </Table.Cell>
                                    <Table.Cell fontSize="xs">
                                        {pos.exit_price != null ? `$${pos.exit_price.toFixed(2)}` : '—'}
                                    </Table.Cell>
                                    <Table.Cell fontSize="xs">
                                        {pos.size}
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Text fontSize="xs" color={pnlColor} fontWeight="bold">
                                            {pos.net_pnl >= 0 ? '+' : ''}
                                            {pos.net_pnl?.toFixed(2)}
                                        </Text>
                                    </Table.Cell>
                                    <Table.Cell fontSize="xs" color="gray.500">
                                        {pos.total_fees?.toFixed(2)}
                                    </Table.Cell>
                                    <Table.Cell fontSize="xs" color="gray.500">
                                        {pos.duration_hours != null
                                            ? pos.duration_hours < 24
                                                ? `${pos.duration_hours.toFixed(1)}h`
                                                : `${(pos.duration_hours / 24).toFixed(1)}d`
                                            : '—'}
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Badge size="sm" colorPalette={statusColor} variant="subtle">
                                            {pos.status}
                                        </Badge>
                                    </Table.Cell>
                                </Table.Row>
                            );
                        })
                    )}
                </Table.Body>
            </Table.Root>
        </Box>
    );
};

// ============================================================================
// Position Detail Panel (slide-in on row click)
// ============================================================================

const PositionDetailPanel: React.FC<{
    position: DerivativePosition;
    onClose: () => void;
}> = ({ position: pos, onClose }) => {
    const sideColor = pos.side === 'long' ? 'green' : 'red';
    const pnlColor = pos.net_pnl >= 0 ? 'green.300' : 'red.300';

    return (
        <Box
            position="fixed"
            right={0}
            top={0}
            bottom={0}
            w="400px"
            bg="white"
            borderLeft="1px solid"
            borderColor="gray.200"
            p={4}
            overflowY="auto"
            zIndex={1000}
            boxShadow="xl"
        >
            <Flex justify="space-between" mb={4}>
                <HStack gap={2}>
                    <Badge size="md" colorPalette="purple">{pos.coin}</Badge>
                    <Badge size="md" colorPalette={sideColor} variant="solid">
                        {pos.side.toUpperCase()}
                    </Badge>
                    <Badge size="md" colorPalette={pos.status === 'open' ? 'blue' : 'gray'}>
                        {pos.status}
                    </Badge>
                </HStack>
                <Box
                    as="button"
                    onClick={onClose}
                    color="gray.400"
                    _hover={{ color: 'gray.700' }}
                    cursor="pointer"
                    fontSize="lg"
                >
                    ✕
                </Box>
            </Flex>

            <VStack align="stretch" gap={2} fontSize="sm">
                <DetailRow label="Entry Price" value={`$${pos.entry_price?.toFixed(2)}`} />
                {pos.exit_price != null && (
                    <DetailRow label="Exit Price" value={`$${pos.exit_price.toFixed(2)}`} />
                )}
                <DetailRow label="Size" value={`${pos.size} ${pos.coin}`} />
                <DetailRow label="Remaining" value={`${pos.remaining_size} ${pos.coin}`} />
                <Box borderTop="1px" borderColor="gray.200" my={1} />
                <DetailRow
                    label="Realized P&L"
                    value={`${pos.realized_pnl >= 0 ? '+' : ''}${pos.realized_pnl?.toFixed(2)} ${pos.margin_currency}`}
                    valueColor={pnlColor}
                />
                <DetailRow
                    label="Total Fees"
                    value={`${pos.total_fees?.toFixed(2)} ${pos.margin_currency}`}
                />
                <DetailRow
                    label="Net P&L"
                    value={`${pos.net_pnl >= 0 ? '+' : ''}${pos.net_pnl?.toFixed(2)} ${pos.margin_currency}`}
                    valueColor={pnlColor}
                    bold
                />
                {pos.return_pct != null && (
                    <DetailRow
                        label="Return"
                        value={`${pos.return_pct >= 0 ? '+' : ''}${pos.return_pct.toFixed(2)}%`}
                        valueColor={pnlColor}
                    />
                )}
                {pos.duration_hours != null && (
                    <DetailRow
                        label="Duration"
                        value={
                            pos.duration_hours < 24
                                ? `${pos.duration_hours.toFixed(1)} hours`
                                : `${(pos.duration_hours / 24).toFixed(1)} days`
                        }
                    />
                )}
                <Box borderTop="1px" borderColor="gray.200" my={1} />
                <DetailRow label="Exchange" value={pos.exchange} />
                <DetailRow label="Margin" value={pos.margin_currency} />
                {pos.opened_at && (
                    <DetailRow label="Opened" value={new Date(pos.opened_at).toLocaleString()} />
                )}
                {pos.closed_at && (
                    <DetailRow label="Closed" value={new Date(pos.closed_at).toLocaleString()} />
                )}
                <DetailRow label="Open TX" value={pos.open_transaction_id ? `#${pos.open_transaction_id}` : '—'} />
                <DetailRow
                    label="Close TXs"
                    value={
                        pos.close_transaction_ids?.length
                            ? pos.close_transaction_ids.map((id) => `#${id}`).join(', ')
                            : '—'
                    }
                />
            </VStack>
        </Box>
    );
};

const DetailRow: React.FC<{
    label: string;
    value: string;
    valueColor?: string;
    bold?: boolean;
}> = ({ label, value, valueColor = 'gray.700', bold = false }) => (
    <Flex justify="space-between">
        <Text color="gray.500">{label}</Text>
        <Text color={valueColor} fontWeight={bold ? 'bold' : 'normal'}>
            {value}
        </Text>
    </Flex>
);

// ============================================================================
// Main Component
// ============================================================================

const PositionsView: React.FC = () => {
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [coinFilter, setCoinFilter] = useState('');
    const [sortBy, setSortBy] = useState('opened_at');
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
    const [selectedPosition, setSelectedPosition] = useState<DerivativePosition | null>(null);

    const { positions, isLoading } = usePositions({
        status: statusFilter === 'all' ? undefined : statusFilter,
        coin: coinFilter || undefined,
        sort_by: sortBy,
        sort_dir: sortDir,
        limit: 500,
    });

    // Extract unique coins for filter dropdown
    const coins = useMemo(() => {
        const seen = new Set<string>();
        positions.forEach((p) => seen.add(p.coin));
        return Array.from(seen).sort();
    }, [positions]);

    const handleSort = (field: string) => {
        if (sortBy === field) {
            setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        } else {
            setSortBy(field);
            setSortDir('desc');
        }
    };

    return (
        <Box p={4}>
            <Heading as="h2" size="lg" mb={4}>
                Derivative Positions
            </Heading>

            {isLoading ? (
                <Center h="200px">
                    <Spinner size="xl" color="blue.500" />
                </Center>
            ) : (
                <>
                    <SummaryCards positions={positions} />

                    <Filters
                        statusFilter={statusFilter}
                        onStatusChange={setStatusFilter}
                        coinFilter={coinFilter}
                        onCoinChange={setCoinFilter}
                        coins={coins}
                    />

                    <PositionsTable
                        positions={positions}
                        sortBy={sortBy}
                        sortDir={sortDir}
                        onSort={handleSort}
                        onRowClick={setSelectedPosition}
                    />

                    <Text fontSize="xs" color="gray.500" mt={2}>
                        {positions.length} position{positions.length !== 1 ? 's' : ''}
                    </Text>
                </>
            )}

            {/* Detail slide-in panel */}
            {selectedPosition && (
                <>
                    {/* Backdrop */}
                    <Box
                        position="fixed"
                        top={0}
                        left={0}
                        right={0}
                        bottom={0}
                        bg="blackAlpha.600"
                        zIndex={999}
                        onClick={() => setSelectedPosition(null)}
                    />
                    <PositionDetailPanel
                        position={selectedPosition}
                        onClose={() => setSelectedPosition(null)}
                    />
                </>
            )}
        </Box>
    );
};

export default PositionsView;
