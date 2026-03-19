/**
 * PnLBreakdownBar — Reusable horizontal stacked bar showing the breakdown
 * of cost basis, unrealized P&L, realized P&L and fees.
 *
 * Segments are ordered: [negative PnL] | Cost + Fees | [positive PnL]
 * Fees are part of cost so they sit right next to the cost segment.
 */
import React, { useMemo } from 'react';
import { Box, Flex, Text } from '@chakra-ui/react';
import { Tooltip } from '../ui/tooltip';
import { fmtCurrency, fmtCurrencySigned } from './TotalReturnScorecard';

export interface PnLBreakdownBarProps {
    costBasis: number;
    unrealizedPnl: number;
    realizedPnl: number;
    fees: number;
    /** Show labelled legend below the bar */
    showLabels?: boolean;
    /** Bar height in px (default: 8) */
    height?: number;
    /** Base currency code for formatting (e.g. "USD") */
    baseCurrency?: string;
}

interface Segment {
    key: string;
    label: string;
    value: number;
    absValue: number;
    color: string;
    pct: number;
}

export const PnLBreakdownBar: React.FC<PnLBreakdownBarProps> = ({
    costBasis,
    unrealizedPnl,
    realizedPnl,
    fees,
    showLabels = false,
    height = 8,
    baseCurrency = 'USD',
}) => {
    const segments = useMemo(() => {
        const absUnrealized = Math.abs(unrealizedPnl);
        const absRealized = Math.abs(realizedPnl);
        const absFees = Math.abs(fees);
        const total = costBasis + absUnrealized + absRealized + absFees;
        if (total <= 0) return [];

        const pct = (v: number) => (v / total) * 100;

        // Collect negative segments (left of cost) and positive segments (right of cost)
        const left: Segment[] = [];
        const right: Segment[] = [];

        // Unrealized
        if (absUnrealized > 0.01) {
            const seg: Segment = {
                key: 'unrealized',
                label: 'Unrealized',
                value: unrealizedPnl,
                absValue: absUnrealized,
                color: unrealizedPnl >= 0 ? 'green.400' : 'red.400',
                pct: pct(absUnrealized),
            };
            (unrealizedPnl >= 0 ? right : left).push(seg);
        }

        // Realized
        if (absRealized > 0.01) {
            const seg: Segment = {
                key: 'realized',
                label: 'Realized',
                value: realizedPnl,
                absValue: absRealized,
                color: realizedPnl >= 0 ? 'green.600' : 'red.600',
                pct: pct(absRealized),
            };
            (realizedPnl >= 0 ? right : left).push(seg);
        }

        // Cost (centre)
        const costSeg: Segment = {
            key: 'cost',
            label: 'Cost Basis',
            value: costBasis,
            absValue: costBasis,
            color: 'gray.400',
            pct: pct(costBasis),
        };

        // Fees sit adjacent to cost (fees are part of cost)
        const feesSeg: Segment | null = absFees > 0.01
            ? { key: 'fees', label: 'Fees', value: fees, absValue: absFees, color: 'gray.500', pct: pct(absFees) }
            : null;

        const ordered = [...left, costSeg];
        if (feesSeg) ordered.push(feesSeg);
        ordered.push(...right);

        return ordered;
    }, [costBasis, unrealizedPnl, realizedPnl, fees]);

    if (segments.length === 0) return null;

    return (
        <Box>
            <Flex h={`${height}px`} borderRadius="full" overflow="hidden" bg="gray.100">
                {segments.map((seg) => (
                    <Tooltip
                        key={seg.key}
                        content={`${seg.label}: ${seg.key === 'cost' || seg.key === 'fees' ? fmtCurrency(seg.value, baseCurrency) : fmtCurrencySigned(seg.value, baseCurrency)}`}
                        openDelay={150}
                    >
                        <Box
                            h="100%"
                            w={`${seg.pct}%`}
                            bg={seg.color}
                            transition="width 0.3s"
                            _first={{ borderLeftRadius: 'full' }}
                            _last={{ borderRightRadius: 'full' }}
                        />
                    </Tooltip>
                ))}
            </Flex>

            {showLabels && (
                <Flex mt={1.5} gap={3} flexWrap="wrap">
                    {segments.map((seg) => (
                        <Flex key={seg.key} align="center" gap={1}>
                            <Box w="8px" h="8px" borderRadius="sm" bg={seg.color} flexShrink={0} />
                            <Text fontSize="2xs" color="gray.500">{seg.label}</Text>
                            <Text fontSize="2xs" fontWeight="semibold" color="gray.700">
                                {seg.key === 'cost' || seg.key === 'fees'
                                    ? fmtCurrency(seg.value, baseCurrency)
                                    : fmtCurrencySigned(seg.value, baseCurrency)}
                            </Text>
                        </Flex>
                    ))}
                </Flex>
            )}
        </Box>
    );
};

export default PnLBreakdownBar;
