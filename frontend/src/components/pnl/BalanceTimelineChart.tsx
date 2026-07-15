/**
 * Balance Timeline Chart (Nivo)
 * 
 * Displays asset balance progression over time based on cost lot events.
 * Features:
 * - Stepped line chart showing balance plateaus between events
 * - Toggle between "By Account" (multiple lines) and "Total" (single line) views
 * - Temporal zoom controls (All, 1Y, 6M, 3M, 1M, 1W)
 * - Dynamic axis formatting based on time range
 * - Density indicators for clustered events
 * - Interactive tooltips with event details
 */

import React, { useMemo, useState, useCallback } from 'react';
import { Badge, Button } from '../ui/primitives';
import { ResponsiveLine } from '@nivo/line';
import { CostLotEventEntry } from './types';

export interface BalanceTimelineChartProps {
    /** Cost lot events with balance_after and account_balance_after */
    events: CostLotEventEntry[];
    /** Base currency symbol for formatting */
    baseCurrency: string;
    /** View mode: 'total' shows asset balance, 'by-account' shows per-account lines */
    viewMode: 'total' | 'by-account';
    /** Asset symbol for display */
    assetSymbol: string;
}

interface BalanceDataPoint {
    x: Date;
    y: number;
    event: CostLotEventEntry;
}

/**
 * Format quantity for display
 */
const formatQty = (value: number): string => {
    if (Math.abs(value) < 0.00001) return '0';
    if (Math.abs(value) < 1) return value.toFixed(8).replace(/\.?0+$/, '');
    if (Math.abs(value) < 1000) return value.toFixed(4).replace(/\.?0+$/, '');
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

/**
 * Format date for display
 */
const formatDate = (date: Date): string => {
    return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
};

/**
 * Format axis date based on time range
 */
const getAxisFormat = (daysDiff: number): string => {
    if (daysDiff < 7) return '%m/%d %H:%M';  // Show time for < 1 week
    if (daysDiff < 90) return '%b %d';       // Show day for < 3 months
    if (daysDiff < 365) return '%b %y';      // Show month for < 1 year
    return '%Y';                              // Show year only
};

/**
 * Zoom preset periods
 */
type ZoomPreset = 'all' | '1y' | '6m' | '3m' | '1m' | '1w';

interface ZoomPresetConfig {
    label: string;
    days: number | null;  // null for 'all'
}

const ZOOM_PRESETS: Record<ZoomPreset, ZoomPresetConfig> = {
    all: { label: 'All', days: null },
    '1y': { label: '1Y', days: 365 },
    '6m': { label: '6M', days: 180 },
    '3m': { label: '3M', days: 90 },
    '1m': { label: '1M', days: 30 },
    '1w': { label: '1W', days: 7 },
};

export const BalanceTimelineChart: React.FC<BalanceTimelineChartProps> = ({
    events,
    baseCurrency,
    viewMode,
    assetSymbol,
}) => {
    // Local zoom state
    const [activeZoom, setActiveZoom] = useState<ZoomPreset>('all');

    // Apply zoom filtering
    const filteredEvents = useMemo(() => {
        let filtered = events;

        // Apply local zoom preset
        if (activeZoom !== 'all') {
            const presetDays = ZOOM_PRESETS[activeZoom].days;
            if (presetDays) {
                const now = new Date();
                const cutoff = new Date(now.getTime() - presetDays * 24 * 60 * 60 * 1000);
                filtered = filtered.filter(e => new Date(e.timestamp) >= cutoff);
            }
        }

        return filtered;
    }, [events, activeZoom]);

    // Calculate time range for axis formatting
    const timeRange = useMemo(() => {
        if (filteredEvents.length === 0) return { daysDiff: 0, minDate: null, maxDate: null };

        const dates = filteredEvents.map(e => new Date(e.timestamp).getTime());
        const minDate = new Date(Math.min(...dates));
        const maxDate = new Date(Math.max(...dates));
        const daysDiff = (maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24);

        return { daysDiff, minDate, maxDate };
    }, [filteredEvents]);

    // Event density calculation (for showing clusters)
    const eventDensity = useMemo(() => {
        if (filteredEvents.length === 0) return [];

        const densityMap = new Map<string, number>();
        filteredEvents.forEach(e => {
            const dateKey = new Date(e.timestamp).toDateString();
            densityMap.set(dateKey, (densityMap.get(dateKey) || 0) + 1);
        });

        return Array.from(densityMap.entries()).filter(([_, count]) => count > 10);
    }, [filteredEvents]);

    // Transform events into Nivo-compatible series data
    const chartData: any[] = useMemo(() => {
        if (filteredEvents.length === 0) return [];

        if (viewMode === 'total') {
            // Single line showing total asset balance
            const data = filteredEvents
                .filter(e => e.balance_after != null)
                .map(e => ({
                    x: new Date(e.timestamp),
                    y: e.balance_after!,
                    event: e,
                }))
                .sort((a, b) => a.x.getTime() - b.x.getTime());

            return [{
                id: 'Total Balance',
                data: data,
            }];
        } else {
            // Multiple lines, one per account
            const accountMap = new Map<string, BalanceDataPoint[]>();

            filteredEvents.forEach(e => {
                if (e.account_balance_after == null) return;

                const accountKey = e.account_name || `Account ${e.account_id || 'Unknown'}`;
                if (!accountMap.has(accountKey)) {
                    accountMap.set(accountKey, []);
                }

                accountMap.get(accountKey)!.push({
                    x: new Date(e.timestamp),
                    y: e.account_balance_after,
                    event: e,
                });
            });

            // Sort each account's data by timestamp
            accountMap.forEach(data => {
                data.sort((a, b) => a.x.getTime() - b.x.getTime());
            });

            return Array.from(accountMap.entries()).map(([account, data]) => ({
                id: account,
                data: data,
            }));
        }
    }, [filteredEvents, viewMode]);

    // Handle zoom preset change
    const handleZoomPreset = useCallback((preset: ZoomPreset) => {
        setActiveZoom(preset);
    }, []);

    if (chartData.length === 0 || chartData.every(s => s.data.length === 0)) {
        return (
            <div className="flex min-h-[300px] flex-col items-center justify-center gap-2 bg-slate-50 px-4 py-12">
                <span className="mb-2 text-lg font-medium text-slate-600">
                    No Balance Data
                </span>
                <span className="text-center text-sm text-slate-500">
                    Balance timeline will appear after events with balance data are available.
                </span>
            </div>
        );
    }

    return (
        <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                    <span className="block text-sm font-semibold">
                        {assetSymbol} Balance Over Time
                    </span>
                    <Badge colorScheme="blue">
                        {filteredEvents.length} event{filteredEvents.length !== 1 ? 's' : ''}
                    </Badge>
                    {eventDensity.length > 0 && (
                        <Badge colorScheme="orange">
                            {eventDensity.length} dense day{eventDensity.length !== 1 ? 's' : ''}
                        </Badge>
                    )}
                </div>

                {/* Zoom Controls */}
                <div className="flex flex-wrap gap-1">
                    {(Object.keys(ZOOM_PRESETS) as ZoomPreset[]).map(preset => (
                        <Button
                            key={preset}
                            size="sm"
                            variant={activeZoom === preset ? 'solid' : 'outline'}
                            colorScheme={activeZoom === preset ? 'blue' : 'gray'}
                            onClick={() => handleZoomPreset(preset)}
                        >
                            {ZOOM_PRESETS[preset].label}
                        </Button>
                    ))}
                </div>
            </div>

            <div className="h-[400px]">
                <ResponsiveLine
                    data={chartData}
                    margin={{ top: 20, right: 120, bottom: 60, left: 80 }}
                    curve="stepAfter"  // Use stepped curve to show balance plateaus
                    xScale={{
                        type: 'time',
                        format: 'native',
                        useUTC: false,
                    }}
                    xFormat="time:%Y-%m-%d %H:%M"
                    yScale={{
                        type: 'linear',
                        min: 'auto',
                        max: 'auto',
                    }}
                    yFormat={(value: any) => formatQty(Number(value))}
                    axisTop={null}
                    axisRight={null}
                    axisBottom={{
                        format: getAxisFormat(timeRange.daysDiff),
                        tickRotation: -45,
                        legend: 'Date',
                        legendOffset: 50,
                        legendPosition: 'middle',
                    }}
                    axisLeft={{
                        legend: `Balance (${assetSymbol})`,
                        legendOffset: -60,
                        legendPosition: 'middle',
                        format: (value: any) => formatQty(Number(value)),
                    }}
                    colors={{ scheme: viewMode === 'total' ? 'set2' : 'category10' }}
                    pointSize={10}
                    pointColor={{ theme: 'background' }}
                    pointBorderWidth={2}
                    pointBorderColor={{ from: 'serieColor' }}
                    pointLabelYOffset={-12}
                    enableArea={false}
                    useMesh={true}
                    legends={[
                        {
                            anchor: 'bottom-right',
                            direction: 'column',
                            justify: false,
                            translateX: 100,
                            translateY: 0,
                            itemsSpacing: 0,
                            itemDirection: 'left-to-right',
                            itemWidth: 80,
                            itemHeight: 20,
                            itemOpacity: 0.75,
                            symbolSize: 12,
                            symbolShape: 'circle',
                            symbolBorderColor: 'rgba(0, 0, 0, .5)',
                        },
                    ]}
                    tooltip={({ point }: any) => {
                        const event = (point.data as any).event as CostLotEventEntry;
                        return (
                            <div className="border border-slate-200 bg-white p-3 text-xs shadow-md">
                                <div className="flex flex-col gap-1">
                                    <span className="font-bold">{formatDate(point.data.x as Date)}</span>
                                    <div className="flex items-center gap-2">
                                        <Badge className="text-xs" colorScheme={
                                            event.event_type === 'created' ? 'green' :
                                                event.event_type === 'consumed' ? 'orange' : 'blue'
                                        }>
                                            {event.event_type}
                                        </Badge>
                                        <span>Lot #{event.lot_id}</span>
                                    </div>
                                    <span>
                                        <span className="text-slate-600">Balance: </span>
                                        <span className={`font-bold ${Number(point.data.y) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                            {formatQty(Number(point.data.y))}
                                        </span>
                                    </span>
                                    <span>
                                        <span className="text-slate-600">Change: </span>
                                        <span className={event.quantity_delta >= 0 ? 'text-green-600' : 'text-red-600'}>
                                            {event.quantity_delta >= 0 ? '+' : ''}{formatQty(event.quantity_delta)}
                                        </span>
                                    </span>
                                    {event.account_name && (
                                        <span className="text-slate-600">
                                            Account: {event.account_name}
                                        </span>
                                    )}
                                </div>
                            </div>
                        );
                    }}
                />
            </div>
        </div>
    );
};

export default BalanceTimelineChart;
