/**
 * useAccountSuggestions
 *
 * Centralized hook for network-aware account suggestions.
 * Calls the backend GET /accounts/suggest endpoint which uses
 * connector chain metadata to disambiguate same-address accounts
 * (e.g., Tangem BSC vs Tangem Eth).
 *
 * Replaces all client-side getAccountSuggestions() calls that were
 * duplicated across TransactionsTable, AccountMappingPanel, etc.
 */

import { useQuery } from '@tanstack/react-query';
import { API_URL } from '../types';

/** Matches the backend SuggestionInfo schema */
export interface AccountSuggestion {
    id: number;
    name: string;
    confidence: number;
}

export interface UseAccountSuggestionsParams {
    /** Raw account label or address to fuzzy-match */
    label: string | undefined | null;
    /** Connector source type (e.g. 'blockscout', 'binance_trx') */
    source?: string | null;
    /** Chain/network for disambiguation (e.g. 'bsc', 'ethereum') */
    network?: string | null;
    /** Minimum confidence threshold (0-1). Default: 0.5 */
    minConfidence?: number;
    /** Maximum number of suggestions. Default: 3 */
    maxResults?: number;
    /** Set false to disable the query (e.g. when label is empty) */
    enabled?: boolean;
}

export interface UseAccountSuggestionsReturn {
    suggestions: AccountSuggestion[];
    isLoading: boolean;
}

export function useAccountSuggestions({
    label,
    source,
    network,
    minConfidence = 0.5,
    maxResults = 3,
    enabled = true,
}: UseAccountSuggestionsParams): UseAccountSuggestionsReturn {
    const hasLabel = !!label?.trim();

    const { data, isLoading } = useQuery<AccountSuggestion[]>({
        queryKey: ['account-suggestions', label, source, network, minConfidence, maxResults],
        queryFn: async () => {
            const params = new URLSearchParams({
                label: label!.trim(),
                min_confidence: String(minConfidence),
                max_results: String(maxResults),
            });
            if (source) params.set('source', source);
            if (network) params.set('network', network);

            const response = await fetch(`${API_URL}/accounts/suggest?${params}`);
            if (!response.ok) return [];
            return response.json();
        },
        enabled: enabled && hasLabel,
        staleTime: 30_000, // Cache for 30s — same label+source+network won't re-fetch
        gcTime: 60_000,
    });

    return {
        suggestions: data ?? [],
        isLoading: isLoading && enabled && hasLabel,
    };
}

/** Batch suggestion item for useAccountSuggestionsBatch */
export interface BatchSuggestionItem {
    label: string;
    source?: string | null;
    network?: string | null;
    minConfidence?: number;
    maxResults?: number;
}

export interface BatchSuggestionResult {
    label: string;
    suggestions: AccountSuggestion[];
}

/**
 * Fetch account suggestions for multiple labels in a single API call.
 * Useful for auto-link and bulk operations.
 */
export async function fetchAccountSuggestionsBatch(
    items: BatchSuggestionItem[],
): Promise<BatchSuggestionResult[]> {
    if (items.length === 0) return [];

    const response = await fetch(`${API_URL}/accounts/suggest-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            items: items.map(item => ({
                label: item.label,
                source: item.source || null,
                network: item.network || null,
                min_confidence: item.minConfidence ?? 0.95,
                max_results: item.maxResults ?? 1,
            })),
        }),
    });

    if (!response.ok) return items.map(i => ({ label: i.label, suggestions: [] }));
    return response.json();
}
