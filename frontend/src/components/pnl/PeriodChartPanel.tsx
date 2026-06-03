/**
 * PeriodChartPanel
 *
 * Wrapper for the inline chart shown next to best/worst performers.
 * Toggles between Performance (rebased) and Cost vs Market Value.
 * Auto-syncs to the selected period range.
 * Includes a fullscreen button that opens a modal with zoom controls.
 */
import React, { useMemo, useState } from 'react';
import { Badge, Box, Flex, Text } from '@chakra-ui/react';
import { FiAlertTriangle, FiMaximize2 } from 'react-icons/fi';
import type { TimelinePoint } from '../../hooks/useChartData';
import { usePriceGaps } from '../../hooks/usePriceGaps';
import type { Range } from './TotalReturnScorecard';
import type { AssetPnLRow } from './types';
import { rangeToZoom, ZOOM_PRESETS, type ZoomPreset } from './chartUtils';
import { PortfolioPerformanceChart } from './PortfolioPerformanceChart';
import { CostBasisVsMarketValueChart } from './CostBasisVsMarketValueChart';
import { AssetPerformanceComparison } from './AssetPerformanceComparison';
import { ChartFullscreenModal } from './ChartFullscreenModal';
import { GapFixPanel } from '../GapFixPanel';

type ChartMode = 'performance' | 'cost-vs-value' | 'price';

interface PeriodChartPanelProps {
    points: TimelinePoint[];
    baseCurrency: string;
    range: Range;
    isLoading?: boolean;
    /** Version ID needed for fullscreen AssetPerformanceComparison */
    versionId?: number | null;
    /** Assets needed for fullscreen AssetPerformanceComparison */
    assets?: AssetPnLRow[];
    /** Context label (e.g. asset symbol) shown in chart legend & title */
    contextLabel?: string;
    /** Error message from the timeline query */
    error?: string | null;
    /** Asset ID — when set, the "Price" chart tab is shown */
    assetId?: number;
    /** Asset symbol — used as the price chart series label */
    assetSymbol?: string;
}

export const PeriodChartPanel: React.FC<PeriodChartPanelProps> = ({
    points,
    baseCurrency,
    range,
    isLoading,
    versionId,
    assets,
    contextLabel,
    error,
    assetId,
    assetSymbol,
}) => {
    const [chartMode, setChartMode] = useState<ChartMode>('performance');
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [fsZoom, setFsZoom] = useState<ZoomPreset>(rangeToZoom(range));

    // Sync fullscreen zoom when period changes
    const periodZoom = rangeToZoom(range);

    // ── Period date range for gap detection ──
    const periodDateRange = useMemo(() => {
        const days = ZOOM_PRESETS[periodZoom]?.days;
        if (!days) return { dateFrom: undefined, dateTo: undefined };
        const today = new Date();
        const from = new Date(today);
        from.setDate(from.getDate() - days);
        return {
            dateFrom: from.toISOString().split('T')[0],
            dateTo: today.toISOString().split('T')[0],
        };
    }, [periodZoom]);

    // ── Price gap detection (single-asset, period-scoped) ──
    const gapQuery = usePriceGaps(
        assetId ?? null,
        periodDateRange.dateFrom,
        periodDateRange.dateTo,
        assetId != null,
    );
    const periodGapCount = gapQuery.data?.gaps?.length ?? 0;

    /** Build the list of available chart modes */
    const modes: [ChartMode, string][] = [
        ['performance', 'Performance'],
        ['cost-vs-value', 'Cost vs Value'],
        ...(assetId != null ? [['price', 'Price'] as [ChartMode, string]] : []),
    ];

    const handleOpenFullscreen = () => {
        setFsZoom(periodZoom);
        setIsFullscreen(true);
    };

    return (
        <>
            {/* Inline chart */}
            <Box position="relative">
                {/* Header: toggle + fullscreen */}
                <Flex justify="space-between" align="center" mb={1}>
                    <Flex gap={0.5}>
                        {modes.map(([mode, label]) => (
                            <Badge
                                key={mode}
                                cursor="pointer"
                                variant={chartMode === mode ? 'solid' : 'outline'}
                                colorPalette={chartMode === mode ? 'blue' : 'gray'}
                                size="xs"
                                px={1.5}
                                onClick={() => setChartMode(mode)}
                            >
                                {label}
                            </Badge>
                        ))}
                    </Flex>
                    <Box
                        cursor="pointer"
                        color="gray.400"
                        _hover={{ color: 'blue.500' }}
                        onClick={handleOpenFullscreen}
                        title="Fullscreen"
                    >
                        <FiMaximize2 size={12} />
                    </Box>
                </Flex>

                {/* Error state */}
                {error && chartMode !== 'price' ? (
                    <Flex align="center" justify="center" h="200px" direction="column" gap={1}>
                        <FiAlertTriangle size={16} color="var(--chakra-colors-red-400)" />
                        <Text fontSize="xs" color="red.500">Failed to load chart data</Text>
                        <Text fontSize="xs" color="red.400">{error}</Text>
                    </Flex>
                ) : !isLoading && points.length === 0 && chartMode !== 'price' ? (
                    <Flex align="center" justify="center" h="200px" direction="column" gap={1}>
                        <Text fontSize="xs" color="gray.400">No chart data available for this period</Text>
                    </Flex>
                ) : chartMode === 'performance' ? (
                    <PortfolioPerformanceChart
                        points={points}
                        baseCurrency={baseCurrency}
                        isLoading={isLoading}
                        zoom={periodZoom}
                        hideControls
                        height="200px"
                        contextLabel={contextLabel}
                    />
                ) : chartMode === 'cost-vs-value' ? (
                    <CostBasisVsMarketValueChart
                        points={points}
                        baseCurrency={baseCurrency}
                        isLoading={isLoading}
                        zoom={periodZoom}
                        hideControls
                        height="200px"
                        contextLabel={contextLabel}
                    />
                ) : assetId != null && assetSymbol ? (
                    <GapFixPanel assetId={assetId} symbol={assetSymbol} />
                ) : null}

                {/* Period-scoped gap warning (Performance / Cost vs Value tabs only) */}
                {chartMode !== 'price' && assetId != null && periodGapCount > 0 && (
                    <Flex
                        align="center"
                        gap={1}
                        mt={1}
                        px={2}
                        py={1}
                        bg="orange.50"
                        border="1px solid"
                        borderColor="orange.200"
                        borderRadius="sm"
                    >
                        <FiAlertTriangle size={11} color="var(--chakra-colors-orange-500)" />
                        <Text fontSize="2xs" color="orange.700">
                            {periodGapCount} price gap{periodGapCount !== 1 ? 's' : ''} in this period — chart accuracy may be affected.
                        </Text>
                        <Text
                            fontSize="2xs"
                            color="blue.500"
                            cursor="pointer"
                            fontWeight="semibold"
                            _hover={{ textDecoration: 'underline' }}
                            onClick={() => setChartMode('price')}
                        >
                            Fix gaps
                        </Text>
                    </Flex>
                )}
            </Box>

            {/* Fullscreen modal */}
            <ChartFullscreenModal
                isOpen={isFullscreen}
                onClose={() => setIsFullscreen(false)}
                title={contextLabel
                    ? `${contextLabel} — ${chartMode === 'performance' ? 'Performance (Rebased)' : chartMode === 'cost-vs-value' ? 'Cost Basis vs Market Value' : 'Price'}`
                    : chartMode === 'performance' ? 'Performance (Rebased)' : chartMode === 'cost-vs-value' ? 'Cost Basis vs Market Value' : 'Price'}
            >
                {/* Mode toggle + zoom badges */}
                <Flex justify="space-between" align="center" mb={3} wrap="wrap" gap={2}>
                    <Flex gap={1}>
                        {modes.map(([mode, label]) => (
                            <Badge
                                key={mode}
                                cursor="pointer"
                                variant={chartMode === mode ? 'solid' : 'outline'}
                                colorPalette={chartMode === mode ? 'blue' : 'gray'}
                                size="sm"
                                px={2}
                                onClick={() => setChartMode(mode)}
                            >
                                {label}
                            </Badge>
                        ))}
                    </Flex>
                </Flex>

                {/* Full-size chart with own zoom controls */}
                {chartMode === 'performance' ? (
                    versionId != null && assets ? (
                        <AssetPerformanceComparison
                            versionId={versionId}
                            baseCurrency={baseCurrency}
                            assets={assets}
                            sharedTimeline={{
                                data: points.length ? { points } : null,
                                isLoading: !!isLoading,
                                error: null,
                            }}
                            zoom={fsZoom}
                            onZoomChange={setFsZoom}
                            contextLabel={contextLabel}
                        />
                    ) : (
                        <PortfolioPerformanceChart
                            points={points}
                            baseCurrency={baseCurrency}
                            isLoading={isLoading}
                            zoom={fsZoom}
                            onZoomChange={setFsZoom}
                            height="calc(90vh - 200px)"
                            contextLabel={contextLabel}
                        />
                    )
                ) : chartMode === 'cost-vs-value' ? (
                    <CostBasisVsMarketValueChart
                        points={points}
                        baseCurrency={baseCurrency}
                        isLoading={isLoading}
                        zoom={fsZoom}
                        onZoomChange={setFsZoom}
                        height="calc(90vh - 200px)"
                        contextLabel={contextLabel}
                    />
                ) : assetId != null && assetSymbol ? (
                    <GapFixPanel assetId={assetId} symbol={assetSymbol} />
                ) : null}
            </ChartFullscreenModal>
        </>
    );
};
