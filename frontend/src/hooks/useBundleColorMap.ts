/**
 * useBundleColorMap
 *
 * Builds a deterministic color map from unique bundle IDs visible in the
 * current transaction list. Colors are stable across re-renders because
 * bundle IDs are sorted before assigning palette indices.
 *
 * Uses a distinct palette from suggestion group colors to avoid confusion.
 */

import { useMemo } from 'react';
import { Transaction } from '../types';

// Color palette for bundle membership — intentionally different from suggestion colors
// Suggestion colors: teal.400, cyan.400, blue.400, purple.400, orange.400, pink.400
const BUNDLE_GROUP_COLORS = [
    'purple.500',
    'red.400',
    'yellow.500',
    'green.500',
    'pink.500',
    'orange.500',
];

export interface UseBundleColorMapReturn {
    /** Map from user_calculation_unit_id → color token */
    bundleColorMap: Map<number, string>;
}

/**
 * Given a list of transactions, extract unique non-null bundle IDs and
 * assign each a stable color from the palette.
 */
export function useBundleColorMap(
    transactions: Transaction[],
): UseBundleColorMapReturn {
    const bundleColorMap = useMemo(() => {
        const map = new Map<number, string>();
        // Collect unique bundle IDs
        const uniqueIds = new Set<number>();
        for (const tx of transactions) {
            if (tx.user_calculation_unit_id != null) {
                uniqueIds.add(tx.user_calculation_unit_id);
            }
        }
        // Sort for deterministic color assignment
        const sorted = Array.from(uniqueIds).sort((a, b) => a - b);
        sorted.forEach((id, idx) => {
            map.set(id, BUNDLE_GROUP_COLORS[idx % BUNDLE_GROUP_COLORS.length]);
        });
        return map;
    }, [transactions]);

    return { bundleColorMap };
}
