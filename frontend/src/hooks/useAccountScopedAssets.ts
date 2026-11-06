/**
 * useAccountScopedAssets
 *
 * Asset rows restricted to the selected holding accounts (only those accounts' lots,
 * realized P&L, fees), priced with the prices already loaded for the full portfolio.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { API_URL } from '../types';
import { balancesToAssetRows, priceScopedRows } from '../components/pnl/pnlCalculations';
import type { AggregatedBalanceItem, AssetPnLRow } from '../components/pnl/types';

export function useAccountScopedAssets(
    versionId: number | null,
    accountIds: number[],
    pricedRows: AssetPnLRow[],
    includeUnsettledNegative = false,
) {
    const accountKey = useMemo(() => [...accountIds].sort((a, b) => a - b).join(','), [accountIds]);
    const enabled = !!versionId && accountKey !== '';

    const query = useQuery<AggregatedBalanceItem[]>({
        queryKey: ['pnl-account-scoped-balances', versionId, accountKey, includeUnsettledNegative],
        queryFn: async ({ signal }) => {
            const sp = new URLSearchParams({
                group_by_asset: 'true',
                include_unsettled_negative: String(includeUnsettledNegative),
                account_ids: accountKey,
            });
            const res = await fetch(`${API_URL}/pnl/versions/${versionId}/balances?${sp}`, { signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        enabled,
        staleTime: 5 * 60_000,
    });

    const rows = useMemo(
        () => (enabled && query.data ? priceScopedRows(balancesToAssetRows(query.data), pricedRows) : null),
        [enabled, query.data, pricedRows],
    );

    return {
        rows,
        isLoading: enabled && query.isLoading,
        error: query.error ? (query.error as Error).message : null,
    };
}
