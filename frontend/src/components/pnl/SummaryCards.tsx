/**
 * P&L Summary Cards
 * 
 * Principle 1: Results first - Always visible top-level metrics
 * Clickable cards open detail panels (fees, warnings)
 */

import React from 'react';
import {
    Badge,
    Box,
    Card,
    Flex,
    SimpleGrid,
    Text,
} from '@chakra-ui/react';
import { FiAlertTriangle, FiDollarSign, FiTrendingUp, FiTrendingDown } from 'react-icons/fi';
import { PnLSummary } from './types';

interface SummaryCardsProps {
    summary: PnLSummary;
    baseCurrency: string;
    onFeesClick?: () => void;
    onWarningsClick?: () => void;
}

const formatCurrency = (value: number, currency: string): string => {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);
};

const formatPct = (value: number): string => {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${(value * 100).toFixed(2)}%`;
};

interface MetricCardProps {
    label: string;
    value: string;
    subValue?: string;
    color?: string;
    icon?: React.ReactNode;
    onClick?: () => void;
    clickable?: boolean;
    badge?: { label: string; colorPalette: string };
}

const MetricCard: React.FC<MetricCardProps> = ({
    label,
    value,
    subValue,
    color = 'gray.800',
    icon,
    onClick,
    clickable = false,
    badge,
}) => (
    <Card.Root
        cursor={clickable ? 'pointer' : 'default'}
        onClick={onClick}
        _hover={clickable ? { shadow: 'md', borderColor: 'blue.200' } : undefined}
        transition="all 0.2s"
    >
        <Card.Body py={4}>
            <Flex justify="space-between" align="flex-start" mb={2}>
                <Text fontSize="sm" color="gray.500" fontWeight="medium">
                    {label}
                </Text>
                {icon && <Box color="gray.400">{icon}</Box>}
            </Flex>
            <Text fontSize="2xl" fontWeight="bold" color={color}>
                {value}
            </Text>
            {subValue && (
                <Text fontSize="sm" color="gray.500" mt={1}>
                    {subValue}
                </Text>
            )}
            {badge && (
                <Badge colorPalette={badge.colorPalette} mt={2} size="sm">
                    {badge.label}
                </Badge>
            )}
        </Card.Body>
    </Card.Root>
);

export const SummaryCards: React.FC<SummaryCardsProps> = ({
    summary,
    baseCurrency,
    onFeesClick,
    onWarningsClick,
}) => {
    const realizedPnLColor = summary.total_realized_pnl >= 0 ? 'green.600' : 'red.600';
    const unrealizedPnLColor = summary.total_unrealized_pnl >= 0 ? 'green.600' : 'red.600';

    return (
        <SimpleGrid columns={{ base: 2, md: 3, lg: 5 }} gap={4} mb={6}>
            {/* Portfolio Value */}
            <MetricCard
                label="Portfolio Value"
                value={formatCurrency(summary.total_portfolio_value, baseCurrency)}
                icon={<FiDollarSign size={18} />}
            />

            {/* Unrealized P&L */}
            <MetricCard
                label="Unrealized P&L"
                value={formatCurrency(summary.total_unrealized_pnl, baseCurrency)}
                color={unrealizedPnLColor}
                icon={summary.total_unrealized_pnl >= 0 ? <FiTrendingUp size={18} /> : <FiTrendingDown size={18} />}
            />

            {/* Realized P&L */}
            <MetricCard
                label="Realized P&L"
                value={formatCurrency(summary.total_realized_pnl, baseCurrency)}
                subValue={`Taxable: ${formatCurrency(summary.taxable_realized_pnl, baseCurrency)}`}
                color={realizedPnLColor}
                icon={summary.total_realized_pnl >= 0 ? <FiTrendingUp size={18} /> : <FiTrendingDown size={18} />}
            />

            {/* Total Fees */}
            <MetricCard
                label="Total Fees"
                value={formatCurrency(summary.total_fees, baseCurrency)}
                subValue={summary.fee_pnl !== 0 ? `P&L: ${formatCurrency(summary.fee_pnl, baseCurrency)}` : `${summary.fee_entry_count} fee events`}
                onClick={onFeesClick}
                clickable={!!onFeesClick}
                badge={onFeesClick ? { label: 'Click for details', colorPalette: 'gray' } : undefined}
            />

            {/* Warnings */}
            <MetricCard
                label="Warnings"
                value={`${summary.warning_count}`}
                subValue={summary.error_count > 0 ? `${summary.error_count} errors` : undefined}
                color={summary.warning_count > 0 ? 'orange.500' : 'green.500'}
                icon={<FiAlertTriangle size={18} />}
                onClick={onWarningsClick}
                clickable={!!onWarningsClick && summary.warning_count > 0}
                badge={
                    summary.error_count > 0
                        ? { label: 'Needs attention', colorPalette: 'red' }
                        : summary.warning_count > 0
                            ? { label: 'Review recommended', colorPalette: 'orange' }
                            : { label: 'All clear', colorPalette: 'green' }
                }
            />
        </SimpleGrid>
    );
};

/**
 * Compact summary bar for when detail view is active
 */
export const SummaryBar: React.FC<{
    summary: PnLSummary;
    baseCurrency: string;
}> = ({ summary, baseCurrency }) => {
    const realizedColor = summary.total_realized_pnl >= 0 ? 'green.600' : 'red.600';

    return (
        <Flex
            gap={6}
            py={2}
            px={4}
            bg="gray.50"
            borderRadius="md"
            mb={4}
            wrap="wrap"
            align="center"
        >
            <Box>
                <Text fontSize="xs" color="gray.500">Portfolio</Text>
                <Text fontSize="sm" fontWeight="bold">
                    {formatCurrency(summary.total_portfolio_value, baseCurrency)}
                </Text>
            </Box>
            <Box>
                <Text fontSize="xs" color="gray.500">Unrealized</Text>
                <Text fontSize="sm" fontWeight="bold" color={summary.total_unrealized_pnl >= 0 ? 'green.600' : 'red.600'}>
                    {formatCurrency(summary.total_unrealized_pnl, baseCurrency)}
                </Text>
            </Box>
            <Box>
                <Text fontSize="xs" color="gray.500">Realized</Text>
                <Text fontSize="sm" fontWeight="bold" color={realizedColor}>
                    {formatCurrency(summary.total_realized_pnl, baseCurrency)}
                </Text>
            </Box>
            <Box>
                <Text fontSize="xs" color="gray.500">Fees</Text>
                <Text fontSize="sm" fontWeight="bold">
                    {formatCurrency(summary.total_fees, baseCurrency)}
                </Text>
                {summary.fee_pnl !== 0 && (
                    <Text fontSize="xs" color={summary.fee_pnl >= 0 ? 'green.500' : 'red.500'}>
                        P&L: {formatCurrency(summary.fee_pnl, baseCurrency)}
                    </Text>
                )}
            </Box>
            {summary.warning_count > 0 && (
                <Badge colorPalette="orange" size="sm">
                    <FiAlertTriangle style={{ marginRight: 4 }} />
                    {summary.warning_count} warnings
                </Badge>
            )}
        </Flex>
    );
};

export default SummaryCards;
