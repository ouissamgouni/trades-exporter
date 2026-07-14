/**
 * PnLBreakdownBar — Reusable horizontal stacked bar showing the breakdown
 * of cost basis, unrealized P&L, realized P&L and fees.
 *
 * Segments are ordered: [negative PnL] | Cost + Fees | [positive PnL]
 * Fees are part of cost so they sit right next to the cost segment.
 */
import React, { useMemo } from 'react';
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
                color: unrealizedPnl >= 0 ? 'bg-green-400' : 'bg-red-400',
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
                color: realizedPnl >= 0 ? 'bg-green-600' : 'bg-red-600',
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
            color: 'bg-slate-400',
            pct: pct(costBasis),
        };

        // Fees sit adjacent to cost (fees are part of cost)
        const feesSeg: Segment | null = absFees > 0.01
            ? { key: 'fees', label: 'Fees', value: fees, absValue: absFees, color: 'bg-slate-500', pct: pct(absFees) }
            : null;

        const ordered = [...left, costSeg];
        if (feesSeg) ordered.push(feesSeg);
        ordered.push(...right);

        return ordered;
    }, [costBasis, unrealizedPnl, realizedPnl, fees]);

    if (segments.length === 0) return null;

    return (
        <div>
            <div className="flex overflow-hidden bg-slate-100" style={{ height: `${height}px` }}>
                {segments.map((seg) => (
                    <Tooltip
                        key={seg.key}
                        content={`${seg.label}: ${seg.key === 'cost' || seg.key === 'fees' ? fmtCurrency(seg.value, baseCurrency) : fmtCurrencySigned(seg.value, baseCurrency)}`}
                        openDelay={150}
                    >
                        <div
                            className={`h-full transition-[width] duration-300 ${seg.color}`}
                            style={{ width: `${seg.pct}%` }}
                        />
                    </Tooltip>
                ))}
            </div>

            {showLabels && (
                <div className="mt-1.5 flex flex-wrap gap-3">
                    {segments.map((seg) => (
                        <div key={seg.key} className="flex items-center gap-1">
                            <span className={`h-2 w-2 flex-shrink-0 ${seg.color}`} />
                            <span className="text-[10px] text-slate-500">{seg.label}</span>
                            <span className="text-[10px] font-semibold text-slate-700">
                                {seg.key === 'cost' || seg.key === 'fees'
                                    ? fmtCurrency(seg.value, baseCurrency)
                                    : fmtCurrencySigned(seg.value, baseCurrency)}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default PnLBreakdownBar;
