import {
    Badge,
    Box,
    Button,
    Flex,
    GridItem,
    SimpleGrid,
    Tabs,
    Text,
} from '@chakra-ui/react';
import React, { useEffect, useRef, useState } from 'react';
import { LuCalendar, LuCheck, LuChevronDown, LuFilter, LuRotateCcw, LuSearch, LuX } from 'react-icons/lu';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { API_URL } from '../types';
import type { AppliedFilters as BackendAppliedFilters, FilterMetadata, ValidationWarning } from '../types';
import { toDateInputString, getDateRangePreset } from '../utils/dateUtils';
import { CounterpartyFilterCard } from './CounterpartyFilterCard';

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
    from_accounts: FilterOption[];
    to_accounts: FilterOption[];
    assets: FilterOption[];
    categories: FilterOption[];
    categories_by_dimension: DimensionWithCategories[];
    dimensions: FilterOption[];
    transaction_types: FilterOption[];
    directions: FilterOption[];
    review_statuses: FilterOption[];
    taxability_statuses: FilterOption[];
    connector_runs: FilterOption[];
    tags: FilterOption[];
    networks: FilterOption[];
    price_quote_assets: FilterOption[];
    fee_quote_assets: FilterOption[];
    bundle_patterns: FilterOption[];
    // P&L context extras
    non_owned_count?: number;
    include_fee_count?: number;
    has_fee_count?: number;
    has_bundle_count?: number;
    total_count?: number;
}

// Current filter state
export interface TransactionFilterState {
    reviewStatus: string[];
    taxability: string[];
    sources: string[];
    accountIds: string[];
    fromAccountIds: string[];
    toAccountIds: string[];
    relatedAccountIds: string[];
    assetIds: string[];
    relatedAssetIds: string[];
    categoryIds: string[];
    transactionTypes: string[];
    directions: string[];
    connectorRunIds: string[];
    tagKeys: string[];
    networks: string[];
    dateFrom: string;
    dateTo: string;
    /** Counterparty filter: show only transactions with non-owned/unmapped counterparties */
    nonOwned: boolean;
    /** Has fees filter: show only transactions that have a fee > 0 */
    hasFees?: boolean;
    /** Include fee filter: show only transactions where include_fee is true/false */
    includeFee?: boolean;
    /** Has bundle filter: show only transactions assigned to a bundle */
    hasBundle?: boolean;
    /** Price quote asset filter */
    priceQuoteAssetIds: string[];
    /** Fee quote asset filter */
    feeQuoteAssetIds: string[];
    /** Bundle pattern filter */
    bundlePatterns: string[];
    // P&L audit filters (hidden from UI, locked to version context)
    versionId?: string;
    inclusionStatus?: 'included' | 'excluded';
    // Transaction ID filter (for issue-specific views)
    transactionIds?: number[];
    // Connector run outcome filter (synced/updated/skipped) — used in job detail drawer
    connectorRunOutcome?: 'synced' | 'updated' | 'skipped';
}

// Default filter state - includes all statuses; invalid rows are collapsed client-side
export const defaultFilterState: TransactionFilterState = {
    reviewStatus: ['pending', 'valid', 'invalid'],  // Fetch all; invalid collapsed in UI
    taxability: [],
    versionId: undefined,
    inclusionStatus: undefined,
    sources: [],
    accountIds: [],
    fromAccountIds: [],
    toAccountIds: [],
    relatedAccountIds: [],
    assetIds: [],
    relatedAssetIds: [],
    categoryIds: [],
    transactionTypes: [],
    directions: [],
    connectorRunIds: [],
    tagKeys: [],
    networks: [],
    dateFrom: '',
    dateTo: '',
    nonOwned: false,
    hasFees: undefined,
    includeFee: undefined,
    hasBundle: undefined,
    priceQuoteAssetIds: [],
    feeQuoteAssetIds: [],
    bundlePatterns: [],
    transactionIds: undefined,
    connectorRunOutcome: undefined,
};

interface TransactionFiltersProps {
    filters: TransactionFilterState;
    onChange: (filters: TransactionFilterState) => void;
    onClear: () => void;
    expanded?: boolean;
    onExpandedChange?: (expanded: boolean) => void;
    appliedFilters?: BackendAppliedFilters | null;
    filterMetadata?: FilterMetadata | null;
    /** Custom reset state - if not provided, uses defaultFilterState */
    resetFilters?: TransactionFilterState;
    /** Custom URL for fetching filter options (default: /transactions/filter-options) */
    filterOptionsUrl?: string;
    /** Custom React Query key for filter options (default: ['filterOptions']) */
    filterOptionsQueryKey?: string[];
    /** Filter keys to hide from the UI */
    hiddenFilters?: (keyof TransactionFilterState)[];
    /** Extra filter cards to render in the grid (e.g., Counterparty) */
    extraFilterCards?: React.ReactNode;
    /** Callback receiving loaded filterOptions for parent to access (e.g. non_owned_count) */
    onFilterOptionsLoaded?: (options: FilterOptions) => void;
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
    searchable?: boolean;
}

// Filter chip data for summary display
interface FilterChipData {
    id: string;
    label: string;
    filterKey: keyof TransactionFilterState;
    value: string;
    category: string;
    color: string;
}

// Order: account, source, type, direction, taxability, status (open) | assets, category, connector run (dropdown)
const FILTER_DEFS: FilterDef[] = [
    { key: 'accountIds', label: 'Account', icon: '👤', type: 'multi', optionsKey: 'accounts', color: 'cyan' },
    { key: 'fromAccountIds', label: 'From Account', icon: '⬅️', type: 'multi', optionsKey: 'from_accounts', color: 'teal', isDropdown: true },
    { key: 'toAccountIds', label: 'To Account', icon: '➡️', type: 'multi', optionsKey: 'to_accounts', color: 'cyan', isDropdown: true },
    { key: 'relatedAccountIds', label: 'Related Account', icon: '🔗', type: 'multi', optionsKey: 'accounts', color: 'cyan', isDropdown: true },
    { key: 'sources', label: 'Source', icon: '🔌', type: 'multi', optionsKey: 'sources', color: 'blue', searchable: true },
    { key: 'transactionTypes', label: 'Type', icon: '🏷️', type: 'multi', optionsKey: 'transaction_types', color: 'teal' },
    { key: 'directions', label: 'Direction', icon: '↔️', type: 'multi', optionsKey: 'directions', color: 'yellow' },
    { key: 'taxability', label: 'Taxability', icon: '💰', type: 'multi', optionsKey: 'taxability_statuses', color: 'red' },
    { key: 'reviewStatus', label: 'Status', icon: '🔄', type: 'multi', optionsKey: 'review_statuses', color: 'green' },
    { key: 'assetIds', label: 'Asset', icon: '💎', type: 'multi', optionsKey: 'assets', color: 'orange', isDropdown: true },
    { key: 'relatedAssetIds', label: 'Related Asset', icon: '🔗', type: 'multi', optionsKey: 'assets', color: 'orange', isDropdown: true },
    { key: 'networks', label: 'Network', icon: '🌐', type: 'multi', optionsKey: 'networks', color: 'emerald', isDropdown: true },
    { key: 'tagKeys', label: 'Tags', icon: '🏷️', type: 'multi', optionsKey: 'tags', color: 'purple', isDropdown: true },
    { key: 'categoryIds', label: 'Category', icon: '📁', type: 'multi', optionsKey: 'categories_by_dimension', color: 'pink', isDropdown: true },
    { key: 'connectorRunIds', label: 'Connector Run', icon: '🔄', type: 'multi', optionsKey: 'connector_runs', color: 'indigo', isDropdown: true },
    { key: 'priceQuoteAssetIds', label: 'Price Quote Asset', icon: '💱', type: 'multi', optionsKey: 'price_quote_assets', color: 'purple', isDropdown: true },
    { key: 'feeQuoteAssetIds', label: 'Fee Quote Asset', icon: '💱', type: 'multi', optionsKey: 'fee_quote_assets', color: 'orange', isDropdown: true },
];

// Filter Card Component - shows all options as toggleable chips (OPEN)
interface FilterCardProps {
    label: string;
    icon: string;
    options: FilterOption[];
    selected: string[];
    onChange: (selected: string[]) => void;
    color: string;
    searchable?: boolean;
}

const FilterCard: React.FC<FilterCardProps> = ({
    label,
    icon,
    options,
    selected,
    onChange,
    color,
    searchable,
}) => {
    const [search, setSearch] = useState('');
    const handleToggle = (value: string) => {
        const newSelected = selected.includes(value)
            ? selected.filter(v => v !== value)
            : [...selected, value];
        onChange(newSelected);
    };

    const activeCount = selected.length;
    const displayOptions = searchable && search
        ? options.filter(o => o.label.toLowerCase().includes(search.toLowerCase()))
        : options;
    const needsScroll = displayOptions.length > 6;

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

            {/* Search box */}
            {searchable && (
                <Flex align="center" gap={1} mb={1.5} px={1} py={1} bg="gray.50" borderRadius="sm">
                    <LuSearch size={10} color="#A0AEC0" />
                    <input
                        type="text"
                        placeholder="Search..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        style={{
                            border: 'none', outline: 'none', background: 'transparent',
                            fontSize: '10px', width: '100%', color: '#4A5568',
                        }}
                    />
                </Flex>
            )}

            {/* Options as toggleable chips - with scroll if > 4 items */}
            <Box
                maxH={needsScroll ? '110px' : 'auto'}
                overflowY={needsScroll ? 'auto' : 'visible'}
                css={{
                    '&::-webkit-scrollbar': { width: '4px' },
                    '&::-webkit-scrollbar-thumb': { background: '#CBD5E0', borderRadius: '2px' },
                }}
            >
                <Flex flexWrap="wrap" gap={1}>
                    {displayOptions.map((option) => {
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
                    {displayOptions.length === 0 && (
                        <Text fontSize="2xs" color="gray.400">No options</Text>
                    )}
                </Flex>
            </Box>
        </Box>
    );
};

// Removable Filter Chip Component
interface FilterChipProps {
    chip: FilterChipData;
    onRemove: (chip: FilterChipData) => void;
}

const FilterChip: React.FC<FilterChipProps> = ({ chip, onRemove }) => {
    return (
        <Badge
            size="sm"
            colorPalette={chip.color}
            display="inline-flex"
            alignItems="center"
            gap={1}
            px={2}
            py={0.5}
            borderRadius="md"
            cursor="pointer"
            transition="all 0.15s"
            _hover={{
                transform: 'scale(0.95)',
                opacity: 0.8,
            }}
            onClick={(e) => {
                e.stopPropagation();
                onRemove(chip);
            }}
        >
            <Text fontSize="xs">{chip.label}</Text>
            <Box
                as="button"
                display="flex"
                alignItems="center"
                onClick={(e) => {
                    e.stopPropagation();
                    onRemove(chip);
                }}
            >
                <LuX size={12} />
            </Box>
        </Badge>
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
                    right={0}
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
    expanded = true,
    onExpandedChange,
    appliedFilters,
    filterMetadata,
    resetFilters,
    filterOptionsUrl,
    filterOptionsQueryKey,
    hiddenFilters,
    extraFilterCards,
    onFilterOptionsLoaded,
}) => {
    const effectiveBaseUrl = filterOptionsUrl || `${API_URL}/transactions/filter-options`;
    const hiddenSet = React.useMemo(() => new Set(hiddenFilters || []), [hiddenFilters]);

    // Build URL search params from applied filters for context-aware counts
    const filterParams = React.useMemo(() => {
        const params = new URLSearchParams();
        if (filters.reviewStatus.length > 0) params.append('review_status', filters.reviewStatus.join(','));
        if (filters.taxability.length > 0) params.append('taxability', filters.taxability.join(','));
        if (filters.sources.length > 0) params.append('source', filters.sources.join(','));
        if (filters.accountIds.length > 0) params.append('account_id', filters.accountIds.join(','));
        if (filters.fromAccountIds?.length) params.append('from_account_id', filters.fromAccountIds.join(','));
        if (filters.toAccountIds?.length) params.append('to_account_id', filters.toAccountIds.join(','));
        if (filters.relatedAccountIds?.length) params.append('related_account_id', filters.relatedAccountIds.join(','));
        if (filters.assetIds.length > 0) params.append('asset_id', filters.assetIds.join(','));
        if (filters.relatedAssetIds.length > 0) params.append('related_asset_id', filters.relatedAssetIds.join(','));
        if (filters.categoryIds.length > 0) params.append('category_id', filters.categoryIds.join(','));
        if (filters.transactionTypes.length > 0) params.append('transaction_type', filters.transactionTypes.join(','));
        if (filters.directions.length > 0) params.append('direction', filters.directions.join(','));
        if (filters.connectorRunIds.length > 0) params.append('connector_run_id', filters.connectorRunIds.join(','));
        if (filters.tagKeys.length > 0) params.append('tag_key', filters.tagKeys.join(','));
        if (filters.networks?.length) params.append('network', filters.networks.join(','));
        if (filters.dateFrom) params.append('date_from', filters.dateFrom);
        if (filters.dateTo) params.append('date_to', filters.dateTo);
        if (filters.transactionIds?.length) params.append('ids', filters.transactionIds.join(','));
        if (filters.hasFees !== undefined) params.append('has_fee', String(filters.hasFees));
        if (filters.includeFee !== undefined) params.append('include_fee', String(filters.includeFee));
        if (filters.hasBundle !== undefined) params.append('has_bundle', String(filters.hasBundle));
        if (filters.priceQuoteAssetIds.length > 0) params.append('price_quote_asset_id', filters.priceQuoteAssetIds.join(','));
        if (filters.feeQuoteAssetIds.length > 0) params.append('fee_quote_asset_id', filters.feeQuoteAssetIds.join(','));
        if (filters.bundlePatterns.length > 0) params.append('bundle_pattern', filters.bundlePatterns.join(','));
        return params;
    }, [filters]);

    const effectiveUrl = React.useMemo(() => {
        const qs = filterParams.toString();
        return qs ? `${effectiveBaseUrl}?${qs}` : effectiveBaseUrl;
    }, [effectiveBaseUrl, filterParams]);

    // Query key includes applied filter state so cache is keyed per filter combination
    const filterKey = React.useMemo(() => JSON.stringify(filters), [filters]);
    const effectiveQueryKey = filterOptionsQueryKey || ['filterOptions', filterKey];

    const { data: filterOptions = null, isLoading: loading } = useQuery({
        queryKey: effectiveQueryKey,
        queryFn: async () => {
            const response = await fetch(effectiveUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json() as Promise<FilterOptions>;
        },
        staleTime: 30_000, // 30 seconds — filter counts refresh on invalidation or after brief staleness
        placeholderData: keepPreviousData, // Keep previous data visible while refetching for new filter state
        retry: 2,
    });

    // Notify parent when filter options load (e.g., for non_owned_count)
    const prevOptionsRef = useRef<FilterOptions | null>(null);
    useEffect(() => {
        if (filterOptions && filterOptions !== prevOptionsRef.current) {
            prevOptionsRef.current = filterOptions;
            onFilterOptionsLoaded?.(filterOptions);
        }
    }, [filterOptions, onFilterOptionsLoaded]);

    // Local state for pending filter changes
    const [localFilters, setLocalFilters] = useState<TransactionFilterState>(filters);

    // Popover states for dropdown cards
    const [openDropdown, setOpenDropdown] = useState<string | null>(null);

    // Chip container ref and visible chip count for dynamic truncation
    const chipContainerRef = useRef<HTMLDivElement>(null);
    const [visibleChipCount, setVisibleChipCount] = useState<number>(999);

    // Sync local filters when applied (parent) filters change externally
    // Use JSON comparison to avoid re-syncing when values are the same
    const prevFilterJsonRef = useRef(JSON.stringify(filters));
    useEffect(() => {
        const newJson = JSON.stringify(filters);
        if (newJson !== prevFilterJsonRef.current) {
            prevFilterJsonRef.current = newJson;
            setLocalFilters(filters);
        }
    }, [filters]);

    // Check if there are unapplied changes
    const hasChanges = !filtersEqual(localFilters, filters);

    // The effective reset target: resetFilters prop or defaultFilterState
    const effectiveResetState = resetFilters || defaultFilterState;

    // Count active filters relative to the reset state,
    // so filters that are part of the default/reset state aren't counted
    const getActiveFilterCount = (): number => {
        let count = 0;
        const resetDates = effectiveResetState;
        if ((localFilters.dateFrom || localFilters.dateTo) &&
            (localFilters.dateFrom !== resetDates.dateFrom || localFilters.dateTo !== resetDates.dateTo)) count++;
        if (localFilters.nonOwned && !effectiveResetState.nonOwned) count++;
        if (localFilters.hasFees !== undefined && localFilters.hasFees !== effectiveResetState.hasFees) count++;
        if (localFilters.includeFee !== undefined && localFilters.includeFee !== effectiveResetState.includeFee) count++;
        if (localFilters.hasBundle !== undefined && localFilters.hasBundle !== effectiveResetState.hasBundle) count++;
        if (localFilters.transactionIds?.length) count++;
        FILTER_DEFS.forEach(def => {
            const values = localFilters[def.key];
            const resetValues = effectiveResetState[def.key];
            if (Array.isArray(values) && Array.isArray(resetValues)) {
                // Only count as active if different from reset state
                if (JSON.stringify(values) !== JSON.stringify(resetValues)) count++;
            } else if (Array.isArray(values) && values.length > 0) {
                count++;
            }
        });
        return count;
    };

    // Whether filters differ from the reset state (used to show "Clear All" button)
    const canReset = !filtersEqual(localFilters, effectiveResetState);

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
        const targetState = resetFilters || defaultFilterState;
        setLocalFilters(targetState);
        onChange(targetState);
    };

    // Get options for a filter
    const getOptionsForFilter = (def: FilterDef): FilterOption[] => {
        if (!filterOptions || !def.optionsKey) return [];
        // categories_by_dimension is DimensionWithCategories[], not FilterOption[] —
        // flatten it so chip display and label resolution work correctly.
        if (def.optionsKey === 'categories_by_dimension') {
            return (filterOptions.categories_by_dimension || []).flatMap(dim =>
                dim.categories.map(cat => ({ value: cat.value, label: cat.label, count: undefined }))
            );
        }
        return (filterOptions[def.optionsKey] as FilterOption[]) || [];
    };

    // Convert filter state to chip data
    // Use appliedFilters from backend as source of truth if available
    const getFilterChips = (): FilterChipData[] => {
        if (!filterOptions) return [];
        const chips: FilterChipData[] = [];

        // Use backend applied filters if available, otherwise fall back to local filters
        const sourceFilters = appliedFilters || {
            review_statuses: localFilters.reviewStatus,
            taxability: localFilters.taxability[0],
            sources: localFilters.sources,
            account_ids: localFilters.accountIds,
            from_account_ids: localFilters.fromAccountIds,
            to_account_ids: localFilters.toAccountIds,
            related_account_ids: localFilters.relatedAccountIds,
            asset_ids: localFilters.assetIds,
            related_asset_ids: localFilters.relatedAssetIds,
            category_ids: localFilters.categoryIds,
            transaction_types: localFilters.transactionTypes,
            directions: localFilters.directions,
            connector_run_ids: localFilters.connectorRunIds,
            tag_keys: localFilters.tagKeys,
            networks: localFilters.networks,
            date_from: localFilters.dateFrom,
            date_to: localFilters.dateTo,
            pnl_cal_version: localFilters.versionId ? Number(localFilters.versionId) : undefined,
            pnl_cal_inclusions_status: localFilters.inclusionStatus,
        };

        // P&L Calculation Version chip
        if (sourceFilters.pnl_cal_version) {
            chips.push({
                id: 'pnl-version',
                label: `P&L Version: #${sourceFilters.pnl_cal_version}`,
                filterKey: 'versionId',
                value: String(sourceFilters.pnl_cal_version),
                category: 'P&L Context',
                color: 'purple',
            });
        }

        // P&L Inclusion Status chip
        if (sourceFilters.pnl_cal_inclusions_status) {
            const statusLabel = sourceFilters.pnl_cal_inclusions_status === 'included' ? 'Included in P&L' : 'Excluded from P&L';
            chips.push({
                id: 'pnl-inclusion',
                label: statusLabel,
                filterKey: 'inclusionStatus',
                value: sourceFilters.pnl_cal_inclusions_status,
                category: 'P&L Context',
                color: sourceFilters.pnl_cal_inclusions_status === 'included' ? 'green' : 'orange',
            });
        }

        // Non-owned counterparty chip
        if (localFilters.nonOwned) {
            chips.push({
                id: 'non-owned',
                label: 'Non-Owned Counterparties',
                filterKey: 'nonOwned' as keyof TransactionFilterState,
                value: 'true',
                category: 'Counterparty',
                color: 'red',
            });
        }

        // Has fees chip
        if (localFilters.hasFees !== undefined) {
            chips.push({
                id: 'has-fees',
                label: localFilters.hasFees ? 'Has Fees' : 'No Fees',
                filterKey: 'hasFees' as keyof TransactionFilterState,
                value: String(localFilters.hasFees),
                category: 'Fee',
                color: 'orange',
            });
        }

        // Include fee chip
        if (localFilters.includeFee !== undefined) {
            chips.push({
                id: 'include-fee',
                label: localFilters.includeFee ? 'Fee in Cost Basis' : 'Fee Not in Cost Basis',
                filterKey: 'includeFee' as keyof TransactionFilterState,
                value: String(localFilters.includeFee),
                category: 'Fee',
                color: 'orange',
            });
        }

        // Has bundle chip
        if (localFilters.hasBundle !== undefined) {
            chips.push({
                id: 'has-bundle',
                label: localFilters.hasBundle ? 'Has Bundle' : 'No Bundle',
                filterKey: 'hasBundle' as keyof TransactionFilterState,
                value: String(localFilters.hasBundle),
                category: 'Bundle',
                color: 'teal',
            });
        }

        // Transaction IDs chip
        if (localFilters.transactionIds?.length) {
            chips.push({
                id: 'transaction-ids',
                label: `IDs: ${localFilters.transactionIds.join(', ')}`,
                filterKey: 'transactionIds' as keyof TransactionFilterState,
                value: localFilters.transactionIds.join(','),
                category: 'ID',
                color: 'gray',
            });
        }

        // Date range chip
        if (sourceFilters.date_from || sourceFilters.date_to) {
            const fromStr = sourceFilters.date_from ? new Date(sourceFilters.date_from).toLocaleDateString() : '';
            const toStr = sourceFilters.date_to ? new Date(sourceFilters.date_to).toLocaleDateString() : '';
            let label = 'Date: ';
            if (fromStr && toStr) label += `${fromStr} - ${toStr}`;
            else if (fromStr) label += `From ${fromStr}`;
            else if (toStr) label += `Until ${toStr}`;

            chips.push({
                id: 'date-range',
                label,
                filterKey: 'dateFrom',
                value: 'date',
                category: 'Date',
                color: 'purple',
            });
        }

        // Array-based filters
        FILTER_DEFS.forEach(def => {
            let values: (string | number)[] = [];

            // Map backend applied_filters to filter def keys
            if (def.key === 'reviewStatus' && sourceFilters.review_statuses?.length) {
                values = sourceFilters.review_statuses;
            } else if (def.key === 'taxability' && sourceFilters.taxability) {
                values = [sourceFilters.taxability];
            } else if (def.key === 'sources') {
                values = sourceFilters.sources || [];
            } else if (def.key === 'accountIds') {
                values = sourceFilters.account_ids || [];
            } else if (def.key === 'fromAccountIds') {
                values = sourceFilters.from_account_ids || [];
            } else if (def.key === 'toAccountIds') {
                values = sourceFilters.to_account_ids || [];
            } else if (def.key === 'relatedAccountIds') {
                values = sourceFilters.related_account_ids || [];
            } else if (def.key === 'assetIds') {
                values = sourceFilters.asset_ids || [];
            } else if (def.key === 'relatedAssetIds') {
                values = sourceFilters.related_asset_ids || [];
            } else if (def.key === 'categoryIds') {
                values = sourceFilters.category_ids || [];
            } else if (def.key === 'transactionTypes') {
                values = sourceFilters.transaction_types || [];
            } else if (def.key === 'directions') {
                values = sourceFilters.directions || [];
            } else if (def.key === 'connectorRunIds') {
                values = sourceFilters.connector_run_ids || [];
            } else if (def.key === 'tagKeys') {
                values = sourceFilters.tag_keys || [];
            } else if (def.key === 'networks') {
                values = sourceFilters.networks || [];
            }

            if (!Array.isArray(values) || values.length === 0) return;

            const options = getOptionsForFilter(def);
            values.forEach(value => {
                const valueStr = String(value);
                const option = options.find(o => o.value === valueStr);
                if (option) {
                    chips.push({
                        id: `${def.key}-${value}`,
                        label: `${def.label}: ${option.label}`,
                        filterKey: def.key,
                        value: valueStr,
                        category: def.label,
                        color: def.color,
                    });
                }
            });
        });

        return chips;
    };

    // Handle removing a chip
    const handleRemoveChip = (chip: FilterChipData) => {
        if (chip.filterKey === 'versionId' || chip.filterKey === 'inclusionStatus') {
            // P&L context filters cannot be removed individually - they define the view context
            // User should navigate away from P&L audit view instead
            return;
        }
        if (chip.filterKey === 'nonOwned') {
            // Toggle off non-owned filter
            const newFilters = { ...localFilters, nonOwned: false };
            setLocalFilters(newFilters);
            onChange(newFilters);
        } else if (chip.filterKey === 'hasFees') {
            const newFilters = { ...localFilters, hasFees: undefined };
            setLocalFilters(newFilters);
            onChange(newFilters);
        } else if (chip.filterKey === 'includeFee') {
            const newFilters = { ...localFilters, includeFee: undefined };
            setLocalFilters(newFilters);
            onChange(newFilters);
        } else if (chip.filterKey === 'hasBundle') {
            const newFilters = { ...localFilters, hasBundle: undefined };
            setLocalFilters(newFilters);
            onChange(newFilters);
        } else if (chip.filterKey === 'transactionIds') {
            const newFilters = { ...localFilters, transactionIds: undefined };
            setLocalFilters(newFilters);
            onChange(newFilters);
        } else if (chip.filterKey === 'dateFrom') {
            // Clear date range
            const newFilters = { ...localFilters, dateFrom: '', dateTo: '' };
            setLocalFilters(newFilters);
            onChange(newFilters);
        } else {
            // Remove from array
            const currentValues = localFilters[chip.filterKey] as string[];
            const newValues = currentValues.filter(v => v !== chip.value);
            const newFilters = { ...localFilters, [chip.filterKey]: newValues };
            setLocalFilters(newFilters);
            onChange(newFilters);
        }
    };

    // Measure chip container width and adjust visible count
    useEffect(() => {
        if (!chipContainerRef.current) return;

        const observer = new ResizeObserver(entries => {
            for (const entry of entries) {
                const width = entry.contentRect.width;
                // Estimate: each chip ~80px, leave space for "and X more"
                const estimatedChipWidth = 90;
                const moreButtonWidth = 80;
                const availableWidth = width - moreButtonWidth;
                const maxChips = Math.max(1, Math.floor(availableWidth / estimatedChipWidth));
                setVisibleChipCount(maxChips);
            }
        });

        observer.observe(chipContainerRef.current);
        return () => observer.disconnect();
    }, []);

    if (loading) {
        return (
            <Box p={3} textAlign="center">
                <Text fontSize="xs" color="gray.500">Loading filters...</Text>
            </Box>
        );
    }

    const activeFilterCount = getActiveFilterCount();
    const openFilters = FILTER_DEFS.filter(d => !d.isDropdown && !hiddenSet.has(d.key));
    const dropdownFilters = FILTER_DEFS.filter(d => d.isDropdown && !hiddenSet.has(d.key));
    const filterChips = getFilterChips();
    const hasActiveFilters = filterChips.length > 0;
    const visibleChips = filterChips.slice(0, visibleChipCount);
    const hiddenChipCount = Math.max(0, filterChips.length - visibleChipCount);

    return (
        <Box mb={3}>
            <Box
                bg="gray.50"
                borderRadius="md"
                border="1px solid"
                borderColor={hasChanges ? 'blue.300' : 'gray.200'}
                overflow="visible"
            >
                {/* Clickable Header */}
                <Flex
                    align="center"
                    justify="space-between"
                    p={3}
                    cursor="pointer"
                    transition="background 0.15s"
                    _hover={{ bg: 'gray.100' }}
                    onClick={() => onExpandedChange?.(!expanded)}
                    borderRadius="md"
                >
                    <Flex align="center" gap={1.5} flex={1} minW={0} flexWrap="wrap">
                        <Box transition="transform 0.2s" transform={expanded ? 'rotate(0deg)' : 'rotate(-90deg)'}>
                            <LuChevronDown size={14} />
                        </Box>
                        <LuFilter size={12} />
                        <Text fontWeight="semibold" fontSize="xs">Filters</Text>
                        {activeFilterCount > 0 && (
                            <Badge size="xs" colorPalette="blue">{activeFilterCount} active</Badge>
                        )}
                        {/* Inline filter chips */}
                        {hasActiveFilters && !expanded && visibleChips.map(chip => (
                            <Box key={chip.id} onClick={(e) => e.stopPropagation()}>
                                <FilterChip chip={chip} onRemove={handleRemoveChip} />
                            </Box>
                        ))}
                        {hasActiveFilters && !expanded && hiddenChipCount > 0 && (
                            <Badge size="sm" colorPalette="gray" variant="outline">
                                +{hiddenChipCount}
                            </Badge>
                        )}
                    </Flex>
                    <Flex gap={1.5} flexShrink={0} onClick={(e) => e.stopPropagation()}>
                        {canReset && (
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

                {/* Chip Summary Row — only when expanded */}
                {hasActiveFilters && expanded && (
                    <Box
                        ref={chipContainerRef}
                        px={3}
                        pb={2}
                        pt={0}
                    >
                        <Flex flexWrap="wrap" gap={1.5} align="center">
                            {visibleChips.map(chip => (
                                <FilterChip key={chip.id} chip={chip} onRemove={handleRemoveChip} />
                            ))}
                            {hiddenChipCount > 0 && (
                                <Badge size="sm" colorPalette="gray" variant="outline">
                                    and {hiddenChipCount} more
                                </Badge>
                            )}
                        </Flex>

                        {/* Filter Metadata - Show counts */}
                        {filterMetadata && (
                            <Text fontSize="2xs" color="gray.500" mt={1}>
                                Showing {filterMetadata.filtered_count} of {filterMetadata.total_count} transactions
                            </Text>
                        )}

                        {/* Validation Warnings */}
                        {filterMetadata?.validation_warnings && filterMetadata.validation_warnings.length > 0 && (
                            <Box mt={2}>
                                {filterMetadata.validation_warnings.map((warning, idx) => (
                                    <Flex key={idx} gap={1} align="center" fontSize="2xs" color={warning.severity === 'error' ? 'red.600' : 'orange.600'}>
                                        <Text fontWeight="semibold">⚠️</Text>
                                        <Text>
                                            <strong>{warning.filter_name}:</strong> {warning.reason} ({warning.provided_value})
                                        </Text>
                                    </Flex>
                                ))}
                            </Box>
                        )}
                    </Box>
                )}

                {/* Filter Cards */}
                {expanded && (
                    <Box p={3} pt={hasActiveFilters ? 1 : 2} overflow="visible">

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
                                const isWideCard = def.key === 'accountIds' || def.key === 'sources';

                                const filterCard = (
                                    <FilterCard
                                        key={def.key}
                                        label={def.label}
                                        icon={def.icon}
                                        options={options}
                                        selected={values || []}
                                        onChange={(v) => updateLocalFilter(def.key, v)}
                                        color={def.color}
                                        searchable={def.searchable}
                                    />
                                );

                                return isWideCard ? (
                                    <GridItem key={def.key} colSpan={{ base: 1, md: 2 }}>
                                        {filterCard}
                                    </GridItem>
                                ) : (
                                    filterCard
                                );
                            })}

                            {/* Asset Dropdown Card */}
                            {!hiddenSet.has('assetIds') && (
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
                            )}

                            {/* Related Asset Dropdown Card (matches base, price quote, fee quote) */}
                            {!hiddenSet.has('relatedAssetIds') && (
                                <DropdownCard
                                    label="Related Asset"
                                    icon="🔗"
                                    options={filterOptions?.assets || []}
                                    selected={localFilters.relatedAssetIds || []}
                                    onChange={(v) => updateLocalFilter('relatedAssetIds', v)}
                                    color="orange"
                                    isOpen={openDropdown === 'relatedAssetIds'}
                                    onToggle={() => setOpenDropdown(openDropdown === 'relatedAssetIds' ? null : 'relatedAssetIds')}
                                    onClose={() => setOpenDropdown(null)}
                                />
                            )}

                            {/* Related Account Dropdown Card (matches account, from account, to account) */}
                            {!hiddenSet.has('relatedAccountIds') && (
                                <DropdownCard
                                    label="Related Account"
                                    icon="🔗"
                                    options={filterOptions?.accounts || []}
                                    selected={localFilters.relatedAccountIds || []}
                                    onChange={(v) => updateLocalFilter('relatedAccountIds', v)}
                                    color="cyan"
                                    isOpen={openDropdown === 'relatedAccountIds'}
                                    onToggle={() => setOpenDropdown(openDropdown === 'relatedAccountIds' ? null : 'relatedAccountIds')}
                                    onClose={() => setOpenDropdown(null)}
                                />
                            )}

                            {/* From Account Dropdown Card */}
                            {!hiddenSet.has('fromAccountIds') && (
                                <DropdownCard
                                    label="From Account"
                                    icon="⬅️"
                                    options={filterOptions?.from_accounts || []}
                                    selected={localFilters.fromAccountIds || []}
                                    onChange={(v) => updateLocalFilter('fromAccountIds', v)}
                                    color="teal"
                                    isOpen={openDropdown === 'fromAccountIds'}
                                    onToggle={() => setOpenDropdown(openDropdown === 'fromAccountIds' ? null : 'fromAccountIds')}
                                    onClose={() => setOpenDropdown(null)}
                                />
                            )}

                            {/* To Account Dropdown Card */}
                            {!hiddenSet.has('toAccountIds') && (
                                <DropdownCard
                                    label="To Account"
                                    icon="➡️"
                                    options={filterOptions?.to_accounts || []}
                                    selected={localFilters.toAccountIds || []}
                                    onChange={(v) => updateLocalFilter('toAccountIds', v)}
                                    color="cyan"
                                    isOpen={openDropdown === 'toAccountIds'}
                                    onToggle={() => setOpenDropdown(openDropdown === 'toAccountIds' ? null : 'toAccountIds')}
                                    onClose={() => setOpenDropdown(null)}
                                />
                            )}

                            {/* Network Dropdown Card */}
                            {!hiddenSet.has('networks') && (
                                <DropdownCard
                                    label="Network"
                                    icon="🌐"
                                    options={filterOptions?.networks || []}
                                    selected={localFilters.networks || []}
                                    onChange={(v) => updateLocalFilter('networks', v)}
                                    color="emerald"
                                    isOpen={openDropdown === 'networks'}
                                    onToggle={() => setOpenDropdown(openDropdown === 'networks' ? null : 'networks')}
                                    onClose={() => setOpenDropdown(null)}
                                />
                            )}

                            {/* Category Dropdown Card */}
                            {!hiddenSet.has('categoryIds') && (
                                <CategoryCard
                                    categoriesByDimension={filterOptions?.categories_by_dimension || []}
                                    allCategories={filterOptions?.categories || []}
                                    selected={localFilters.categoryIds || []}
                                    onChange={(v) => updateLocalFilter('categoryIds', v)}
                                    isOpen={openDropdown === 'categoryIds'}
                                    onToggle={() => setOpenDropdown(openDropdown === 'categoryIds' ? null : 'categoryIds')}
                                    onClose={() => setOpenDropdown(null)}
                                />
                            )}

                            {/* Connector Run Dropdown Card */}
                            {!hiddenSet.has('connectorRunIds') && (
                                <DropdownCard
                                    label="Connector Run"
                                    icon="🔄"
                                    options={filterOptions?.connector_runs || []}
                                    selected={localFilters.connectorRunIds || []}
                                    onChange={(v) => updateLocalFilter('connectorRunIds', v)}
                                    color="indigo"
                                    isOpen={openDropdown === 'connectorRunIds'}
                                    onToggle={() => setOpenDropdown(openDropdown === 'connectorRunIds' ? null : 'connectorRunIds')}
                                    onClose={() => setOpenDropdown(null)}
                                />
                            )}

                            {/* Tags Dropdown Card (Searchable) */}
                            {!hiddenSet.has('tagKeys') && (
                                <DropdownCard
                                    label="Tags"
                                    icon="🏷️"
                                    options={filterOptions?.tags || []}
                                    selected={localFilters.tagKeys || []}
                                    onChange={(v) => updateLocalFilter('tagKeys', v)}
                                    color="purple"
                                    isOpen={openDropdown === 'tagKeys'}
                                    onToggle={() => setOpenDropdown(openDropdown === 'tagKeys' ? null : 'tagKeys')}
                                    onClose={() => setOpenDropdown(null)}
                                />
                            )}

                            {/* Transaction ID filter card */}
                            {!hiddenSet.has('transactionIds') && (
                                <Box
                                    bg="white"
                                    border="1px solid"
                                    borderColor={localFilters.transactionIds?.length ? 'gray.300' : 'gray.200'}
                                    borderRadius="md"
                                    p={2}
                                    minH="70px"
                                >
                                    <Flex align="center" justify="space-between" mb={1.5}>
                                        <Flex align="center" gap={1}>
                                            <Text fontSize="xs">#️⃣</Text>
                                            <Text fontSize="2xs" fontWeight="semibold" color="gray.600" textTransform="uppercase">
                                                Transaction IDs
                                            </Text>
                                        </Flex>
                                        {localFilters.transactionIds?.length ? (
                                            <Badge size="xs" colorPalette="gray" borderRadius="full">
                                                {localFilters.transactionIds.length}
                                            </Badge>
                                        ) : null}
                                    </Flex>
                                    <Flex align="center" gap={1} px={1} py={1} bg="gray.50" borderRadius="sm">
                                        <LuSearch size={10} color="#A0AEC0" />
                                        <input
                                            type="text"
                                            placeholder="e.g. 42, 99, 105"
                                            value={localFilters.transactionIds?.join(', ') || ''}
                                            onChange={(e) => {
                                                const raw = e.target.value;
                                                if (!raw.trim()) {
                                                    updateLocalFilter('transactionIds', undefined);
                                                    return;
                                                }
                                                const ids = raw
                                                    .split(/[,\s]+/)
                                                    .map(s => s.trim())
                                                    .filter(s => /^\d+$/.test(s))
                                                    .map(Number);
                                                updateLocalFilter('transactionIds', ids.length > 0 ? ids : undefined);
                                            }}
                                            style={{
                                                border: 'none', outline: 'none', background: 'transparent',
                                                fontSize: '10px', width: '100%', color: '#4A5568',
                                            }}
                                        />
                                        {localFilters.transactionIds?.length ? (
                                            <Box
                                                as="button"
                                                onClick={() => updateLocalFilter('transactionIds', undefined)}
                                                cursor="pointer"
                                                color="gray.400"
                                                _hover={{ color: 'gray.600' }}
                                            >
                                                <LuX size={10} />
                                            </Box>
                                        ) : null}
                                    </Flex>
                                    <Text fontSize="2xs" color="gray.400" mt={1}>
                                        Comma-separated IDs
                                    </Text>
                                </Box>
                            )}

                            {/* Fees filter card (Has Fees + Include Fee) */}
                            {!hiddenSet.has('hasFees') && (
                                <Box
                                    bg="white"
                                    border="1px solid"
                                    borderColor={localFilters.hasFees !== undefined || localFilters.includeFee !== undefined ? 'orange.200' : 'gray.200'}
                                    borderRadius="md"
                                    p={2}
                                    minH="70px"
                                >
                                    <Flex align="center" justify="space-between" mb={1.5}>
                                        <Flex align="center" gap={1}>
                                            <Text fontSize="xs">💸</Text>
                                            <Text fontSize="2xs" fontWeight="semibold" color="gray.600" textTransform="uppercase">
                                                Fees
                                            </Text>
                                        </Flex>
                                        {(localFilters.hasFees !== undefined || localFilters.includeFee !== undefined) && (
                                            <Badge size="xs" colorPalette="orange">active</Badge>
                                        )}
                                    </Flex>
                                    <Flex flexWrap="wrap" gap={1.5}>
                                        <Badge
                                            size="sm"
                                            variant={localFilters.hasFees ? 'solid' : 'outline'}
                                            colorPalette={localFilters.hasFees ? 'orange' : 'gray'}
                                            cursor="pointer"
                                            userSelect="none"
                                            onClick={() => updateLocalFilter('hasFees', localFilters.hasFees ? undefined : true)}
                                            _hover={{ opacity: 0.8 }}
                                        >
                                            Has Fees{filterOptions?.has_fee_count != null ? ` (${filterOptions.has_fee_count})` : ''}
                                        </Badge>
                                        <Badge
                                            size="sm"
                                            variant={localFilters.hasFees === false ? 'solid' : 'outline'}
                                            colorPalette={localFilters.hasFees === false ? 'red' : 'gray'}
                                            cursor="pointer"
                                            userSelect="none"
                                            onClick={() => updateLocalFilter('hasFees', localFilters.hasFees === false ? undefined : false)}
                                            _hover={{ opacity: 0.8 }}
                                        >
                                            No Fees{filterOptions?.total_count != null && filterOptions?.has_fee_count != null ? ` (${filterOptions.total_count - filterOptions.has_fee_count})` : ''}
                                        </Badge>
                                        <Badge
                                            size="sm"
                                            variant={localFilters.includeFee === true ? 'solid' : 'outline'}
                                            colorPalette={localFilters.includeFee === true ? 'green' : 'gray'}
                                            cursor="pointer"
                                            userSelect="none"
                                            title="Fee included in P&L cost basis calculation"
                                            onClick={() => updateLocalFilter('includeFee', localFilters.includeFee === true ? undefined : true)}
                                            _hover={{ opacity: 0.8 }}
                                        >
                                            Fee in Cost Basis{filterOptions?.include_fee_count != null ? ` (${filterOptions.include_fee_count})` : ''}
                                        </Badge>
                                        <Badge
                                            size="sm"
                                            variant={localFilters.includeFee === false ? 'solid' : 'outline'}
                                            colorPalette={localFilters.includeFee === false ? 'red' : 'gray'}
                                            cursor="pointer"
                                            userSelect="none"
                                            title="Fee excluded from P&L cost basis calculation"
                                            onClick={() => updateLocalFilter('includeFee', localFilters.includeFee === false ? undefined : false)}
                                            _hover={{ opacity: 0.8 }}
                                        >
                                            Fee Not in Cost Basis{filterOptions?.total_count != null && filterOptions?.include_fee_count != null ? ` (${filterOptions.total_count - filterOptions.include_fee_count})` : ''}
                                        </Badge>
                                    </Flex>
                                </Box>
                            )}

                            {/* Counterparty filter card (non-owned / unmapped) */}
                            {filterOptions?.non_owned_count != null && filterOptions.non_owned_count > 0 && (
                                <CounterpartyFilterCard
                                    nonOwned={localFilters.nonOwned}
                                    onToggle={(v) => updateLocalFilter('nonOwned', v)}
                                    nonOwnedCount={filterOptions.non_owned_count}
                                />
                            )}

                            {/* Bundle filter card (Has Bundle toggle + Pattern chips) */}
                            {!hiddenSet.has('hasBundle') && (
                                <Box
                                    bg="white"
                                    border="1px solid"
                                    borderColor={localFilters.hasBundle !== undefined || (localFilters.bundlePatterns?.length ?? 0) > 0 ? 'teal.200' : 'gray.200'}
                                    borderRadius="md"
                                    p={2}
                                    minH="70px"
                                >
                                    <Flex align="center" justify="space-between" mb={1.5}>
                                        <Flex align="center" gap={1}>
                                            <Text fontSize="xs">📦</Text>
                                            <Text fontSize="2xs" fontWeight="semibold" color="gray.600" textTransform="uppercase">
                                                Bundle
                                            </Text>
                                        </Flex>
                                        {(localFilters.hasBundle !== undefined || (localFilters.bundlePatterns?.length ?? 0) > 0) && (
                                            <Badge size="xs" colorPalette="teal">active</Badge>
                                        )}
                                    </Flex>
                                    <Flex flexWrap="wrap" gap={1.5}>
                                        <Badge
                                            size="sm"
                                            variant={localFilters.hasBundle === true ? 'solid' : 'outline'}
                                            colorPalette={localFilters.hasBundle === true ? 'teal' : 'gray'}
                                            cursor="pointer"
                                            userSelect="none"
                                            onClick={() => updateLocalFilter('hasBundle', localFilters.hasBundle === true ? undefined : true)}
                                            _hover={{ opacity: 0.8 }}
                                        >
                                            Has Bundle{filterOptions?.has_bundle_count != null ? ` (${filterOptions.has_bundle_count})` : ''}
                                        </Badge>
                                        <Badge
                                            size="sm"
                                            variant={localFilters.hasBundle === false ? 'solid' : 'outline'}
                                            colorPalette={localFilters.hasBundle === false ? 'red' : 'gray'}
                                            cursor="pointer"
                                            userSelect="none"
                                            onClick={() => updateLocalFilter('hasBundle', localFilters.hasBundle === false ? undefined : false)}
                                            _hover={{ opacity: 0.8 }}
                                        >
                                            No Bundle{filterOptions?.total_count != null && filterOptions?.has_bundle_count != null ? ` (${filterOptions.total_count - filterOptions.has_bundle_count})` : ''}
                                        </Badge>
                                    </Flex>
                                    {/* Bundle Pattern chips */}
                                    {(filterOptions?.bundle_patterns?.length ?? 0) > 0 && (
                                        <Flex flexWrap="wrap" gap={1} mt={2}>
                                            {(filterOptions?.bundle_patterns || []).map((opt) => {
                                                const isSelected = (localFilters.bundlePatterns || []).includes(opt.value);
                                                return (
                                                    <Box
                                                        key={opt.value}
                                                        as="button"
                                                        px={1.5}
                                                        py={0.5}
                                                        borderRadius="sm"
                                                        fontSize="2xs"
                                                        fontWeight="medium"
                                                        cursor="pointer"
                                                        transition="all 0.15s"
                                                        bg={isSelected ? 'teal.100' : 'gray.50'}
                                                        color={isSelected ? 'teal.700' : 'gray.600'}
                                                        border="1px solid"
                                                        borderColor={isSelected ? 'teal.300' : 'gray.200'}
                                                        _hover={{
                                                            bg: isSelected ? 'teal.200' : 'gray.100',
                                                            borderColor: isSelected ? 'teal.400' : 'gray.300',
                                                        }}
                                                        onClick={() => {
                                                            const current = localFilters.bundlePatterns || [];
                                                            const next = isSelected
                                                                ? current.filter(v => v !== opt.value)
                                                                : [...current, opt.value];
                                                            updateLocalFilter('bundlePatterns', next);
                                                        }}
                                                        display="inline-flex"
                                                        alignItems="center"
                                                        gap={0.5}
                                                    >
                                                        {isSelected && <LuCheck size={8} />}
                                                        {opt.label}
                                                        {opt.count !== undefined && (
                                                            <Text as="span" fontSize="2xs" color={isSelected ? 'teal.500' : 'gray.400'}>
                                                                ({opt.count})
                                                            </Text>
                                                        )}
                                                    </Box>
                                                );
                                            })}
                                        </Flex>
                                    )}
                                </Box>
                            )}

                            {/* Extra filter cards from parent */}
                            {extraFilterCards}
                        </SimpleGrid>
                    </Box>
                )}
            </Box>
        </Box>
    );
};

export default TransactionFilters;
