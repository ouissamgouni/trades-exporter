/**
 * P&L Filter Bar
 * 
 * Unified filter bar for P&L Portfolio View with auto-sizing cards grid layout.
 * Supports filtering by:
 * - Accounts (which accounts hold the assets)
 * - Category dimensions (e.g., Asset Class, Sector)
 * - Options (include unsettled negative lots)
 * 
 * Only shows values available in current P&L version results.
 * Client-side filtering - no recalculation needed.
 */

import React, { useState, useMemo } from 'react';
import {
    Badge,
    Box,
    Button,
    Card,
    Collapsible,
    Flex,
    SimpleGrid,
    Switch,
    Text,
} from '@chakra-ui/react';
import { FiFilter, FiX, FiChevronDown, FiChevronRight, FiDatabase, FiTag, FiSettings, FiEye, FiEyeOff } from 'react-icons/fi';
import { Account, DimensionWithCategories, Category } from '../../types';
import { PnLFilterState } from './types';
import { getAccountColor } from '../../utils/accountColors';

export interface PnLFilterBarProps {
    /** All accounts (from global context) */
    allAccounts: Account[];
    /** Available dimensions with their categories (from /categories/tree) */
    dimensions: DimensionWithCategories[];
    /** Account IDs present in current P&L results */
    availableAccountIds: Set<number>;
    /** Category IDs present in current P&L results */
    availableCategoryIds: Set<number>;
    /** Current filter state */
    filterState: PnLFilterState;
    /** Callback when filter state changes */
    onFilterChange: (state: PnLFilterState) => void;
    /** Total assets count (before filtering) */
    totalAssetCount: number;
    /** Filtered assets count */
    filteredAssetCount: number;
    /** Whether data is loading */
    isLoading?: boolean;
    /** Total count of unsettled negative lots (for display in Options card) */
    unsettledNegativeCount?: number;
}

/**
 * Get contrasting text color for a background color
 */
const getContrastColor = (hexColor: string): string => {
    const hex = hexColor.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? 'gray.800' : 'white';
};

export const PnLFilterBar: React.FC<PnLFilterBarProps> = ({
    allAccounts,
    dimensions,
    availableAccountIds,
    availableCategoryIds,
    filterState,
    onFilterChange,
    totalAssetCount,
    filteredAssetCount,
    isLoading = false,
    unsettledNegativeCount = 0,
}) => {
    // Filter to only show accounts present in results
    const availableAccounts = useMemo(() => {
        return allAccounts.filter(acc => availableAccountIds.has(acc.id));
    }, [allAccounts, availableAccountIds]);

    // Filter to only show dimensions/categories present in results
    const relevantDimensions = useMemo(() => {
        if (availableCategoryIds.size === 0) {
            return [];
        }
        return dimensions
            .map(dim => ({
                ...dim,
                categories: dim.categories.filter(cat => availableCategoryIds.has(cat.id)),
            }))
            .filter(dim => dim.categories.length > 0);
    }, [dimensions, availableCategoryIds]);

    // Count active filters
    const selectedAccountCount = filterState.selectedAccountIds.length;
    const selectedCategoryCount = filterState.selectedCategoryIds.length;
    const hasActiveFilter = selectedAccountCount > 0 || selectedCategoryCount > 0;
    const isFiltered = filteredAssetCount < totalAssetCount;

    // Build summary text for collapsed state
    const filterSummaryParts: string[] = [];
    if (selectedAccountCount > 0) {
        filterSummaryParts.push(`${selectedAccountCount} of ${availableAccounts.length} accounts`);
    }
    if (selectedCategoryCount > 0) {
        filterSummaryParts.push(`${selectedCategoryCount} ${selectedCategoryCount === 1 ? 'category' : 'categories'}`);
    }
    const filterSummary = filterSummaryParts.length > 0 ? filterSummaryParts.join(', ') : '';

    // Handlers
    const handleAccountToggle = (accountId: number) => {
        const newIds = filterState.selectedAccountIds.includes(accountId)
            ? filterState.selectedAccountIds.filter(id => id !== accountId)
            : [...filterState.selectedAccountIds, accountId];
        onFilterChange({ ...filterState, selectedAccountIds: newIds });
    };

    const handleCategoryToggle = (categoryId: number) => {
        const newIds = filterState.selectedCategoryIds.includes(categoryId)
            ? filterState.selectedCategoryIds.filter(id => id !== categoryId)
            : [...filterState.selectedCategoryIds, categoryId];
        onFilterChange({ ...filterState, selectedCategoryIds: newIds });
    };

    const handleUnsettledToggle = () => {
        onFilterChange({
            ...filterState,
            includeUnsettledNegative: !filterState.includeUnsettledNegative,
        });
    };

    const handleClearFilters = () => {
        onFilterChange({
            selectedAccountIds: [],
            selectedCategoryIds: [],
            includeUnsettledNegative: filterState.includeUnsettledNegative,
        });
    };

    // Auto-expand when filter is active
    const [isExpanded, setIsExpanded] = useState(hasActiveFilter);

    if (isLoading) {
        return (
            <Box py={2} px={3} bg="gray.50" borderRadius="md" border="1px solid" borderColor="gray.200">
                <Flex align="center" gap={2}>
                    <FiFilter color="gray" />
                    <Text fontSize="sm" color="gray.500">Loading filters...</Text>
                </Flex>
            </Box>
        );
    }

    // Hide if no filters available
    if (availableAccounts.length === 0 && relevantDimensions.length === 0) {
        return null;
    }

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
                        Filters
                    </Text>
                    {filterSummary && !isExpanded && (
                        <Badge colorPalette="blue" size="sm">
                            {filterSummary}
                        </Badge>
                    )}
                    {isFiltered && isExpanded && (
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

            {/* Collapsible content with cards grid */}
            <Collapsible.Root open={isExpanded}>
                <Collapsible.Content>
                    <SimpleGrid columns={{ base: 1, md: 2, lg: 3 }} gap={3} pt={3}>
                        {/* Accounts card */}
                        {availableAccounts.length > 0 && (
                            <FilterCard
                                icon={<FiDatabase size={14} />}
                                label="Accounts"
                                count={`${selectedAccountCount || 'All'}/${availableAccounts.length}`}
                                hasSelection={selectedAccountCount > 0}
                            >
                                <Flex gap={1} flexWrap="wrap">
                                    {availableAccounts.map((account) => {
                                        const isSelected = filterState.selectedAccountIds.includes(account.id);
                                        const color = getAccountColor(account.id);
                                        return (
                                            <AccountChip
                                                key={account.id}
                                                account={account}
                                                color={color}
                                                isSelected={isSelected}
                                                onClick={() => handleAccountToggle(account.id)}
                                            />
                                        );
                                    })}
                                </Flex>
                            </FilterCard>
                        )}

                        {/* Category dimension cards */}
                        {relevantDimensions.map((dimension) => {
                            const selectedInDim = dimension.categories.filter(
                                cat => filterState.selectedCategoryIds.includes(cat.id)
                            ).length;
                            return (
                                <FilterCard
                                    key={dimension.id}
                                    icon={<FiTag size={14} />}
                                    label={dimension.label}
                                    count={`${selectedInDim || 'All'}/${dimension.categories.length}`}
                                    hasSelection={selectedInDim > 0}
                                >
                                    <Flex gap={1} flexWrap="wrap">
                                        {dimension.categories.map((category) => {
                                            const isSelected = filterState.selectedCategoryIds.includes(category.id);
                                            return (
                                                <CategoryChip
                                                    key={category.id}
                                                    category={category}
                                                    isSelected={isSelected}
                                                    onClick={() => handleCategoryToggle(category.id)}
                                                />
                                            );
                                        })}
                                    </Flex>
                                </FilterCard>
                            );
                        })}

                        {/* Options card - only show if there are unsettled lots */}
                        {unsettledNegativeCount > 0 && (
                            <FilterCard
                                icon={<FiSettings size={14} />}
                                label="Options"
                                hasSelection={!filterState.includeUnsettledNegative}
                            >
                                <Flex align="center" gap={2}>
                                    {filterState.includeUnsettledNegative ? (
                                        <FiEye size={14} color="#718096" />
                                    ) : (
                                        <FiEyeOff size={14} color="#718096" />
                                    )}
                                    <Text fontSize="xs" color="gray.600">
                                        {filterState.includeUnsettledNegative
                                            ? `Showing ${unsettledNegativeCount} unsettled lot${unsettledNegativeCount === 1 ? '' : 's'}`
                                            : `${unsettledNegativeCount} unsettled lot${unsettledNegativeCount === 1 ? '' : 's'} hidden`
                                        }
                                    </Text>
                                    <Switch.Root
                                        checked={filterState.includeUnsettledNegative}
                                        onCheckedChange={handleUnsettledToggle}
                                        size="sm"
                                        ml="auto"
                                    >
                                        <Switch.HiddenInput />
                                        <Switch.Control>
                                            <Switch.Thumb />
                                        </Switch.Control>
                                        <Switch.Label ml={1} fontSize="xs">
                                            {filterState.includeUnsettledNegative ? 'Hide' : 'Show'}
                                        </Switch.Label>
                                    </Switch.Root>
                                </Flex>
                            </FilterCard>
                        )}
                    </SimpleGrid>
                </Collapsible.Content>
            </Collapsible.Root>
        </Box>
    );
};

// ============================================================================
// Sub-components
// ============================================================================

interface FilterCardProps {
    icon: React.ReactNode;
    label: string;
    count?: string;
    hasSelection: boolean;
    children: React.ReactNode;
}

const FilterCard: React.FC<FilterCardProps> = ({
    icon,
    label,
    count,
    hasSelection,
    children,
}) => {
    return (
        <Card.Root
            size="sm"
            variant="outline"
            borderColor={hasSelection ? 'blue.200' : 'gray.200'}
            bg={hasSelection ? 'blue.50' : 'white'}
        >
            <Card.Body p={3}>
                <Flex align="center" gap={2} mb={2}>
                    <Box color={hasSelection ? 'blue.500' : 'gray.500'}>
                        {icon}
                    </Box>
                    <Text fontSize="xs" fontWeight="semibold" color={hasSelection ? 'blue.700' : 'gray.700'}>
                        {label}
                    </Text>
                    {count && (
                        <Badge size="xs" colorPalette={hasSelection ? 'blue' : 'gray'} ml="auto">
                            {count}
                        </Badge>
                    )}
                </Flex>
                {children}
            </Card.Body>
        </Card.Root>
    );
};

interface AccountChipProps {
    account: Account;
    color: string;
    isSelected: boolean;
    onClick: () => void;
}

const AccountChip: React.FC<AccountChipProps> = ({
    account,
    color,
    isSelected,
    onClick,
}) => {
    return (
        <Button
            size="xs"
            variant={isSelected ? 'solid' : 'outline'}
            onClick={onClick}
            bg={isSelected ? color : 'white'}
            color={isSelected ? getContrastColor(color) : 'gray.700'}
            borderColor={color}
            _hover={{
                bg: isSelected ? color : `${color}15`,
                opacity: 0.9,
            }}
        >
            <Box
                w="8px"
                h="8px"
                borderRadius="full"
                bg={isSelected ? 'currentColor' : color}
                mr={1}
                opacity={isSelected ? 0.7 : 1}
            />
            {account.name}
        </Button>
    );
};

interface CategoryChipProps {
    category: Category;
    isSelected: boolean;
    onClick: () => void;
}

const CategoryChip: React.FC<CategoryChipProps> = ({
    category,
    isSelected,
    onClick,
}) => {
    const bgColor = isSelected && category.color ? category.color : undefined;
    const textColor = isSelected && category.color ? getContrastColor(category.color) : undefined;

    return (
        <Button
            size="xs"
            variant={isSelected ? 'solid' : 'outline'}
            colorPalette={isSelected && !category.color ? 'blue' : 'gray'}
            onClick={onClick}
            bg={bgColor}
            color={textColor}
            borderColor={category.color || undefined}
            _hover={{
                bg: isSelected ? bgColor : 'gray.100',
                opacity: 0.9,
            }}
        >
            {category.label}
        </Button>
    );
};

export default PnLFilterBar;
