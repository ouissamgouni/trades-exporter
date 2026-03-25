/**
 * PnLLevel1 — Drill Level 1 Renderer
 *
 * Shows filtered content based on drill context:
 * - Metric drill → treemap sized by metric + cards sorted by metric
 * - Category drill → treemap + cards filtered to category assets
 * - Account drill → treemap + cards filtered to account holdings
 * - Warnings drill → flat warning cards (no treemap)
 */

import React, { useMemo } from 'react';
import { Box, Heading, Text, Flex, Badge, Card } from '@chakra-ui/react';
import { FiAlertTriangle } from 'react-icons/fi';
import { AllocationTreemap } from './AllocationTreemap';
import { AssetPnLTable } from './AssetPnLTable';
import { usePnL } from './PnLContext';
import type { AssetPnLRow } from './types';
import type { DrillDownState } from './pnlState';

interface PnLLevel1Props {
    drill: DrillDownState;
    onAssetClick: (assetId: number) => void;
    onAccountClick?: (assetId: number, accountId: number) => void;
    onAssetNavigate?: (assetId: number, assetSymbol: string) => void;
}

export const PnLLevel1: React.FC<PnLLevel1Props> = ({
    drill,
    onAssetClick,
    onAccountClick,
    onAssetNavigate,
}) => {
    const {
        state,
        assets,
        heroTimeline,
        liveBalanceMap,
        liveAccountBalanceMap,
        liveBalanceLoading,
        liveAccountErrors,
        liveFetchedAccountIds,
    } = usePnL();

    const {
        accounts, dimensions, accountBalances,
    } = state;

    // Filter assets based on drill context
    const filteredAssets = useMemo((): AssetPnLRow[] => {
        if (drill.entityType === 'category' && drill.entityId != null) {
            return assets.filter(a => a.category_ids.includes(drill.entityId!));
        }
        if (drill.entityType === 'account' && drill.entityId != null) {
            return assets.filter(a => a.account_ids.includes(drill.entityId!));
        }
        // Metric or general drill — show all assets
        return assets;
    }, [assets, drill.entityType, drill.entityId]);

    // Build assetCategoryMaps for treemap
    const assetCategoryMaps = useMemo(() => {
        const result: Record<number, Record<number, string>> = {};
        for (const dim of dimensions) {
            const catMap: Record<number, string> = {};
            const catIdToLabel: Record<number, string> = {};
            for (const cat of dim.categories) {
                catIdToLabel[cat.id] = cat.label;
            }
            for (const a of filteredAssets) {
                if (a.asset.id == null) continue;
                for (const catId of a.category_ids) {
                    if (catIdToLabel[catId]) {
                        catMap[a.asset.id] = catIdToLabel[catId];
                        break;
                    }
                }
            }
            result[dim.id] = catMap;
        }
        return result;
    }, [dimensions, filteredAssets]);

    const title = drill.entityLabel
        ?? drill.metric?.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
        ?? 'Drill Down';

    // Warnings drill — flat list instead of treemap
    if (drill.metric === 'warnings') {
        const warningAssets = assets.filter(a => a.warning_count > 0);
        return (
            <Box>
                <Flex align="center" gap={2} mb={3}>
                    <FiAlertTriangle color="var(--chakra-colors-orange-500)" />
                    <Heading size="sm">Warnings ({state.warnings.length})</Heading>
                </Flex>
                <Flex gap={2} flexWrap="wrap" mb={4}>
                    {Object.entries(state.warningTypeCounts).map(([type, count]) => (
                        <Badge key={type} colorPalette="orange" variant="subtle" size="sm">
                            {type}: {count}
                        </Badge>
                    ))}
                </Flex>
                <AssetPnLTable
                    assets={warningAssets}
                    baseCurrency={state.config.base_currency_symbol}
                    onAssetClick={(id) => id != null && onAssetClick(id)}
                    onAccountClick={onAccountClick}
                    accounts={accounts}
                    dimensions={dimensions}
                    accountBalances={accountBalances}
                />
            </Box>
        );
    }

    return (
        <Box>
            <Flex align="center" gap={2} mb={3}>
                <Heading size="sm">{title}</Heading>
                {drill.period && (
                    <Badge colorPalette="blue" variant="subtle" size="sm">
                        {drill.period.toUpperCase()}
                    </Badge>
                )}
                <Text fontSize="xs" color="gray.500">
                    {filteredAssets.length} asset{filteredAssets.length !== 1 ? 's' : ''}
                </Text>
            </Flex>

            {/* Treemap */}
            <Box mb={4}>
                <AllocationTreemap
                    points={heroTimeline.data?.points || []}
                    assetCategoryMaps={assetCategoryMaps}
                    dimensions={dimensions}
                    accounts={accounts}
                    assets={filteredAssets}
                    baseCurrency={state.config.base_currency_symbol}
                    isLoading={heroTimeline.isLoading}
                    accountBalances={accountBalances}
                    onAssetNavigate={onAssetNavigate}
                />
            </Box>

            {/* Asset cards / table */}
            <AssetPnLTable
                assets={filteredAssets}
                baseCurrency={state.config.base_currency_symbol}
                onAssetClick={(id) => id != null && onAssetClick(id)}
                onAccountClick={onAccountClick}
                accounts={accounts}
                dimensions={dimensions}
                accountBalances={accountBalances}
                liveBalances={liveBalanceMap}
                liveAccountBalances={liveAccountBalanceMap}
                liveBalanceLoading={liveBalanceLoading}
                liveAccountErrors={liveAccountErrors}
                liveFetchedAccountIds={liveFetchedAccountIds}
            />
        </Box>
    );
};
