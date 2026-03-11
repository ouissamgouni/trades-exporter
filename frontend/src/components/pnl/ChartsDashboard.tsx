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
import { Badge, Box, Flex, Heading, Spinner, Text } from '@chakra-ui/react';
import { FiChevronDown, FiChevronRight } from 'react-icons/fi';
import { usePortfolioTimeline, type ChartFilterParams, type PeriodSummaryResponse, type RangeKey } from '../../hooks/useChartData';
import { DimensionWithCategories, Account } from '../../types';
import type { AssetPnLRow } from './types';
import type { ScorecardSummary, Range } from './TotalReturnScorecard';

// Chart components
import { TimeframeIndicators } from './TotalReturnScorecard';
import { CostBasisVsMarketValueChart } from './CostBasisVsMarketValueChart';
import { AllocationTreemap } from './AllocationTreemap';
import { MarketValuePieChart } from './MarketValuePieChart';
import { AssetPerformanceComparison } from './AssetPerformanceComparison';

type VisualizationMode = 'treemap' | 'pie';
type AccordionPanel = 'cost_basis' | 'benchmark';

interface ChartsDashboardProps {
    versionId: number | null;
    baseCurrency: string;
    dimensions: DimensionWithCategories[];
    accounts: Account[];
    /** Filtered assets with category_ids for category mapping */
    assets: AssetPnLRow[];
    /** P&L filter state to pass through as chart filters */
    selectedAccountIds?: number[];
    selectedCategoryIds?: number[];
    /** Callback when a pie slice is clicked (category filter toggle) */
    onCategoryClick?: (categoryId: number | null) => void;
    /** Callback when a bar item is clicked (asset or category) */
    onItemClick?: (itemId: number, type: 'asset' | 'category') => void;
    /** Shared timeline data from PnLPanel (React Query cached) */
    sharedTimeline?: { data: { points: any[] } | null; isLoading: boolean; error: string | null };
    /** Backend period summary — passed from PnLPanel */
    periodSummaryData?: PeriodSummaryResponse;
    /** Authoritative summary from P&L engine */
    summary?: ScorecardSummary;
    /** Current timeframe range (controlled by PnLPanel) */
    timeframeRange?: Range;
    /** Called when user changes timeframe range */
    onTimeframeRangeChange?: (range: Range) => void;
    /** Callback when an asset is clicked */
    onAssetClick?: (assetId: number) => void;
}

export const ChartsDashboard: React.FC<ChartsDashboardProps> = ({
    versionId,
    baseCurrency,
    dimensions,
    accounts,
    assets,
    selectedAccountIds,
    selectedCategoryIds,
    onCategoryClick,
    onItemClick,
    sharedTimeline,
    periodSummaryData,
    summary,
    timeframeRange: controlledRange,
    onTimeframeRangeChange,
    onAssetClick,
}) => {
    // Visualization toggle: Treemap (default) or Pie
    const [vizMode, setVizMode] = useState<VisualizationMode>('treemap');

    // Accordion: only one panel visible at a time (cost_basis default)
    const [openPanel, setOpenPanel] = useState<AccordionPanel>('cost_basis');

    // Local range state as fallback if not controlled
    const [localRange, setLocalRange] = useState<Range>('1m');
    const activeRange = controlledRange ?? localRange;
    const setActiveRange = onTimeframeRangeChange ?? setLocalRange;

    // Build asset_id → category label mapping from assets + dimensions
    const assetCategoryMap = useMemo(() => {
        const catMap = new Map<number, string>();
        for (const dim of dimensions) {
            for (const cat of dim.categories) {
                catMap.set(cat.id, cat.label);
            }
        }
        const result: Record<number, string> = {};
        for (const a of assets) {
            if (a.asset.id != null && a.category_ids?.length) {
                for (const catId of a.category_ids) {
                    if (catMap.has(catId)) {
                        result[a.asset.id] = catMap.get(catId)!;
                        break;
                    }
                }
            }
        }
        return result;
    }, [assets, dimensions]);

    // Use shared timeline from PnLPanel when available, otherwise fetch own
    const timelineParams: ChartFilterParams = {
        granularity: 'daily',
        accountIds: selectedAccountIds?.length ? selectedAccountIds : undefined,
        categoryIds: selectedCategoryIds?.length ? selectedCategoryIds : undefined,
    };
    const ownTimeline = usePortfolioTimeline(versionId, timelineParams, !sharedTimeline);
    const timeline = sharedTimeline ?? ownTimeline;

    const points = timeline.data?.points || [];

    // Period summary performers for the active range
    const rangeData = periodSummaryData?.ranges?.[activeRange as RangeKey];

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
                topPerformers={rangeData?.top_performers}
                flopPerformers={rangeData?.flop_performers}
                onAssetClick={onAssetClick}
                assets={assets}
                dimensions={dimensions}
                accounts={accounts}
            />

            {/* Row 2: Treemap / Pie toggle (full width) */}
            <Box mb={4} mt={4}>
                <Flex justify="space-between" align="center" mb={2}>
                    <Flex gap={1} align="center">
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

                {vizMode === 'treemap' ? (
                    <AllocationTreemap
                        points={points}
                        assetCategoryMap={assetCategoryMap}
                        accounts={accounts}
                        assets={assets}
                        baseCurrency={baseCurrency}
                        isLoading={timeline.isLoading}
                    />
                ) : dimensions.length > 0 ? (
                    <MarketValuePieChart
                        assets={assets}
                        dimensions={dimensions}
                        baseCurrency={baseCurrency}
                        selectedCategoryIds={selectedCategoryIds ?? []}
                        onCategoryClick={(id) => onCategoryClick?.(id)}
                    />
                ) : (
                    <Box p={4} textAlign="center">
                        <Text fontSize="sm" color="gray.400">No dimensions configured for pie chart.</Text>
                    </Box>
                )}
            </Box>

            {/* Row 3: Accordion — Cost Basis | Benchmark (one open at a time) */}
            <Box>
                {/* Accordion header: Cost Basis vs Market Value */}
                <Flex
                    align="center"
                    gap={2}
                    py={2}
                    px={3}
                    cursor="pointer"
                    bg={openPanel === 'cost_basis' ? 'blue.50' : 'gray.50'}
                    borderRadius="md"
                    border="1px solid"
                    borderColor={openPanel === 'cost_basis' ? 'blue.200' : 'gray.200'}
                    onClick={() => setOpenPanel('cost_basis')}
                    _hover={{ bg: openPanel === 'cost_basis' ? 'blue.50' : 'gray.100' }}
                    transition="all 0.15s"
                    mb={openPanel === 'cost_basis' ? 0 : 2}
                    borderBottomRadius={openPanel === 'cost_basis' ? 0 : 'md'}
                >
                    {openPanel === 'cost_basis' ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                    <Heading size="sm" color={openPanel === 'cost_basis' ? 'blue.700' : 'gray.600'}>
                        Cost Basis vs Market Value
                    </Heading>
                </Flex>
                {openPanel === 'cost_basis' && (
                    <Box mb={2}>
                        <CostBasisVsMarketValueChart
                            points={points}
                            baseCurrency={baseCurrency}
                            isLoading={timeline.isLoading}
                        />
                    </Box>
                )}

                {/* Accordion header: Performance Comparison (Benchmark) */}
                <Flex
                    align="center"
                    gap={2}
                    py={2}
                    px={3}
                    cursor="pointer"
                    bg={openPanel === 'benchmark' ? 'blue.50' : 'gray.50'}
                    borderRadius="md"
                    border="1px solid"
                    borderColor={openPanel === 'benchmark' ? 'blue.200' : 'gray.200'}
                    onClick={() => setOpenPanel('benchmark')}
                    _hover={{ bg: openPanel === 'benchmark' ? 'blue.50' : 'gray.100' }}
                    transition="all 0.15s"
                    borderBottomRadius={openPanel === 'benchmark' ? 0 : 'md'}
                >
                    {openPanel === 'benchmark' ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                    <Heading size="sm" color={openPanel === 'benchmark' ? 'blue.700' : 'gray.600'}>
                        Performance Comparison
                    </Heading>
                </Flex>
                {openPanel === 'benchmark' && (
                    <Box mb={2}>
                        <AssetPerformanceComparison
                            versionId={versionId}
                            baseCurrency={baseCurrency}
                            assets={assets}
                            sharedTimeline={sharedTimeline}
                        />
                    </Box>
                )}
            </Box>
        </Box>
    );
};
