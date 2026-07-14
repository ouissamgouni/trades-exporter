import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Spinner } from './ui/primitives';
import { ResponsiveLine } from '@nivo/line';
import { API_URL, GapRange } from '../types';
import { useBaseCurrency } from '../hooks/useBaseCurrency';

interface PriceTimeseriesPoint {
    date: string;
    price: number;
}

interface ChartSerie {
    id: string;
    data: Array<{ x: string; y: number | null }>;
}

interface AssetPriceChartProps {
    assetId: number;
    symbol: string;
    /** Optional gap ranges to render as red overlay zones */
    gaps?: GapRange[];
    /** Mini sparkline mode — small height, no axes/tooltips/presets */
    mini?: boolean;
    /** External zoom override — when set, internal zoom state is ignored */
    zoom?: ZoomKey;
    /** Callback when user changes zoom (fullscreen mode) */
    onZoomChange?: (z: ZoomKey) => void;
    /** Hide internal zoom preset badges */
    hideControls?: boolean;
    /** Custom chart height (CSS string) */
    height?: string;
}

const ZOOM_PRESETS = {
    '1W': { label: '1W', days: 7 },
    '1M': { label: '1M', days: 30 },
    '3M': { label: '3M', days: 90 },
    '6M': { label: '6M', days: 180 },
    '1Y': { label: '1Y', days: 365 },
    ALL: { label: 'All', days: 0 },
} as const;

type ZoomKey = keyof typeof ZOOM_PRESETS;

const CHART_HEIGHT = 180;
const MINI_HEIGHT = 36;

export type PriceChartZoomKey = ZoomKey;

export const AssetPriceChart: React.FC<AssetPriceChartProps> = ({ assetId, symbol, gaps, mini, zoom: externalZoom, onZoomChange, hideControls, height: heightProp }) => {
    const [points, setPoints] = useState<PriceTimeseriesPoint[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [internalZoom, setInternalZoom] = useState<ZoomKey>('ALL');
    const zoom = externalZoom ?? internalZoom;
    const setZoom = onZoomChange ?? setInternalZoom;
    const baseCurrency = useBaseCurrency();

    useEffect(() => {
        let cancelled = false;
        setIsLoading(true);
        setError(null);

        const params = new URLSearchParams({ asset_ids: String(assetId) });
        if (baseCurrency.assetId) params.set('quote_asset_id', String(baseCurrency.assetId));

        fetch(`${API_URL}/price-snapshots/timeseries?${params}`)
            .then(r => {
                if (!r.ok) throw new Error('Failed to fetch');
                return r.json();
            })
            .then(data => {
                if (cancelled) return;
                const assetData = data.assets?.find((a: any) => a.asset_id === assetId);
                setPoints(assetData?.points ?? []);
            })
            .catch(err => {
                if (cancelled) return;
                setError(err.message);
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });

        return () => { cancelled = true; };
    }, [assetId, baseCurrency.assetId]);

    const filteredPoints = useMemo(() => {
        if (zoom === 'ALL' || points.length === 0) return points;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - ZOOM_PRESETS[zoom].days);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        return points.filter(p => p.date >= cutoffStr);
    }, [points, zoom]);

    const chartData: ChartSerie[] = useMemo(() => {
        if (filteredPoints.length === 0) return [];

        // Build a set of gap date strings for quick lookup
        const gapDateSet = new Set<string>();
        if (gaps) {
            for (const g of gaps) {
                const cur = new Date(g.start_date + 'T00:00:00Z');
                const end = new Date(g.end_date + 'T00:00:00Z');
                while (cur <= end) {
                    gapDateSet.add(cur.toISOString().slice(0, 10));
                    cur.setUTCDate(cur.getUTCDate() + 1);
                }
            }
        }

        // Insert null y-values inside gap ranges to break the line
        const dataPoints: Array<{ x: string; y: number | null }> = [];
        for (let i = 0; i < filteredPoints.length; i++) {
            const p = filteredPoints[i];
            dataPoints.push({ x: p.date, y: p.price });

            // If the next point exists and there's a gap between this point and the next,
            // insert a null entry after the current point's date to break the line
            if (i < filteredPoints.length - 1) {
                const nextDate = filteredPoints[i + 1].date;
                const curDate = new Date(p.date + 'T00:00:00Z');
                const nxtDate = new Date(nextDate + 'T00:00:00Z');
                const diffDays = (nxtDate.getTime() - curDate.getTime()) / 86400000;

                // Check if any gap range overlaps with the interval between consecutive points
                if (diffDays > 1 && gaps) {
                    const hasGap = gaps.some(g => {
                        const gs = new Date(g.start_date + 'T00:00:00Z').getTime();
                        const ge = new Date(g.end_date + 'T00:00:00Z').getTime();
                        return gs <= nxtDate.getTime() && ge >= curDate.getTime();
                    });
                    if (hasGap) {
                        // Insert null one day after current to break the line
                        const breakDate = new Date(curDate);
                        breakDate.setUTCDate(breakDate.getUTCDate() + 1);
                        dataPoints.push({ x: breakDate.toISOString().slice(0, 10), y: null });
                    }
                }
            }
        }

        // Extend to today: add a point at today's date if last point is before today
        const today = new Date().toISOString().slice(0, 10);
        const lastPoint = filteredPoints[filteredPoints.length - 1];
        if (lastPoint && lastPoint.date < today) {
            // If in a gap zone, line is already broken; just add null
            // If not, add a point at today with the last known price
            if (gapDateSet.has(today)) {
                dataPoints.push({ x: today, y: null });
            } else {
                dataPoints.push({ x: today, y: lastPoint.price });
            }
        }

        return [{
            id: symbol,
            data: dataPoints,
        }];
    }, [filteredPoints, symbol, gaps]);

    // ── Custom Nivo layer: red/orange overlay for gap zones ──────────────
    const gapLayer = useMemo(() => {
        if (!gaps || gaps.length === 0) return undefined;

        return (props: any) => {
            const { xScale, innerHeight } = props;
            const scale = xScale as unknown as (v: Date) => number;

            return (
                <g>
                    {gaps.map((g) => {
                        const startX = scale(new Date(g.start_date + 'T00:00:00Z'));
                        const endX = scale(new Date(g.end_date + 'T00:00:00Z'));
                        const width = endX - startX;
                        if (width <= 0) return null;
                        return (
                            <rect
                                key={`gap-${g.start_date}-${g.end_date}`}
                                x={startX}
                                y={0}
                                width={width}
                                height={innerHeight}
                                fill="rgba(245, 101, 101, 0.12)"
                                stroke="rgba(245, 101, 101, 0.3)"
                                strokeWidth={0.5}
                                strokeDasharray="4 2"
                            />
                        );
                    })}
                </g>
            );
        };
    }, [gaps]);

    const totalDays = filteredPoints.length > 1
        ? Math.ceil((new Date(filteredPoints[filteredPoints.length - 1].date).getTime() - new Date(filteredPoints[0].date).getTime()) / 86400000)
        : 0;

    const getTickValues = (days: number) => {
        if (days <= 35) return 'every 7 days';
        if (days <= 100) return 'every 2 weeks';
        if (days <= 200) return 'every month';
        if (days <= 400) return 'every 2 months';
        return 'every 3 months';
    };

    const getAxisFormat = (days: number) => {
        if (days <= 100) return '%b %d';
        return '%b %y';
    };

    const formatPrice = (v: number) => {
        if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
        if (v >= 1) return `$${v.toFixed(2)}`;
        if (v >= 0.01) return `$${v.toFixed(4)}`;
        return `$${v.toFixed(6)}`;
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center" style={{ height: mini ? '100%' : CHART_HEIGHT }}>
                <Spinner size="xs" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex items-center justify-center" style={{ height: mini ? '100%' : 60 }}>
                <span className="text-xs text-red-500">{error}</span>
            </div>
        );
    }

    if (points.length === 0) {
        return (
            <div className="flex items-center justify-center" style={{ height: mini ? '100%' : 60 }}>
                <span className="text-xs text-gray-400">No price data</span>
            </div>
        );
    }

    // ── Mini sparkline mode ──────────────────────────────────────────────
    if (mini) {
        if (filteredPoints.length < 2) {
            return (
                <div className="flex h-full items-center justify-center">
                    <span className="text-[9px] text-gray-400">—</span>
                </div>
            );
        }

        const layers: any[] = ['grid', 'areas', 'lines'];
        if (gapLayer) layers.push(gapLayer);

        return (
            <div className="h-full w-full overflow-hidden">
                <ResponsiveLine
                    data={chartData}
                    animate={false}
                    margin={{ top: 2, right: 2, bottom: 2, left: 2 }}
                    xScale={{ type: 'time', format: '%Y-%m-%d', precision: 'day', useUTC: false }}
                    yScale={{ type: 'linear', min: 'auto', max: 'auto' }}
                    axisBottom={null}
                    axisLeft={null}
                    enableGridX={false}
                    enableGridY={false}
                    enableArea={true}
                    areaOpacity={0.06}
                    enablePoints={false}
                    colors={['#3182CE']}
                    lineWidth={1}
                    curve="monotoneX"
                    isInteractive={false}
                    layers={layers}
                />
            </div>
        );
    }

    // ── Full chart mode ──────────────────────────────────────────────────
    const chartHeight = heightProp ? undefined : CHART_HEIGHT;

    return (
        <div style={{ height: heightProp }}>
            {/* Zoom presets */}
            {!hideControls && (
                <div className="mb-1 flex justify-end gap-1">
                    {(Object.keys(ZOOM_PRESETS) as ZoomKey[]).map(k => (
                        <Badge
                            key={k}
                            colorScheme={zoom === k ? 'blue' : 'gray'}
                            onClick={() => setZoom(k)}
                            className={`cursor-pointer px-1.5 text-[9px] ${zoom === k ? 'ring-2 ring-blue-400' : ''}`}
                        >
                            {ZOOM_PRESETS[k].label}
                        </Badge>
                    ))}
                </div>
            )}

            {filteredPoints.length < 2 ? (
                <div className="flex items-center justify-center" style={{ height: chartHeight }}>
                    <span className="text-xs text-gray-400">Not enough data for selected range</span>
                </div>
            ) : (
                <div style={{ height: heightProp ? '100%' : CHART_HEIGHT }}>
                    <ResponsiveLine
                        data={chartData}
                        animate={false}
                        margin={{ top: 8, right: 8, bottom: 24, left: 50 }}
                        xScale={{ type: 'time', format: '%Y-%m-%d', precision: 'day', useUTC: false }}
                        xFormat="time:%Y-%m-%d"
                        yScale={{ type: 'linear', min: 'auto', max: 'auto' }}
                        yFormat={v => formatPrice(Number(v))}
                        axisBottom={{
                            format: getAxisFormat(totalDays),
                            tickRotation: -30,
                            tickValues: getTickValues(totalDays),
                            tickSize: 3,
                            tickPadding: 2,
                        }}
                        axisLeft={{
                            format: (v: number) => formatPrice(v),
                            tickSize: 3,
                            tickPadding: 4,
                        }}
                        enableArea={true}
                        areaOpacity={0.08}
                        enablePoints={false}
                        useMesh={true}
                        colors={['#3182CE']}
                        lineWidth={1.5}
                        curve="monotoneX"
                        enableSlices="x"
                        layers={[
                            'grid',
                            'markers',
                            'axes',
                            'areas',
                            'crosshair',
                            'lines',
                            ...(gapLayer ? [gapLayer] : []),
                            'points',
                            'slices',
                            'mesh',
                            'legends',
                        ] as any}
                        sliceTooltip={({ slice }) => (
                            <div className="min-w-[120px] rounded-md border border-gray-200 bg-white p-2 shadow-md">
                                <div className="mb-0.5 text-[10px] font-bold text-gray-600">
                                    {slice.points[0]?.data.xFormatted}
                                </div>
                                {slice.points.map(p => (
                                    <div key={p.id} className="text-xs font-medium text-blue-600">
                                        {formatPrice(Number(p.data.yFormatted?.toString().replace(/[$,k]/g, '') || p.data.y))}
                                    </div>
                                ))}
                            </div>
                        )}
                        theme={{
                            axis: {
                                ticks: { text: { fontSize: 9, fill: '#999' } },
                            },
                            grid: { line: { stroke: '#f0f0f0' } },
                            crosshair: { line: { stroke: '#aaa', strokeDasharray: '4 4' } },
                        }}
                    />
                </div>
            )}

            {/* Summary line */}
            {!hideControls && (
                <div className="mt-1 flex justify-between">
                    <span className="text-[9px] text-gray-400">
                        {filteredPoints.length} data points
                        {filteredPoints.length > 0 && ` · ${filteredPoints[0].date} → ${filteredPoints[filteredPoints.length - 1].date}`}
                    </span>
                    {filteredPoints.length > 0 && (
                        <span className="text-[9px] font-medium text-gray-500">
                            Latest: {formatPrice(filteredPoints[filteredPoints.length - 1].price)}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
};

export default AssetPriceChart;
