/**
 * ChartsDashboard
 *
 * Scrollable grid containing all chart components.
 * Receives shared timeline data from PnLPanel (React Query cached) —
 * no duplicate fetches when switching between Portfolio ↔ Charts tabs.
 *
 * Layout:
 *   Row 1: TimeframeIndicators (full width) — period metrics + best/worst performers
 *   Row 2: Toggle section (full width) — Treemap (default) or Pie
 *   Row 3: Accordion — Cost Basis vs Market Value | Performance Comparison (one at a time)
 */
import React, { useMemo, useState, useCallback } from 'react';
import { Badge, Box, Collapsible, Flex, Spinner, Text } from '@chakra-ui/react';
import { FiChevronDown, FiChevronRight } from 'react-icons/fi';
import { usePortfolioTimeline, type ChartFilterParams, type VersionMetricsResponse, type RangeKey, type GroupBy } from '../../hooks/useChartData';
import { DimensionWithCategories, Account } from '../../types';
import type { AssetPnLRow, AccountBalanceBreakdown } from './types';
import type { ScorecardSummary, Range } from './TotalReturnScorecard';

// Chart components
import { TimeframeIndicators } from './TotalReturnScorecard';
import { CostBasisVsMarketValueChart } from './CostBasisVsMarketValueChart';
import { AllocationTreemap } from './AllocationTreemap';
import { MarketValuePieChart } from './MarketValuePieChart';
import { AssetPerformanceComparison } from './AssetPerformanceComparison';

type VisualizationMode = 'treemap' | 'pie';

interface ChartsDashboardProps {
    versionId: number | null;
    baseCurrency: string;
    dimensions: DimensionWithCategories[];
    accounts: Account[];
    /** Filtered assets with category_ids for category mapping */
    assets: AssetPnLRow[];
    /** Callback when a bar item is clicked (asset or category) */
    onItemClick?: (itemId: number, type: 'asset' | 'category') => void;
    /** Shared timeline data from PnLPanel (React Query cached) */
    sharedTimeline?: { data: { points: any[] } | null; isLoading: boolean; error: string | null };
    /** Backend version metrics — passed from PnLPanel */
    periodSummaryData?: VersionMetricsResponse;
    /** Current performer group-by mode */
    groupBy?: GroupBy;
    /** Called when user changes performer group-by */
    onGroupByChange?: (groupBy: GroupBy) => void;
    /** Authoritative summary from P&L engine */
    summary?: ScorecardSummary;
    /** Current timeframe range (controlled by PnLPanel) */
    timeframeRange?: Range;
    /** Called when user changes timeframe range */
    onTimeframeRangeChange?: (range: Range) => void;
    /** Callback when an asset is clicked */
    onAssetClick?: (assetId: number) => void;
    /** Per-account balance breakdown keyed by asset ID (for treemap account grouping) */
    accountBalances?: Map<number, AccountBalanceBreakdown[]>;
    /** Currently selected dimension ID for performer category grouping */
    performerDimensionId?: number | null;
    /** Called when user selects a performer dimension */
    onPerformerDimensionChange?: (dimensionId: number) => void;
}

export const ChartsDashboard: React.FC<ChartsDashboardProps> = ({
    versionId,
    baseCurrency,
    dimensions,
    accounts,
    assets,
    onItemClick,
    sharedTimeline,
    periodSummaryData,
    groupBy,
    onGroupByChange,
    summary,
    timeframeRange: controlledRange,
    onTimeframeRangeChange,
    onAssetClick,
    accountBalances,
    performerDimensionId,
    onPerformerDimensionChange,
}) => {
    // Visualization toggle: Treemap (default) or Pie
    const [vizMode, setVizMode] = useState<VisualizationMode>('treemap');

    // Accordion: independent open/close for each chart
    const [treemapOpen, setTreemapOpen] = useState(true);
    const [costBasisOpen, setCostBasisOpen] = useState(true);
    const [benchmarkOpen, setBenchmarkOpen] = useState(true);

    // Local range state as fallback if not controlled
    const [localRange, setLocalRange] = useState<Range>('1w');
    const activeRange = controlledRange ?? localRange;
    const setActiveRange = onTimeframeRangeChange ?? setLocalRange;

    // Build per-dimension asset_id → category label maps
    const assetCategoryMaps = useMemo(() => {
        const result: Record<number, Record<number, string>> = {};
        for (const dim of dimensions) {
            const catIdToLabel = new Map<number, string>();
            for (const cat of dim.categories) {
                catIdToLabel.set(cat.id, cat.label);
            }
            const dimMap: Record<number, string> = {};
            for (const a of assets) {
                if (a.asset.id != null && a.category_ids?.length) {
                    for (const catId of a.category_ids) {
                        if (catIdToLabel.has(catId)) {
                            dimMap[a.asset.id] = catIdToLabel.get(catId)!;
                            break;
                        }
                    }
                }
            }
            result[dim.id] = dimMap;
        }
        return result;
    }, [assets, dimensions]);

    // Use shared timeline from PnLPanel when available, otherwise fetch own
    const timelineParams: ChartFilterParams = {
        granularity: 'daily',
    };
    const ownTimeline = usePortfolioTimeline(versionId, timelineParams, !sharedTimeline);
    const timeline = sharedTimeline ?? ownTimeline;

    const points = timeline.data?.points || [];

    if (!versionId) {
        return (
            <Box p={8} textAlign="center">
                <Text color="gray.400">No P&L version selected. Calculate P&L first to see charts.</Text>
            </Box>
        );
    }

    return (
        <Box>
            {/* Loading state */}
            {timeline.isLoading && (
                <Flex justify="center" align="center" py={4} gap={2}>
                    <Spinner size="sm" color="blue.500" />
                    <Text fontSize="sm" color="gray.500">Loading chart data...</Text>
                </Flex>
            )}

            {/* Error state */}
            {timeline.error && (
                <Box bg="red.50" border="1px solid" borderColor="red.200" borderRadius="md" p={3} mb={4}>
                    <Text fontSize="sm" color="red.600">{timeline.error}</Text>
                </Box>
            )}

            {/* Row 1: TimeframeIndicators — period metrics + best/worst performers */}
            <TimeframeIndicators
                points={points}
                baseCurrency={baseCurrency}
                isLoading={timeline.isLoading}
                summary={summary}
                range={activeRange}
                onRangeChange={setActiveRange}
                periodSummaryData={periodSummaryData}
                groupBy={groupBy}
                onGroupByChange={onGroupByChange}
                onAssetClick={onAssetClick}
                dimensions={dimensions}
                selectedDimensionId={performerDimensionId}
                onDimensionChange={onPerformerDimensionChange}
            />

            {/* Row 2: Treemap / Pie — collapsible accordion */}
            <Box border="1px solid" borderColor="gray.200" borderRadius="md" overflow="hidden" mb={2} mt={4}>
                <Flex
                    align="center"
                    gap={2}
                    px={3}
                    py={2}
                    bg={treemapOpen ? 'blue.50' : 'gray.50'}
                    cursor="pointer"
                    _hover={{ bg: treemapOpen ? 'blue.100' : 'gray.100' }}
                    transition="all 0.15s"
                    onClick={() => setTreemapOpen(prev => !prev)}
                    userSelect="none"
                >
                    {treemapOpen ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                    <Text fontSize="sm" fontWeight="semibold" color="gray.700">
                        Allocation
                    </Text>
                    {/* Viz mode toggle inside header */}
                    <Flex gap={1} ml="auto" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                        {(['treemap', 'pie'] as const).map(mode => (
                            <Badge
                                key={mode}
                                cursor="pointer"
                                variant={vizMode === mode ? 'solid' : 'outline'}
                                colorPalette={vizMode === mode ? 'blue' : 'gray'}
                                onClick={() => setVizMode(mode)}
                                size="sm"
                                px={2}
                            >
                                {mode === 'treemap' ? 'Treemap' : 'Pie Chart'}
                            </Badge>
                        ))}
                    </Flex>
                </Flex>
                <Collapsible.Root open={treemapOpen}>
                    <Collapsible.Content>
                        <Box>
                            {vizMode === 'treemap' ? (
                                <AllocationTreemap
                                    points={points}
                                    dimensions={dimensions}
                                    assetCategoryMaps={assetCategoryMaps}
                                    accounts={accounts}
                                    assets={assets}
                                    baseCurrency={baseCurrency}
                                    isLoading={timeline.isLoading}
                                    accountBalances={accountBalances}
                                />
                            ) : dimensions.length > 0 ? (
                                <MarketValuePieChart
                                    assets={assets}
                                    dimensions={dimensions}
                                    baseCurrency={baseCurrency}
                                />
                            ) : (
                                <Box p={4} textAlign="center">
                                    <Text fontSize="sm" color="gray.400">No dimensions configured for pie chart.</Text>
                                </Box>
                            )}
                        </Box>
                    </Collapsible.Content>
                </Collapsible.Root>
            </Box>

            {/* Row 3: Independent horizontal accordions for each chart */}
            <Flex direction="column" gap={2}>
                {/* Cost Basis vs Market Value */}
                <Box border="1px solid" borderColor="gray.200" borderRadius="md" overflow="hidden">
                    <Flex
                        align="center"
                        gap={2}
                        px={3}
                        py={2}
                        bg={costBasisOpen ? 'blue.50' : 'gray.50'}
                        cursor="pointer"
                        _hover={{ bg: costBasisOpen ? 'blue.100' : 'gray.100' }}
                        transition="all 0.15s"
                        onClick={() => setCostBasisOpen(prev => !prev)}
                        userSelect="none"
                    >
                        {costBasisOpen ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                        <Text fontSize="sm" fontWeight="semibold" color="gray.700">
                            Cost Basis vs Market Value
                        </Text>
                    </Flex>
                    <Collapsible.Root open={costBasisOpen}>
                        <Collapsible.Content>
                            <Box>
                                <CostBasisVsMarketValueChart
                                    points={points}
                                    baseCurrency={baseCurrency}
                                    isLoading={timeline.isLoading}
                                />
                            </Box>
                        </Collapsible.Content>
                    </Collapsible.Root>
                </Box>

                {/* Performance Comparison */}
                <Box border="1px solid" borderColor="gray.200" borderRadius="md" overflow="hidden">
                    <Flex
                        align="center"
                        gap={2}
                        px={3}
                        py={2}
                        bg={benchmarkOpen ? 'blue.50' : 'gray.50'}
                        cursor="pointer"
                        _hover={{ bg: benchmarkOpen ? 'blue.100' : 'gray.100' }}
                        transition="all 0.15s"
                        onClick={() => setBenchmarkOpen(prev => !prev)}
                        userSelect="none"
                    >
                        {benchmarkOpen ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                        <Text fontSize="sm" fontWeight="semibold" color="gray.700">
                            Performance Comparison
                        </Text>
                    </Flex>
                    <Collapsible.Root open={benchmarkOpen}>
                        <Collapsible.Content>
                            <Box>
                                <AssetPerformanceComparison
                                    versionId={versionId}
                                    baseCurrency={baseCurrency}
                                    assets={assets}
                                    sharedTimeline={sharedTimeline}
                                />
                            </Box>
                        </Collapsible.Content>
                    </Collapsible.Root>
                </Box>
            </Flex>
        </Box>
    );
};
