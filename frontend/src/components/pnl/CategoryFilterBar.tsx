/**
 * Category Filter Bar
 * 
 * Post-calculation display filter for P&L results by dimension/category.
 * Appears between SummaryCards and AssetPnLTable after calculation.
 * Client-side filtering - no recalculation needed.
 * Collapsible to save space when not actively filtering.
 */

import React, { useState, useMemo } from 'react';
import { FiFilter, FiX, FiChevronDown, FiChevronRight } from 'react-icons/fi';
import { DimensionWithCategories, Category } from '../../types';
import { Badge, Button } from '../ui/primitives';

export interface CategoryFilterBarProps {
    /** Available dimensions with their categories (from /categories/tree) */
    dimensions: DimensionWithCategories[];
    /** Currently selected category IDs */
    selectedCategoryIds: number[];
    /** Callback when selection changes */
    onSelectionChange: (categoryIds: number[]) => void;
    /** Categories that have assets in current results (for highlighting) */
    availableCategoryIds?: Set<number>;
    /** Total assets count (before filtering) */
    totalAssetCount: number;
    /** Filtered assets count */
    filteredAssetCount: number;
    /** Whether categories are loading */
    isLoading?: boolean;
}

/**
 * Get contrasting text color for a background color
 */
const getContrastColor = (hexColor: string | null | undefined): string => {
    if (!hexColor) return '#334155'; // slate-700
    const hex = hexColor.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    // Calculate relative luminance
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? '#1e293b' : 'white'; // slate-800 or white
};

export const CategoryFilterBar: React.FC<CategoryFilterBarProps> = ({
    dimensions,
    selectedCategoryIds,
    onSelectionChange,
    availableCategoryIds,
    totalAssetCount,
    filteredAssetCount,
    isLoading = false,
}) => {
    // Filter to only show dimensions that have categories with assets in results
    const relevantDimensions = useMemo(() => {
        if (!availableCategoryIds || availableCategoryIds.size === 0) {
            return dimensions;
        }
        return dimensions
            .map(dim => ({
                ...dim,
                categories: dim.categories.filter(cat => availableCategoryIds.has(cat.id)),
            }))
            .filter(dim => dim.categories.length > 0);
    }, [dimensions, availableCategoryIds]);

    const hasActiveFilter = selectedCategoryIds.length > 0;
    const isFiltered = filteredAssetCount < totalAssetCount;

    const handleCategoryToggle = (categoryId: number) => {
        if (selectedCategoryIds.includes(categoryId)) {
            onSelectionChange(selectedCategoryIds.filter(id => id !== categoryId));
        } else {
            onSelectionChange([...selectedCategoryIds, categoryId]);
        }
    };

    const handleClearFilters = () => {
        onSelectionChange([]);
    };

    if (isLoading) {
        return (
            <div className="border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="flex items-center gap-2">
                    <FiFilter color="gray" />
                    <span className="text-sm text-slate-500">Loading categories...</span>
                </div>
            </div>
        );
    }

    if (relevantDimensions.length === 0) {
        return null; // No categories to show
    }

    // Auto-expand when filter is active
    const [isExpanded, setIsExpanded] = useState(hasActiveFilter);

    return (
        <div
            className={`mb-4 border px-3 py-2 ${hasActiveFilter ? 'border-blue-200' : 'border-slate-200'} bg-slate-50`}
        >
            {/* Clickable header row */}
            <div
                className="flex cursor-pointer items-center justify-between py-1"
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <div className="flex items-center gap-2">
                    {isExpanded ? (
                        <FiChevronDown size={14} color={hasActiveFilter ? '#3182ce' : '#718096'} />
                    ) : (
                        <FiChevronRight size={14} color={hasActiveFilter ? '#3182ce' : '#718096'} />
                    )}
                    <FiFilter size={14} color={hasActiveFilter ? '#3182ce' : '#718096'} />
                    <span className={`text-sm font-medium ${hasActiveFilter ? 'text-blue-600' : 'text-slate-600'}`}>
                        Filter by Category
                    </span>
                    {isFiltered && (
                        <Badge colorScheme="blue">
                            {filteredAssetCount} of {totalAssetCount} assets
                        </Badge>
                    )}
                </div>
                {hasActiveFilter && (
                    <Button
                        size="sm"
                        variant="ghost"
                        colorScheme="gray"
                        onClick={(e) => {
                            e.stopPropagation();
                            handleClearFilters();
                        }}
                    >
                        <FiX />
                        <span className="ml-1">Clear</span>
                    </Button>
                )}
            </div>

            {/* Collapsible content */}
            {isExpanded && (
                <div className="flex flex-col gap-2 pt-2">
                    {relevantDimensions.map((dimension) => (
                        <div key={dimension.id} className="flex flex-wrap items-center gap-2">
                            <span className="min-w-[80px] text-xs font-medium text-slate-500">
                                {dimension.label}:
                            </span>
                            <div className="flex flex-wrap gap-1">
                                {dimension.categories.map((category) => {
                                    const isSelected = selectedCategoryIds.includes(category.id);
                                    const hasAssets = !availableCategoryIds || availableCategoryIds.has(category.id);

                                    return (
                                        <CategoryChip
                                            key={category.id}
                                            category={category}
                                            isSelected={isSelected}
                                            isDisabled={!hasAssets}
                                            onClick={() => handleCategoryToggle(category.id)}
                                        />
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

interface CategoryChipProps {
    category: Category;
    isSelected: boolean;
    isDisabled?: boolean;
    onClick: () => void;
}

const CategoryChip: React.FC<CategoryChipProps> = ({
    category,
    isSelected,
    isDisabled = false,
    onClick,
}) => {
    const bgColor = isSelected && category.color ? category.color : undefined;
    const textColor = isSelected && category.color ? getContrastColor(category.color) : undefined;

    return (
        <Button
            size="sm"
            variant={isSelected ? 'solid' : 'outline'}
            colorScheme={isSelected ? 'blue' : 'gray'}
            onClick={onClick}
            disabled={isDisabled}
            style={{
                opacity: isDisabled ? 0.5 : 1,
                backgroundColor: bgColor,
                color: textColor,
                borderColor: category.color || undefined,
            }}
        >
            {category.label}
            {category.asset_count !== undefined && (
                <span className="ml-1 opacity-70">
                    ({category.asset_count})
                </span>
            )}
        </Button>
    );
};

export default CategoryFilterBar;
