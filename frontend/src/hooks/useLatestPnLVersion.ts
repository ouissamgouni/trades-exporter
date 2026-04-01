/**
 * useLatestPnLVersion — Standalone hook to fetch the most recent PnL version.
 *
 * Used by the Asset Detail Panel to show PnL data without being inside PnLContext.
 */
import { useQuery } from '@tanstack/react-query';
import { API_URL } from '../types';
import type { VersionListItem } from '../components/pnl/types';

export function useLatestPnLVersion(enabled = true) {
    const result = useQuery<VersionListItem[]>({
        queryKey: ['pnl-versions-latest'],
        queryFn: async ({ signal }) => {
            const res = await fetch(`${API_URL}/pnl/versions?limit=1`, { signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        enabled,
        staleTime: 5 * 60_000,
    });

    const version = result.data?.[0] ?? null;

    return {
        version,
        versionId: version?.version_id ?? null,
        baseCurrency: version?.base_currency_symbol ?? 'EUR',
        isLoading: result.isLoading,
        error: result.error ? (result.error as Error).message : null,
    };
}
