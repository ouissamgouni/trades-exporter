import React, { useState, useCallback, Suspense } from 'react';
import { Badge, Button, Heading, Spinner } from './ui/primitives';
import { LuChevronLeft, LuChevronRight, LuCalendar, LuX, LuRefreshCw } from 'react-icons/lu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL } from '../types';
import { CalendarHeatmap, DailyStats } from './CalendarHeatmap';
import { TransactionFilterState, defaultFilterState } from './TransactionFilters';

// Lazy load TransactionsTable for performance
const TransactionsTable = React.lazy(() =>
    import('./TransactionsTable').then(m => ({ default: m.TransactionsTable }))
);

interface TimelineStatsResponse {
    year: number;
    daily_stats: DailyStats[];
    total_transactions: number;
    excluded_invalid_count: number;
    min_year: number;
    max_year: number;
}

// Loading fallback for lazy-loaded table
const TableLoadingFallback = () => (
    <div className="flex h-[200px] items-center justify-center">
        <Spinner size="lg" className="text-blue-500" />
    </div>
);

export const TimelineSection: React.FC = () => {
    // Current year for initial view
    const currentYear = new Date().getFullYear();
    const queryClient = useQueryClient();

    // State
    const [selectedYear, setSelectedYear] = useState(currentYear);
    const [selectedDate, setSelectedDate] = useState<string | null>(null);
    const [selectedStats, setSelectedStats] = useState<DailyStats | null>(null);

    // Fetch timeline stats for selected year
    const {
        data: timelineData,
        isLoading,
        error,
        isFetching,
    } = useQuery<TimelineStatsResponse>({
        queryKey: ['timeline-stats', selectedYear],
        queryFn: async () => {
            const response = await fetch(`${API_URL}/timeline/daily-stats?year=${selectedYear}`);
            if (!response.ok) {
                throw new Error('Failed to fetch timeline data');
            }
            return response.json();
        },
        staleTime: 60000, // Cache for 1 minute
    });

    // Refresh handler
    const handleRefresh = () => {
        queryClient.invalidateQueries({ queryKey: ['timeline-stats', selectedYear] });
    };

    // Year navigation
    const canGoPrev = timelineData ? selectedYear > timelineData.min_year : false;
    const canGoNext = timelineData ? selectedYear < timelineData.max_year : false;

    const handlePrevYear = () => {
        if (canGoPrev) {
            setSelectedYear(prev => prev - 1);
            setSelectedDate(null);
            setSelectedStats(null);
        }
    };

    const handleNextYear = () => {
        if (canGoNext) {
            setSelectedYear(prev => prev + 1);
            setSelectedDate(null);
            setSelectedStats(null);
        }
    };

    // Handle date selection from heatmap
    const handleDateClick = useCallback((date: string, stats: DailyStats | null) => {
        if (selectedDate === date) {
            // Toggle off if clicking same date
            setSelectedDate(null);
            setSelectedStats(null);
        } else {
            setSelectedDate(date);
            setSelectedStats(stats);
        }
    }, [selectedDate]);

    // Clear selection
    const handleClearSelection = () => {
        setSelectedDate(null);
        setSelectedStats(null);
    };

    // Format date for display
    const formatSelectedDate = (dateStr: string) => {
        const date = new Date(dateStr + 'T00:00:00');
        return date.toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
        });
    };

    // Build filters for TransactionsTable when date is selected
    const getDateFilters = (): Partial<TransactionFilterState> => {
        if (!selectedDate) return {};
        return {
            dateFrom: selectedDate,
            dateTo: selectedDate,
            reviewStatus: [], // Show all statuses in timeline view
        };
    };

    // Check if year has no data
    const hasNoData = timelineData?.total_transactions === 0;

    return (
        <div>
            {/* Header with Year Navigation */}
            <div className="mb-4 border border-slate-200 bg-white p-4">
                <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <LuCalendar size={24} />
                        <Heading className="text-lg">Transaction Timeline</Heading>
                        <Button
                            aria-label="Refresh timeline"
                            variant="ghost"
                            size="sm"
                            onClick={handleRefresh}
                            disabled={isFetching}
                        >
                            <LuRefreshCw className={isFetching ? 'animate-spin' : ''} />
                        </Button>
                    </div>

                    {/* Year Navigation */}
                    <div className="flex items-center gap-2">
                        <Button
                            aria-label="Previous year"
                            variant="outline"
                            size="sm"
                            onClick={handlePrevYear}
                            disabled={!canGoPrev || isLoading}
                        >
                            <LuChevronLeft />
                        </Button>

                        <Badge
                            colorScheme="blue"
                            className="px-4 py-2 text-base font-bold"
                        >
                            {selectedYear}
                        </Badge>

                        <Button
                            aria-label="Next year"
                            variant="outline"
                            size="sm"
                            onClick={handleNextYear}
                            disabled={!canGoNext || isLoading}
                        >
                            <LuChevronRight />
                        </Button>
                    </div>

                    {/* Year Summary */}
                    {timelineData && !hasNoData && (
                        <div className="flex items-center gap-2">
                            <span className="text-sm text-slate-600">
                                {timelineData.total_transactions.toLocaleString()} transactions
                            </span>
                            {timelineData.excluded_invalid_count > 0 && (
                                <Badge colorScheme="red">
                                    {timelineData.excluded_invalid_count} rejected excluded
                                </Badge>
                            )}
                        </div>
                    )}
                </div>

                {/* Calendar Heatmap */}
                {error && (
                    <div className="flex h-[200px] items-center justify-center">
                        <span className="text-red-500">Failed to load timeline data</span>
                    </div>
                )}
                {!error && hasNoData && (
                    <div className="flex h-[200px] flex-col items-center justify-center gap-2">
                        <LuCalendar size={48} color="#9CA3AF" />
                        <span className="text-lg font-medium text-slate-600">
                            No activity in {selectedYear}
                        </span>
                        <span className="text-sm text-slate-500">
                            No transactions were recorded during this year.
                        </span>
                        {timelineData && timelineData.min_year !== timelineData.max_year && (
                            <span className="mt-2 block text-sm text-blue-500">
                                Try navigating to {timelineData.max_year} for your most recent activity.
                            </span>
                        )}
                    </div>
                )}
                {!error && !hasNoData && (
                    <CalendarHeatmap
                        year={selectedYear}
                        data={timelineData?.daily_stats || []}
                        selectedDate={selectedDate}
                        onDateClick={handleDateClick}
                        isLoading={isLoading}
                    />
                )}

                {/* Legend */}
                {!hasNoData && !isLoading && (
                    <div className="mt-4 flex items-center justify-center gap-4">
                        <span className="text-xs text-slate-500">Less</span>
                        <div className="flex gap-1">
                            <div className="h-3 w-3 rounded-sm bg-[#f3f4f6]" />
                            <div className="h-3 w-3 rounded-sm bg-[#d1fae5]" />
                            <div className="h-3 w-3 rounded-sm bg-[#6ee7b7]" />
                            <div className="h-3 w-3 rounded-sm bg-[#34d399]" />
                            <div className="h-3 w-3 rounded-sm bg-[#10b981]" />
                            <div className="h-3 w-3 rounded-sm bg-[#059669]" />
                        </div>
                        <span className="text-xs text-slate-500">More</span>
                    </div>
                )}
            </div>

            {/* Selected Date Transaction Table */}
            {selectedDate && (
                <div className="border border-slate-200 bg-white p-4">
                    {/* Selection Header */}
                    <div className="mb-4 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <span className="text-lg font-bold">
                                📅 {formatSelectedDate(selectedDate)}
                            </span>
                            {selectedStats && (
                                <div className="flex items-center gap-2">
                                    <Badge colorScheme="blue">
                                        {selectedStats.count} transaction{selectedStats.count === 1 ? '' : 's'}
                                    </Badge>
                                    {selectedStats.inflow_count > 0 && (
                                        <Badge colorScheme="green">
                                            ↑ {selectedStats.inflow_count} inflow
                                        </Badge>
                                    )}
                                    {selectedStats.outflow_count > 0 && (
                                        <Badge colorScheme="red">
                                            ↓ {selectedStats.outflow_count} outflow
                                        </Badge>
                                    )}
                                </div>
                            )}
                        </div>

                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleClearSelection}
                        >
                            <LuX />
                            Clear Selection
                        </Button>
                    </div>

                    {/* Transactions Table */}
                    <Suspense fallback={<TableLoadingFallback />}>
                        <TransactionsTable
                            tableId="timeline"
                            key={selectedDate}
                            title=""
                            subtitle=""
                            filters={{ ...defaultFilterState, ...getDateFilters() }}
                            showFilters={false}
                            showBundles={false}
                            showSuggestions={false}
                            compact={false}
                            emptyMessage={`No transactions found on ${formatSelectedDate(selectedDate)}`}
                        />
                    </Suspense>
                </div>
            )}

            {/* Hint when no date selected */}
            {!selectedDate && !hasNoData && !isLoading && timelineData && (
                <div className="border border-slate-200 bg-white p-6">
                    <div className="flex flex-col items-center justify-center gap-2 py-4">
                        <span className="text-base font-medium text-slate-600">
                            Click on any day in the calendar to view transactions
                        </span>
                        <span className="text-sm text-slate-500">
                            Darker cells indicate more activity. Hover over a day for details.
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
};

export default TimelineSection;
