/**
 * FmvBadge — Compact badge showing FMV price with source/timestamp tooltip.
 *
 * Used in Realized P&L and Cost Lot Events to show price transparency.
 */

import React from 'react';
import { Badge, Box, Flex, Text } from '@chakra-ui/react';
import { Tooltip } from '../ui/tooltip';
import { ValueDisplay } from '../ValueDisplay';

export interface FmvBadgeProps {
    /** The total value in base currency (proceeds or cost basis) */
    value: number;
    baseCurrency: string;
    /** How the value was determined */
    source?: 'fmv_lookup' | 'base_currency' | 'transfer' | 'fmv' | 'provisional' | 'inherited' | 'proceeds' | string;
    /** Unit price used for FMV calculation */
    price?: number | null;
    /** Price provider (e.g., "coingecko", "manual", "fallback") */
    priceSource?: string | null;
    /** ISO timestamp when price was fetched/valid */
    timestamp?: string | null;
    /** Whether the price was flagged as stale */
    stale?: boolean;
}

const SOURCE_COLORS: Record<string, string> = {
    fmv_lookup: 'cyan',
    fmv: 'cyan',
    provisional: 'orange',
    base_currency: 'gray',
    transfer: 'blue',
    inherited: 'blue',
    proceeds: 'green',
};

export const FmvBadge: React.FC<FmvBadgeProps> = ({
    value,
    baseCurrency,
    source,
    price,
    priceSource,
    timestamp,
    stale,
}) => {
    const hasFmvDetails = price != null || priceSource || timestamp;
    const colorPalette = stale ? 'yellow' : SOURCE_COLORS[source || ''] || 'gray';

    if (!hasFmvDetails) {
        // No FMV details — just show value plainly
        return <ValueDisplay value={value} currency={baseCurrency} />;
    }

    const tooltipContent = (
        <Box fontSize="xs" lineHeight="tall">
            <Text fontWeight="semibold" mb={0.5}>
                {stale ? '⚠ Stale FMV Price' : 'FMV Price Details'}
            </Text>
            {price != null && (
                <Flex gap={1}>
                    <Text color="gray.300">Price:</Text>
                    <Text>{Number(price).toFixed(6)} {baseCurrency}</Text>
                </Flex>
            )}
            {priceSource && (
                <Flex gap={1}>
                    <Text color="gray.300">Source:</Text>
                    <Text>{priceSource}</Text>
                </Flex>
            )}
            {timestamp && (
                <Flex gap={1}>
                    <Text color="gray.300">Time:</Text>
                    <Text>{new Date(timestamp).toLocaleString()}</Text>
                </Flex>
            )}
        </Box>
    );

    return (
        <Tooltip content={tooltipContent} openDelay={200}>
            <Badge
                size="xs"
                colorPalette={colorPalette}
                cursor="help"
                fontFamily="mono"
                fontWeight="medium"
                variant="subtle"
            >
                <ValueDisplay value={value} currency={baseCurrency} />
            </Badge>
        </Tooltip>
    );
};
