/**
 * GapFixPanel — Shared chart + gap-range list with CTAs.
 *
 * Layout: price chart on the left, scrollable gap list on the right.
 * Used by both expanded HealthCard and AssetDetailSlidePanel.
 *
 * - "Fetch" buttons are hidden when the asset has no price getters.
 * - Default quote currency is the app's base currency asset.
 */

import React, { useState } from 'react';
import { FiDownload, FiEdit3, FiZap } from 'react-icons/fi';
import { AssetPriceChart } from './AssetPriceChart';
import { PriceSetterDialog } from './pnl/PriceSetterDialog';
import { usePriceGaps, useEnqueuePriceFetch } from '../hooks/usePriceGaps';
import { GapFixJobInline } from './GapFixJobInline';
import { useAsset } from '../hooks/useAsset';
import { useBaseCurrency } from '../hooks/useBaseCurrency';
import { GapRange } from '../types';
import { toaster } from './ui/toaster';
import { Tooltip } from './ui/tooltip';
import { Button, Spinner } from './ui/primitives';

export interface GapFixPanelProps {
    assetId: number;
    symbol: string;
    /** Optional external handler to open PriceSetterDialog (e.g. from parent card) */
    onOpenPriceSetter?: () => void;
}

const fmtShort = (d: string) => {
    try {
        return new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
        return d;
    }
};

export const GapFixPanel: React.FC<GapFixPanelProps> = ({ assetId, symbol, onOpenPriceSetter }) => {
    const { data: gapData, refetch } = usePriceGaps(assetId);
    const gaps = gapData?.gaps ?? [];
    const enqueue = useEnqueuePriceFetch();
    const [fixingAll, setFixingAll] = useState(false);
    const [fetchingIdx, setFetchingIdx] = useState<number | null>(null);
    const [manualGap, setManualGap] = useState<GapRange | null>(null);

    // Check if asset has price getters → if not, disable auto-fetch
    const { asset } = useAsset(assetId);
    const hasGetters = (asset?.price_getters?.length ?? 0) > 0;

    // Resolve base currency from app settings
    const baseCurrency = useBaseCurrency();

    const queue = async (ranges: GapRange[]) => {
        try {
            await enqueue.mutateAsync({
                items: ranges.map(g => ({ asset_id: assetId, date_from: g.start_date, date_to: g.end_date })),
                quoteAssetId: baseCurrency.assetId ?? null,
            });
            toaster.info({ title: 'Price fetch queued', description: `${symbol}: progress and log below` });
        } catch (err) {
            toaster.error({ title: 'Could not queue price fetch', description: err instanceof Error ? err.message : 'Unknown error' });
        }
    };

    const handleFixAll = async () => {
        setFixingAll(true);
        await queue(gaps);
        setFixingAll(false);
    };

    const handleFetchOne = async (gap: GapRange, idx: number) => {
        setFetchingIdx(idx);
        await queue([gap]);
        setFetchingIdx(null);
    };

    const totalMissing = gaps.reduce((s, g) => s + g.missing_days_count, 0);

    return (
        <>
            <div className="flex items-stretch gap-3">
                {/* Left: chart */}
                <div className="min-w-0 flex-[2]">
                    <GapFixJobInline assetId={assetId} className="mb-1.5" />
                    <AssetPriceChart assetId={assetId} symbol={symbol} gaps={gaps} />
                    {/* Price Setter CTA */}
                    <div className="mt-1.5 flex gap-1">
                        <Button
                            size="sm"
                            variant="outline"
                            colorScheme="blue"
                            className="text-[10px]"
                            onClick={() => {
                                if (onOpenPriceSetter) {
                                    onOpenPriceSetter();
                                } else {
                                    setManualGap({ start_date: new Date().toISOString().split('T')[0], end_date: new Date().toISOString().split('T')[0], missing_days_count: 1, last_known_price: null, last_known_price_date: null, last_known_source: null });
                                }
                            }}
                        >
                            <FiEdit3 size={10} /> Price Setter
                        </Button>
                    </div>
                </div>

                {/* Right: gap list */}
                {gaps.length > 0 && (
                    <div className="flex min-w-[160px] max-w-[220px] flex-1 flex-col gap-1">
                        {/* Header + Fix All */}
                        <div className="mb-0.5 flex items-center justify-between">
                            <span className="text-[10px] font-medium text-orange-700">
                                {gaps.length} range{gaps.length !== 1 ? 's' : ''} · {totalMissing}d
                            </span>
                            {hasGetters ? (
                                <Button
                                    size="sm"
                                    colorScheme="blue"
                                    variant="solid"
                                    onClick={handleFixAll}
                                    disabled={fixingAll}
                                    className="bg-orange-600 text-[10px] hover:bg-orange-700"
                                >
                                    {fixingAll ? <Spinner size="xs" /> : <><FiZap size={10} /> Fix all</>}
                                </Button>
                            ) : (
                                <Tooltip content="No price getters configured — only manual fill available">
                                    <span className="text-[10px] text-slate-400">auto N/A</span>
                                </Tooltip>
                            )}
                        </div>

                        {/* Scrollable gap list */}
                        <div className="flex max-h-[180px] flex-col gap-1 overflow-y-auto pr-1">
                            {gaps.map((gap, i) => (
                                <div
                                    key={`${gap.start_date}-${gap.end_date}`}
                                    className="border border-orange-100 bg-orange-50 px-1.5 py-1"
                                >
                                    <span className="mb-0.5 block text-[10px] font-medium text-orange-800">
                                        {fmtShort(gap.start_date)} — {fmtShort(gap.end_date)} ({gap.missing_days_count}d)
                                    </span>
                                    <div className="flex gap-1">
                                        {hasGetters && (
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                colorScheme="blue"
                                                className="border-orange-300 text-[10px] text-orange-700 hover:bg-orange-50"
                                                onClick={() => handleFetchOne(gap, i)}
                                                disabled={fetchingIdx === i}
                                            >
                                                {fetchingIdx === i ? <Spinner size="xs" /> : <><FiDownload size={10} /> Fetch</>}
                                            </Button>
                                        )}
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="text-[10px]"
                                            onClick={() => setManualGap(gap)}
                                        >
                                            <FiEdit3 size={10} /> Manual
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {manualGap && (
                <PriceSetterDialog
                    isOpen={true}
                    onClose={() => setManualGap(null)}
                    onSave={() => { setManualGap(null); refetch(); }}
                    assetId={assetId}
                    assetName={symbol}
                    defaultDate={manualGap.start_date}
                    quoteAssetId={baseCurrency.assetId}
                    quoteAssetName={baseCurrency.symbol}
                    defaultDateFrom={manualGap.start_date}
                    defaultDateTo={manualGap.end_date}
                    defaultPrice={manualGap.last_known_price}
                    hasGetters={hasGetters}
                />
            )}
        </>
    );
};

export default GapFixPanel;
