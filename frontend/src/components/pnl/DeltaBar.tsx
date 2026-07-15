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
            <span className={`text-slate-400 ${size === 'sm' ? 'text-sm' : 'text-xs'}`}>
                —
            </span>
        );
    }

    const barW = size === 'sm' ? '40px' : '28px';
    const barH = size === 'sm' ? '5px' : '4px';

    // Tooltip content — always shows exact values
    const tooltipContent = (
        <div className="p-1 text-xs">
            {liveQty != null && (
                <div>Live: {formatQuantityFullPrecision(liveQty)}</div>
            )}
            {pnlQty != null && (
                <div>P&L: {formatQuantityFullPrecision(pnlQty)}</div>
            )}
            <div>
                Delta: {delta.delta >= 0 ? '+' : ''}
                {formatQuantityFullPrecision(delta.delta)} ({formatPct(delta.pct)})
            </div>
        </div>
    );

    // Green portion = how much matches (1 - gap), clamped 0–1
    const absPct = Math.abs(delta.pct);
    const greenFraction = Math.max(0, Math.min(1, 1 - absPct));

    return (
        <Tooltip content={tooltipContent} openDelay={200}>
            <div
                className="flex cursor-help items-center justify-center"
                style={{ width: barW, height: '16px' }}
            >
                <div
                    className="relative w-full overflow-hidden bg-red-300"
                    style={{ height: barH }}
                >
                    <div
                        className="h-full bg-green-400 transition-[width] duration-200"
                        style={{ width: `${(greenFraction * 100).toFixed(1)}%` }}
                    />
                </div>
            </div>
        </Tooltip>
    );
};
