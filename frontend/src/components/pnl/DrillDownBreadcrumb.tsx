/**
 * DrillDownBreadcrumb
 *
 * Renders a prominent breadcrumb bar with navigation trail and period badge.
 * Section toggles live inside ContextView.
 */

import React from 'react';
import { Badge, Flex, Text } from '@chakra-ui/react';
import { FiChevronRight } from 'react-icons/fi';
import { usePnL } from './PnLContext';

export const DrillDownBreadcrumb: React.FC = () => {
    const { state, dispatch } = usePnL();
    const { breadcrumbs, level } = state.drill;
    const timeframeRange = state.timeframeRange;

    const displayCrumbs = breadcrumbs;

    // First crumb shows period inline: "Portfolio · 1W"
    const firstCrumbLabel = displayCrumbs.length > 0
        ? (timeframeRange && timeframeRange !== 'all'
            ? `${displayCrumbs[0].label} · ${timeframeRange.toUpperCase()}`
            : displayCrumbs[0].label)
        : 'Portfolio';

    return (
        <Flex
            align="center"
            gap={1.5}
            mb={0}
            px={3}
            py={2}
            bg="gray.50"
            borderRadius="lg"
            border="1px solid"
            borderColor="gray.200"
            flexWrap="wrap"
        >
            {/* Breadcrumb trail */}
            {displayCrumbs.map((crumb, idx) => {
                const isLast = idx === displayCrumbs.length - 1;
                const label = idx === 0 ? firstCrumbLabel : crumb.label;

                return (
                    <React.Fragment key={idx}>
                        {idx > 0 && (
                            <FiChevronRight
                                size={14}
                                style={{ color: 'var(--chakra-colors-gray-400)', flexShrink: 0 }}
                            />
                        )}
                        {isLast ? (
                            <Badge
                                colorPalette="blue"
                                variant="subtle"
                                size="sm"
                                px={2}
                                py={0.5}
                                fontWeight="600"
                            >
                                {label}
                            </Badge>
                        ) : (
                            <Text
                                fontSize="sm"
                                fontWeight="500"
                                color="blue.600"
                                cursor="pointer"
                                _hover={{ textDecoration: 'underline' }}
                                onClick={() => dispatch({ type: 'DRILL_TO_BREADCRUMB', index: idx })}
                                whiteSpace="nowrap"
                            >
                                {label}
                            </Text>
                        )}
                    </React.Fragment>
                );
            })}
        </Flex>
    );
};
