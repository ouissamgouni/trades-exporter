/**
 * PnLStatusBadge
 * 
 * Displays the current P&L calculation service status as a colored badge.
 * Shows stale reasons on hover via tooltip.
 * When completed, shows version ID and relative datetime inline.
 */

import React from 'react';
import { Badge, Flex, Spinner, Text } from '@chakra-ui/react';
import { Tooltip } from '../ui/tooltip';
import { PnLCalcStatus } from './types';
import { parseApiDate, formatDateTimeLocale } from '../../utils/dateUtils';

interface PnLStatusBadgeProps {
    status: PnLCalcStatus;
    staleReasons?: string[];
    lastCalculatedAt?: string | null;
    currentVersionId?: number | null;
    size?: 'sm' | 'md';
}

const STATUS_CONFIG: Record<PnLCalcStatus, {
    label: string;
    colorPalette: string;
    icon?: string;
}> = {
    idle: { label: 'No calculation', colorPalette: 'gray' },
    stale: { label: 'P&L outdated', colorPalette: 'orange', icon: '⚠️' },
    calculating: { label: 'Calculating…', colorPalette: 'blue' },
    completed: { label: 'Up to date', colorPalette: 'green', icon: '✓' },
    error: { label: 'Calculation error', colorPalette: 'red', icon: '✗' },
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
    size = 'sm',
}) => {
    const config = STATUS_CONFIG[status];

    // Build inline detail for completed status
    const inlineDetail = status === 'completed'
        ? [
            currentVersionId != null ? `v${currentVersionId}` : null,
            lastCalculatedAt ? formatCalcTime(lastCalculatedAt) : null,
        ].filter(Boolean).join(' · ')
        : null;

    const tooltipContent = status === 'stale' && staleReasons.length > 0
        ? `Changes detected:\n${staleReasons.slice(0, 5).join('\n')}${staleReasons.length > 5 ? `\n...and ${staleReasons.length - 5} more` : ''}`
        : lastCalculatedAt
            ? `Last calculated: ${formatDateTimeLocale(lastCalculatedAt)}`
            : undefined;

    const badge = (
        <Badge
            colorPalette={config.colorPalette}
            size={size}
            variant="subtle"
        >
            <Flex align="center" gap={1}>
                {status === 'calculating' ? (
                    <Spinner size="xs" />
                ) : config.icon ? (
                    <Text as="span" fontSize="xs">{config.icon}</Text>
                ) : null}
                <Text as="span">{config.label}</Text>
                {inlineDetail && (
                    <Text as="span" fontSize="2xs" opacity={0.7}>· {inlineDetail}</Text>
                )}
            </Flex>
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
