/**
 * GapFixPanel — Shared chart + gap-range list with CTAs.
 *
 * Layout: price chart on the left, scrollable gap list on the right.
 * Used by both expanded HealthCard and AssetDetailSlidePanel.
 */

import React, { useState } from 'react';
import { Box, Button, Flex, Spinner, Text } from '@chakra-ui/react';
import { FiDownload, FiEdit3, FiZap } from 'react-icons/fi';
import { AssetPriceChart } from './AssetPriceChart';
import { AddManualPriceDialog } from './pnl/AddManualPriceDialog';
import { usePriceGaps, useBackfillPrices } from '../hooks/usePriceGaps';
import { GapRange } from '../types';
import { toaster } from './ui/toaster';

export interface GapFixPanelProps {
    assetId: number;
    symbol: string;
}

const fmtShort = (d: string) => {
    try {
        return new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
        return d;
    }
};

export const GapFixPanel: React.FC<GapFixPanelProps> = ({ assetId, symbol }) => {
    const { data: gapData, refetch } = usePriceGaps(assetId);
    const gaps = gapData?.gaps ?? [];
    const backfill = useBackfillPrices();
    const [fixingAll, setFixingAll] = useState(false);
    const [fetchingIdx, setFetchingIdx] = useState<number | null>(null);
    const [manualGap, setManualGap] = useState<GapRange | null>(null);

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
                toaster.success({ title: 'All gaps fixed', description: `Fetched ${totalFetched} price(s)` });
            } else {
                toaster.info({ title: 'Partial fix', description: `Fetched ${totalFetched}, failed ${totalFailed}` });
            }
            refetch();
        } catch (err) {
            toaster.error({ title: 'Fix all failed', description: err instanceof Error ? err.message : 'Unknown error' });
        } finally {
            setFixingAll(false);
        }
    };

    const handleFetchOne = async (gap: GapRange, idx: number) => {
        setFetchingIdx(idx);
        try {
            const result = await backfill.mutateAsync({
                asset_id: assetId,
                date_from: gap.start_date,
                date_to: gap.end_date,
            });
            if (result.failed.length === 0) {
                toaster.success({ title: 'Fetched', description: `${result.fetched.length} price(s)` });
            } else {
                toaster.info({ title: 'Partial', description: `Fetched ${result.fetched.length}, failed ${result.failed.length}` });
            }
            refetch();
        } catch (err) {
            toaster.error({ title: 'Fetch failed', description: err instanceof Error ? err.message : 'Unknown error' });
        } finally {
            setFetchingIdx(null);
        }
    };

    const totalMissing = gaps.reduce((s, g) => s + g.missing_days_count, 0);

    return (
        <>
            <Flex gap={3} align="stretch">
                {/* Left: chart */}
                <Box flex={2} minW={0}>
                    <AssetPriceChart assetId={assetId} symbol={symbol} gaps={gaps} />
                </Box>

                {/* Right: gap list */}
                {gaps.length > 0 && (
                    <Flex direction="column" flex={1} minW="160px" maxW="220px" gap={1}>
                        {/* Header + Fix All */}
                        <Flex align="center" justify="space-between" mb={0.5}>
                            <Text fontSize="2xs" color="orange.700" fontWeight="medium">
                                {gaps.length} range{gaps.length !== 1 ? 's' : ''} · {totalMissing}d
                            </Text>
                            <Button
                                size="2xs"
                                colorPalette="orange"
                                variant="solid"
                                onClick={handleFixAll}
                                disabled={fixingAll}
                                fontSize="2xs"
                            >
                                {fixingAll ? <Spinner size="xs" /> : <><FiZap size={10} /> Fix all</>}
                            </Button>
                        </Flex>

                        {/* Scrollable gap list */}
                        <Flex direction="column" gap={1} overflowY="auto" maxH="180px" pr={1}>
                            {gaps.map((gap, i) => (
                                <Box
                                    key={`${gap.start_date}-${gap.end_date}`}
                                    bg="orange.50"
                                    border="1px solid"
                                    borderColor="orange.100"
                                    borderRadius="sm"
                                    px={1.5}
                                    py={1}
                                >
                                    <Text fontSize="2xs" color="orange.800" fontWeight="medium" mb={0.5}>
                                        {fmtShort(gap.start_date)} — {fmtShort(gap.end_date)} ({gap.missing_days_count}d)
                                    </Text>
                                    <Flex gap={1}>
                                        <Button
                                            size="2xs"
                                            variant="outline"
                                            colorPalette="orange"
                                            fontSize="2xs"
                                            onClick={() => handleFetchOne(gap, i)}
                                            disabled={fetchingIdx === i}
                                        >
                                            {fetchingIdx === i ? <Spinner size="xs" /> : <><FiDownload size={10} /> Fetch</>}
                                        </Button>
                                        <Button
                                            size="2xs"
                                            variant="outline"
                                            fontSize="2xs"
                                            onClick={() => setManualGap(gap)}
                                        >
                                            <FiEdit3 size={10} /> Manual
                                        </Button>
                                    </Flex>
                                </Box>
                            ))}
                        </Flex>
                    </Flex>
                )}
            </Flex>

            {manualGap && (
                <AddManualPriceDialog
                    isOpen={true}
                    onClose={() => setManualGap(null)}
                    onSave={() => { setManualGap(null); refetch(); }}
                    assetId={assetId}
                    assetName={symbol}
                    defaultDate={manualGap.start_date}
                    quoteAssetName="USD"
                    defaultDateFrom={manualGap.start_date}
                    defaultDateTo={manualGap.end_date}
                    defaultPrice={manualGap.last_known_price}
                />
            )}
        </>
    );
};

export default GapFixPanel;
