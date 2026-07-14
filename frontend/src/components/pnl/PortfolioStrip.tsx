/**
 * PortfolioStrip — Compact always-visible bar showing portfolio-level metrics.
 *
 * Hidden at portfolio level (no duplication).
 * Visible when drilled into category/account/asset as a context anchor.
 */
import React from 'react';
import { Badge, Text } from '../ui/primitives';
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
            <polyline fill="none" stroke={isPositive ? '#16a34a' : '#dc2626'} strokeWidth={1.5} points={coords} />
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
        <div className="mb-2 flex flex-wrap items-center gap-2 border border-gray-200 bg-gray-50 px-3 py-1.5">
            <Badge colorScheme="gray" className="text-xs">Portfolio</Badge>

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
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {priceTotal > 0 && (
                    <div className={`flex shrink-0 items-center gap-1 px-1.5 py-0.5 ${errorCount > 0 ? 'bg-red-50' : staleCount > 0 ? 'bg-orange-50' : 'bg-green-50'}`}>
                        <FiRefreshCw size={10} color={errorCount > 0 ? '#dc2626' : staleCount > 0 ? '#f97316' : '#16a34a'} />
                        <Text className={`text-xs font-semibold ${errorCount > 0 ? 'text-red-600' : staleCount > 0 ? 'text-orange-600' : 'text-green-600'}`}>{freshCount}/{priceTotal}</Text>
                    </div>
                )}
                {pnlSummary && pnlSummary.warning_count > 0 && (
                    <div className={`flex shrink-0 items-center gap-1 px-1.5 py-0.5 ${pnlSummary.error_count > 0 ? 'bg-red-50' : 'bg-orange-50'}`}>
                        <FiAlertTriangle size={10} color={pnlSummary.error_count > 0 ? '#dc2626' : '#f97316'} />
                        <Text className={`text-xs font-semibold ${pnlSummary.error_count > 0 ? 'text-red-600' : 'text-orange-600'}`}>{pnlSummary.warning_count}</Text>
                    </div>
                )}
                {balanceHealth && balanceHealth.mismatchCount > 0 && (
                    <div className="flex shrink-0 items-center gap-1 bg-orange-50 px-1.5 py-0.5">
                        <FiActivity size={10} color="#f97316" />
                        <Text className="text-xs font-semibold text-orange-600">{balanceHealth.mismatchCount}</Text>
                    </div>
                )}
            </div>
        </div>
    );
};
