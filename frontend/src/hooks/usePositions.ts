/**
 * usePositions - Hook for fetching derivative positions via React Query.
 */

import { useQuery } from '@tanstack/react-query';
import { API_URL, DerivativePosition } from '../types';

export const POSITIONS_QUERY_KEY = ['positions'] as const;

interface UsePositionsParams {
    account_id?: number;
    coin?: string;
    status?: string;
    exchange?: string;
    transaction_id?: number;
    sort_by?: string;
    sort_dir?: string;
    limit?: number;
    offset?: number;
    enabled?: boolean;
}

async function fetchPositions(params: Omit<UsePositionsParams, 'enabled'>): Promise<DerivativePosition[]> {
    const searchParams = new URLSearchParams();
    if (params.account_id != null) searchParams.set('account_id', String(params.account_id));
    if (params.coin) searchParams.set('coin', params.coin);
    if (params.status) searchParams.set('status', params.status);
    if (params.exchange) searchParams.set('exchange', params.exchange);
    if (params.transaction_id != null) searchParams.set('transaction_id', String(params.transaction_id));
    if (params.sort_by) searchParams.set('sort_by', params.sort_by);
    if (params.sort_dir) searchParams.set('sort_dir', params.sort_dir);
    if (params.limit != null) searchParams.set('limit', String(params.limit));
    if (params.offset != null) searchParams.set('offset', String(params.offset));

    const qs = searchParams.toString();
    const url = `${API_URL}/positions/${qs ? `?${qs}` : ''}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to fetch positions');
    return response.json();
}

async function fetchPosition(id: number): Promise<DerivativePosition> {
    const response = await fetch(`${API_URL}/positions/${id}`);
    if (!response.ok) throw new Error('Failed to fetch position');
    return response.json();
}

export function usePositions(params: UsePositionsParams = {}) {
    const { enabled = true, ...queryParams } = params;

    const queryKey = [...POSITIONS_QUERY_KEY, queryParams];

    const { data, isLoading, error, refetch } = useQuery<DerivativePosition[]>({
        queryKey,
        queryFn: () => fetchPositions(queryParams),
        staleTime: 30_000,
        enabled,
    });

    return {
        positions: data ?? [],
        isLoading,
        error: error as Error | null,
        refetch,
    };
}

export function usePosition(id: number | null) {
    const { data, isLoading, error } = useQuery<DerivativePosition>({
        queryKey: [...POSITIONS_QUERY_KEY, 'detail', id],
        queryFn: () => fetchPosition(id!),
        staleTime: 30_000,
        enabled: id != null,
    });

    return {
        position: data ?? null,
        isLoading,
        error: error as Error | null,
    };
}
