/**
 * usePagination Hook
 * 
 * Unified pagination state management with:
 * - Page and page size state
 * - localStorage persistence for page size
 * - Automatic page reset when page size changes
 * - Server-side and client-side pagination support
 * 
 * @example
 * // Server-side pagination
 * const pagination = usePagination({
 *   storageKey: 'transactions',
 *   onPageChange: (page, pageSize) => fetchData(page, pageSize),
 * });
 * 
 * // Client-side pagination
 * const pagination = usePagination({ storageKey: 'items' });
 * const paginatedItems = pagination.paginate(allItems);
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';

// Unified page size options across the app
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 200] as const;
export type PageSizeOption = typeof PAGE_SIZE_OPTIONS[number];

export const DEFAULT_PAGE_SIZE: PageSizeOption = 50;

// localStorage key prefix for page size persistence
const STORAGE_KEY_PREFIX = 'pagination_page_size_';

/**
 * Get persisted page size from localStorage
 */
export const getPersistedPageSize = (storageKey: string): number => {
    try {
        const stored = localStorage.getItem(`${STORAGE_KEY_PREFIX}${storageKey}`);
        if (stored) {
            const parsed = parseInt(stored, 10);
            if ((PAGE_SIZE_OPTIONS as readonly number[]).includes(parsed)) {
                return parsed;
            }
        }
    } catch {
        // localStorage not available
    }
    return DEFAULT_PAGE_SIZE;
};

/**
 * Persist page size to localStorage
 */
const persistPageSize = (storageKey: string, size: number): void => {
    try {
        localStorage.setItem(`${STORAGE_KEY_PREFIX}${storageKey}`, String(size));
    } catch {
        // localStorage not available
    }
};

export interface UsePaginationOptions {
    /** Storage key for localStorage persistence (e.g., 'transactions', 'pnl_units') */
    storageKey?: string;
    /** Initial page (1-indexed) */
    initialPage?: number;
    /** Initial page size (defaults to persisted value or DEFAULT_PAGE_SIZE) */
    initialPageSize?: PageSizeOption;
    /** Total number of items (for calculating total pages) */
    totalItems?: number;
    /** Callback when page or page size changes - use for server-side pagination */
    onPageChange?: (page: number, pageSize: number) => void;
    /** Whether to reset to page 1 when page size changes (default: true) */
    resetOnPageSizeChange?: boolean;
}

export interface PaginationState {
    /** Current page (1-indexed) */
    page: number;
    /** Items per page */
    pageSize: number;
    /** Total number of items */
    total: number;
    /** Total number of pages */
    totalPages: number;
    /** Index of first item on current page (0-indexed) */
    startIndex: number;
    /** Index of last item on current page (exclusive, 0-indexed) */
    endIndex: number;
    /** First item number on current page (1-indexed, for display) */
    startItem: number;
    /** Last item number on current page (1-indexed, for display) */
    endItem: number;
    /** Whether there's a previous page */
    hasPrevPage: boolean;
    /** Whether there's a next page */
    hasNextPage: boolean;
}

export interface UsePaginationReturn extends PaginationState {
    /** Set the current page */
    setPage: (page: number) => void;
    /** Set the page size (automatically resets to page 1 unless resetOnPageSizeChange is false) */
    setPageSize: (size: number) => void;
    /** Go to next page */
    nextPage: () => void;
    /** Go to previous page */
    prevPage: () => void;
    /** Go to first page */
    firstPage: () => void;
    /** Go to last page */
    lastPage: () => void;
    /** Set total items count (for server-side pagination) */
    setTotal: (total: number) => void;
    /** Paginate an array of items (for client-side pagination) */
    paginate: <T>(items: T[]) => T[];
    /** Reset pagination state */
    reset: () => void;
    /** Get pagination params for API calls */
    getApiParams: () => { page: number; limit: number };
}

export function usePagination(options: UsePaginationOptions = {}): UsePaginationReturn {
    const {
        storageKey,
        initialPage = 1,
        initialPageSize,
        totalItems: externalTotal,
        onPageChange,
        resetOnPageSizeChange = true,
    } = options;

    // Determine initial page size from storage or prop
    const resolvedInitialPageSize = useMemo(() => {
        if (initialPageSize !== undefined) return initialPageSize;
        if (storageKey) return getPersistedPageSize(storageKey);
        return DEFAULT_PAGE_SIZE;
    }, [initialPageSize, storageKey]);

    const [page, setPageState] = useState(initialPage);
    const [pageSize, setPageSizeState] = useState<number>(resolvedInitialPageSize);
    const [internalTotal, setInternalTotal] = useState(externalTotal ?? 0);

    // Track last known items length from paginate() for client-side pagination
    const lastItemsLengthRef = useRef(0);

    // Use external total if provided, otherwise use internal (or ref for client-side)
    const total = externalTotal ?? (internalTotal > 0 ? internalTotal : lastItemsLengthRef.current);

    // Derived state
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const startIndex = (page - 1) * pageSize;
    const endIndex = Math.min(startIndex + pageSize, total);
    const startItem = total === 0 ? 0 : startIndex + 1;
    const endItem = endIndex;
    const hasPrevPage = page > 1;
    const hasNextPage = page < totalPages;

    // Persist page size to localStorage when it changes
    useEffect(() => {
        if (storageKey) {
            persistPageSize(storageKey, pageSize);
        }
    }, [pageSize, storageKey]);

    // Adjust page if it exceeds total pages (e.g., after total changes)
    useEffect(() => {
        if (page > totalPages && totalPages > 0) {
            setPageState(totalPages);
        }
    }, [page, totalPages]);

    const setPage = useCallback((newPage: number) => {
        // For client-side pagination where total isn't externally set,
        // don't clamp - let the component handle bounds via paginate()
        const clampedPage = total > 0
            ? Math.max(1, Math.min(newPage, totalPages))
            : Math.max(1, newPage);
        console.log('[usePagination] setPage:', newPage, 'total:', total, 'totalPages:', totalPages, 'clamped:', clampedPage);
        setPageState(clampedPage);
        onPageChange?.(clampedPage, pageSize);
    }, [total, totalPages, pageSize, onPageChange]);

    const setPageSize = useCallback((newSize: number) => {
        setPageSizeState(newSize);
        if (resetOnPageSizeChange) {
            setPageState(1);
            onPageChange?.(1, newSize);
        } else {
            onPageChange?.(page, newSize);
        }
    }, [resetOnPageSizeChange, page, onPageChange]);

    const nextPage = useCallback(() => {
        if (hasNextPage) setPage(page + 1);
    }, [hasNextPage, page, setPage]);

    const prevPage = useCallback(() => {
        if (hasPrevPage) setPage(page - 1);
    }, [hasPrevPage, page, setPage]);

    const firstPage = useCallback(() => {
        setPage(1);
    }, [setPage]);

    const lastPage = useCallback(() => {
        setPage(totalPages);
    }, [setPage, totalPages]);

    const setTotal = useCallback((newTotal: number) => {
        setInternalTotal(newTotal);
    }, []);

    const paginate = useCallback(<T,>(items: T[]): T[] => {
        // For client-side pagination, calculate indices from items length
        const itemsTotal = items.length;
        // Track items length for totalPages calculation
        lastItemsLengthRef.current = itemsTotal;
        const start = (page - 1) * pageSize;
        const end = Math.min(start + pageSize, itemsTotal);
        return items.slice(start, end);
    }, [page, pageSize]);

    const reset = useCallback(() => {
        setPageState(1);
        setInternalTotal(0);
        lastItemsLengthRef.current = 0;
    }, []);

    const getApiParams = useCallback(() => ({
        page,
        limit: pageSize,
    }), [page, pageSize]);

    return {
        // State
        page,
        pageSize,
        total,
        totalPages,
        startIndex,
        endIndex,
        startItem,
        endItem,
        hasPrevPage,
        hasNextPage,
        // Actions
        setPage,
        setPageSize,
        nextPage,
        prevPage,
        firstPage,
        lastPage,
        setTotal,
        paginate,
        reset,
        getApiParams,
    };
}

export default usePagination;
