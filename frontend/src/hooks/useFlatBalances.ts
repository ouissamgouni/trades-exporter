import { useQuery } from '@tanstack/react-query';
import { API_URL } from '../types';
import type { PerAccountBalanceItem } from '../components/pnl/types';

/** Every (account, asset) balance of a P&L version, unsettled negatives included. */
export function useFlatBalances(versionId: number | null, enabled = true) {
    return useQuery<PerAccountBalanceItem[]>({
        queryKey: ['pnl-balances-flat', versionId],
        queryFn: async ({ signal }) => {
            const params = new URLSearchParams({ group_by_asset: 'false', include_unsettled_negative: 'true' });
            const res = await fetch(`${API_URL}/pnl/versions/${versionId}/balances?${params}`, { signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        enabled: enabled && !!versionId,
        staleTime: 5 * 60_000,
    });
}
