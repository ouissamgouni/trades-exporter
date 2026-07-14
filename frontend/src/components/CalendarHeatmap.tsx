import React, { useMemo, useCallback } from 'react';
import { ResponsiveCalendar, CalendarTooltipProps } from '@nivo/calendar';
import { Badge } from './ui/primitives';

export interface DailyStats {
    date: string;
    count: number;
    volume: number;
    inflow_count: number;
    outflow_count: number;
}

interface CalendarHeatmapProps {
    year: number;
    data: DailyStats[];
    selectedDate: string | null;
    onDateClick: (date: string, stats: DailyStats | null) => void;
    isLoading?: boolean;
}

// Helper functions for formatting
const formatTooltipDate = (dateStr: string) => {
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });
};

const formatVolume = (vol: number) => {
    if (vol >= 1000000) return `$${(vol / 1000000).toFixed(1)}M`;
    if (vol >= 1000) return `$${(vol / 1000).toFixed(1)}K`;
    return `$${vol.toFixed(2)}`;
};

export const CalendarHeatmap: React.FC<CalendarHeatmapProps> = ({
    year,
    data,
    selectedDate,
    onDateClick,
    isLoading = false,
}) => {
    // Transform data for Nivo calendar format
    const calendarData = useMemo(() => {
        return data.map(d => ({
            day: d.date,
            value: d.count,
        }));
    }, [data]);

    // Create a lookup map for full stats
    const statsMap = useMemo(() => {
        const map = new Map<string, DailyStats>();
        data.forEach(d => map.set(d.date, d));
        return map;
    }, [data]);

    // GitHub-style green color scheme
    const colors = [
        '#d1fae5', // Very light green (1-2 txns)
        '#6ee7b7', // Light green
        '#34d399', // Medium green
        '#10b981', // Green
        '#059669', // Dark green (many txns)
    ];

    const handleDayClick = (day: { day: string; value?: number }) => {
        const stats = statsMap.get(day.day) || null;
        onDateClick(day.day, stats);
    };

    // Custom tooltip render function
    const renderTooltip = useCallback(({ day, value }: CalendarTooltipProps) => {
        const dayStats = statsMap.get(day);
        const numValue = typeof value === 'number' ? value : 0;

        return (
            <div className="min-w-[180px] border border-slate-200 bg-white p-3 shadow-lg">
                <span className="mb-2 block text-sm font-bold">
                    {formatTooltipDate(day)}
                </span>
                <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-600">Transactions:</span>
                        <Badge colorScheme="blue">{numValue}</Badge>
                    </div>
                    {dayStats && (
                        <>
                            <div className="flex items-center justify-between">
                                <span className="text-xs text-slate-600">Volume:</span>
                                <span className="text-xs font-medium">{formatVolume(dayStats.volume)}</span>
                            </div>
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-xs text-slate-600">Flow:</span>
                                <div className="flex gap-1">
                                    <Badge colorScheme="green">
                                        ↓{dayStats.inflow_count}
                                    </Badge>
                                    <Badge colorScheme="red">
                                        ↑{dayStats.outflow_count}
                                    </Badge>
                                </div>
                            </div>
                        </>
                    )}
                </div>
                <span className="mt-2 block text-center text-xs text-blue-500">
                    Click to view transactions
                </span>
            </div>
        );
    }, [statsMap]);

    if (isLoading) {
        return (
            <div className="flex h-[200px] items-center justify-center">
                <span className="text-slate-500">Loading calendar data...</span>
            </div>
        );
    }

    return (
        <div className="h-[200px] w-full">
            <ResponsiveCalendar
                data={calendarData}
                from={`${year}-01-01`}
                to={`${year}-12-31`}
                emptyColor="#f3f4f6"
                colors={colors}
                margin={{ top: 20, right: 20, bottom: 20, left: 20 }}
                yearSpacing={40}
                monthBorderColor="#ffffff"
                dayBorderWidth={2}
                dayBorderColor="#ffffff"
                monthLegendPosition="before"
                monthLegendOffset={10}
                legends={[
                    {
                        anchor: 'bottom-right',
                        direction: 'row',
                        translateY: 36,
                        itemCount: 5,
                        itemWidth: 42,
                        itemHeight: 36,
                        itemsSpacing: 14,
                        itemDirection: 'right-to-left',
                    },
                ]}
                tooltip={renderTooltip}
                onClick={handleDayClick}
                theme={{
                    labels: {
                        text: {
                            fontSize: 11,
                            fill: '#6b7280',
                        },
                    },
                }}
            />
        </div>
    );
};
