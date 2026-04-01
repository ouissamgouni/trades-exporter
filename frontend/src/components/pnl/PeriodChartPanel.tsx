/**
 * PeriodChartPanel
 *
 * Wrapper for the inline chart shown next to best/worst performers.
 * Toggles between Performance (rebased) and Cost vs Market Value.
 * Auto-syncs to the selected period range.
 * Includes a fullscreen button that opens a modal with zoom controls.
 */
import React, { useState } from 'react';
import { Badge, Box, Flex, Text } from '@chakra-ui/react';
import { FiMaximize2 } from 'react-icons/fi';
import type { TimelinePoint } from '../../hooks/useChartData';
import type { Range } from './TotalReturnScorecard';
import type { AssetPnLRow } from './types';
import { rangeToZoom, type ZoomPreset } from './chartUtils';
import { PortfolioPerformanceChart } from './PortfolioPerformanceChart';
import { CostBasisVsMarketValueChart } from './CostBasisVsMarketValueChart';
import { AssetPerformanceComparison } from './AssetPerformanceComparison';
import { ChartFullscreenModal } from './ChartFullscreenModal';

type ChartMode = 'performance' | 'cost-vs-value';

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
}

export const PeriodChartPanel: React.FC<PeriodChartPanelProps> = ({
    points,
    baseCurrency,
    range,
    isLoading,
    versionId,
    assets,
    contextLabel,
}) => {
    const [chartMode, setChartMode] = useState<ChartMode>('performance');
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [fsZoom, setFsZoom] = useState<ZoomPreset>(rangeToZoom(range));

    // Sync fullscreen zoom when period changes
    const periodZoom = rangeToZoom(range);

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
                        {([['performance', 'Performance'], ['cost-vs-value', 'Cost vs Value']] as [ChartMode, string][]).map(([mode, label]) => (
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

                {/* Chart (compact, no controls) */}
                {chartMode === 'performance' ? (
                    <PortfolioPerformanceChart
                        points={points}
                        baseCurrency={baseCurrency}
                        isLoading={isLoading}
                        zoom={periodZoom}
                        hideControls
                        height="200px"
                        contextLabel={contextLabel}
                    />
                ) : (
                    <CostBasisVsMarketValueChart
                        points={points}
                        baseCurrency={baseCurrency}
                        isLoading={isLoading}
                        zoom={periodZoom}
                        hideControls
                        height="200px"
                        contextLabel={contextLabel}
                    />
                )}
            </Box>

            {/* Fullscreen modal */}
            <ChartFullscreenModal
                isOpen={isFullscreen}
                onClose={() => setIsFullscreen(false)}
                title={contextLabel
                    ? `${contextLabel} — ${chartMode === 'performance' ? 'Performance (Rebased)' : 'Cost Basis vs Market Value'}`
                    : chartMode === 'performance' ? 'Performance (Rebased)' : 'Cost Basis vs Market Value'}
            >
                {/* Mode toggle + zoom badges */}
                <Flex justify="space-between" align="center" mb={3} wrap="wrap" gap={2}>
                    <Flex gap={1}>
                        {([['performance', 'Performance'], ['cost-vs-value', 'Cost vs Value']] as [ChartMode, string][]).map(([mode, label]) => (
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
                ) : (
                    <CostBasisVsMarketValueChart
                        points={points}
                        baseCurrency={baseCurrency}
                        isLoading={isLoading}
                        zoom={fsZoom}
                        onZoomChange={setFsZoom}
                        height="calc(90vh - 200px)"
                        contextLabel={contextLabel}
                    />
                )}
            </ChartFullscreenModal>
        </>
    );
};
