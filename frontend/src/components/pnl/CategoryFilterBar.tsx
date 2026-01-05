/**
 * Category Filter Bar
 * 
 * Post-calculation display filter for P&L results by dimension/category.
 * Appears between SummaryCards and AssetPnLTable after calculation.
 * Client-side filtering - no recalculation needed.
 * Collapsible to save space when not actively filtering.
 */

import React, { useState, useMemo } from 'react';
import {
    Badge,
    Box,
    Button,
    Collapsible,
    Flex,
    Text,
} from '@chakra-ui/react';
import { FiFilter, FiX, FiChevronDown, FiChevronRight } from 'react-icons/fi';
import { DimensionWithCategories, Category } from '../../types';

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
    if (!hexColor) return 'gray.700';
    const hex = hexColor.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    // Calculate relative luminance
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? 'gray.800' : 'white';
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
            <Box py={2} px={3} bg="gray.50" borderRadius="md" border="1px solid" borderColor="gray.200">
                <Flex align="center" gap={2}>
                    <FiFilter color="gray" />
                    <Text fontSize="sm" color="gray.500">Loading categories...</Text>
                </Flex>
            </Box>
        );
    }

    if (relevantDimensions.length === 0) {
        return null; // No categories to show
    }

    // Auto-expand when filter is active
    const [isExpanded, setIsExpanded] = useState(hasActiveFilter);

    return (
        <Box
            py={2}
            px={3}
            bg="gray.50"
            borderRadius="md"
            border="1px solid"
            borderColor={hasActiveFilter ? 'blue.200' : 'gray.200'}
            mb={4}
        >
            {/* Clickable header row */}
            <Flex
                justify="space-between"
                align="center"
                cursor="pointer"
                onClick={() => setIsExpanded(!isExpanded)}
                py={1}
            >
                <Flex align="center" gap={2}>
                    {isExpanded ? (
                        <FiChevronDown size={14} color={hasActiveFilter ? '#3182ce' : '#718096'} />
                    ) : (
                        <FiChevronRight size={14} color={hasActiveFilter ? '#3182ce' : '#718096'} />
                    )}
                    <FiFilter size={14} color={hasActiveFilter ? '#3182ce' : '#718096'} />
                    <Text fontSize="sm" fontWeight="medium" color={hasActiveFilter ? 'blue.600' : 'gray.600'}>
                        Filter by Category
                    </Text>
                    {isFiltered && (
                        <Badge colorPalette="blue" size="sm">
                            {filteredAssetCount} of {totalAssetCount} assets
                        </Badge>
                    )}
                </Flex>
                {hasActiveFilter && (
                    <Button
                        size="xs"
                        variant="ghost"
                        colorPalette="gray"
                        onClick={(e) => {
                            e.stopPropagation();
                            handleClearFilters();
                        }}
                    >
                        <FiX />
                        <Text ml={1}>Clear</Text>
                    </Button>
                )}
            </Flex>

            {/* Collapsible content */}
            <Collapsible.Root open={isExpanded}>
                <Collapsible.Content>
                    <Flex direction="column" gap={2} pt={2}>
                        {relevantDimensions.map((dimension) => (
                            <Flex key={dimension.id} align="center" gap={2} flexWrap="wrap">
                                <Text
                                    fontSize="xs"
                                    color="gray.500"
                                    fontWeight="medium"
                                    minW="80px"
                                >
                                    {dimension.label}:
                                </Text>
                                <Flex gap={1} flexWrap="wrap">
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
                                </Flex>
                            </Flex>
                        ))}
                    </Flex>
                </Collapsible.Content>
            </Collapsible.Root>
        </Box>
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
            size="xs"
            variant={isSelected ? 'solid' : 'outline'}
            colorPalette={isSelected ? 'blue' : 'gray'}
            onClick={onClick}
            disabled={isDisabled}
            opacity={isDisabled ? 0.5 : 1}
            bg={bgColor}
            color={textColor}
            borderColor={category.color || undefined}
            _hover={{
                bg: isSelected ? bgColor : 'gray.100',
                opacity: isDisabled ? 0.5 : 0.9,
            }}
        >
            {category.label}
            {category.asset_count !== undefined && (
                <Text as="span" ml={1} opacity={0.7}>
                    ({category.asset_count})
                </Text>
            )}
        </Button>
    );
};

export default CategoryFilterBar;
