/**
 * Market Value Pie Chart
 * 
 * Displays market value distribution by category within a selected dimension.
 * Features:
 * - Dimension selector dropdown
 * - Interactive pie chart with click-to-filter
 * - Tooltip showing category details
 * - Legend with color-coded categories
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
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
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
    selectedCategoryIds: number[];
    /** Callback when a pie slice is clicked */
    onCategoryClick: (categoryId: number | null) => void;
}

/**
 * Format currency value for display
 */
const formatCurrency = (value: number, currency: string): string => {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency === 'USD' ? 'USD' : 'USD',  // Default to USD formatting
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    }).format(value).replace('$', `${currency} `);
};

/**
 * Custom tooltip for the pie chart
 */
interface CustomTooltipProps {
    active?: boolean;
    payload?: Array<{
        payload: PieChartDataPoint;
    }>;
    baseCurrency: string;
}

const CustomTooltip: React.FC<CustomTooltipProps> = ({ active, payload, baseCurrency }) => {
    if (!active || !payload || payload.length === 0) return null;

    const data = payload[0].payload;

    return (
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
                    bg={data.color}
                />
                <Text fontWeight="semibold">{data.label}</Text>
            </Flex>
            <Text fontSize="sm" color="gray.600">
                Value: {formatCurrency(data.value, baseCurrency)}
            </Text>
            <Text fontSize="sm" color="gray.600">
                Percentage: {data.percentage.toFixed(1)}%
            </Text>
            <Text fontSize="sm" color="gray.500">
                {data.assetCount} asset{data.assetCount !== 1 ? 's' : ''}
            </Text>
        </Box>
    );
};

/**
 * Custom legend that shows category names with values
 */
interface CustomLegendProps {
    payload?: Array<{
        value: string;
        color: string;
        payload: PieChartDataPoint;
    }>;
    baseCurrency: string;
    selectedCategoryIds: number[];
    onCategoryClick: (categoryId: number | null) => void;
}

const CustomLegend: React.FC<CustomLegendProps> = ({
    payload,
    baseCurrency,
    selectedCategoryIds,
    onCategoryClick
}) => {
    if (!payload) return null;

    return (
        <Box maxH="200px" overflowY="auto" pr={2}>
            {payload.map((entry, index) => {
                const data = entry.payload;
                const isSelected = data.categoryId !== null && selectedCategoryIds.includes(data.categoryId);

                return (
                    <Flex
                        key={index}
                        align="center"
                        gap={2}
                        py={1}
                        px={2}
                        borderRadius="md"
                        cursor="pointer"
                        bg={isSelected ? 'blue.50' : 'transparent'}
                        _hover={{ bg: isSelected ? 'blue.100' : 'gray.50' }}
                        onClick={() => onCategoryClick(data.categoryId)}
                    >
                        <Box
                            w={3}
                            h={3}
                            borderRadius="sm"
                            bg={entry.color}
                            flexShrink={0}
                        />
                        <Text fontSize="sm" flex={1} truncate>
                            {entry.value}
                        </Text>
                        <Text fontSize="xs" color="gray.500">
                            {data.percentage.toFixed(1)}%
                        </Text>
                    </Flex>
                );
            })}
        </Box>
    );
};

export const MarketValuePieChart: React.FC<MarketValuePieChartProps> = ({
    assets,
    dimensions,
    baseCurrency,
    selectedCategoryIds,
    onCategoryClick,
}) => {
    // Default to first dimension
    const [selectedDimensionId, setSelectedDimensionId] = useState<number | null>(
        dimensions.length > 0 ? dimensions[0].id : null
    );

    // Flatten all categories from all dimensions for the aggregation function
    const allCategories = useMemo(() => {
        const cats: Category[] = [];
        for (const dim of dimensions) {
            cats.push(...dim.categories);
        }
        return cats;
    }, [dimensions]);

    // Compute pie chart data
    const pieData = useMemo(() => {
        if (selectedDimensionId === null || assets.length === 0) {
            return [];
        }
        return aggregateMarketValueByCategory(assets, selectedDimensionId, allCategories);
    }, [assets, selectedDimensionId, allCategories]);

    // Total market value for display
    const totalMarketValue = useMemo(() => {
        return assets.reduce((sum, a) => sum + a.market_value, 0);
    }, [assets]);

    // Handle pie slice click
    const handlePieClick = useCallback((data: PieChartDataPoint) => {
        onCategoryClick(data.categoryId);
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
                <Flex direction={{ base: 'column', md: 'row' }} gap={4}>
                    {/* Pie Chart */}
                    <Box flex={1} minH="250px">
                        <ResponsiveContainer width="100%" height={250}>
                            <PieChart>
                                <Pie
                                    data={pieData as any[]}
                                    dataKey="value"
                                    nameKey="label"
                                    cx="50%"
                                    cy="50%"
                                    innerRadius={50}
                                    outerRadius={90}
                                    paddingAngle={2}
                                    onClick={(_, index) => handlePieClick(pieData[index])}
                                    style={{ cursor: 'pointer' }}
                                >
                                    {pieData.map((entry, index) => {
                                        const isSelected = entry.categoryId !== null &&
                                            selectedCategoryIds.includes(entry.categoryId);
                                        return (
                                            <Cell
                                                key={`cell-${index}`}
                                                fill={entry.color}
                                                stroke={isSelected ? '#2563eb' : '#fff'}
                                                strokeWidth={isSelected ? 3 : 1}
                                                opacity={
                                                    selectedCategoryIds.length === 0
                                                        ? 1
                                                        : isSelected ? 1 : 0.5
                                                }
                                            />
                                        );
                                    })}
                                </Pie>
                                <Tooltip content={<CustomTooltip baseCurrency={baseCurrency} />} />
                            </PieChart>
                        </ResponsiveContainer>
                    </Box>

                    {/* Legend */}
                    <Box minW="200px" maxW="280px">
                        <Text fontSize="xs" fontWeight="medium" color="gray.500" mb={2}>
                            Click to filter
                        </Text>
                        <CustomLegend
                            payload={pieData.map(d => ({
                                value: d.label,
                                color: d.color,
                                payload: d,
                            }))}
                            baseCurrency={baseCurrency}
                            selectedCategoryIds={selectedCategoryIds}
                            onCategoryClick={onCategoryClick}
                        />
                    </Box>
                </Flex>
            )}
        </Box>
    );
};

export default MarketValuePieChart;
