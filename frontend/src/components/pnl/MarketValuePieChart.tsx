/**
 * Market Value Pie Chart (Nivo)
 * 
 * Displays market value distribution by category within a selected dimension.
 * Features:
 * - Dimension selector dropdown
 * - Interactive pie chart with click-to-filter
 * - Built-in arc link labels with connector lines
 * - Tooltip showing category details
 * - "Uncategorized" slice for assets without category in selected dimension
 */

import React, { useMemo, useState, useCallback } from 'react';
import {
    Box,
    Flex,
    Heading,
    NativeSelect,
    Text,
} from '@chakra-ui/react';
import { ResponsivePie } from '@nivo/pie';
import { DimensionWithCategories, Category } from '../../types';
import { AssetPnLRow, PieChartDataPoint, aggregateMarketValueByCategory } from './types';

export interface MarketValuePieChartProps {
    /** Assets with market value and category_ids */
    assets: AssetPnLRow[];
    /** Dimensions with their categories */
    dimensions: DimensionWithCategories[];
    /** Base currency symbol for formatting */
    baseCurrency: string;
    /** Currently selected category IDs (for highlighting active filter) */
    selectedCategoryIds?: number[];
    /** Callback when a pie slice is clicked */
    onCategoryClick?: (categoryId: number | null) => void;
}

/**
 * Format currency value for display
 */
const formatCurrency = (value: number, currency: string): string => {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    }).format(value).replace('$', `${currency} `);
};

/**
 * Nivo pie data format
 */
interface NivoPieData {
    id: string;
    label: string;
    value: number;
    color: string;
    categoryId: number | null;
    percentage: number;
    assetCount: number;
}

export const MarketValuePieChart: React.FC<MarketValuePieChartProps> = ({
    assets,
    dimensions,
    baseCurrency,
    selectedCategoryIds = [],
    onCategoryClick,
}) => {
    // Default to first dimension
    const [selectedDimensionId, setSelectedDimensionId] = useState<number | null>(null);

    // Set initial dimension when dimensions load
    React.useEffect(() => {
        if (dimensions.length > 0 && selectedDimensionId === null) {
            setSelectedDimensionId(dimensions[0].id);
        }
    }, [dimensions, selectedDimensionId]);

    // Flatten all categories from all dimensions for the aggregation function
    const allCategories = useMemo(() => {
        const cats: Category[] = [];
        for (const dim of dimensions) {
            cats.push(...dim.categories);
        }
        return cats;
    }, [dimensions]);

    // Compute pie chart data and convert to Nivo format
    const pieData = useMemo((): NivoPieData[] => {
        if (selectedDimensionId === null || assets.length === 0) {
            return [];
        }
        const rawData = aggregateMarketValueByCategory(assets, selectedDimensionId, allCategories);
        return rawData.map((d: PieChartDataPoint) => ({
            id: d.label,
            label: d.label,
            value: d.value,
            color: d.color,
            categoryId: d.categoryId,
            percentage: d.percentage,
            assetCount: d.assetCount,
        }));
    }, [assets, selectedDimensionId, allCategories]);

    // Total market value for display
    const totalMarketValue = useMemo(() => {
        return assets.reduce((sum, a) => sum + a.market_value, 0);
    }, [assets]);

    // Handle pie slice click
    const handlePieClick = useCallback((data: NivoPieData) => {
        onCategoryClick?.(data.categoryId);
    }, [onCategoryClick]);

    // Handle dimension change via native select
    const handleDimensionChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
        const newId = e.target.value ? parseInt(e.target.value, 10) : null;
        setSelectedDimensionId(newId);
    }, []);

    // Empty state
    if (dimensions.length === 0) {
        return null;
    }

    if (assets.length === 0 || totalMarketValue === 0) {
        return (
            <Box
                p={4}
                bg="gray.50"
                borderRadius="md"
                border="1px solid"
                borderColor="gray.200"
                mb={4}
            >
                <Heading size="sm" mb={2}>Market Value by Category</Heading>
                <Text fontSize="sm" color="gray.500">
                    No market value data available. Refresh prices to see the distribution.
                </Text>
            </Box>
        );
    }

    return (
        <Box
            p={4}
            bg="white"
            borderRadius="md"
            border="1px solid"
            borderColor="gray.200"
            mb={4}
        >
            {/* Header with dimension selector */}
            <Flex justify="space-between" align="center" mb={4}>
                <Heading size="sm">Market Value by Category</Heading>
                <NativeSelect.Root size="sm" width="180px">
                    <NativeSelect.Field
                        value={selectedDimensionId !== null ? String(selectedDimensionId) : ''}
                        onChange={handleDimensionChange}
                    >
                        {dimensions.map(dim => (
                            <option key={dim.id} value={String(dim.id)}>
                                {dim.label}
                            </option>
                        ))}
                    </NativeSelect.Field>
                </NativeSelect.Root>
            </Flex>

            {/* Total value display */}
            <Text fontSize="sm" color="gray.600" mb={3}>
                Total: {formatCurrency(totalMarketValue, baseCurrency)}
            </Text>

            {pieData.length === 0 ? (
                <Text fontSize="sm" color="gray.500" textAlign="center" py={8}>
                    No categories assigned in this dimension.
                </Text>
            ) : (
                <Box h="320px">
                    <ResponsivePie
                        data={pieData}
                        margin={{ top: 40, right: 100, bottom: 40, left: 100 }}
                        innerRadius={0.5}
                        padAngle={1}
                        cornerRadius={3}
                        activeOuterRadiusOffset={8}
                        colors={{ datum: 'data.color' }}
                        borderWidth={1}
                        borderColor={{ from: 'color', modifiers: [['darker', 0.2]] }}
                        // Arc link labels (connector lines)
                        arcLinkLabelsSkipAngle={10}
                        arcLinkLabelsTextColor="#374151"
                        arcLinkLabelsThickness={1}
                        arcLinkLabelsColor={{ from: 'color' }}
                        arcLinkLabelsDiagonalLength={16}
                        arcLinkLabelsStraightLength={12}
                        arcLinkLabelsTextOffset={4}
                        arcLinkLabel={d => `${d.label} (${d.data.percentage.toFixed(1)}%)`}
                        // Arc labels (inside slices) - disabled for cleaner look
                        enableArcLabels={false}
                        // Tooltip
                        tooltip={({ datum }) => (
                            <Box
                                bg="white"
                                p={3}
                                borderRadius="md"
                                boxShadow="lg"
                                border="1px solid"
                                borderColor="gray.200"
                            >
                                <Flex align="center" gap={2} mb={1}>
                                    <Box
                                        w={3}
                                        h={3}
                                        borderRadius="sm"
                                        bg={datum.color}
                                    />
                                    <Text fontWeight="semibold">{datum.label}</Text>
                                </Flex>
                                <Text fontSize="sm" color="gray.600">
                                    Value: {formatCurrency(datum.value, baseCurrency)}
                                </Text>
                                <Text fontSize="sm" color="gray.600">
                                    Percentage: {datum.data.percentage.toFixed(1)}%
                                </Text>
                                <Text fontSize="sm" color="gray.500">
                                    {datum.data.assetCount} asset{datum.data.assetCount !== 1 ? 's' : ''}
                                </Text>
                            </Box>
                        )}
                        // Interactivity
                        onClick={(data) => handlePieClick(data.data as NivoPieData)}
                        // Selection highlighting via activeId
                        activeId={
                            selectedCategoryIds.length > 0
                                ? pieData.find(d => d.categoryId !== null && selectedCategoryIds.includes(d.categoryId))?.id
                                : undefined
                        }
                        // Theme
                        theme={{
                            labels: {
                                text: {
                                    fontSize: 10,
                                    fontFamily: 'inherit',
                                }
                            },
                            tooltip: {
                                container: {
                                    fontFamily: 'inherit',
                                }
                            }
                        }}
                    />
                </Box>
            )}
        </Box>
    );
};

export default MarketValuePieChart;
