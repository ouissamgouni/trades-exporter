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
import {
    type ZoomPreset,
    ZOOM_PRESETS,
    formatCompact,
    getAxisDateFormat,
    getTickValues,
    filterPointsByZoom,
} from './chartUtils';

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
        <Box p={hideControls ? 0 : 4} bg="white" borderRadius={hideControls ? 'none' : 'md'} border={hideControls ? 'none' : '1px solid'} borderColor="gray.200" mb={hideControls ? 0 : 4}>
            {!hideControls && (
                <Flex justify="space-between" align="center" mb={3} wrap="wrap" gap={2}>
                    <Heading size="sm" color="gray.700">{contextLabel ? `${contextLabel} — Cost Basis vs Market Value` : 'Cost Basis vs Market Value'}</Heading>
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
            )}

            {isLoading ? (
                <Box h={height} display="flex" alignItems="center" justifyContent="center">
                    <Text fontSize="sm" color="gray.400">Loading...</Text>
                </Box>
            ) : lineData.length === 0 ? (
                <Box h={height} display="flex" alignItems="center" justifyContent="center">
                    <Text fontSize="xs" color="gray.400">Not enough data</Text>
                </Box>
            ) : (
                <Box h={height}>
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
                </Box>
            )}
        </Box>
    );
};
