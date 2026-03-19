/**
 * useAssets - Shared hook for fetching assets via React Query.
 *
 * Replaces duplicated `fetch('/assets?limit=10000')` + `useState` calls
 * across 7+ components with a single shared cache entry.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL, Asset } from '../types';

export const ASSETS_QUERY_KEY = ['assets'] as const;

async function fetchAssets(): Promise<Asset[]> {
    const response = await fetch(`${API_URL}/assets?limit=10000`);
    if (!response.ok) throw new Error('Failed to fetch assets');
    return response.json();
}

export interface UseAssetsReturn {
    assets: Asset[];
    isLoading: boolean;
    error: Error | null;
    refetchAssets: () => void;
}

/**
 * Shared hook that provides the global asset list via React Query cache.
 * All consumers share the same cache entry — no duplicate fetches or state copies.
 *
 * @param enabled - Whether to fetch immediately (default: true). Pass false to defer.
 */
export function useAssets(enabled = true): UseAssetsReturn {
    const queryClient = useQueryClient();

    const { data, isLoading, error } = useQuery<Asset[]>({
        queryKey: ASSETS_QUERY_KEY,
        queryFn: fetchAssets,
        staleTime: 60_000,  // Consider fresh for 1 minute
        enabled,
    });

    const refetchAssets = () => {
        queryClient.invalidateQueries({ queryKey: ASSETS_QUERY_KEY });
    };

    return {
        assets: data ?? [],
        isLoading,
        error: error as Error | null,
        refetchAssets,
    };
}
