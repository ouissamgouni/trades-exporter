/**
 * PriceInvestigationChart — Self-contained price comparison chart tab.
 *
 * Shows return % over time for selected assets. All assets are selected by
 * default (from the health endpoint). Users can add/remove assets via badges
 * and pick line colors, same UX as the "Performance Comparison" chart.
 *
 * Reuses patterns from AssetPerformanceComparison:
 * - Rebasing: return% = ((price_t / price_0) - 1) * 100
 * - Zoom presets (All / 1Y / 6M / 3M / 1M)
 * - P5-P95 percentile clipping for Y-axis (auto mode)
 * - Color picker popovers on each badge
 * - "+Add" search dropdown for adding more assets
 * - Nivo ResponsiveLine with slice tooltips
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as RadixPopover from '@radix-ui/react-popover';
import { FiX, FiPlus } from 'react-icons/fi';
import { ResponsiveLine } from '@nivo/line';
import { usePriceHealth, usePriceTimeseries } from '../hooks/usePriceHealth';
import { useBaseCurrency } from '../hooks/useBaseCurrency';
import type { PriceHealthRow } from '../types';
import { Badge, Button, Input, Spinner, Text } from './ui/primitives';

// ---------------------------------------------------------------------------
// Color palette (Tableau-10 inspired - same as AssetPerformanceComparison)
// ---------------------------------------------------------------------------

const COMPARISON_PALETTE = [
    '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
    '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
    '#4dc9f6', '#f67019', '#537bc4', '#acc236', '#166a8f',
];

const MAX_ASSETS = 50;

// ---------------------------------------------------------------------------
// Zoom / scale
// ---------------------------------------------------------------------------

type ZoomPreset = 'all' | '1y' | '6m' | '3m' | '1m';
const ZOOM_PRESETS: Record<ZoomPreset, { label: string; days: number | null }> = {
    all: { label: 'All', days: null },
    '1y': { label: '1Y', days: 365 },
    '6m': { label: '6M', days: 180 },
    '3m': { label: '3M', days: 90 },
    '1m': { label: '1M', days: 30 },
};

type ScaleMode = 'auto' | 'full';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computePercentileBounds(
    series: { data: { y: number }[] }[],
    padding = 0.15,
): { min: number; max: number } | null {
    const allY: number[] = [];
    for (const s of series) for (const d of s.data) allY.push(d.y);
    if (allY.length < 4) return null;
    allY.sort((a, b) => a - b);
    const p5 = allY[Math.floor(allY.length * 0.05)];
    const p95 = allY[Math.floor(allY.length * 0.95)];
    const range = p95 - p5;
    return { min: p5 - range * padding, max: p95 + range * padding };
}

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
// Component
// ---------------------------------------------------------------------------

export const PriceInvestigationChart: React.FC = () => {
    // ----- State -----
    const [selectedIds, setSelectedIds] = useState<number[]>([]);
    const [colorOverrides, setColorOverrides] = useState<Record<number, string>>({});
    const [colorPopoverKey, setColorPopoverKey] = useState<string | null>(null);
    const [zoom, setZoom] = useState<ZoomPreset>('3m');
    const [scaleMode, setScaleMode] = useState<ScaleMode>('auto');
    const [pickerOpen, setPickerOpen] = useState(false);
    const [pickerSearch, setPickerSearch] = useState('');
    const pickerInputRef = useRef<HTMLInputElement>(null);
    const [initialised, setInitialised] = useState(false);

    // ----- Data -----
    const baseCurrency = useBaseCurrency();
    const { data: healthData, isLoading: healthLoading } = usePriceHealth();
    const { data: tsData, isLoading: tsLoading, error: tsError } = usePriceTimeseries(
        { assetIds: selectedIds, quoteAssetId: baseCurrency.assetId },
        selectedIds.length > 0,
    );

    // Auto-select stale + warning assets once health data arrives
    useEffect(() => {
        if (healthData && !initialised) {
            const problemIds = healthData.items
                .filter(r => r.status === 'stale' || r.status === 'warning')
                .map(r => r.asset_id)
                .slice(0, MAX_ASSETS);
            setSelectedIds(problemIds);
            setInitialised(true);
        }
    }, [healthData, initialised]);

    // Map asset_id -> health row for quick lookup
    const assetMap = useMemo(() => {
        const m = new Map<number, PriceHealthRow>();
        if (healthData) {
            for (const row of healthData.items) m.set(row.asset_id, row);
        }
        return m;
    }, [healthData]);

    // Filtered options for add-picker (not already selected, matching search)
    const filteredOptions = useMemo(() => {
        if (!healthData) return [];
        const selSet = new Set(selectedIds);
        const q = pickerSearch.toLowerCase().trim();
        return healthData.items
            .filter(r => {
                if (selSet.has(r.asset_id)) return false;
                if (!q) return true;
                return r.symbol.toLowerCase().includes(q) ||
                    (r.label || '').toLowerCase().includes(q);
            })
            .slice(0, 20);
    }, [healthData, selectedIds, pickerSearch]);

    // ----- Build chart series -----
    const { chartData, colorMap, totalDays } = useMemo(() => {
        const series: { id: string; data: { x: string; y: number }[] }[] = [];
        const colors: Record<string, string> = {};
        let maxDays = 0;

        if (!tsData?.assets) return { chartData: series, colorMap: colors, totalDays: 0 };

        const zoomPreset = ZOOM_PRESETS[zoom];

        tsData.assets.forEach((asset) => {
            let points = asset.points;
            if (!points || points.length < 2) return;
            if (asset.first_transaction_date) {
                const fromTx = points.filter(p => p.date >= asset.first_transaction_date!);
                if (fromTx.length >= 2) points = fromTx;
            }

            // Apply zoom filter (anchored to last data point, not "now")
            if (zoomPreset.days) {
                const lastDate = new Date(points[points.length - 1].date);
                const cutoff = new Date(lastDate);
                cutoff.setDate(cutoff.getDate() - zoomPreset.days);
                const cutoffStr = cutoff.toISOString().split('T')[0];
                const filtered = points.filter(p => p.date >= cutoffStr);
                if (filtered.length >= 2) points = filtered;
            }

            // Rebase: return% = ((price_t / price_0) - 1) * 100
            const price0 = points[0].price;
            if (price0 <= 0) return;

            const rebasedData = points.map(p => ({
                x: p.date,
                y: ((p.price / price0) - 1) * 100,
            }));

            const firstDate = new Date(points[0].date);
            const lastDate = new Date(points[points.length - 1].date);
            const days = Math.ceil((lastDate.getTime() - firstDate.getTime()) / 86_400_000);
            if (days > maxDays) maxDays = days;

            const label = asset.label
                ? (asset.label.length > 12 ? asset.label.slice(0, 12) + '\u2026' : asset.label)
                : asset.symbol;

            // Find position in selectedIds for consistent color assignment
            const selIdx = selectedIds.indexOf(asset.asset_id);
            const color = colorOverrides[asset.asset_id]
                ?? COMPARISON_PALETTE[(selIdx >= 0 ? selIdx : 0) % COMPARISON_PALETTE.length];

            series.push({ id: label, data: rebasedData });
            colors[label] = color;
        });

        return { chartData: series, colorMap: colors, totalDays: maxDays };
    }, [tsData, zoom, selectedIds, colorOverrides]);

    // ----- Y-axis bounds -----
    const yBounds = useMemo((): { min: number | 'auto'; max: number | 'auto' } => {
        if (scaleMode === 'full' || !chartData.length) return { min: 'auto', max: 'auto' };
        const bounds = computePercentileBounds(chartData as { data: { y: number }[] }[]);
        if (!bounds) return { min: 'auto', max: 'auto' };
        return { min: bounds.min, max: bounds.max };
    }, [chartData, scaleMode]);

    // ----- Event handlers -----
    const handleAdd = (id: number) => {
        if (selectedIds.length >= MAX_ASSETS) return;
        setSelectedIds(prev => [...prev, id]);
        setPickerSearch('');
        setPickerOpen(false);
    };

    const handleRemove = (id: number) => {
        setSelectedIds(prev => prev.filter(x => x !== id));
    };

    // ----- Loading state -----
    if (healthLoading) {
        return (
            <div className="py-10 text-center">
                <Spinner size="lg" className="text-blue-500" />
                <Text className="mt-4 block">Loading asset list...</Text>
            </div>
        );
    }

    if (!healthData || healthData.items.length === 0) {
        return (
            <div className="bg-gray-50 py-10 text-center">
                <Text className="text-gray-500">No price data available. Import some prices first.</Text>
            </div>
        );
    }

    const atMax = selectedIds.length >= MAX_ASSETS;

    return (
        <div>
            {/* ===== Badge bar: selected assets with color pickers + Add button ===== */}
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
                {/* Add button + search dropdown */}
                <div className="relative">
                    <Badge
                        colorScheme="gray"
                        className={`flex cursor-pointer items-center gap-1 rounded-full px-2 py-1 ${atMax ? 'cursor-not-allowed opacity-50' : ''}`}
                        onClick={() => {
                            if (!atMax) {
                                setPickerOpen(prev => !prev);
                                setTimeout(() => pickerInputRef.current?.focus(), 50);
                            }
                        }}
                    >
                        <FiPlus size={10} />
                        <Text className="text-xs">{atMax ? `Max ${MAX_ASSETS}` : 'Add'}</Text>
                    </Badge>

                    {pickerOpen && !atMax && (
                        <div className="absolute left-0 top-full z-20 mt-1 w-[240px] max-h-[260px] overflow-hidden border border-gray-200 bg-white shadow-lg">
                            <div className="border-b border-gray-100 p-2">
                                <Input
                                    ref={pickerInputRef}
                                    placeholder="Search assets..."
                                    value={pickerSearch}
                                    onChange={e => setPickerSearch(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === 'Escape') {
                                            setPickerOpen(false);
                                            setPickerSearch('');
                                        }
                                    }}
                                    className="h-8"
                                />
                            </div>
                            <div className="max-h-[200px] overflow-y-auto">
                                {filteredOptions.length === 0 ? (
                                    <Text className="block p-3 text-center text-xs text-gray-400">

                                        {selectedIds.length === healthData.items.length
                                            ? 'All assets already selected'
                                            : 'No assets found'}
                                    </Text>
                                ) : (
                                    filteredOptions.map(r => (
                                        <div
                                            key={r.asset_id}
                                            className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-blue-50"
                                            onClick={() => handleAdd(r.asset_id)}
                                        >
                                            <Text className="flex-1 text-xs font-medium">
                                                {r.symbol}
                                            </Text>
                                            {r.label && r.label !== r.symbol && (
                                                <Text className="max-w-[100px] truncate text-xs text-gray-400">
                                                    {r.label}
                                                </Text>
                                            )}
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* Click-away layer for picker */}
                {pickerOpen && (
                    <div
                        className="fixed inset-0 z-[19]"
                        onClick={() => { setPickerOpen(false); setPickerSearch(''); }}
                    />
                )}

                {/* Selected asset badges with color picker popovers */}
                {selectedIds.map((id, idx) => {
                    const row = assetMap.get(id);
                    if (!row) return null;
                    const currentColor = colorOverrides[id]
                        ?? COMPARISON_PALETTE[idx % COMPARISON_PALETTE.length];
                    const name = row.label ?? row.symbol ?? '???';
                    const label = name.length > 14 ? name.slice(0, 14) + '\u2026' : name;
                    const popKey = `asset-${id}`;

                    return (
                        <RadixPopover.Root
                            key={id}
                            open={colorPopoverKey === popKey}
                            onOpenChange={(isOpen) => setColorPopoverKey(isOpen ? popKey : null)}
                        >
                            <RadixPopover.Trigger asChild>
                                <Badge
                                    colorScheme="gray"
                                    className="flex cursor-pointer items-center gap-1 px-2"
                                >
                                    <span
                                        className="h-2 w-2 shrink-0 rounded-full"
                                        style={{ backgroundColor: currentColor }}
                                    />
                                    <Text className="text-xs">{label}</Text>
                                    <span
                                        className="ml-0.5 text-gray-400 hover:text-red-500"
                                        onClick={(e: React.MouseEvent) => {
                                            e.stopPropagation();
                                            handleRemove(id);
                                        }}
                                    >
                                        <FiX size={10} />
                                    </span>
                                </Badge>
                            </RadixPopover.Trigger>
                            <RadixPopover.Portal>
                                <RadixPopover.Content side="bottom" className="z-[2600] w-auto border border-gray-200 bg-white p-2 shadow-md">
                                    <div className="flex max-w-[140px] flex-wrap gap-1">
                                        {COMPARISON_PALETTE.map(c => (
                                            <span
                                                key={c}
                                                className="h-4 w-4 cursor-pointer rounded-full border-2 transition-transform hover:scale-125"
                                                style={{
                                                    backgroundColor: c,
                                                    borderColor: currentColor === c ? '#374151' : 'transparent',
                                                }}
                                                onClick={() => {
                                                    setColorOverrides(prev => ({ ...prev, [id]: c }));
                                                    setColorPopoverKey(null);
                                                }}
                                            />
                                        ))}
                                    </div>
                                </RadixPopover.Content>
                            </RadixPopover.Portal>
                        </RadixPopover.Root>
                    );
                })}

                {/* Quick actions */}
                {selectedIds.length > 0 && (
                    <Button
                        variant="ghost"
                        className="ml-1 h-6 px-2 text-xs text-gray-400"
                        onClick={() => setSelectedIds([])}
                    >
                        Clear all
                    </Button>
                )}
                {selectedIds.length < healthData.items.length && (
                    <Button
                        variant="ghost"
                        className={`h-6 px-2 text-xs text-gray-400 ${selectedIds.length > 0 ? '' : 'ml-1'}`}
                        onClick={() => setSelectedIds(healthData.items.map(r => r.asset_id).slice(0, MAX_ASSETS))}
                    >
                        Select all
                    </Button>
                )}
            </div>

            {/* ===== Controls: Zoom + Scale ===== */}
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <Text className="text-xs text-gray-500">
                    {selectedIds.length} of {healthData.items.length} assets
                    {tsLoading && ' \u00b7 Loading chart\u2026'}
                </Text>
                <div className="flex items-center gap-2">
                    {/* Zoom presets */}
                    <div className="inline-flex overflow-hidden border border-gray-200">
                        {(Object.entries(ZOOM_PRESETS) as [ZoomPreset, { label: string }][]).map(
                            ([key, { label }]) => (
                                <Button
                                    key={key}
                                    variant={zoom === key ? 'solid' : 'ghost'}
                                    colorScheme={zoom === key ? 'blue' : 'gray'}
                                    onClick={() => setZoom(key)}
                                    className="h-6 px-2 text-xs"
                                >
                                    {label}
                                </Button>
                            ),
                        )}
                    </div>
                    {/* Scale mode */}
                    <div className="inline-flex overflow-hidden border border-gray-200">
                        {([
                            { value: 'auto', label: 'Auto' },
                            { value: 'full', label: 'Full' },
                        ] as const).map(opt => (
                            <Button
                                key={opt.value}
                                variant={scaleMode === opt.value ? 'solid' : 'ghost'}
                                colorScheme="gray"
                                onClick={() => setScaleMode(opt.value)}
                                className="h-6 px-2 text-xs"
                            >
                                {opt.label}
                            </Button>
                        ))}
                    </div>
                </div>
            </div>

            {/* ===== Chart area ===== */}
            {selectedIds.length === 0 ? (
                <div className="border border-dashed border-gray-300 bg-gray-50 p-6 text-center">
                    <Text className="text-sm text-gray-400">
                        No assets selected. Click "+ Add" or "Select all" to begin.
                    </Text>
                </div>
            ) : tsLoading ? (
                <div className="flex h-[400px] items-center justify-center gap-2">
                    <Spinner size="sm" className="text-blue-500" />
                    <Text className="text-sm text-gray-500">Loading price history\u2026</Text>
                </div>
            ) : tsError ? (
                <div className="border border-red-200 bg-red-50 p-4">
                    <Text className="text-sm text-red-600">Error: {tsError}</Text>
                </div>
            ) : chartData.length === 0 ? (
                <div className="bg-gray-50 p-6 text-center">
                    <Text className="text-sm text-gray-400">
                        No price data available for the selected assets.
                    </Text>
                </div>

            ) : (
                <div className="h-[400px]" key={`chart-${zoom}-${selectedIds.join(',')}`}>
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
                                    <Text className="mb-1 block text-xs font-bold text-gray-600">
                                        {sorted[0]?.data.xFormatted}
                                    </Text>
                                    {sorted.map(p => {
                                        const val = p.data.y as number;
                                        return (
                                            <div key={p.id} className="flex items-center justify-between gap-3 py-0.5">
                                                <div className="flex min-w-0 items-center gap-1">
                                                    <span
                                                        className="h-2 w-2 shrink-0 rounded-full"
                                                        style={{ backgroundColor: p.seriesColor }}
                                                    />
                                                    <Text className="truncate text-xs">
                                                        {p.seriesId}
                                                    </Text>
                                                </div>
                                                <Text
                                                    className={`shrink-0 text-xs font-bold ${val >= 0 ? 'text-green-600' : 'text-red-600'}`}
                                                >
                                                    {val >= 0 ? '+' : ''}{val.toFixed(1)}%
                                                </Text>
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
    );
};
