/**
 * PortfolioPerformanceChart
 *
 * Lightweight rebased performance chart showing:
 *   - Portfolio ROI line (from timeline points)
 *   - Default benchmark: S&P 500
 *
 * Designed for inline / embedded use inside the period panel,
 * with an optional fullscreen mode that shows zoom controls.
 */
import React, { useMemo, useState } from 'react';
import { ResponsiveLine } from '@nivo/line';
import {
    useMultiBenchmarkSeries,
    type TimelinePoint,
} from '../../hooks/useChartData';
import {
    type ZoomPreset,
    ZOOM_PRESETS,
    getAxisDateFormat,
    getTickValues,
    filterPointsByZoom,
} from './chartUtils';
import { Badge } from '../ui/primitives';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PORTFOLIO_COLOR = '#3182CE';
const BENCHMARK_COLOR = '#d4b872'; // muted gold

// ---------------------------------------------------------------------------
// Custom line layer: strong portfolio line, thin dashed benchmark
// ---------------------------------------------------------------------------

const CustomLineLayer = ({ series, lineGenerator, xScale, yScale }: any) => {
    return (
        <>
            {series.map((s: any) => {
                const isBenchmark = s.id === 'S&P 500';
                const lineData = s.data.filter((d: any) => d.data.x != null && d.data.y != null);
                if (!lineData.length) return null;
                lineGenerator.x((d: any) => (xScale as any)(d.data.x));
                lineGenerator.y((d: any) => (yScale as any)(d.data.y));
                const path = lineGenerator(lineData as any) || '';
                return (
                    <path
                        key={s.id}
                        d={path}
                        fill="none"
                        stroke={s.color}
                        strokeWidth={isBenchmark ? 1.5 : 2.5}
                        strokeDasharray={isBenchmark ? '6,3' : undefined}
                        strokeOpacity={isBenchmark ? 0.7 : 1}
                    />
                );
            })}
        </>
    );
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PortfolioPerformanceChartProps {
    points: TimelinePoint[];
    baseCurrency: string;
    isLoading?: boolean;
    /** Controlled zoom — when provided, overrides internal state */
    zoom?: ZoomPreset;
    onZoomChange?: (z: ZoomPreset) => void;
    /** Hide zoom badge bar (for inline / embedded usage) */
    hideControls?: boolean;
    /** Override chart height (default 200px) */
    height?: string;
    /** Context label (e.g. asset symbol) shown in legend instead of 'Portfolio' */
    contextLabel?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const PortfolioPerformanceChart: React.FC<PortfolioPerformanceChartProps> = ({
    points,
    baseCurrency,
    isLoading,
    zoom: controlledZoom,
    onZoomChange,
    hideControls,
    height = '200px',
    contextLabel,
}) => {
    const [internalZoom, setInternalZoom] = useState<ZoomPreset>('all');
    const zoom = controlledZoom ?? internalZoom;
    const setZoom = onZoomChange ?? setInternalZoom;

    // ---- Zoom filter ----
    const filteredPoints = useMemo(() => filterPointsByZoom(points, zoom), [points, zoom]);

    // ---- Date range for benchmark fetch ----
    const dateRange = useMemo(() => {
        if (!filteredPoints.length) return { start: null, end: null };
        return {
            start: filteredPoints[0].date,
            end: filteredPoints[filteredPoints.length - 1].date,
        };
    }, [filteredPoints]);

    // ---- Benchmark data (S&P 500 only) ----
    const benchmarkResults = useMultiBenchmarkSeries(
        ['^GSPC'],
        dateRange.start,
        dateRange.end,
        filteredPoints.length > 0,
    );

    // ---- Build chart series ----
    const { chartData, colorMap } = useMemo(() => {
        const series: { id: string; data: { x: string; y: number }[] }[] = [];
        const colors: Record<string, string> = {};

        if (!filteredPoints.length) return { chartData: series, colorMap: colors };

        // 1) Portfolio ROI line: ((unrealized + realized + income) / cost_basis) × 100, rebased to 0% at start
        const portfolioData: { x: string; y: number }[] = [];
        let roi0: number | null = null;
        for (const pt of filteredPoints) {
            const costBasis = pt.cost_basis_in_base;
            if (costBasis <= 0) continue;
            const roi = ((pt.unrealized_pnl + pt.cumulative_realized_pnl + (pt.cumulative_income ?? 0)) / costBasis) * 100;
            if (roi0 === null) roi0 = roi;
            portfolioData.push({ x: pt.date, y: roi - roi0 });
        }
        const portfolioLabel = contextLabel || 'Portfolio';
        if (portfolioData.length >= 2) {
            series.push({ id: portfolioLabel, data: portfolioData });
            colors[portfolioLabel] = PORTFOLIO_COLOR;
        }

        // 2) S&P 500 benchmark (rebased to 0%)
        const br = benchmarkResults[0];
        if (br?.data && br.data.points.length >= 2) {
            const bPoints = br.data.points;
            const close0 = bPoints[0].close;
            if (close0 > 0) {
                const data = bPoints.map(bp => ({
                    x: bp.date,
                    y: ((bp.close / close0) - 1) * 100,
                }));
                series.push({ id: 'S&P 500', data });
                colors['S&P 500'] = BENCHMARK_COLOR;
            }
        }

        return { chartData: series, colorMap: colors };
    }, [filteredPoints, benchmarkResults, contextLabel]);

    const totalDays = filteredPoints.length > 1
        ? Math.ceil(
            (new Date(filteredPoints[filteredPoints.length - 1].date).getTime() -
                new Date(filteredPoints[0].date).getTime()) / 86400000,
        )
        : 0;

    if (!points.length && !isLoading) return null;

    return (
        <div>
            {!hideControls && (
                <div className="mb-2 flex justify-end gap-1">
                    {(Object.keys(ZOOM_PRESETS) as ZoomPreset[]).map(k => (
                        <Badge
                            key={k}
                            className={`cursor-pointer px-2 ${zoom === k ? 'bg-purple-600 text-white' : 'border border-slate-300 bg-white text-slate-700'}`}
                            onClick={() => setZoom(k)}
                        >
                            {ZOOM_PRESETS[k].label}
                        </Badge>
                    ))}
                </div>
            )}

            {isLoading ? (
                <div className="flex items-center justify-center" style={{ height }}>
                    <span className="text-sm text-slate-400">Loading...</span>
                </div>
            ) : chartData.length === 0 ? (
                <div className="flex items-center justify-center" style={{ height }}>
                    <span className="text-xs text-slate-400">Not enough data</span>
                </div>
            ) : (
                <div style={{ height }}>
                    <ResponsiveLine
                        data={chartData}
                        animate={false}
                        margin={{ top: 20, right: 10, bottom: 22, left: 40 }}
                        xScale={{ type: 'time', format: '%Y-%m-%d', precision: 'day', useUTC: false }}
                        xFormat="time:%Y-%m-%d"
                        yScale={{ type: 'linear', min: 'auto', max: 'auto' }}
                        yFormat={(v) => `${Number(v).toFixed(1)}%`}
                        axisBottom={{
                            format: getAxisDateFormat(totalDays),
                            tickRotation: -30,
                            tickValues: getTickValues(totalDays),
                        }}
                        axisLeft={{
                            format: (v: number) => `${v.toFixed(0)}%`,
                            tickSize: 3,
                            tickPadding: 4,
                        }}
                        enableArea={false}
                        enablePoints={false}
                        useMesh={true}
                        colors={(d) => colorMap[d.id] ?? '#999'}
                        lineWidth={2.5}
                        layers={['grid', 'markers', 'axes', 'areas', CustomLineLayer, 'crosshair', 'slices', 'mesh', 'legends']}
                        curve="monotoneX"
                        enableSlices="x"
                        sliceTooltip={({ slice }) => (
                            <div className="min-w-[140px] border border-slate-200 bg-white p-2 shadow-md">
                                <div className="mb-1 text-xs font-bold text-slate-600">
                                    {slice.points[0]?.data.xFormatted}
                                </div>
                                {slice.points.map(p => (
                                    <div key={p.id} className="flex justify-between gap-3">
                                        <div className="flex items-center gap-1">
                                            <div className="h-2 w-2 rounded-full" style={{ backgroundColor: p.seriesColor }} />
                                            <span className="text-xs">{p.seriesId}</span>
                                        </div>
                                        <span className="text-xs font-bold">
                                            {Number(p.data.y).toFixed(1)}%
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                        legends={[{
                            anchor: 'top-right',
                            direction: 'row',
                            translateX: 0,
                            translateY: -18,
                            itemWidth: 80,
                            itemHeight: 14,
                            symbolSize: 8,
                            symbolShape: 'circle',
                            itemTextColor: '#555',
                        }]}
                        theme={{
                            axis: { ticks: { text: { fontSize: 9 } } },
                            tooltip: { container: { fontFamily: 'inherit', fontSize: 11 } },
                        }}
                    />
                </div>
            )}
        </div>
    );
};
