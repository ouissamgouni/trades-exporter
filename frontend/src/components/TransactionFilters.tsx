import {
    Badge,
    Box,
    Button,
    Flex,
    SimpleGrid,
    Tabs,
    Text,
} from '@chakra-ui/react';
import React, { useEffect, useRef, useState } from 'react';
import { LuCalendar, LuCheck, LuChevronDown, LuFilter, LuRotateCcw, LuSearch, LuX } from 'react-icons/lu';
import { API_URL } from '../types';
import { toDateInputString, getDateRangePreset } from '../utils/dateUtils';

// Filter option from backend
export interface FilterOption {
    value: string;
    label: string;
    count?: number;
}

// Category with dimension info
export interface CategoryOption {
    value: string;
    label: string;
    dimension_id: number;
    dimension_label: string;
}

// Dimension with categories
export interface DimensionWithCategories {
    id: number;
    label: string;
    categories: CategoryOption[];
}

// All filter options returned by the backend
export interface FilterOptions {
    sources: FilterOption[];
    accounts: FilterOption[];
    assets: FilterOption[];
    categories: FilterOption[];
    categories_by_dimension: DimensionWithCategories[];
    dimensions: FilterOption[];
    transaction_types: FilterOption[];
    directions: FilterOption[];
    review_statuses: FilterOption[];
    taxability_statuses: FilterOption[];
}

// Current filter state
export interface TransactionFilterState {
    reviewStatus: string[];
    taxability: string[];
    sources: string[];
    accountIds: string[];
    assetIds: string[];
    categoryIds: string[];
    transactionTypes: string[];
    directions: string[];
    dateFrom: string;
    dateTo: string;
}

// Default empty filter state
export const defaultFilterState: TransactionFilterState = {
    reviewStatus: [],
    taxability: [],
    sources: [],
    accountIds: [],
    assetIds: [],
    categoryIds: [],
    transactionTypes: [],
    directions: [],
    dateFrom: '',
    dateTo: '',
};

interface TransactionFiltersProps {
    filters: TransactionFilterState;
    onChange: (filters: TransactionFilterState) => void;
    onClear: () => void;
}

// Filter definitions - ordered: date, account, source, type, direction, taxability, status, assets, category
interface FilterDef {
    key: keyof TransactionFilterState;
    label: string;
    icon: string;
    type: 'multi' | 'single';
    optionsKey?: keyof FilterOptions;
    color: string;
    isDropdown?: boolean;
}

// Order: account, source, type, direction, taxability, status (open) | assets, category (dropdown)
const FILTER_DEFS: FilterDef[] = [
    { key: 'accountIds', label: 'Account', icon: '👤', type: 'multi', optionsKey: 'accounts', color: 'cyan' },
    { key: 'sources', label: 'Source', icon: '🔌', type: 'multi', optionsKey: 'sources', color: 'blue' },
    { key: 'transactionTypes', label: 'Type', icon: '🏷️', type: 'multi', optionsKey: 'transaction_types', color: 'teal' },
    { key: 'directions', label: 'Direction', icon: '↔️', type: 'multi', optionsKey: 'directions', color: 'yellow' },
    { key: 'taxability', label: 'Taxability', icon: '💰', type: 'multi', optionsKey: 'taxability_statuses', color: 'red' },
    { key: 'reviewStatus', label: 'Status', icon: '🔄', type: 'multi', optionsKey: 'review_statuses', color: 'green' },
    { key: 'assetIds', label: 'Asset', icon: '💎', type: 'multi', optionsKey: 'assets', color: 'orange', isDropdown: true },
    { key: 'categoryIds', label: 'Category', icon: '📁', type: 'multi', color: 'pink', isDropdown: true },
];

// Filter Card Component - shows all options as toggleable chips (OPEN)
interface FilterCardProps {
    label: string;
    icon: string;
    options: FilterOption[];
    selected: string[];
    onChange: (selected: string[]) => void;
    color: string;
}

const FilterCard: React.FC<FilterCardProps> = ({
    label,
    icon,
    options,
    selected,
    onChange,
    color,
}) => {
    const handleToggle = (value: string) => {
        const newSelected = selected.includes(value)
            ? selected.filter(v => v !== value)
            : [...selected, value];
        onChange(newSelected);
    };

    const activeCount = selected.length;
    const needsScroll = options.length > 4;

    return (
        <Box
            bg="white"
            border="1px solid"
            borderColor={activeCount > 0 ? `${color}.200` : 'gray.200'}
            borderRadius="md"
            p={2}
            minH="70px"
        >
            {/* Card Header */}
            <Flex align="center" justify="space-between" mb={1.5}>
                <Flex align="center" gap={1}>
                    <Text fontSize="xs">{icon}</Text>
                    <Text fontSize="2xs" fontWeight="semibold" color="gray.600" textTransform="uppercase">
                        {label}
                    </Text>
                </Flex>
                {activeCount > 0 && (
                    <Badge size="xs" colorPalette={color} borderRadius="full">
                        {activeCount}
                    </Badge>
                )}
            </Flex>

            {/* Options as toggleable chips - with scroll if > 4 items */}
            <Box
                maxH={needsScroll ? '72px' : 'auto'}
                overflowY={needsScroll ? 'auto' : 'visible'}
                css={{
                    '&::-webkit-scrollbar': { width: '4px' },
                    '&::-webkit-scrollbar-thumb': { background: '#CBD5E0', borderRadius: '2px' },
                }}
            >
                <Flex flexWrap="wrap" gap={1}>
                    {options.map((option) => {
                        const isSelected = selected.includes(option.value);
                        return (
                            <Box
                                key={option.value}
                                as="button"
                                px={1.5}
                                py={0.5}
                                borderRadius="sm"
                                fontSize="2xs"
                                fontWeight="medium"
                                cursor="pointer"
                                transition="all 0.15s"
                                bg={isSelected ? `${color}.100` : 'gray.50'}
                                color={isSelected ? `${color}.700` : 'gray.600'}
                                border="1px solid"
                                borderColor={isSelected ? `${color}.300` : 'gray.200'}
                                _hover={{
                                    bg: isSelected ? `${color}.200` : 'gray.100',
                                    borderColor: isSelected ? `${color}.400` : 'gray.300',
                                }}
                                onClick={() => handleToggle(option.value)}
                                display="inline-flex"
                                alignItems="center"
                                gap={0.5}
                            >
                                {isSelected && <LuCheck size={8} />}
                                {option.label}
                                {option.count !== undefined && (
                                    <Text as="span" fontSize="2xs" color={isSelected ? `${color}.500` : 'gray.400'}>
                                        ({option.count})
                                    </Text>
                                )}
                            </Box>
                        );
                    })}
                    {options.length === 0 && (
                        <Text fontSize="2xs" color="gray.400">No options</Text>
                    )}
                </Flex>
            </Box>
        </Box>
    );
};

// Date Range Card - vertical layout with quick presets
interface DateCardProps {
    dateFrom: string;
    dateTo: string;
    onChangeFrom: (value: string) => void;
    onChangeTo: (value: string) => void;
    onClear: () => void;
}

// Quick date presets
const DATE_PRESETS = [
    { label: '1M', months: 1 },
    { label: '3M', months: 3 },
    { label: '6M', months: 6 },
    { label: '1Y', months: 12 },
];

const DateCard: React.FC<DateCardProps> = ({
    dateFrom,
    dateTo,
    onChangeFrom,
    onChangeTo,
    onClear,
}) => {
    const hasValue = dateFrom || dateTo;

    // Check if current dates match a preset
    const getActivePreset = (): string | null => {
        if (!dateFrom || !dateTo) return null;
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        const toDateStr = dateTo.split('T')[0];

        // Check if "to" date is today
        if (toDateStr !== todayStr) return null;

        for (const preset of DATE_PRESETS) {
            const fromDate = new Date(today);
            fromDate.setMonth(fromDate.getMonth() - preset.months);
            const fromDateStr = fromDate.toISOString().split('T')[0];
            if (dateFrom.split('T')[0] === fromDateStr) {
                return preset.label;
            }
        }
        return null;
    };

    const applyPreset = (months: number) => {
        const range = getDateRangePreset(months);
        onChangeFrom(range.from);
        onChangeTo(range.to);
    };

    const activePreset = getActivePreset();

    return (
        <Box
            bg="white"
            border="1px solid"
            borderColor={hasValue ? 'purple.200' : 'gray.200'}
            borderRadius="md"
            p={2}
            minH="70px"
            overflow="hidden"
        >
            {/* Card Header */}
            <Flex align="center" justify="space-between" mb={1.5}>
                <Flex align="center" gap={1}>
                    <LuCalendar size={10} />
                    <Text fontSize="2xs" fontWeight="semibold" color="gray.600" textTransform="uppercase">
                        Date Range
                    </Text>
                </Flex>
                {hasValue && (
                    <Box
                        as="button"
                        onClick={onClear}
                        color="gray.400"
                        _hover={{ color: 'gray.600' }}
                        cursor="pointer"
                        p={0.5}
                    >
                        <LuX size={10} />
                    </Box>
                )}
            </Flex>

            {/* Quick Presets */}
            <Flex gap={1} mb={1.5} flexWrap="wrap">
                {DATE_PRESETS.map((preset) => {
                    const isActive = activePreset === preset.label;
                    return (
                        <Box
                            key={preset.label}
                            as="button"
                            px={1.5}
                            py={0.5}
                            borderRadius="sm"
                            fontSize="2xs"
                            fontWeight="medium"
                            cursor="pointer"
                            transition="all 0.15s"
                            bg={isActive ? 'purple.100' : 'gray.50'}
                            color={isActive ? 'purple.700' : 'gray.600'}
                            border="1px solid"
                            borderColor={isActive ? 'purple.300' : 'gray.200'}
                            _hover={{
                                bg: isActive ? 'purple.200' : 'gray.100',
                                borderColor: isActive ? 'purple.400' : 'gray.300',
                            }}
                            onClick={() => applyPreset(preset.months)}
                        >
                            {preset.label}
                        </Box>
                    );
                })}
            </Flex>

            {/* Date inputs - Vertical */}
            <Flex direction="column" gap={1}>
                <Box>
                    <Text fontSize="2xs" color="gray.500" mb={0.5}>From</Text>
                    <input
                        type="date"
                        value={dateFrom ? dateFrom.split('T')[0] : ''}
                        onChange={e => onChangeFrom(e.target.value ? `${e.target.value}T00:00` : '')}
                        style={{
                            width: '100%',
                            height: '22px',
                            padding: '0 4px',
                            fontSize: '10px',
                            border: '1px solid #E2E8F0',
                            borderRadius: '4px',
                            backgroundColor: 'white',
                        }}
                    />
                </Box>
                <Box>
                    <Text fontSize="2xs" color="gray.500" mb={0.5}>To</Text>
                    <input
                        type="date"
                        value={dateTo ? dateTo.split('T')[0] : ''}
                        onChange={e => onChangeTo(e.target.value ? `${e.target.value}T23:59` : '')}
                        style={{
                            width: '100%',
                            height: '22px',
                            padding: '0 4px',
                            fontSize: '10px',
                            border: '1px solid #E2E8F0',
                            borderRadius: '4px',
                            backgroundColor: 'white',
                        }}
                    />
                </Box>
            </Flex>
        </Box>
    );
};

// Dropdown Filter Card - for Asset (with search)
interface DropdownCardProps {
    label: string;
    icon: string;
    options: FilterOption[];
    selected: string[];
    onChange: (selected: string[]) => void;
    color: string;
    isOpen: boolean;
    onToggle: () => void;
    onClose: () => void;
}

const DropdownCard: React.FC<DropdownCardProps> = ({
    label,
    icon,
    options,
    selected,
    onChange,
    color,
    isOpen,
    onToggle,
    onClose,
}) => {
    const [search, setSearch] = useState('');
    const cardRef = useRef<HTMLDivElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);

    const filteredOptions = options.filter(o =>
        o.label.toLowerCase().includes(search.toLowerCase())
    );

    const handleToggle = (value: string) => {
        const newSelected = selected.includes(value)
            ? selected.filter(v => v !== value)
            : [...selected, value];
        onChange(newSelected);
    };

    const activeCount = selected.length;

    // Close on click outside
    useEffect(() => {
        if (!isOpen) return;
        const handleClickOutside = (event: MouseEvent) => {
            if (
                popoverRef.current &&
                !popoverRef.current.contains(event.target as Node) &&
                cardRef.current &&
                !cardRef.current.contains(event.target as Node)
            ) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen, onClose]);

    // Get display text for selected items
    const getSelectedDisplay = () => {
        if (selected.length === 0) return 'Select...';
        if (selected.length === 1) {
            const opt = options.find(o => o.value === selected[0]);
            return opt?.label || selected[0];
        }
        return `${selected.length} selected`;
    };

    return (
        <Box
            ref={cardRef}
            bg="white"
            border="1px solid"
            borderColor={activeCount > 0 ? `${color}.200` : 'gray.200'}
            borderRadius="md"
            p={2}
            minH="70px"
            position="relative"
        >
            {/* Card Header */}
            <Flex align="center" justify="space-between" mb={1.5}>
                <Flex align="center" gap={1}>
                    <Text fontSize="xs">{icon}</Text>
                    <Text fontSize="2xs" fontWeight="semibold" color="gray.600" textTransform="uppercase">
                        {label}
                    </Text>
                </Flex>
                {activeCount > 0 && (
                    <Badge size="xs" colorPalette={color} borderRadius="full">
                        {activeCount}
                    </Badge>
                )}
            </Flex>

            {/* Dropdown trigger */}
            <Button
                size="xs"
                variant="outline"
                width="100%"
                justifyContent="space-between"
                onClick={onToggle}
                borderColor={isOpen ? `${color}.300` : 'gray.200'}
                bg={activeCount > 0 ? `${color}.50` : 'white'}
                _hover={{ borderColor: `${color}.300` }}
            >
                <Text fontSize="2xs" color={activeCount > 0 ? `${color}.700` : 'gray.600'} truncate>
                    {getSelectedDisplay()}
                </Text>
                <LuChevronDown
                    size={10}
                    style={{
                        transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s',
                        flexShrink: 0,
                    }}
                />
            </Button>

            {/* Dropdown panel */}
            {isOpen && (
                <Box
                    ref={popoverRef}
                    position="absolute"
                    top="100%"
                    left={0}
                    right={0}
                    mt={1}
                    bg="white"
                    border="1px solid"
                    borderColor="gray.200"
                    borderRadius="md"
                    boxShadow="lg"
                    zIndex={1000}
                    overflow="hidden"
                >
                    {/* Search */}
                    <Box p={1.5} borderBottom="1px solid" borderColor="gray.100">
                        <Flex
                            align="center"
                            bg="gray.50"
                            borderRadius="sm"
                            px={1.5}
                            gap={1}
                        >
                            <LuSearch size={10} color="#A0AEC0" />
                            <input
                                type="text"
                                placeholder="Search..."
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                style={{
                                    flex: 1,
                                    border: 'none',
                                    background: 'transparent',
                                    padding: '6px 0',
                                    fontSize: '10px',
                                    outline: 'none',
                                }}
                            />
                        </Flex>
                    </Box>

                    {/* Quick actions */}
                    <Flex p={1.5} gap={1} borderBottom="1px solid" borderColor="gray.100">
                        <Button size="xs" variant="ghost" onClick={() => onChange(filteredOptions.map(o => o.value))}>
                            <Text fontSize="2xs">All</Text>
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => onChange([])}>
                            <Text fontSize="2xs">None</Text>
                        </Button>
                    </Flex>

                    {/* Options */}
                    <Box maxH="160px" overflowY="auto" p={1}>
                        {filteredOptions.map((option) => {
                            const isSelected = selected.includes(option.value);
                            return (
                                <Box
                                    key={option.value}
                                    px={1.5}
                                    py={1}
                                    cursor="pointer"
                                    borderRadius="sm"
                                    bg={isSelected ? `${color}.50` : undefined}
                                    _hover={{ bg: isSelected ? `${color}.100` : 'gray.50' }}
                                    onClick={() => handleToggle(option.value)}
                                    display="flex"
                                    alignItems="center"
                                    gap={1.5}
                                >
                                    <Box
                                        w="12px"
                                        h="12px"
                                        borderRadius="sm"
                                        border="1px solid"
                                        borderColor={isSelected ? `${color}.500` : 'gray.300'}
                                        bg={isSelected ? `${color}.500` : 'white'}
                                        display="flex"
                                        alignItems="center"
                                        justifyContent="center"
                                        flexShrink={0}
                                    >
                                        {isSelected && <LuCheck size={8} color="white" />}
                                    </Box>
                                    <Text fontSize="2xs" flex={1}>{option.label}</Text>
                                    {option.count !== undefined && (
                                        <Text fontSize="2xs" color="gray.400">({option.count})</Text>
                                    )}
                                </Box>
                            );
                        })}
                        {filteredOptions.length === 0 && (
                            <Text fontSize="2xs" color="gray.400" p={1.5} textAlign="center">
                                No results
                            </Text>
                        )}
                    </Box>
                </Box>
            )}
        </Box>
    );
};

// Category Dropdown Card with Tabs
interface CategoryCardProps {
    categoriesByDimension: DimensionWithCategories[];
    allCategories: FilterOption[];
    selected: string[];
    onChange: (selected: string[]) => void;
    isOpen: boolean;
    onToggle: () => void;
    onClose: () => void;
}

const CategoryCard: React.FC<CategoryCardProps> = ({
    categoriesByDimension,
    allCategories,
    selected,
    onChange,
    isOpen,
    onToggle,
    onClose,
}) => {
    const [activeTab, setActiveTab] = useState<string>(
        categoriesByDimension[0]?.id.toString() || '0'
    );
    const cardRef = useRef<HTMLDivElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);

    const activeCount = selected.length;

    const currentDimension = categoriesByDimension.find(d => d.id.toString() === activeTab);
    const currentCategories = currentDimension?.categories || [];

    // Close on click outside
    useEffect(() => {
        if (!isOpen) return;
        const handleClickOutside = (event: MouseEvent) => {
            if (
                popoverRef.current &&
                !popoverRef.current.contains(event.target as Node) &&
                cardRef.current &&
                !cardRef.current.contains(event.target as Node)
            ) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen, onClose]);

    const handleToggle = (value: string) => {
        const newSelected = selected.includes(value)
            ? selected.filter(v => v !== value)
            : [...selected, value];
        onChange(newSelected);
    };

    const getSelectedDisplay = () => {
        if (selected.length === 0) return 'Select...';
        if (selected.length === 1) {
            const cat = allCategories.find(c => c.value === selected[0]);
            return cat?.label || selected[0];
        }
        return `${selected.length} selected`;
    };

    return (
        <Box
            ref={cardRef}
            bg="white"
            border="1px solid"
            borderColor={activeCount > 0 ? 'pink.200' : 'gray.200'}
            borderRadius="md"
            p={2}
            minH="70px"
            position="relative"
        >
            {/* Card Header */}
            <Flex align="center" justify="space-between" mb={1.5}>
                <Flex align="center" gap={1}>
                    <Text fontSize="xs">📁</Text>
                    <Text fontSize="2xs" fontWeight="semibold" color="gray.600" textTransform="uppercase">
                        Category
                    </Text>
                </Flex>
                {activeCount > 0 && (
                    <Badge size="xs" colorPalette="pink" borderRadius="full">
                        {activeCount}
                    </Badge>
                )}
            </Flex>

            {/* Dropdown trigger */}
            <Button
                size="xs"
                variant="outline"
                width="100%"
                justifyContent="space-between"
                onClick={onToggle}
                borderColor={isOpen ? 'pink.300' : 'gray.200'}
                bg={activeCount > 0 ? 'pink.50' : 'white'}
                _hover={{ borderColor: 'pink.300' }}
            >
                <Text fontSize="2xs" color={activeCount > 0 ? 'pink.700' : 'gray.600'} truncate>
                    {getSelectedDisplay()}
                </Text>
                <LuChevronDown
                    size={10}
                    style={{
                        transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s',
                        flexShrink: 0,
                    }}
                />
            </Button>

            {/* Dropdown panel with tabs */}
            {isOpen && categoriesByDimension.length > 0 && (
                <Box
                    ref={popoverRef}
                    position="absolute"
                    top="100%"
                    left={0}
                    mt={1}
                    bg="white"
                    border="1px solid"
                    borderColor="gray.200"
                    borderRadius="md"
                    boxShadow="lg"
                    zIndex={1000}
                    overflow="hidden"
                    minW="220px"
                >
                    <Tabs.Root
                        value={activeTab}
                        onValueChange={(e) => setActiveTab(e.value)}
                        size="sm"
                    >
                        <Tabs.List px={1.5} pt={1.5}>
                            {categoriesByDimension.map(dim => {
                                const count = selected.filter(s =>
                                    dim.categories.some(c => c.value === s)
                                ).length;
                                return (
                                    <Tabs.Trigger key={dim.id} value={dim.id.toString()}>
                                        <Text fontSize="2xs">{dim.label}</Text>
                                        {count > 0 && (
                                            <Badge size="xs" colorPalette="pink" ml={1}>{count}</Badge>
                                        )}
                                    </Tabs.Trigger>
                                );
                            })}
                        </Tabs.List>

                        {categoriesByDimension.map(dim => (
                            <Tabs.Content key={dim.id} value={dim.id.toString()}>
                                <Box maxH="160px" overflowY="auto" p={1.5}>
                                    <Flex flexWrap="wrap" gap={1}>
                                        {currentCategories.map((cat) => {
                                            const isSelected = selected.includes(cat.value);
                                            return (
                                                <Box
                                                    key={cat.value}
                                                    as="button"
                                                    px={1.5}
                                                    py={0.5}
                                                    borderRadius="sm"
                                                    fontSize="2xs"
                                                    cursor="pointer"
                                                    bg={isSelected ? 'pink.100' : 'gray.50'}
                                                    color={isSelected ? 'pink.700' : 'gray.600'}
                                                    border="1px solid"
                                                    borderColor={isSelected ? 'pink.300' : 'gray.200'}
                                                    _hover={{
                                                        bg: isSelected ? 'pink.200' : 'gray.100',
                                                    }}
                                                    onClick={() => handleToggle(cat.value)}
                                                    display="inline-flex"
                                                    alignItems="center"
                                                    gap={0.5}
                                                >
                                                    {isSelected && <LuCheck size={8} />}
                                                    {cat.label}
                                                </Box>
                                            );
                                        })}
                                    </Flex>
                                </Box>
                            </Tabs.Content>
                        ))}
                    </Tabs.Root>
                </Box>
            )}
        </Box>
    );
};

// Helper to check if filters have changes
const filtersEqual = (a: TransactionFilterState, b: TransactionFilterState): boolean => {
    return JSON.stringify(a) === JSON.stringify(b);
};

export const TransactionFilters: React.FC<TransactionFiltersProps> = ({
    filters,
    onChange,
    onClear,
}) => {
    const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
    const [loading, setLoading] = useState(true);

    // Local state for pending filter changes
    const [localFilters, setLocalFilters] = useState<TransactionFilterState>(filters);

    // Popover states for dropdown cards
    const [openDropdown, setOpenDropdown] = useState<string | null>(null);

    // Sync local filters when applied filters change externally
    useEffect(() => {
        setLocalFilters(filters);
    }, [filters]);

    // Fetch filter options from backend
    useEffect(() => {
        const fetchFilterOptions = async () => {
            try {
                const response = await fetch(`${API_URL}/transactions/filter-options`);
                if (response.ok) {
                    const data = await response.json();
                    setFilterOptions(data);
                }
            } catch (err) {
                console.error('Failed to fetch filter options:', err);
            } finally {
                setLoading(false);
            }
        };
        fetchFilterOptions();
    }, []);

    // Check if there are unapplied changes
    const hasChanges = !filtersEqual(localFilters, filters);

    // Count active filters
    const getActiveFilterCount = (): number => {
        let count = 0;
        if (localFilters.dateFrom || localFilters.dateTo) count++;
        FILTER_DEFS.forEach(def => {
            const values = localFilters[def.key];
            if (Array.isArray(values) && values.length > 0) count++;
        });
        return count;
    };

    // Update local filter state
    const updateLocalFilter = <K extends keyof TransactionFilterState>(
        key: K,
        value: TransactionFilterState[K]
    ) => {
        setLocalFilters(prev => ({ ...prev, [key]: value }));
    };

    // Clear date filter
    const clearDateFilter = () => {
        setLocalFilters(prev => ({ ...prev, dateFrom: '', dateTo: '' }));
    };

    // Apply filters
    const handleApply = () => {
        onChange(localFilters);
    };

    // Reset all filters
    const handleReset = () => {
        setLocalFilters(defaultFilterState);
        onChange(defaultFilterState);
    };

    // Get options for a filter
    const getOptionsForFilter = (def: FilterDef): FilterOption[] => {
        if (!filterOptions || !def.optionsKey) return [];
        return (filterOptions[def.optionsKey] as FilterOption[]) || [];
    };

    if (loading) {
        return (
            <Box p={3} textAlign="center">
                <Text fontSize="xs" color="gray.500">Loading filters...</Text>
            </Box>
        );
    }

    const activeFilterCount = getActiveFilterCount();
    const openFilters = FILTER_DEFS.filter(d => !d.isDropdown);
    const dropdownFilters = FILTER_DEFS.filter(d => d.isDropdown);

    return (
        <Box mb={3}>
            <Box
                p={3}
                bg="gray.50"
                borderRadius="md"
                border="1px solid"
                borderColor={hasChanges ? 'blue.300' : 'gray.200'}
            >
                {/* Header */}
                <Flex align="center" justify="space-between" mb={2}>
                    <Flex align="center" gap={1.5}>
                        <LuFilter size={12} />
                        <Text fontWeight="semibold" fontSize="xs">Filters</Text>
                        {activeFilterCount > 0 && (
                            <Badge size="xs" colorPalette="blue">{activeFilterCount} active</Badge>
                        )}
                    </Flex>
                    <Flex gap={1.5}>
                        {activeFilterCount > 0 && (
                            <Button
                                size="xs"
                                variant="ghost"
                                onClick={handleReset}
                                color="gray.500"
                                _hover={{ color: 'gray.700' }}
                            >
                                <LuRotateCcw size={10} />
                                <Text ml={0.5} fontSize="2xs">Clear All</Text>
                            </Button>
                        )}
                        {hasChanges && (
                            <Button
                                size="xs"
                                colorPalette="blue"
                                onClick={handleApply}
                            >
                                <LuCheck size={10} />
                                <Text ml={0.5} fontSize="2xs">Apply</Text>
                            </Button>
                        )}
                    </Flex>
                </Flex>

                {/* Card Grid - Maximum columns */}
                <SimpleGrid columns={{ base: 1, sm: 2, md: 3, lg: 4, xl: 5 }} gap={2}>
                    {/* Date Range Card - First */}
                    <DateCard
                        dateFrom={localFilters.dateFrom}
                        dateTo={localFilters.dateTo}
                        onChangeFrom={(v) => updateLocalFilter('dateFrom', v)}
                        onChangeTo={(v) => updateLocalFilter('dateTo', v)}
                        onClear={clearDateFilter}
                    />

                    {/* Open Filter Cards: Account, Source, Type, Direction, Taxability, Status */}
                    {openFilters.map(def => {
                        const values = localFilters[def.key] as string[];
                        const options = getOptionsForFilter(def);

                        return (
                            <FilterCard
                                key={def.key}
                                label={def.label}
                                icon={def.icon}
                                options={options}
                                selected={values || []}
                                onChange={(v) => updateLocalFilter(def.key, v)}
                                color={def.color}
                            />
                        );
                    })}

                    {/* Asset Dropdown Card */}
                    <DropdownCard
                        label="Asset"
                        icon="💎"
                        options={filterOptions?.assets || []}
                        selected={localFilters.assetIds || []}
                        onChange={(v) => updateLocalFilter('assetIds', v)}
                        color="orange"
                        isOpen={openDropdown === 'assetIds'}
                        onToggle={() => setOpenDropdown(openDropdown === 'assetIds' ? null : 'assetIds')}
                        onClose={() => setOpenDropdown(null)}
                    />

                    {/* Category Dropdown Card */}
                    <CategoryCard
                        categoriesByDimension={filterOptions?.categories_by_dimension || []}
                        allCategories={filterOptions?.categories || []}
                        selected={localFilters.categoryIds || []}
                        onChange={(v) => updateLocalFilter('categoryIds', v)}
                        isOpen={openDropdown === 'categoryIds'}
                        onToggle={() => setOpenDropdown(openDropdown === 'categoryIds' ? null : 'categoryIds')}
                        onClose={() => setOpenDropdown(null)}
                    />
                </SimpleGrid>
            </Box>
        </Box>
    );
};

export default TransactionFilters;
