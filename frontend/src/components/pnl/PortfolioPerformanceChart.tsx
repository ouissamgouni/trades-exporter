/**
 * PortfolioPerformanceChart
 *
 * Rebased performance chart: portfolio TWR (or ROI on cost) against selectable
 * benchmarks converted to the base currency. The gap to the main benchmark is shaded.
 */
import React, { useMemo, useState } from 'react';
import { ResponsiveLine } from '@nivo/line';
import {
    BENCHMARK_PRESETS,
    useMultiBenchmarkSeries,
    type TimelinePoint,
} from '../../hooks/useChartData';
import {
    type ZoomPreset,
    ZOOM_PRESETS,
    cumulativeTwr,
    getAxisDateFormat,
    getTickValues,
    filterPointsByZoom,
} from './chartUtils';
import { Badge } from '../ui/primitives';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PORTFOLIO_COLOR = '#3182CE';
export const BENCHMARK_LINE_COLORS = ['#d4b872', '#9f7aea', '#38a169', '#dd6b20', '#e53e3e', '#718096', '#319795', '#b83280', '#2c5282'];

export type PerformanceBasis = 'twr' | 'roi';

// ---------------------------------------------------------------------------
// Line layer: strong portfolio line, thin dashed benchmarks, shaded gap to the main benchmark
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- nivo custom layer props are untyped */
function makeLineLayer(portfolioId: string, shadeWithId: string | null) {
    const Layer = ({ series, lineGenerator, xScale, yScale }: any) => {
        const portfolio = series.find((s: any) => s.id === portfolioId);
        const shadeWith = shadeWithId ? series.find((s: any) => s.id === shadeWithId) : null;
        let shade: string | null = null;
        if (portfolio && shadeWith && portfolio.data.length > 1) {
            const xs = portfolio.data.map((d: any) => new Date(d.data.x).getTime());
            const lo = xs[0];
            const hi = xs[xs.length - 1];
            const bench = shadeWith.data.filter((d: any) => {
                const t = new Date(d.data.x).getTime();
                return t >= lo && t <= hi;
            });
            if (bench.length > 1) {
                const top = portfolio.data.map((d: any) => `${xScale(d.data.x)},${yScale(d.data.y)}`);
                const bottom = [...bench].reverse().map((d: any) => `${xScale(d.data.x)},${yScale(d.data.y)}`);
                shade = `M${[...top, ...bottom].join('L')}Z`;
            }
        }
        return (
            <>
                {shade && <path d={shade} fill={PORTFOLIO_COLOR} fillOpacity={0.08} stroke="none" />}
                {series.map((s: any) => {
                    const isBenchmark = s.id !== portfolioId;
                    const lineData = s.data.filter((d: any) => d.data.x != null && d.data.y != null);
                    if (!lineData.length) return null;
                    lineGenerator.x((d: any) => xScale(d.data.x));
                    lineGenerator.y((d: any) => yScale(d.data.y));
                    const path = lineGenerator(lineData) || '';
                    return (
                        <path
                            key={s.id}
                            d={path}
                            fill="none"
                            stroke={s.color}
                            strokeWidth={isBenchmark ? 1.5 : 2.5}
                            strokeDasharray={isBenchmark ? '6,3' : undefined}
                            strokeOpacity={isBenchmark ? 0.8 : 1}
                        />
                    );
                })}
            </>
        );
    };
    return Layer;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

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
    /** Benchmark tickers to overlay (first one is shaded against unless mainBenchmark is set) */
    benchmarks?: string[];
    mainBenchmark?: string;
    basis?: PerformanceBasis;
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
    benchmarks = ['^GSPC'],
    mainBenchmark,
    basis = 'twr',
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

    // ROI moves with deposits, an index return does not: benchmarks are only drawn against TWR
    const showBenchmarks = basis === 'twr';
    const benchmarkResults = useMultiBenchmarkSeries(
        benchmarks,
        dateRange.start,
        dateRange.end,
        filteredPoints.length > 0 && showBenchmarks,
        baseCurrency,
    );

    const portfolioLabel = `${contextLabel || 'Portfolio'} ${basis === 'twr' ? 'TWR' : 'ROI'}`;
    const labelOf = (ticker: string) => BENCHMARK_PRESETS.find(b => b.ticker === ticker)?.label ?? ticker;
    const shadeTicker = mainBenchmark && benchmarks.includes(mainBenchmark) ? mainBenchmark : benchmarks[0];
    const shadeWithId = showBenchmarks && shadeTicker ? labelOf(shadeTicker) : null;
    const lineLayer = useMemo(() => makeLineLayer(portfolioLabel, shadeWithId), [portfolioLabel, shadeWithId]);

    // ---- Build chart series ----
    const { chartData, colorMap } = useMemo(() => {
        const series: { id: string; data: { x: string; y: number }[] }[] = [];
        const colors: Record<string, string> = {};

        if (!filteredPoints.length) return { chartData: series, colorMap: colors };

        let portfolioData: { x: string; y: number }[];
        if (basis === 'twr') {
            portfolioData = cumulativeTwr(filteredPoints);
        } else {
            // ROI on cost incl. income, rebased to 0% at start
            portfolioData = [];
            let roi0: number | null = null;
            for (const pt of filteredPoints) {
                const costBasis = pt.cost_basis_in_base;
                if (costBasis <= 0) continue;
                const roi = ((pt.unrealized_pnl + pt.cumulative_realized_pnl + (pt.cumulative_income ?? 0)) / costBasis) * 100;
                if (roi0 === null) roi0 = roi;
                portfolioData.push({ x: pt.date, y: roi - roi0 });
            }
        }
        if (portfolioData.length >= 2) {
            series.push({ id: portfolioLabel, data: portfolioData });
            colors[portfolioLabel] = PORTFOLIO_COLOR;
        }

        if (showBenchmarks) benchmarkResults.forEach((br, idx) => {
            if (!br.data || br.data.points.length < 2) return;
            const close0 = br.data.points[0].close;
            if (close0 <= 0) return;
            const id = labelOf(br.ticker);
            series.push({ id, data: br.data.points.map(bp => ({ x: bp.date, y: ((bp.close / close0) - 1) * 100 })) });
            colors[id] = BENCHMARK_LINE_COLORS[idx % BENCHMARK_LINE_COLORS.length];
        });

        return { chartData: series, colorMap: colors };
    }, [filteredPoints, benchmarkResults, portfolioLabel, basis, showBenchmarks]); // eslint-disable-line react-hooks/exhaustive-deps

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

            {!showBenchmarks && benchmarks.length > 0 && (
                <div className="mb-1 text-[10px] text-slate-400" data-testid="benchmarks-twr-only">
                    Benchmarks are compared against TWR — ROI moves with deposits and withdrawals, an index does not.
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
                        layers={['grid', 'markers', 'axes', 'areas', lineLayer, 'crosshair', 'slices', 'mesh', 'legends']}
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
                            itemWidth: 110,
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
