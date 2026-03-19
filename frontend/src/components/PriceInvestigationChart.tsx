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
import {
    Badge, Box, Button, Flex, Input, Popover, Portal, Spinner, Text,
} from '@chakra-ui/react';
import { FiX, FiPlus } from 'react-icons/fi';
import { ResponsiveLine } from '@nivo/line';
import { usePriceHealth, usePriceTimeseries } from '../hooks/usePriceHealth';
import type { PriceHealthRow } from '../types';

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
    const { data: healthData, isLoading: healthLoading } = usePriceHealth();
    const { data: tsData, isLoading: tsLoading, error: tsError } = usePriceTimeseries(
        { assetIds: selectedIds },
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
            <Box textAlign="center" py={10}>
                <Spinner size="xl" color="blue.500" />
                <Text mt={4}>Loading asset list...</Text>
            </Box>
        );
    }

    if (!healthData || healthData.items.length === 0) {
        return (
            <Box textAlign="center" py={10} bg="gray.50" borderRadius="md">
                <Text color="gray.500">No price data available. Import some prices first.</Text>
            </Box>
        );
    }

    const atMax = selectedIds.length >= MAX_ASSETS;

    return (
        <Box>
            {/* ===== Badge bar: selected assets with color pickers + Add button ===== */}
            <Flex wrap="wrap" gap={1.5} align="center" mb={3}>
                {/* Add button + search dropdown */}
                <Box position="relative">
                    <Badge
                        variant={atMax ? 'subtle' : 'outline'}
                        size="sm"
                        px={2}
                        py={1}
                        borderRadius="full"
                        cursor={atMax ? 'not-allowed' : 'pointer'}
                        opacity={atMax ? 0.5 : 1}
                        display="flex"
                        alignItems="center"
                        gap={1}
                        onClick={() => {
                            if (!atMax) {
                                setPickerOpen(prev => !prev);
                                setTimeout(() => pickerInputRef.current?.focus(), 50);
                            }
                        }}
                    >
                        <Box as={FiPlus} fontSize="10px" />
                        <Text fontSize="xs">{atMax ? `Max ${MAX_ASSETS}` : 'Add'}</Text>
                    </Badge>

                    {pickerOpen && !atMax && (
                        <Box
                            position="absolute"
                            top="100%"
                            left={0}
                            mt={1}
                            zIndex={20}
                            bg="white"
                            border="1px solid"
                            borderColor="gray.200"
                            borderRadius="md"
                            boxShadow="lg"
                            w="240px"
                            maxH="260px"
                            overflow="hidden"
                        >
                            <Box p={2} borderBottom="1px solid" borderColor="gray.100">
                                <Input
                                    ref={pickerInputRef}
                                    size="sm"
                                    placeholder="Search assets..."
                                    value={pickerSearch}
                                    onChange={e => setPickerSearch(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === 'Escape') {
                                            setPickerOpen(false);
                                            setPickerSearch('');
                                        }
                                    }}
                                />
                            </Box>
                            <Box maxH="200px" overflowY="auto">
                                {filteredOptions.length === 0 ? (
                                    <Text fontSize="xs" color="gray.400" p={3} textAlign="center">
                                        {selectedIds.length === healthData.items.length
                                            ? 'All assets already selected'
                                            : 'No assets found'}
                                    </Text>
                                ) : (
                                    filteredOptions.map(r => (
                                        <Flex
                                            key={r.asset_id}
                                            px={3}
                                            py={1.5}
                                            align="center"
                                            gap={2}
                                            cursor="pointer"
                                            _hover={{ bg: 'blue.50' }}
                                            onClick={() => handleAdd(r.asset_id)}
                                        >
                                            <Text fontSize="xs" fontWeight="medium" flex={1}>
                                                {r.symbol}
                                            </Text>
                                            {r.label && r.label !== r.symbol && (
                                                <Text fontSize="xs" color="gray.400" truncate maxW="100px">
                                                    {r.label}
                                                </Text>
                                            )}
                                        </Flex>
                                    ))
                                )}
                            </Box>
                        </Box>
                    )}
                </Box>

                {/* Click-away layer for picker */}
                {pickerOpen && (
                    <Box
                        position="fixed"
                        inset={0}
                        zIndex={19}
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
                        <Popover.Root
                            key={id}
                            open={colorPopoverKey === popKey}
                            onOpenChange={(e) => setColorPopoverKey(e.open ? popKey : null)}
                            positioning={{ placement: 'bottom' }}
                            lazyMount
                            unmountOnExit
                        >
                            <Popover.Trigger asChild>
                                <Badge
                                    variant="outline"
                                    colorPalette="gray"
                                    size="sm"
                                    px={2}
                                    cursor="pointer"
                                    display="flex"
                                    alignItems="center"
                                    gap={1}
                                >
                                    <Box
                                        w="8px"
                                        h="8px"
                                        borderRadius="full"
                                        bg={currentColor}
                                        flexShrink={0}
                                    />
                                    <Text fontSize="xs">{label}</Text>
                                    <Box
                                        as="span"
                                        ml={0.5}
                                        color="gray.400"
                                        _hover={{ color: 'red.500' }}
                                        onClick={(e: React.MouseEvent) => {
                                            e.stopPropagation();
                                            handleRemove(id);
                                        }}
                                    >
                                        <FiX size={10} />
                                    </Box>
                                </Badge>
                            </Popover.Trigger>
                            <Portal>
                                <Popover.Positioner>
                                    <Popover.Content width="auto" p={2} shadow="md" bg="white" borderWidth={1} borderColor="gray.200">
                                        <Flex gap={1} wrap="wrap" maxW="140px">
                                            {COMPARISON_PALETTE.map(c => (
                                                <Box
                                                    key={c}
                                                    w="16px"
                                                    h="16px"
                                                    borderRadius="full"
                                                    bg={c}
                                                    cursor="pointer"
                                                    border="2px solid"
                                                    borderColor={currentColor === c ? 'gray.700' : 'transparent'}
                                                    onClick={() => {
                                                        setColorOverrides(prev => ({ ...prev, [id]: c }));
                                                        setColorPopoverKey(null);
                                                    }}
                                                    _hover={{ transform: 'scale(1.2)' }}
                                                    transition="all 0.15s"
                                                />
                                            ))}
                                        </Flex>
                                    </Popover.Content>
                                </Popover.Positioner>
                            </Portal>
                        </Popover.Root>
                    );
                })}

                {/* Quick actions */}
                {selectedIds.length > 0 && (
                    <Button
                        size="2xs"
                        variant="ghost"
                        color="gray.400"
                        onClick={() => setSelectedIds([])}
                        ml={1}
                    >
                        Clear all
                    </Button>
                )}
                {selectedIds.length < healthData.items.length && (
                    <Button
                        size="2xs"
                        variant="ghost"
                        color="gray.400"
                        onClick={() => setSelectedIds(healthData.items.map(r => r.asset_id).slice(0, MAX_ASSETS))}
                        ml={selectedIds.length > 0 ? 0 : 1}
                    >
                        Select all
                    </Button>
                )}
            </Flex>

            {/* ===== Controls: Zoom + Scale ===== */}
            <Flex gap={2} mb={3} align="center" justify="space-between" flexWrap="wrap">
                <Text fontSize="xs" color="gray.500">
                    {selectedIds.length} of {healthData.items.length} assets
                    {tsLoading && ' \u00b7 Loading chart\u2026'}
                </Text>
                <Flex gap={2} align="center">
                    {/* Zoom presets */}
                    <Flex
                        borderRadius="md"
                        border="1px solid"
                        borderColor="gray.200"
                        overflow="hidden"
                        display="inline-flex"
                    >
                        {(Object.entries(ZOOM_PRESETS) as [ZoomPreset, { label: string }][]).map(
                            ([key, { label }]) => (
                                <Button
                                    key={key}
                                    size="2xs"
                                    variant={zoom === key ? 'solid' : 'ghost'}
                                    colorPalette={zoom === key ? 'blue' : 'gray'}
                                    borderRadius="0"
                                    onClick={() => setZoom(key)}
                                    px={2}
                                    fontSize="xs"
                                >
                                    {label}
                                </Button>
                            ),
                        )}
                    </Flex>
                    {/* Scale mode */}
                    <Flex
                        borderRadius="md"
                        border="1px solid"
                        borderColor="gray.200"
                        overflow="hidden"
                        display="inline-flex"
                    >
                        {([
                            { value: 'auto', label: 'Auto' },
                            { value: 'full', label: 'Full' },
                        ] as const).map(opt => (
                            <Button
                                key={opt.value}
                                size="2xs"
                                variant={scaleMode === opt.value ? 'solid' : 'ghost'}
                                colorPalette={scaleMode === opt.value ? 'gray' : 'gray'}
                                borderRadius="0"
                                onClick={() => setScaleMode(opt.value)}
                                px={2}
                                fontSize="xs"
                            >
                                {opt.label}
                            </Button>
                        ))}
                    </Flex>
                </Flex>
            </Flex>

            {/* ===== Chart area ===== */}
            {selectedIds.length === 0 ? (
                <Box p={6} textAlign="center" bg="gray.50" borderRadius="md" border="1px dashed" borderColor="gray.300">
                    <Text color="gray.400" fontSize="sm">
                        No assets selected. Click "+ Add" or "Select all" to begin.
                    </Text>
                </Box>
            ) : tsLoading ? (
                <Box h="400px" display="flex" alignItems="center" justifyContent="center" gap={2}>
                    <Spinner size="sm" color="blue.500" />
                    <Text fontSize="sm" color="gray.500">Loading price history\u2026</Text>
                </Box>
            ) : tsError ? (
                <Box p={4} bg="red.50" borderRadius="md" border="1px solid" borderColor="red.200">
                    <Text fontSize="sm" color="red.600">Error: {tsError}</Text>
                </Box>
            ) : chartData.length === 0 ? (
                <Box p={6} textAlign="center" bg="gray.50" borderRadius="md">
                    <Text color="gray.400" fontSize="sm">
                        No price data available for the selected assets.
                    </Text>
                </Box>
            ) : (
                <Box h="400px" key={`chart-${zoom}-${selectedIds.join(',')}`}>
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
                                <Box
                                    bg="white"
                                    p={2}
                                    borderRadius="md"
                                    boxShadow="md"
                                    border="1px solid"
                                    borderColor="gray.200"
                                    minW="200px"
                                    maxW="280px"
                                >
                                    <Text fontSize="xs" fontWeight="bold" color="gray.600" mb={1}>
                                        {sorted[0]?.data.xFormatted}
                                    </Text>
                                    {sorted.map(p => {
                                        const val = p.data.y as number;
                                        return (
                                            <Flex key={p.id} justify="space-between" gap={3} py={0.5}>
                                                <Flex align="center" gap={1} minW={0}>
                                                    <Box
                                                        w="8px"
                                                        h="8px"
                                                        borderRadius="full"
                                                        bg={p.seriesColor}
                                                        flexShrink={0}
                                                    />
                                                    <Text fontSize="xs" truncate>
                                                        {p.seriesId}
                                                    </Text>
                                                </Flex>
                                                <Text
                                                    fontSize="xs"
                                                    fontWeight="bold"
                                                    color={val >= 0 ? 'green.600' : 'red.600'}
                                                    flexShrink={0}
                                                >
                                                    {val >= 0 ? '+' : ''}{val.toFixed(1)}%
                                                </Text>
                                            </Flex>
                                        );
                                    })}
                                </Box>
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
                </Box>
            )}
        </Box>
    );
};
