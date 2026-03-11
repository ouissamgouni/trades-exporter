/**
 * useUrlFilterSync – bidirectional sync between TransactionFilterState and URL search params.
 *
 * On mount: reads URL → populates initial filter state + viewMode.
 * On change: writes filter state + viewMode → URL via history.replaceState.
 *
 * Param encoding:
 *   - Array fields (accountIds, assetIds, …): comma-separated, snake_case key
 *   - Dates: ISO strings (date_from, date_to)
 *   - Booleans: "true"/"false"
 *   - viewMode: "portfolio" | "audit" (defaults to "portfolio")
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    type TransactionFilterState,
    defaultFilterState,
} from '../components/TransactionFilters';

type ViewMode = 'portfolio' | 'charts' | 'audit';

/** Map of URL param name → TransactionFilterState array field */
const ARRAY_PARAM_MAP: Record<string, keyof TransactionFilterState> = {
    source: 'sources',
    account_id: 'accountIds',
    from_account_id: 'fromAccountIds',
    to_account_id: 'toAccountIds',
    related_account_id: 'relatedAccountIds',
    asset_id: 'assetIds',
    related_asset_id: 'relatedAssetIds',
    category_id: 'categoryIds',
    transaction_type: 'transactionTypes',
    direction: 'directions',
    connector_run_id: 'connectorRunIds',
    tag_key: 'tagKeys',
    network: 'networks',
};

/** Read TransactionFilterState + viewMode from current URL search params. */
function readFromUrl(): { filters: TransactionFilterState; viewMode: ViewMode } {
    const params = new URLSearchParams(window.location.search);
    const filters: TransactionFilterState = {
        ...defaultFilterState,
        // PnL context: don't pre-filter by reviewStatus or taxability
        reviewStatus: [],
        taxability: [],
    };

    // Array fields
    for (const [paramName, stateKey] of Object.entries(ARRAY_PARAM_MAP)) {
        const raw = params.get(paramName);
        if (raw) {
            (filters as any)[stateKey] = raw.split(',').filter(Boolean);
        }
    }

    // Date fields
    const dateFrom = params.get('date_from');
    const dateTo = params.get('date_to');
    if (dateFrom) filters.dateFrom = dateFrom;
    if (dateTo) filters.dateTo = dateTo;

    // Boolean fields
    if (params.get('non_owned') === 'true') filters.nonOwned = true;

    // View mode
    const vm = params.get('view');
    const viewMode: ViewMode = vm === 'audit' ? 'audit' : vm === 'charts' ? 'charts' : 'portfolio';

    return { filters, viewMode };
}

/** Write TransactionFilterState + viewMode to URL search params (replaceState). */
function writeToUrl(filters: TransactionFilterState, viewMode: ViewMode): void {
    const params = new URLSearchParams();

    // Array fields
    for (const [paramName, stateKey] of Object.entries(ARRAY_PARAM_MAP)) {
        const arr = (filters as any)[stateKey] as string[];
        if (arr && arr.length > 0) {
            params.set(paramName, arr.join(','));
        }
    }

    // Date fields
    if (filters.dateFrom) params.set('date_from', filters.dateFrom);
    if (filters.dateTo) params.set('date_to', filters.dateTo);

    // Boolean
    if (filters.nonOwned) params.set('non_owned', 'true');

    // View mode (only write if not default)
    if (viewMode !== 'portfolio') params.set('view', viewMode);

    const qs = params.toString();
    const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState({}, '', newUrl);
}

interface UseUrlFilterSyncReturn {
    /** Current filter state (always in sync with URL). */
    filters: TransactionFilterState;
    /** Current view mode (always in sync with URL). */
    viewMode: ViewMode;
    /** Replace entire filter state (also updates URL). */
    setFilters: (filters: TransactionFilterState) => void;
    /** Update specific filter fields (merges, also updates URL). */
    updateFilters: (partial: Partial<TransactionFilterState>) => void;
    /** Set view mode (also updates URL). */
    setViewMode: (mode: ViewMode) => void;
    /** Reset filters to default state (also updates URL). */
    resetFilters: () => void;
}

/**
 * Hook that owns TransactionFilterState + viewMode, synced bidirectionally with URL.
 */
export function useUrlFilterSync(): UseUrlFilterSyncReturn {
    // Read initial state from URL (only once)
    const initialRef = useRef(readFromUrl());
    const [filters, setFiltersInternal] = useState<TransactionFilterState>(initialRef.current.filters);
    const [viewMode, setViewModeInternal] = useState<ViewMode>(initialRef.current.viewMode);

    // Write to URL whenever state changes (skip first render since it came FROM url)
    const isFirstRender = useRef(true);
    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }
        writeToUrl(filters, viewMode);
    }, [filters, viewMode]);

    const setFilters = useCallback((next: TransactionFilterState) => {
        setFiltersInternal(next);
    }, []);

    const updateFilters = useCallback((partial: Partial<TransactionFilterState>) => {
        setFiltersInternal(prev => ({ ...prev, ...partial }));
    }, []);

    const setViewMode = useCallback((mode: ViewMode) => {
        setViewModeInternal(mode);
    }, []);

    const resetFilters = useCallback(() => {
        setFiltersInternal({ ...defaultFilterState, reviewStatus: [], taxability: [] });
    }, []);

    return { filters, viewMode, setFilters, updateFilters, setViewMode, resetFilters };
}
