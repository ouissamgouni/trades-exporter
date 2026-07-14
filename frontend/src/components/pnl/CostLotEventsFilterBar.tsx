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
import { Input, Button, Spinner, Badge, type BadgeColorScheme } from '../ui/primitives';
import { FiSearch, FiChevronDown, FiChevronUp, FiX, FiCalendar, FiRefreshCw } from 'react-icons/fi';
import { LuChevronDown, LuFilter, LuRotateCcw, LuX } from 'react-icons/lu';
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

export interface FilterOptionWithCount {
    value: string;
    label?: string;
    count: number;
}

export interface CostLotEventsFilterBarProps {
    filters: FilterState;
    onFiltersChange: (filters: FilterState) => void;
    eventCounts: Record<LotEventType, number>;
    accounts?: { id: number; name: string }[];
    assets?: { id: number; symbol: string; label?: string }[];
    eventTypeOptions?: FilterOptionWithCount[];
    unitPatternOptions?: FilterOptionWithCount[];
    isLoading?: boolean;
    showDateRange?: boolean;
    showEventTypes?: boolean;
    showUnitPatterns?: boolean;
    showAccountFilter?: boolean;
    showAssetFilter?: boolean;
    showSearch?: boolean;
    defaultCollapsed?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

// Label overrides for known patterns (optional cosmetic improvement)
const PATTERN_LABELS: Record<string, string> = {
    internal_transfer: 'Transfer',
    unmatched_internal_transfer: 'Unmatched',
    'created-negative': 'Negative',
};

// Date presets
const DATE_PRESETS = [
    { label: 'Any time', value: 'any' },
    { label: 'Today', value: 'today' },
    { label: 'Last 7 days', value: '7d' },
    { label: 'Last 30 days', value: '30d' },
    { label: 'This year', value: 'year' },
    { label: 'Custom...', value: 'custom' },
];

// Get default event types — empty means "no filter" = show all
export const getDefaultEventTypes = (): LotEventType[] => [];

// Get default unit patterns — empty means "no filter" = show all
export const getDefaultUnitPatterns = (): string[] => [];

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
        variant={active ? 'solid' : 'outline'}
        colorScheme="gray"
        onClick={onClick}
        disabled={disabled}
        className={`h-[22px] px-2 text-[10px] font-normal ${active
            ? 'border-gray-700 bg-gray-700 text-white hover:bg-gray-800'
            : 'border-gray-300 bg-white text-gray-600 hover:border-gray-400 hover:bg-gray-50'
            }`}
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
        <div className="relative" ref={ref}>
            <Button
                variant="outline"
                colorScheme="gray"
                onClick={() => !disabled && setIsOpen(!isOpen)}
                disabled={disabled}
                className="h-[22px] min-w-[80px] justify-between bg-white px-2 text-[10px] font-normal text-gray-700 hover:border-gray-400"
            >
                <span className="max-w-[70px] truncate text-[10px]">{value}</span>
                <FiChevronDown size={10} />
            </Button>

            {isOpen && (
                <div className="absolute left-0 top-full z-[1000] mt-1 min-w-[180px] max-h-[280px] overflow-hidden border border-gray-200 bg-white shadow-lg">
                    {/* Search */}
                    <div className="border-b border-gray-100 p-2">
                        <div className="flex items-center gap-1 bg-gray-50 px-2">
                            <FiSearch color="gray" size={12} />
                            <Input
                                placeholder={searchPlaceholder}
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                className="h-6 border-none bg-transparent px-1 text-xs focus:ring-0"
                                autoFocus
                            />
                        </div>
                    </div>

                    {/* Options */}
                    <div className="max-h-[200px] overflow-y-auto">
                        {/* All option */}
                        <div
                            className={`cursor-pointer px-3 py-2 hover:bg-gray-50 ${value === `All ${label}` ? 'bg-gray-100' : 'bg-transparent'}`}
                            onClick={() => {
                                onSelect(null);
                                setIsOpen(false);
                                setSearch('');
                            }}
                        >
                            <span className="text-xs text-gray-600">All {label}</span>
                        </div>

                        {filtered.map(opt => (
                            <div
                                key={opt.id}
                                className="cursor-pointer px-3 py-2 hover:bg-gray-50"
                                onClick={() => {
                                    onSelect(opt.id);
                                    setIsOpen(false);
                                    setSearch('');
                                }}
                            >
                                <span className="text-xs">{opt.name}</span>
                                {opt.subtitle && (
                                    <span className="block text-[10px] text-gray-500">{opt.subtitle}</span>
                                )}
                            </div>
                        ))}

                        {filtered.length === 0 && (
                            <div className="px-3 py-2">
                                <span className="text-xs text-gray-400">No results</span>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
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
        <div className="relative" ref={ref}>
            <div className="flex items-center gap-1">
                <Button
                    variant="outline"
                    colorScheme="gray"
                    onClick={() => !disabled && setIsOpen(!isOpen)}
                    disabled={disabled}
                    className={`h-7 bg-white px-2 text-xs font-normal ${hasDateFilter ? 'border-blue-300 text-blue-600 hover:border-blue-400' : 'border-gray-300 text-gray-700 hover:border-gray-400'}`}
                >
                    <FiCalendar size={12} style={{ marginRight: 4 }} />
                    <span className="text-xs">{getDisplayLabel()}</span>
                    <FiChevronDown size={12} style={{ marginLeft: 4 }} />
                </Button>

                {hasDateFilter && (
                    <Button
                        variant="ghost"
                        colorScheme="gray"
                        aria-label="Clear date"
                        onClick={() => onApply('', '')}
                        className="h-7 w-7 px-0 text-gray-400 hover:text-gray-600"
                    >
                        <FiX size={12} />
                    </Button>
                )}
            </div>

            {isOpen && (
                <div className="absolute left-0 top-full z-[1000] mt-1 min-w-[280px] border border-gray-200 bg-white p-3 shadow-lg">
                    {/* Quick presets */}
                    <div className="mb-2 text-xs text-gray-500">Quick select</div>
                    <div className="mb-3 flex flex-wrap gap-1">
                        {DATE_PRESETS.filter(p => p.value !== 'custom').map(preset => (
                            <Button
                                key={preset.value}
                                variant="ghost"
                                colorScheme="gray"
                                onClick={() => applyPreset(preset.value)}
                                className="h-[26px] px-2 text-xs font-normal hover:bg-gray-100"
                            >
                                {preset.label}
                            </Button>
                        ))}
                    </div>

                    {/* Custom range */}
                    <div className="border-t border-gray-100 pt-3">
                        <div className="mb-2 text-xs text-gray-500">Custom range</div>
                        <div className="mb-2 flex items-center gap-2">
                            <span className="min-w-[35px] text-xs text-gray-600">From</span>
                            <Input
                                type="datetime-local"
                                value={tempStart}
                                onChange={(e) => setTempStart(e.target.value)}
                                max={tempEnd || undefined}
                                className="h-7 flex-1 text-xs"
                            />
                        </div>
                        <div className="mb-3 flex items-center gap-2">
                            <span className="min-w-[35px] text-xs text-gray-600">To</span>
                            <Input
                                type="datetime-local"
                                value={tempEnd}
                                onChange={(e) => setTempEnd(e.target.value)}
                                min={tempStart || undefined}
                                className="h-7 flex-1 text-xs"
                            />
                        </div>
                        <div className="flex justify-end gap-2">
                            <Button
                                variant="ghost"
                                colorScheme="gray"
                                onClick={() => {
                                    setTempStart('');
                                    setTempEnd('');
                                }}
                                className="h-7 px-2 text-xs"
                            >
                                Clear
                            </Button>
                            <Button
                                colorScheme="blue"
                                onClick={handleApplyCustom}
                                className="h-7 px-2 text-xs"
                            >
                                Apply
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
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
    eventTypeOptions = [],
    unitPatternOptions = [],
    isLoading = false,
    showDateRange = true,
    showEventTypes = true,
    showUnitPatterns = true,
    showAccountFilter = true,
    showAssetFilter = true,
    showSearch = true,
    defaultCollapsed = false,
}) => {
    // Collapsible state
    const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

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

    // Check if filters are modified from defaults (empty = show all)
    const isModified = useMemo(() => {
        return (
            filters.dateStart !== '' ||
            filters.dateEnd !== '' ||
            filters.search !== '' ||
            filters.accountIds.length > 0 ||
            filters.assetIds.length > 0 ||
            filters.eventTypes.length > 0 ||
            filters.unitPatterns.length > 0
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

    // Build active filter chips for inline display
    const activeChips = useMemo(() => {
        const chips: { id: string; label: string; color: BadgeColorScheme; onClear: () => void }[] = [];
        if (filters.eventTypes.length > 0) {
            chips.push({ id: 'events', label: `Events: ${filters.eventTypes.length}`, color: 'blue', onClear: () => onFiltersChange({ ...filters, eventTypes: [] }) });
        }
        if (filters.unitPatterns.length > 0) {
            chips.push({ id: 'units', label: `Units: ${filters.unitPatterns.length}`, color: 'purple', onClear: () => onFiltersChange({ ...filters, unitPatterns: [] }) });
        }
        if (filters.accountIds.length > 0) {
            const acc = accounts.find(a => a.id === filters.accountIds[0]);
            chips.push({ id: 'account', label: `Acct: ${acc?.name || 'Unknown'}`, color: 'green', onClear: () => onFiltersChange({ ...filters, accountIds: [] }) });
        }
        if (filters.assetIds.length > 0) {
            const asset = assets.find(a => a.id === filters.assetIds[0]);
            chips.push({ id: 'asset', label: `Asset: ${asset?.symbol || 'Unknown'}`, color: 'orange', onClear: () => onFiltersChange({ ...filters, assetIds: [] }) });
        }
        if (filters.dateStart || filters.dateEnd) {
            chips.push({ id: 'date', label: 'Date range', color: 'yellow', onClear: () => onFiltersChange({ ...filters, dateStart: '', dateEnd: '' }) });
        }
        if (filters.search) {
            chips.push({ id: 'search', label: `"${filters.search}"`, color: 'gray', onClear: () => { onFiltersChange({ ...filters, search: '' }); setLocalSearch(''); } });
        }
        return chips;
    }, [filters, accounts, assets, onFiltersChange]);

    return (
        <div className="mb-3">
            <div className={`border bg-gray-50 ${isModified ? 'border-blue-300' : 'border-gray-200'}`}>
                {/* Clickable header */}
                <div
                    className="flex cursor-pointer items-center justify-between p-3 transition-colors hover:bg-gray-100"
                    onClick={() => setIsCollapsed(c => !c)}
                >
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                        <div className={`flex-shrink-0 transition-transform duration-200 ${!isCollapsed ? 'rotate-0' : '-rotate-90'}`}>
                            <LuChevronDown size={14} />
                        </div>
                        <LuFilter size={12} />
                        <span className="flex-shrink-0 text-xs font-semibold">Filters</span>
                        {activeChips.length > 0 && (
                            <Badge colorScheme="blue">{activeChips.length} active</Badge>
                        )}
                        {isLoading && <Spinner size="xs" className="text-gray-400" />}
                        {activeChips.length > 0 && (
                            <div className="ml-1 flex flex-wrap items-center gap-1" onClick={e => e.stopPropagation()}>
                                {activeChips.map(chip => (
                                    <Badge
                                        key={chip.id}
                                        colorScheme={chip.color}
                                        className="inline-flex cursor-pointer items-center gap-1 transition-transform hover:scale-95 hover:opacity-80"
                                        onClick={() => chip.onClear()}
                                    >
                                        <span className="text-xs">{chip.label}</span>
                                        <LuX size={12} />
                                    </Badge>
                                ))}
                            </div>
                        )}
                    </div>
                    <div className="flex flex-shrink-0 gap-1.5" onClick={e => e.stopPropagation()}>
                        {isModified && (
                            <Button variant="ghost" colorScheme="gray" onClick={resetFilters} className="h-7 px-2 text-xs">
                                <LuRotateCcw size={10} />
                                <span className="ml-0.5 text-[10px]">Clear All</span>
                            </Button>
                        )}
                    </div>
                </div>

                {/* Collapsible content */}
                {!isCollapsed && (
                    <div className="p-3 pt-1">
                        {/* Row 1: Event Types & Unit Patterns */}
                        <div className="mb-2 flex flex-wrap items-center gap-4">
                            {/* Event type pills - dynamic from backend */}
                            {showEventTypes && eventTypeOptions.length > 0 && (
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-medium text-gray-500">Event:</span>
                                    <div className="flex gap-1">
                                        {eventTypeOptions.map(opt => (
                                            <TogglePill
                                                key={opt.value}
                                                label={PATTERN_LABELS[opt.value] || opt.label || opt.value.charAt(0).toUpperCase() + opt.value.slice(1)}
                                                active={filters.eventTypes.includes(opt.value as LotEventType)}
                                                onClick={() => toggleEventType(opt.value as LotEventType)}
                                                disabled={isLoading}
                                            />
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Unit pattern pills - dynamic from backend */}
                            {showUnitPatterns && unitPatternOptions.length > 0 && (
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-medium text-gray-500">Unit:</span>
                                    <div className="flex gap-1">
                                        {unitPatternOptions.map(opt => (
                                            <TogglePill
                                                key={opt.value}
                                                label={PATTERN_LABELS[opt.value] || opt.label || opt.value.charAt(0).toUpperCase() + opt.value.slice(1)}
                                                active={filters.unitPatterns.includes(opt.value)}
                                                onClick={() => toggleUnitPattern(opt.value)}
                                                disabled={isLoading}
                                            />
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Row 2: Dropdowns, Date, Search, Reset */}
                        <div className="flex flex-wrap items-center gap-3">
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
                                <div className="flex h-[22px] max-w-[160px] flex-1 items-center gap-1 border border-gray-300 bg-white px-1.5 focus-within:border-blue-400">
                                    <FiSearch color="gray" size={10} />
                                    <Input
                                        placeholder="Search..."
                                        value={localSearch}
                                        onChange={(e) => setLocalSearch(e.target.value)}
                                        className="h-[18px] border-none bg-transparent px-1 text-[10px] focus:ring-0"
                                    />
                                    {localSearch && (
                                        <Button
                                            variant="ghost"
                                            colorScheme="gray"
                                            aria-label="Clear search"
                                            onClick={() => setLocalSearch('')}
                                            className="h-4 min-w-[16px] p-0"
                                        >
                                            <FiX size={10} />
                                        </Button>
                                    )}
                                </div>
                            )}

                            {/* Loading indicator */}
                            {isLoading && <Spinner size="xs" className="text-gray-400" />}

                            {/* Reset button */}
                            {isModified && (
                                <Button
                                    variant="ghost"
                                    colorScheme="gray"
                                    onClick={resetFilters}
                                    className="h-[22px] px-2 text-[10px] font-normal hover:bg-gray-100 hover:text-gray-700"
                                >
                                    <FiRefreshCw size={10} style={{ marginRight: 2 }} />
                                    Reset
                                </Button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default CostLotEventsFilterBar;
