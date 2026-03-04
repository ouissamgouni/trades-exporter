/**
 * DeltaBar — Compact visual indicator for P&L vs Live balance delta.
 *
 * Always renders as a horizontal mini bar:
 * • 100% green   → quantities match (< 0.01% gap)
 * • 100% red     → total mismatch (one side is effectively zero)
 * • green|red    → partial mismatch; green = matched portion, red = gap
 *
 * Exact numbers (Live, P&L, absolute delta, %) are always in the tooltip.
 */

import React from 'react';
import { Box, Flex, Text } from '@chakra-ui/react';
import { Tooltip } from '../ui/tooltip';
import { formatQuantityFullPrecision } from '../../utils/numberUtils';
import { type DeltaInfo, formatPct } from './deltaUtils';

// ------------------------------------------------------------------
// Props
// ------------------------------------------------------------------

interface DeltaBarProps {
    /** Pre-computed delta info (from computeDelta). null → render "—" */
    delta: DeltaInfo | null;
    /** Raw live quantity (for tooltip) */
    liveQty?: number;
    /** Raw P&L quantity (for tooltip) */
    pnlQty?: number;
    /** Visual size variant */
    size?: 'sm' | 'xs';
}

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

export const DeltaBar: React.FC<DeltaBarProps> = ({
    delta,
    liveQty,
    pnlQty,
    size = 'sm',
}) => {
    if (!delta) {
        return (
            <Text fontSize={size} color="gray.400">
                —
            </Text>
        );
    }

    const barW = size === 'sm' ? '40px' : '28px';
    const barH = size === 'sm' ? '5px' : '4px';

    // Tooltip content — always shows exact values
    const tooltipContent = (
        <Box p={1} fontSize="xs">
            {liveQty != null && (
                <Text>Live: {formatQuantityFullPrecision(liveQty)}</Text>
            )}
            {pnlQty != null && (
                <Text>P&L: {formatQuantityFullPrecision(pnlQty)}</Text>
            )}
            <Text>
                Delta: {delta.delta >= 0 ? '+' : ''}
                {formatQuantityFullPrecision(delta.delta)} ({formatPct(delta.pct)})
            </Text>
        </Box>
    );

    // Green portion = how much matches (1 - gap), clamped 0–1
    const absPct = Math.abs(delta.pct);
    const greenFraction = Math.max(0, Math.min(1, 1 - absPct));

    return (
        <Tooltip content={tooltipContent} openDelay={200}>
            <Flex
                align="center"
                justify="center"
                cursor="help"
                w={barW}
                h="16px"
            >
                <Box
                    w="100%"
                    h={barH}
                    borderRadius="full"
                    overflow="hidden"
                    bg="red.300"
                    position="relative"
                >
                    <Box
                        h="100%"
                        w={`${(greenFraction * 100).toFixed(1)}%`}
                        bg="green.400"
                        borderRadius="full"
                        transition="width 0.2s"
                    />
                </Box>
            </Flex>
        </Tooltip>
    );
};
