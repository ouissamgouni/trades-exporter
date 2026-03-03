/**
 * useAccounts - Shared hook for fetching accounts via React Query.
 *
 * Replaces duplicated `fetch('/accounts/')` + `useState` calls
 * across 9+ components with a single shared cache entry.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL, Account } from '../types';

export const ACCOUNTS_QUERY_KEY = ['accounts'] as const;

async function fetchAccountsList(): Promise<Account[]> {
    const response = await fetch(`${API_URL}/accounts/`);
    if (!response.ok) throw new Error('Failed to fetch accounts');
    return response.json();
}

export interface UseAccountsReturn {
    accounts: Account[];
    isLoading: boolean;
    error: Error | null;
    refetchAccounts: () => void;
}

/**
 * Shared hook that provides the global account list via React Query cache.
 * All consumers share the same cache entry — no duplicate fetches or state copies.
 *
 * @param enabled - Whether to fetch immediately (default: true). Pass false to defer.
 */
export function useAccounts(enabled = true): UseAccountsReturn {
    const queryClient = useQueryClient();

    const { data, isLoading, error } = useQuery<Account[]>({
        queryKey: ACCOUNTS_QUERY_KEY,
        queryFn: fetchAccountsList,
        staleTime: 30_000,  // Consider fresh for 30 seconds
        enabled,
    });

    const refetchAccounts = () => {
        queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
    };

    return {
        accounts: data ?? [],
        isLoading,
        error: error as Error | null,
        refetchAccounts,
    };
}
