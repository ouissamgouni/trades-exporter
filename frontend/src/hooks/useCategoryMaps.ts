import { useMemo } from 'react';
import type { DimensionWithCategories } from '../types';
import type { AssetPnLRow } from '../components/pnl/types';

/**
 * Builds per-dimension maps of asset_id → category label.
 * Shared between PnLPanel (L0) and PnLDetailPanel (drill).
 */
export function useCategoryMaps(
    dimensions: DimensionWithCategories[],
    assets: AssetPnLRow[],
): Record<number, Record<number, string>> {
    return useMemo(() => {
        const maps: Record<number, Record<number, string>> = {};
        for (const dim of dimensions) {
            const catIdToLabel: Record<number, string> = {};
            for (const cat of dim.categories) {
                catIdToLabel[cat.id] = cat.label;
            }
            const m: Record<number, string> = {};
            for (const a of assets) {
                if (a.asset.id == null) continue;
                for (const catId of a.category_ids) {
                    if (catIdToLabel[catId]) {
                        m[a.asset.id] = catIdToLabel[catId];
                        break;
                    }
                }
            }
            maps[dim.id] = m;
        }
        return maps;
    }, [dimensions, assets]);
}
