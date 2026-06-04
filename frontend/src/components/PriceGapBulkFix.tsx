import React from 'react';
import { Box, Button, Flex, Progress, Spinner, Text } from '@chakra-ui/react';
import { FiZap } from 'react-icons/fi';
import { useBackfillAllPriceGaps } from '../hooks/usePriceGaps';
import type { BackfillAllPriceGapsProgress } from '../hooks/usePriceGaps';
import { toaster } from './ui/toaster';

interface PriceGapBulkFixProps {
    quoteAssetId?: number | null;
    onComplete?: (progress: BackfillAllPriceGapsProgress) => void | Promise<void>;
    compact?: boolean;
}

export const PriceGapBulkFix: React.FC<PriceGapBulkFixProps> = ({
    quoteAssetId,
    onComplete,
    compact = false,
}) => {
    const { progress, progressPercent, isRunning, run } = useBackfillAllPriceGaps(quoteAssetId);
    const hasProgress = progress.status !== 'idle';

    const handleRun = async () => {
        try {
            const result = await run();
            if (result.totalRanges === 0) {
                toaster.info({ title: 'No gaps found', description: 'All transaction-backed assets are covered.' });
            } else if (result.failedCount > 0) {
                toaster.info({ title: 'Partial gap fix', description: `Fetched ${result.fetchedCount}, failed ${result.failedCount}` });
            } else {
                toaster.success({ title: 'All gaps fixed', description: `Fetched ${result.fetchedCount} price(s)` });
            }
            await onComplete?.(result);
        } catch (err) {
            toaster.error({ title: 'Gap fix failed', description: err instanceof Error ? err.message : 'Unknown error' });
        }
    };

    return (
        <Box minW={compact ? '220px' : '280px'} maxW={compact ? '100%' : '380px'}>
            <Flex align="center" gap={2} justify={compact ? 'flex-start' : 'flex-end'}>
                <Button
                    size={compact ? 'xs' : 'sm'}
                    colorPalette="blue"
                    onClick={handleRun}
                    disabled={isRunning}
                >
                    {isRunning ? <Spinner size="xs" /> : <FiZap />}
                    <Text as="span">{isRunning ? 'Fixing gaps' : 'Fix all gaps'}</Text>
                </Button>
            </Flex>

            {hasProgress && (
                <Box mt={2}>
                    <Flex justify="space-between" align="center" mb={1} gap={2}>
                        <Text fontSize="xs" color={progress.status === 'error' ? 'red.600' : 'gray.600'} truncate>
                            {progress.status === 'scanning'
                                ? 'Scanning transaction assets...'
                                : progress.status === 'running'
                                    ? `${progress.currentAssetSymbol ?? 'Asset'} · ${progress.currentRange ?? ''}`
                                    : progress.status === 'complete'
                                        ? 'Gap fix complete'
                                        : progress.error ?? 'Gap fix failed'}
                        </Text>
                        <Text fontSize="xs" color="gray.500" whiteSpace="nowrap">
                            {progress.completedRanges}/{progress.totalRanges}
                        </Text>
                    </Flex>
                    <Progress.Root
                        value={progressPercent}
                        max={100}
                        size="sm"
                        colorPalette={progress.status === 'error' || progress.failedCount > 0 ? 'orange' : 'blue'}
                    >
                        <Progress.Track>
                            <Progress.Range />
                        </Progress.Track>
                    </Progress.Root>
                    <Flex mt={1} gap={3} fontSize="xs" color="gray.500" wrap="wrap">
                        <Text>{progress.assetsWithGaps} asset{progress.assetsWithGaps !== 1 ? 's' : ''}</Text>
                        <Text>{progress.totalMissingDays} missing day{progress.totalMissingDays !== 1 ? 's' : ''}</Text>
                        <Text color="green.600">{progress.fetchedCount} fetched</Text>
                        {progress.failedCount > 0 && <Text color="red.600">{progress.failedCount} failed</Text>}
                    </Flex>
                </Box>
            )}
        </Box>
    );
};

export default PriceGapBulkFix;
