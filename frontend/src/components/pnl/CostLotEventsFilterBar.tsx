/**
 * Cost Lot Events Filter Bar
 * 
 * Simple, single-row filter bar with instant-apply toggle pills.
 * 
 * Design principles:
 * - Toggle pills for event types and unit patterns (instant apply on click)
 * - Dropdown selectors for account and asset (instant apply on selection)
 * - Date range via popover with presets (apply on confirm)
 * - Debounced search input
 * - Clean, minimal design with neutral colors
 */

import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Box, Flex, Input, Button, Text, IconButton, Spinner } from '@chakra-ui/react';
import { FiSearch, FiChevronDown, FiX, FiCalendar, FiRefreshCw } from 'react-icons/fi';
import { LotEventType } from './types';

// ============================================================================
// Types
// ============================================================================

export interface FilterState {
    dateStart: string;
    dateEnd: string;
    eventTypes: LotEventType[];
    unitPatterns: string[];
    accountIds: number[];
    assetIds: number[];
    search: string;
}

export interface CostLotEventsFilterBarProps {
    filters: FilterState;
    onFiltersChange: (filters: FilterState) => void;
    eventCounts: Record<LotEventType, number>;
    accounts?: { id: number; name: string }[];
    assets?: { id: number; symbol: string; label?: string }[];
    isLoading?: boolean;
    showDateRange?: boolean;
    showEventTypes?: boolean;
    showUnitPatterns?: boolean;
    showAccountFilter?: boolean;
    showAssetFilter?: boolean;
    showSearch?: boolean;
    defaultCollapsed?: boolean;  // Kept for API compatibility, but ignored
}

// ============================================================================
// Constants
// ============================================================================

// Event type pills configuration - all visible by default for full audit view
const EVENT_PILLS: { key: LotEventType; label: string; defaultOn: boolean }[] = [
    { key: 'created', label: 'Created', defaultOn: true },
    { key: 'consumed', label: 'Consumed', defaultOn: true },
    { key: 'created-negative', label: 'Negative', defaultOn: true },
    { key: 'settled', label: 'Settled', defaultOn: true },
    { key: 'transferred', label: 'Transferred', defaultOn: true },
    { key: 'adjusted', label: 'Adjusted', defaultOn: true },
    { key: 'merged', label: 'Merged', defaultOn: true },
];

// Unit pattern pills configuration
const UNIT_PILLS: { key: string; label: string; defaultOn: boolean }[] = [
    { key: 'swap', label: 'Swap', defaultOn: true },
    { key: 'transfer', label: 'Transfer', defaultOn: true },
    { key: 'pending_transfer', label: 'Pending', defaultOn: true },
];

// Date presets
const DATE_PRESETS = [
    { label: 'Any time', value: 'any' },
    { label: 'Today', value: 'today' },
    { label: 'Last 7 days', value: '7d' },
    { label: 'Last 30 days', value: '30d' },
    { label: 'This year', value: 'year' },
    { label: 'Custom...', value: 'custom' },
];

// Get default event types
export const getDefaultEventTypes = (): LotEventType[] => {
    return EVENT_PILLS.filter(p => p.defaultOn).map(p => p.key);
};

// Get default unit patterns
export const getDefaultUnitPatterns = (): string[] => {
    return UNIT_PILLS.filter(p => p.defaultOn).map(p => p.key);
};

// ============================================================================
// Hooks
// ============================================================================

// Debounce hook for search
function useDebounce<T>(value: T, delay: number): T {
    const [debouncedValue, setDebouncedValue] = useState<T>(value);

    useEffect(() => {
        const handler = setTimeout(() => setDebouncedValue(value), delay);
        return () => clearTimeout(handler);
    }, [value, delay]);

    return debouncedValue;
}

// Click outside hook
function useClickOutside(ref: React.RefObject<HTMLElement | null>, handler: () => void) {
    useEffect(() => {
        const listener = (event: MouseEvent) => {
            if (!ref.current || ref.current.contains(event.target as Node)) return;
            handler();
        };
        document.addEventListener('mousedown', listener);
        return () => document.removeEventListener('mousedown', listener);
    }, [ref, handler]);
}

// ============================================================================
// Sub-components
// ============================================================================

// Toggle Pill Component
const TogglePill: React.FC<{
    label: string;
    active: boolean;
    onClick: () => void;
    disabled?: boolean;
}> = ({ label, active, onClick, disabled }) => (
    <Button
        size="xs"
        variant={active ? 'solid' : 'outline'}
        bg={active ? 'gray.700' : 'white'}
        color={active ? 'white' : 'gray.600'}
        borderColor={active ? 'gray.700' : 'gray.300'}
        _hover={{
            bg: active ? 'gray.800' : 'gray.50',
            borderColor: active ? 'gray.800' : 'gray.400',
        }}
        onClick={onClick}
        disabled={disabled}
        fontWeight="normal"
        px={3}
        h="28px"
    >
        {label}
    </Button>
);

// Dropdown Component
const FilterDropdown: React.FC<{
    label: string;
    value: string;
    options: { id: number; name: string; subtitle?: string }[];
    onSelect: (id: number | null) => void;
    searchPlaceholder?: string;
    disabled?: boolean;
}> = ({ label, value, options, onSelect, searchPlaceholder = 'Search...', disabled }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');
    const ref = useRef<HTMLDivElement>(null);

    useClickOutside(ref, () => setIsOpen(false));

    const filtered = useMemo(() => {
        if (!search) return options;
        const s = search.toLowerCase();
        return options.filter(o =>
            o.name.toLowerCase().includes(s) ||
            (o.subtitle && o.subtitle.toLowerCase().includes(s))
        );
    }, [options, search]);

    return (
        <Box position="relative" ref={ref}>
            <Button
                size="xs"
                variant="outline"
                bg="white"
                borderColor="gray.300"
                color="gray.700"
                onClick={() => !disabled && setIsOpen(!isOpen)}
                minW="100px"
                justifyContent="space-between"
                fontWeight="normal"
                h="28px"
                disabled={disabled}
                _hover={{ borderColor: 'gray.400' }}
            >
                <Text truncate maxW="80px" fontSize="xs">{value}</Text>
                <FiChevronDown size={12} />
            </Button>

            {isOpen && (
                <Box
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
                    minW="180px"
                    maxH="280px"
                    overflow="hidden"
                >
                    {/* Search */}
                    <Box p={2} borderBottom="1px solid" borderColor="gray.100">
                        <Flex align="center" bg="gray.50" px={2} borderRadius="md">
                            <FiSearch color="gray" size={12} />
                            <Input
                                placeholder={searchPlaceholder}
                                size="xs"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                border="none"
                                _focus={{ boxShadow: 'none' }}
                                autoFocus
                            />
                        </Flex>
                    </Box>

                    {/* Options */}
                    <Box maxH="200px" overflowY="auto">
                        {/* All option */}
                        <Box
                            px={3}
                            py={2}
                            cursor="pointer"
                            bg={value === `All ${label}` ? 'gray.100' : 'transparent'}
                            _hover={{ bg: 'gray.50' }}
                            onClick={() => {
                                onSelect(null);
                                setIsOpen(false);
                                setSearch('');
                            }}
                        >
                            <Text fontSize="xs" color="gray.600">All {label}</Text>
                        </Box>

                        {filtered.map(opt => (
                            <Box
                                key={opt.id}
                                px={3}
                                py={2}
                                cursor="pointer"
                                _hover={{ bg: 'gray.50' }}
                                onClick={() => {
                                    onSelect(opt.id);
                                    setIsOpen(false);
                                    setSearch('');
                                }}
                            >
                                <Text fontSize="xs">{opt.name}</Text>
                                {opt.subtitle && (
                                    <Text fontSize="2xs" color="gray.500">{opt.subtitle}</Text>
                                )}
                            </Box>
                        ))}

                        {filtered.length === 0 && (
                            <Box px={3} py={2}>
                                <Text fontSize="xs" color="gray.400">No results</Text>
                            </Box>
                        )}
                    </Box>
                </Box>
            )}
        </Box>
    );
};

// Date Range Popover Component
const DateRangeFilter: React.FC<{
    dateStart: string;
    dateEnd: string;
    onApply: (start: string, end: string) => void;
    disabled?: boolean;
}> = ({ dateStart, dateEnd, onApply, disabled }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [tempStart, setTempStart] = useState(dateStart);
    const [tempEnd, setTempEnd] = useState(dateEnd);
    const ref = useRef<HTMLDivElement>(null);

    useClickOutside(ref, () => setIsOpen(false));

    // Sync temp values when props change
    useEffect(() => {
        setTempStart(dateStart);
        setTempEnd(dateEnd);
    }, [dateStart, dateEnd]);

    const getDisplayLabel = () => {
        if (!dateStart && !dateEnd) return 'Any time';
        if (dateStart && dateEnd) {
            const start = new Date(dateStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            const end = new Date(dateEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            return `${start} - ${end}`;
        }
        if (dateStart) return `From ${new Date(dateStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
        return `Until ${new Date(dateEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    };

    const applyPreset = (preset: string) => {
        const now = new Date();
        let start = '';
        let end = '';

        switch (preset) {
            case 'any':
                break;
            case 'today':
                start = new Date(now.setHours(0, 0, 0, 0)).toISOString().slice(0, 16);
                end = new Date().toISOString().slice(0, 16);
                break;
            case '7d':
                start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
                end = new Date().toISOString().slice(0, 16);
                break;
            case '30d':
                start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
                end = new Date().toISOString().slice(0, 16);
                break;
            case 'year':
                start = new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 16);
                end = new Date().toISOString().slice(0, 16);
                break;
            case 'custom':
                return; // Don't close, let user pick custom dates
        }

        onApply(start, end);
        setIsOpen(false);
    };

    const handleApplyCustom = () => {
        onApply(tempStart, tempEnd);
        setIsOpen(false);
    };

    const hasDateFilter = dateStart || dateEnd;

    return (
        <Box position="relative" ref={ref}>
            <Flex align="center" gap={1}>
                <Button
                    size="xs"
                    variant="outline"
                    bg="white"
                    borderColor={hasDateFilter ? 'blue.300' : 'gray.300'}
                    color={hasDateFilter ? 'blue.600' : 'gray.700'}
                    onClick={() => !disabled && setIsOpen(!isOpen)}
                    fontWeight="normal"
                    h="28px"
                    px={2}
                    disabled={disabled}
                    _hover={{ borderColor: hasDateFilter ? 'blue.400' : 'gray.400' }}
                >
                    <FiCalendar size={12} style={{ marginRight: 4 }} />
                    <Text fontSize="xs">{getDisplayLabel()}</Text>
                    <FiChevronDown size={12} style={{ marginLeft: 4 }} />
                </Button>

                {hasDateFilter && (
                    <IconButton
                        size="xs"
                        variant="ghost"
                        aria-label="Clear date"
                        onClick={() => onApply('', '')}
                        color="gray.400"
                        _hover={{ color: 'gray.600' }}
                    >
                        <FiX size={12} />
                    </IconButton>
                )}
            </Flex>

            {isOpen && (
                <Box
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
                    p={3}
                    minW="280px"
                >
                    {/* Quick presets */}
                    <Text fontSize="xs" color="gray.500" mb={2}>Quick select</Text>
                    <Flex gap={1} wrap="wrap" mb={3}>
                        {DATE_PRESETS.filter(p => p.value !== 'custom').map(preset => (
                            <Button
                                key={preset.value}
                                size="xs"
                                variant="ghost"
                                onClick={() => applyPreset(preset.value)}
                                fontWeight="normal"
                                h="26px"
                                _hover={{ bg: 'gray.100' }}
                            >
                                {preset.label}
                            </Button>
                        ))}
                    </Flex>

                    {/* Custom range */}
                    <Box borderTop="1px solid" borderColor="gray.100" pt={3}>
                        <Text fontSize="xs" color="gray.500" mb={2}>Custom range</Text>
                        <Flex gap={2} align="center" mb={2}>
                            <Text fontSize="xs" color="gray.600" minW="35px">From</Text>
                            <Input
                                type="datetime-local"
                                size="xs"
                                value={tempStart}
                                onChange={(e) => setTempStart(e.target.value)}
                                max={tempEnd || undefined}
                                flex={1}
                            />
                        </Flex>
                        <Flex gap={2} align="center" mb={3}>
                            <Text fontSize="xs" color="gray.600" minW="35px">To</Text>
                            <Input
                                type="datetime-local"
                                size="xs"
                                value={tempEnd}
                                onChange={(e) => setTempEnd(e.target.value)}
                                min={tempStart || undefined}
                                flex={1}
                            />
                        </Flex>
                        <Flex justify="flex-end" gap={2}>
                            <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => {
                                    setTempStart('');
                                    setTempEnd('');
                                }}
                            >
                                Clear
                            </Button>
                            <Button
                                size="xs"
                                colorPalette="blue"
                                onClick={handleApplyCustom}
                            >
                                Apply
                            </Button>
                        </Flex>
                    </Box>
                </Box>
            )}
        </Box>
    );
};

// ============================================================================
// Main Component
// ============================================================================

export const CostLotEventsFilterBar: React.FC<CostLotEventsFilterBarProps> = ({
    filters,
    onFiltersChange,
    eventCounts,
    accounts = [],
    assets = [],
    isLoading = false,
    showDateRange = true,
    showEventTypes = true,
    showUnitPatterns = true,
    showAccountFilter = true,
    showAssetFilter = true,
    showSearch = true,
}) => {
    // Local search state (debounced)
    const [localSearch, setLocalSearch] = useState(filters.search);
    const debouncedSearch = useDebounce(localSearch, 300);

    // Sync debounced search to parent
    useEffect(() => {
        if (debouncedSearch !== filters.search) {
            onFiltersChange({ ...filters, search: debouncedSearch });
        }
    }, [debouncedSearch]);

    // Sync local search when filters change externally
    useEffect(() => {
        setLocalSearch(filters.search);
    }, [filters.search]);

    // Toggle event type (instant apply)
    const toggleEventType = useCallback((type: LotEventType) => {
        const newTypes = filters.eventTypes.includes(type)
            ? filters.eventTypes.filter(t => t !== type)
            : [...filters.eventTypes, type];
        onFiltersChange({ ...filters, eventTypes: newTypes });
    }, [filters, onFiltersChange]);

    // Toggle unit pattern (instant apply)
    const toggleUnitPattern = useCallback((pattern: string) => {
        const newPatterns = filters.unitPatterns.includes(pattern)
            ? filters.unitPatterns.filter(p => p !== pattern)
            : [...filters.unitPatterns, pattern];
        onFiltersChange({ ...filters, unitPatterns: newPatterns });
    }, [filters, onFiltersChange]);

    // Select account (instant apply)
    const selectAccount = useCallback((accountId: number | null) => {
        onFiltersChange({
            ...filters,
            accountIds: accountId ? [accountId] : [],
        });
    }, [filters, onFiltersChange]);

    // Select asset (instant apply)
    const selectAsset = useCallback((assetId: number | null) => {
        onFiltersChange({
            ...filters,
            assetIds: assetId ? [assetId] : [],
        });
    }, [filters, onFiltersChange]);

    // Apply date range
    const applyDateRange = useCallback((start: string, end: string) => {
        onFiltersChange({
            ...filters,
            dateStart: start,
            dateEnd: end,
        });
    }, [filters, onFiltersChange]);

    // Reset all filters
    const resetFilters = useCallback(() => {
        onFiltersChange({
            dateStart: '',
            dateEnd: '',
            eventTypes: getDefaultEventTypes(),
            unitPatterns: getDefaultUnitPatterns(),
            accountIds: [],
            assetIds: [],
            search: '',
        });
        setLocalSearch('');
    }, [onFiltersChange]);

    // Check if filters are modified from defaults
    const isModified = useMemo(() => {
        const defaultTypes = getDefaultEventTypes();
        const defaultPatterns = getDefaultUnitPatterns();
        return (
            filters.dateStart !== '' ||
            filters.dateEnd !== '' ||
            filters.search !== '' ||
            filters.accountIds.length > 0 ||
            filters.assetIds.length > 0 ||
            JSON.stringify([...filters.eventTypes].sort()) !== JSON.stringify([...defaultTypes].sort()) ||
            JSON.stringify([...filters.unitPatterns].sort()) !== JSON.stringify([...defaultPatterns].sort())
        );
    }, [filters]);

    // Get display values for dropdowns
    const accountDisplay = useMemo(() => {
        if (filters.accountIds.length === 0) return 'All Accounts';
        const acc = accounts.find(a => a.id === filters.accountIds[0]);
        return acc?.name || 'Unknown';
    }, [filters.accountIds, accounts]);

    const assetDisplay = useMemo(() => {
        if (filters.assetIds.length === 0) return 'All Assets';
        const asset = assets.find(a => a.id === filters.assetIds[0]);
        return asset?.symbol || 'Unknown';
    }, [filters.assetIds, assets]);

    return (
        <Box
            bg="white"
            borderBottom="1px solid"
            borderColor="gray.200"
            py={2}
            px={3}
            mb={2}
        >
            {/* Row 1: Event Types & Unit Patterns */}
            <Flex gap={4} align="center" wrap="wrap" mb={2}>
                {/* Event type pills */}
                {showEventTypes && (
                    <Flex align="center" gap={2}>
                        <Text fontSize="xs" color="gray.500" fontWeight="medium">Event:</Text>
                        <Flex gap={1}>
                            {EVENT_PILLS.map(pill => (
                                <TogglePill
                                    key={pill.key}
                                    label={pill.label}
                                    active={filters.eventTypes.includes(pill.key)}
                                    onClick={() => toggleEventType(pill.key)}
                                    disabled={isLoading}
                                />
                            ))}
                        </Flex>
                    </Flex>
                )}

                {/* Unit pattern pills */}
                {showUnitPatterns && (
                    <Flex align="center" gap={2}>
                        <Text fontSize="xs" color="gray.500" fontWeight="medium">Unit:</Text>
                        <Flex gap={1}>
                            {UNIT_PILLS.map(pill => (
                                <TogglePill
                                    key={pill.key}
                                    label={pill.label}
                                    active={filters.unitPatterns.includes(pill.key)}
                                    onClick={() => toggleUnitPattern(pill.key)}
                                    disabled={isLoading}
                                />
                            ))}
                        </Flex>
                    </Flex>
                )}
            </Flex>

            {/* Row 2: Dropdowns, Date, Search, Reset */}
            <Flex gap={3} align="center" wrap="wrap">
                {/* Account dropdown */}
                {showAccountFilter && accounts.length > 0 && (
                    <FilterDropdown
                        label="Accounts"
                        value={accountDisplay}
                        options={accounts.map(a => ({ id: a.id, name: a.name }))}
                        onSelect={selectAccount}
                        searchPlaceholder="Search accounts..."
                        disabled={isLoading}
                    />
                )}

                {/* Asset dropdown */}
                {showAssetFilter && assets.length > 0 && (
                    <FilterDropdown
                        label="Assets"
                        value={assetDisplay}
                        options={assets.map(a => ({
                            id: a.id,
                            name: a.symbol,
                            subtitle: a.label,
                        }))}
                        onSelect={selectAsset}
                        searchPlaceholder="Search assets..."
                        disabled={isLoading}
                    />
                )}

                {/* Date range */}
                {showDateRange && (
                    <DateRangeFilter
                        dateStart={filters.dateStart}
                        dateEnd={filters.dateEnd}
                        onApply={applyDateRange}
                        disabled={isLoading}
                    />
                )}

                {/* Search */}
                {showSearch && (
                    <Flex
                        align="center"
                        bg="white"
                        border="1px solid"
                        borderColor="gray.300"
                        borderRadius="md"
                        px={2}
                        h="28px"
                        flex="1"
                        maxW="200px"
                        _focusWithin={{ borderColor: 'blue.400' }}
                    >
                        <FiSearch color="gray" size={12} />
                        <Input
                            placeholder="Search..."
                            size="xs"
                            value={localSearch}
                            onChange={(e) => setLocalSearch(e.target.value)}
                            border="none"
                            _focus={{ boxShadow: 'none' }}
                            h="24px"
                        />
                        {localSearch && (
                            <IconButton
                                size="xs"
                                variant="ghost"
                                aria-label="Clear search"
                                onClick={() => setLocalSearch('')}
                                p={0}
                                minW="16px"
                                h="16px"
                            >
                                <FiX size={10} />
                            </IconButton>
                        )}
                    </Flex>
                )}

                {/* Loading indicator */}
                {isLoading && <Spinner size="xs" color="gray.400" />}

                {/* Reset button */}
                {isModified && (
                    <Button
                        size="xs"
                        variant="ghost"
                        onClick={resetFilters}
                        color="gray.500"
                        fontWeight="normal"
                        h="28px"
                        _hover={{ color: 'gray.700', bg: 'gray.100' }}
                    >
                        <FiRefreshCw size={12} style={{ marginRight: 4 }} />
                        Reset
                    </Button>
                )}
            </Flex>
        </Box>
    );
};

export default CostLotEventsFilterBar;
