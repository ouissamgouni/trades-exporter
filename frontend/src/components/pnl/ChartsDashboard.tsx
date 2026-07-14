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
import { FiChevronDown, FiChevronRight } from 'react-icons/fi';
import { Badge, Spinner } from '../ui/primitives';
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
            <div className="p-8 text-center">
                <span className="text-slate-400">No P&L version selected. Calculate P&L first to see charts.</span>
            </div>
        );
    }

    return (
        <div>
            {/* Loading state */}
            {timeline.isLoading && (
                <div className="flex items-center justify-center gap-2 py-4">
                    <Spinner size="sm" className="text-blue-500" />
                    <span className="text-sm text-slate-500">Loading chart data...</span>
                </div>
            )}

            {/* Error state */}
            {timeline.error && (
                <div className="mb-4 border border-red-200 bg-red-50 p-3">
                    <span className="text-sm text-red-600">{timeline.error}</span>
                </div>
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
            <div className="mb-2 mt-4 overflow-hidden border border-slate-200">
                <div
                    className={`flex select-none items-center gap-2 px-3 py-2 transition-colors cursor-pointer ${treemapOpen ? 'bg-blue-50 hover:bg-blue-100' : 'bg-slate-50 hover:bg-slate-100'
                        }`}
                    onClick={() => setTreemapOpen(prev => !prev)}
                >
                    {treemapOpen ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                    <span className="text-sm font-semibold text-slate-700">
                        Allocation
                    </span>
                    {/* Viz mode toggle inside header */}
                    <div className="ml-auto flex gap-1" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                        {(['treemap', 'pie'] as const).map(mode => (
                            <Badge
                                key={mode}
                                className={`cursor-pointer px-2 ${vizMode === mode
                                    ? 'bg-blue-500 text-white'
                                    : 'border border-slate-300 bg-white text-slate-700'
                                    }`}
                                onClick={() => setVizMode(mode)}
                            >
                                {mode === 'treemap' ? 'Treemap' : 'Pie Chart'}
                            </Badge>
                        ))}
                    </div>
                </div>
                {treemapOpen && (
                    <div>
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
                            <div className="p-4 text-center">
                                <span className="text-sm text-slate-400">No dimensions configured for pie chart.</span>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Row 3: Independent horizontal accordions for each chart */}
            <div className="flex flex-col gap-2">
                {/* Cost Basis vs Market Value */}
                <div className="overflow-hidden border border-slate-200">
                    <div
                        className={`flex select-none items-center gap-2 px-3 py-2 transition-colors cursor-pointer ${costBasisOpen ? 'bg-blue-50 hover:bg-blue-100' : 'bg-slate-50 hover:bg-slate-100'
                            }`}
                        onClick={() => setCostBasisOpen(prev => !prev)}
                    >
                        {costBasisOpen ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                        <span className="text-sm font-semibold text-slate-700">
                            Cost Basis vs Market Value
                        </span>
                    </div>
                    {costBasisOpen && (
                        <div>
                            <CostBasisVsMarketValueChart
                                points={points}
                                baseCurrency={baseCurrency}
                                isLoading={timeline.isLoading}
                            />
                        </div>
                    )}
                </div>

                {/* Performance Comparison */}
                <div className="overflow-hidden border border-slate-200">
                    <div
                        className={`flex select-none items-center gap-2 px-3 py-2 transition-colors cursor-pointer ${benchmarkOpen ? 'bg-blue-50 hover:bg-blue-100' : 'bg-slate-50 hover:bg-slate-100'
                            }`}
                        onClick={() => setBenchmarkOpen(prev => !prev)}
                    >
                        {benchmarkOpen ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                        <span className="text-sm font-semibold text-slate-700">
                            Performance Comparison
                        </span>
                    </div>
                    {benchmarkOpen && (
                        <div>
                            <AssetPerformanceComparison
                                versionId={versionId}
                                baseCurrency={baseCurrency}
                                assets={assets}
                                sharedTimeline={sharedTimeline}
                            />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
