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
import { Badge, Box, Flex, Heading, Popover, Portal, Spinner, Switch, Text } from '@chakra-ui/react';
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
            <Box p={8} textAlign="center">
                <Text color="gray.400">No P&L version selected. Calculate P&L first to compare assets.</Text>
            </Box>
        );
    }

    // ---- Render ----
    return (
        <Box>
            {/* Card container */}
            <Box p={4} bg="white" borderRadius="md" border="1px solid" borderColor="gray.200">
                {/* Header row */}
                <Flex justify="space-between" align="center" mb={3} wrap="wrap" gap={2}>
                    <Flex align="center" gap={2}>
                        <Heading size="sm" color="gray.700">{contextLabel ? `${contextLabel} — Performance Comparison` : 'Performance Comparison'}</Heading>
                        <Tooltip content="Rebased return comparison: each line starts at 0% on the first visible date. Portfolio ROI = (unrealized + realized) / cost basis — measures actual return on invested capital. Compare against benchmarks (S&P 500, BTC) to assess relative performance. If your portfolio underperforms a benchmark, consider whether the risk you’re taking is justified by the returns." openDelay={200}>
                            <Box color="gray.400" cursor="help" _hover={{ color: 'blue.500' }}>
                                <FiInfo size={14} />
                            </Box>
                        </Tooltip>
                    </Flex>
                    <Flex gap={2} align="center" wrap="wrap">
                        {/* Scale mode */}
                        <Flex gap={1}>
                            {(['auto', 'full'] as const).map(mode => (
                                <Badge
                                    key={mode}
                                    cursor="pointer"
                                    variant={scaleMode === mode ? 'solid' : 'outline'}
                                    colorPalette={scaleMode === mode ? 'teal' : 'gray'}
                                    onClick={() => setScaleMode(mode)}
                                    size="sm"
                                    px={2}
                                >
                                    {mode === 'auto' ? 'Auto' : 'Full'}
                                </Badge>
                            ))}
                            {scaleMode === 'auto' && clippedCount > 0 && (
                                <Text fontSize="xs" color="gray.400" alignSelf="center">
                                    {clippedCount} clipped
                                </Text>
                            )}
                        </Flex>
                        {/* Zoom presets */}
                        <Flex gap={1}>
                            {(Object.keys(ZOOM_PRESETS) as ZoomPreset[]).map(k => (
                                <Badge
                                    key={k}
                                    cursor="pointer"
                                    variant={zoom === k ? 'solid' : 'outline'}
                                    colorPalette={zoom === k ? 'purple' : 'gray'}
                                    onClick={() => setZoom(k)}
                                    size="sm"
                                    px={2}
                                >
                                    {ZOOM_PRESETS[k].label}
                                </Badge>
                            ))}
                        </Flex>
                    </Flex>
                </Flex>

                {/* Controls row */}
                <Flex gap={4} align="center" mb={3} wrap="wrap">
                    {/* Asset picker */}
                    <Box flex={1} minW="200px">
                        <AssetComparisonPicker
                            assets={assets}
                            selectedIds={selectedIds}
                            onChange={setSelectedIds}
                            maxSelections={10}
                        />
                    </Box>

                    {/* Benchmark multiselect dropdown */}
                    <Popover.Root
                        positioning={{ placement: 'bottom-start' }}
                        lazyMount
                        unmountOnExit
                    >
                        <Popover.Trigger asChild>
                            <Flex
                                align="center"
                                gap={1}
                                px={2}
                                py={1}
                                border="1px solid"
                                borderColor="gray.200"
                                borderRadius="md"
                                cursor="pointer"
                                _hover={{ borderColor: 'gray.400' }}
                                transition="all 0.15s"
                                flexShrink={0}
                            >
                                <Text fontSize="xs" color="gray.500" whiteSpace="nowrap">
                                    Benchmarks{benchmarkTickers.length > 0 ? ` (${benchmarkTickers.length})` : ''}
                                </Text>
                                <FiChevronDown size={12} />
                                {anyBenchmarkLoading && <Spinner size="xs" color="yellow.500" />}
                            </Flex>
                        </Popover.Trigger>
                        <Portal>
                            <Popover.Positioner>
                                <Popover.Content width="200px" p={2} shadow="lg" bg="white" borderWidth={1} borderColor="gray.200">
                                    <Flex direction="column" gap={1}>
                                        {BENCHMARK_PRESETS.map(bp => {
                                            const isActive = benchmarkTickers.includes(bp.ticker);
                                            return (
                                                <Flex
                                                    key={bp.ticker}
                                                    align="center"
                                                    gap={2}
                                                    px={2}
                                                    py={1}
                                                    borderRadius="sm"
                                                    cursor="pointer"
                                                    bg={isActive ? 'yellow.50' : 'transparent'}
                                                    _hover={{ bg: isActive ? 'yellow.100' : 'gray.50' }}
                                                    onClick={() =>
                                                        setBenchmarkTickers(prev =>
                                                            prev.includes(bp.ticker)
                                                                ? prev.filter(t => t !== bp.ticker)
                                                                : [...prev, bp.ticker]
                                                        )
                                                    }
                                                >
                                                    <Box
                                                        w="14px"
                                                        h="14px"
                                                        borderRadius="sm"
                                                        border="1.5px solid"
                                                        borderColor={isActive ? 'yellow.500' : 'gray.300'}
                                                        bg={isActive ? 'yellow.500' : 'transparent'}
                                                        display="flex"
                                                        alignItems="center"
                                                        justifyContent="center"
                                                        flexShrink={0}
                                                    >
                                                        {isActive && (
                                                            <Text fontSize="2xs" color="white" lineHeight={1}>✓</Text>
                                                        )}
                                                    </Box>
                                                    <Text fontSize="xs" color="gray.700">{bp.label}</Text>
                                                </Flex>
                                            );
                                        })}
                                    </Flex>
                                </Popover.Content>
                            </Popover.Positioner>
                        </Portal>
                    </Popover.Root>

                    {/* Portfolio toggle */}
                    <Flex align="center" gap={2} flexShrink={0}>
                        <Switch.Root
                            size="sm"
                            checked={showPortfolio}
                            onCheckedChange={(e) => setShowPortfolio(e.checked)}
                        >
                            <Switch.HiddenInput />
                            <Switch.Control>
                                <Switch.Thumb />
                            </Switch.Control>
                        </Switch.Root>
                        <Text fontSize="xs" color="gray.500" whiteSpace="nowrap">Portfolio</Text>
                    </Flex>
                </Flex>

                {/* Unified badge bar — all selected items with color dot + remove */}
                <Flex gap={1.5} mb={2} wrap="wrap" align="center">
                    {/* Portfolio badge */}
                    {showPortfolio && (
                        <Popover.Root
                            open={colorPopoverKey === 'portfolio'}
                            onOpenChange={(e) => setColorPopoverKey(e.open ? 'portfolio' : null)}
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
                                        bg={portfolioColor}
                                        flexShrink={0}
                                    />
                                    <Text fontSize="xs">{portfolioRoiLabel}</Text>
                                </Badge>
                            </Popover.Trigger>
                            <Portal>
                                <Popover.Positioner>
                                    <Popover.Content width="auto" p={2} shadow="md" bg="white" borderWidth={1} borderColor="gray.200">
                                        <Flex gap={1} wrap="wrap" maxW="140px">
                                            {PORTFOLIO_COLOR_PRESETS.map(c => (
                                                <Box
                                                    key={c}
                                                    w="16px"
                                                    h="16px"
                                                    borderRadius="full"
                                                    bg={c}
                                                    cursor="pointer"
                                                    border="2px solid"
                                                    borderColor={portfolioColor === c ? 'gray.700' : 'transparent'}
                                                    onClick={() => { setPortfolioColor(c); setColorPopoverKey(null); }}
                                                    _hover={{ transform: 'scale(1.2)' }}
                                                    transition="all 0.15s"
                                                />
                                            ))}
                                        </Flex>
                                    </Popover.Content>
                                </Popover.Positioner>
                            </Portal>
                        </Popover.Root>
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
                                                setSelectedIds(prev => prev.filter(x => x !== id));
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
                                                        onClick={() => { setColorOverrides(prev => ({ ...prev, [id]: c })); setColorPopoverKey(null); }}
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

                    {/* Benchmark badges */}
                    {benchmarkTickers.map((ticker, idx) => {
                        const preset = BENCHMARK_PRESETS.find(b => b.ticker === ticker);
                        if (!preset) return null;
                        const currentColor = benchmarkColorOverrides[ticker]
                            ?? BENCHMARK_COLORS[idx % BENCHMARK_COLORS.length];
                        const popKey = `bench-${ticker}`;
                        return (
                            <Popover.Root
                                key={ticker}
                                open={colorPopoverKey === popKey}
                                onOpenChange={(e) => setColorPopoverKey(e.open ? popKey : null)}
                                positioning={{ placement: 'bottom' }}
                                lazyMount
                                unmountOnExit
                            >
                                <Popover.Trigger asChild>
                                    <Badge
                                        variant="outline"
                                        colorPalette="yellow"
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
                                        <Text fontSize="xs">{preset.label}</Text>
                                        <Box
                                            as="span"
                                            ml={0.5}
                                            color="gray.400"
                                            _hover={{ color: 'red.500' }}
                                            onClick={(e: React.MouseEvent) => {
                                                e.stopPropagation();
                                                setBenchmarkTickers(prev => prev.filter(t => t !== ticker));
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
                                                {[...BENCHMARK_COLORS, ...COMPARISON_PALETTE.slice(0, 4)].map(c => (
                                                    <Box
                                                        key={c}
                                                        w="16px"
                                                        h="16px"
                                                        borderRadius="full"
                                                        bg={c}
                                                        cursor="pointer"
                                                        border="2px solid"
                                                        borderColor={currentColor === c ? 'gray.700' : 'transparent'}
                                                        onClick={() => { setBenchmarkColorOverrides(prev => ({ ...prev, [ticker]: c })); setColorPopoverKey(null); }}
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
                </Flex>

                {/* Error states */}
                {timeline.error && (
                    <Box bg="red.50" border="1px solid" borderColor="red.200" borderRadius="md" p={2} mb={3}>
                        <Text fontSize="xs" color="red.600">Timeline error: {timeline.error}</Text>
                    </Box>
                )}
                {benchmarkErrors.length > 0 && (
                    <Box bg="yellow.50" border="1px solid" borderColor="yellow.200" borderRadius="md" p={2} mb={3}>
                        {benchmarkErrors.map((e, i) => (
                            <Text key={i} fontSize="xs" color="yellow.700">Benchmark: {e}</Text>
                        ))}
                    </Box>
                )}

                {/* Chart area */}
                {timeline.isLoading ? (
                    <Box h="400px" display="flex" alignItems="center" justifyContent="center" gap={2}>
                        <Spinner size="sm" color="blue.500" />
                        <Text fontSize="sm" color="gray.400">Loading timeline data...</Text>
                    </Box>
                ) : chartData.length === 0 ? (
                    <Box h="400px" display="flex" alignItems="center" justifyContent="center">
                        <Text fontSize="sm" color="gray.400">
                            Select assets to compare their performance.
                        </Text>
                    </Box>
                ) : (
                    <Box h="400px" key={`chart-${zoom}-${selectedIds.join(',')}-${benchmarkTickers.join(',')}`}>
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
                                            const isBenchmark = benchmarkSeriesIds.has(p.seriesId as string);
                                            return (
                                                <Flex key={p.id} justify="space-between" gap={3} py={0.5}>
                                                    <Flex align="center" gap={1} minW={0}>
                                                        <Box
                                                            w="8px"
                                                            h="8px"
                                                            borderRadius="full"
                                                            bg={p.seriesColor}
                                                            flexShrink={0}
                                                            border={isBenchmark ? '1px dashed' : undefined}
                                                            borderColor={isBenchmark ? 'gray.400' : undefined}
                                                        />
                                                        <Text
                                                            fontSize="xs"
                                                            fontStyle={isBenchmark ? 'italic' : undefined}
                                                            truncate
                                                        >
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
        </Box>
    );
};
