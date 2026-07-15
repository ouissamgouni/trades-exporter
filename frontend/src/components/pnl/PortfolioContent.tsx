/**
 * PortfolioContent — Unified portfolio view
 *
 * Two rendering modes:
 * - Asset drill:          PnLDetailPanel (metrics + PnL Audit / Charts tabs)
 * - Everything else (L0 / entity drill): Tabs — Assets | Charts | PnL Audit
 *
 * Entity drill (account/category) sets selectedAccountIds/selectedCategoryIds
 * so the filter chip is visible and removable in AssetPnLTable.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '../ui/primitives';
import { FiGrid } from 'react-icons/fi';
import { usePnL } from './PnLContext';
import { AssetPnLTable, PnlStatusFilter, BalanceStatusFilter } from './AssetPnLTable';
import { PnLDetailPanel, SectionToggle } from './PnLDetailPanel';
import { InvestigationView } from './InvestigationView';
import { AllocationTreemap } from './AllocationTreemap';
import { MarketValuePieChart } from './MarketValuePieChart';
import { DrillDownBreadcrumb } from './DrillDownBreadcrumb';
import { ViewModeToggle, type AssetsViewMode } from './ViewModeToggle';
import { usePortfolioTimeline } from '../../hooks/useChartData';
import { useAssets } from '../../hooks/useAssets';
import type { AssetPeriodDelta } from '../../hooks/useChartData';
import type { Range } from './TotalReturnScorecard';

// ─── Props ──────────────────────────────────────────────────────────────────

export interface PortfolioContentProps {
    drill: any;
    dispatch: any;
    displayAssets: any[];
    assets: any[];
    config: any;
    showMismatchedOnly: boolean;
    accountBalances: any;
    accounts: any[];
    dimensions: any[];
    availableAccountIds: Set<number>;
    availableCategoryIds: Set<number>;
    currentVersionId: number | null;
    heroTimeline: any;
    assetCategoryMaps: Record<number, Record<number, string>>;
    liveBalanceMap: any;
    liveAccountBalanceMap: any;
    liveBalanceLoading: boolean;
    unmappedLiveAssets: any[];
    liveAccountErrors: any;
    liveFetchedAccountIds: any;
    onAssetClick: (id: number | null | undefined) => void;
    onAccountClick: (assetId: number, accountId: number) => void;
    onAssetNavigate: (assetId: number, assetSymbol: string) => void;
    onTransactionClick: (txId: number) => void;
    onUnitClick: (unitId: number) => void;
    onLoadAccountBalances: () => void;
    selectedAccountIds: number[];
    onSelectedAccountIdsChange: (ids: number[]) => void;
    selectedCategoryIds: number[];
    onSelectedCategoryIdsChange: (ids: number[]) => void;
    timeframeRange?: Range;
    periodDateFrom?: string;
    periodDateTo?: string;
    /** Period delta map: assetId → AssetPeriodDelta */
    periodDeltaMap?: Map<number, AssetPeriodDelta>;
    /** Period label (e.g. "1W") for delta display on cards */
    periodLabel?: string;
}

// ─── Component ──────────────────────────────────────────────────────────────

export const PortfolioContent: React.FC<PortfolioContentProps> = ({
    drill, dispatch, displayAssets, assets, config,
    showMismatchedOnly, accountBalances, accounts, dimensions,
    availableAccountIds, availableCategoryIds, currentVersionId,
    heroTimeline, assetCategoryMaps,
    liveBalanceMap, liveAccountBalanceMap, liveBalanceLoading,
    unmappedLiveAssets, liveAccountErrors, liveFetchedAccountIds,
    onAssetClick, onAccountClick, onAssetNavigate,
    onTransactionClick, onUnitClick, onLoadAccountBalances,
    selectedAccountIds, onSelectedAccountIdsChange: setSelectedAccountIds,
    selectedCategoryIds, onSelectedCategoryIdsChange: setSelectedCategoryIds,
    timeframeRange, periodDateFrom, periodDateTo,
    periodDeltaMap, periodLabel,
}) => {
    const { scorecardSummary, state: pnlState } = usePnL();
    const [assetsView, setAssetsView] = useState<AssetsViewMode>('list');
    const [chartsTab, setChartsTab] = useState<'cost-basis' | 'performance'>('cost-basis');

    // ── Mode detection ──
    const isAssetDrill = drill.level > 0 && drill.assetId != null;
    const isEntityDrill = drill.level > 0 && drill.entityType != null && drill.entityId != null;
    const isDrilled = isAssetDrill || isEntityDrill;

    // ── Section open state (independently collapsible) ──
    const [assetsOpen, setAssetsOpen] = useState(true);
    const [auditOpen, setAuditOpen] = useState(true);

    // ── Asset denomination currency map (asset_id → currency symbol) ──
    const { assets: allMasterAssets } = useAssets();
    const assetCurrencyMap = useMemo(() => {
        const m: Record<number, string> = {};
        for (const a of allMasterAssets) {
            if (a.asset_id != null && a.denomination_currency?.symbol) {
                m[a.asset_id] = a.denomination_currency.symbol;
            }
        }
        return m;
    }, [allMasterAssets]);

    // Reset sections whenever drill context changes
    useEffect(() => {
        setAssetsOpen(true);
        setAuditOpen(true);
    }, [drill.level, drill.entityId, drill.assetId]);

    // When auditDefaultPanel is set, open audit section
    const auditDefaultPanel = pnlState.auditDefaultPanel;
    useEffect(() => {
        if (auditDefaultPanel) setAuditOpen(true);
    }, [auditDefaultPanel]);

    // ── Wrap filter change callbacks: reset drill when entity filter removed ──
    const handleAccountIdsChange = useCallback((ids: number[]) => {
        setSelectedAccountIds(ids);
        if (drill.entityType === 'account' && drill.entityId && !ids.includes(drill.entityId)) {
            dispatch({ type: 'DRILL_TO_BREADCRUMB', index: 0 });
        }
    }, [setSelectedAccountIds, drill.entityType, drill.entityId, dispatch]);

    const handleCategoryIdsChange = useCallback((ids: number[]) => {
        setSelectedCategoryIds(ids);
        if (drill.entityType === 'category' && drill.entityId && !ids.includes(drill.entityId)) {
            dispatch({ type: 'DRILL_TO_BREADCRUMB', index: 0 });
        }
    }, [setSelectedCategoryIds, drill.entityType, drill.entityId, dispatch]);

    // ── Scoped timeline (contextualized when filters active) ──
    const hasEntityFilter = selectedAccountIds.length > 0 || selectedCategoryIds.length > 0;
    const entityTimelineFilters = useMemo(() => ({
        granularity: 'daily' as const,
        accountIds: selectedAccountIds.length > 0 ? selectedAccountIds : undefined,
        categoryIds: selectedCategoryIds.length > 0 ? selectedCategoryIds : undefined,
    }), [selectedAccountIds, selectedCategoryIds]);
    const scopedTimeline = usePortfolioTimeline(currentVersionId, entityTimelineFilters, !!currentVersionId && hasEntityFilter);
    const effectiveTimeline = hasEntityFilter ? scopedTimeline : heroTimeline;

    // ── Audit filters from selected filter IDs ──
    // Use relatedAccountIds / relatedAssetIds so the audit matches transactions
    // involving the asset/account in any role (from/to/fee quote), not just as primary.
    const auditFilters = useMemo(() => {
        const filters: Record<string, any> = {};
        if (periodDateFrom && periodDateTo && timeframeRange !== 'all') {
            filters.dateFrom = periodDateFrom;
            filters.dateTo = periodDateTo;
        }
        if (selectedAccountIds.length > 0) filters.relatedAccountIds = selectedAccountIds.map(String);
        if (selectedCategoryIds.length > 0) filters.categoryIds = selectedCategoryIds.map(String);
        return Object.keys(filters).length > 0 ? filters : undefined;
    }, [periodDateFrom, periodDateTo, timeframeRange, selectedAccountIds, selectedCategoryIds]);

    // ── Shared filter state for list views ──
    const [search, setSearch] = useState('');
    const [minMarketValue, setMinMarketValue] = useState(0);
    const [pnlStatus, setPnlStatus] = useState<PnlStatusFilter>('with_pnl');
    const [balanceStatus, setBalanceStatus] = useState<BalanceStatusFilter>('all');

    const filteredTreemapAssets = useMemo(() => {
        return displayAssets.filter(a => {
            if (search && (!a.asset.symbol || !a.asset.symbol.toLowerCase().includes(search.toLowerCase()))) return false;
            if (selectedAccountIds.length > 0) {
                if (!a.account_ids || a.account_ids.length === 0) return false;
                if (!a.account_ids.some((id: number) => selectedAccountIds.includes(id))) return false;
            }
            if (selectedCategoryIds.length > 0) {
                if (!a.category_ids || a.category_ids.length === 0) return false;
                if (!a.category_ids.some((id: number) => selectedCategoryIds.includes(id))) return false;
            }
            if (pnlStatus === 'with_pnl' && !a.has_lots) return false;
            if (pnlStatus === 'no_pnl' && a.has_lots) return false;
            const sym = a.asset.symbol?.toUpperCase() ?? '';
            const liveQty = liveBalanceMap?.get(sym);
            if (balanceStatus === 'mapped' && (liveQty == null || liveQty === 0)) return false;
            if (balanceStatus === 'unmapped' && liveQty != null && liveQty > 0) return false;
            if (minMarketValue > 0 && a.has_lots && a.unit_value != null) {
                const pnlValue = Math.abs(a.market_value);
                const liveValue = liveQty != null && a.unit_value != null ? Math.abs(liveQty * a.unit_value) : pnlValue;
                if (pnlValue < minMarketValue && liveValue < minMarketValue) return false;
            }
            return true;
        });
    }, [displayAssets, search, selectedAccountIds, selectedCategoryIds, pnlStatus, balanceStatus, minMarketValue, liveBalanceMap]);

    const [filteredAssetCount, setFilteredAssetCount] = useState<number>(displayAssets.length);

    // ── Shared assets table ──
    const assetsTable = (
        <>
            <AssetPnLTable
                assets={displayAssets}
                baseCurrency={config.base_currency_symbol}
                onAssetClick={onAssetClick}
                onAccountClick={onAccountClick}
                accountBalances={accountBalances}
                accounts={accounts}
                dimensions={dimensions}
                availableAccountIds={availableAccountIds}
                availableCategoryIds={availableCategoryIds}
                onLoadAccountBalances={onLoadAccountBalances}
                liveBalances={liveBalanceMap}
                liveAccountBalances={liveAccountBalanceMap}
                liveBalanceLoading={liveBalanceLoading}
                unmappedLiveAssets={unmappedLiveAssets}
                liveAccountErrors={liveAccountErrors}
                liveFetchedAccountIds={liveFetchedAccountIds}
                search={search}
                onSearchChange={setSearch}
                minMarketValue={minMarketValue}
                onMinMarketValueChange={setMinMarketValue}
                pnlStatus={pnlStatus}
                onPnlStatusChange={setPnlStatus}
                balanceStatus={balanceStatus}
                onBalanceStatusChange={setBalanceStatus}
                selectedAccountIds={selectedAccountIds}
                onSelectedAccountIdsChange={handleAccountIdsChange}
                selectedCategoryIds={selectedCategoryIds}
                onSelectedCategoryIdsChange={handleCategoryIdsChange}
                contentHidden={assetsView !== 'list'}
                onFilteredCountChange={setFilteredAssetCount}
                backendSummary={scorecardSummary ? {
                    totalCost: scorecardSummary.costBasis,
                    totalUnrealized: scorecardSummary.unrealizedPnl,
                    totalRealized: scorecardSummary.realizedPnl,
                    totalFees: scorecardSummary.totalFees,
                    totalValue: scorecardSummary.portfolioValue,
                } : undefined}
                periodDeltaMap={periodDeltaMap}
                periodLabel={periodLabel}
                pnlVersionId={currentVersionId ?? undefined}
                renderAfterFilters={<ViewModeToggle value={assetsView} onChange={setAssetsView} />}
            />
            {assetsView === 'treemap' && (
                <div className="mx-3 mb-3 mt-1 overflow-hidden border-2 border-blue-100">
                    <AllocationTreemap
                        points={effectiveTimeline.data?.points || []}
                        assetCategoryMaps={assetCategoryMaps}
                        dimensions={dimensions}
                        accounts={accounts}
                        assets={filteredTreemapAssets}
                        baseCurrency={config.base_currency_symbol}
                        isLoading={effectiveTimeline.isLoading}
                        accountBalances={accountBalances}
                        onAssetNavigate={onAssetNavigate}
                        assetCurrencyMap={assetCurrencyMap}
                    />
                </div>
            )}
            {assetsView === 'pie' && (
                <div className="mx-3 mb-3 mt-1 overflow-hidden border-2 border-blue-100">
                    <MarketValuePieChart
                        assets={filteredTreemapAssets}
                        dimensions={dimensions}
                        baseCurrency={config.base_currency_symbol}
                        selectedCategoryIds={selectedCategoryIds}
                        assetCurrencyMap={assetCurrencyMap}
                        onCategoryClick={(catId) => {
                            if (catId == null) return;
                            handleCategoryIdsChange(
                                selectedCategoryIds.includes(catId)
                                    ? selectedCategoryIds.filter(id => id !== catId)
                                    : [...selectedCategoryIds, catId]
                            );
                        }}
                    />
                </div>
            )}
        </>
    );

    // ── Shared audit block ──
    const auditBlock = currentVersionId ? (
        <div className="p-3">
            <InvestigationView
                versionId={currentVersionId}
                baseCurrency={config.base_currency_symbol}
                onTransactionClick={onTransactionClick}
                onAssetClick={onAssetClick}
                onUnitClick={onUnitClick}
                assets={assets.map((a: any) => ({
                    id: a.asset.id ?? 0,
                    symbol: a.asset.symbol ?? '',
                    label: a.asset.label ?? undefined,
                }))}
                initialFilters={auditFilters}
                defaultPanel={auditDefaultPanel}
                onPanelChange={() => {
                    if (auditDefaultPanel) dispatch({ type: 'SET_AUDIT_DEFAULT_PANEL', panel: null });
                }}
            />
        </div>
    ) : null;

    // =====================================================================
    // DRILL (asset or entity) → PnLDetailPanel (metrics + charts + PnL Audit)
    // =====================================================================
    if (isDrilled) {
        return (
            <>
                <DrillDownBreadcrumb />
                <PnLDetailPanel
                    drill={drill}
                    assetsOpen={assetsOpen}
                    auditOpen={auditOpen}
                    onToggleAssets={() => setAssetsOpen(v => !v)}
                    onToggleAudit={() => setAuditOpen(v => !v)}
                    onAssetClick={(id) => onAssetClick(id)}
                    onAccountClick={onAccountClick}
                    onAssetNavigate={onAssetNavigate}
                    onTransactionClick={onTransactionClick}
                    onUnitClick={onUnitClick}
                />
            </>
        );
    }

    // =====================================================================
    // L0 + ENTITY DRILL → Breadcrumb-driven tabs: Assets | PnL Audit
    // =====================================================================
    return (
        <>
            <DrillDownBreadcrumb />

            {showMismatchedOnly && (
                <div className="mb-3 flex items-center gap-2 px-1">
                    <Badge colorScheme="orange">
                        Showing {displayAssets.length} mismatched asset{displayAssets.length !== 1 ? 's' : ''} only
                    </Badge>
                    <span className="cursor-pointer text-xs text-blue-500 hover:underline"
                        onClick={() => dispatch({ type: 'SET_SHOW_MISMATCHED_ONLY', value: false })}>
                        Clear filter
                    </span>
                </div>
            )}

            <div className="mt-2 border border-slate-200 bg-white">
                <SectionToggle label="Assets" defaultOpen open={assetsOpen} onOpenChange={() => setAssetsOpen(v => !v)} badge={`${displayAssets.length}`}>
                    {assetsTable}
                </SectionToggle>
            </div>

            {currentVersionId && (
                <div className="mt-2 border border-slate-200 bg-white">
                    <SectionToggle label="PnL Audit" defaultOpen open={auditOpen} onOpenChange={() => setAuditOpen(v => !v)}>
                        {auditBlock}
                    </SectionToggle>
                </div>
            )}
        </>
    );
};
