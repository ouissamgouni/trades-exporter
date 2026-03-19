import React, { useState, useCallback, Suspense } from 'react';
import {
    Box,
    Button,
    Card,
    Center,
    Flex,
    Heading,
    HStack,
    IconButton,
    Spinner,
    Text,
    Badge,
} from '@chakra-ui/react';
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
    <Center h="200px">
        <Spinner size="lg" color="blue.500" />
    </Center>
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
        <Box>
            {/* Header with Year Navigation */}
            <Card.Root mb={4}>
                <Card.Body p={4}>
                    <Flex justify="space-between" align="center" mb={4}>
                        <Flex align="center" gap={3}>
                            <LuCalendar size={24} />
                            <Heading size="md">Transaction Timeline</Heading>
                            <IconButton
                                aria-label="Refresh timeline"
                                variant="ghost"
                                size="sm"
                                onClick={handleRefresh}
                                disabled={isFetching}
                            >
                                <LuRefreshCw style={{ animation: isFetching ? 'spin 1s linear infinite' : 'none' }} />
                            </IconButton>
                        </Flex>

                        {/* Year Navigation */}
                        <HStack gap={2}>
                            <IconButton
                                aria-label="Previous year"
                                variant="outline"
                                size="sm"
                                onClick={handlePrevYear}
                                disabled={!canGoPrev || isLoading}
                            >
                                <LuChevronLeft />
                            </IconButton>

                            <Badge
                                colorPalette="blue"
                                size="lg"
                                px={4}
                                py={2}
                                fontSize="md"
                                fontWeight="bold"
                            >
                                {selectedYear}
                            </Badge>

                            <IconButton
                                aria-label="Next year"
                                variant="outline"
                                size="sm"
                                onClick={handleNextYear}
                                disabled={!canGoNext || isLoading}
                            >
                                <LuChevronRight />
                            </IconButton>
                        </HStack>

                        {/* Year Summary */}
                        {timelineData && !hasNoData && (
                            <Flex align="center" gap={2}>
                                <Text fontSize="sm" color="gray.600">
                                    {timelineData.total_transactions.toLocaleString()} transactions
                                </Text>
                                {timelineData.excluded_invalid_count > 0 && (
                                    <Badge colorPalette="red" variant="subtle" size="sm">
                                        {timelineData.excluded_invalid_count} invalid excluded
                                    </Badge>
                                )}
                            </Flex>
                        )}
                    </Flex>

                    {/* Calendar Heatmap */}
                    {error && (
                        <Center h="200px">
                            <Text color="red.500">Failed to load timeline data</Text>
                        </Center>
                    )}
                    {!error && hasNoData && (
                        <Center h="200px" flexDirection="column" gap={2}>
                            <LuCalendar size={48} color="#9CA3AF" />
                            <Text fontSize="lg" fontWeight="medium" color="gray.600">
                                No activity in {selectedYear}
                            </Text>
                            <Text fontSize="sm" color="gray.500">
                                No transactions were recorded during this year.
                            </Text>
                            {timelineData && timelineData.min_year !== timelineData.max_year && (
                                <Text fontSize="sm" color="blue.500" mt={2}>
                                    Try navigating to {timelineData.max_year} for your most recent activity.
                                </Text>
                            )}
                        </Center>
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
                        <Flex justify="center" mt={4} gap={4} align="center">
                            <Text fontSize="xs" color="gray.500">Less</Text>
                            <Flex gap={1}>
                                <Box w={3} h={3} bg="#f3f4f6" borderRadius="sm" />
                                <Box w={3} h={3} bg="#d1fae5" borderRadius="sm" />
                                <Box w={3} h={3} bg="#6ee7b7" borderRadius="sm" />
                                <Box w={3} h={3} bg="#34d399" borderRadius="sm" />
                                <Box w={3} h={3} bg="#10b981" borderRadius="sm" />
                                <Box w={3} h={3} bg="#059669" borderRadius="sm" />
                            </Flex>
                            <Text fontSize="xs" color="gray.500">More</Text>
                        </Flex>
                    )}
                </Card.Body>
            </Card.Root>

            {/* Selected Date Transaction Table */}
            {selectedDate && (
                <Card.Root>
                    <Card.Body p={4}>
                        {/* Selection Header */}
                        <Flex justify="space-between" align="center" mb={4}>
                            <Flex align="center" gap={3}>
                                <Text fontSize="lg" fontWeight="bold">
                                    📅 {formatSelectedDate(selectedDate)}
                                </Text>
                                {selectedStats && (
                                    <HStack gap={2}>
                                        <Badge colorPalette="blue">
                                            {selectedStats.count} transaction{selectedStats.count === 1 ? '' : 's'}
                                        </Badge>
                                        {selectedStats.inflow_count > 0 && (
                                            <Badge colorPalette="green" variant="subtle">
                                                ↑ {selectedStats.inflow_count} inflow
                                            </Badge>
                                        )}
                                        {selectedStats.outflow_count > 0 && (
                                            <Badge colorPalette="red" variant="subtle">
                                                ↓ {selectedStats.outflow_count} outflow
                                            </Badge>
                                        )}
                                    </HStack>
                                )}
                            </Flex>

                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={handleClearSelection}
                            >
                                <LuX />
                                Clear Selection
                            </Button>
                        </Flex>

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
                    </Card.Body>
                </Card.Root>
            )}

            {/* Hint when no date selected */}
            {!selectedDate && !hasNoData && !isLoading && timelineData && (
                <Card.Root>
                    <Card.Body p={6}>
                        <Center flexDirection="column" gap={2} py={4}>
                            <Text fontSize="md" color="gray.600" fontWeight="medium">
                                Click on any day in the calendar to view transactions
                            </Text>
                            <Text fontSize="sm" color="gray.500">
                                Darker cells indicate more activity. Hover over a day for details.
                            </Text>
                        </Center>
                    </Card.Body>
                </Card.Root>
            )}
        </Box>
    );
};

export default TimelineSection;
