/**
 * PriceGapAlert — shared component that renders actionable alerts for price gaps.
 *
 * - Full mode: one alert per gap range, stacked vertically, each with CTAs
 * - Compact mode: a single badge ("N gaps") with a popover listing ranges
 *
 * CTAs per gap range:
 *   1. "Fetch Missing Prices" → useBackfillPrices mutation for that range
 *   2. "Fill Manually" → opens PriceSetterDialog in range mode with last_known_price
 *
 * A "Fix All Gaps" button at the top triggers sequential backfill for all ranges.
 */

import React, { useState } from 'react';
import {
    Badge,
    Box,
    Button,
    Flex,
    Spinner,
    Text,
} from '@chakra-ui/react';
import { FiAlertTriangle, FiDownload, FiEdit3, FiZap } from 'react-icons/fi';
import { GapRange, BackfillResponse } from '../types';
import { useBackfillPrices } from '../hooks/usePriceGaps';
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
    const backfill = useBackfillPrices();
    const [backfillResult, setBackfillResult] = useState<BackfillResponse | null>(null);
    const [showManual, setShowManual] = useState(false);

    const handleFetch = async () => {
        try {
            const result = await backfill.mutateAsync({
                asset_id: assetId,
                date_from: gap.start_date,
                date_to: gap.end_date,
            });
            setBackfillResult(result);
            if (result.failed.length === 0) {
                toaster.success({
                    title: 'Backfill complete',
                    description: `Fetched ${result.fetched.length} price(s) for ${assetName}`,
                });
            } else {
                toaster.info({
                    title: 'Partial backfill',
                    description: `Fetched ${result.fetched.length}, failed ${result.failed.length}. Consider manual fill for remaining dates.`,
                });
            }
            onComplete?.();
        } catch (err) {
            toaster.error({
                title: 'Backfill failed',
                description: err instanceof Error ? err.message : 'Unknown error',
            });
        }
    };

    const handleManualSaved = () => {
        setShowManual(false);
        onComplete?.();
    };

    const isFetching = backfill.isPending;

    // After a backfill attempt, show remaining failures
    const showFailures = backfillResult && backfillResult.failed.length > 0;

    return (
        <>
            <Box
                bg="orange.50"
                border="1px solid"
                borderColor="orange.200"
                borderRadius="md"
                p={3}
            >
                <Flex align="flex-start" gap={2}>
                    <Box color="orange.500" mt={0.5}>
                        <FiAlertTriangle size={16} />
                    </Box>
                    <Box flex={1}>
                        <Text fontSize="sm" fontWeight="medium" color="orange.800">
                            Missing prices: {fmtDate(gap.start_date)} — {fmtDate(gap.end_date)}
                            {' '}({gap.missing_days_count} day{gap.missing_days_count !== 1 ? 's' : ''})
                        </Text>
                        {gap.last_known_price != null && (
                            <Text fontSize="xs" color="gray.600" mt={0.5}>
                                Last known: {gap.last_known_price.toLocaleString()} ({gap.last_known_source ?? 'unknown'} on{' '}
                                {gap.last_known_price_date ? fmtDate(gap.last_known_price_date) : '?'})
                            </Text>
                        )}
                        {showFailures && (
                            <Text fontSize="xs" color="red.600" mt={1}>
                                {backfillResult!.failed.length} date(s) could not be fetched automatically.
                                Use "Fill Manually" for remaining dates.
                            </Text>
                        )}
                        <Flex gap={2} mt={2}>
                            <Button
                                size="xs"
                                colorPalette="orange"
                                variant="outline"
                                onClick={handleFetch}
                                disabled={isFetching}
                            >
                                {isFetching ? (
                                    <><Spinner size="xs" mr={1} /> Fetching...</>
                                ) : (
                                    <><FiDownload style={{ marginRight: 4 }} /> Fetch Missing Prices</>
                                )}
                            </Button>
                            <Button
                                size="xs"
                                variant="outline"
                                onClick={() => setShowManual(true)}
                            >
                                <FiEdit3 style={{ marginRight: 4 }} /> Fill Manually
                            </Button>
                        </Flex>
                    </Box>
                </Flex>
            </Box>

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
    const backfill = useBackfillPrices();
    const [fixingAll, setFixingAll] = useState(false);
    const [expandedCompact, setExpandedCompact] = useState(false);

    if (!gaps || gaps.length === 0) return null;

    const totalMissing = gaps.reduce((sum, g) => sum + g.missing_days_count, 0);

    // ── Compact mode: just a badge ────────────────────────────────────────
    if (compact) {
        return (
            <Box position="relative" display="inline-block">
                <Tooltip content={`${gaps.length} gap range(s), ${totalMissing} missing day(s)`}>
                    <Badge
                        size="sm"
                        colorPalette="orange"
                        variant="subtle"
                        cursor="pointer"
                        onClick={() => setExpandedCompact(!expandedCompact)}
                    >
                        {gaps.length} gap{gaps.length !== 1 ? 's' : ''}
                    </Badge>
                </Tooltip>
                {expandedCompact && (
                    <Box
                        position="absolute"
                        top="100%"
                        left={0}
                        mt={1}
                        zIndex={10}
                        bg="white"
                        border="1px solid"
                        borderColor="gray.200"
                        borderRadius="md"
                        boxShadow="md"
                        p={3}
                        minW="340px"
                        maxH="400px"
                        overflowY="auto"
                    >
                        <Flex direction="column" gap={2}>
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
                        </Flex>
                    </Box>
                )}
            </Box>
        );
    }

    // ── Full mode: stacked alerts ─────────────────────────────────────────

    const handleFixAll = async () => {
        setFixingAll(true);
        let totalFetched = 0;
        let totalFailed = 0;
        try {
            for (const gap of gaps) {
                const result = await backfill.mutateAsync({
                    asset_id: assetId,
                    date_from: gap.start_date,
                    date_to: gap.end_date,
                });
                totalFetched += result.fetched.length;
                totalFailed += result.failed.length;
            }
            if (totalFailed === 0) {
                toaster.success({
                    title: 'All gaps fixed',
                    description: `Fetched ${totalFetched} price(s) for ${assetName}`,
                });
            } else {
                toaster.info({
                    title: 'Partial fix',
                    description: `Fetched ${totalFetched}, failed ${totalFailed}. Some dates may need manual fill.`,
                });
            }
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
        <Flex direction="column" gap={2}>
            {/* Header with bulk action */}
            {gaps.length > 1 && (
                <Flex align="center" justify="space-between">
                    <Text fontSize="xs" color="orange.700" fontWeight="medium">
                        {gaps.length} gap range{gaps.length !== 1 ? 's' : ''} ({totalMissing} missing day{totalMissing !== 1 ? 's' : ''})
                    </Text>
                    <Button
                        size="xs"
                        colorPalette="orange"
                        variant="solid"
                        onClick={handleFixAll}
                        disabled={fixingAll}
                    >
                        {fixingAll ? (
                            <><Spinner size="xs" mr={1} /> Fixing all...</>
                        ) : (
                            <><FiZap style={{ marginRight: 4 }} /> Fix All Gaps</>
                        )}
                    </Button>
                </Flex>
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
        </Flex>
    );
};

export default PriceGapAlert;
