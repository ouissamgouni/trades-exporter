import { Badge, Button, Tabs, TabsList, TabsTrigger, TabsContent, type BadgeColorScheme } from './ui/primitives';
import React, { useEffect, useRef, useState } from 'react';
import { LuCalendar, LuCheck, LuChevronDown, LuFilter, LuRotateCcw, LuSearch, LuX } from 'react-icons/lu';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { API_URL } from '../types';
import type { AppliedFilters as BackendAppliedFilters, FilterMetadata, ValidationWarning } from '../types';
import { toDateInputString, getDateRangePreset, getNamedDateRange, NAMED_DATE_RANGES } from '../utils/dateUtils';
import { buildTransactionFilterParams } from '../utils/transactionFilterParams';
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
    attributed_assets: FilterOption[];
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
    attributedAssetIds: string[];
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
    connectorRunOutcome?: 'synced' | 'updated' | 'skipped' | 'all';
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
    attributedAssetIds: [],
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
    /** Show date range, accounts and status as an always-visible bar; the panel holds the rest (default true) */
    quickBar?: boolean;
    /** Callback receiving loaded filterOptions for parent to access (e.g. non_owned_count) */
    onFilterOptionsLoaded?: (options: FilterOptions) => void;
    className?: string;
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
    { key: 'attributedAssetIds', label: 'Attributed Asset', icon: '🎯', type: 'multi', optionsKey: 'attributed_assets', color: 'orange', isDropdown: true },
    { key: 'networks', label: 'Network', icon: '🌐', type: 'multi', optionsKey: 'networks', color: 'emerald', isDropdown: true },
    { key: 'tagKeys', label: 'Tags', icon: '🏷️', type: 'multi', optionsKey: 'tags', color: 'purple', isDropdown: true },
    { key: 'categoryIds', label: 'Category', icon: '📁', type: 'multi', optionsKey: 'categories_by_dimension', color: 'pink', isDropdown: true },
    { key: 'connectorRunIds', label: 'Connector Run', icon: '🔄', type: 'multi', optionsKey: 'connector_runs', color: 'indigo', isDropdown: true },
    { key: 'priceQuoteAssetIds', label: 'Price Quote Asset', icon: '💱', type: 'multi', optionsKey: 'price_quote_assets', color: 'purple', isDropdown: true },
    { key: 'feeQuoteAssetIds', label: 'Fee Quote Asset', icon: '💱', type: 'multi', optionsKey: 'fee_quote_assets', color: 'orange', isDropdown: true },
];

// Dynamic per-filter colorScheme lookup - literal Tailwind classes (Tailwind JIT cannot
// resolve `${color}-100` style interpolation, so every color used by FILTER_DEFS/cards
// must have a full literal entry here).
interface FilterColorClasses {
    border200: string;
    bg100: string;
    text700: string;
    border300: string;
    hoverBorder300: string;
    hoverBg200: string;
    hoverBorder400: string;
    text500: string;
    bg50: string;
    hoverBg100: string;
    border500: string;
    bg500: string;
    badge: BadgeColorScheme;
}

const FILTER_COLOR_CLASSES: Record<string, FilterColorClasses> = {
    cyan: { border200: 'border-cyan-200', bg100: 'bg-cyan-100', text700: 'text-cyan-700', border300: 'border-cyan-300', hoverBorder300: 'hover:border-cyan-300', hoverBg200: 'hover:bg-cyan-200', hoverBorder400: 'hover:border-cyan-400', text500: 'text-cyan-500', bg50: 'bg-cyan-50', hoverBg100: 'hover:bg-cyan-100', border500: 'border-cyan-500', bg500: 'bg-cyan-500', badge: 'blue' },
    teal: { border200: 'border-teal-200', bg100: 'bg-teal-100', text700: 'text-teal-700', border300: 'border-teal-300', hoverBorder300: 'hover:border-teal-300', hoverBg200: 'hover:bg-teal-200', hoverBorder400: 'hover:border-teal-400', text500: 'text-teal-500', bg50: 'bg-teal-50', hoverBg100: 'hover:bg-teal-100', border500: 'border-teal-500', bg500: 'bg-teal-500', badge: 'green' },
    blue: { border200: 'border-blue-200', bg100: 'bg-blue-100', text700: 'text-blue-700', border300: 'border-blue-300', hoverBorder300: 'hover:border-blue-300', hoverBg200: 'hover:bg-blue-200', hoverBorder400: 'hover:border-blue-400', text500: 'text-blue-500', bg50: 'bg-blue-50', hoverBg100: 'hover:bg-blue-100', border500: 'border-blue-500', bg500: 'bg-blue-500', badge: 'blue' },
    yellow: { border200: 'border-yellow-200', bg100: 'bg-yellow-100', text700: 'text-yellow-700', border300: 'border-yellow-300', hoverBorder300: 'hover:border-yellow-300', hoverBg200: 'hover:bg-yellow-200', hoverBorder400: 'hover:border-yellow-400', text500: 'text-yellow-500', bg50: 'bg-yellow-50', hoverBg100: 'hover:bg-yellow-100', border500: 'border-yellow-500', bg500: 'bg-yellow-500', badge: 'yellow' },
    red: { border200: 'border-red-200', bg100: 'bg-red-100', text700: 'text-red-700', border300: 'border-red-300', hoverBorder300: 'hover:border-red-300', hoverBg200: 'hover:bg-red-200', hoverBorder400: 'hover:border-red-400', text500: 'text-red-500', bg50: 'bg-red-50', hoverBg100: 'hover:bg-red-100', border500: 'border-red-500', bg500: 'bg-red-500', badge: 'red' },
    green: { border200: 'border-green-200', bg100: 'bg-green-100', text700: 'text-green-700', border300: 'border-green-300', hoverBorder300: 'hover:border-green-300', hoverBg200: 'hover:bg-green-200', hoverBorder400: 'hover:border-green-400', text500: 'text-green-500', bg50: 'bg-green-50', hoverBg100: 'hover:bg-green-100', border500: 'border-green-500', bg500: 'bg-green-500', badge: 'green' },
    orange: { border200: 'border-orange-200', bg100: 'bg-orange-100', text700: 'text-orange-700', border300: 'border-orange-300', hoverBorder300: 'hover:border-orange-300', hoverBg200: 'hover:bg-orange-200', hoverBorder400: 'hover:border-orange-400', text500: 'text-orange-500', bg50: 'bg-orange-50', hoverBg100: 'hover:bg-orange-100', border500: 'border-orange-500', bg500: 'bg-orange-500', badge: 'orange' },
    emerald: { border200: 'border-emerald-200', bg100: 'bg-emerald-100', text700: 'text-emerald-700', border300: 'border-emerald-300', hoverBorder300: 'hover:border-emerald-300', hoverBg200: 'hover:bg-emerald-200', hoverBorder400: 'hover:border-emerald-400', text500: 'text-emerald-500', bg50: 'bg-emerald-50', hoverBg100: 'hover:bg-emerald-100', border500: 'border-emerald-500', bg500: 'bg-emerald-500', badge: 'green' },
    purple: { border200: 'border-purple-200', bg100: 'bg-purple-100', text700: 'text-purple-700', border300: 'border-purple-300', hoverBorder300: 'hover:border-purple-300', hoverBg200: 'hover:bg-purple-200', hoverBorder400: 'hover:border-purple-400', text500: 'text-purple-500', bg50: 'bg-purple-50', hoverBg100: 'hover:bg-purple-100', border500: 'border-purple-500', bg500: 'bg-purple-500', badge: 'purple' },
    pink: { border200: 'border-pink-200', bg100: 'bg-pink-100', text700: 'text-pink-700', border300: 'border-pink-300', hoverBorder300: 'hover:border-pink-300', hoverBg200: 'hover:bg-pink-200', hoverBorder400: 'hover:border-pink-400', text500: 'text-pink-500', bg50: 'bg-pink-50', hoverBg100: 'hover:bg-pink-100', border500: 'border-pink-500', bg500: 'bg-pink-500', badge: 'red' },
    indigo: { border200: 'border-indigo-200', bg100: 'bg-indigo-100', text700: 'text-indigo-700', border300: 'border-indigo-300', hoverBorder300: 'hover:border-indigo-300', hoverBg200: 'hover:bg-indigo-200', hoverBorder400: 'hover:border-indigo-400', text500: 'text-indigo-500', bg50: 'bg-indigo-50', hoverBg100: 'hover:bg-indigo-100', border500: 'border-indigo-500', bg500: 'bg-indigo-500', badge: 'purple' },
    gray: { border200: 'border-slate-200', bg100: 'bg-slate-100', text700: 'text-slate-700', border300: 'border-slate-300', hoverBorder300: 'hover:border-slate-300', hoverBg200: 'hover:bg-slate-200', hoverBorder400: 'hover:border-slate-400', text500: 'text-slate-500', bg50: 'bg-slate-50', hoverBg100: 'hover:bg-slate-100', border500: 'border-slate-500', bg500: 'bg-slate-500', badge: 'gray' },
};

const getFilterColorClasses = (color: string): FilterColorClasses => FILTER_COLOR_CLASSES[color] ?? FILTER_COLOR_CLASSES.gray;

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
    const c = getFilterColorClasses(color);

    return (
        <div className={`min-h-[70px] border bg-white p-2 ${activeCount > 0 ? c.border200 : 'border-slate-200'}`}>
            {/* Card Header */}
            <div className="mb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-1">
                    <span className="text-xs">{icon}</span>
                    <span className="text-[10px] font-semibold uppercase text-slate-600">
                        {label}
                    </span>
                </div>
                {activeCount > 0 && (
                    <Badge colorScheme={c.badge} className="rounded-full">
                        {activeCount}
                    </Badge>
                )}
            </div>

            {/* Search box */}
            {searchable && (
                <div className="mb-1.5 flex items-center gap-1 bg-slate-50 px-1 py-1">
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
                </div>
            )}

            {/* Options as toggleable chips - with scroll if > 4 items */}
            <div className={needsScroll ? 'max-h-[110px] overflow-y-auto' : 'overflow-visible'}>
                <div className="flex flex-wrap gap-1">
                    {displayOptions.map((option) => {
                        const isSelected = selected.includes(option.value);
                        return (
                            <button
                                key={option.value}
                                type="button"
                                className={`inline-flex cursor-pointer items-center gap-0.5 border px-1.5 py-0.5 text-[10px] font-medium transition-all ${isSelected ? `${c.bg100} ${c.text700} ${c.border300} ${c.hoverBg200} ${c.hoverBorder400}` : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300 hover:bg-slate-100'}`}
                                onClick={() => handleToggle(option.value)}
                            >
                                {isSelected && <LuCheck size={8} />}
                                {option.label}
                                {option.count !== undefined && (
                                    <span className={`text-[10px] ${isSelected ? c.text500 : 'text-slate-400'}`}>
                                        ({option.count})
                                    </span>
                                )}
                            </button>
                        );
                    })}
                    {displayOptions.length === 0 && (
                        <span className="text-[10px] text-slate-400">No options</span>
                    )}
                </div>
            </div>
        </div>
    );
};

// Removable Filter Chip Component
interface FilterChipProps {
    chip: FilterChipData;
    onRemove: (chip: FilterChipData) => void;
}

const FilterChip: React.FC<FilterChipProps> = ({ chip, onRemove }) => {
    const c = getFilterColorClasses(chip.color);
    return (
        <Badge
            colorScheme={c.badge}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 transition-all hover:scale-95 hover:opacity-80"
            onClick={(e) => {
                e.stopPropagation();
                onRemove(chip);
            }}
        >
            <span className="text-xs">{chip.label}</span>
            <button
                type="button"
                title="Remove filter"
                className="flex items-center"
                onClick={(e) => {
                    e.stopPropagation();
                    onRemove(chip);
                }}
            >
                <LuX size={12} />
            </button>
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
        <div className="min-h-[70px] overflow-hidden border border-slate-200 bg-white p-2">
            {/* Card Header */}
            <div className="mb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-1">
                    <LuCalendar size={10} />
                    <span className="text-[10px] font-semibold uppercase text-slate-600">
                        Date Range
                    </span>
                </div>
                {hasValue && (
                    <button
                        type="button"
                        title="Clear date range"
                        onClick={onClear}
                        className="cursor-pointer p-0.5 text-slate-400 hover:text-slate-600"
                    >
                        <LuX size={10} />
                    </button>
                )}
            </div>

            {/* Quick Presets */}
            <div className="mb-1.5 flex flex-wrap gap-1">
                {DATE_PRESETS.map((preset) => {
                    const isActive = activePreset === preset.label;
                    return (
                        <button
                            key={preset.label}
                            type="button"
                            className={`cursor-pointer border px-1.5 py-0.5 text-[10px] font-medium transition-all ${isActive ? 'border-purple-300 bg-purple-100 text-purple-700 hover:border-purple-400 hover:bg-purple-200' : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300 hover:bg-slate-100'}`}
                            onClick={() => applyPreset(preset.months)}
                        >
                            {preset.label}
                        </button>
                    );
                })}
            </div>

            {/* Date inputs - Vertical */}
            <div className="flex flex-col gap-1">
                <div>
                    <span className="mb-0.5 block text-[10px] text-slate-500">From</span>
                    <input
                        type="date"
                        title="From date"
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
                </div>
                <div>
                    <span className="mb-0.5 block text-[10px] text-slate-500">To</span>
                    <input
                        type="date"
                        title="To date"
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
                </div>
            </div>
        </div>
    );
};

// Always-visible primary filters: date range, accounts, review status (apply immediately)
interface QuickFilterBarProps {
    filters: TransactionFilterState;
    onChange: (filters: TransactionFilterState) => void;
    accountOptions: FilterOption[];
    statusOptions: FilterOption[];
    hiddenSet: Set<keyof TransactionFilterState>;
}

const QUICK_STATUSES = [
    { value: 'pending', label: 'Pending', on: 'border-amber-300 bg-amber-50 text-amber-800', off: 'border-slate-200 bg-white text-amber-700/60 hover:bg-amber-50/50' },
    { value: 'valid', label: 'Valid', on: 'border-green-300 bg-green-50 text-green-800', off: 'border-slate-200 bg-white text-green-700/60 hover:bg-green-50/50' },
    { value: 'invalid', label: 'Invalid', on: 'border-red-200 bg-red-50 text-red-700', off: 'border-slate-200 bg-white text-red-700/60 hover:bg-red-50/50' },
];

const QUICK_PILL = 'shrink-0 whitespace-nowrap border px-2 py-0.5 text-xs transition-colors';
const QUICK_PILL_ON = 'border-blue-500 bg-blue-500 text-white';
const QUICK_PILL_OFF = 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50';

const QuickFilterBar: React.FC<QuickFilterBarProps> = ({ filters, onChange, accountOptions, statusOptions, hiddenSet }) => {
    const fromDate = filters.dateFrom ? filters.dateFrom.split('T')[0] : '';
    const toDate = filters.dateTo ? filters.dateTo.split('T')[0] : '';
    const activePreset = NAMED_DATE_RANGES.find(r => {
        const range = getNamedDateRange(r.id);
        return range.from === fromDate && range.to === toDate;
    })?.id;

    const statusCounts = new Map(statusOptions.map(o => [o.value, o.count]));
    const toggleStatus = (value: string) => {
        const current = filters.reviewStatus;
        const next = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
        onChange({ ...filters, reviewStatus: next });
    };

    const selectedAccounts = filters.accountIds;
    const [accountSearch, setAccountSearch] = useState('');
    const visibleAccounts = accountSearch
        ? accountOptions.filter(o => o.label.toLowerCase().includes(accountSearch.toLowerCase()))
        : accountOptions;
    const toggleAccount = (value: string) => {
        const next = selectedAccounts.includes(value)
            ? selectedAccounts.filter(v => v !== value)
            : [...selectedAccounts, value];
        onChange({ ...filters, accountIds: next });
    };

    return (
        <div className="mb-2 flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Date range">
                    <LuCalendar size={14} className="text-slate-500" />
                    {NAMED_DATE_RANGES.map(r => (
                        <button
                            key={r.id}
                            type="button"
                            aria-pressed={activePreset === r.id}
                            className={`${QUICK_PILL} ${activePreset === r.id ? QUICK_PILL_ON : QUICK_PILL_OFF}`}
                            onClick={() => {
                                const range = getNamedDateRange(r.id);
                                onChange({ ...filters, dateFrom: range.from, dateTo: range.to });
                            }}
                        >
                            {r.label}
                        </button>
                    ))}
                    <input
                        type="date"
                        aria-label="From date"
                        value={fromDate}
                        onChange={e => onChange({ ...filters, dateFrom: e.target.value })}
                        className="h-6 border border-slate-200 bg-white px-1 text-xs"
                    />
                    <span className="text-xs text-slate-400">→</span>
                    <input
                        type="date"
                        aria-label="To date"
                        value={toDate}
                        onChange={e => onChange({ ...filters, dateTo: e.target.value })}
                        className="h-6 border border-slate-200 bg-white px-1 text-xs"
                    />
                    {(fromDate || toDate) && (
                        <button
                            type="button"
                            aria-label="Clear date range"
                            className="p-0.5 text-slate-400 hover:text-slate-700"
                            onClick={() => onChange({ ...filters, dateFrom: '', dateTo: '' })}
                        >
                            <LuX size={12} />
                        </button>
                    )}
                </div>

                {!hiddenSet.has('reviewStatus') && (
                    <div className="inline-flex items-center gap-1" role="group" aria-label="Review status">
                        {QUICK_STATUSES.map(s => {
                            const isOn = filters.reviewStatus.includes(s.value);
                            const count = statusCounts.get(s.value);
                            return (
                                <button
                                    key={s.value}
                                    type="button"
                                    aria-pressed={isOn}
                                    className={`${QUICK_PILL} ${isOn ? `${s.on} font-medium` : s.off}`}
                                    onClick={() => toggleStatus(s.value)}
                                >
                                    {s.label}{count !== undefined ? ` ${count}` : ''}
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>

            {!hiddenSet.has('accountIds') && accountOptions.length > 0 && (
                <div className={`border bg-white p-2 ${selectedAccounts.length > 0 ? 'border-blue-200' : 'border-slate-200'}`}>
                    <div className="flex items-start gap-2">
                        <div className="flex shrink-0 items-center gap-2">
                            <span className="text-[10px] font-semibold uppercase text-slate-600">👤 Accounts</span>
                            {selectedAccounts.length > 0 && (
                                <Badge colorScheme="blue" className="rounded-full">{selectedAccounts.length}</Badge>
                            )}
                            <label className="flex w-40 items-center gap-1 border border-slate-200 bg-slate-50 px-1.5 py-0.5">
                                <LuSearch size={12} className="text-slate-400" />
                                <input
                                    type="text"
                                    aria-label="Search accounts"
                                    placeholder="Search…"
                                    value={accountSearch}
                                    onChange={e => setAccountSearch(e.target.value)}
                                    className="w-full bg-transparent text-xs text-slate-700 outline-none"
                                />
                            </label>
                            <button
                                type="button"
                                aria-pressed={selectedAccounts.length === 0}
                                className={`${QUICK_PILL} ${selectedAccounts.length === 0 ? QUICK_PILL_ON : QUICK_PILL_OFF}`}
                                onClick={() => onChange({ ...filters, accountIds: [] })}
                            >
                                All
                            </button>
                        </div>
                        <div className="flex max-h-[52px] min-w-0 flex-1 flex-wrap gap-1 overflow-y-auto" role="group" aria-label="Accounts">
                            {visibleAccounts.map(o => {
                                const isOn = selectedAccounts.includes(o.value);
                                return (
                                    <button
                                        key={o.value}
                                        type="button"
                                        aria-pressed={isOn}
                                        className={`${QUICK_PILL} ${isOn ? QUICK_PILL_ON : QUICK_PILL_OFF}`}
                                        onClick={() => toggleAccount(o.value)}
                                    >
                                        {o.label}
                                        {o.count !== undefined && <span className={isOn ? 'ml-1 text-blue-100' : 'ml-1 text-slate-400'}>{o.count}</span>}
                                    </button>
                                );
                            })}
                            {visibleAccounts.length === 0 && <span className="py-0.5 text-xs text-slate-400">No matching accounts</span>}
                        </div>
                    </div>
                </div>
            )}
        </div>
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
        <div ref={cardRef} className={`relative min-h-[70px] border bg-white p-2 ${activeCount > 0 ? getFilterColorClasses(color).border200 : 'border-slate-200'}`}>
            {/* Card Header */}
            <div className="mb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-1">
                    <span className="text-xs">{icon}</span>
                    <span className="text-[10px] font-semibold uppercase text-slate-600">
                        {label}
                    </span>
                </div>
                {activeCount > 0 && (
                    <Badge colorScheme={getFilterColorClasses(color).badge} className="rounded-full">
                        {activeCount}
                    </Badge>
                )}
            </div>

            {/* Dropdown trigger */}
            <Button
                size="sm"
                variant="outline"
                className={`w-full justify-between ${isOpen ? getFilterColorClasses(color).border300 : 'border-slate-200'} ${activeCount > 0 ? getFilterColorClasses(color).bg50 : 'bg-white'} ${getFilterColorClasses(color).hoverBorder300}`}
                onClick={onToggle}
            >
                <span className={`truncate text-[10px] ${activeCount > 0 ? getFilterColorClasses(color).text700 : 'text-slate-600'}`}>
                    {getSelectedDisplay()}
                </span>
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
                <div ref={popoverRef} className="absolute left-0 right-0 top-full z-[1000] mt-1 overflow-hidden border border-slate-200 bg-white shadow-lg">
                    {/* Search */}
                    <div className="border-b border-slate-100 p-1.5">
                        <div className="flex items-center gap-1 bg-slate-50 px-1.5">
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
                        </div>
                    </div>

                    {/* Quick actions */}
                    <div className="flex gap-1 border-b border-slate-100 p-1.5">
                        <Button size="sm" variant="ghost" onClick={() => onChange(filteredOptions.map(o => o.value))}>
                            <span className="text-[10px]">All</span>
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => onChange([])}>
                            <span className="text-[10px]">None</span>
                        </Button>
                    </div>

                    {/* Options */}
                    <div className="max-h-[160px] overflow-y-auto p-1">
                        {filteredOptions.map((option) => {
                            const isSelected = selected.includes(option.value);
                            const c = getFilterColorClasses(color);
                            return (
                                <div
                                    key={option.value}
                                    className={`flex cursor-pointer items-center gap-1.5 px-1.5 py-1 ${isSelected ? c.bg50 : ''} ${isSelected ? c.hoverBg100 : 'hover:bg-slate-50'}`}
                                    onClick={() => handleToggle(option.value)}
                                >
                                    <div
                                        className={`flex h-3 w-3 shrink-0 items-center justify-center border ${isSelected ? `${c.border500} ${c.bg500}` : 'border-slate-300 bg-white'}`}
                                    >
                                        {isSelected && <LuCheck size={8} color="white" />}
                                    </div>
                                    <span className="flex-1 text-[10px]">{option.label}</span>
                                    {option.count !== undefined && (
                                        <span className="text-[10px] text-slate-400">({option.count})</span>
                                    )}
                                </div>
                            );
                        })}
                        {filteredOptions.length === 0 && (
                            <p className="p-1.5 text-center text-[10px] text-slate-400">
                                No results
                            </p>
                        )}
                    </div>
                </div>
            )}
        </div>
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
        <div ref={cardRef} className={`relative min-h-[70px] border bg-white p-2 ${activeCount > 0 ? 'border-pink-200' : 'border-slate-200'}`}>
            {/* Card Header */}
            <div className="mb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-1">
                    <span className="text-xs">📁</span>
                    <span className="text-[10px] font-semibold uppercase text-slate-600">
                        Category
                    </span>
                </div>
                {activeCount > 0 && (
                    <Badge colorScheme="red" className="rounded-full">
                        {activeCount}
                    </Badge>
                )}
            </div>

            {/* Dropdown trigger */}
            <Button
                size="sm"
                variant="outline"
                className={`w-full justify-between hover:border-pink-300 ${isOpen ? 'border-pink-300' : 'border-slate-200'} ${activeCount > 0 ? 'bg-pink-50' : 'bg-white'}`}
                onClick={onToggle}
            >
                <span className={`truncate text-[10px] ${activeCount > 0 ? 'text-pink-700' : 'text-slate-600'}`}>
                    {getSelectedDisplay()}
                </span>
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
                <div ref={popoverRef} className="absolute left-0 right-0 top-full z-[1000] mt-1 min-w-[220px] overflow-hidden border border-slate-200 bg-white shadow-lg">
                    <Tabs value={activeTab} onValueChange={setActiveTab}>
                        <TabsList className="px-1.5 pt-1.5">
                            {categoriesByDimension.map(dim => {
                                const count = selected.filter(s =>
                                    dim.categories.some(c => c.value === s)
                                ).length;
                                return (
                                    <TabsTrigger key={dim.id} value={dim.id.toString()}>
                                        <span className="text-[10px]">{dim.label}</span>
                                        {count > 0 && (
                                            <Badge colorScheme="red" className="ml-1">{count}</Badge>
                                        )}
                                    </TabsTrigger>
                                );
                            })}
                        </TabsList>

                        {categoriesByDimension.map(dim => (
                            <TabsContent key={dim.id} value={dim.id.toString()}>
                                <div className="max-h-[160px] overflow-y-auto p-1.5">
                                    <div className="flex flex-wrap gap-1">
                                        {currentCategories.map((cat) => {
                                            const isSelected = selected.includes(cat.value);
                                            return (
                                                <button
                                                    key={cat.value}
                                                    type="button"
                                                    className={`inline-flex cursor-pointer items-center gap-0.5 border px-1.5 py-0.5 text-[10px] ${isSelected ? 'border-pink-300 bg-pink-100 text-pink-700 hover:bg-pink-200' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'}`}
                                                    onClick={() => handleToggle(cat.value)}
                                                >
                                                    {isSelected && <LuCheck size={8} />}
                                                    {cat.label}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            </TabsContent>
                        ))}
                    </Tabs>
                </div>
            )}
        </div>
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
    quickBar = true,
    className = 'mb-3',
}) => {
    const effectiveBaseUrl = filterOptionsUrl || `${API_URL}/transactions/filter-options`;
    const hiddenSet = React.useMemo(() => new Set(hiddenFilters || []), [hiddenFilters]);

    // Build URL search params from applied filters for context-aware counts
    const filterParams = React.useMemo(() => buildTransactionFilterParams(filters), [filters]);

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
            attributed_asset_ids: localFilters.attributedAssetIds,
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
            } else if (def.key === 'attributedAssetIds') {
                values = sourceFilters.attributed_asset_ids || [];
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
            <div className="p-3 text-center">
                <span className="text-xs text-slate-500">Loading filters...</span>
            </div>
        );
    }

    const activeFilterCount = getActiveFilterCount();
    const openFilters = FILTER_DEFS.filter(d => !d.isDropdown && !hiddenSet.has(d.key));
    const dropdownFilters = FILTER_DEFS.filter(d => d.isDropdown && !hiddenSet.has(d.key));
    const filterChips = getFilterChips();
    const hasActiveFilters = filterChips.length > 0;
    const visibleChips = filterChips.slice(0, visibleChipCount);
    const hiddenChipCount = Math.max(0, filterChips.length - visibleChipCount);

    const applyQuick = (next: TransactionFilterState) => {
        setLocalFilters(next);
        onChange(next);
    };

    return (
        <div className={className}>
            {quickBar && (
                <QuickFilterBar
                    filters={localFilters}
                    onChange={applyQuick}
                    accountOptions={filterOptions?.accounts || []}
                    statusOptions={filterOptions?.review_statuses || []}
                    hiddenSet={hiddenSet}
                />
            )}
            <div className={`overflow-visible border bg-slate-50 ${hasChanges ? 'border-blue-300' : 'border-slate-200'}`}>
                {/* Clickable Header */}
                <div
                    className="flex cursor-pointer items-center justify-between p-3 transition-colors hover:bg-slate-100"
                    onClick={() => onExpandedChange?.(!expanded)}
                >
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                        <div className="transition-transform duration-200" style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}>
                            <LuChevronDown size={14} />
                        </div>
                        <LuFilter size={12} />
                        <span className="text-xs font-semibold">{quickBar ? '+ Filter' : 'Filters'}</span>
                        {activeFilterCount > 0 && (
                            <Badge colorScheme="blue">{activeFilterCount} active</Badge>
                        )}
                        {/* Inline filter chips */}
                        {hasActiveFilters && !expanded && visibleChips.map(chip => (
                            <div key={chip.id} onClick={(e) => e.stopPropagation()}>
                                <FilterChip chip={chip} onRemove={handleRemoveChip} />
                            </div>
                        ))}
                        {hasActiveFilters && !expanded && hiddenChipCount > 0 && (
                            <Badge colorScheme="gray" className="border border-slate-200">
                                +{hiddenChipCount}
                            </Badge>
                        )}
                    </div>
                    <div className="flex shrink-0 gap-1.5" onClick={(e) => e.stopPropagation()}>
                        {canReset && (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={handleReset}
                                className="text-slate-500 hover:text-slate-700"
                            >
                                <LuRotateCcw size={10} />
                                <span className="ml-0.5 text-[10px]">Clear All</span>
                            </Button>
                        )}
                        {hasChanges && (
                            <Button
                                size="sm"
                                colorScheme="blue"
                                onClick={handleApply}
                            >
                                <LuCheck size={10} />
                                <span className="ml-0.5 text-[10px]">Apply</span>
                            </Button>
                        )}
                    </div>
                </div>

                {/* Chip Summary Row — only when expanded */}
                {hasActiveFilters && expanded && (
                    <div ref={chipContainerRef} className="px-3 pb-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                            {visibleChips.map(chip => (
                                <FilterChip key={chip.id} chip={chip} onRemove={handleRemoveChip} />
                            ))}
                            {hiddenChipCount > 0 && (
                                <Badge colorScheme="gray" className="border border-slate-200">
                                    and {hiddenChipCount} more
                                </Badge>
                            )}
                        </div>

                        {/* Filter Metadata - Show counts */}
                        {filterMetadata && (
                            <p className="mt-1 text-[10px] text-slate-500">
                                Showing {filterMetadata.filtered_count} of {filterMetadata.total_count} transactions
                            </p>
                        )}

                        {/* Validation Warnings */}
                        {filterMetadata?.validation_warnings && filterMetadata.validation_warnings.length > 0 && (
                            <div className="mt-2">
                                {filterMetadata.validation_warnings.map((warning, idx) => (
                                    <div key={idx} className={`flex items-center gap-1 text-[10px] ${warning.severity === 'error' ? 'text-red-600' : 'text-orange-600'}`}>
                                        <span className="font-semibold">⚠️</span>
                                        <span>
                                            <strong>{warning.filter_name}:</strong> {warning.reason} ({warning.provided_value})
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}


                {/* Filter Cards */}
                {expanded && (
                    <div className={`overflow-visible p-3 ${hasActiveFilters ? 'pt-1' : 'pt-2'}`}>

                        {/* Card Grid - Maximum columns */}
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
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
                                    <div key={def.key} className="col-span-1 md:col-span-2">
                                        {filterCard}
                                    </div>
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

                            {/* Attributed Asset Dropdown Card */}
                            {!hiddenSet.has('attributedAssetIds') && (
                                <DropdownCard
                                    label="Attributed Asset"
                                    icon="🎯"
                                    options={filterOptions?.attributed_assets || []}
                                    selected={localFilters.attributedAssetIds || []}
                                    onChange={(v) => updateLocalFilter('attributedAssetIds', v)}
                                    color="orange"
                                    isOpen={openDropdown === 'attributedAssetIds'}
                                    onToggle={() => setOpenDropdown(openDropdown === 'attributedAssetIds' ? null : 'attributedAssetIds')}
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
                                <div className={`min-h-[70px] border bg-white p-2 ${localFilters.transactionIds?.length ? 'border-slate-300' : 'border-slate-200'}`}>
                                    <div className="mb-1.5 flex items-center justify-between">
                                        <div className="flex items-center gap-1">
                                            <span className="text-xs">#️⃣</span>
                                            <span className="text-[10px] font-semibold uppercase text-slate-600">
                                                Transaction IDs
                                            </span>
                                        </div>
                                        {localFilters.transactionIds?.length ? (
                                            <Badge colorScheme="gray" className="rounded-full">
                                                {localFilters.transactionIds.length}
                                            </Badge>
                                        ) : null}
                                    </div>
                                    <div className="flex items-center gap-1 bg-slate-50 px-1 py-1">
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
                                            <button
                                                type="button"
                                                title="Clear transaction IDs"
                                                onClick={() => updateLocalFilter('transactionIds', undefined)}
                                                className="cursor-pointer text-slate-400 hover:text-slate-600"
                                            >
                                                <LuX size={10} />
                                            </button>
                                        ) : null}
                                    </div>
                                    <p className="mt-1 text-[10px] text-slate-400">
                                        Comma-separated IDs
                                    </p>
                                </div>
                            )}

                            {/* Fees filter card (Has Fees + Include Fee) */}
                            {!hiddenSet.has('hasFees') && (
                                <div className={`min-h-[70px] border bg-white p-2 ${localFilters.hasFees !== undefined || localFilters.includeFee !== undefined ? 'border-orange-200' : 'border-slate-200'}`}>
                                    <div className="mb-1.5 flex items-center justify-between">
                                        <div className="flex items-center gap-1">
                                            <span className="text-xs">💸</span>
                                            <span className="text-[10px] font-semibold uppercase text-slate-600">
                                                Fees
                                            </span>
                                        </div>
                                        {(localFilters.hasFees !== undefined || localFilters.includeFee !== undefined) && (
                                            <Badge colorScheme="orange">active</Badge>
                                        )}
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        <Badge
                                            colorScheme={localFilters.hasFees ? 'orange' : 'gray'}
                                            className={`cursor-pointer select-none hover:opacity-80 ${localFilters.hasFees ? '' : 'border border-slate-200'}`}
                                            onClick={() => updateLocalFilter('hasFees', localFilters.hasFees ? undefined : true)}
                                        >
                                            Has Fees{filterOptions?.has_fee_count != null ? ` (${filterOptions.has_fee_count})` : ''}
                                        </Badge>
                                        <Badge
                                            colorScheme={localFilters.hasFees === false ? 'red' : 'gray'}
                                            className={`cursor-pointer select-none hover:opacity-80 ${localFilters.hasFees === false ? '' : 'border border-slate-200'}`}
                                            onClick={() => updateLocalFilter('hasFees', localFilters.hasFees === false ? undefined : false)}
                                        >
                                            No Fees{filterOptions?.total_count != null && filterOptions?.has_fee_count != null ? ` (${filterOptions.total_count - filterOptions.has_fee_count})` : ''}
                                        </Badge>
                                        <Badge
                                            colorScheme={localFilters.includeFee === true ? 'green' : 'gray'}
                                            className={`cursor-pointer select-none hover:opacity-80 ${localFilters.includeFee === true ? '' : 'border border-slate-200'}`}
                                            title="Fee included in P&L cost basis calculation"
                                            onClick={() => updateLocalFilter('includeFee', localFilters.includeFee === true ? undefined : true)}
                                        >
                                            Fee in Cost Basis{filterOptions?.include_fee_count != null ? ` (${filterOptions.include_fee_count})` : ''}
                                        </Badge>
                                        <Badge
                                            colorScheme={localFilters.includeFee === false ? 'red' : 'gray'}
                                            className={`cursor-pointer select-none hover:opacity-80 ${localFilters.includeFee === false ? '' : 'border border-slate-200'}`}
                                            title="Fee excluded from P&L cost basis calculation"
                                            onClick={() => updateLocalFilter('includeFee', localFilters.includeFee === false ? undefined : false)}
                                        >
                                            Fee Not in Cost Basis{filterOptions?.total_count != null && filterOptions?.include_fee_count != null ? ` (${filterOptions.total_count - filterOptions.include_fee_count})` : ''}
                                        </Badge>
                                    </div>
                                </div>
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
                                <div className={`min-h-[70px] border bg-white p-2 ${localFilters.hasBundle !== undefined || (localFilters.bundlePatterns?.length ?? 0) > 0 ? 'border-teal-200' : 'border-slate-200'}`}>
                                    <div className="mb-1.5 flex items-center justify-between">
                                        <div className="flex items-center gap-1">
                                            <span className="text-xs">📦</span>
                                            <span className="text-[10px] font-semibold uppercase text-slate-600">
                                                Bundle
                                            </span>
                                        </div>
                                        {(localFilters.hasBundle !== undefined || (localFilters.bundlePatterns?.length ?? 0) > 0) && (
                                            <Badge colorScheme="green">active</Badge>
                                        )}
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        <Badge
                                            colorScheme={localFilters.hasBundle === true ? 'green' : 'gray'}
                                            className={`cursor-pointer select-none hover:opacity-80 ${localFilters.hasBundle === true ? '' : 'border border-slate-200'}`}
                                            onClick={() => updateLocalFilter('hasBundle', localFilters.hasBundle === true ? undefined : true)}
                                        >
                                            Has Bundle{filterOptions?.has_bundle_count != null ? ` (${filterOptions.has_bundle_count})` : ''}
                                        </Badge>
                                        <Badge
                                            colorScheme={localFilters.hasBundle === false ? 'red' : 'gray'}
                                            className={`cursor-pointer select-none hover:opacity-80 ${localFilters.hasBundle === false ? '' : 'border border-slate-200'}`}
                                            onClick={() => updateLocalFilter('hasBundle', localFilters.hasBundle === false ? undefined : false)}
                                        >
                                            No Bundle{filterOptions?.total_count != null && filterOptions?.has_bundle_count != null ? ` (${filterOptions.total_count - filterOptions.has_bundle_count})` : ''}
                                        </Badge>
                                    </div>
                                    {/* Bundle Pattern chips */}
                                    {(filterOptions?.bundle_patterns?.length ?? 0) > 0 && (
                                        <div className="mt-2 flex flex-wrap gap-1">
                                            {(filterOptions?.bundle_patterns || []).map((opt) => {
                                                const isSelected = (localFilters.bundlePatterns || []).includes(opt.value);
                                                return (
                                                    <button
                                                        key={opt.value}
                                                        type="button"
                                                        className={`inline-flex cursor-pointer items-center gap-0.5 border px-1.5 py-0.5 text-[10px] font-medium transition-all ${isSelected ? 'border-teal-300 bg-teal-100 text-teal-700 hover:border-teal-400 hover:bg-teal-200' : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300 hover:bg-slate-100'}`}
                                                        onClick={() => {
                                                            const current = localFilters.bundlePatterns || [];
                                                            const next = isSelected
                                                                ? current.filter(v => v !== opt.value)
                                                                : [...current, opt.value];
                                                            updateLocalFilter('bundlePatterns', next);
                                                        }}
                                                    >
                                                        {isSelected && <LuCheck size={8} />}
                                                        {opt.label}
                                                        {opt.count !== undefined && (
                                                            <span className={`text-[10px] ${isSelected ? 'text-teal-500' : 'text-slate-400'}`}>
                                                                ({opt.count})
                                                            </span>
                                                        )}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Extra filter cards from parent */}
                            {extraFilterCards}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default TransactionFilters;
