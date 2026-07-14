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
import { FiAlertTriangle } from 'react-icons/fi';
import { AllocationTreemap } from './AllocationTreemap';
import { AssetPnLTable } from './AssetPnLTable';
import { usePnL } from './PnLContext';
import type { AssetPnLRow } from './types';
import type { DrillDownState } from './pnlState';
import { Badge } from '../ui/primitives';

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
            <div>
                <div className="mb-3 flex items-center gap-2">
                    <span className="text-orange-500"><FiAlertTriangle /></span>
                    <span className="text-sm font-semibold">Warnings ({state.warnings.length})</span>
                </div>
                <div className="mb-4 flex flex-wrap gap-2">
                    {Object.entries(state.warningTypeCounts).map(([type, count]) => (
                        <Badge key={type} colorScheme="orange">
                            {type}: {count}
                        </Badge>
                    ))}
                </div>
                <AssetPnLTable
                    assets={warningAssets}
                    baseCurrency={state.config.base_currency_symbol}
                    onAssetClick={(id) => id != null && onAssetClick(id)}
                    onAccountClick={onAccountClick}
                    accounts={accounts}
                    dimensions={dimensions}
                    accountBalances={accountBalances}
                    pnlVersionId={state.currentVersionId ?? undefined}
                />
            </div>
        );
    }

    return (
        <div>
            <div className="mb-3 flex items-center gap-2">
                <span className="text-sm font-semibold">{title}</span>
                {state.timeframeRange !== 'all' && (
                    <Badge colorScheme="blue">
                        {state.timeframeRange.toUpperCase()}
                    </Badge>
                )}
                <span className="text-xs text-slate-500">
                    {filteredAssets.length} asset{filteredAssets.length !== 1 ? 's' : ''}
                </span>
            </div>

            {/* Treemap */}
            <div className="mb-4">
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
            </div>

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
                pnlVersionId={state.currentVersionId ?? undefined}
            />
        </div>
    );
};
