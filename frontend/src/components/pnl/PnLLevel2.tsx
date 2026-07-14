/**
 * PnLLevel2 — Drill Level 2 Renderer (Asset Audit)
 *
 * Full audit view scoped to a single asset + optional date range + account filter.
 * Composes InvestigationView (stats cards + activity feed + slide panels)
 * with optional highlightCard visual hint from drill context.
 */

import React from 'react';
import { InvestigationView } from './InvestigationView';
import { usePnL } from './PnLContext';
import type { DrillDownState } from './pnlState';

interface PnLLevel2Props {
    drill: DrillDownState;
    onTransactionClick: (txId: number) => void;
    onAssetClick: (assetId: number) => void;
    onUnitClick: (unitId: number) => void;
}

export const PnLLevel2: React.FC<PnLLevel2Props> = ({
    drill,
    onTransactionClick,
    onAssetClick,
    onUnitClick,
}) => {
    const {
        state,
        assets,
        assetBalanceMap,
    } = usePnL();

    const { currentVersionId, config } = state;

    if (!currentVersionId || !drill.assetId) return null;

    // Map asset list for InvestigationView (scoped to drilled asset)
    const scopedAssets = assets
        .filter(a => a.asset.id === drill.assetId)
        .map(a => ({ id: a.asset.id ?? 0, symbol: a.asset.symbol ?? '', label: a.asset.label ?? undefined }));

    return (
        <div>
            <InvestigationView
                versionId={currentVersionId}
                baseCurrency={config.base_currency_symbol}
                onTransactionClick={onTransactionClick}
                onAssetClick={onAssetClick}
                onUnitClick={onUnitClick}
                defaultPanel={drill.highlightCard ?? null}
                assets={scopedAssets.length > 0 ? scopedAssets : assets.map(a => ({ id: a.asset.id ?? 0, symbol: a.asset.symbol ?? '', label: a.asset.label ?? undefined }))}
                assetBalanceMap={assetBalanceMap}
            />
        </div>
    );
};
