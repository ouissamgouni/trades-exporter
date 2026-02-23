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
