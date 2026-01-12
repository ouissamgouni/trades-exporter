/**
 * useLazyPaginatedQuery Hook
 * 
 * Generic hook for lazy loading paginated data from the API.
 * Handles:
 * - Lazy loading (only fetches when enabled)
 * - Pagination (page, limit, total)
 * - Loading/refreshing states
 * - Error handling
 * - Stable array dependencies (prevents infinite loops)
 * - Initial load guard to prevent duplicate fetches
 * 
 * @example
 * const { data, total, isLoading, error, refetch } = useLazyPaginatedQuery<CostLot>({
 *     endpoint: `/pnl/versions/${versionId}/lots`,
 *     page: 1,
 *     limit: 50,
 *     lazy: true,
 *     enabled: isTabActive,
 * });
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { API_URL } from '../types';

export interface UseLazyPaginatedQueryParams {
    /** API endpoint path (without API_URL prefix) */
    endpoint: string;
    /** Current page number (1-indexed) */
    page: number;
    /** Items per page */
    limit: number;
    /** Additional query parameters */
    params?: Record<string, string | number | boolean | undefined>;
    /** If true, defer data fetching until enabled is set to true */
    lazy?: boolean;
    /** Controls when lazy fetching begins (only used when lazy=true) */
    enabled?: boolean;
    /** Callback when data is loaded (for updating external state) */
    onDataLoaded?: (data: { items: unknown[]; total: number }) => void;
}

export interface UseLazyPaginatedQueryResult<T> {
    /** The fetched data items */
    data: T[];
    /** Total number of items (for pagination) */
    total: number;
    /** True during initial load */
    isLoading: boolean;
    /** True during subsequent fetches (refetch/page change) */
    isRefreshing: boolean;
    /** Error message if fetch failed */
    error: string | null;
    /** Manually trigger a refetch */
    refetch: () => void;
    /** True if initial fetch has completed */
    hasLoaded: boolean;
}

/**
 * Serialize params to a stable string key for dependency comparison.
 * This prevents infinite loops when params object contains arrays.
 */
function serializeParams(params: Record<string, unknown> | undefined): string {
    if (!params) return '';
    const sorted = Object.keys(params)
        .sort()
        .map(key => `${key}=${JSON.stringify(params[key])}`)
        .join('&');
    return sorted;
}

export function useLazyPaginatedQuery<T>(
    params: UseLazyPaginatedQueryParams
): UseLazyPaginatedQueryResult<T> {
    const {
        endpoint,
        page,
        limit,
        params: queryParams,
        lazy = false,
        enabled = true,
        onDataLoaded,
    } = params;

    const [data, setData] = useState<T[]>([]);
    const [total, setTotal] = useState(0);
    // Start with loading=false when lazy mode is enabled but not yet activated
    const [isLoading, setIsLoading] = useState(!lazy || enabled);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [hasLoaded, setHasLoaded] = useState(false);

    // Guard against duplicate initial fetches
    const fetchingRef = useRef(false);
    const initialFetchDoneRef = useRef(false);
    // Track if we've been enabled before (for lazy mode)
    const wasEnabledRef = useRef(!lazy || enabled);

    // Serialize params for stable dependency comparison
    const paramsKey = serializeParams(queryParams);

    const fetchData = useCallback(async (isInitial = false) => {
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
            // Build query string
            const searchParams = new URLSearchParams();
            searchParams.append('page', page.toString());
            searchParams.append('limit', limit.toString());

            if (queryParams) {
                Object.entries(queryParams).forEach(([key, value]) => {
                    if (value !== undefined && value !== null && value !== '') {
                        searchParams.append(key, String(value));
                    }
                });
            }

            const url = `${API_URL}${endpoint}?${searchParams.toString()}`;
            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(`Failed to fetch: ${response.statusText}`);
            }

            const result = await response.json();

            // Handle both { items, total } and { fees, total } response shapes
            const items = result.items ?? result.fees ?? [];
            const totalCount = result.total ?? items.length;

            setData(items);
            setTotal(totalCount);
            setHasLoaded(true);
            initialFetchDoneRef.current = true;

            onDataLoaded?.({ items, total: totalCount });
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            setError(message);
            console.error(`Error fetching ${endpoint}:`, err);
        } finally {
            setIsLoading(false);
            setIsRefreshing(false);
            fetchingRef.current = false;
        }
    }, [endpoint, page, limit, paramsKey, onDataLoaded]);

    // Reset state when endpoint changes
    useEffect(() => {
        initialFetchDoneRef.current = false;
        wasEnabledRef.current = false;
        setHasLoaded(false);
        setData([]);
        setTotal(0);
    }, [endpoint]);

    // Fetch on mount and when dependencies change
    // If lazy is enabled, wait for enabled flag
    useEffect(() => {
        // Skip if lazy mode and not enabled
        if (lazy && !enabled) return;

        // Detect transition from disabled to enabled (tab becoming active)
        const justBecameEnabled = lazy && enabled && !wasEnabledRef.current;
        if (justBecameEnabled) {
            wasEnabledRef.current = true;
            // Reset fetch guard to allow new fetch
            initialFetchDoneRef.current = false;
        }

        // Trigger fetch
        if (!initialFetchDoneRef.current) {
            setIsLoading(true);
            fetchData(true);
        } else {
            // For subsequent changes (page, params), refetch
            fetchData(false);
        }
    }, [fetchData, lazy, enabled, page, limit, paramsKey]);

    const refetch = useCallback(() => {
        fetchData(false);
    }, [fetchData]);

    return {
        data,
        total,
        isLoading,
        isRefreshing,
        error,
        refetch,
        hasLoaded,
    };
}

export default useLazyPaginatedQuery;
