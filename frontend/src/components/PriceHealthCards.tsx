/**
 * PriceHealthCards — Compact card-grid price health view.
 *
 * - Bulk gap-fix bar (shared server-side job) with per-card job status
 * - Filter pills + search + sort toolbar
 * - Responsive grid of compact cards (as many per row as fit)
 * - PnL-style pagination bar (top + bottom) with chevron icons
 * - Gap badge is clickable → expands card with bigger chart + CTAs
 * - Info icon next to asset name opens AssetDetailSlidePanel
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    Badge, type BadgeColorScheme, Button, Input, Spinner, Text,
} from './ui/primitives';
import {
    FiInfo, FiSearch, FiRefreshCw, FiX,
    FiChevronLeft, FiChevronRight, FiChevronsLeft, FiChevronsRight,
    FiChevronDown, FiEdit3, FiList, FiSkipForward,
} from 'react-icons/fi';
import { usePriceHealth } from '../hooks/usePriceHealth';
import {
    usePriceGapsSummary, useGapFixJob,
    PRICE_GAPS_QUERY_KEY, PRICE_GAPS_SUMMARY_QUERY_KEY, GAP_FIX_JOB_QUERY_KEY,
} from '../hooks/usePriceGaps';
import { PRICE_TIMESERIES_QUERY_KEY, PRICE_HEALTH_QUERY_KEY } from '../hooks/usePriceHealth';
import { useQueryClient } from '@tanstack/react-query';
import { useAssetDetailPanel } from '../contexts/AssetDetailPanelContext';
import { GapFixPanel } from './GapFixPanel';
import { GapFixJobBar } from './GapFixJobBar';
import { PriceSetterDialog } from './pnl/PriceSetterDialog';
import { Tooltip } from './ui/tooltip';
import { toaster } from './ui/toaster';
import { formatRelativeTime } from '../utils/dateUtils';
import type { GapFixAssetStatus, GapFixJobAsset, GapFixJobState, PriceHealthRow } from '../types';

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

const JOB_STATUS_META: Record<GapFixAssetStatus, { label: string; scheme: BadgeColorScheme }> = {
    pending: { label: 'Queued', scheme: 'gray' },
    running: { label: 'Fetching', scheme: 'blue' },
    done: { label: 'Fixed', scheme: 'green' },
    partial: { label: 'Partial', scheme: 'orange' },
    failed: { label: 'Failed', scheme: 'red' },
    skipped: { label: 'Skipped', scheme: 'orange' },
    cancelled: { label: 'Cancelled', scheme: 'gray' },
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

const displayName = (row: PriceHealthRow) => row.label || row.symbol;

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
            case 'symbol': return displayName(a).localeCompare(displayName(b));
            default: return 0;
        }
    });
}

export type PriceHealthFilter = 'all' | 'healthy' | 'warning' | 'stale' | 'gaps';

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface PriceHealthCardsProps {
    onViewTable?: (assetId: number) => void;
    /** Restrict to these assets; null/undefined = all assets */
    assetIds?: number[] | null;
    defaultFilter?: PriceHealthFilter;
    /** Switch to gaps, expand this asset's card and scroll to it */
    focusAssetId?: number | null;
    quoteAssetId?: number | null;
    onJobFinished?: (job: GapFixJobState) => void;
    /** Rendered at the start of the gap-fix bar (e.g. a scope toggle) */
    toolbarStart?: React.ReactNode;
    /** Custom asset name renderer (defaults to label, falling back to symbol) */
    renderName?: (row: PriceHealthRow) => React.ReactNode;
}

export const PriceHealthCards: React.FC<PriceHealthCardsProps> = ({
    onViewTable, assetIds, defaultFilter = 'all', focusAssetId, quoteAssetId, onJobFinished, toolbarStart, renderName,
}) => {
    const { data, isLoading, error, refetch } = usePriceHealth();
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState<PriceHealthFilter>(focusAssetId != null ? 'gaps' : defaultFilter);
    const [sortKey, setSortKey] = useState<SortKey>(defaultFilter === 'gaps' ? 'gaps' : 'status');
    const [page, setPage] = useState(0);         // 0-indexed like PnL
    const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
    const [expandedId, setExpandedId] = useState<number | null>(focusAssetId ?? null);
    const pendingFocusRef = useRef<number | null>(focusAssetId ?? null);
    const scrollTargetRef = useRef<number | null>(null);

    const { openAssetPanel } = useAssetDetailPanel();
    const qc = useQueryClient();

    const fix = useGapFixJob((finished) => {
        const msg = `${finished.fetched_count} fetched, ${finished.failed_count} failed`;
        if (finished.status === 'complete') toaster.success({ title: 'Gap fix complete', description: msg });
        else if (finished.status === 'cancelled') toaster.info({ title: 'Gap fix cancelled', description: msg });
        else if (finished.status === 'error') toaster.error({ title: 'Gap fix failed', description: finished.error ?? msg });
        onJobFinished?.(finished);
    });
    const { job, isActive, skip } = fix;

    const handleCardRefresh = () => {
        qc.invalidateQueries({ queryKey: PRICE_HEALTH_QUERY_KEY });
        qc.invalidateQueries({ queryKey: PRICE_GAPS_QUERY_KEY });
        qc.invalidateQueries({ queryKey: PRICE_GAPS_SUMMARY_QUERY_KEY });
        qc.invalidateQueries({ queryKey: PRICE_TIMESERIES_QUERY_KEY });
    };

    const handleRefreshAll = () => {
        handleCardRefresh();
        qc.invalidateQueries({ queryKey: GAP_FIX_JOB_QUERY_KEY });
    };

    // Scope
    const scopeSet = useMemo(() => (assetIds ? new Set(assetIds) : null), [assetIds]);
    const scopedItems = useMemo(
        () => (data?.items ?? []).filter(r => !scopeSet || scopeSet.has(r.asset_id)),
        [data?.items, scopeSet],
    );

    // Gap summary
    const { data: gapSummary, isLoading: gapSummaryLoading } = usePriceGapsSummary(assetIds ?? null);
    const gapMap = useMemo(() => {
        const m = new Map<number, number>();
        for (const item of gapSummary?.items ?? []) {
            if (item.total_missing_days > 0) m.set(item.asset_id, item.total_missing_days);
        }
        return m;
    }, [gapSummary]);
    const recap = useMemo(() => {
        const items = (gapSummary?.items ?? []).filter(i => i.total_missing_days > 0);
        return {
            assets: items.length,
            ranges: items.reduce((s, i) => s + i.gap_count, 0),
            days: items.reduce((s, i) => s + i.total_missing_days, 0),
        };
    }, [gapSummary]);

    // Job assets stay under the Gaps filter after their gaps are fixed
    const jobById = useMemo(
        () => new Map<number, GapFixJobAsset>((job && job.status !== 'idle' ? job.assets : []).map(a => [a.asset_id, a])),
        [job],
    );

    // Filter + search + sort
    const processed = useMemo(() => {
        let items = scopedItems;
        if (search) {
            const q = search.toLowerCase();
            items = items.filter(r =>
                r.symbol.toLowerCase().includes(q) || (r.label && r.label.toLowerCase().includes(q))
            );
        }
        if (filter !== 'all') {
            items = filter === 'gaps'
                ? items.filter(r => gapMap.has(r.asset_id) || jobById.has(r.asset_id))
                : items.filter(r => r.status === filter);
        }
        return sortRows(items, sortKey, gapMap);
    }, [scopedItems, search, filter, sortKey, gapMap, jobById]);

    // Pagination
    const totalRows = processed.length;
    const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
    const safePage = Math.min(page, pageCount - 1);
    const pageItems = useMemo(() => {
        const start = safePage * pageSize;
        return processed.slice(start, start + pageSize);
    }, [processed, safePage, pageSize]);

    React.useEffect(() => { setPage(0); }, [search, filter, sortKey]);

    // Focus: switch to gaps, expand, jump to page, scroll into view
    useEffect(() => {
        if (focusAssetId == null) return;
        pendingFocusRef.current = focusAssetId;
        setFilter('gaps');
        setSearch('');
        setExpandedId(focusAssetId);
    }, [focusAssetId]);

    useEffect(() => {
        const id = pendingFocusRef.current;
        if (id == null) return;
        const idx = processed.findIndex(r => r.asset_id === id);
        if (idx < 0) return;
        pendingFocusRef.current = null;
        scrollTargetRef.current = id;
        setPage(Math.floor(idx / pageSize));
    }, [processed, pageSize]);

    useEffect(() => {
        const id = scrollTargetRef.current;
        if (id == null || !pageItems.some(r => r.asset_id === id)) return;
        scrollTargetRef.current = null;
        requestAnimationFrame(() => {
            document.querySelector(`[data-asset-card="${id}"]`)?.scrollIntoView({ block: 'center' });
        });
    }, [pageItems]);

    // Counts
    const counts = useMemo(() => ({
        all: scopedItems.length,
        healthy: scopedItems.filter(r => r.status === 'healthy').length,
        warning: scopedItems.filter(r => r.status === 'warning').length,
        stale: scopedItems.filter(r => r.status === 'stale').length,
        gaps: scopedItems.filter(r => gapMap.has(r.asset_id) || jobById.has(r.asset_id)).length,
    }), [scopedItems, gapMap, jobById]);

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
    const pills: Array<{ key: PriceHealthFilter; label: string; count: number; color: BadgeColorScheme }> = [
        { key: 'all', label: 'All', count: counts.all, color: 'gray' },
        { key: 'healthy', label: 'Healthy', count: counts.healthy, color: 'green' },
        { key: 'warning', label: 'Warning', count: counts.warning, color: 'yellow' },
        { key: 'stale', label: 'Stale', count: counts.stale, color: 'red' },
        { key: 'gaps', label: 'Gaps', count: counts.gaps, color: 'orange' },
    ];

    return (
        <div>
            {/* ── Bulk gap fix ── */}
            <GapFixJobBar
                fix={fix}
                recap={recap}
                recapLoading={gapSummaryLoading}
                scopeAssetIds={assetIds ?? null}
                quoteAssetId={quoteAssetId}
                leading={toolbarStart}
            />

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
                    <Input placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} className="h-7 pl-7 text-xs" aria-label="Search assets" />
                    <div className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400"><FiSearch size={12} /></div>
                </div>
                <select
                    value={sortKey}
                    onChange={e => setSortKey(e.target.value as SortKey)}
                    className="h-7 w-[120px] border border-gray-200 px-1 text-xs"
                    aria-label="Sort assets"
                >
                    <option value="status">Sort: Status</option>
                    <option value="gaps">Sort: Gaps</option>
                    <option value="days_stale">Sort: Stale</option>
                    <option value="symbol">Sort: A-Z</option>
                </select>
                <Button variant="outline" className="px-2 text-xs" onClick={handleRefreshAll} aria-label="Refresh price health"><FiRefreshCw size={12} /></Button>
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
                    <Text className="text-gray-400">
                        {filter === 'gaps' && !search ? 'No price gaps 🎉' : 'No assets match your criteria.'}
                    </Text>
                </div>
            ) : (
                <div className="flex flex-wrap gap-2">
                    {pageItems.map(row => {
                        const jobAsset = jobById.get(row.asset_id);
                        const canSkip = isActive && !!jobAsset && (jobAsset.status === 'pending' || jobAsset.status === 'running');
                        return (
                            <HealthCard
                                key={row.asset_id}
                                row={row}
                                name={renderName ? renderName(row) : displayName(row)}
                                gapDays={gapMap.get(row.asset_id)}
                                expanded={expandedId === row.asset_id}
                                focused={focusAssetId === row.asset_id}
                                jobAsset={jobAsset}
                                onSkip={canSkip ? () => skip.mutate(row.asset_id) : undefined}
                                onToggleExpand={() => setExpandedId(prev => prev === row.asset_id ? null : row.asset_id)}
                                onOpenPanel={() => openAssetPanel(row.asset_id)}
                                onRefresh={handleCardRefresh}
                                onViewTable={onViewTable}
                            />
                        );
                    })}
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
    name: React.ReactNode;
    gapDays?: number;
    expanded: boolean;
    focused: boolean;
    jobAsset?: GapFixJobAsset;
    onSkip?: () => void;
    onToggleExpand: () => void;
    onOpenPanel: () => void;
    onRefresh: () => void;
    onViewTable?: (assetId: number) => void;
}

const HealthCard: React.FC<HealthCardProps> = ({
    row, name, gapDays, expanded, focused, jobAsset, onSkip, onToggleExpand, onOpenPanel, onRefresh, onViewTable,
}) => {
    const cfg = STATUS_CONFIG[row.status] ?? STATUS_CONFIG.healthy;
    const hasGaps = gapDays != null && gapDays > 0;
    const noTx = row.status === 'no_transactions';
    const [showPriceSetter, setShowPriceSetter] = useState(false);
    const jobMeta = jobAsset ? JOB_STATUS_META[jobAsset.status] : null;

    return (
        <div
            data-asset-card={row.asset_id}
            className={`relative border bg-white px-2.5 py-1.5 transition-all duration-150 ${noTx ? 'opacity-60' : 'opacity-100'} ${focused ? 'ring-2 ring-blue-300' : ''} ${expanded
                ? 'min-w-[185px] max-w-[660px] flex-[1_0_570px] border-orange-300 hover:border-orange-400 hover:shadow-xs'
                : 'min-w-[185px] max-w-[220px] flex-[1_0_185px] hover:shadow-xs ' + (noTx ? 'border-gray-100 hover:border-blue-300' : 'border-gray-200 hover:border-blue-300')
                }`}
        >
            {/* Row 1: name + icons + tiny chart */}
            <div className="mb-1 flex items-center gap-1.5">
                <div className="min-w-0 flex-1 truncate text-xs font-bold" title={row.label ? `${row.label} (${row.symbol})` : row.symbol}>
                    {name}
                </div>
                {onViewTable && (
                    <Tooltip content="View price table">
                        <button
                            type="button"
                            aria-label="View price table"
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
                        aria-label="Open details"
                        className="shrink-0 cursor-pointer text-gray-400 hover:text-blue-500"
                        onClick={e => { e.stopPropagation(); onOpenPanel(); }}
                    >
                        <FiInfo size={12} />
                    </button>
                </Tooltip>
                <Tooltip content="Set prices">
                    <button
                        type="button"
                        aria-label="Set prices"
                        className="shrink-0 cursor-pointer text-gray-400 hover:text-blue-500"
                        onClick={e => { e.stopPropagation(); setShowPriceSetter(true); }}
                    >
                        <FiEdit3 size={11} />
                    </button>
                </Tooltip>
                <Tooltip content="Refresh">
                    <button
                        type="button"
                        aria-label="Refresh"
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
                            aria-label="Collapse"
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
                            aria-label="Expand"
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

            {/* Row 4: gap-fix job status */}
            {jobAsset && jobMeta && (
                <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px]">
                    <Badge colorScheme={jobMeta.scheme} className="text-[9px]">
                        {jobAsset.status === 'running' && <Spinner size="xs" className="mr-1" />}
                        {jobMeta.label}
                    </Badge>
                    {(jobAsset.fetched > 0 || jobAsset.failed > 0) && (
                        <span className="text-gray-500">
                            <span className="text-green-700">{jobAsset.fetched}</span> / <span className="text-red-700">{jobAsset.failed}</span>
                        </span>
                    )}
                    {(jobAsset.note || jobAsset.last_error) && (
                        <span className="min-w-0 max-w-[140px] truncate text-orange-700" title={[jobAsset.note, jobAsset.last_error].filter(Boolean).join(' — ')}>
                            {jobAsset.note ?? jobAsset.last_error}
                        </span>
                    )}
                    {onSkip && (
                        <button
                            type="button"
                            aria-label={`Skip ${displayName(row)}`}
                            title="Skip this asset"
                            onClick={e => { e.stopPropagation(); onSkip(); }}
                            className="ml-auto p-0.5 text-gray-500 hover:bg-orange-50 hover:text-orange-600"
                        >
                            <FiSkipForward size={11} />
                        </button>
                    )}
                </div>
            )}

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
                    assetName={displayName(row)}
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
