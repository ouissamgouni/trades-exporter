import React, { useMemo, useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '../ui/primitives';
import type { PriceResponse } from '../../types';
import { usePriceGapsSummary } from '../../hooks/usePriceGaps';
import { PriceStatusList, type AssetGapInfo } from './PriceStatusList';
import { PriceGapsTab } from './PriceGapsTab';
import type { AssetPnLRow } from './types';

type DrawerTab = 'prices' | 'gaps';

interface PricesDrawerProps {
    prices: PriceResponse[];
    baseCurrency: string;
    quoteAssetId?: number;
    pnlAssets: AssetPnLRow[];
    /** Assets shown in the P&L but without cost lots (not priced) */
    naAssets: AssetPnLRow[];
    totalAssetCount: number;
    loadingAssetIds: Set<number>;
    pnlVersionId?: number;
    onPriceAdded: (assetId: number) => void;
    onRetryFailed: () => void;
    onRefreshAll: () => void;
    onRefreshAsset: (assetId: number) => void;
    onGapFixFinished: () => void;
}

export const PricesDrawer: React.FC<PricesDrawerProps> = ({
    prices,
    baseCurrency,
    quoteAssetId,
    pnlAssets,
    naAssets,
    totalAssetCount,
    loadingAssetIds,
    pnlVersionId,
    onPriceAdded,
    onRetryFailed,
    onRefreshAll,
    onRefreshAsset,
    onGapFixFinished,
}) => {
    const [tab, setTab] = useState<DrawerTab>('prices');
    const [focusAssetId, setFocusAssetId] = useState<number | null>(null);

    const pnlAssetIds = useMemo(
        () => pnlAssets.map(a => a.asset.id).filter((id): id is number => id != null),
        [pnlAssets],
    );
    const assetRefs = useMemo(
        () => new Map(pnlAssets.filter(a => a.asset.id != null).map(a => [a.asset.id!, { symbol: a.asset.symbol, label: a.asset.label }])),
        [pnlAssets],
    );
    const naRefs = useMemo(
        () => naAssets.filter(a => a.asset.id != null).map(a => ({ id: a.asset.id!, symbol: a.asset.symbol, label: a.asset.label })),
        [naAssets],
    );

    const { data: gapSummary } = usePriceGapsSummary(pnlAssetIds);
    const gapMap = useMemo(() => {
        const m = new Map<number, AssetGapInfo>();
        for (const i of gapSummary?.items ?? []) {
            if (i.total_missing_days > 0) m.set(i.asset_id, { gap_count: i.gap_count, total_missing_days: i.total_missing_days });
        }
        return m;
    }, [gapSummary]);
    const gapDays = useMemo(() => [...gapMap.values()].reduce((s, g) => s + g.total_missing_days, 0), [gapMap]);

    return (
        <div className="flex h-full flex-col">
            <Tabs value={tab} onValueChange={(v) => setTab(v as DrawerTab)}>
                <TabsList className="px-4">
                    <TabsTrigger value="prices">Prices</TabsTrigger>
                    <TabsTrigger value="gaps">
                        Price health{gapMap.size > 0 ? ` (${gapMap.size} assets · ${gapDays} d gaps)` : ''}
                    </TabsTrigger>
                </TabsList>
            </Tabs>
            <div className="min-h-0 flex-1">
                {tab === 'prices' ? (
                    <PriceStatusList
                        prices={prices}
                        baseCurrency={baseCurrency}
                        quoteAssetId={quoteAssetId}
                        onPriceAdded={onPriceAdded}
                        onRetryFailed={onRetryFailed}
                        onRefreshAll={onRefreshAll}
                        onRefreshAsset={onRefreshAsset}
                        loadingAssetIds={loadingAssetIds}
                        assetRefs={assetRefs}
                        totalAssetCount={totalAssetCount}
                        naAssets={naRefs}
                        gapMap={gapMap}
                        onGapsClick={(id) => {
                            setFocusAssetId(id);
                            setTab('gaps');
                        }}
                        pnlVersionId={pnlVersionId}
                    />
                ) : (
                    <PriceGapsTab
                        pnlAssetIds={pnlAssetIds}
                        quoteAssetId={quoteAssetId}
                        focusAssetId={focusAssetId}
                        pnlVersionId={pnlVersionId}
                        onJobFinished={onGapFixFinished}
                    />
                )}
            </div>
        </div>
    );
};
