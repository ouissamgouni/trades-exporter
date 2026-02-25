/**
 * useBundleSuggestionMap
 * 
 * Fetches bundle suggestions and builds a O(1) lookup map from transaction ID
 * to suggestion + group color. Used by TransactionsTable to render inline
 * suggestion indicators on rows.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { API_URL, BundleSuggestion } from '../types';

// Color palette for suggestion groups — each group gets a unique color
const SUGGESTION_GROUP_COLORS = [
    'teal.400',
    'cyan.400',
    'blue.400',
    'purple.400',
    'orange.400',
    'pink.400',
];

export interface SuggestionEntry {
    /** The full suggestion object */
    suggestion: BundleSuggestion;
    /** Color token for this suggestion group */
    color: string;
    /** Index of this suggestion in the suggestions array */
    groupIndex: number;
}

export interface UseBundleSuggestionMapReturn {
    /** Map from transaction ID → suggestion entry */
    suggestionMap: Map<number, SuggestionEntry>;
    /** Get all sibling transaction IDs for a given transaction */
    getGroupTxIds: (txId: number) => number[];
    /** Raw suggestions array */
    suggestions: BundleSuggestion[];
    /** Loading state */
    isLoading: boolean;
    /** Refetch suggestions */
    refetch: () => void;
}

export function useBundleSuggestionMap(
    enabled: boolean = true,
    maxSuggestions: number = 100,
): UseBundleSuggestionMapReturn {
    const {
        data: allSuggestions = [],
        isLoading,
        refetch,
    } = useQuery({
        queryKey: ['bundleSuggestions'],
        queryFn: async () => {
            const response = await fetch(
                `${API_URL}/bundles/suggestions?max_suggestions=100`,
            );
            if (!response.ok) throw new Error('Failed to fetch suggestions');
            return response.json() as Promise<BundleSuggestion[]>;
        },
        enabled,
        staleTime: 60_000, // Cache for 1 minute to avoid excessive refetches
    });

    // Slice client-side to the requested max
    const suggestions = useMemo(
        () => allSuggestions.slice(0, maxSuggestions),
        [allSuggestions, maxSuggestions],
    );

    const suggestionMap = useMemo(() => {
        const map = new Map<number, SuggestionEntry>();
        suggestions.forEach((suggestion, idx) => {
            const color = SUGGESTION_GROUP_COLORS[idx % SUGGESTION_GROUP_COLORS.length];
            suggestion.transactions.forEach((tx) => {
                map.set(tx.id, { suggestion, color, groupIndex: idx });
            });
        });
        return map;
    }, [suggestions]);

    const getGroupTxIds = useMemo(() => {
        return (txId: number): number[] => {
            const entry = suggestionMap.get(txId);
            if (!entry) return [];
            return entry.suggestion.transactions.map((tx) => tx.id);
        };
    }, [suggestionMap]);

    return {
        suggestionMap,
        getGroupTxIds,
        suggestions,
        isLoading,
        refetch: () => refetch(),
    };
}
