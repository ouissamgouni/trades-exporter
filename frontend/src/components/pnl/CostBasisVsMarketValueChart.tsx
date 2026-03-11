/**
 * CostBasisVsMarketValueChart
 *
 * Dual-line chart: Market Value vs Cost Basis over time.
 * Zoom presets: All / 1Y / 6M / 3M / 1M.
 */
import React, { useMemo, useState } from 'react';
import { Badge, Box, Flex, Heading, Text } from '@chakra-ui/react';
import { ResponsiveLine } from '@nivo/line';
import type { TimelinePoint } from '../../hooks/useChartData';

interface CostBasisVsMarketValueChartProps {
    points: TimelinePoint[];
    baseCurrency: string;
    isLoading?: boolean;
}

type ZoomPreset = 'all' | '1y' | '6m' | '3m' | '1m';

const ZOOM_PRESETS: Record<ZoomPreset, { label: string; days: number | null }> = {
    all: { label: 'All', days: null },
    '1y': { label: '1Y', days: 365 },
    '6m': { label: '6M', days: 180 },
    '3m': { label: '3M', days: 90 },
    '1m': { label: '1M', days: 30 },
};

function formatCompact(val: number): string {
    const abs = Math.abs(val);
    if (abs >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
    return val.toFixed(0);
}

function getAxisDateFormat(totalDays: number): string {
    if (totalDays < 7) return '%m/%d';
    if (totalDays < 90) return '%b %d';
    if (totalDays < 365) return '%b %y';
    return '%Y';
}

function getTickValues(totalDays: number): string {
    if (totalDays > 730) return 'every 6 months';
    if (totalDays > 365) return 'every 3 months';
    if (totalDays > 180) return 'every 2 months';
    return 'every 1 month';
}

export const CostBasisVsMarketValueChart: React.FC<CostBasisVsMarketValueChartProps> = ({
    points,
    baseCurrency,
    isLoading,
}) => {
    const [zoom, setZoom] = useState<ZoomPreset>('all');

    // ----- Time-series data (Total view) -----
    const filteredPoints = useMemo(() => {
        const preset = ZOOM_PRESETS[zoom];
        if (!preset.days) return points;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - preset.days);
        const cutoffStr = cutoff.toISOString().split('T')[0];
        const filtered = points.filter(p => p.date >= cutoffStr);
        return filtered.length >= 2 ? filtered : points;
    }, [points, zoom]);

    const lineData = useMemo(() => {
        if (!filteredPoints.length) return [];
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
        <Box p={4} bg="white" borderRadius="md" border="1px solid" borderColor="gray.200" mb={4}>
            <Flex justify="space-between" align="center" mb={3} wrap="wrap" gap={2}>
                <Heading size="sm" color="gray.700">Cost Basis vs Market Value</Heading>
                <Flex gap={1}>
                    {(Object.keys(ZOOM_PRESETS) as ZoomPreset[]).map(k => (
                        <Badge
                            key={k}
                            cursor="pointer"
                            variant={zoom === k ? 'solid' : 'outline'}
                            colorPalette={zoom === k ? 'purple' : 'gray'}
                            onClick={() => setZoom(k)}
                            size="sm"
                            px={2}
                        >
                            {ZOOM_PRESETS[k].label}
                        </Badge>
                    ))}
                </Flex>
            </Flex>

            {isLoading ? (
                <Box h="300px" display="flex" alignItems="center" justifyContent="center">
                    <Text fontSize="sm" color="gray.400">Loading...</Text>
                </Box>
            ) : (
                <Box h="300px">
                    <ResponsiveLine
                        data={lineData}
                        margin={{ top: 20, right: 30, bottom: 50, left: 70 }}
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
                                <Box bg="white" p={2} borderRadius="md" boxShadow="md" border="1px solid" borderColor="gray.200" minW="180px">
                                    <Text fontSize="xs" fontWeight="bold" color="gray.600" mb={1}>
                                        {slice.points[0]?.data.xFormatted}
                                    </Text>
                                    {slice.points.map(p => (
                                        <Flex key={p.id} justify="space-between" gap={3}>
                                            <Flex align="center" gap={1}>
                                                <Box w="8px" h="8px" borderRadius="full" bg={p.seriesColor} />
                                                <Text fontSize="xs">{p.seriesId}</Text>
                                            </Flex>
                                            <Text fontSize="xs" fontWeight="bold">
                                                {Number(p.data.yFormatted).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                            </Text>
                                        </Flex>
                                    ))}
                                    <Box borderTop="1px solid" borderColor="gray.100" mt={1} pt={1}>
                                        <Flex justify="space-between">
                                            <Text fontSize="xs" color="gray.500">Unrealized</Text>
                                            <Text fontSize="xs" fontWeight="bold" color={unrealized >= 0 ? 'green.600' : 'red.600'}>
                                                {unrealized >= 0 ? '+' : ''}{formatCompact(unrealized)} {baseCurrency}
                                            </Text>
                                        </Flex>
                                    </Box>
                                </Box>
                            );
                        }}
                        legends={[{
                            anchor: 'bottom',
                            direction: 'row',
                            translateX: 0,
                            translateY: 45,
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
                </Box>
            )}
        </Box>
    );
};
