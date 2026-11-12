/**
 * GainsLossesBar — Gains on the left, Losses on the right, bars meeting at the centre.
 */
import React from 'react';

interface GainsLossesBarProps {
    gains: number;
    losses: number;
    gainCount?: number;
    lossCount?: number;
    format: (v: number) => string;
    testId?: string;
}

export const GainsLossesBar: React.FC<GainsLossesBarProps> = ({ gains, losses, gainCount, lossCount, format, testId }) => {
    const max = Math.max(Math.abs(gains), Math.abs(losses), 1);
    return (
        <div className="grid min-w-0 flex-1 grid-cols-[auto_1fr_1fr_auto] items-center gap-1.5 text-[11px]" data-testid={testId}>
            <span className="whitespace-nowrap text-gray-500">
                Gains <span className="font-bold tabular-nums text-green-600">{format(gains)}</span>
                {gainCount != null && <span className="text-gray-400"> · {gainCount}</span>}
            </span>
            <div className="flex h-3 justify-end bg-slate-100/70">
                <div className="h-full bg-green-400" style={{ width: `${(Math.abs(gains) / max) * 100}%` }} />
            </div>
            <div className="flex h-3 justify-start border-l border-slate-300 bg-slate-100/70">
                <div className="h-full bg-red-400" style={{ width: `${(Math.abs(losses) / max) * 100}%` }} />
            </div>
            <span className="whitespace-nowrap text-right text-gray-500">
                {lossCount != null && <span className="text-gray-400">{lossCount} · </span>}
                <span className="font-bold tabular-nums text-red-600">{format(losses)}</span> Losses
            </span>
        </div>
    );
};
