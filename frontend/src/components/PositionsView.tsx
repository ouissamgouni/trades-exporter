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
import { Badge, Heading, Spinner, Text } from './ui/primitives';
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
            valueColor: totalPnl >= 0 ? 'text-green-600' : 'text-red-600',
            bg: totalPnl >= 0 ? 'bg-green-50' : 'bg-red-50',
            borderColor: totalPnl >= 0 ? 'border-l-green-400' : 'border-l-red-400',
        },
        {
            label: 'Win Rate',
            value: `${winRate.toFixed(1)}%`,
            subtitle: `${wins}W / ${closedPositions.length - wins}L`,
            valueColor: winRate >= 50 ? 'text-green-600' : 'text-orange-600',
            bg: 'bg-gray-50',
            borderColor: winRate >= 50 ? 'border-l-green-400' : 'border-l-orange-400',
        },
        {
            label: 'Positions',
            value: String(closedPositions.length),
            subtitle: `${positions.filter(p => p.status === 'open').length} open`,
            valueColor: 'text-blue-600',
            bg: 'bg-blue-50',
            borderColor: 'border-l-blue-400',
        },
        {
            label: 'Total Fees',
            value: `${totalFees.toFixed(2)} USDC`,
            valueColor: 'text-orange-600',
            bg: 'bg-orange-50',
            borderColor: 'border-l-orange-400',
        },
    ];

    return (
        <div className="mb-4 flex flex-wrap gap-3">
            {cards.map((card) => (
                <div
                    key={card.label}
                    className={`flex-1 min-w-[150px] border border-gray-200 border-l-[3px] p-3 ${card.bg} ${card.borderColor}`}
                >
                    <Text className="mb-1 block text-xs text-gray-500">
                        {card.label}
                    </Text>
                    <Text className={`block text-lg font-bold ${card.valueColor}`}>
                        {card.value}
                    </Text>
                    {card.subtitle && (
                        <Text className="block text-xs text-gray-500">
                            {card.subtitle}
                        </Text>
                    )}
                </div>
            ))}
        </div>
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
        <div className="mb-4 flex flex-wrap items-center gap-3">
            {/* Status segmented control */}
            <div className="flex overflow-hidden border border-gray-200">
                {statuses.map((s) => (
                    <button
                        key={s}
                        type="button"
                        className={`cursor-pointer px-3 py-1 text-xs transition-all duration-150 ${statusFilter === s
                                ? 'bg-blue-500 font-bold text-white hover:bg-blue-600'
                                : 'bg-white font-normal text-gray-600 hover:bg-gray-50'
                            }`}
                        onClick={() => onStatusChange(s)}
                    >
                        {s.charAt(0).toUpperCase() + s.slice(1)}
                    </button>
                ))}
            </div>

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
        </div>
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
    <th
        className="cursor-pointer py-2 text-left text-xs hover:bg-gray-200"
        onClick={() => onSort(field)}
    >
        <div className="flex items-center gap-1">
            {label}
            {sortBy === field && (
                <Text className="text-[9px]">{sortDir === 'asc' ? '▲' : '▼'}</Text>
            )}
        </div>
    </th>
);

const PositionsTable: React.FC<PositionsTableProps> = ({
    positions,
    sortBy,
    sortDir,
    onSort,
    onRowClick,
}) => {
    return (
        <div className="overflow-x-auto border border-gray-200 bg-white shadow-sm">
            <table className="w-full text-sm">
                <thead>
                    <tr className="bg-gray-100">
                        <SortableHeader label="Coin" field="coin" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                        <SortableHeader label="Side" field="side" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                        <SortableHeader label="Entry" field="entry_price" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                        <SortableHeader label="Exit" field="exit_price" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                        <SortableHeader label="Size" field="size" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                        <SortableHeader label="P&L" field="realized_pnl" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                        <SortableHeader label="Fees" field="total_fees" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                        <SortableHeader label="Duration" field="closed_at" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                        <th className="bg-gray-100 py-2 text-left text-xs">Status</th>
                    </tr>
                </thead>
                <tbody>
                    {positions.length === 0 ? (
                        <tr>
                            <td colSpan={9}>
                                <div className="flex items-center justify-center py-8">
                                    <Text className="text-sm text-gray-500">
                                        No positions found
                                    </Text>
                                </div>
                            </td>
                        </tr>
                    ) : (
                        positions.map((pos) => {
                            const sideColor = pos.side === 'long' ? 'green' : 'red';
                            const pnlColor = pos.net_pnl >= 0 ? 'text-green-600' : 'text-red-600';
                            const statusColor = pos.status === 'open' ? 'blue' : 'gray';

                            return (
                                <tr
                                    key={pos.id}
                                    className="cursor-pointer transition-colors duration-100 hover:bg-blue-50"
                                    onClick={() => onRowClick?.(pos)}
                                >
                                    <td className="px-2 py-1">
                                        <Badge colorScheme="purple" className="text-xs">
                                            {pos.coin}
                                        </Badge>
                                    </td>
                                    <td className="px-2 py-1">
                                        <Badge colorScheme={sideColor} className="text-xs">
                                            {pos.side.toUpperCase()}
                                        </Badge>
                                    </td>
                                    <td className="px-2 py-1 text-xs">
                                        ${pos.entry_price?.toFixed(2)}
                                    </td>
                                    <td className="px-2 py-1 text-xs">
                                        {pos.exit_price != null ? `$${pos.exit_price.toFixed(2)}` : '—'}
                                    </td>
                                    <td className="px-2 py-1 text-xs">
                                        {pos.size}
                                    </td>
                                    <td className="px-2 py-1">
                                        <Text className={`text-xs font-bold ${pnlColor}`}>
                                            {pos.net_pnl >= 0 ? '+' : ''}
                                            {pos.net_pnl?.toFixed(2)}
                                        </Text>
                                    </td>
                                    <td className="px-2 py-1 text-xs text-gray-500">
                                        {pos.total_fees?.toFixed(2)}
                                    </td>
                                    <td className="px-2 py-1 text-xs text-gray-500">
                                        {pos.duration_hours != null
                                            ? pos.duration_hours < 24
                                                ? `${pos.duration_hours.toFixed(1)}h`
                                                : `${(pos.duration_hours / 24).toFixed(1)}d`
                                            : '—'}
                                    </td>
                                    <td className="px-2 py-1">
                                        <Badge colorScheme={statusColor} className="text-xs">
                                            {pos.status}
                                        </Badge>
                                    </td>
                                </tr>
                            );
                        })
                    )}
                </tbody>
            </table>
        </div>
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
    const pnlColor = pos.net_pnl >= 0 ? 'text-green-600' : 'text-red-600';

    return (
        <div className="fixed bottom-0 right-0 top-0 z-[1000] w-[400px] overflow-y-auto border-l border-gray-200 bg-white p-4 shadow-xl">
            <div className="mb-4 flex justify-between">
                <div className="flex items-center gap-2">
                    <Badge colorScheme="purple">{pos.coin}</Badge>
                    <Badge colorScheme={sideColor}>
                        {pos.side.toUpperCase()}
                    </Badge>
                    <Badge colorScheme={pos.status === 'open' ? 'blue' : 'gray'}>
                        {pos.status}
                    </Badge>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="cursor-pointer text-lg text-gray-400 hover:text-gray-700"
                >
                    ✕
                </button>
            </div>

            <div className="flex flex-col gap-2 text-sm">
                <DetailRow label="Entry Price" value={`$${pos.entry_price?.toFixed(2)}`} />
                {pos.exit_price != null && (
                    <DetailRow label="Exit Price" value={`$${pos.exit_price.toFixed(2)}`} />
                )}
                <DetailRow label="Size" value={`${pos.size} ${pos.coin}`} />
                <DetailRow label="Remaining" value={`${pos.remaining_size} ${pos.coin}`} />
                <div className="my-1 border-t border-gray-200" />
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
                <div className="my-1 border-t border-gray-200" />
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
            </div>
        </div>
    );
};

const DetailRow: React.FC<{
    label: string;
    value: string;
    valueColor?: string;
    bold?: boolean;
}> = ({ label, value, valueColor = 'text-gray-700', bold = false }) => (
    <div className="flex justify-between">
        <Text className="text-gray-500">{label}</Text>
        <Text className={`${valueColor} ${bold ? 'font-bold' : 'font-normal'}`}>
            {value}
        </Text>
    </div>
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
        <div className="p-4">
            <Heading as="h2" className="mb-4 text-lg">
                Derivative Positions
            </Heading>

            {isLoading ? (
                <div className="flex h-[200px] items-center justify-center">
                    <Spinner size="lg" className="text-blue-500" />
                </div>
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

                    <Text className="mt-2 block text-xs text-gray-500">
                        {positions.length} position{positions.length !== 1 ? 's' : ''}
                    </Text>
                </>
            )}

            {/* Detail slide-in panel */}
            {selectedPosition && (
                <>
                    {/* Backdrop */}
                    <div
                        className="fixed inset-0 z-[999] bg-black/60"
                        onClick={() => setSelectedPosition(null)}
                    />
                    <PositionDetailPanel
                        position={selectedPosition}
                        onClose={() => setSelectedPosition(null)}
                    />
                </>
            )}
        </div>
    );
};

export default PositionsView;
