/**
 * P&L Status Cards
 *
 * Three full-size cards displayed in a horizontal row:
 * 1. RefreshPricesCard — shows fresh / stale / error counts + refresh button
 * 2. WarningsCard — warning count + type breakdown badges
 * 3. BalanceHealthCard — mismatch count + tolerance slider + issue tooltip
 *
 * Also re-exports SummaryBar for the detail view.
 */

import React from 'react';
import {
    Badge,
    Box,
    Button,
    Flex,
    Slider,
    Text,
} from '@chakra-ui/react';
import { FiAlertTriangle, FiActivity, FiRefreshCw } from 'react-icons/fi';
import { Tooltip } from '../ui/tooltip';
import { PnLSummary, UnmappedLiveAsset } from './types';

export interface BalanceHealthIssue {
    symbol: string;
    delta: number;
    pct: number;
}

export interface BalanceHealthData {
    mismatchCount: number;
    totalCompared: number;
    issues: BalanceHealthIssue[];
    assetsFetched?: number;
    assetsTotal?: number;
    failedAssets?: string[];
    uncoveredAssets?: string[];
}

// ═══════════════════════════════════════════════════════════════════
// RefreshPricesCard
// ═══════════════════════════════════════════════════════════════════

interface RefreshPricesCardProps {
    onRefreshPrices?: () => void;
    isRefreshingPrices?: boolean;
    priceSuccessCount?: number;
    priceStaleCount?: number;
    priceErrorCount?: number;
    onPriceBadgeClick?: () => void;
    refreshDisabled?: boolean;
    /** Number of assets not tracked in P&L (no cost lots — consistent with PriceStatusList) */
    naCount?: number;
    /** Number of P&L assets whose price fetch hasn't completed yet */
    pendingCount?: number;
    /** Total number of P&L assets (with cost lots) */
    pnlAssetCount?: number;
}

export const RefreshPricesCard: React.FC<RefreshPricesCardProps> = ({
    onRefreshPrices,
    isRefreshingPrices,
    priceSuccessCount = 0,
    priceStaleCount = 0,
    priceErrorCount = 0,
    onPriceBadgeClick,
    refreshDisabled,
    naCount = 0,
    pendingCount = 0,
    pnlAssetCount,
}) => {
    const priceableCount = priceSuccessCount + priceStaleCount + priceErrorCount;
    const highErrorRate = priceableCount > 0 && priceErrorCount / priceableCount > 0.2;

    return (
        <Box
            py={1}
            px={2.5}
            bg="white"
            borderRadius="lg"
            border="1px solid"
            borderColor="gray.200"
            h="100%"
            display="flex"
            alignItems="center"
            overflow="hidden"
        >
            <Flex align="center" gap={1.5} flex={1} wrap="nowrap" overflow="hidden">
                <FiRefreshCw size={12} color="#3182ce" style={{ flexShrink: 0 }} />
                <Text fontSize="2xs" fontWeight="semibold" color="gray.700" whiteSpace="nowrap">Prices</Text>
                {pnlAssetCount != null && (
                    <Text fontSize="2xs" color="gray.400" whiteSpace="nowrap">{pnlAssetCount}a</Text>
                )}
                {priceSuccessCount > 0 && (
                    <Badge colorPalette="green" variant="solid" size="xs" cursor="pointer" onClick={onPriceBadgeClick}>✅{priceSuccessCount}</Badge>
                )}
                {priceStaleCount > 0 && (
                    <Badge colorPalette="orange" variant="solid" size="xs" cursor="pointer" onClick={onPriceBadgeClick}>⏳{priceStaleCount}</Badge>
                )}
                {priceErrorCount > 0 && (
                    <Badge colorPalette="red" variant="solid" size="xs" cursor="pointer" onClick={onPriceBadgeClick}>⚠️{priceErrorCount}</Badge>
                )}
                {priceSuccessCount === 0 && priceStaleCount === 0 && priceErrorCount === 0 && (
                    <Text fontSize="2xs" color="gray.400">—</Text>
                )}
                {naCount > 0 && (
                    <Tooltip content="Only assets with cost lots need live pricing">
                        <Badge colorPalette="gray" variant="outline" size="xs">{naCount} N/A</Badge>
                    </Tooltip>
                )}
                {pendingCount > 0 && (
                    <Badge colorPalette="gray" variant="outline" size="xs" cursor="pointer" onClick={onPriceBadgeClick}>⏳{pendingCount}</Badge>
                )}
                {highErrorRate && (
                    <Badge colorPalette="orange" variant="subtle" size="xs">⚠️</Badge>
                )}
                <Button
                    onClick={onRefreshPrices}
                    loading={isRefreshingPrices}
                    colorPalette="blue"
                    variant="outline"
                    size="2xs"
                    disabled={refreshDisabled}
                    title="Refresh all prices"
                    ml="auto"
                    flexShrink={0}
                >
                    <FiRefreshCw size={12} />
                </Button>
            </Flex>
        </Box>
    );
};

// ═══════════════════════════════════════════════════════════════════
// WarningsCard
// ═══════════════════════════════════════════════════════════════════

interface WarningsCardProps {
    summary: PnLSummary;
    onWarningsClick?: () => void;
    warningTypeCounts?: Record<string, number>;
}

export const WarningsCard: React.FC<WarningsCardProps> = ({
    summary,
    onWarningsClick,
    warningTypeCounts,
}) => {
    const hasWarnings = summary.warning_count > 0;

    return (
        <Tooltip
            showArrow
            content={
                warningTypeCounts && Object.keys(warningTypeCounts).length > 0 ? (
                    <Box p={1}>
                        {Object.entries(warningTypeCounts)
                            .sort((a, b) => b[1] - a[1])
                            .map(([type, count]) => (
                                <Text key={type} fontSize="xs">{type.replace(/_/g, ' ')}: {count}</Text>
                            ))}
                    </Box>
                ) : hasWarnings ? `${summary.warning_count} warnings detected` : 'No warnings'
            }
        >
            <Box
                py={1}
                px={2.5}
                bg="white"
                borderRadius="lg"
                border="1px solid"
                borderColor="gray.200"
                h="100%"
                display="flex"
                alignItems="center"
                cursor={hasWarnings && onWarningsClick ? 'pointer' : 'default'}
                onClick={hasWarnings ? onWarningsClick : undefined}
                _hover={hasWarnings && onWarningsClick ? { borderColor: 'orange.300', shadow: 'sm' } : undefined}
                transition="all 0.15s"
                overflow="hidden"
            >
                <Flex align="center" gap={1.5} flex={1} wrap="nowrap" overflow="hidden">
                    <FiAlertTriangle size={12} color={hasWarnings ? '#dd6b20' : '#38a169'} style={{ flexShrink: 0 }} />
                    <Text fontSize="2xs" fontWeight="semibold" color="gray.700" whiteSpace="nowrap">Warnings</Text>
                    <Badge
                        colorPalette={summary.error_count > 0 ? 'red' : hasWarnings ? 'orange' : 'green'}
                        size="xs"
                    >
                        {hasWarnings ? summary.warning_count : '✓'}
                    </Badge>
                    {/* Inline type breakdown */}
                    {warningTypeCounts && Object.keys(warningTypeCounts).length > 0 && (
                        <>
                            {Object.entries(warningTypeCounts)
                                .sort((a, b) => b[1] - a[1])
                                .slice(0, 3)
                                .map(([type, count]) => (
                                    <Badge key={type} size="xs" variant="subtle" colorPalette="orange">
                                        {type.replace(/_/g, ' ').substring(0, 12)}:{count}
                                    </Badge>
                                ))}
                            {Object.keys(warningTypeCounts).length > 3 && (
                                <Badge size="xs" variant="subtle" colorPalette="gray">
                                    +{Object.keys(warningTypeCounts).length - 3}
                                </Badge>
                            )}
                        </>
                    )}
                    {!hasWarnings && !warningTypeCounts && (
                        <Text fontSize="2xs" color="green.600">✓ ok</Text>
                    )}
                </Flex>
            </Box>
        </Tooltip>
    );
};

// ═══════════════════════════════════════════════════════════════════
// BalanceHealthCard
// ═══════════════════════════════════════════════════════════════════

interface BalanceHealthCardProps {
    balanceHealth?: BalanceHealthData;
    onBalanceHealthClick?: () => void;
    deltaThreshold?: number;
    onDeltaThresholdChange?: (value: number) => void;
    unmappedLiveAssets?: UnmappedLiveAsset[];
}

export const BalanceHealthCard: React.FC<BalanceHealthCardProps> = ({
    balanceHealth,
    onBalanceHealthClick,
    deltaThreshold = 5,
    onDeltaThresholdChange,
    unmappedLiveAssets = [],
}) => {
    if (!balanceHealth) return null;

    const hasMismatches = balanceHealth.mismatchCount > 0;
    const hasFailed = (balanceHealth.failedAssets?.length ?? 0) > 0;
    const covered = balanceHealth.assetsFetched ?? balanceHealth.totalCompared;
    const total = balanceHealth.assetsTotal ?? 0;
    const uncovered = balanceHealth.uncoveredAssets ?? [];

    return (
        <Box
            py={1}
            px={2.5}
            bg="white"
            borderRadius="lg"
            border="1px solid"
            borderColor={hasFailed ? 'red.200' : 'gray.200'}
            h="100%"
            display="flex"
            alignItems="center"
            cursor={onBalanceHealthClick ? 'pointer' : 'default'}
            onClick={onBalanceHealthClick}
            _hover={onBalanceHealthClick ? { borderColor: 'orange.300', shadow: 'sm' } : undefined}
            transition="all 0.15s"
            overflow="hidden"
        >
            <Flex align="center" gap={1.5} flex={1} wrap="nowrap" overflow="hidden">
                <FiActivity size={12} color={hasFailed ? '#e53e3e' : hasMismatches ? '#dd6b20' : '#38a169'} style={{ flexShrink: 0 }} />
                <Text fontSize="2xs" fontWeight="semibold" color="gray.700" whiteSpace="nowrap">Balance</Text>
                <Badge colorPalette={hasMismatches ? 'orange' : 'green'} size="xs">
                    {covered}/{total}
                </Badge>
                {hasMismatches && (
                    <Badge size="xs" colorPalette="orange">{balanceHealth.mismatchCount}Δ</Badge>
                )}
                {hasFailed && (
                    <Badge size="xs" colorPalette="red">⚠{balanceHealth.failedAssets!.length}</Badge>
                )}
                {!hasMismatches && !hasFailed && (
                    <Badge size="xs" colorPalette="green">✓</Badge>
                )}
                {unmappedLiveAssets.length > 0 && (
                    <Badge size="xs" colorPalette="purple">📦{unmappedLiveAssets.length}</Badge>
                )}
                {/* Inline tolerance slider */}
                <Flex align="center" gap={1} ml="auto" flexShrink={0} onClick={(e) => e.stopPropagation()}>
                    <Text fontSize="2xs" color="gray.400" whiteSpace="nowrap">{deltaThreshold}%</Text>
                    <Box w="50px">
                        <Slider.Root
                            size="sm"
                            min={0}
                            max={50}
                            step={1}
                            value={[deltaThreshold]}
                            onValueChange={(details) => onDeltaThresholdChange?.(details.value[0])}
                        >
                            <Slider.Control>
                                <Slider.Track>
                                    <Slider.Range />
                                </Slider.Track>
                                <Slider.Thumb index={0} />
                            </Slider.Control>
                        </Slider.Root>
                    </Box>
                </Flex>
            </Flex>
        </Box>
    );
};

// ═══════════════════════════════════════════════════════════════════
// Legacy exports (kept for compatibility)
// ═══════════════════════════════════════════════════════════════════

/** @deprecated Use RefreshPricesCard + WarningsCard + BalanceHealthCard instead */
export const CompactStatusBar: React.FC<any> = () => null;

interface SummaryCardsProps {
    summary: PnLSummary;
    baseCurrency: string;
    onFeesClick?: () => void;
    onWarningsClick?: () => void;
    balanceHealth?: BalanceHealthData;
    onBalanceHealthClick?: () => void;
    deltaThreshold?: number;
    onDeltaThresholdChange?: (value: number) => void;
    warningTypeCounts?: Record<string, number>;
}

/** @deprecated Replaced by individual card exports */
export const SummaryCards: React.FC<SummaryCardsProps> = () => null;

/**
 * Compact summary bar for when detail view is active
 */
const formatCurrency = (value: number, currency: string): string => {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);
};

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
                {summary.taxable_realized_pnl !== 0 && (
                    <Text fontSize="2xs" color="gray.500">
                        Taxable: {formatCurrency(summary.taxable_realized_pnl, baseCurrency)}
                    </Text>
                )}
            </Box>
            <Box>
                <Text fontSize="xs" color="gray.500">Fees</Text>
                <Text fontSize="sm" fontWeight="bold">
                    {formatCurrency(summary.total_fees, baseCurrency)}
                </Text>
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
