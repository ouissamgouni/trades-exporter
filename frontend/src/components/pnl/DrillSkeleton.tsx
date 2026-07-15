/**
 * DrillSkeleton
 *
 * Loading skeleton placeholder shown while drill-down data is being fetched.
 * Provides visual continuity during L1 (asset detail) and L2 (event detail) loads.
 *
 * Variants:
 *  - 'asset': Skeleton for asset detail view (header + stats + table)
 *  - 'event': Skeleton for event impact view (header + breakdown)
 */

import React from 'react';
import { Skeleton } from '../ui/primitives';

export type DrillSkeletonVariant = 'asset' | 'event';

interface DrillSkeletonProps {
    variant?: DrillSkeletonVariant;
}

/** Stat card placeholder */
const StatSkeleton: React.FC = () => (
    <div className="flex-1 border border-slate-200 p-4">
        <Skeleton height="12px" width="60%" className="mb-2" />
        <Skeleton height="24px" width="80%" className="mb-1" />
        <Skeleton height="10px" width="40%" />
    </div>
);

/** Table row placeholder */
const RowSkeleton: React.FC = () => (
    <div className="flex items-center gap-3 px-3 py-2">
        <Skeleton height="14px" width="25%" />
        <Skeleton height="14px" width="15%" />
        <Skeleton height="14px" width="20%" />
        <Skeleton height="14px" width="15%" />
        <Skeleton height="14px" width="10%" />
    </div>
);

/** Asset detail skeleton: header + 4 stat cards + 6 table rows */
const AssetSkeleton: React.FC = () => (
    <div>
        {/* Header */}
        <div className="mb-4 flex items-center gap-3">
            <Skeleton height="28px" width="120px" />
            <Skeleton height="20px" width="80px" />
        </div>

        {/* Stat cards row */}
        <div className="mb-6 flex gap-3">
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
        </div>

        {/* Table header */}
        <Skeleton height="14px" width="200px" className="mb-3" />

        {/* Table rows */}
        <div className="overflow-hidden border border-slate-200">
            {Array.from({ length: 6 }, (_, i) => (
                <RowSkeleton key={i} />
            ))}
        </div>
    </div>
);

/** Event detail skeleton: header + 2-column breakdown */
const EventSkeleton: React.FC = () => (
    <div>
        {/* Header */}
        <div className="mb-4 flex items-center gap-3">
            <Skeleton height="24px" width="180px" />
            <Skeleton height="16px" width="60px" />
        </div>

        {/* Summary stats */}
        <div className="mb-6 flex gap-3">
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
        </div>

        {/* Breakdown list */}
        <Skeleton height="14px" width="160px" className="mb-3" />
        <div className="overflow-hidden border border-slate-200">
            {Array.from({ length: 4 }, (_, i) => (
                <RowSkeleton key={i} />
            ))}
        </div>
    </div>
);

export const DrillSkeleton: React.FC<DrillSkeletonProps> = ({ variant = 'asset' }) => {
    return variant === 'event' ? <EventSkeleton /> : <AssetSkeleton />;
};
