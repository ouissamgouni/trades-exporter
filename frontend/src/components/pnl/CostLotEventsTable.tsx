/**
 * Unified Cost Lot Events Table
 * 
 * Reusable component for displaying cost lot events across different contexts:
 * - P&L Audit tab (full featured with all columns and filters)
 * - Asset Detail view (asset-specific events)
 * - Unit Detail expanded row (compact mode)
 * 
 * Features:
 * - Event type visibility toggles (with smart defaults)
 * - Asset filtering
 * - Date range filtering (server-side)
 * - Column show/hide configuration
 * - Pagination support
 * - Balance change indicators
 * - Event type legend tooltip
 * - Collapsible filter bar with quick presets
 */

import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Box, Flex, Button, Badge, Text, IconButton, Spinner } from '@chakra-ui/react';
import { Table } from '@chakra-ui/react';
import { Tooltip } from '../ui/tooltip';
import { FiHelpCircle, FiRefreshCw, FiChevronLeft, FiChevronRight, FiChevronsLeft, FiChevronsRight } from 'react-icons/fi';
import { usePagination } from '../../hooks/usePagination';
import { formatDateTimeLocale } from '../../utils/dateUtils';
import { CostLotEventEntry, LotEventType } from './types';
import { AssetRef, API_URL } from '../../types';
import {
    EVENT_TYPE_CONFIG,
    getSortedEventTypes,
    countEventsByType,
    getEventConfig
} from './eventConfig';
import { CostLotEventsFilterBar, FilterState, getDefaultEventTypes, getDefaultUnitPatterns } from './CostLotEventsFilterBar';
import { TransactionTooltip } from '../TransactionTooltip';
import { CostBasisChainTooltip } from './CostBasisChainTooltip';
import { FmvBadge } from './FmvBadge';

// ============================================================================
// Types
// ============================================================================

interface CostLotEventsTableProps {
    // Required: Version ID for server-side data fetching
    versionId: number;
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
    onUnitClick?: (unitId: number) => void;

    // Optional filters for specific contexts
    lotId?: number;        // Filter to specific lot
    unitId?: number;       // Filter to specific unit
    assetContext?: AssetRef;  // For asset-specific filtering

    // Context-level transaction filters (from InvestigationView filter bar)
    txFilterParams?: Record<string, string | undefined>;

    // Column visibility options
    showColumns?: {
        timestamp?: boolean;
        asset?: boolean;
        account?: boolean;
        unit?: boolean;
        transactionId?: boolean;
        quantityDelta?: boolean;
        costDelta?: boolean;
        accountBalance?: boolean;
        assetBalance?: boolean;
        triggeredBy?: boolean;
        chain?: boolean;
    };

    // External filters (for programmatic control)
    filters?: {
        eventTypes?: Set<LotEventType>;
        assetIds?: Set<number>;
        accountIds?: Set<number>;
        dateRange?: {
            start: Date;
            end: Date;
        };
    };

    // Feature flags
    features?: {
        pagination?: boolean;
        search?: boolean;
        eventTypeFilters?: boolean;
        assetFilter?: boolean;
        dateRangeFilter?: boolean;
        eventLegend?: boolean;
    };

    // Filter bar collapse state
    defaultFiltersCollapsed?: boolean;

    // Pagination
    hidePagination?: boolean;
    storageKey?: string;

    // Styling
    compact?: boolean;
    maxHeight?: string;
}

// ============================================================================
// Utility Functions
// ============================================================================

const formatCurrency = (value: number, currency: string): string => {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);
};

const formatQty = (value: number): string => {
    if (value === 0) return '0';
    return value.toFixed(8).replace(/\.?0+$/, '');
};

const formatSmartNumber = (value: number): string => {
    if (value === 0) return '0';

    const abs = Math.abs(value);
    // If main number is zero (< 1), use 4 decimals
    if (abs < 1) {
        return value.toFixed(4).replace(/\.?0+$/, '');
    }
    // Otherwise use 2 decimals
    return value.toFixed(2);
};

const getPatternColor = (pattern: string): string => {
    const colorMap: Record<string, string> = {
        'internal_transfer': 'blue',
        'unmatched_internal_transfer': 'orange',
        'swap': 'purple',
        'split': 'teal',
        'flow': 'green',
        'unknown': 'gray',
    };
    return colorMap[pattern] || 'gray';
};

const formatCompactDateTime = (timestamp: string): string => {
    const date = new Date(timestamp);
    // Format: "Jan 15 14:30" - compact date and time
    const month = date.toLocaleString('en-US', { month: 'short' });
    const day = date.getDate();
    const time = date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
    return `${month} ${day} ${time}`;
};

// ============================================================================
// Quick Filter Presets
// ============================================================================

interface QuickPreset {
    label: string;
    icon: string;
    eventTypes?: LotEventType[];
    unitPatterns?: string[];
}

const QUICK_PRESETS: Record<string, QuickPreset> = {
    created: {
        label: 'Created',
        icon: '+',
        eventTypes: ['created'],
    },
    consumed: {
        label: 'Consumed',
        icon: '↓',
        eventTypes: ['consumed'],
    },
    negative: {
        label: 'Negative Lots',
        icon: '−',
        eventTypes: ['created-negative', 'settled'],
    },
    settled: {
        label: 'Settled',
        icon: '✓',
        eventTypes: ['settled'],
    },
    transfers: {
        label: 'Transfers',
        icon: '🔄',
        unitPatterns: ['internal_transfer'],
    },
    unmatchedTransfers: {
        label: 'Unmatched Transfers',
        icon: '⏳',
        unitPatterns: ['unmatched_internal_transfer'],
    },
};

// ============================================================================
// Event Type Legend Tooltip
// ============================================================================

const EventLegendTooltip: React.FC = () => {
    return (
        <Tooltip
            content={
                <Box fontSize="xs" maxW="400px" p={2}>
                    <Text fontWeight="bold" mb={2}>Cost Lot Event Types:</Text>
                    {getSortedEventTypes().map(type => {
                        const cfg = EVENT_TYPE_CONFIG[type];
                        return (
                            <Flex key={type} gap={2} mb={2} align="flex-start">
                                <Badge size="xs" colorPalette={cfg.color} flexShrink={0}>
                                    {cfg.icon}
                                </Badge>
                                <Box>
                                    <Text fontWeight="medium">{cfg.label}</Text>
                                    <Text color="gray.500" fontSize="2xs">{cfg.description}</Text>
                                </Box>
                            </Flex>
                        );
                    })}
                </Box>
            }
        >
            <IconButton size="xs" variant="ghost" aria-label="Event types help">
                <FiHelpCircle />
            </IconButton>
        </Tooltip>
    );
};

// ============================================================================
// Server-Side Data Fetching Hook
// ============================================================================

interface UseLotEventsQueryParams {
    versionId: number;
    lotId?: number;
    unitId?: number;
    eventTypes?: LotEventType[];
    assetIds?: number[];
    relatedAssetIds?: number[];
    accountIds?: number[];
    unitPatterns?: string[];
    dateStart?: string;  // ISO datetime string
    dateEnd?: string;    // ISO datetime string
    txFilterParams?: Record<string, string | undefined>;  // Context-level transaction filters
    page: number;
    limit: number;
}

interface UseLotEventsQueryResult {
    events: CostLotEventEntry[];
    total: number;
    isLoading: boolean;
    isRefreshing: boolean;
    error: string | null;
    refetch: () => void;
}

const useLotEventsQuery = (params: UseLotEventsQueryParams): UseLotEventsQueryResult => {
    const [events, setEvents] = useState<CostLotEventEntry[]>([]);
    const [total, setTotal] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Guard against concurrent fetches
    const fetchingRef = useRef(false);
    const initialFetchDoneRef = useRef(false);

    // Serialize arrays to stable string keys for dependency comparison
    const eventTypesKey = JSON.stringify(params.eventTypes ?? []);
    const assetIdsKey = JSON.stringify(params.assetIds ?? []);
    const relatedAssetIdsKey = JSON.stringify(params.relatedAssetIds ?? []);
    const accountIdsKey = JSON.stringify(params.accountIds ?? []);
    const unitPatternsKey = JSON.stringify(params.unitPatterns ?? []);
    const txFilterParamsKey = JSON.stringify(params.txFilterParams ?? {});

    const fetchEvents = useCallback(async (isInitial = false) => {
        // Prevent concurrent fetches
        if (fetchingRef.current) return;
        fetchingRef.current = true;

        if (isInitial) {
            setIsLoading(true);
        } else {
            setIsRefreshing(true);
        }
        setError(null);

        try {
            const queryParams = new URLSearchParams();
            queryParams.append('page', params.page.toString());
            queryParams.append('limit', params.limit.toString());

            if (params.lotId) queryParams.append('lot_id', params.lotId.toString());
            if (params.unitId) queryParams.append('unit_id', params.unitId.toString());

            if (params.eventTypes && params.eventTypes.length > 0) {
                queryParams.append('event_type', params.eventTypes.join(','));
            }
            if (params.assetIds && params.assetIds.length > 0) {
                queryParams.append('asset_id', params.assetIds.join(','));
            }
            if (params.relatedAssetIds && params.relatedAssetIds.length > 0) {
                queryParams.append('related_asset_id', params.relatedAssetIds.join(','));
            }
            if (params.accountIds && params.accountIds.length > 0) {
                queryParams.append('account_id', params.accountIds.join(','));
            }
            if (params.unitPatterns && params.unitPatterns.length > 0) {
                queryParams.append('unit_pattern', params.unitPatterns.join(','));
            }
            // Server-side date range filtering
            if (params.dateStart) {
                queryParams.append('date_start', params.dateStart);
            }
            if (params.dateEnd) {
                queryParams.append('date_end', params.dateEnd);
            }

            // Context-level transaction filters (from InvestigationView filter bar)
            if (params.txFilterParams) {
                Object.entries(params.txFilterParams).forEach(([key, value]) => {
                    if (value !== undefined && value !== '') {
                        queryParams.append(key, value);
                    }
                });
            }

            const response = await fetch(
                `${API_URL}/pnl/versions/${params.versionId}/lot-events?${queryParams.toString()}`
            );

            if (!response.ok) {
                throw new Error(`Failed to fetch lot events: ${response.statusText}`);
            }

            const data = await response.json();
            setEvents(data.items || []);
            setTotal(data.total || 0);
            initialFetchDoneRef.current = true;
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
            console.error('Error fetching lot events:', err);
        } finally {
            setIsLoading(false);
            setIsRefreshing(false);
            fetchingRef.current = false;
        }
    }, [params.versionId, params.lotId, params.unitId, params.page, params.limit, params.dateStart, params.dateEnd, eventTypesKey, assetIdsKey, relatedAssetIdsKey, accountIdsKey, unitPatternsKey, txFilterParamsKey]);

    useEffect(() => {
        if (!initialFetchDoneRef.current) {
            fetchEvents(true);
        } else {
            fetchEvents(false);
        }
    }, [fetchEvents]);

    return {
        events,
        total,
        isLoading,
        isRefreshing,
        error,
        refetch: () => fetchEvents(false),
    };
};

// ============================================================================
// Filter Options Hook - Fetch all available filter values for a version
// ============================================================================

interface FilterOptions {
    assets: { id: number; symbol: string; label?: string }[];
    accounts: { id: number; name: string }[];
    eventTypes: { value: string; label?: string; count: number }[];
    unitPatterns: { value: string; label?: string; count: number }[];
}

interface UseFilterOptionsResult {
    options: FilterOptions;
    isLoading: boolean;
    error: string | null;
}

const useFilterOptions = (versionId: number): UseFilterOptionsResult => {
    const [options, setOptions] = useState<FilterOptions>({ assets: [], accounts: [], eventTypes: [], unitPatterns: [] });
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const fetchedRef = useRef(false);

    useEffect(() => {
        // Only fetch once per version
        if (fetchedRef.current) return;
        fetchedRef.current = true;

        const fetchOptions = async () => {
            setIsLoading(true);
            setError(null);

            try {
                const response = await fetch(
                    `${API_URL}/pnl/versions/${versionId}/lot-events/filter-options`
                );

                if (!response.ok) {
                    throw new Error(`Failed to fetch filter options: ${response.statusText}`);
                }

                const data = await response.json();
                setOptions({
                    assets: data.assets || [],
                    accounts: data.accounts || [],
                    eventTypes: data.event_types || [],
                    unitPatterns: data.unit_patterns || [],
                });
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Unknown error');
                console.error('Error fetching filter options:', err);
            } finally {
                setIsLoading(false);
            }
        };

        fetchOptions();
    }, [versionId]);

    return { options, isLoading, error };
};

// ============================================================================
// Main Component
// ============================================================================

export const CostLotEventsTable: React.FC<CostLotEventsTableProps> = ({
    versionId,
    lotId,
    unitId,
    baseCurrency,
    onTransactionClick,
    onUnitClick,
    showColumns = {},
    filters: externalFilters,
    features = {},
    hidePagination = false,
    storageKey = 'cost_lot_events',
    compact = false,
    maxHeight,
    assetContext,
    txFilterParams,
    defaultFiltersCollapsed = true,
}) => {
    // Default column visibility
    const columns = {
        timestamp: showColumns.timestamp ?? true,
        asset: showColumns.asset ?? true,
        account: showColumns.account ?? true,
        unit: showColumns.unit ?? true,
        quantityDelta: showColumns.quantityDelta ?? true,
        costDelta: showColumns.costDelta ?? true,
        accountBalance: showColumns.accountBalance ?? false,
        assetBalance: showColumns.assetBalance ?? false,
        triggeredBy: showColumns.triggeredBy ?? true,
        chain: showColumns.chain ?? true,
    };

    // Default feature flags
    const enabledFeatures = {
        pagination: features.pagination ?? true,
        search: features.search ?? true,
        eventTypeFilters: features.eventTypeFilters ?? true,
        assetFilter: features.assetFilter ?? false,
        dateRangeFilter: features.dateRangeFilter ?? false,
        eventLegend: features.eventLegend ?? true,
        filterBar: features.eventTypeFilters ?? true,  // Show new filter bar when event type filters enabled
    };

    // Pagination
    const pagination = usePagination({ storageKey });

    // Unified filter state for the new filter bar (all server-side)
    const [filterState, setFilterState] = useState<FilterState>(() => ({
        dateStart: '',
        dateEnd: '',
        eventTypes: externalFilters?.eventTypes
            ? Array.from(externalFilters.eventTypes)
            : getDefaultEventTypes(),
        unitPatterns: getDefaultUnitPatterns(),
        accountIds: externalFilters?.accountIds ? Array.from(externalFilters.accountIds) : [],
        assetIds: externalFilters?.assetIds ? Array.from(externalFilters.assetIds) : [],
        search: '',
    }));

    // Legacy state for backward compatibility with non-filter-bar mode
    const [activePreset, setActivePreset] = useState<string | null>(null);
    const [activeAction, setActiveAction] = useState<string | null>(null);

    // Stabilize array references to prevent infinite loops
    const stableRelatedAssetIds = useMemo(() => {
        if (assetContext?.id) return [assetContext.id];
        return undefined;
    }, [assetContext?.id]);

    const stableAssetIds = useMemo(() => {
        // When using related-asset context, skip the narrow asset_id filter
        if (assetContext?.id) return undefined;
        return filterState.assetIds;
    }, [assetContext?.id, filterState.assetIds]);

    const stableAccountIds = useMemo(() => filterState.accountIds, [filterState.accountIds]);

    // Fetch filter options (all available assets/accounts in this version)
    const { options: filterOptions, isLoading: isLoadingFilterOptions } = useFilterOptions(versionId);

    // Fetch data from server with filters (now all server-side)
    const { events, total, isLoading, isRefreshing, error } = useLotEventsQuery({
        versionId,
        lotId,
        unitId,
        eventTypes: filterState.eventTypes,
        assetIds: stableAssetIds,
        relatedAssetIds: stableRelatedAssetIds,
        accountIds: stableAccountIds,
        unitPatterns: filterState.unitPatterns,
        dateStart: filterState.dateStart,
        dateEnd: filterState.dateEnd,
        txFilterParams,
        page: enabledFeatures.pagination ? pagination.page : 1,
        limit: enabledFeatures.pagination ? pagination.pageSize : 1000,
    });

    // Update pagination total when data changes
    useEffect(() => {
        if (enabledFeatures.pagination) {
            pagination.setTotal(total);
        }
    }, [total, enabledFeatures.pagination]);

    // Client-side refinements (only search now - date range is server-side)
    const filtered = useMemo(() => {
        return events.filter(event => {
            // Search filter (client-side for instant feedback)
            if (filterState.search && enabledFeatures.search) {
                const s = filterState.search.toLowerCase();
                return (
                    String(event.lot_id).includes(s) ||
                    (event.asset?.symbol || '').toLowerCase().includes(s) ||
                    (event.account_name || '').toLowerCase().includes(s)
                );
            }

            return true;
        });
    }, [events, filterState.search, enabledFeatures.search]);

    // Data is already sorted by backend
    const displayEvents = filtered;

    // Event type counts
    const eventCounts = useMemo(() => countEventsByType(events), [events]);

    // Stats
    const stats = useMemo(() => {
        const totalQtyDelta = filtered.reduce((sum, e) => sum + e.quantity_delta, 0);
        const totalCostDelta = filtered.reduce((sum, e) => sum + (e.cost_basis_delta ?? 0), 0);
        return { totalQtyDelta, totalCostDelta };
    }, [filtered]);

    // Handler for filter bar changes
    const handleFiltersChange = useCallback((newFilters: FilterState) => {
        setFilterState(newFilters);
        // Reset to page 1 when filters change
        if (enabledFeatures.pagination) {
            pagination.setPage(1);
        }
    }, [enabledFeatures.pagination, pagination]);

    // Toggle event type visibility (for legacy/compact mode)
    const toggleEventType = (type: LotEventType) => {
        setActivePreset(null);
        setActiveAction(`toggle-${type}`);
        setFilterState(prev => ({
            ...prev,
            eventTypes: prev.eventTypes.includes(type)
                ? prev.eventTypes.filter(t => t !== type)
                : [...prev.eventTypes, type]
        }));
        setTimeout(() => setActiveAction(null), 500);
    };

    // Apply quick preset filter (for legacy/compact mode)
    const applyPreset = (presetKey: string) => {
        const preset = QUICK_PRESETS[presetKey];
        if (!preset) return;

        if (activePreset === presetKey) {
            // Deactivate preset
            setActivePreset(null);
            setFilterState(prev => ({
                ...prev,
                eventTypes: getDefaultEventTypes(),
                unitPatterns: getDefaultUnitPatterns(),
            }));
        } else {
            // Activate preset
            setActiveAction(presetKey);
            setActivePreset(presetKey);
            setFilterState(prev => ({
                ...prev,
                eventTypes: preset.eventTypes || getDefaultEventTypes(),
                unitPatterns: preset.unitPatterns || getDefaultUnitPatterns(),
            }));
            setTimeout(() => setActiveAction(null), 500);
        }
    };

    // Loading state
    if (isLoading) {
        return (
            <Box p={4}>
                <Flex
                    direction="column"
                    align="center"
                    justify="center"
                    py={12}
                    px={4}
                    minH="200px"
                >
                    <Spinner size="lg" mb={4} />
                    <Text fontSize="sm" color="gray.500">Loading cost lot events...</Text>
                </Flex>
            </Box>
        );
    }

    // Error state
    if (error) {
        return (
            <Box p={4}>
                <Flex
                    direction="column"
                    align="center"
                    justify="center"
                    py={12}
                    px={4}
                    bg="red.50"
                    borderRadius="md"
                    minH="200px"
                >
                    <Text fontSize="lg" fontWeight="medium" color="red.600" mb={2}>
                        Error Loading Events
                    </Text>
                    <Text fontSize="sm" color="gray.600" textAlign="center">
                        {error}
                    </Text>
                </Flex>
            </Box>
        );
    }

    // Empty state - still show filter bar so user can adjust filters
    if (events.length === 0) {
        const defaultTypes = getDefaultEventTypes();
        const defaultPatterns = getDefaultUnitPatterns();
        const hasActiveFilters = (
            filterState.dateStart !== '' ||
            filterState.dateEnd !== '' ||
            filterState.assetIds.length > 0 ||
            filterState.accountIds.length > 0 ||
            filterState.search !== '' ||
            filterState.eventTypes.length !== defaultTypes.length ||
            !filterState.eventTypes.every(t => defaultTypes.includes(t)) ||
            filterState.unitPatterns.length !== defaultPatterns.length ||
            !filterState.unitPatterns.every(p => defaultPatterns.includes(p))
        );

        return (
            <Box>
                {/* Filter Bar - shown even when empty so user can adjust filters */}
                {enabledFeatures.filterBar && !compact && (
                    <CostLotEventsFilterBar
                        filters={filterState}
                        onFiltersChange={handleFiltersChange}
                        eventCounts={eventCounts}
                        assets={filterOptions.assets}
                        accounts={filterOptions.accounts}
                        eventTypeOptions={filterOptions.eventTypes}
                        unitPatternOptions={filterOptions.unitPatterns}
                        isLoading={isRefreshing || isLoadingFilterOptions}
                        showDateRange={enabledFeatures.dateRangeFilter}
                        showEventTypes={enabledFeatures.eventTypeFilters}
                        showUnitPatterns={enabledFeatures.eventTypeFilters}
                        showAccountFilter={true}
                        showAssetFilter={enabledFeatures.assetFilter}
                        showSearch={enabledFeatures.search}
                        defaultCollapsed={defaultFiltersCollapsed}
                    />
                )}
                {/* Compact mode filter header */}
                {compact && enabledFeatures.eventTypeFilters && (
                    <Flex gap={2} mb={3} align="center" justify="space-between" pb={2} borderBottom="1px solid" borderColor="gray.200">
                        <Text fontSize="xs" fontWeight="semibold" color="gray.600">
                            Event Filters
                        </Text>
                        {hasActiveFilters && (
                            <Button
                                size="xs"
                                variant="ghost"
                                colorPalette="gray"
                                onClick={() => {
                                    setFilterState(prev => ({
                                        ...prev,
                                        eventTypes: getDefaultEventTypes(),
                                        unitPatterns: getDefaultUnitPatterns(),
                                    }));
                                    setActivePreset(null);
                                }}
                            >
                                <FiRefreshCw size={12} />
                                <span style={{ marginLeft: '4px' }}>Reset Filters</span>
                            </Button>
                        )}
                    </Flex>
                )}
                <Flex
                    direction="column"
                    align="center"
                    justify="center"
                    py={12}
                    px={4}
                    bg="gray.50"
                    borderRadius="md"
                    minH="200px"
                >
                    <Text fontSize="lg" fontWeight="medium" color="gray.600" mb={2}>
                        {hasActiveFilters ? 'No Events Match Filters' : 'No Cost Lot Events'}
                    </Text>
                    <Text fontSize="sm" color="gray.500" textAlign="center" mb={hasActiveFilters ? 3 : 0}>
                        {hasActiveFilters
                            ? 'No events match your current filter criteria. Try adjusting or clearing the filters.'
                            : unitId
                                ? 'No cost lot events for this unit.'
                                : 'Cost lot events will appear here after P&L calculation.'}
                    </Text>
                    {hasActiveFilters && (
                        <Button
                            size="sm"
                            colorPalette="blue"
                            variant="outline"
                            onClick={() => {
                                setFilterState({
                                    dateStart: '',
                                    dateEnd: '',
                                    eventTypes: getDefaultEventTypes(),
                                    unitPatterns: getDefaultUnitPatterns(),
                                    accountIds: [],
                                    assetIds: [],
                                    search: '',
                                });
                                setActivePreset(null);
                            }}
                        >
                            <FiRefreshCw />
                            <span style={{ marginLeft: '6px' }}>Clear All Filters</span>
                        </Button>
                    )}
                </Flex>
            </Box>
        );
    }

    return (
        <Box>
            {/* New Collapsible Filter Bar - shown in AUDIT mode */}
            {enabledFeatures.filterBar && !compact && (
                <CostLotEventsFilterBar
                    filters={filterState}
                    onFiltersChange={handleFiltersChange}
                    eventCounts={eventCounts}
                    assets={filterOptions.assets}
                    accounts={filterOptions.accounts}
                    eventTypeOptions={filterOptions.eventTypes}
                    unitPatternOptions={filterOptions.unitPatterns}
                    isLoading={isRefreshing || isLoadingFilterOptions}
                    showDateRange={enabledFeatures.dateRangeFilter}
                    showEventTypes={enabledFeatures.eventTypeFilters}
                    showUnitPatterns={enabledFeatures.eventTypeFilters}
                    showAccountFilter={true}
                    showAssetFilter={enabledFeatures.assetFilter}
                    showSearch={enabledFeatures.search}
                    defaultCollapsed={defaultFiltersCollapsed}
                />
            )}

            {/* Compact mode filters - for unit detail expanded rows */}
            {compact && enabledFeatures.eventTypeFilters && (
                <>
                    {/* Filter Header with Count Badge and Reset */}
                    <Flex gap={2} mb={3} align="center" justify="space-between" pb={2} borderBottom="1px solid" borderColor="gray.200">
                        <Flex gap={2} align="center">
                            <Text fontSize="xs" fontWeight="semibold" color="gray.600">
                                Event Filters
                            </Text>
                            {(() => {
                                const defaultTypes = getDefaultEventTypes();
                                const activeFilterCount = (
                                    (filterState.eventTypes.length !== defaultTypes.length || !filterState.eventTypes.every(t => defaultTypes.includes(t)) ? 1 : 0) +
                                    (filterState.unitPatterns.length !== getDefaultUnitPatterns().length ? 1 : 0)
                                );
                                return activeFilterCount > 0 ? (
                                    <Badge size="xs" colorPalette="blue">
                                        {activeFilterCount} active
                                    </Badge>
                                ) : null;
                            })()}
                        </Flex>
                        {(() => {
                            const defaultTypes = getDefaultEventTypes();
                            const hasActiveFilters = (
                                filterState.eventTypes.length !== defaultTypes.length ||
                                !filterState.eventTypes.every(t => defaultTypes.includes(t)) ||
                                filterState.unitPatterns.length !== getDefaultUnitPatterns().length
                            );
                            return hasActiveFilters ? (
                                <Button
                                    size="xs"
                                    variant="ghost"
                                    colorPalette="gray"
                                    onClick={() => {
                                        setFilterState(prev => ({
                                            ...prev,
                                            eventTypes: getDefaultEventTypes(),
                                            unitPatterns: getDefaultUnitPatterns(),
                                        }));
                                        setActivePreset(null);
                                    }}
                                    disabled={isRefreshing}
                                >
                                    <FiRefreshCw size={12} />
                                    <span style={{ marginLeft: '4px' }}>Reset</span>
                                </Button>
                            ) : null;
                        })()}
                    </Flex>

                    {/* Event Type Filter Buttons */}
                    <Flex gap={1} mb={3} wrap="wrap" position="relative">
                        {isRefreshing && (
                            <Box
                                position="absolute"
                                top={0}
                                left={0}
                                right={0}
                                bottom={0}
                                bg="white"
                                opacity={0.7}
                                borderRadius="md"
                                zIndex={1}
                                display="flex"
                                alignItems="center"
                                justifyContent="center"
                            >
                                <Spinner size="sm" />
                            </Box>
                        )}
                        {getSortedEventTypes().map(type => {
                            const cfg = EVENT_TYPE_CONFIG[type];
                            const count = eventCounts[type];
                            if (count === 0) return null;

                            return (
                                <Button
                                    key={type}
                                    size="xs"
                                    variant={filterState.eventTypes.includes(type) ? 'solid' : 'outline'}
                                    colorPalette={cfg.color}
                                    onClick={() => toggleEventType(type)}
                                    disabled={isRefreshing}
                                >
                                    {cfg.icon} {cfg.label} ({count})
                                </Button>
                            );
                        })}
                    </Flex>
                </>
            )}

            {/* Event Legend for compact mode */}
            {compact && enabledFeatures.eventLegend && (
                <Flex justify="flex-end" mb={2}>
                    <EventLegendTooltip />
                </Flex>
            )}

            {/* Summary Stats */}
            {!compact && (
                <Flex gap={4} mb={3} fontSize="sm" color="gray.600" wrap="wrap">
                    <Text>
                        Showing: <Text as="span" fontWeight="bold">{filtered.length}</Text> of {total} events
                    </Text>
                </Flex>
            )}

            {/* Table */}
            <Box position="relative">
                {isRefreshing && (
                    <Flex
                        position="absolute"
                        inset={0}
                        bg="whiteAlpha.800"
                        zIndex={10}
                        align="center"
                        justify="center"
                        direction="column"
                        gap={2}
                    >
                        <Spinner size="md" />
                        <Text fontSize="sm" color="gray.600">Applying filter...</Text>
                    </Flex>
                )}
                <Box
                    overflowX="auto"
                    style={{ fontSize: compact ? '8px' : '9px' }}
                    maxH={maxHeight}
                    overflowY={maxHeight ? 'auto' : undefined}
                    opacity={isRefreshing ? 0.5 : 1}
                    transition="opacity 0.2s"
                >
                    <Table.Root size="sm">
                        <Table.Header>
                            <Table.Row>
                                <Table.ColumnHeader width="50px">ID</Table.ColumnHeader>
                                <Table.ColumnHeader width="60px">Type</Table.ColumnHeader>
                                {columns.timestamp && <Table.ColumnHeader>Timestamp</Table.ColumnHeader>}
                                {columns.asset && <Table.ColumnHeader>Asset</Table.ColumnHeader>}
                                {columns.account && <Table.ColumnHeader>Account</Table.ColumnHeader>}
                                {columns.quantityDelta && <Table.ColumnHeader textAlign="right">Qty Δ</Table.ColumnHeader>}
                                {columns.costDelta && <Table.ColumnHeader textAlign="right">Cost Δ</Table.ColumnHeader>}
                                {columns.accountBalance && <Table.ColumnHeader textAlign="right">Acct Balance</Table.ColumnHeader>}
                                {columns.assetBalance && <Table.ColumnHeader textAlign="right" pr={6}>Asset Balance</Table.ColumnHeader>}
                                {columns.unit && <Table.ColumnHeader pl={4}>Unit</Table.ColumnHeader>}
                                {columns.triggeredBy && <Table.ColumnHeader>Triggered By</Table.ColumnHeader>}
                                {columns.chain && <Table.ColumnHeader textAlign="center" width="40px">Chain</Table.ColumnHeader>}
                            </Table.Row>
                        </Table.Header>
                        <Table.Body>
                            {displayEvents.map((event, index) => {
                                const cfg = getEventConfig(event.event_type);
                                const prevEvent = index > 0 ? displayEvents[index - 1] : null;

                                return (
                                    <Table.Row key={event.event_id} bg={cfg.bgColor}>
                                        <Table.Cell>
                                            <Text fontSize="2xs" color="gray.400" fontFamily="mono">#{event.event_id}</Text>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Tooltip content={cfg.description}>
                                                <Badge size="xs" colorPalette={cfg.color}>
                                                    {cfg.icon}
                                                </Badge>
                                            </Tooltip>
                                        </Table.Cell>

                                        {columns.timestamp && (
                                            <Table.Cell fontSize="2xs">
                                                {compact ? formatCompactDateTime(event.timestamp) : formatDateTimeLocale(event.timestamp)}
                                            </Table.Cell>
                                        )}

                                        {columns.asset && (
                                            <Table.Cell>
                                                <Badge size="xs">{event.asset?.symbol || '?'}</Badge>
                                            </Table.Cell>
                                        )}

                                        {columns.account && (
                                            <Table.Cell fontSize="2xs">
                                                {event.account_name || '—'}
                                            </Table.Cell>
                                        )}

                                        {columns.quantityDelta && (
                                            <Table.Cell textAlign="right" fontFamily="mono" fontSize="2xs">
                                                <Text color={event.quantity_delta >= 0 ? 'green.600' : 'red.600'}>
                                                    {event.quantity_delta >= 0 ? '+' : ''}{formatSmartNumber(event.quantity_delta)}
                                                </Text>
                                            </Table.Cell>
                                        )}

                                        {columns.costDelta && (
                                            <Table.Cell textAlign="right" fontSize="2xs">
                                                {event.cost_basis_delta != null ? (
                                                    (event.event_type === 'created' || event.event_type === 'created-negative') && event.cost_source && (event.cost_source === 'fmv' || event.cost_source === 'provisional') ? (
                                                        <FmvBadge
                                                            value={event.cost_basis_delta}
                                                            baseCurrency={baseCurrency}
                                                            source={event.cost_source}
                                                            price={event.cost_fmv_price}
                                                            priceSource={event.cost_fmv_source}
                                                            timestamp={event.cost_fmv_timestamp}
                                                            stale={event.cost_fmv_stale}
                                                        />
                                                    ) : (
                                                        <Text color={event.cost_basis_delta >= 0 ? 'green.600' : 'red.600'}>
                                                            {event.cost_basis_delta >= 0 ? '+' : ''}{formatSmartNumber(event.cost_basis_delta)}
                                                        </Text>
                                                    )
                                                ) : '—'}
                                            </Table.Cell>
                                        )}

                                        {columns.accountBalance && (
                                            <Table.Cell textAlign="right" fontFamily="mono" fontSize="2xs">
                                                <Tooltip content="Balance for this account after event">
                                                    <Text
                                                        color={
                                                            event.account_balance_after == null ? 'gray.400' :
                                                                prevEvent?.account_balance_after == null ? 'gray.600' :
                                                                    event.account_balance_after > prevEvent.account_balance_after ? 'green.600' :
                                                                        event.account_balance_after < prevEvent.account_balance_after ? 'red.600' : 'gray.600'
                                                        }
                                                    >
                                                        {event.account_balance_after != null ? (
                                                            <>
                                                                {prevEvent?.account_balance_after != null &&
                                                                    event.account_balance_after > prevEvent.account_balance_after && '↑ '}
                                                                {prevEvent?.account_balance_after != null &&
                                                                    event.account_balance_after < prevEvent.account_balance_after && '↓ '}
                                                                {formatSmartNumber(event.account_balance_after)}
                                                            </>
                                                        ) : '—'}
                                                    </Text>
                                                </Tooltip>
                                            </Table.Cell>
                                        )}

                                        {columns.assetBalance && (
                                            <Table.Cell textAlign="right" fontFamily="mono" fontSize="2xs" pr={6}>
                                                <Tooltip content="Total asset balance across all accounts after event">
                                                    <Text
                                                        fontWeight="medium"
                                                        color={
                                                            event.balance_after == null ? 'gray.400' :
                                                                prevEvent?.balance_after == null ? 'gray.600' :
                                                                    event.balance_after > prevEvent.balance_after ? 'green.600' :
                                                                        event.balance_after < prevEvent.balance_after ? 'red.600' : 'gray.600'
                                                        }
                                                    >
                                                        {event.balance_after != null ? (
                                                            <>
                                                                {prevEvent?.balance_after != null &&
                                                                    event.balance_after > prevEvent.balance_after && '↑ '}
                                                                {prevEvent?.balance_after != null &&
                                                                    event.balance_after < prevEvent.balance_after && '↓ '}
                                                                {formatSmartNumber(event.balance_after)}
                                                            </>
                                                        ) : '—'}
                                                    </Text>
                                                </Tooltip>
                                            </Table.Cell>
                                        )}

                                        {columns.unit && (
                                            <Table.Cell fontSize="2xs" fontFamily="mono" pl={4}>
                                                {event.triggered_by_unit_id && event.triggered_by_unit_pattern ? (
                                                    <Flex gap={1} align="center">
                                                        <Tooltip content={event.triggered_by_unit_pattern}>
                                                            <Badge size="xs" colorPalette={getPatternColor(event.triggered_by_unit_pattern)}>
                                                                {event.triggered_by_unit_pattern === 'internal_transfer' ? '⇄' :
                                                                    event.triggered_by_unit_pattern === 'unmatched_internal_transfer' ? '⇄?' :
                                                                        event.triggered_by_unit_pattern === 'swap' ? '⇋' :
                                                                            event.triggered_by_unit_pattern === 'flow' ? '→' :
                                                                                event.triggered_by_unit_pattern === 'split' ? '✂' :
                                                                                    event.triggered_by_unit_pattern.charAt(0).toUpperCase()}
                                                            </Badge>
                                                        </Tooltip>
                                                        <Text
                                                            as="span"
                                                            color={onUnitClick ? 'blue.500' : 'gray.500'}
                                                            fontSize="9px"
                                                            cursor={onUnitClick ? 'pointer' : undefined}
                                                            _hover={onUnitClick ? { textDecoration: 'underline' } : undefined}
                                                            onClick={() => onUnitClick?.(event.triggered_by_unit_id!)}
                                                        >
                                                            #{event.triggered_by_unit_id}
                                                        </Text>
                                                    </Flex>
                                                ) : (
                                                    <span style={{ color: 'var(--chakra-colors-gray-400)' }}>—</span>
                                                )}
                                            </Table.Cell>
                                        )}

                                        {columns.triggeredBy && (
                                            <Table.Cell fontSize="2xs">
                                                {event.triggered_by_transaction_id ? (
                                                    <TransactionTooltip
                                                        txId={event.triggered_by_transaction_id}
                                                        baseCurrency={baseCurrency}
                                                        onTransactionClick={onTransactionClick}
                                                    >
                                                        <Button
                                                            size="xs"
                                                            variant="ghost"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                onTransactionClick?.(event.triggered_by_transaction_id!);
                                                            }}
                                                        >
                                                            #{event.triggered_by_transaction_id}
                                                        </Button>
                                                    </TransactionTooltip>
                                                ) : (
                                                    <span style={{ color: 'var(--chakra-colors-gray-400)' }}>—</span>
                                                )}
                                            </Table.Cell>
                                        )}

                                        {columns.chain && (
                                            <Table.Cell textAlign="center">
                                                <CostBasisChainTooltip
                                                    eventId={event.event_id}
                                                    versionId={versionId}
                                                    baseCurrency={baseCurrency}
                                                    onTransactionClick={onTransactionClick}
                                                >
                                                    <Text fontSize="2xs" color="blue.400" cursor="help" _hover={{ textDecoration: 'underline' }}>🔗</Text>
                                                </CostBasisChainTooltip>
                                            </Table.Cell>
                                        )}
                                    </Table.Row>
                                );
                            })}
                        </Table.Body>
                    </Table.Root>
                </Box>
            </Box>

            {/* Pagination */}
            {!hidePagination && enabledFeatures.pagination && total > 0 && (() => {
                const PAGE_SIZE_OPTIONS = [25, 50, 100];
                const pageCount = Math.max(1, Math.ceil(total / pagination.pageSize));
                const safePage = pagination.page;
                return (
                    <Flex justify="space-between" align="center" width="100%" py={2} px={3}>
                        <Flex align="center" gap={2}>
                            <Text fontSize="2xs" color="gray.500">Rows:</Text>
                            <Flex borderRadius="md" border="1px solid" borderColor="gray.200" overflow="hidden" display="inline-flex">
                                {PAGE_SIZE_OPTIONS.map(size => (
                                    <Button key={size} size="2xs"
                                        variant={pagination.pageSize === size ? 'subtle' : 'ghost'}
                                        colorPalette={pagination.pageSize === size ? 'blue' : 'gray'}
                                        borderRadius="0"
                                        onClick={() => { pagination.setPageSize(size); pagination.setPage(1); }}
                                        px={2} fontSize="xs">
                                        {size}
                                    </Button>
                                ))}
                            </Flex>
                        </Flex>
                        <Text fontSize="2xs" color="gray.500">
                            {(safePage - 1) * pagination.pageSize + 1}–{Math.min(safePage * pagination.pageSize, total)} of {total}
                        </Text>
                        <Flex align="center" gap={1}>
                            <Button size="2xs" variant="ghost" onClick={() => pagination.setPage(1)} disabled={safePage <= 1} px={1}>
                                <FiChevronsLeft size={12} />
                            </Button>
                            <Button size="2xs" variant="ghost" onClick={() => pagination.setPage(safePage - 1)} disabled={safePage <= 1} px={1}>
                                <FiChevronLeft size={14} />
                            </Button>
                            <Text fontSize="xs" color="gray.600" mx={1}>{safePage} / {pageCount}</Text>
                            <Button size="2xs" variant="ghost" onClick={() => pagination.setPage(safePage + 1)} disabled={safePage >= pageCount} px={1}>
                                <FiChevronRight size={14} />
                            </Button>
                            <Button size="2xs" variant="ghost" onClick={() => pagination.setPage(pageCount)} disabled={safePage >= pageCount} px={1}>
                                <FiChevronsRight size={12} />
                            </Button>
                        </Flex>
                    </Flex>
                );
            })()}
        </Box>
    );
};

// ============================================================================
// Configuration Presets - For Consistent Usage Across App
// ============================================================================

export const EVENT_TABLE_PRESETS = {
    /** Full-featured configuration for P&L Audit and Asset Detail views */
    AUDIT: {
        showColumns: {
            timestamp: true,
            asset: true,
            account: true,
            unit: true,
            quantityDelta: true,
            costDelta: true,
            accountBalance: true,
            assetBalance: true,
            triggeredBy: true,
        },
        features: {
            pagination: true,
            search: true,
            eventTypeFilters: true,
            assetFilter: true,
            dateRangeFilter: true,
            eventLegend: true,
        },
    },
    /** Asset Detail view - same as AUDIT but no asset filter (already filtered by asset) */
    ASSET_DETAIL: {
        showColumns: {
            timestamp: true,
            asset: false,  // Not needed since we're in asset detail view
            account: true,
            unit: true,
            quantityDelta: true,
            costDelta: true,
            accountBalance: true,
            assetBalance: true,
            triggeredBy: true,
        },
        features: {
            pagination: true,
            search: true,
            eventTypeFilters: true,
            assetFilter: false,  // No need - already filtered by asset
            dateRangeFilter: true,
            eventLegend: true,
        },
    },
    /** Unit Detail expanded row - with quick event type filters, show all events with balances */
    UNIT_DETAIL: {
        showColumns: {
            timestamp: true,
            asset: true,
            account: true,
            unit: false,  // Already in unit context
            quantityDelta: true,
            costDelta: true,
            accountBalance: true,
            assetBalance: true,
            triggeredBy: false,  // Already in unit context
        },
        features: {
            pagination: false,  // Show all
            search: false,
            eventTypeFilters: true,  // Enable quick event type filters
            assetFilter: false,
            dateRangeFilter: false,
            eventLegend: true,  // Show legend for reference
        },
        compact: true,
    },
    /** Compact configuration for legacy uses - deprecated, use UNIT_DETAIL instead */
    COMPACT: {
        showColumns: {
            timestamp: true,
            asset: true,
            account: true,
            unit: false,
            quantityDelta: true,
            costDelta: true,
            accountBalance: false,
            assetBalance: false,
            triggeredBy: false,
        },
        features: {
            pagination: false,
            search: false,
            eventTypeFilters: true,  // Allow toggling event types
            assetFilter: false,
            dateRangeFilter: false,
            eventLegend: true,  // Keep help icon
        },
        compact: true,
    },
} as const;
