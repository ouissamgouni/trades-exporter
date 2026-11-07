import React, { useCallback, useEffect, useState } from 'react';
import type { GapFixJobState, PriceHealthRow } from '../../types';
import { useGapFixJob } from '../../hooks/usePriceGaps';
import { PriceHealthCards } from '../PriceHealthCards';
import { AssetNameCell } from './AssetNameCell';

interface PriceGapsTabProps {
    pnlAssetIds: number[];
    quoteAssetId?: number | null;
    focusAssetId?: number | null;
    pnlVersionId?: number;
    onJobFinished?: (job: GapFixJobState) => void;
}

type Scope = 'pnl' | 'all';

export const PriceGapsTab: React.FC<PriceGapsTabProps> = ({ pnlAssetIds, quoteAssetId, focusAssetId, pnlVersionId, onJobFinished }) => {
    const [scope, setScope] = useState<Scope>('pnl');
    const { isActive } = useGapFixJob();

    useEffect(() => {
        if (focusAssetId != null) setScope('pnl');
    }, [focusAssetId]);

    const renderName = useCallback(
        (row: PriceHealthRow) => <AssetNameCell id={row.asset_id} symbol={row.symbol} label={row.label} pnlVersionId={pnlVersionId} />,
        [pnlVersionId],
    );

    const scopeToggle = (
        <div className="inline-flex border border-slate-200" role="group" aria-label="Gap scope">
            {(['pnl', 'all'] as Scope[]).map(s => (
                <button
                    key={s}
                    type="button"
                    onClick={() => setScope(s)}
                    disabled={isActive}
                    className={`px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${scope === s ? 'border-blue-500 bg-blue-500 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}
                >
                    {s === 'pnl' ? 'This P&L' : 'All assets'}
                </button>
            ))}
        </div>
    );

    return (
        <div className="h-full overflow-y-auto p-4">
            <PriceHealthCards
                assetIds={scope === 'pnl' ? pnlAssetIds : null}
                defaultFilter="gaps"
                focusAssetId={focusAssetId}
                quoteAssetId={quoteAssetId}
                onJobFinished={onJobFinished}
                toolbarStart={scopeToggle}
                renderName={renderName}
            />
        </div>
    );
};
