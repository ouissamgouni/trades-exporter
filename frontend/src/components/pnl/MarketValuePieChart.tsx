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
import { ResponsivePie } from '@nivo/pie';
import { DimensionWithCategories, Category } from '../../types';
import { AssetPnLRow, PieChartDataPoint, aggregateMarketValueByCategory, aggregateMarketValueByCurrency } from './types';
import { Heading } from '../ui/primitives';

/** Sentinel value for the "Currency" pseudo-dimension in the selector */
const CURRENCY_DIMENSION_ID = -1;

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
    /** Per-asset denomination currency map: assetId → currency symbol */
    assetCurrencyMap?: Record<number, string>;
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
    assetCurrencyMap = {},
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
        const rawData = selectedDimensionId === CURRENCY_DIMENSION_ID
            ? aggregateMarketValueByCurrency(assets, assetCurrencyMap)
            : aggregateMarketValueByCategory(assets, selectedDimensionId, allCategories);
        return rawData.map((d: PieChartDataPoint) => ({
            id: d.label,
            label: d.label,
            value: d.value,
            color: d.color,
            categoryId: d.categoryId,
            percentage: d.percentage,
            assetCount: d.assetCount,
        }));
    }, [assets, selectedDimensionId, allCategories, assetCurrencyMap]);

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
            <div className="mb-4 border border-slate-200 bg-slate-50 p-4">
                <Heading className="mb-2 text-sm">Market Value by Category</Heading>
                <span className="block text-sm text-slate-500">
                    No market value data available. Refresh prices to see the distribution.
                </span>
            </div>
        );
    }

    return (
        <div className="mb-4 border border-slate-200 bg-white p-4">
            {/* Header with dimension selector */}
            <div className="mb-4 flex items-center justify-between">
                <Heading className="text-sm">
                    {selectedDimensionId === CURRENCY_DIMENSION_ID ? 'Market Value by Currency' : 'Market Value by Category'}
                </Heading>
                <select
                    className="h-8 w-[180px] border border-slate-300 bg-white px-2 text-sm"
                    value={selectedDimensionId !== null ? String(selectedDimensionId) : ''}
                    onChange={handleDimensionChange}
                >
                    <option value={String(CURRENCY_DIMENSION_ID)}>Currency</option>
                    {dimensions.map(dim => (
                        <option key={dim.id} value={String(dim.id)}>
                            {dim.label}
                        </option>
                    ))}
                </select>
            </div>

            {/* Total value display */}
            <div className="mb-3 text-sm text-slate-600">
                Total: {formatCurrency(totalMarketValue, baseCurrency)}
            </div>

            {pieData.length === 0 ? (
                <div className="py-8 text-center text-sm text-slate-500">
                    No categories assigned in this dimension.
                </div>
            ) : (
                <div className="h-[320px]">
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
                            <div className="border border-slate-200 bg-white p-3 shadow-lg">
                                <div className="mb-1 flex items-center gap-2">
                                    <div
                                        className="h-3 w-3"
                                        style={{ backgroundColor: datum.color }}
                                    />
                                    <span className="font-semibold">{datum.label}</span>
                                </div>
                                <div className="text-sm text-slate-600">
                                    Value: {formatCurrency(datum.value, baseCurrency)}
                                </div>
                                <div className="text-sm text-slate-600">
                                    Percentage: {datum.data.percentage.toFixed(1)}%
                                </div>
                                <div className="text-sm text-slate-500">
                                    {datum.data.assetCount} asset{datum.data.assetCount !== 1 ? 's' : ''}
                                </div>
                            </div>
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
                </div>
            )}
        </div>
    );
};

export default MarketValuePieChart;
