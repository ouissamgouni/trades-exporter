/**
 * PriceGapAlert — shared component that renders actionable alerts for price gaps.
 *
 * - Full mode: one alert per gap range, stacked vertically, each with CTAs
 * - Compact mode: a single badge ("N gaps") with a popover listing ranges
 *
 * CTAs per gap range:
 *   1. "Fetch Missing Prices" → queues the range into the gap-fix job
 *   2. "Fill Manually" → opens PriceSetterDialog in range mode with last_known_price
 *
 * A "Fix All Gaps" button at the top queues every range in one job request.
 */

import React, { useState } from 'react';
import { Badge, Button, Spinner } from './ui/primitives';
import { FiAlertTriangle, FiDownload, FiEdit3, FiZap } from 'react-icons/fi';
import { GapRange } from '../types';
import { useEnqueuePriceFetch } from '../hooks/usePriceGaps';
import { GapFixJobInline } from './GapFixJobInline';
import { Tooltip } from './ui/tooltip';
import { toaster } from './ui/toaster';
import { PriceSetterDialog } from './pnl/PriceSetterDialog';

export interface PriceGapAlertProps {
    assetId: number;
    assetName: string;
    gaps: GapRange[];
    quoteAssetId?: number;
    quoteAssetName?: string;
    /** Called after any successful backfill or manual fill */
    onComplete?: () => void;
    /** Compact mode: renders a clickable badge instead of full alerts */
    compact?: boolean;
}

/** Format a date string to short locale format */
const fmtDate = (d: string) => {
    try {
        return new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        });
    } catch {
        return d;
    }
};

// ─── Single Gap Range Alert ─────────────────────────────────────────────────

interface GapRangeAlertProps {
    gap: GapRange;
    assetId: number;
    assetName: string;
    quoteAssetId?: number;
    quoteAssetName: string;
    onComplete?: () => void;
}

const GapRangeAlert: React.FC<GapRangeAlertProps> = ({
    gap,
    assetId,
    assetName,
    quoteAssetId,
    quoteAssetName,
    onComplete,
}) => {
    const enqueue = useEnqueuePriceFetch();
    const [showManual, setShowManual] = useState(false);

    const handleFetch = async () => {
        try {
            await enqueue.mutateAsync({
                items: [{ asset_id: assetId, date_from: gap.start_date, date_to: gap.end_date }],
                quoteAssetId: quoteAssetId ?? null,
            });
            toaster.info({ title: 'Price fetch queued', description: `${assetName}: follow progress in the price fetch job` });
            onComplete?.();
        } catch (err) {
            toaster.error({
                title: 'Could not queue price fetch',
                description: err instanceof Error ? err.message : 'Unknown error',
            });
        }
    };

    const handleManualSaved = () => {
        setShowManual(false);
        onComplete?.();
    };

    const isFetching = enqueue.isPending;

    return (
        <>
            <div className="rounded-md border border-orange-200 bg-orange-50 p-3">
                <div className="flex items-start gap-2">
                    <span className="mt-0.5 text-orange-500">
                        <FiAlertTriangle size={16} />
                    </span>
                    <div className="flex-1">
                        <span className="block text-sm font-medium text-orange-800">
                            Missing prices: {fmtDate(gap.start_date)} — {fmtDate(gap.end_date)}
                            {' '}({gap.missing_days_count} day{gap.missing_days_count !== 1 ? 's' : ''})
                        </span>
                        {gap.last_known_price != null && (
                            <span className="mt-0.5 block text-xs text-slate-600">
                                Last known: {gap.last_known_price.toLocaleString()} ({gap.last_known_source ?? 'unknown'} on{' '}
                                {gap.last_known_price_date ? fmtDate(gap.last_known_price_date) : '?'})
                            </span>
                        )}
                        <div className="mt-2 flex gap-2">
                            <Button
                                size="sm"
                                colorScheme="gray"
                                variant="outline"
                                className="border-orange-300 text-orange-600 hover:bg-orange-50"
                                onClick={handleFetch}
                                disabled={isFetching}
                            >
                                {isFetching ? (
                                    <><Spinner size="xs" className="mr-1" /> Fetching...</>
                                ) : (
                                    <><FiDownload style={{ marginRight: 4 }} /> Fetch Missing Prices</>
                                )}
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setShowManual(true)}
                            >
                                <FiEdit3 style={{ marginRight: 4 }} /> Fill Manually
                            </Button>
                        </div>
                    </div>
                </div>
            </div>

            <PriceSetterDialog
                isOpen={showManual}
                onClose={() => setShowManual(false)}
                onSave={handleManualSaved}
                assetId={assetId}
                assetName={assetName}
                defaultDate={gap.start_date}
                quoteAssetId={quoteAssetId}
                quoteAssetName={quoteAssetName}
                defaultDateFrom={gap.start_date}
                defaultDateTo={gap.end_date}
                defaultPrice={gap.last_known_price}
            />
        </>
    );
};

// ─── Main PriceGapAlert ─────────────────────────────────────────────────────

export const PriceGapAlert: React.FC<PriceGapAlertProps> = ({
    assetId,
    assetName,
    gaps,
    quoteAssetId,
    quoteAssetName = 'USD',
    onComplete,
    compact = false,
}) => {
    const enqueue = useEnqueuePriceFetch();
    const [fixingAll, setFixingAll] = useState(false);
    const [expandedCompact, setExpandedCompact] = useState(false);

    if (!gaps || gaps.length === 0) return null;

    const totalMissing = gaps.reduce((sum, g) => sum + g.missing_days_count, 0);

    // ── Compact mode: just a badge ────────────────────────────────────────
    if (compact) {
        return (
            <div className="relative inline-block">
                <Tooltip content={`${gaps.length} gap range(s), ${totalMissing} missing day(s)`}>
                    <Badge
                        colorScheme="orange"
                        className="cursor-pointer"
                        onClick={() => setExpandedCompact(!expandedCompact)}
                    >
                        {gaps.length} gap{gaps.length !== 1 ? 's' : ''}
                    </Badge>
                </Tooltip>
                {expandedCompact && (
                    <div className="absolute left-0 top-full z-10 mt-1 max-h-[400px] min-w-[340px] overflow-y-auto border border-slate-200 bg-white p-3 shadow-md">
                        <div className="flex flex-col gap-2">
                            {gaps.map((gap, i) => (
                                <GapRangeAlert
                                    key={`${gap.start_date}-${gap.end_date}`}
                                    gap={gap}
                                    assetId={assetId}
                                    assetName={assetName}
                                    quoteAssetId={quoteAssetId}
                                    quoteAssetName={quoteAssetName}
                                    onComplete={onComplete}
                                />
                            ))}
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // ── Full mode: stacked alerts ─────────────────────────────────────────

    const handleFixAll = async () => {
        setFixingAll(true);
        try {
            await enqueue.mutateAsync({
                items: gaps.map(g => ({ asset_id: assetId, date_from: g.start_date, date_to: g.end_date })),
                quoteAssetId: quoteAssetId ?? null,
            });
            toaster.info({ title: 'Price fetch queued', description: `${assetName}: follow progress in the price fetch job` });
            onComplete?.();
        } catch (err) {
            toaster.error({
                title: 'Fix all failed',
                description: err instanceof Error ? err.message : 'Unknown error',
            });
        } finally {
            setFixingAll(false);
        }
    };

    return (
        <div className="flex flex-col gap-2">
            <GapFixJobInline assetId={assetId} />
            {/* Header with bulk action */}
            {gaps.length > 1 && (
                <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-orange-700">
                        {gaps.length} gap range{gaps.length !== 1 ? 's' : ''} ({totalMissing} missing day{totalMissing !== 1 ? 's' : ''})
                    </span>
                    <Button
                        size="sm"
                        colorScheme="gray"
                        className="bg-orange-600 hover:bg-orange-700"
                        onClick={handleFixAll}
                        disabled={fixingAll}
                    >
                        {fixingAll ? (
                            <><Spinner size="xs" className="mr-1" /> Fixing all...</>
                        ) : (
                            <><FiZap style={{ marginRight: 4 }} /> Fix All Gaps</>
                        )}
                    </Button>
                </div>
            )}

            {/* Individual gap range alerts */}
            {gaps.map((gap) => (
                <GapRangeAlert
                    key={`${gap.start_date}-${gap.end_date}`}
                    gap={gap}
                    assetId={assetId}
                    assetName={assetName}
                    quoteAssetId={quoteAssetId}
                    quoteAssetName={quoteAssetName}
                    onComplete={onComplete}
                />
            ))}
        </div>
    );
};

export default PriceGapAlert;
