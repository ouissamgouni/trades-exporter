/**
 * useBaseCurrency — Shared hook for the app's configured base currency.
 *
 * Fetches GET /config/settings and caches via React Query.
 * Returns the base currency symbol (e.g. "EUR") and resolved asset_id.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { API_URL } from '../types';
import { useAssets } from './useAssets';

export const APP_SETTINGS_QUERY_KEY = ['app-settings'] as const;

interface AppSettings {
    base_currency: string;
    [key: string]: unknown;
}

async function fetchAppSettings(): Promise<AppSettings> {
    const res = await fetch(`${API_URL}/config/settings`);
    if (!res.ok) throw new Error('Failed to fetch app settings');
    return res.json();
}

export interface UseBaseCurrencyReturn {
    symbol: string;
    assetId: number | undefined;
    isLoading: boolean;
}

export function useBaseCurrency(): UseBaseCurrencyReturn {
    const { data: settings, isLoading: settingsLoading } = useQuery<AppSettings>({
        queryKey: APP_SETTINGS_QUERY_KEY,
        queryFn: fetchAppSettings,
        staleTime: 5 * 60_000, // 5 min
    });

    const { assets, isLoading: assetsLoading } = useAssets();

    const symbol = settings?.base_currency ?? 'USD';

    const assetId = useMemo(() => {
        if (!assets || !symbol) return undefined;
        return assets.find(a => a.symbol === symbol)?.asset_id ?? undefined;
    }, [assets, symbol]);

    return {
        symbol,
        assetId,
        isLoading: settingsLoading || assetsLoading,
    };
}
