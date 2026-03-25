/**
 * DrillDownBreadcrumb
 *
 * Renders a clickable breadcrumb trail based on the drill-down navigation stack.
 * Always visible — shows "Portfolio > All" at level 0.
 * Reads drill state from PnLContext.
 */

import React from 'react';
import { Badge, Button, Flex, Text } from '@chakra-ui/react';
import { FiChevronRight, FiFileText, FiBarChart2 } from 'react-icons/fi';
import { usePnL } from './PnLContext';

interface DrillDownBreadcrumbProps {
    /** Callback for "Go to PnL Audit" button */
    onGoToAudit?: () => void;
    /** Callback for "Go to Charts" button */
    onGoToCharts?: () => void;
}

export const DrillDownBreadcrumb: React.FC<DrillDownBreadcrumbProps> = ({ onGoToAudit, onGoToCharts }) => {
    const { state, dispatch } = usePnL();
    const { breadcrumbs, level } = state.drill;
    const timeframeRange = state.timeframeRange;

    // Use breadcrumbs directly — "Portfolio" crumb at L0 is sufficient
    const displayCrumbs = breadcrumbs;

    return (
        <Flex align="center" gap={1} mb={3} flexWrap="wrap">
            {displayCrumbs.map((crumb, idx) => {
                const isLast = idx === displayCrumbs.length - 1;
                const isClickable = !isLast;

                return (
                    <React.Fragment key={idx}>
                        {idx > 0 && (
                            <FiChevronRight
                                size={14}
                                style={{ color: 'var(--chakra-colors-gray-400)', flexShrink: 0 }}
                            />
                        )}
                        <Text
                            fontSize="sm"
                            fontWeight={isLast ? '600' : '400'}
                            color={isLast ? 'gray.800' : 'blue.500'}
                            cursor={isClickable ? 'pointer' : 'default'}
                            _hover={isClickable ? { textDecoration: 'underline' } : undefined}
                            onClick={isClickable ? () => dispatch({ type: 'DRILL_TO_BREADCRUMB', index: idx }) : undefined}
                            whiteSpace="nowrap"
                        >
                            {crumb.label}
                        </Text>
                    </React.Fragment>
                );
            })}
            {timeframeRange && timeframeRange !== 'all' && (
                <Badge colorPalette="blue" variant="subtle" size="sm" ml={1}>
                    {timeframeRange.toUpperCase()}
                </Badge>
            )}
            {onGoToCharts && (
                <Button size="xs" variant="ghost" colorPalette="blue" onClick={onGoToCharts} ml="auto">
                    <FiBarChart2 size={12} />
                    <Text ml={1}>Charts</Text>
                </Button>
            )}
            {onGoToAudit && (
                <Button size="xs" variant="ghost" colorPalette="blue" onClick={onGoToAudit} ml={onGoToCharts ? undefined : 'auto'}>
                    <FiFileText size={12} />
                    <Text ml={1}>PnL Audit</Text>
                </Button>
            )}
        </Flex>
    );
};
