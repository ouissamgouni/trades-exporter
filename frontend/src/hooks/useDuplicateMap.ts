/**
 * useDuplicateMap
 *
 * Fetches lightweight duplicate suspicions from /data-health/duplicate-suspicions
 * and builds a O(1) lookup map from transaction ID to duplicate group info.
 * Used by TransactionsTable to render inline duplicate indicators on rows.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { API_URL } from '../types';

// Color palette for duplicate groups — distinct from bundle suggestion colors (literal
// hex, consumed directly as CSS values by non-Chakra components).
const DUPLICATE_GROUP_COLORS = [
    '#f87171', // red-400
    '#fb923c', // orange-400
    '#eab308', // yellow-500
    '#f472b6', // pink-400
    '#fca5a5', // red-300
    '#fdba74', // orange-300
];

export interface DuplicateSuspicion {
    group_hash: string;
    transaction_ids: number[];
    match_criteria: string;
}

export interface DuplicateEntry {
    /** Group hash for this duplicate group */
    groupHash: string;
    /** All transaction IDs in this duplicate group */
    transactionIds: number[];
    /** Human-readable match criteria summary */
    matchCriteria: string;
    /** Color token for this group */
    color: string;
    /** Index of this group in the suspicions array */
    groupIndex: number;
}

export interface UseDuplicateMapReturn {
    /** Map from transaction ID → duplicate entry */
    duplicateMap: Map<number, DuplicateEntry>;
    /** Get all sibling transaction IDs for a given transaction */
    getGroupTxIds: (txId: number) => number[];
    /** Raw suspicions array */
    suspicions: DuplicateSuspicion[];
    /** Loading state */
    isLoading: boolean;
    /** Refetch suspicions */
    refetch: () => void;
}

export function useDuplicateMap(
    enabled: boolean = true,
): UseDuplicateMapReturn {
    const {
        data: responseData,
        isLoading,
        refetch,
    } = useQuery({
        queryKey: ['duplicateSuspicions'],
        queryFn: async () => {
            const response = await fetch(
                `${API_URL}/data-health/duplicate-suspicions`,
            );
            if (!response.ok) throw new Error('Failed to fetch duplicate suspicions');
            return response.json() as Promise<{ suspicions: DuplicateSuspicion[] }>;
        },
        enabled,
        staleTime: 60_000,
    });

    const suspicions = useMemo(
        () => responseData?.suspicions ?? [],
        [responseData],
    );

    const duplicateMap = useMemo(() => {
        const map = new Map<number, DuplicateEntry>();
        suspicions.forEach((suspicion, idx) => {
            const color = DUPLICATE_GROUP_COLORS[idx % DUPLICATE_GROUP_COLORS.length];
            const entry: DuplicateEntry = {
                groupHash: suspicion.group_hash,
                transactionIds: suspicion.transaction_ids,
                matchCriteria: suspicion.match_criteria,
                color,
                groupIndex: idx,
            };
            suspicion.transaction_ids.forEach((txId) => {
                map.set(txId, entry);
            });
        });
        return map;
    }, [suspicions]);

    const getGroupTxIds = useMemo(() => {
        return (txId: number): number[] => {
            const entry = duplicateMap.get(txId);
            if (!entry) return [];
            return entry.transactionIds;
        };
    }, [duplicateMap]);

    return {
        duplicateMap,
        getGroupTxIds,
        suspicions,
        isLoading,
        refetch: () => refetch(),
    };
}
