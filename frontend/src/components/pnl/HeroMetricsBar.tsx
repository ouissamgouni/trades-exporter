/**
 * HeroMetricsBar — Shared hero + metrics + PnL breakdown bar layout.
 *
 * Layout:  Hero (left)  |  Metrics row (right, top) + PnL bar (right, bottom)
 *
 * Used by both TimeframeIndicators (L0) and PnLDetailPanel (L1/L2).
 */
import React from 'react';
import { Badge, Box, Flex, Text } from '@chakra-ui/react';
import { FiTrendingUp, FiTrendingDown } from 'react-icons/fi';
import { PnLBreakdownBar } from './PnLBreakdownBar';

export interface HeroMetricsBarProps {
    totalReturn: number;
    roi: number;
    baseCurrency: string;
    /** PnL breakdown bar values */
    costBasisInPeriod: number;
    unrealizedInPeriod: number;
    realizedInPeriod: number;
    feesInPeriod: number;
    /** Metric items rendered on the right */
    children: React.ReactNode;
    /** Format helpers passed in to avoid coupling to TotalReturnScorecard */
    fmtCurrencySigned: (v: number, c: string) => string;
    color: (v: number) => string;
}

export const HeroMetricsBar: React.FC<HeroMetricsBarProps> = ({
    totalReturn,
    roi,
    baseCurrency,
    costBasisInPeriod,
    unrealizedInPeriod,
    realizedInPeriod,
    feesInPeriod,
    children,
    fmtCurrencySigned: fmtSigned,
    color,
}) => (
    <Flex gap={2} align="stretch">
        {/* LEFT: Hero card — horizontal layout */}
        <Flex
            align="center"
            justify="center"
            gap={2}
            py={2}
            px={3}
            bg={totalReturn >= 0 ? 'green.50' : 'red.50'}
            borderRadius="md"
            direction="row"
            flexShrink={0}
        >
            {totalReturn >= 0
                ? <FiTrendingUp size={20} color="var(--chakra-colors-green-600)" />
                : <FiTrendingDown size={20} color="var(--chakra-colors-red-600)" />
            }
            <Text fontSize="xl" fontWeight="bold" color={color(totalReturn)} whiteSpace="nowrap">
                {fmtSigned(totalReturn, baseCurrency)}
            </Text>
            <Badge
                colorPalette={roi >= 0 ? 'green' : 'red'}
                variant="subtle"
                size="sm"
                px={2}
            >
                {roi >= 0 ? '+' : ''}{roi.toFixed(2)}%
            </Badge>
        </Flex>

        {/* RIGHT: Metrics row + PnL bar underneath */}
        <Box flex="1" minW={0}>
            <Flex gap={1} align="stretch" flexWrap="wrap" mb={1}>
                {children}
            </Flex>
            <PnLBreakdownBar
                costBasis={costBasisInPeriod}
                unrealizedPnl={unrealizedInPeriod}
                realizedPnl={realizedInPeriod}
                fees={feesInPeriod}
                baseCurrency={baseCurrency}
                height={6}
            />
        </Box>
    </Flex>
);
