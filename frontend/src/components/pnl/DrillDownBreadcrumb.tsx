/**
 * DrillDownBreadcrumb
 *
 * Renders a prominent breadcrumb bar with navigation trail, period badge,
 * and section toggle buttons (Assets / PnL Audit) right-aligned.
 */

import React from 'react';
import { Badge, Button, Flex, Text } from '@chakra-ui/react';
import { FiChevronRight, FiFileText, FiGrid } from 'react-icons/fi';
import { usePnL } from './PnLContext';

interface DrillDownBreadcrumbProps {
    assetsOpen: boolean;
    auditOpen: boolean;
    onToggleAssets: () => void;
    onToggleAudit: () => void;
}

export const DrillDownBreadcrumb: React.FC<DrillDownBreadcrumbProps> = ({ assetsOpen, auditOpen, onToggleAssets, onToggleAudit }) => {
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

            {/* Section toggle buttons — right-aligned */}
            <Flex gap={1} ml="auto" align="center">
                <Button
                    size="xs"
                    variant={assetsOpen ? 'solid' : 'outline'}
                    colorPalette={assetsOpen ? 'blue' : 'gray'}
                    onClick={onToggleAssets}
                >
                    <FiGrid size={12} />
                    <Text ml={1} fontSize="xs">Assets</Text>
                </Button>
                <Button
                    size="xs"
                    variant={auditOpen ? 'solid' : 'outline'}
                    colorPalette={auditOpen ? 'blue' : 'gray'}
                    onClick={onToggleAudit}
                >
                    <FiFileText size={12} />
                    <Text ml={1} fontSize="xs">PnL Audit</Text>
                </Button>
            </Flex>
        </Flex>
    );
};
