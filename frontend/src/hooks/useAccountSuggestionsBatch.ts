/**
 * useAccountSuggestionsBatch
 *
 * Fetches account suggestions for all unlinked labels on the current page
 * in a single POST /accounts/suggest-batch call, instead of N individual
 * GET /accounts/suggest calls. Returns a Map<label, AccountSuggestion[]>.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { API_URL } from '../types';
import type { AccountSuggestion } from './useAccountSuggestions';

export interface BatchItem {
    label: string;
    source?: string | null;
    network?: string | null;
}

/**
 * Given a list of unique { label, source, network } items,
 * fetches suggestions for all of them in one batch API call.
 *
 * Returns a Map keyed by label → AccountSuggestion[].
 */
export function useAccountSuggestionsBatch(
    items: BatchItem[],
    options?: { enabled?: boolean; maxResults?: number; minConfidence?: number },
) {
    const enabled = options?.enabled !== false && items.length > 0;
    const maxResults = options?.maxResults ?? 3;
    const minConfidence = options?.minConfidence ?? 0.5;

    // Stable key from sorted labels
    const cacheKey = useMemo(
        () => items.map(i => `${i.label}|${i.source ?? ''}|${i.network ?? ''}`).sort().join(';;'),
        [items],
    );

    const { data, isLoading } = useQuery<Map<string, AccountSuggestion[]>>({
        queryKey: ['account-suggestions-batch', cacheKey, maxResults, minConfidence],
        queryFn: async () => {
            if (items.length === 0) return new Map();

            const response = await fetch(`${API_URL}/accounts/suggest-batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    items: items.map(item => ({
                        label: item.label,
                        source: item.source || null,
                        network: item.network || null,
                        min_confidence: minConfidence,
                        max_results: maxResults,
                    })),
                }),
            });

            if (!response.ok) return new Map();

            const results: { label: string; suggestions: AccountSuggestion[] }[] = await response.json();
            const map = new Map<string, AccountSuggestion[]>();
            for (const r of results) {
                map.set(r.label, r.suggestions);
            }
            return map;
        },
        enabled,
        staleTime: 30_000,
        gcTime: 60_000,
    });

    return {
        suggestionsMap: data ?? new Map<string, AccountSuggestion[]>(),
        isLoading: isLoading && enabled,
    };
}
