/**
 * HeroMetricsBar — Shared hero + metrics + PnL breakdown bar layout.
 *
 * Layout:  Hero (left)  |  Metrics row (right, top) + PnL bar (right, bottom)
 *
 * Used by both TimeframeIndicators (L0) and PnLDetailPanel (L1/L2).
 */
import React from 'react';
import { Badge, Text } from '../ui/primitives';
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
}) => {
    // `color` keeps the Chakra-style dot-notation token format (e.g. "green.600") for
    // backward compatibility with callers; convert it to a Tailwind text-* class here.
    const colorClass = (val: number) => {
        const token = color(val);
        const parts = token.split('.');
        return parts.length === 2 ? `text-${parts[0]}-${parts[1]}` : 'text-gray-700';
    };

    return (
        <div className="flex items-stretch gap-2">
            {/* LEFT: Hero card — horizontal layout */}
            <div
                className={`flex shrink-0 flex-row items-center justify-center gap-2 px-3 py-2 ${totalReturn >= 0 ? 'bg-green-50' : 'bg-red-50'}`}
            >
                {totalReturn >= 0
                    ? <FiTrendingUp size={20} color="#16a34a" />
                    : <FiTrendingDown size={20} color="#dc2626" />
                }
                <Text className={`whitespace-nowrap text-xl font-bold ${colorClass(totalReturn)}`}>
                    {fmtSigned(totalReturn, baseCurrency)}
                </Text>
                <Badge
                    colorScheme={roi >= 0 ? 'green' : 'red'}
                    className="px-2"
                >
                    {roi >= 0 ? '+' : ''}{roi.toFixed(2)}%
                </Badge>
            </div>

            {/* RIGHT: Metrics row + PnL bar underneath */}
            <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-stretch gap-1">
                    {children}
                </div>
                <PnLBreakdownBar
                    costBasis={costBasisInPeriod}
                    unrealizedPnl={unrealizedInPeriod}
                    realizedPnl={realizedInPeriod}
                    fees={feesInPeriod}
                    baseCurrency={baseCurrency}
                    height={6}
                />
            </div>
        </div>
    );
};

