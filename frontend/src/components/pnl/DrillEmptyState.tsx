/**
 * DrillEmptyState
 *
 * Empty state placeholder shown when a drill-down level has no data,
 * e.g., no lots for an asset, no realized entries in a period, no matching filters.
 *
 * Provides contextual messaging per drill level and an optional action button.
 */

import React from 'react';
import { Box, Flex, Heading, Text, Button } from '@chakra-ui/react';

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
        <Flex
            direction="column"
            align="center"
            justify="center"
            py={16}
            px={6}
            bg="gray.50"
            borderRadius="md"
            textAlign="center"
        >
            <Text fontSize="3xl" mb={3}>{config.icon}</Text>
            <Heading size="md" color="gray.600" mb={2}>
                {config.title}
            </Heading>
            <Text color="gray.400" maxW="400px" mb={filterDescription ? 2 : 0}>
                {config.description}
            </Text>
            {filterDescription && (
                <Box
                    mt={2}
                    px={3}
                    py={1}
                    bg="gray.100"
                    borderRadius="md"
                    fontSize="xs"
                    color="gray.500"
                >
                    Filter: {filterDescription}
                </Box>
            )}
            {actionLabel && onAction && (
                <Button
                    mt={4}
                    size="sm"
                    colorPalette="blue"
                    variant="outline"
                    onClick={onAction}
                >
                    {actionLabel}
                </Button>
            )}
        </Flex>
    );
};
