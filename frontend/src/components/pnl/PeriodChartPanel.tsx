/**
 * PeriodChartPanel
 *
 * Wrapper for the inline chart shown next to best/worst performers.
 * Toggles between Performance (rebased) and Cost vs Market Value.
 * Auto-syncs to the selected period range.
 * Includes a fullscreen button that opens a modal with zoom controls.
 */
import React, { useMemo, useState } from 'react';
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
import { Badge } from '../ui/primitives';

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
            <div className="relative">
                {/* Header: toggle + fullscreen */}
                <div className="mb-1 flex items-center justify-between">
                    <div className="flex gap-0.5">
                        {modes.map(([mode, label]) => (
                            <Badge
                                key={mode}
                                className={`cursor-pointer px-1.5 ${chartMode === mode ? 'bg-blue-500 text-white' : 'border border-slate-300 bg-white text-slate-700'}`}
                                onClick={() => setChartMode(mode)}
                            >
                                {label}
                            </Badge>
                        ))}
                    </div>
                    <div
                        className="cursor-pointer text-slate-400 hover:text-blue-500"
                        onClick={handleOpenFullscreen}
                        title="Fullscreen"
                    >
                        <FiMaximize2 size={12} />
                    </div>
                </div>

                {/* Error state */}
                {error && chartMode !== 'price' ? (
                    <div className="flex h-[200px] flex-col items-center justify-center gap-1">
                        <span className="text-red-400"><FiAlertTriangle size={16} /></span>
                        <span className="text-xs text-red-500">Failed to load chart data</span>
                        <span className="text-xs text-red-400">{error}</span>
                    </div>
                ) : !isLoading && points.length === 0 && chartMode !== 'price' ? (
                    <div className="flex h-[200px] flex-col items-center justify-center gap-1">
                        <span className="text-xs text-slate-400">No chart data available for this period</span>
                    </div>
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
                    <div className="mt-1 flex items-center gap-1 border border-orange-200 bg-orange-50 px-2 py-1">
                        <span className="text-orange-500"><FiAlertTriangle size={11} /></span>
                        <span className="text-[10px] text-orange-700">
                            {periodGapCount} price gap{periodGapCount !== 1 ? 's' : ''} in this period — chart accuracy may be affected.
                        </span>
                        <span
                            className="cursor-pointer text-[10px] font-semibold text-blue-500 hover:underline"
                            onClick={() => setChartMode('price')}
                        >
                            Fix gaps
                        </span>
                    </div>
                )}
            </div>

            {/* Fullscreen modal */}
            <ChartFullscreenModal
                isOpen={isFullscreen}
                onClose={() => setIsFullscreen(false)}
                title={contextLabel
                    ? `${contextLabel} — ${chartMode === 'performance' ? 'Performance (Rebased)' : chartMode === 'cost-vs-value' ? 'Cost Basis vs Market Value' : 'Price'}`
                    : chartMode === 'performance' ? 'Performance (Rebased)' : chartMode === 'cost-vs-value' ? 'Cost Basis vs Market Value' : 'Price'}
            >
                {/* Mode toggle + zoom badges */}
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex gap-1">
                        {modes.map(([mode, label]) => (
                            <Badge
                                key={mode}
                                className={`cursor-pointer px-2 ${chartMode === mode ? 'bg-blue-500 text-white' : 'border border-slate-300 bg-white text-slate-700'}`}
                                onClick={() => setChartMode(mode)}
                            >
                                {label}
                            </Badge>
                        ))}
                    </div>
                </div>

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
