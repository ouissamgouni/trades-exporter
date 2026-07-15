/**
 * CostBasisVsMarketValueChart
 *
 * Dual-line chart: Market Value vs Cost Basis over time.
 * Zoom presets: All / 1Y / 6M / 3M / 1M.
 */
import React, { useMemo, useState } from 'react';
import { ResponsiveLine } from '@nivo/line';
import type { TimelinePoint } from '../../hooks/useChartData';
import {
    type ZoomPreset,
    ZOOM_PRESETS,
    formatCompact,
    getAxisDateFormat,
    getTickValues,
    filterPointsByZoom,
} from './chartUtils';
import { Badge } from '../ui/primitives';

interface CostBasisVsMarketValueChartProps {
    points: TimelinePoint[];
    baseCurrency: string;
    isLoading?: boolean;
    /** Controlled zoom — when provided, overrides internal state */
    zoom?: ZoomPreset;
    /** Callback when user changes zoom (only relevant if zoom is controlled) */
    onZoomChange?: (z: ZoomPreset) => void;
    /** Hide the header + zoom badge bar (for inline / embedded usage) */
    hideControls?: boolean;
    /** Override chart height (default 300px) */
    height?: string;
    /** Context label (e.g. account/category name) shown in title */
    contextLabel?: string;
}

export const CostBasisVsMarketValueChart: React.FC<CostBasisVsMarketValueChartProps> = ({
    points,
    baseCurrency,
    isLoading,
    zoom: controlledZoom,
    onZoomChange,
    hideControls,
    height = '300px',
    contextLabel,
}) => {
    const [internalZoom, setInternalZoom] = useState<ZoomPreset>('all');
    const zoom = controlledZoom ?? internalZoom;
    const setZoom = onZoomChange ?? setInternalZoom;

    // ----- Time-series data (Total view) -----
    const filteredPoints = useMemo(() => filterPointsByZoom(points, zoom), [points, zoom]);

    const lineData = useMemo(() => {
        if (filteredPoints.length < 2) return [];
        return [
            { id: 'Market Value', data: filteredPoints.map(p => ({ x: p.date, y: p.total_value_in_base })) },
            { id: 'Cost Basis', data: filteredPoints.map(p => ({ x: p.date, y: p.cost_basis_in_base })) },
        ];
    }, [filteredPoints]);

    const totalDays = filteredPoints.length > 1
        ? Math.ceil((new Date(filteredPoints[filteredPoints.length - 1].date).getTime() -
            new Date(filteredPoints[0].date).getTime()) / 86400000)
        : 0;

    if (!points.length && !isLoading) return null;

    return (
        <div className={hideControls ? '' : 'mb-4 border border-slate-200 bg-white p-4'}>
            {!hideControls && (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-700">{contextLabel ? `${contextLabel} — Cost Basis vs Market Value` : 'Cost Basis vs Market Value'}</span>
                    <div className="flex gap-1">
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
                </div>
            )}

            {isLoading ? (
                <div className="flex items-center justify-center" style={{ height }}>
                    <span className="text-sm text-slate-400">Loading...</span>
                </div>
            ) : lineData.length === 0 ? (
                <div className="flex items-center justify-center" style={{ height }}>
                    <span className="text-xs text-slate-400">Not enough data</span>
                </div>
            ) : (
                <div style={{ height }}>
                    <ResponsiveLine
                        data={lineData}
                        animate={false}
                        margin={{ top: 28, right: 30, bottom: 40, left: 70 }}
                        xScale={{ type: 'time', format: '%Y-%m-%d', precision: 'day', useUTC: false }}
                        xFormat="time:%Y-%m-%d"
                        yScale={{ type: 'linear', min: 0, max: 'auto' }}
                        axisBottom={{
                            format: getAxisDateFormat(totalDays),
                            tickRotation: -30,
                            tickValues: getTickValues(totalDays),
                        }}
                        axisLeft={{
                            format: (v: number) => formatCompact(v),
                            legend: baseCurrency,
                            legendOffset: -55,
                            legendPosition: 'middle',
                        }}
                        enableArea={true}
                        areaOpacity={0.08}
                        enablePoints={false}
                        useMesh={true}
                        colors={['#3182CE', '#E53E3E']}
                        lineWidth={2}
                        curve="monotoneX"
                        enableSlices="x"
                        sliceTooltip={({ slice }) => {
                            const marketVal = slice.points.find(p => p.seriesId === 'Market Value')?.data.y as number | undefined;
                            const costVal = slice.points.find(p => p.seriesId === 'Cost Basis')?.data.y as number | undefined;
                            const unrealized = (marketVal ?? 0) - (costVal ?? 0);
                            return (
                                <div className="min-w-[180px] border border-slate-200 bg-white p-2 shadow-md">
                                    <span className="mb-1 block text-xs font-bold text-slate-600">
                                        {slice.points[0]?.data.xFormatted}
                                    </span>
                                    {slice.points.map(p => (
                                        <div key={p.id} className="flex justify-between gap-3">
                                            <div className="flex items-center gap-1">
                                                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.seriesColor }} />
                                                <span className="text-xs">{p.seriesId}</span>
                                            </div>
                                            <span className="text-xs font-bold">
                                                {Number(p.data.yFormatted).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                            </span>
                                        </div>
                                    ))}
                                    <div className="mt-1 border-t border-slate-100 pt-1">
                                        <div className="flex justify-between">
                                            <span className="text-xs text-slate-500">Unrealized</span>
                                            <span className={`text-xs font-bold ${unrealized >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                {unrealized >= 0 ? '+' : ''}{formatCompact(unrealized)} {baseCurrency}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            );
                        }}
                        legends={[{
                            anchor: 'top-right',
                            direction: 'row',
                            translateX: 0,
                            translateY: -24,
                            itemWidth: 120,
                            itemHeight: 16,
                            symbolSize: 10,
                            symbolShape: 'circle',
                            itemTextColor: '#555',
                        }]}
                        theme={{
                            axis: { ticks: { text: { fontSize: 10 } } },
                            tooltip: { container: { fontFamily: 'inherit', fontSize: 12 } },
                        }}
                    />
                </div>
            )}
        </div>
    );
};
