/**
 * useAsset - Hook for fetching a single asset with full details (price_getters, categories).
 *
 * Uses `GET /assets/{id}?include_getters=true&include_categories=true` which
 * returns the full AssetResponse.  Separate from `useAssets` (the list cache)
 * so the panel always shows fresh data.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL, Asset } from '../types';
import { ASSETS_QUERY_KEY } from './useAssets';

export const ASSET_QUERY_KEY = (id: number) => ['asset', id] as const;

async function fetchAsset(id: number): Promise<Asset> {
    const response = await fetch(
        `${API_URL}/assets/${id}?include_getters=true&include_categories=true`,
    );
    if (!response.ok) throw new Error('Failed to fetch asset');
    return response.json();
}

export interface UseAssetReturn {
    asset: Asset | null;
    isLoading: boolean;
    error: Error | null;
    refetch: () => void;
    /** Invalidate both the single-asset and list caches */
    invalidate: () => void;
}

export function useAsset(assetId: number | null, enabled = true): UseAssetReturn {
    const queryClient = useQueryClient();

    const { data, isLoading, error } = useQuery<Asset>({
        queryKey: ASSET_QUERY_KEY(assetId!),
        queryFn: () => fetchAsset(assetId!),
        staleTime: 30_000,
        enabled: enabled && assetId != null,
    });

    const refetch = () => {
        if (assetId != null) {
            queryClient.invalidateQueries({ queryKey: ASSET_QUERY_KEY(assetId) });
        }
    };

    const invalidate = () => {
        if (assetId != null) {
            queryClient.invalidateQueries({ queryKey: ASSET_QUERY_KEY(assetId) });
        }
        queryClient.invalidateQueries({ queryKey: ASSETS_QUERY_KEY });
    };

    return {
        asset: data ?? null,
        isLoading,
        error: error as Error | null,
        refetch,
        invalidate,
    };
}
