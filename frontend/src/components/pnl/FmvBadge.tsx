/**
 * FmvBadge — Compact badge showing FMV price with source/timestamp tooltip.
 *
 * Used in Realized P&L and Cost Lot Events to show price transparency.
 */

import React from 'react';
import { Badge, type BadgeColorScheme } from '../ui/primitives';
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

const SOURCE_COLORS: Record<string, BadgeColorScheme> = {
    fmv_lookup: 'blue',
    fmv: 'blue',
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
    const colorScheme: BadgeColorScheme = stale ? 'yellow' : SOURCE_COLORS[source || ''] || 'gray';

    if (!hasFmvDetails) {
        // No FMV details — just show value plainly
        return <ValueDisplay value={value} currency={baseCurrency} />;
    }

    const tooltipContent = (
        <div className="text-xs leading-relaxed">
            <span className="mb-0.5 block font-semibold">
                {stale ? '⚠ Stale FMV Price' : 'FMV Price Details'}
            </span>
            {price != null && (
                <div className="flex gap-1">
                    <span className="text-slate-300">Price:</span>
                    <span>{Number(price).toFixed(6)} {baseCurrency}</span>
                </div>
            )}
            {priceSource && (
                <div className="flex gap-1">
                    <span className="text-slate-300">Source:</span>
                    <span>{priceSource}</span>
                </div>
            )}
            {timestamp && (
                <div className="flex gap-1">
                    <span className="text-slate-300">Time:</span>
                    <span>{new Date(timestamp).toLocaleString()}</span>
                </div>
            )}
        </div>
    );

    return (
        <Tooltip content={tooltipContent} openDelay={200}>
            <Badge colorScheme={colorScheme} className="cursor-help font-mono font-medium">
                <ValueDisplay value={value} currency={baseCurrency} />
            </Badge>
        </Tooltip>
    );
};
