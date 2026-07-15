/**
 * Hooks index
 * 
 * Central export point for all custom hooks
 */

export {
    usePagination,
    getPersistedPageSize,
    PAGE_SIZE_OPTIONS,
    DEFAULT_PAGE_SIZE,
    type UsePaginationOptions,
    type UsePaginationReturn,
    type PaginationState,
    type PageSizeOption,
} from './usePagination';

export {
    useLazyPaginatedQuery,
    type UseLazyPaginatedQueryParams,
    type UseLazyPaginatedQueryResult,
} from './useLazyPaginatedQuery';

export {
    useBundleSuggestionMap,
    type SuggestionEntry,
    type UseBundleSuggestionMapReturn,
} from './useBundleSuggestionMap';

export {
    useBundleColorMap,
    type UseBundleColorMapReturn,
} from './useBundleColorMap';

export {
    useBalance,
    type UseBalanceReturn,
} from './useBalance';

export {
    useAccountSuggestions,
    fetchAccountSuggestionsBatch,
    type AccountSuggestion,
    type BatchSuggestionItem,
    type BatchSuggestionResult,
} from './useAccountSuggestions';

export {
    useEntityColors,
    ENTITY_COLOR_PALETTE,
    DEFAULT_ENTITY_COLOR,
    getNextAvailableEntityColor,
    hexToRgba,
    type EntityColor,
    type UseEntityColorsReturn,
} from './useEntityColors';

export {
    useSyncConfigStore,
    type UseSyncConfigStoreReturn,
} from './useSyncConfigStore';

export {
    useAssets,
    ASSETS_QUERY_KEY,
    type UseAssetsReturn,
} from './useAssets';

export {
    usePnLCalculationStatus,
    type UsePnLCalculationStatusOptions,
    type UsePnLCalculationStatusReturn,
} from './usePnLCalculationStatus';

export {
    usePriceHealth,
    usePriceTimeseries,
    PRICE_HEALTH_QUERY_KEY,
    PRICE_TIMESERIES_QUERY_KEY,
    type UsePriceHealthReturn,
    type UsePriceTimeseriesReturn,
} from './usePriceHealth';
