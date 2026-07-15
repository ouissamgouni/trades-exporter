/**
 * PriceHealthCards — Compact card-grid price health view.
 *
 * - Filter pills + search + sort toolbar
 * - Responsive grid of compact cards (as many per row as fit)
 * - PnL-style pagination bar (top + bottom) with chevron icons
 * - Gap badge is clickable → expands card with bigger chart + CTAs
 * - Info icon next to asset name opens AssetDetailSlidePanel
 */

import React, { useMemo, useState } from 'react';
import {
    Badge, type BadgeColorScheme, Button, Input, Spinner, Text,
} from './ui/primitives';
import {
    FiInfo, FiSearch, FiRefreshCw, FiX,
    FiChevronLeft, FiChevronRight, FiChevronsLeft, FiChevronsRight,
    FiChevronDown, FiEdit3, FiList,
} from 'react-icons/fi';
import { usePriceHealth } from '../hooks/usePriceHealth';
import { usePriceGapsSummary, PRICE_GAPS_QUERY_KEY, PRICE_GAPS_SUMMARY_QUERY_KEY } from '../hooks/usePriceGaps';
import { PRICE_TIMESERIES_QUERY_KEY, PRICE_HEALTH_QUERY_KEY } from '../hooks/usePriceHealth';
import { useQueryClient } from '@tanstack/react-query';
import { useAssetDetailPanel } from '../contexts/AssetDetailPanelContext';
import { GapFixPanel } from './GapFixPanel';
import { PriceSetterDialog } from './pnl/PriceSetterDialog';
import { Tooltip } from './ui/tooltip';
import { formatRelativeTime } from '../utils/dateUtils';
import type { PriceHealthRow } from '../types';

// ---------------------------------------------------------------------------
// Lightweight sparkline — pure SVG, no deps, no HTTP fetch
// ---------------------------------------------------------------------------

const Sparkline: React.FC<{ prices: number[]; width?: number; height?: number; color?: string }> = ({
    prices, width = 180, height = 28, color = '#6366f1',
}) => {
    if (prices.length < 2) return null;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;
    const pad = 1;
    const points = prices
        .map((p, i) => {
            const x = (i / (prices.length - 1)) * (width - pad * 2) + pad;
            const y = height - pad - ((p - min) / range) * (height - pad * 2);
            return `${x},${y}`;
        })
        .join(' ');
    return (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
            <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        </svg>
    );
};

// ---------------------------------------------------------------------------
// Status config
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<string, { color: BadgeColorScheme; label: string; emoji: string }> = {
    healthy: { color: 'green', label: 'Healthy', emoji: '✅' },
    warning: { color: 'yellow', label: 'Warning', emoji: '⚠️' },
    stale: { color: 'red', label: 'Stale', emoji: '🔴' },
    no_transactions: { color: 'gray', label: 'No txns', emoji: 'ℹ️' },
};

const PILL_ACTIVE: Record<string, string> = {
    gray: 'bg-slate-600 text-white',
    green: 'bg-green-600 text-white',
    yellow: 'bg-yellow-600 text-white',
    red: 'bg-red-600 text-white',
    orange: 'bg-orange-600 text-white',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPrice(price: number): string {
    if (price >= 1) return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (price >= 0.01) return price.toFixed(4);
    if (price >= 0.0001) return price.toFixed(6);
    return price.toFixed(8);
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

type SortKey = 'status' | 'gaps' | 'days_stale' | 'symbol';
const STATUS_ORDER: Record<string, number> = { stale: 0, warning: 1, healthy: 2, no_transactions: 3 };

function sortRows(rows: PriceHealthRow[], key: SortKey, gapMap: Map<number, number>): PriceHealthRow[] {
    return [...rows].sort((a, b) => {
        switch (key) {
            case 'status': {
                const c = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
                return c !== 0 ? c : b.days_stale - a.days_stale;
            }
            case 'gaps': return (gapMap.get(b.asset_id) ?? 0) - (gapMap.get(a.asset_id) ?? 0);
            case 'days_stale': return b.days_stale - a.days_stale;
            case 'symbol': return a.symbol.localeCompare(b.symbol);
            default: return 0;
        }
    });
}

type StatusFilter = 'all' | 'healthy' | 'warning' | 'stale' | 'gaps';

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const PriceHealthCards: React.FC<{ onViewTable?: (assetId: number) => void }> = ({ onViewTable }) => {
    const { data, isLoading, error, refetch } = usePriceHealth();
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState<StatusFilter>('all');
    const [sortKey, setSortKey] = useState<SortKey>('status');
    const [page, setPage] = useState(0);         // 0-indexed like PnL
    const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
    const [expandedId, setExpandedId] = useState<number | null>(null);

    const { openAssetPanel } = useAssetDetailPanel();
    const qc = useQueryClient();

    const handleCardRefresh = () => {
        qc.invalidateQueries({ queryKey: PRICE_HEALTH_QUERY_KEY });
        qc.invalidateQueries({ queryKey: PRICE_GAPS_QUERY_KEY });
        qc.invalidateQueries({ queryKey: PRICE_GAPS_SUMMARY_QUERY_KEY });
        qc.invalidateQueries({ queryKey: PRICE_TIMESERIES_QUERY_KEY });
    };

    // Gap summary
    const allAssetIds = useMemo(() => (data?.items ?? []).map(r => r.asset_id), [data?.items]);
    const { data: gapSummary } = usePriceGapsSummary(allAssetIds);
    const gapMap = useMemo(() => {
        const m = new Map<number, number>();
        if (gapSummary?.items) {
            for (const item of gapSummary.items) {
                if (item.total_missing_days > 0) m.set(item.asset_id, item.total_missing_days);
            }
        }
        return m;
    }, [gapSummary]);

    // Filter + search + sort
    const processed = useMemo(() => {
        if (!data?.items) return [];
        let items = data.items;
        if (search) {
            const q = search.toLowerCase();
            items = items.filter(r =>
                r.symbol.toLowerCase().includes(q) || (r.label && r.label.toLowerCase().includes(q))
            );
        }
        if (filter !== 'all') {
            items = filter === 'gaps'
                ? items.filter(r => gapMap.has(r.asset_id))
                : items.filter(r => r.status === filter);
        }
        return sortRows(items, sortKey, gapMap);
    }, [data?.items, search, filter, sortKey, gapMap]);

    // Pagination
    const totalRows = processed.length;
    const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
    const safePage = Math.min(page, pageCount - 1);
    const pageItems = useMemo(() => {
        const start = safePage * pageSize;
        return processed.slice(start, start + pageSize);
    }, [processed, safePage, pageSize]);

    React.useEffect(() => { setPage(0); }, [search, filter, sortKey]);

    // Counts
    const counts = useMemo(() => {
        if (!data?.items) return { all: 0, healthy: 0, warning: 0, stale: 0, gaps: 0 };
        return {
            all: data.items.length,
            healthy: data.summary.healthy,
            warning: data.summary.warning,
            stale: data.summary.stale,
            gaps: gapMap.size,
        };
    }, [data, gapMap]);

    // ── Loading / Error / Empty ──────────────────────────────────────────
    if (isLoading) {
        return (
            <div className="bg-gray-50 py-10 text-center">
                <Spinner size="lg" className="text-blue-500" />
                <Text className="mt-4 block">Loading price health data...</Text>
            </div>
        );
    }
    if (error) {
        return (
            <div className="border border-red-200 bg-red-50 py-10 text-center">
                <Text className="text-red-600">Error: {error}</Text>
                <Button size="sm" className="mt-3" onClick={() => refetch()}>Retry</Button>
            </div>
        );
    }
    if (!data || data.items.length === 0) {
        return (
            <div className="bg-gray-50 py-10 text-center">
                <Text className="text-gray-500">No price snapshot data found. Import prices first.</Text>
            </div>
        );
    }

    // ── Pagination bar (PnL style) ──────────────────────────────────────
    const paginationBar = totalRows > PAGE_SIZE_OPTIONS[0] ? (
        <div className="flex w-full items-center justify-between px-3 py-2">
            <div className="flex items-center gap-2">
                <Text className="text-[10px] text-gray-500">Rows:</Text>
                <div className="inline-flex overflow-hidden border border-gray-200">
                    {PAGE_SIZE_OPTIONS.map(size => (
                        <Button
                            key={size}
                            variant={pageSize === size ? 'outline' : 'ghost'}
                            colorScheme={pageSize === size ? 'blue' : 'gray'}
                            onClick={() => { setPageSize(size); setPage(0); }}
                            className="px-2 text-xs"
                        >
                            {size}
                        </Button>
                    ))}
                </div>
            </div>
            <Text className="text-[10px] text-gray-500">
                {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, totalRows)} of {totalRows}
            </Text>
            <div className="flex items-center gap-1">
                <Button variant="ghost" onClick={() => setPage(0)} disabled={safePage === 0} className="px-1">
                    <FiChevronsLeft size={12} />
                </Button>
                <Button variant="ghost" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0} className="px-1">
                    <FiChevronLeft size={14} />
                </Button>
                <Text className="mx-1 text-xs text-gray-600">
                    {safePage + 1} / {pageCount}
                </Text>
                <Button variant="ghost" onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1} className="px-1">
                    <FiChevronRight size={14} />
                </Button>
                <Button variant="ghost" onClick={() => setPage(pageCount - 1)} disabled={safePage >= pageCount - 1} className="px-1">
                    <FiChevronsRight size={12} />
                </Button>
            </div>
        </div>
    ) : null;

    // ── Filter pills ────────────────────────────────────────────────────
    const pills: Array<{ key: StatusFilter; label: string; count: number; color: BadgeColorScheme }> = [
        { key: 'all', label: 'All', count: counts.all, color: 'gray' },
        { key: 'healthy', label: 'Healthy', count: counts.healthy, color: 'green' },
        { key: 'warning', label: 'Warning', count: counts.warning, color: 'yellow' },
        { key: 'stale', label: 'Stale', count: counts.stale, color: 'red' },
        { key: 'gaps', label: 'Gaps', count: counts.gaps, color: 'orange' },
    ];

    return (
        <div>
            {/* ── Toolbar: pills + search + sort + refresh ── */}
            <div className="mb-2 flex flex-wrap items-center gap-2">
                {pills.map(p => {
                    const isActive = filter === p.key;
                    return (
                        <Badge
                            key={p.key}
                            colorScheme={p.color}
                            onClick={() => setFilter(isActive ? 'all' : p.key)}
                            className={`cursor-pointer rounded-full px-2 py-0.5 hover:opacity-80 ${isActive ? PILL_ACTIVE[p.color] : ''}`}
                        >
                            {p.label} ({p.count})
                        </Badge>
                    );
                })}
                <div className="flex-1" />
                <div className="relative w-[160px]">
                    <Input placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} className="h-7 pl-7 text-xs" />
                    <div className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400"><FiSearch size={12} /></div>
                </div>
                <select
                    value={sortKey}
                    onChange={e => setSortKey(e.target.value as SortKey)}
                    className="h-7 w-[120px] border border-gray-200 px-1 text-xs"
                >
                    <option value="status">Sort: Status</option>
                    <option value="gaps">Sort: Gaps</option>
                    <option value="days_stale">Sort: Stale</option>
                    <option value="symbol">Sort: A-Z</option>
                </select>
                <Button variant="outline" className="px-2 text-xs" onClick={() => refetch()}><FiRefreshCw size={12} /></Button>
            </div>

            {/* ── Top pagination ── */}
            {paginationBar && (
                <div className="mb-2 border-b border-gray-100">
                    {paginationBar}
                </div>
            )}

            {/* ── Card grid ── */}
            {pageItems.length === 0 ? (
                <div className="bg-gray-50 py-10 text-center">
                    <Text className="text-gray-400">No assets match your criteria.</Text>
                </div>
            ) : (
                <div className="flex flex-wrap gap-2">
                    {pageItems.map(row => (
                        <HealthCard
                            key={row.asset_id}
                            row={row}
                            gapDays={gapMap.get(row.asset_id)}
                            expanded={expandedId === row.asset_id}
                            onToggleExpand={() => setExpandedId(prev => prev === row.asset_id ? null : row.asset_id)}
                            onOpenPanel={() => openAssetPanel(row.asset_id)}
                            onRefresh={handleCardRefresh}
                            onViewTable={onViewTable}
                        />
                    ))}
                </div>
            )}

            {/* ── Bottom pagination ── */}
            {paginationBar && (
                <div className="mt-2 border-t border-gray-100">
                    {paginationBar}
                </div>
            )}
        </div>
    );
};

// ---------------------------------------------------------------------------
// Single health card — compact, fits many per row
// ---------------------------------------------------------------------------

interface HealthCardProps {
    row: PriceHealthRow;
    gapDays?: number;
    expanded: boolean;
    onToggleExpand: () => void;
    onOpenPanel: () => void;
    onRefresh: () => void;
    onViewTable?: (assetId: number) => void;
}

const HealthCard: React.FC<HealthCardProps> = ({ row, gapDays, expanded, onToggleExpand, onOpenPanel, onRefresh, onViewTable }) => {
    const cfg = STATUS_CONFIG[row.status] ?? STATUS_CONFIG.healthy;
    const hasGaps = gapDays != null && gapDays > 0;
    const noTx = row.status === 'no_transactions';
    const [showPriceSetter, setShowPriceSetter] = useState(false);

    return (
        <div
            className={`relative border bg-white px-2.5 py-1.5 transition-all duration-150 ${noTx ? 'opacity-60' : 'opacity-100'} ${expanded
                    ? 'min-w-[185px] max-w-[660px] flex-[1_0_570px] border-orange-300 hover:border-orange-400 hover:shadow-xs'
                    : 'min-w-[185px] max-w-[220px] flex-[1_0_185px] hover:shadow-xs ' + (noTx ? 'border-gray-100 hover:border-blue-300' : 'border-gray-200 hover:border-blue-300')
                }`}
        >
            {/* Row 1: name + icons + tiny chart */}
            <div className="mb-1 flex items-center gap-1.5">
                <Text className="flex-1 truncate text-xs font-bold">
                    {row.symbol}
                </Text>
                {onViewTable && (
                    <Tooltip content="View price table">
                        <button
                            type="button"
                            className="shrink-0 cursor-pointer text-gray-400 hover:text-blue-500"
                            onClick={e => { e.stopPropagation(); onViewTable(row.asset_id); }}
                        >
                            <FiList size={12} />
                        </button>
                    </Tooltip>
                )}
                <Tooltip content="Open details">
                    <button
                        type="button"
                        className="shrink-0 cursor-pointer text-gray-400 hover:text-blue-500"
                        onClick={e => { e.stopPropagation(); onOpenPanel(); }}
                    >
                        <FiInfo size={12} />
                    </button>
                </Tooltip>
                <Tooltip content="Set prices">
                    <button
                        type="button"
                        className="shrink-0 cursor-pointer text-gray-400 hover:text-blue-500"
                        onClick={e => { e.stopPropagation(); setShowPriceSetter(true); }}
                    >
                        <FiEdit3 size={11} />
                    </button>
                </Tooltip>
                <Tooltip content="Refresh">
                    <button
                        type="button"
                        className="shrink-0 cursor-pointer text-gray-300 hover:text-blue-500"
                        onClick={e => { e.stopPropagation(); onRefresh(); }}
                    >
                        <FiRefreshCw size={10} />
                    </button>
                </Tooltip>
                {expanded ? (
                    <Tooltip content="Collapse">
                        <button
                            type="button"
                            className="shrink-0 cursor-pointer text-gray-400 hover:text-red-500"
                            onClick={e => { e.stopPropagation(); onToggleExpand(); }}
                        >
                            <FiX size={14} />
                        </button>
                    </Tooltip>
                ) : (
                    <Tooltip content="Expand">
                        <button
                            type="button"
                            className="shrink-0 cursor-pointer text-gray-300 hover:text-blue-500"
                            onClick={e => { e.stopPropagation(); onToggleExpand(); }}
                        >
                            <FiChevronDown size={14} />
                        </button>
                    </Tooltip>
                )}
            </div>

            {/* Sparkline row */}
            {!expanded && row.sparkline && row.sparkline.length >= 2 && (
                <div className="mb-0.5 mt-0.5 h-[28px]">
                    <Sparkline prices={row.sparkline} width={180} height={28} />
                </div>
            )}

            {/* Row 2: badges */}
            <div className="mb-0.5 flex flex-wrap gap-1">
                <Badge colorScheme={cfg.color} className="text-[9px]">
                    {cfg.label}
                </Badge>
                {row.is_flatline && (
                    <Tooltip content="Last 5+ prices identical — possible broken feed">
                        <Badge colorScheme="orange" className="text-[9px]">Flat</Badge>
                    </Tooltip>
                )}
                {hasGaps && (
                    <Badge
                        colorScheme="orange"
                        onClick={onToggleExpand}
                        className={`cursor-pointer text-[9px] hover:opacity-80 ${expanded ? 'bg-orange-600 text-white' : ''}`}
                    >
                        {gapDays}d gaps
                    </Badge>
                )}
                {row.quote_currencies && row.quote_currencies.length > 0 && row.quote_currencies.map(q => (
                    <Badge key={q.asset_id} colorScheme="purple" className="text-[8px]">
                        {q.symbol}
                    </Badge>
                ))}
            </div>

            {/* Row 3: price, age, source */}
            <div className="flex items-center gap-2">
                <Text className="font-mono text-xs font-bold">
                    {formatPrice(row.last_price)}
                </Text>
                <Tooltip content={row.last_updated ? new Date(row.last_updated).toLocaleString() : ''}>
                    <Text className={`text-[10px] ${row.status === 'stale' ? 'text-red-600' : 'text-gray-500'}`}>
                        {formatRelativeTime(row.last_updated)}
                    </Text>
                </Tooltip>
                <Text className="truncate text-[10px] text-gray-400">
                    {row.last_source || '—'}
                </Text>
            </div>

            {/* Expanded section: chart + gap CTAs */}
            {expanded && (
                <ExpandedSection assetId={row.asset_id} symbol={row.symbol} onOpenPriceSetter={() => setShowPriceSetter(true)} />
            )}

            {/* Price Setter Dialog */}
            {showPriceSetter && (
                <PriceSetterDialog
                    isOpen={true}
                    onClose={() => setShowPriceSetter(false)}
                    onSave={() => { setShowPriceSetter(false); onRefresh(); }}
                    assetId={row.asset_id}
                    assetName={row.symbol}
                    defaultDate={new Date().toISOString()}
                />
            )}
        </div>
    );
};

// ---------------------------------------------------------------------------
// Expanded gap section — loaded only when card is expanded
// ---------------------------------------------------------------------------

const ExpandedSection: React.FC<{ assetId: number; symbol: string; onOpenPriceSetter: () => void }> = ({ assetId, symbol, onOpenPriceSetter }) => (
    <div className="mt-2 border-t border-orange-100 pt-2">
        <GapFixPanel assetId={assetId} symbol={symbol} onOpenPriceSetter={onOpenPriceSetter} />
    </div>
);

export default PriceHealthCards;
