import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { API_URL, type PriceResponse } from '../types';
import { useAccountScopedAssets } from './useAccountScopedAssets';
import { applyPricesToAssets, buildPriceMap } from '../components/pnl/pnlCalculations';
import type { AssetPnLRow } from '../components/pnl/types';

const NO_ROWS: AssetPnLRow[] = [];

/** Account-scoped asset rows priced with cached prices, for views outside the P&L provider. */
export function useScopedAssetRows(versionId: number | null, accountIds: number[], baseCurrency: string) {
    const scoped = useAccountScopedAssets(versionId, accountIds, NO_ROWS);
    const ids = useMemo(
        () => (scoped.rows ?? []).map(r => r.asset.id).filter((id): id is number => id != null).sort((a, b) => a - b),
        [scoped.rows],
    );

    const prices = useQuery<PriceResponse[]>({
        queryKey: ['scoped-cached-prices', baseCurrency, ids.join(',')],
        queryFn: async ({ signal }) => {
            const res = await fetch(`${API_URL}/pnl/prices/cached`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ asset_ids: ids, base_currency: baseCurrency }),
                signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        enabled: ids.length > 0,
        staleTime: 60_000,
    });

    const rows = useMemo(
        () => (scoped.rows ? applyPricesToAssets(scoped.rows, buildPriceMap(prices.data ?? [])) : null),
        [scoped.rows, prices.data],
    );

    return { rows, isLoading: scoped.isLoading || (ids.length > 0 && prices.isLoading) };
}
