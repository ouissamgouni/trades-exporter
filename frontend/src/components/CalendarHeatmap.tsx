import React, { useMemo, useCallback } from 'react';
import { Box, Text, Flex, Badge } from '@chakra-ui/react';
import { ResponsiveCalendar, CalendarTooltipProps } from '@nivo/calendar';

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
            <Box
                bg="white"
                p={3}
                borderRadius="md"
                boxShadow="lg"
                border="1px solid"
                borderColor="gray.200"
                minW="180px"
            >
                <Text fontWeight="bold" fontSize="sm" mb={2}>
                    {formatTooltipDate(day)}
                </Text>
                <Flex direction="column" gap={1}>
                    <Flex justify="space-between" align="center">
                        <Text fontSize="xs" color="gray.600">Transactions:</Text>
                        <Badge colorPalette="blue" size="sm">{numValue}</Badge>
                    </Flex>
                    {dayStats && (
                        <>
                            <Flex justify="space-between" align="center">
                                <Text fontSize="xs" color="gray.600">Volume:</Text>
                                <Text fontSize="xs" fontWeight="medium">{formatVolume(dayStats.volume)}</Text>
                            </Flex>
                            <Flex justify="space-between" align="center" gap={2}>
                                <Text fontSize="xs" color="gray.600">Flow:</Text>
                                <Flex gap={1}>
                                    <Badge colorPalette="green" size="sm" variant="subtle">
                                        ↓{dayStats.inflow_count}
                                    </Badge>
                                    <Badge colorPalette="red" size="sm" variant="subtle">
                                        ↑{dayStats.outflow_count}
                                    </Badge>
                                </Flex>
                            </Flex>
                        </>
                    )}
                </Flex>
                <Text fontSize="xs" color="blue.500" mt={2} textAlign="center">
                    Click to view transactions
                </Text>
            </Box>
        );
    }, [statsMap]);

    if (isLoading) {
        return (
            <Box h="200px" display="flex" alignItems="center" justifyContent="center">
                <Text color="gray.500">Loading calendar data...</Text>
            </Box>
        );
    }

    return (
        <Box h="200px" w="100%">
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
        </Box>
    );
};
