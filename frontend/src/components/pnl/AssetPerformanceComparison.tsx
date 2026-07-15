/**
 * AssetPerformanceComparison
 *
 * Multi-line chart comparing rebased price return (%) for selected assets.
 * - Auto-selects top 10 assets by cost basis (money invested)
 * - Supports external benchmark indices (S&P 500, NASDAQ, BTC, etc.)
 * - Portfolio benchmark uses ROI% = (unrealized + realized) / cost_basis
 * - Zoom presets: All / 1Y / 6M / 3M / 1M
 * - Y-axis scale modes: Auto (clips outliers to P5-P95), Full (shows all)
 *
 * Metric: Price Return % = ((unit_price_t / unit_price_0) - 1) × 100
 * Portfolio: ROI% = ((value - cost_basis + realized) / cost_basis) × 100
 * Industry-standard rebased comparison chart (like Yahoo Finance, Bloomberg).
 */
import React, { useEffect, useMemo, useState } from 'react';
import * as RadixPopover from '@radix-ui/react-popover';
import { Badge, Spinner } from '../ui/primitives';
import { FiInfo, FiX, FiChevronDown } from 'react-icons/fi';
import { ResponsiveLine } from '@nivo/line';
import {
    usePortfolioTimeline,
    useMultiBenchmarkSeries,
    BENCHMARK_PRESETS,
    type TimelinePoint,
} from '../../hooks/useChartData';
import type { AssetPnLRow } from './types';
import { AssetComparisonPicker } from './AssetComparisonPicker';
import { Tooltip } from '../ui/tooltip';
import {
    type ZoomPreset,
    ZOOM_PRESETS,
    filterPointsByZoom,
} from './chartUtils';

const PORTFOLIO_LINE_COLOR = '#718096'; // gray.500

/** Distinct benchmark line colors (one per simultaneously-active benchmark) */
const BENCHMARK_COLORS = [
    '#D69E2E', // yellow
    '#805AD5', // purple  
    '#DD6B20', // orange
    '#319795', // teal
    '#E53E3E', // red  
    '#3182CE', // blue
];

/** Maximally-distinct asset color palette (Tableau-10 inspired) */
const COMPARISON_PALETTE = [
    '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
    '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
    '#4dc9f6', '#f67019', '#537bc4', '#acc236', '#166a8f',
];

/** Preset portfolio line colors for the color picker */
const PORTFOLIO_COLOR_PRESETS = [
    '#718096', // gray
    '#3182CE', // blue
    '#38A169', // green
    '#D69E2E', // yellow
    '#E53E3E', // red
    '#805AD5', // purple
    '#DD6B20', // orange
    '#319795', // teal
];

type ScaleMode = 'auto' | 'full';

/** Compute P5 and P95 from all Y values to clip outliers */
function computePercentileBounds(series: { data: { y: number }[] }[], padding = 0.15): { min: number; max: number } | null {
    const allY: number[] = [];
    for (const s of series) {
        for (const d of s.data) allY.push(d.y);
    }
    if (allY.length < 4) return null;
    allY.sort((a, b) => a - b);
    const p5 = allY[Math.floor(allY.length * 0.05)];
    const p95 = allY[Math.floor(allY.length * 0.95)];
    const range = p95 - p5;
    // Add padding so lines don't touch edges
    return { min: p5 - range * padding, max: p95 + range * padding };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAxisDateFormat(totalDays: number): string {
    if (totalDays < 7) return '%m/%d';
    if (totalDays < 90) return '%b %d';
    if (totalDays < 365) return '%b %y';
    return '%Y';
}

function getTickValues(totalDays: number): string {
    if (totalDays > 730) return 'every 6 months';
    if (totalDays > 365) return 'every 3 months';
    if (totalDays > 180) return 'every 2 months';
    return 'every 1 month';
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AssetPerformanceComparisonProps {
    versionId: number | null;
    baseCurrency: string;
    /** All assets from the P&L (used for auto-selection + picker) */
    assets: AssetPnLRow[];
    /** Pre-fetched timeline from PnLPanel (React Query shared) */
    sharedTimeline?: {
        data: { points: TimelinePoint[] } | null;
        isLoading: boolean;
        error: string | null;
    };
    /** Controlled zoom — when provided, overrides internal state */
    zoom?: ZoomPreset;
    /** Callback when user changes zoom (only relevant if zoom is controlled) */
    onZoomChange?: (z: ZoomPreset) => void;
    /** Context label (e.g. account/category name) shown in heading & portfolio ROI legend */
    contextLabel?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const AssetPerformanceComparison: React.FC<AssetPerformanceComparisonProps> = ({
    versionId,
    baseCurrency,
    assets,
    sharedTimeline,
    zoom: controlledZoom,
    onZoomChange,
    contextLabel,
}) => {
    // ---- State ----
    const [selectedIds, setSelectedIds] = useState<number[]>([]);
    const [internalZoom, setInternalZoom] = useState<ZoomPreset>('all');
    const zoom = controlledZoom ?? internalZoom;
    const setZoom = onZoomChange ?? setInternalZoom;
    const [showPortfolio, setShowPortfolio] = useState(true);
    const [benchmarkTickers, setBenchmarkTickers] = useState<string[]>(['^GSPC']);
    const [scaleMode, setScaleMode] = useState<ScaleMode>('auto');
    const [portfolioColor, setPortfolioColor] = useState(PORTFOLIO_LINE_COLOR);
    const [colorOverrides, setColorOverrides] = useState<Record<number, string>>({});
    const [benchmarkColorOverrides, setBenchmarkColorOverrides] = useState<Record<string, string>>({});
    const [colorPopoverKey, setColorPopoverKey] = useState<string | null>(null);

    // ---- Data fetching ----
    // Use shared timeline from PnLPanel if available; otherwise fetch own
    const ownTimeline = usePortfolioTimeline(
        versionId,
        { granularity: 'daily' },
        !sharedTimeline && !!versionId,
    );
    const timeline = sharedTimeline ?? ownTimeline;

    const allPoints: TimelinePoint[] = timeline.data?.points || [];

    // ---- Zoom filter ----
    const filteredPoints = useMemo(() => filterPointsByZoom(allPoints, zoom), [allPoints, zoom]);

    // ---- Date range for benchmark fetch ----
    const dateRange = useMemo(() => {
        if (!filteredPoints.length) return { start: null, end: null };
        return {
            start: filteredPoints[0].date,
            end: filteredPoints[filteredPoints.length - 1].date,
        };
    }, [filteredPoints]);

    // ---- Benchmark data (multiple simultaneous) ----
    const benchmarkResults = useMultiBenchmarkSeries(
        benchmarkTickers,
        dateRange.start,
        dateRange.end,
        filteredPoints.length > 0,
    );
    const anyBenchmarkLoading = benchmarkResults.some(r => r.isLoading);
    const benchmarkErrors = benchmarkResults.filter(r => r.error).map(r => `${r.ticker}: ${r.error}`);

    const portfolioRoiLabel = contextLabel ? `${contextLabel} ROI` : 'Portfolio ROI';

    // ---- Build chart series (useMemo) ----
    const { chartData, colorMap } = useMemo(() => {
        const series: { id: string; data: { x: string; y: number }[] }[] = [];
        const colors: Record<string, string> = {};

        if (!filteredPoints.length) return { chartData: series, colorMap: colors };

        // 1) Per-asset price return series
        let colorIdx = 0;
        for (const assetId of selectedIds) {
            const assetRow = assets.find(a => a.asset.id === assetId);
            // Use label (truncated to 10 chars) instead of symbol
            const rawLabel = assetRow?.asset.label || assetRow?.asset.symbol || `Asset #${assetId}`;
            const seriesId = rawLabel.length > 10 ? rawLabel.slice(0, 10) + '…' : rawLabel;
            const color = colorOverrides[assetId]
                ?? COMPARISON_PALETTE[colorIdx % COMPARISON_PALETTE.length];
            colorIdx++;

            // Build return series
            let price0: number | null = null;
            const data: { x: string; y: number }[] = [];

            for (const pt of filteredPoints) {
                const item = pt.breakdown.find(b => b.asset_id === assetId);
                if (!item || Math.abs(item.qty) < 1e-12) continue;
                const unitPrice = item.value_in_base / item.qty;
                if (price0 === null) price0 = unitPrice;
                if (price0 > 0) {
                    data.push({
                        x: pt.date,
                        y: ((unitPrice / price0) - 1) * 100,
                    });
                }
            }

            // Trim stale tail: if last 7+ points have identical y, truncate
            if (data.length >= 10) {
                let staleStart = data.length;
                for (let i = data.length - 2; i >= 0; i--) {
                    if (Math.abs(data[i].y - data[data.length - 1].y) < 0.01) {
                        staleStart = i;
                    } else break;
                }
                const staleLen = data.length - staleStart;
                if (staleLen >= 7) data.length = staleStart + 1; // keep one point for the last valid value
            }

            if (data.length >= 2) {
                series.push({ id: seriesId, data });
                colors[seriesId] = color;
            }
        }

        // 2) Portfolio benchmark — ROI%: (unrealized + realized) / cost_basis, rebased to 0% at start
        if (showPortfolio && filteredPoints.length >= 2) {
            const data: { x: string; y: number }[] = [];
            let roi0: number | null = null;
            for (const pt of filteredPoints) {
                const costBasis = pt.cost_basis_in_base;
                if (costBasis <= 0) continue;
                const unrealized = pt.unrealized_pnl;
                const realized = pt.cumulative_realized_pnl;
                const roi = ((unrealized + realized) / costBasis) * 100;
                if (roi0 === null) roi0 = roi;
                data.push({ x: pt.date, y: roi - roi0 });
            }
            if (data.length >= 2) {
                series.push({ id: `📊 ${portfolioRoiLabel}`, data });
                colors[`📊 ${portfolioRoiLabel}`] = portfolioColor;
            }
        }

        // 3) External benchmarks (multiple simultaneous)
        benchmarkResults.forEach((br, idx) => {
            if (!br.data || br.data.points.length < 2) return;
            const bPoints = br.data.points;
            const close0 = bPoints[0].close;
            if (close0 > 0) {
                const data = bPoints.map(bp => ({
                    x: bp.date,
                    y: ((bp.close / close0) - 1) * 100,
                }));
                const label = br.data.label;
                series.push({ id: label, data });
                colors[label] = benchmarkColorOverrides[br.ticker]
                    ?? BENCHMARK_COLORS[idx % BENCHMARK_COLORS.length];
            }
        });

        return { chartData: series, colorMap: colors };
    }, [filteredPoints, selectedIds, assets, showPortfolio, benchmarkResults, portfolioColor, colorOverrides, benchmarkColorOverrides, portfolioRoiLabel]);

    // ---- Derived values ----
    const totalDays = filteredPoints.length > 1
        ? Math.ceil(
            (new Date(filteredPoints[filteredPoints.length - 1].date).getTime() -
                new Date(filteredPoints[0].date).getTime()) / 86400000,
        )
        : 0;

    const portfolioId = `📊 ${portfolioRoiLabel}`;

    // Identify which series are "benchmarks" (dashed lines)
    const benchmarkSeriesIds = useMemo(() => {
        const ids = new Set<string>();
        if (showPortfolio) ids.add(portfolioId);
        for (const br of benchmarkResults) {
            if (br.data?.label) ids.add(br.data.label);
        }
        return ids;
    }, [showPortfolio, benchmarkResults]);

    // Y-axis bounds: auto mode clips outliers to P5-P95
    const yBounds = useMemo((): { min: number | 'auto'; max: number | 'auto' } => {
        if (scaleMode === 'full' || !chartData.length) return { min: 'auto', max: 'auto' };
        const bounds = computePercentileBounds(chartData as { data: { y: number }[] }[]);
        if (!bounds) return { min: 'auto', max: 'auto' };
        return { min: bounds.min, max: bounds.max };
    }, [chartData, scaleMode]);

    // Count how many series are clipped in auto mode (for indicator)
    const clippedCount = useMemo(() => {
        if (scaleMode !== 'auto' || typeof yBounds.min !== 'number' || typeof yBounds.max !== 'number') return 0;
        const bMin = yBounds.min;
        const bMax = yBounds.max;
        let count = 0;
        for (const s of chartData) {
            for (const d of s.data) {
                if ((d.y as number) > bMax || (d.y as number) < bMin) {
                    count++;
                    break; // Count each series once
                }
            }
        }
        return count;
    }, [chartData, scaleMode, yBounds]);

    // ---- Empty / loading states ----
    if (!versionId) {
        return (
            <div className="p-8 text-center">
                <span className="text-gray-400">No P&L version selected. Calculate P&L first to compare assets.</span>
            </div>
        );
    }

    // ---- Render ----
    return (
        <div>
            {/* Card container */}
            <div className="border border-gray-200 bg-white p-4">
                {/* Header row */}
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <h2 className="text-sm font-semibold text-gray-700">{contextLabel ? `${contextLabel} — Performance Comparison` : 'Performance Comparison'}</h2>
                        <Tooltip content="Rebased return comparison: each line starts at 0% on the first visible date. Portfolio ROI = (unrealized + realized) / cost basis — measures actual return on invested capital. Compare against benchmarks (S&P 500, BTC) to assess relative performance. If your portfolio underperforms a benchmark, consider whether the risk you’re taking is justified by the returns." openDelay={200}>
                            <div className="cursor-help text-gray-400 hover:text-blue-500">
                                <FiInfo size={14} />
                            </div>
                        </Tooltip>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {/* Scale mode */}
                        <div className="flex items-center gap-1">
                            {(['auto', 'full'] as const).map(mode => (
                                <Badge
                                    key={mode}
                                    colorScheme={scaleMode === mode ? 'blue' : 'gray'}
                                    onClick={() => setScaleMode(mode)}
                                    className={`cursor-pointer px-2 ${scaleMode === mode ? 'ring-2 ring-blue-400' : ''}`}
                                >
                                    {mode === 'auto' ? 'Auto' : 'Full'}
                                </Badge>
                            ))}
                            {scaleMode === 'auto' && clippedCount > 0 && (
                                <span className="self-center text-xs text-gray-400">
                                    {clippedCount} clipped
                                </span>
                            )}
                        </div>
                        {/* Zoom presets */}
                        <div className="flex items-center gap-1">
                            {(Object.keys(ZOOM_PRESETS) as ZoomPreset[]).map(k => (
                                <Badge
                                    key={k}
                                    colorScheme={zoom === k ? 'purple' : 'gray'}
                                    onClick={() => setZoom(k)}
                                    className={`cursor-pointer px-2 ${zoom === k ? 'ring-2 ring-purple-400' : ''}`}
                                >
                                    {ZOOM_PRESETS[k].label}
                                </Badge>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Controls row */}
                <div className="mb-3 flex flex-wrap items-center gap-4">
                    {/* Asset picker */}
                    <div className="min-w-[200px] flex-1">
                        <AssetComparisonPicker
                            assets={assets}
                            selectedIds={selectedIds}
                            onChange={setSelectedIds}
                            maxSelections={10}
                        />
                    </div>

                    {/* Benchmark multiselect dropdown */}
                    <RadixPopover.Root>
                        <RadixPopover.Trigger asChild>
                            <div className="flex shrink-0 cursor-pointer items-center gap-1 border border-gray-200 px-2 py-1 transition-colors hover:border-gray-400">
                                <span className="whitespace-nowrap text-xs text-gray-500">
                                    Benchmarks{benchmarkTickers.length > 0 ? ` (${benchmarkTickers.length})` : ''}
                                </span>
                                <FiChevronDown size={12} />
                                {anyBenchmarkLoading && <Spinner size="xs" className="text-yellow-500" />}
                            </div>
                        </RadixPopover.Trigger>
                        <RadixPopover.Portal>
                            <RadixPopover.Content
                                side="bottom"
                                align="start"
                                sideOffset={4}
                                className="w-[200px] border border-gray-200 bg-white p-2 shadow-lg"
                            >
                                <div className="flex flex-col gap-1">
                                    {BENCHMARK_PRESETS.map(bp => {
                                        const isActive = benchmarkTickers.includes(bp.ticker);
                                        return (
                                            <div
                                                key={bp.ticker}
                                                className={`flex cursor-pointer items-center gap-2 px-2 py-1 ${isActive ? 'bg-yellow-50 hover:bg-yellow-100' : 'hover:bg-gray-50'}`}
                                                onClick={() =>
                                                    setBenchmarkTickers(prev =>
                                                        prev.includes(bp.ticker)
                                                            ? prev.filter(t => t !== bp.ticker)
                                                            : [...prev, bp.ticker]
                                                    )
                                                }
                                            >
                                                <div
                                                    className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center border-[1.5px] ${isActive ? 'border-yellow-500 bg-yellow-500' : 'border-gray-300 bg-transparent'}`}
                                                >
                                                    {isActive && (
                                                        <span className="text-[10px] leading-none text-white">✓</span>
                                                    )}
                                                </div>
                                                <span className="text-xs text-gray-700">{bp.label}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </RadixPopover.Content>
                        </RadixPopover.Portal>
                    </RadixPopover.Root>

                    {/* Portfolio toggle */}
                    <div className="flex shrink-0 items-center gap-2">
                        <button
                            type="button"
                            role="switch"
                            aria-checked={showPortfolio}
                            onClick={() => setShowPortfolio(!showPortfolio)}
                            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${showPortfolio ? 'bg-blue-500' : 'bg-gray-300'}`}
                        >
                            <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${showPortfolio ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                        </button>
                        <span className="whitespace-nowrap text-xs text-gray-500">Portfolio</span>
                    </div>
                </div>

                {/* Unified badge bar — all selected items with color dot + remove */}
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    {/* Portfolio badge */}
                    {showPortfolio && (
                        <RadixPopover.Root
                            open={colorPopoverKey === 'portfolio'}
                            onOpenChange={(o) => setColorPopoverKey(o ? 'portfolio' : null)}
                        >
                            <RadixPopover.Trigger asChild>
                                <Badge colorScheme="gray" className="flex cursor-pointer items-center gap-1 px-2">
                                    <div
                                        className="h-2 w-2 shrink-0 rounded-full"
                                        style={{ backgroundColor: portfolioColor }}
                                    />
                                    <span className="text-xs">{portfolioRoiLabel}</span>
                                </Badge>
                            </RadixPopover.Trigger>
                            <RadixPopover.Portal>
                                <RadixPopover.Content
                                    side="bottom"
                                    sideOffset={4}
                                    className="w-auto border border-gray-200 bg-white p-2 shadow-md"
                                >
                                    <div className="flex max-w-[140px] flex-wrap gap-1">
                                        {PORTFOLIO_COLOR_PRESETS.map(c => (
                                            <div
                                                key={c}
                                                className={`h-4 w-4 cursor-pointer rounded-full border-2 transition-transform hover:scale-125 ${portfolioColor === c ? 'border-gray-700' : 'border-transparent'}`}
                                                style={{ backgroundColor: c }}
                                                onClick={() => { setPortfolioColor(c); setColorPopoverKey(null); }}
                                            />
                                        ))}
                                    </div>
                                </RadixPopover.Content>
                            </RadixPopover.Portal>
                        </RadixPopover.Root>
                    )}

                    {/* Asset badges */}
                    {selectedIds.map((id, idx) => {
                        const row = assets.find(a => a.asset.id === id);
                        if (!row) return null;
                        const currentColor = colorOverrides[id] ?? COMPARISON_PALETTE[idx % COMPARISON_PALETTE.length];
                        const name = row.asset.label ?? row.asset.symbol ?? '???';
                        const label = name.length > 14 ? name.slice(0, 14) + '…' : name;
                        const popKey = `asset-${id}`;
                        return (
                            <RadixPopover.Root
                                key={id}
                                open={colorPopoverKey === popKey}
                                onOpenChange={(o) => setColorPopoverKey(o ? popKey : null)}
                            >
                                <RadixPopover.Trigger asChild>
                                    <Badge colorScheme="gray" className="flex cursor-pointer items-center gap-1 px-2">
                                        <div
                                            className="h-2 w-2 shrink-0 rounded-full"
                                            style={{ backgroundColor: currentColor }}
                                        />
                                        <span className="text-xs">{label}</span>
                                        <span
                                            className="ml-0.5 text-gray-400 hover:text-red-500"
                                            onClick={(e: React.MouseEvent) => {
                                                e.stopPropagation();
                                                setSelectedIds(prev => prev.filter(x => x !== id));
                                            }}
                                        >
                                            <FiX size={10} />
                                        </span>
                                    </Badge>
                                </RadixPopover.Trigger>
                                <RadixPopover.Portal>
                                    <RadixPopover.Content
                                        side="bottom"
                                        sideOffset={4}
                                        className="w-auto border border-gray-200 bg-white p-2 shadow-md"
                                    >
                                        <div className="flex max-w-[140px] flex-wrap gap-1">
                                            {COMPARISON_PALETTE.map(c => (
                                                <div
                                                    key={c}
                                                    className={`h-4 w-4 cursor-pointer rounded-full border-2 transition-transform hover:scale-125 ${currentColor === c ? 'border-gray-700' : 'border-transparent'}`}
                                                    style={{ backgroundColor: c }}
                                                    onClick={() => { setColorOverrides(prev => ({ ...prev, [id]: c })); setColorPopoverKey(null); }}
                                                />
                                            ))}
                                        </div>
                                    </RadixPopover.Content>
                                </RadixPopover.Portal>
                            </RadixPopover.Root>
                        );
                    })}

                    {/* Benchmark badges */}
                    {benchmarkTickers.map((ticker, idx) => {
                        const preset = BENCHMARK_PRESETS.find(b => b.ticker === ticker);
                        if (!preset) return null;
                        const currentColor = benchmarkColorOverrides[ticker]
                            ?? BENCHMARK_COLORS[idx % BENCHMARK_COLORS.length];
                        const popKey = `bench-${ticker}`;
                        return (
                            <RadixPopover.Root
                                key={ticker}
                                open={colorPopoverKey === popKey}
                                onOpenChange={(o) => setColorPopoverKey(o ? popKey : null)}
                            >
                                <RadixPopover.Trigger asChild>
                                    <Badge colorScheme="yellow" className="flex cursor-pointer items-center gap-1 px-2">
                                        <div
                                            className="h-2 w-2 shrink-0 rounded-full"
                                            style={{ backgroundColor: currentColor }}
                                        />
                                        <span className="text-xs">{preset.label}</span>
                                        <span
                                            className="ml-0.5 text-gray-400 hover:text-red-500"
                                            onClick={(e: React.MouseEvent) => {
                                                e.stopPropagation();
                                                setBenchmarkTickers(prev => prev.filter(t => t !== ticker));
                                            }}
                                        >
                                            <FiX size={10} />
                                        </span>
                                    </Badge>
                                </RadixPopover.Trigger>
                                <RadixPopover.Portal>
                                    <RadixPopover.Content
                                        side="bottom"
                                        sideOffset={4}
                                        className="w-auto border border-gray-200 bg-white p-2 shadow-md"
                                    >
                                        <div className="flex max-w-[140px] flex-wrap gap-1">
                                            {[...BENCHMARK_COLORS, ...COMPARISON_PALETTE.slice(0, 4)].map(c => (
                                                <div
                                                    key={c}
                                                    className={`h-4 w-4 cursor-pointer rounded-full border-2 transition-transform hover:scale-125 ${currentColor === c ? 'border-gray-700' : 'border-transparent'}`}
                                                    style={{ backgroundColor: c }}
                                                    onClick={() => { setBenchmarkColorOverrides(prev => ({ ...prev, [ticker]: c })); setColorPopoverKey(null); }}
                                                />
                                            ))}
                                        </div>
                                    </RadixPopover.Content>
                                </RadixPopover.Portal>
                            </RadixPopover.Root>
                        );
                    })}
                </div>

                {/* Error states */}
                {timeline.error && (
                    <div className="mb-3 border border-red-200 bg-red-50 p-2">
                        <span className="text-xs text-red-600">Timeline error: {timeline.error}</span>
                    </div>
                )}
                {benchmarkErrors.length > 0 && (
                    <div className="mb-3 border border-yellow-200 bg-yellow-50 p-2">
                        {benchmarkErrors.map((e, i) => (
                            <div key={i} className="text-xs text-yellow-700">Benchmark: {e}</div>
                        ))}
                    </div>
                )}

                {/* Chart area */}
                {timeline.isLoading ? (
                    <div className="flex h-[400px] items-center justify-center gap-2">
                        <Spinner size="sm" className="text-blue-500" />
                        <span className="text-sm text-gray-400">Loading timeline data...</span>
                    </div>
                ) : chartData.length === 0 ? (
                    <div className="flex h-[400px] items-center justify-center">
                        <span className="text-sm text-gray-400">
                            Select assets to compare their performance.
                        </span>
                    </div>
                ) : (
                    <div className="h-[400px]" key={`chart-${zoom}-${selectedIds.join(',')}-${benchmarkTickers.join(',')}`}>
                        <ResponsiveLine
                            data={chartData}
                            animate={false}
                            margin={{ top: 20, right: 130, bottom: 50, left: 65 }}
                            xScale={{ type: 'time', format: '%Y-%m-%d', precision: 'day', useUTC: false }}
                            xFormat="time:%Y-%m-%d"
                            yScale={{ type: 'linear', min: yBounds.min, max: yBounds.max }}
                            yFormat={(v) => `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`}
                            axisBottom={{
                                format: getAxisDateFormat(totalDays),
                                tickRotation: -30,
                                tickValues: getTickValues(totalDays),
                            }}
                            axisLeft={{
                                format: (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`,
                                legend: 'Return %',
                                legendOffset: -55,
                                legendPosition: 'middle',
                            }}
                            colors={(serie) => colorMap[serie.id as string] || '#999'}
                            lineWidth={2}
                            enableArea={false}
                            enablePoints={false}
                            useMesh={true}
                            curve="monotoneX"
                            enableSlices="x"
                            markers={[
                                {
                                    axis: 'y',
                                    value: 0,
                                    lineStyle: { stroke: '#CBD5E0', strokeWidth: 1, strokeDasharray: '4 4' },
                                    legend: '',
                                },
                            ]}
                            sliceTooltip={({ slice }) => {
                                const sorted = [...slice.points].sort(
                                    (a, b) => (b.data.y as number) - (a.data.y as number),
                                );
                                return (
                                    <div className="min-w-[200px] max-w-[280px] border border-gray-200 bg-white p-2 shadow-md">
                                        <div className="mb-1 text-xs font-bold text-gray-600">
                                            {sorted[0]?.data.xFormatted}
                                        </div>
                                        {sorted.map(p => {
                                            const val = p.data.y as number;
                                            const isBenchmark = benchmarkSeriesIds.has(p.seriesId as string);
                                            return (
                                                <div key={p.id} className="flex items-center justify-between gap-3 py-0.5">
                                                    <div className="flex min-w-0 items-center gap-1">
                                                        <div
                                                            className={`h-2 w-2 shrink-0 rounded-full ${isBenchmark ? 'border border-dashed border-gray-400' : ''}`}
                                                            style={{ backgroundColor: p.seriesColor }}
                                                        />
                                                        <span className={`truncate text-xs ${isBenchmark ? 'italic' : ''}`}>
                                                            {p.seriesId}
                                                        </span>
                                                    </div>
                                                    <span className={`shrink-0 text-xs font-bold ${val >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                        {val >= 0 ? '+' : ''}{val.toFixed(1)}%
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                );
                            }}
                            legends={[
                                {
                                    anchor: 'right',
                                    direction: 'column',
                                    translateX: 125,
                                    translateY: 0,
                                    itemWidth: 115,
                                    itemHeight: 16,
                                    symbolSize: 10,
                                    symbolShape: 'circle',
                                    itemTextColor: '#555',
                                },
                            ]}
                            theme={{
                                axis: { ticks: { text: { fontSize: 10 } } },
                                tooltip: { container: { fontFamily: 'inherit', fontSize: 12 } },
                            }}
                        />
                    </div>
                )}
            </div>
        </div>
    );
};
