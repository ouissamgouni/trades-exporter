/**
 * Performance Bar Chart (Nivo)
 * 
 * Displays best and worst performing items by unrealized P&L.
 * Features:
 * - Horizontal bar chart sorted by unrealized P&L
 * - Toggle between "By Asset" and "By Category" views
 * - Configurable number of items to display (slider)
 * - Gradient color scheme (green for gains, red for losses)
 * - Click to filter assets
 */

import React, { useMemo, useState, useCallback } from 'react';
import {
    Box,
    Flex,
    Heading,
    Text,
    NativeSelect,
    Slider,
} from '@chakra-ui/react';
import { ResponsiveBar, BarDatum } from '@nivo/bar';
import { DimensionWithCategories, Category } from '../../types';
import { AssetPnLRow } from './types';

export interface PerformanceBarChartProps {
    /** Assets with unrealized P&L data */
    assets: AssetPnLRow[];
    /** Dimensions with their categories */
    dimensions: DimensionWithCategories[];
    /** Base currency symbol for formatting */
    baseCurrency: string;
    /** Callback when a bar is clicked (asset_id for assets, category_id for categories) */
    onItemClick?: (itemId: number, type: 'asset' | 'category') => void;
}

type ViewMode = 'asset' | 'category';

// Nivo-compatible bar data type
interface BarDataItem extends BarDatum {
    id: number;
    name: string;
    value: number;
    positiveValue: number;
    negativeValue: number;
    percentage: number;
    itemType: string; // 'asset' or 'category' - renamed to avoid conflict
    color: string;
}

/**
 * Format currency value for display (compact)
 */
const formatCurrency = (value: number, currency: string): string => {
    const absValue = Math.abs(value);
    let formatted: string;

    if (absValue >= 1_000_000) {
        formatted = `${(value / 1_000_000).toFixed(1)}M`;
    } else if (absValue >= 1_000) {
        formatted = `${(value / 1_000).toFixed(1)}K`;
    } else {
        formatted = value.toFixed(0);
    }

    return `${currency} ${formatted}`;
};

/**
 * Get gradient color based on value (green for positive, red for negative)
 */
const getGradientColor = (value: number, maxAbsValue: number): string => {
    if (maxAbsValue === 0) return '#94a3b8';

    const intensity = Math.min(Math.abs(value) / maxAbsValue, 1);

    if (value >= 0) {
        // Green gradient: from light green to dark green
        const r = Math.round(34 + (1 - intensity) * 150);
        const g = Math.round(197 - intensity * 50);
        const b = Math.round(94 + (1 - intensity) * 100);
        return `rgb(${r}, ${g}, ${b})`;
    } else {
        // Red gradient: from light red to dark red
        const r = Math.round(239 - intensity * 50);
        const g = Math.round(68 + (1 - intensity) * 120);
        const b = Math.round(68 + (1 - intensity) * 120);
        return `rgb(${r}, ${g}, ${b})`;
    }
};

/**
 * Aggregate unrealized P&L by category
 */
function aggregateByCategory(
    assets: AssetPnLRow[],
    dimensionId: number,
    categories: Category[],
    maxAbsValue: number
): BarDataItem[] {
    const categoryMap = new Map<number, { pnl: number; costBasis: number }>();
    const categoryLookup = new Map(categories.map(c => [c.id, c]));

    const dimensionCategories = categories.filter(c => c.dimension_id === dimensionId);
    const dimensionCategoryIds = new Set(dimensionCategories.map(c => c.id));

    for (const asset of assets) {
        const assetCategories = asset.category_ids.filter(id => dimensionCategoryIds.has(id));

        if (assetCategories.length === 0) continue;

        const share = 1 / assetCategories.length;
        for (const catId of assetCategories) {
            const existing = categoryMap.get(catId) || { pnl: 0, costBasis: 0 };
            existing.pnl += asset.unrealized_pnl * share;
            existing.costBasis += asset.cost_basis * share;
            categoryMap.set(catId, existing);
        }
    }

    return Array.from(categoryMap.entries()).map(([catId, data]) => {
        const category = categoryLookup.get(catId);
        const percentage = data.costBasis !== 0 ? (data.pnl / data.costBasis) * 100 : 0;
        return {
            id: catId,
            name: category?.label || 'Unknown',
            value: data.pnl,
            positiveValue: data.pnl >= 0 ? data.pnl : 0,
            negativeValue: data.pnl < 0 ? data.pnl : 0,
            percentage,
            itemType: 'category',
            color: getGradientColor(data.pnl, maxAbsValue),
        };
    });
}

export const PerformanceBarChart: React.FC<PerformanceBarChartProps> = ({
    assets,
    dimensions,
    baseCurrency,
    onItemClick,
}) => {
    const [viewMode, setViewMode] = useState<ViewMode>('asset');
    const [itemCount, setItemCount] = useState<number>(7);
    const [selectedDimensionId, setSelectedDimensionId] = useState<number | null>(null);

    // Set initial dimension when dimensions load
    React.useEffect(() => {
        if (dimensions.length > 0 && selectedDimensionId === null) {
            setSelectedDimensionId(dimensions[0].id);
        }
    }, [dimensions, selectedDimensionId]);

    // Flatten all categories
    const allCategories = useMemo(() => {
        const cats: Category[] = [];
        for (const dim of dimensions) {
            cats.push(...dim.categories);
        }
        return cats;
    }, [dimensions]);

    // Calculate max absolute value first for consistent gradient
    const maxAbsValueRaw = useMemo(() => {
        if (assets.length === 0) return 0;
        if (viewMode === 'asset') {
            return assets.reduce((max, a) => Math.max(max, Math.abs(a.unrealized_pnl)), 0);
        }
        // For category, calculate from raw aggregation
        const categoryMap = new Map<number, number>();
        const dimensionCategories = allCategories.filter(c => c.dimension_id === selectedDimensionId);
        const dimensionCategoryIds = new Set(dimensionCategories.map(c => c.id));

        for (const asset of assets) {
            const assetCategories = asset.category_ids.filter(id => dimensionCategoryIds.has(id));
            if (assetCategories.length === 0) continue;
            const share = 1 / assetCategories.length;
            for (const catId of assetCategories) {
                const existing = categoryMap.get(catId) || 0;
                categoryMap.set(catId, existing + asset.unrealized_pnl * share);
            }
        }
        return Array.from(categoryMap.values()).reduce((max, v) => Math.max(max, Math.abs(v)), 0);
    }, [assets, viewMode, selectedDimensionId, allCategories]);

    // Compute bar chart data based on view mode
    const barData = useMemo((): BarDataItem[] => {
        if (assets.length === 0) return [];

        if (viewMode === 'asset') {
            return assets.map(asset => ({
                id: asset.asset.id || 0,
                name: asset.asset.symbol || 'Unknown',
                value: asset.unrealized_pnl,
                positiveValue: asset.unrealized_pnl >= 0 ? asset.unrealized_pnl : 0,
                negativeValue: asset.unrealized_pnl < 0 ? asset.unrealized_pnl : 0,
                percentage: asset.unrealized_pnl_pct,
                itemType: 'asset',
                color: getGradientColor(asset.unrealized_pnl, maxAbsValueRaw),
            }));
        } else {
            if (selectedDimensionId === null) return [];
            return aggregateByCategory(assets, selectedDimensionId, allCategories, maxAbsValueRaw);
        }
    }, [assets, viewMode, selectedDimensionId, allCategories, maxAbsValueRaw]);

    // Sort and limit data
    const sortedData = useMemo(() => {
        const sorted = [...barData].sort((a, b) => b.value - a.value);

        const halfCount = Math.ceil(itemCount / 2);
        const top = sorted.slice(0, halfCount);
        const bottom = sorted.slice(-halfCount);

        const combined = [...top];
        for (const item of bottom) {
            if (!combined.find(c => c.id === item.id && c.itemType === item.itemType)) {
                combined.push(item);
            }
        }

        // Sort for display (best at top, which means reversed for horizontal bar)
        return combined.sort((a, b) => a.value - b.value);
    }, [barData, itemCount]);

    // Handle bar click
    const handleBarClick = useCallback((data: BarDataItem) => {
        const itemType = data.itemType === 'asset' ? 'asset' : 'category';
        onItemClick?.(data.id as number, itemType);
    }, [onItemClick]);

    // Handle view mode change
    const handleViewModeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
        setViewMode(e.target.value as ViewMode);
    }, []);

    // Handle dimension change
    const handleDimensionChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
        const newId = e.target.value ? parseInt(e.target.value, 10) : null;
        setSelectedDimensionId(newId);
    }, []);

    // Empty state
    if (assets.length === 0) {
        return (
            <Box
                p={4}
                bg="gray.50"
                borderRadius="md"
                border="1px solid"
                borderColor="gray.200"
                mb={4}
            >
                <Heading size="sm" mb={2}>Top Performers</Heading>
                <Text fontSize="sm" color="gray.500">
                    No P&L data available. Run calculation to see performance.
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
            h="100%"
        >
            {/* Header */}
            <Flex justify="space-between" align="center" mb={3} flexWrap="wrap" gap={2}>
                <Heading size="sm">Top Performers by Unrealized P&L</Heading>
                <Flex gap={2} align="center">
                    <NativeSelect.Root size="sm" width="120px">
                        <NativeSelect.Field value={viewMode} onChange={handleViewModeChange}>
                            <option value="asset">By Asset</option>
                            <option value="category">By Category</option>
                        </NativeSelect.Field>
                    </NativeSelect.Root>
                    {viewMode === 'category' && dimensions.length > 0 && (
                        <NativeSelect.Root size="sm" width="140px">
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
                    )}
                </Flex>
            </Flex>

            {/* Item count slider */}
            <Flex align="center" gap={3} mb={3}>
                <Text fontSize="xs" color="gray.500" whiteSpace="nowrap">
                    Show: {itemCount} items
                </Text>
                <Box flex={1} maxW="150px">
                    <Slider.Root
                        size="sm"
                        min={3}
                        max={15}
                        step={1}
                        value={[itemCount]}
                        onValueChange={(e) => setItemCount(e.value[0])}
                    >
                        <Slider.Control>
                            <Slider.Track>
                                <Slider.Range />
                            </Slider.Track>
                            <Slider.Thumb index={0} />
                        </Slider.Control>
                    </Slider.Root>
                </Box>
            </Flex>

            {sortedData.length === 0 ? (
                <Text fontSize="sm" color="gray.500" textAlign="center" py={8}>
                    No data for selected dimension.
                </Text>
            ) : (
                <Box h="280px">
                    <ResponsiveBar
                        data={sortedData}
                        keys={['positiveValue', 'negativeValue']}
                        indexBy="name"
                        layout="horizontal"
                        margin={{ top: 10, right: 60, bottom: 30, left: 70 }}
                        padding={0.3}
                        valueScale={{ type: 'linear' }}
                        indexScale={{ type: 'band', round: true }}
                        colors={(bar) => {
                            const item = sortedData.find(d => d.name === bar.indexValue);
                            return item?.color || '#94a3b8';
                        }}
                        borderColor={{ from: 'color', modifiers: [['darker', 1.6]] }}
                        axisTop={null}
                        axisRight={null}
                        axisBottom={{
                            tickSize: 5,
                            tickPadding: 5,
                            tickRotation: 0,
                            format: (v) => formatCurrency(Number(v), baseCurrency),
                        }}
                        axisLeft={{
                            tickSize: 5,
                            tickPadding: 5,
                            tickRotation: 0,
                        }}
                        enableGridX={true}
                        enableGridY={false}
                        enableLabel={true}
                        label={(d) => formatCurrency(Number(d.value) || 0, baseCurrency)}
                        labelSkipWidth={40}
                        labelSkipHeight={12}
                        labelTextColor="#fff"
                        markers={[
                            {
                                axis: 'x',
                                value: 0,
                                lineStyle: { stroke: '#cbd5e1', strokeWidth: 1 },
                            },
                        ]}
                        tooltip={({ indexValue }) => {
                            const item = sortedData.find(d => d.name === indexValue);
                            if (!item) return null;
                            const isPositive = item.value >= 0;
                            return (
                                <Box
                                    bg="white"
                                    p={3}
                                    borderRadius="md"
                                    boxShadow="lg"
                                    border="1px solid"
                                    borderColor="gray.200"
                                >
                                    <Text fontWeight="semibold" mb={1}>{item.name}</Text>
                                    <Flex align="center" gap={2}>
                                        <Text fontSize="sm" color={isPositive ? 'green.600' : 'red.600'}>
                                            {isPositive ? '+' : ''}{formatCurrency(item.value, baseCurrency)}
                                        </Text>
                                        <Text fontSize="xs" color="gray.500">
                                            ({isPositive ? '+' : ''}{item.percentage.toFixed(1)}%)
                                        </Text>
                                    </Flex>
                                    <Text fontSize="xs" color="gray.400" mt={1}>
                                        {item.itemType === 'asset' ? 'Asset' : 'Category'}
                                    </Text>
                                </Box>
                            );
                        }}
                        onClick={(data) => {
                            const item = sortedData.find(d => d.name === data.indexValue);
                            if (item) handleBarClick(item);
                        }}
                        theme={{
                            axis: {
                                ticks: {
                                    text: {
                                        fontSize: 9,
                                        fontFamily: 'inherit',
                                    }
                                }
                            },
                            labels: {
                                text: {
                                    fontSize: 8,
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

            {/* Legend */}
            <Flex justify="center" gap={6} mt={2}>
                <Flex align="center" gap={1}>
                    <Box w={3} h={3} borderRadius="sm" bg="#22c55e" />
                    <Text fontSize="xs" color="gray.500">Gains</Text>
                </Flex>
                <Flex align="center" gap={1}>
                    <Box w={3} h={3} borderRadius="sm" bg="#ef4444" />
                    <Text fontSize="xs" color="gray.500">Losses</Text>
                </Flex>
            </Flex>
        </Box>
    );
};

export default PerformanceBarChart;
