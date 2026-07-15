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
import { Badge, Button, Spinner, type BadgeColorScheme } from './ui/primitives';
import { usePriceHealth } from '../hooks/usePriceHealth';
import { AssetBadge } from './AssetBadge';
import type { PriceHealthRow } from '../types';
import { Tooltip } from './ui/tooltip';

// ---------------------------------------------------------------------------
// Status config
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<string, { badgeColor: BadgeColorScheme; label: string; emoji: string; border: string; text: string }> = {
    healthy: { badgeColor: 'green', label: 'Healthy', emoji: '✅', border: 'border-green-200', text: 'text-green-600' },
    warning: { badgeColor: 'yellow', label: 'Warning', emoji: '⚠️', border: 'border-yellow-200', text: 'text-yellow-600' },
    stale: { badgeColor: 'red', label: 'Stale', emoji: '🔴', border: 'border-red-200', text: 'text-red-600' },
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
            <div className="rounded-md bg-slate-50 py-10 text-center">
                <Spinner size="lg" className="text-blue-500" />
                <span className="mt-4 block">Loading price health data...</span>
            </div>
        );
    }

    if (error) {
        return (
            <div className="rounded-md border border-red-200 bg-red-50 py-10 text-center">
                <span className="text-red-600">Error: {error}</span>
                <Button size="sm" className="mt-3" onClick={() => refetch()}>Retry</Button>
            </div>
        );
    }

    if (!data || data.items.length === 0) {
        return (
            <div className="rounded-md bg-slate-50 py-10 text-center">
                <span className="text-slate-500">No price snapshot data found. Import prices first.</span>
            </div>
        );
    }

    const { summary, staleness_threshold_days } = data;

    return (
        <div>
            {/* Summary cards */}
            <div className="mb-5 flex flex-wrap gap-4">
                {(['healthy', 'warning', 'stale'] as const).map(status => {
                    const cfg = STATUS_CONFIG[status];
                    const count = summary[status];
                    return (
                        <div
                            key={status}
                            className={`min-w-[120px] flex-1 border bg-white p-3 shadow-sm ${cfg.border}`}
                        >
                            <div className="mb-1 flex items-center gap-2">
                                <span className="text-lg">{cfg.emoji}</span>
                                <span className="text-sm font-medium text-slate-600">{cfg.label}</span>
                            </div>
                            <span className={`block text-2xl font-bold ${cfg.text}`}>
                                {count}
                            </span>
                        </div>
                    );
                })}
                <div className="min-w-[120px] flex-1 border border-slate-200 bg-white p-3 shadow-sm">
                    <div className="mb-1 flex items-center gap-2">
                        <span className="text-lg">📊</span>
                        <span className="text-sm font-medium text-slate-600">Total Assets</span>
                    </div>
                    <span className="block text-2xl font-bold text-slate-700">
                        {data.items.length}
                    </span>
                </div>
            </div>

            {/* Info bar */}
            <div className="mb-3 flex items-center justify-between">
                <span className="text-xs text-slate-500">
                    Stale threshold: {staleness_threshold_days} days (configurable in P&L settings).
                </span>
                <Button size="sm" variant="outline" onClick={() => refetch()}>
                    🔄 Refresh
                </Button>
            </div>

            {/* Health table */}
            <div className="overflow-x-auto bg-white shadow-sm">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="bg-slate-50 text-left">
                            <th
                                className="cursor-pointer select-none px-2 py-1"
                                onClick={() => handleSort('status')}
                            >
                                Status{sortIndicator('status')}
                            </th>
                            <th
                                className="cursor-pointer select-none px-2 py-1"
                                onClick={() => handleSort('symbol')}
                            >
                                Asset{sortIndicator('symbol')}
                            </th>
                            <th
                                className="cursor-pointer select-none px-2 py-1 text-right"
                                onClick={() => handleSort('last_price')}
                            >
                                Last Price{sortIndicator('last_price')}
                            </th>
                            <th className="px-2 py-1">Last Updated</th>
                            <th
                                className="cursor-pointer select-none px-2 py-1 text-right"
                                onClick={() => handleSort('days_stale')}
                            >
                                Days Stale{sortIndicator('days_stale')}
                            </th>
                            <th
                                className="cursor-pointer select-none px-2 py-1 text-right"
                                onClick={() => handleSort('total_snapshots')}
                            >
                                Snapshots{sortIndicator('total_snapshots')}
                            </th>
                            <th className="px-2 py-1">Source</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sortedItems.map(row => {
                            const cfg = STATUS_CONFIG[row.status];
                            return (
                                <tr
                                    key={row.asset_id}
                                    className="border-b border-slate-100 hover:bg-slate-50"
                                >
                                    <td className="px-2 py-1">
                                        <div className="flex items-center gap-1.5">
                                            <Badge
                                                colorScheme={cfg.badgeColor}
                                                className="text-[10px]"
                                            >
                                                {cfg.label}
                                            </Badge>
                                            {row.is_flatline && (
                                                <Tooltip content="Last 5+ prices are identical — possible broken feed">
                                                    <Badge
                                                        colorScheme="orange"
                                                        className="text-[10px]"
                                                    >
                                                        Flat
                                                    </Badge>
                                                </Tooltip>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-2 py-1">
                                        <AssetBadge
                                            asset={{
                                                id: row.asset_id,
                                                symbol: row.symbol,
                                                label: row.label,
                                            }}
                                            colorPalette="blue"
                                            size="xs"
                                        />
                                    </td>
                                    <td className="px-2 py-1 text-right">
                                        <span className="font-mono text-xs font-medium">
                                            {formatPrice(row.last_price)}
                                        </span>
                                    </td>
                                    <td className="px-2 py-1">
                                        <Tooltip content={formatAbsoluteDate(row.last_updated)}>
                                            <span
                                                className={`text-xs ${row.days_stale >= staleness_threshold_days ? 'text-red-600' : 'text-slate-600'}`}
                                            >
                                                {formatRelativeTime(row.last_updated)}
                                            </span>
                                        </Tooltip>
                                    </td>
                                    <td className="px-2 py-1 text-right">
                                        <span
                                            className={`text-xs font-bold ${row.days_stale >= staleness_threshold_days
                                                ? 'text-red-600'
                                                : row.days_stale >= staleness_threshold_days / 2
                                                    ? 'text-yellow-600'
                                                    : 'text-slate-600'
                                                }`}
                                        >
                                            {row.days_stale}
                                        </span>
                                    </td>
                                    <td className="px-2 py-1 text-right">
                                        <span className="text-xs text-slate-600">{row.total_snapshots}</span>
                                    </td>
                                    <td className="px-2 py-1">
                                        <span className="text-xs text-slate-500">{row.last_source || '-'}</span>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
};
