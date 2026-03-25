/**
 * DrillSidebar — Context-Aware Sidebar
 *
 * Adapts its content based on drill state:
 * - Category: aggregate stats for category, list of contained assets
 * - Account: aggregate stats for account, per-asset breakdown
 * - Metric: portfolio metric breakdown, top contributors
 * - Asset (L2): full asset detail with per-account breakdown
 * - Not shown at L0
 */

import React, { useMemo } from 'react';
import { Badge, Box, Card, Flex, Heading, Text } from '@chakra-ui/react';
import { FiArrowRight, FiTrendingUp, FiTrendingDown, FiAlertTriangle } from 'react-icons/fi';
import { usePnL } from './PnLContext';
import { fmtCurrency, fmtCurrencySigned } from './TotalReturnScorecard';
import type { DrillDownState } from './pnlState';
import type { AssetPnLRow } from './types';

interface DrillSidebarProps {
    drill: DrillDownState;
    onAssetClick: (assetId: number, assetSymbol: string) => void;
    onAccountFilterClick?: (accountId: number) => void;
}

/** Small metric display for sidebar */
const SidebarMetric: React.FC<{ label: string; value: string; color?: string }> = ({ label, value, color }) => (
    <Box py={1}>
        <Text fontSize="2xs" color="gray.500" textTransform="uppercase" letterSpacing="wide">{label}</Text>
        <Text fontSize="sm" fontWeight="bold" color={color ?? 'gray.800'} fontFamily="mono">{value}</Text>
    </Box>
);

/** Clickable asset row in sidebar */
const SidebarAssetRow: React.FC<{
    asset: AssetPnLRow;
    baseCurrency: string;
    onClick: () => void;
}> = ({ asset, baseCurrency, onClick }) => {
    const returnColor = asset.unrealized_pnl >= 0 ? 'green.600' : 'red.600';
    return (
        <Flex
            align="center"
            justify="space-between"
            py={1.5}
            px={2}
            cursor="pointer"
            _hover={{ bg: 'gray.50' }}
            borderRadius="sm"
            onClick={onClick}
        >
            <Flex align="center" gap={2} flex={1} minW={0}>
                <Text fontSize="xs" fontWeight="semibold" color="gray.700" truncate>
                    {asset.asset.symbol}
                </Text>
                {asset.warning_count > 0 && (
                    <FiAlertTriangle size={10} color="var(--chakra-colors-orange-500)" />
                )}
            </Flex>
            <Flex align="center" gap={2}>
                <Text fontSize="xs" fontWeight="bold" color={returnColor}>
                    {fmtCurrencySigned(asset.unrealized_pnl, baseCurrency)}
                </Text>
                <FiArrowRight size={10} color="var(--chakra-colors-gray-400)" />
            </Flex>
        </Flex>
    );
};

export const DrillSidebar: React.FC<DrillSidebarProps> = ({
    drill,
    onAssetClick,
    onAccountFilterClick,
}) => {
    const { state, assets } = usePnL();
    const baseCurrency = state.config.base_currency_symbol;

    // Rank assets by metric (hoisted before conditionals to satisfy rules of hooks)
    const rankedAssets = useMemo(() => {
        if (!drill.metric) return [];
        const sorted = [...assets].filter(a => a.asset.id != null);
        switch (drill.metric) {
            case 'cost_basis': sorted.sort((a, b) => b.cost_basis - a.cost_basis); break;
            case 'unrealized': sorted.sort((a, b) => Math.abs(b.unrealized_pnl) - Math.abs(a.unrealized_pnl)); break;
            case 'realized': sorted.sort((a, b) => Math.abs(b.realized_pnl) - Math.abs(a.realized_pnl)); break;
            case 'fees': sorted.sort((a, b) => b.total_fees - a.total_fees); break;
            case 'total_return': sorted.sort((a, b) => Math.abs(b.unrealized_pnl + b.realized_pnl) - Math.abs(a.unrealized_pnl + a.realized_pnl)); break;
            case 'warnings': sorted.sort((a, b) => b.warning_count - a.warning_count); break;
        }
        return sorted.slice(0, 15);
    }, [assets, drill.metric]);

    // Don't render at L0
    if (drill.level === 0) return null;

    // ── Asset Mode (L2) ──
    if (drill.level === 2 && drill.assetId != null) {
        const asset = assets.find(a => a.asset.id === drill.assetId);
        if (!asset) return null;

        const accountBreakdown = asset.asset.id != null
            ? state.accountBalances.get(asset.asset.id)
            : undefined;

        const returnColor = asset.unrealized_pnl >= 0 ? 'green.600' : 'red.600';
        const totalReturn = asset.unrealized_pnl + asset.realized_pnl;

        return (
            <Box p={3} bg="white" borderRadius="lg" border="1px solid" borderColor="gray.200" h="100%">
                <Heading size="sm" mb={2}>{asset.asset.symbol}</Heading>
                {asset.asset.label && <Text fontSize="xs" color="gray.500" mb={2}>{asset.asset.label}</Text>}

                <Box display="grid" gridTemplateColumns="1fr 1fr" gap={1} mb={3}>
                    <SidebarMetric label="Market Value" value={fmtCurrency(asset.market_value, baseCurrency)} />
                    <SidebarMetric label="Cost Basis" value={fmtCurrency(asset.cost_basis, baseCurrency)} />
                    <SidebarMetric label="Unrealized" value={fmtCurrencySigned(asset.unrealized_pnl, baseCurrency)} color={returnColor} />
                    <SidebarMetric label="Realized" value={fmtCurrencySigned(asset.realized_pnl, baseCurrency)} color={asset.realized_pnl >= 0 ? 'green.600' : 'red.600'} />
                    <SidebarMetric label="Total Return" value={fmtCurrencySigned(totalReturn, baseCurrency)} color={totalReturn >= 0 ? 'green.600' : 'red.600'} />
                    <SidebarMetric label="Fees" value={fmtCurrency(asset.total_fees, baseCurrency)} />
                </Box>

                <Flex gap={1} mb={3} flexWrap="wrap">
                    <Badge size="xs" colorPalette="blue">{asset.lot_count} lots</Badge>
                    <Badge size="xs" colorPalette="purple">{asset.realized_event_count} realized</Badge>
                    {asset.warning_count > 0 && (
                        <Badge size="xs" colorPalette="orange">{asset.warning_count} warnings</Badge>
                    )}
                </Flex>

                {/* Per-account breakdown */}
                {accountBreakdown && accountBreakdown.length > 0 && (
                    <Box>
                        <Text fontSize="2xs" fontWeight="semibold" color="gray.500" mb={1} textTransform="uppercase">
                            Accounts
                        </Text>
                        {accountBreakdown.map(ab => {
                            const acct = state.accounts.find(a => a.id === ab.account_id);
                            const isActive = drill.accountFilter === ab.account_id;
                            return (
                                <Flex
                                    key={ab.account_id}
                                    align="center"
                                    justify="space-between"
                                    py={1}
                                    px={2}
                                    cursor="pointer"
                                    bg={isActive ? 'blue.50' : 'transparent'}
                                    borderRadius="sm"
                                    _hover={{ bg: isActive ? 'blue.50' : 'gray.50' }}
                                    onClick={() => onAccountFilterClick?.(ab.account_id)}
                                >
                                    <Text fontSize="xs" color="gray.700">{acct?.name ?? `#${ab.account_id}`}</Text>
                                    <Text fontSize="xs" fontFamily="mono" color="gray.600">
                                        {ab.qty.toFixed(4)}
                                    </Text>
                                </Flex>
                            );
                        })}
                    </Box>
                )}
            </Box>
        );
    }

    // ── Category Mode (L1) ──
    if (drill.entityType === 'category' && drill.entityId != null) {
        const categoryAssets = assets.filter(a => a.category_ids.includes(drill.entityId!));
        const totals = aggregateAssets(categoryAssets);

        return (
            <SidebarAggregateView
                title={drill.entityLabel ?? 'Category'}
                totals={totals}
                assetList={categoryAssets}
                baseCurrency={baseCurrency}
                onAssetClick={onAssetClick}
            />
        );
    }

    // ── Account Mode (L1) ──
    if (drill.entityType === 'account' && drill.entityId != null) {
        const accountAssets = assets.filter(a => a.account_ids.includes(drill.entityId!));
        const totals = aggregateAssets(accountAssets);

        return (
            <SidebarAggregateView
                title={drill.entityLabel ?? 'Account'}
                totals={totals}
                assetList={accountAssets}
                baseCurrency={baseCurrency}
                onAssetClick={onAssetClick}
            />
        );
    }

    // ── Metric Mode (L1) ──
    if (drill.metric) {
        const metricLabel = drill.metric.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase());

        const totals = aggregateAssets(assets);

        return (
            <Box p={3} bg="white" borderRadius="lg" border="1px solid" borderColor="gray.200" h="100%">
                <Heading size="sm" mb={2}>{metricLabel}</Heading>
                {drill.period && (
                    <Badge colorPalette="blue" variant="subtle" size="xs" mb={2}>
                        {drill.period.toUpperCase()}
                    </Badge>
                )}

                <Box display="grid" gridTemplateColumns="1fr 1fr" gap={1} mb={3}>
                    <SidebarMetric label="Total Value" value={fmtCurrency(totals.marketValue, baseCurrency)} />
                    <SidebarMetric label="Cost Basis" value={fmtCurrency(totals.costBasis, baseCurrency)} />
                    <SidebarMetric label="Unrealized" value={fmtCurrencySigned(totals.unrealizedPnl, baseCurrency)} color={totals.unrealizedPnl >= 0 ? 'green.600' : 'red.600'} />
                    <SidebarMetric label="Realized" value={fmtCurrencySigned(totals.realizedPnl, baseCurrency)} color={totals.realizedPnl >= 0 ? 'green.600' : 'red.600'} />
                </Box>

                <Text fontSize="2xs" fontWeight="semibold" color="gray.500" mb={1} textTransform="uppercase">
                    Top Contributors
                </Text>
                {rankedAssets.map(a => (
                    <SidebarAssetRow
                        key={a.asset.id}
                        asset={a}
                        baseCurrency={baseCurrency}
                        onClick={() => a.asset.id != null && a.asset.symbol && onAssetClick(a.asset.id, a.asset.symbol)}
                    />
                ))}
            </Box>
        );
    }

    return null;
};

// ── Helpers ──

function aggregateAssets(assetList: AssetPnLRow[]) {
    return assetList.reduce(
        (acc, a) => ({
            marketValue: acc.marketValue + a.market_value,
            costBasis: acc.costBasis + a.cost_basis,
            unrealizedPnl: acc.unrealizedPnl + a.unrealized_pnl,
            realizedPnl: acc.realizedPnl + a.realized_pnl,
            totalFees: acc.totalFees + a.total_fees,
            lotCount: acc.lotCount + a.lot_count,
            warningCount: acc.warningCount + a.warning_count,
            assetCount: acc.assetCount + 1,
        }),
        { marketValue: 0, costBasis: 0, unrealizedPnl: 0, realizedPnl: 0, totalFees: 0, lotCount: 0, warningCount: 0, assetCount: 0 },
    );
}

/** Reusable aggregate sidebar for category/account modes */
const SidebarAggregateView: React.FC<{
    title: string;
    totals: ReturnType<typeof aggregateAssets>;
    assetList: AssetPnLRow[];
    baseCurrency: string;
    onAssetClick: (assetId: number, assetSymbol: string) => void;
}> = ({ title, totals, assetList, baseCurrency, onAssetClick }) => (
    <Box p={3} bg="white" borderRadius="lg" border="1px solid" borderColor="gray.200" h="100%">
        <Heading size="sm" mb={1}>{title}</Heading>
        <Text fontSize="xs" color="gray.500" mb={2}>{totals.assetCount} assets</Text>

        <Box display="grid" gridTemplateColumns="1fr 1fr" gap={1} mb={3}>
            <SidebarMetric label="Total Value" value={fmtCurrency(totals.marketValue, baseCurrency)} />
            <SidebarMetric label="Cost Basis" value={fmtCurrency(totals.costBasis, baseCurrency)} />
            <SidebarMetric
                label="Unrealized"
                value={fmtCurrencySigned(totals.unrealizedPnl, baseCurrency)}
                color={totals.unrealizedPnl >= 0 ? 'green.600' : 'red.600'}
            />
            <SidebarMetric
                label="Realized"
                value={fmtCurrencySigned(totals.realizedPnl, baseCurrency)}
                color={totals.realizedPnl >= 0 ? 'green.600' : 'red.600'}
            />
            <SidebarMetric label="Fees" value={fmtCurrency(totals.totalFees, baseCurrency)} />
            <SidebarMetric label="Lots" value={String(totals.lotCount)} />
        </Box>

        {totals.warningCount > 0 && (
            <Flex align="center" gap={1} mb={2}>
                <FiAlertTriangle size={12} color="var(--chakra-colors-orange-500)" />
                <Text fontSize="xs" color="orange.600">{totals.warningCount} warnings</Text>
            </Flex>
        )}

        <Text fontSize="2xs" fontWeight="semibold" color="gray.500" mb={1} textTransform="uppercase">
            Assets
        </Text>
        <Box maxH="300px" overflowY="auto">
            {assetList.map(a => (
                <SidebarAssetRow
                    key={a.asset.id ?? a.asset.symbol}
                    asset={a}
                    baseCurrency={baseCurrency}
                    onClick={() => a.asset.id != null && a.asset.symbol && onAssetClick(a.asset.id, a.asset.symbol)}
                />
            ))}
        </Box>
    </Box>
);
