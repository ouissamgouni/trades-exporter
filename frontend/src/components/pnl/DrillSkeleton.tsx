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
import { Box, Flex, Skeleton } from '@chakra-ui/react';

export type DrillSkeletonVariant = 'asset' | 'event';

interface DrillSkeletonProps {
    variant?: DrillSkeletonVariant;
}

/** Stat card placeholder */
const StatSkeleton: React.FC = () => (
    <Box p={4} borderWidth={1} borderRadius="md" borderColor="gray.200" flex={1}>
        <Skeleton height="12px" width="60%" mb={2} />
        <Skeleton height="24px" width="80%" mb={1} />
        <Skeleton height="10px" width="40%" />
    </Box>
);

/** Table row placeholder */
const RowSkeleton: React.FC = () => (
    <Flex gap={3} py={2} px={3} align="center">
        <Skeleton height="14px" width="25%" />
        <Skeleton height="14px" width="15%" />
        <Skeleton height="14px" width="20%" />
        <Skeleton height="14px" width="15%" />
        <Skeleton height="14px" width="10%" />
    </Flex>
);

/** Asset detail skeleton: header + 4 stat cards + 6 table rows */
const AssetSkeleton: React.FC = () => (
    <Box>
        {/* Header */}
        <Flex align="center" gap={3} mb={4}>
            <Skeleton height="28px" width="120px" />
            <Skeleton height="20px" width="80px" />
        </Flex>

        {/* Stat cards row */}
        <Flex gap={3} mb={6}>
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
        </Flex>

        {/* Table header */}
        <Skeleton height="14px" width="200px" mb={3} />

        {/* Table rows */}
        <Box borderWidth={1} borderRadius="md" borderColor="gray.200" overflow="hidden">
            {Array.from({ length: 6 }, (_, i) => (
                <RowSkeleton key={i} />
            ))}
        </Box>
    </Box>
);

/** Event detail skeleton: header + 2-column breakdown */
const EventSkeleton: React.FC = () => (
    <Box>
        {/* Header */}
        <Flex align="center" gap={3} mb={4}>
            <Skeleton height="24px" width="180px" />
            <Skeleton height="16px" width="60px" />
        </Flex>

        {/* Summary stats */}
        <Flex gap={3} mb={6}>
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
        </Flex>

        {/* Breakdown list */}
        <Skeleton height="14px" width="160px" mb={3} />
        <Box borderWidth={1} borderRadius="md" borderColor="gray.200" overflow="hidden">
            {Array.from({ length: 4 }, (_, i) => (
                <RowSkeleton key={i} />
            ))}
        </Box>
    </Box>
);

export const DrillSkeleton: React.FC<DrillSkeletonProps> = ({ variant = 'asset' }) => {
    return variant === 'event' ? <EventSkeleton /> : <AssetSkeleton />;
};
