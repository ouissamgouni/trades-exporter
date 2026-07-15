/**
 * PnLStatusBadge
 * 
 * Displays the current P&L calculation service status as a colored badge.
 * Shows stale reasons on hover via tooltip.
 * When completed, shows version ID and relative datetime inline.
 */

import React from 'react';
import { Badge, Spinner, type BadgeColorScheme } from '../ui/primitives';
import { Tooltip } from '../ui/tooltip';
import { PnLCalcStatus } from './types';
import { parseApiDate, formatDateTimeLocale } from '../../utils/dateUtils';

interface PnLStatusBadgeProps {
    status: PnLCalcStatus;
    staleReasons?: string[];
    lastCalculatedAt?: string | null;
    currentVersionId?: number | null;
    errorMessage?: string | null;
    size?: 'sm' | 'md';
    /** When true and status is 'completed', hide the "Up to date" label */
    compactWhenCompleted?: boolean;
}

const STATUS_CONFIG: Record<PnLCalcStatus, {
    label: string;
    colorScheme: BadgeColorScheme;
    icon?: string;
}> = {
    idle: { label: 'No calculation', colorScheme: 'gray' },
    stale: { label: 'P&L outdated', colorScheme: 'orange', icon: '⚠️' },
    calculating: { label: 'Calculating…', colorScheme: 'blue' },
    completed: { label: 'Up to date', colorScheme: 'green', icon: '✓' },
    error: { label: 'Calculation error', colorScheme: 'red', icon: '✗' },
};

/** Format a datetime string to a compact relative or absolute form */
function formatCalcTime(isoString: string): string {
    const date = parseApiDate(isoString);
    if (!date) return isoString;
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60_000);

    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    // Older than 24h: show compact date
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const PnLStatusBadge: React.FC<PnLStatusBadgeProps> = ({
    status,
    staleReasons = [],
    lastCalculatedAt,
    currentVersionId,
    errorMessage,
    size = 'sm',
    compactWhenCompleted = false,
}) => {
    const config = STATUS_CONFIG[status];

    // Build inline detail for completed status
    const inlineDetail = status === 'completed'
        ? [
            currentVersionId != null ? `v${currentVersionId}` : null,
            lastCalculatedAt ? formatCalcTime(lastCalculatedAt) : null,
        ].filter(Boolean).join(' · ')
        : null;

    const tooltipContent = status === 'error' && errorMessage
        ? `Error: ${errorMessage}`
        : status === 'stale' && staleReasons.length > 0
            ? `Changes detected:\n${staleReasons.slice(0, 5).join('\n')}${staleReasons.length > 5 ? `\n...and ${staleReasons.length - 5} more` : ''}`
            : lastCalculatedAt
                ? `Last calculated: ${formatDateTimeLocale(lastCalculatedAt)}`
                : undefined;

    const badge = (
        <Badge colorScheme={config.colorScheme}>
            <div className="flex items-center gap-1">
                {status === 'calculating' ? (
                    <Spinner size="xs" />
                ) : config.icon ? (
                    <span className="text-xs">{config.icon}</span>
                ) : null}
                {!(compactWhenCompleted && status === 'completed') && (
                    <span>{config.label}</span>
                )}
                {inlineDetail && (
                    <span className="text-[10px] opacity-70">· {inlineDetail}</span>
                )}
            </div>
        </Badge>
    );

    if (tooltipContent) {
        return (
            <Tooltip content={tooltipContent}>
                {badge}
            </Tooltip>
        );
    }

    return badge;
};
