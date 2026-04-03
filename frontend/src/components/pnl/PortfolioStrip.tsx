/**
 * PortfolioStrip — Compact always-visible bar showing portfolio-level metrics.
 *
 * Hidden at portfolio level (no duplication).
 * Visible when drilled into category/account/asset as a context anchor.
 */
import React from 'react';
import { Badge, Box, Flex, Text } from '@chakra-ui/react';
import { FiTrendingUp, FiTrendingDown, FiDollarSign, FiAlertTriangle, FiActivity, FiRefreshCw } from 'react-icons/fi';
import { LuReceipt } from 'react-icons/lu';
import { MetricItem, fmtCurrency, fmtCurrencySigned } from './TotalReturnScorecard';
import type { ScorecardSummary } from './TotalReturnScorecard';
import type { PnLSummary } from './types';
import type { BalanceHealthData } from './SummaryCards';
import type { PriceResponse } from '../../types';
import type { TimelinePoint } from '../../hooks/useChartData';

/** Tiny SVG sparkline */
const Sparkline: React.FC<{ points: TimelinePoint[]; width?: number; height?: number }> = ({ points, width = 80, height = 20 }) => {
    if (points.length < 2) return null;
    const values = points.map(p => {
        const cb = p.cost_basis_in_base;
        if (cb <= 0) return 0;
        return ((p.unrealized_pnl + p.cumulative_realized_pnl) / cb) * 100;
    });
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const coords = values.map((v, i) =>
        `${(i / (values.length - 1)) * width},${height - ((v - min) / range) * (height - 2) - 1}`
    ).join(' ');
    const isPositive = values[values.length - 1] >= values[0];
    return (
        <svg width={width} height={height} style={{ display: 'block', flexShrink: 0, border: '1px solid #E2E8F0', borderRadius: 4 }}>
            <polyline fill="none" stroke={isPositive ? '#38A169' : '#E53E3E'} strokeWidth={1.5} points={coords} />
        </svg>
    );
};

export interface PortfolioStripProps {
    summary: ScorecardSummary | null;
    baseCurrency: string;
    prices: PriceResponse[];
    pnlSummary: PnLSummary | null;
    balanceHealth: BalanceHealthData | undefined;
    timelinePoints: TimelinePoint[];
}

export const PortfolioStrip: React.FC<PortfolioStripProps> = ({
    summary,
    baseCurrency,
    prices,
    pnlSummary,
    balanceHealth,
    timelinePoints,
}) => {
    if (!summary) return null;

    const totalReturn = summary.unrealizedPnl + summary.realizedPnl;
    const roi = summary.costBasis > 0 ? (totalReturn / summary.costBasis) * 100 : 0;
    const color = (v: number) => (v >= 0 ? 'green.600' : 'red.600');

    const freshCount = prices.filter(p => !p.error && p.price != null && !p.is_stale).length;
    const staleCount = prices.filter(p => !p.error && p.price != null && p.is_stale).length;
    const errorCount = prices.filter(p => !!p.error || p.price == null).length;
    const priceTotal = freshCount + staleCount + errorCount;

    return (
        <Flex
            align="center"
            gap={2}
            px={3}
            py={1.5}
            mb={2}
            bg="gray.50"
            borderRadius="lg"
            border="1px solid"
            borderColor="gray.200"
            flexWrap="wrap"
        >
            <Badge colorPalette="gray" variant="subtle" size="xs">Portfolio</Badge>

            <MetricItem
                label="ROI"
                value={`${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`}
                color={color(totalReturn)}
                icon={totalReturn >= 0 ? <FiTrendingUp size={10} /> : <FiTrendingDown size={10} />}
                bg={totalReturn >= 0 ? 'green.50' : 'red.50'}
            />
            <MetricItem
                label="Value"
                value={fmtCurrency(summary.portfolioValue, baseCurrency)}
                color="gray.800"
                icon={<FiDollarSign size={10} />}
                bg="blue.50"
            />
            <MetricItem
                label="Cost"
                value={fmtCurrency(summary.costBasis, baseCurrency)}
                color="gray.700"
                icon={<LuReceipt size={10} />}
                bg="gray.100"
            />
            <MetricItem
                label="Fees"
                value={fmtCurrency(summary.totalFees, baseCurrency)}
                color="orange.700"
                icon={<LuReceipt size={10} />}
                bg="orange.50"
            />

            <Sparkline points={timelinePoints} />

            {/* Mini badges */}
            <Flex gap={1.5} ml="auto" align="center" flexShrink={0}>
                {priceTotal > 0 && (
                    <Flex align="center" gap={1} px={1.5} py={0.5} bg={errorCount > 0 ? 'red.50' : staleCount > 0 ? 'orange.50' : 'green.50'} borderRadius="md" flexShrink={0}>
                        <FiRefreshCw size={10} color={errorCount > 0 ? 'var(--chakra-colors-red-500)' : staleCount > 0 ? 'var(--chakra-colors-orange-500)' : 'var(--chakra-colors-green-500)'} />
                        <Text fontSize="xs" fontWeight="semibold" color={errorCount > 0 ? 'red.600' : staleCount > 0 ? 'orange.600' : 'green.600'}>{freshCount}/{priceTotal}</Text>
                    </Flex>
                )}
                {pnlSummary && pnlSummary.warning_count > 0 && (
                    <Flex align="center" gap={1} px={1.5} py={0.5} bg={pnlSummary.error_count > 0 ? 'red.50' : 'orange.50'} borderRadius="md" flexShrink={0}>
                        <FiAlertTriangle size={10} color={pnlSummary.error_count > 0 ? 'var(--chakra-colors-red-500)' : 'var(--chakra-colors-orange-500)'} />
                        <Text fontSize="xs" fontWeight="semibold" color={pnlSummary.error_count > 0 ? 'red.600' : 'orange.600'}>{pnlSummary.warning_count}</Text>
                    </Flex>
                )}
                {balanceHealth && balanceHealth.mismatchCount > 0 && (
                    <Flex align="center" gap={1} px={1.5} py={0.5} bg="orange.50" borderRadius="md" flexShrink={0}>
                        <FiActivity size={10} color="var(--chakra-colors-orange-500)" />
                        <Text fontSize="xs" fontWeight="semibold" color="orange.600">{balanceHealth.mismatchCount}</Text>
                    </Flex>
                )}
            </Flex>
        </Flex>
    );
};
