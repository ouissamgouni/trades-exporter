/**
 * DrillEmptyState
 *
 * Empty state placeholder shown when a drill-down level has no data,
 * e.g., no lots for an asset, no realized entries in a period, no matching filters.
 *
 * Provides contextual messaging per drill level and an optional action button.
 */

import React from 'react';
import { Button } from '../ui/primitives';

type DrillLevel = 'portfolio' | 'asset' | 'event';

interface DrillEmptyStateProps {
    /** Current drill level for contextual messaging */
    level: DrillLevel;
    /** Optional filter description (e.g., "in the last 3 months") */
    filterDescription?: string;
    /** Optional action button label */
    actionLabel?: string;
    /** Optional action callback */
    onAction?: () => void;
}

const LEVEL_CONFIG: Record<DrillLevel, { icon: string; title: string; description: string }> = {
    portfolio: {
        icon: '📊',
        title: 'No Assets Found',
        description: 'No assets match the current filters. Try adjusting your account selection or running a new calculation.',
    },
    asset: {
        icon: '📋',
        title: 'No Data for This Asset',
        description: 'No cost lots or realized entries found for this asset in the current calculation.',
    },
    event: {
        icon: '🔍',
        title: 'No Events Found',
        description: 'No realized P&L events match the current filters.',
    },
};

export const DrillEmptyState: React.FC<DrillEmptyStateProps> = ({
    level,
    filterDescription,
    actionLabel,
    onAction,
}) => {
    const config = LEVEL_CONFIG[level];

    return (
        <div className="flex flex-col items-center justify-center bg-slate-50 px-6 py-16 text-center">
            <span className="mb-3 text-3xl">{config.icon}</span>
            <span className="mb-2 text-base font-semibold text-slate-600">
                {config.title}
            </span>
            <span className={`max-w-[400px] text-slate-400 ${filterDescription ? 'mb-2' : 'mb-0'}`}>
                {config.description}
            </span>
            {filterDescription && (
                <div className="mt-2 bg-slate-100 px-3 py-1 text-xs text-slate-500">
                    Filter: {filterDescription}
                </div>
            )}
            {actionLabel && onAction && (
                <Button
                    className="mt-4"
                    size="sm"
                    colorScheme="blue"
                    variant="outline"
                    onClick={onAction}
                >
                    {actionLabel}
                </Button>
            )}
        </div>
    );
};
