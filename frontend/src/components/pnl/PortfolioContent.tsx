/**
 * PortfolioContent — Unified portfolio view (L0 + drill)
 *
 * Renders the main Portfolio content:
 * - Breadcrumb navigation
 * - Level 0: Assets section (List/Treemap/Pie toggle), Charts section, PnL Audit section
 * - Level 1/2: PnLDetailPanel (drill-down detail)
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Badge, Box, Button, Flex, Text } from '@chakra-ui/react';
import { usePnL } from './PnLContext';
import { AssetPnLTable, PnlStatusFilter, BalanceStatusFilter } from './AssetPnLTable';
import { PnLDetailPanel, SectionToggle } from './PnLDetailPanel';
import { InvestigationView } from './InvestigationView';
import { AllocationTreemap } from './AllocationTreemap';
import { MarketValuePieChart } from './MarketValuePieChart';
import { CostBasisVsMarketValueChart } from './CostBasisVsMarketValueChart';
import { AssetPerformanceComparison } from './AssetPerformanceComparison';
import { DrillDownBreadcrumb } from './DrillDownBreadcrumb';
import { ViewModeToggle, type AssetsViewMode } from './ViewModeToggle';

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
}) => {
    const { scorecardSummary } = usePnL();
    const [assetsView, setAssetsView] = useState<AssetsViewMode>('list');
    const [auditOpen, setAuditOpen] = useState(false);
    const auditRef = useRef<HTMLDivElement>(null);
    const handleGoToAudit = useCallback(() => {
        setAuditOpen(true);
        setTimeout(() => auditRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    }, []);

    // Charts section state
    const [chartsOpen, setChartsOpen] = useState(false);
    const [chartsTab, setChartsTab] = useState<'cost-basis' | 'performance'>('cost-basis');
    const chartsRef = useRef<HTMLDivElement>(null);
    const handleGoToCharts = useCallback(() => {
        setChartsOpen(true);
        setTimeout(() => chartsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    }, []);

    // --- Shared filter state (controls both list and treemap) ---
    const [search, setSearch] = useState('');
    const [minMarketValue, setMinMarketValue] = useState(5);
    const [pnlStatus, setPnlStatus] = useState<PnlStatusFilter>('with_pnl');
    const [balanceStatus, setBalanceStatus] = useState<BalanceStatusFilter>('all');

    // Apply shared filters to treemap assets
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

    // Filter timeline points to selected period date range
    const periodFilteredPoints = useMemo(() => {
        const allPoints = heroTimeline.data?.points || [];
        if (!periodDateFrom || !periodDateTo || timeframeRange === 'all') return allPoints;
        return allPoints.filter((p: any) => {
            const d = (p.date ?? p.timestamp ?? '').slice(0, 10);
            return d >= periodDateFrom && d <= periodDateTo;
        });
    }, [heroTimeline.data?.points, periodDateFrom, periodDateTo, timeframeRange]);

    const assetsViewToggle = (
        <ViewModeToggle value={assetsView} onChange={setAssetsView} />
    );

    return (
        <>
            {/* Breadcrumb — always visible ("Portfolio > All" at L0) */}
            <DrillDownBreadcrumb onGoToAudit={handleGoToAudit} onGoToCharts={handleGoToCharts} />

            {/* Level 0: all-assets foldable sections */}
            {drill.level === 0 && (
                <>
                    {showMismatchedOnly && (
                        <Flex align="center" gap={2} mb={3} px={1}>
                            <Badge colorPalette="orange" size="sm">
                                Showing {displayAssets.length} mismatched asset{displayAssets.length !== 1 ? 's' : ''} only
                            </Badge>
                            <Text as="span" fontSize="xs" color="blue.500" cursor="pointer"
                                _hover={{ textDecoration: 'underline' }}
                                onClick={() => dispatch({ type: 'SET_SHOW_MISMATCHED_ONLY', value: false })}>
                                Clear filter
                            </Text>
                        </Flex>
                    )}

                    {/* Assets / Treemap / Pie section */}
                    <Box bg="white" borderRadius="lg" border="1px solid" borderColor="gray.200" mb={3}>
                        <SectionToggle label="Assets" defaultOpen={false} badge={`${filteredAssetCount}`}>
                            {/* AssetPnLTable always rendered for shared filter bar */}
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
                                onSelectedAccountIdsChange={setSelectedAccountIds}
                                selectedCategoryIds={selectedCategoryIds}
                                onSelectedCategoryIdsChange={setSelectedCategoryIds}
                                renderAfterFilters={assetsViewToggle}
                                contentHidden={assetsView !== 'list'}
                                onFilteredCountChange={setFilteredAssetCount}
                                backendSummary={scorecardSummary ? {
                                    totalCost: scorecardSummary.costBasis,
                                    totalUnrealized: scorecardSummary.unrealizedPnl,
                                    totalRealized: scorecardSummary.realizedPnl,
                                    totalFees: scorecardSummary.totalFees,
                                    totalValue: scorecardSummary.portfolioValue,
                                } : undefined}
                            />
                            {assetsView === 'treemap' && (
                                <Box mx={3} mb={3} mt={1} border="2px solid" borderColor="blue.100" borderRadius="md" overflow="hidden">
                                    <AllocationTreemap
                                        points={heroTimeline.data?.points || []}
                                        assetCategoryMaps={assetCategoryMaps}
                                        dimensions={dimensions}
                                        accounts={accounts}
                                        assets={filteredTreemapAssets}
                                        baseCurrency={config.base_currency_symbol}
                                        isLoading={heroTimeline.isLoading}
                                        accountBalances={accountBalances}
                                        onAssetNavigate={onAssetNavigate}
                                    />
                                </Box>
                            )}
                            {assetsView === 'pie' && (
                                <Box mx={3} mb={3} mt={1} border="2px solid" borderColor="blue.100" borderRadius="md" overflow="hidden">
                                    <MarketValuePieChart
                                        assets={filteredTreemapAssets}
                                        dimensions={dimensions}
                                        baseCurrency={config.base_currency_symbol}
                                        selectedCategoryIds={selectedCategoryIds}
                                        onCategoryClick={(catId) => {
                                            if (catId == null) return;
                                            setSelectedCategoryIds(
                                                selectedCategoryIds.includes(catId)
                                                    ? selectedCategoryIds.filter(id => id !== catId)
                                                    : [...selectedCategoryIds, catId]
                                            );
                                        }}
                                    />
                                </Box>
                            )}
                        </SectionToggle>
                    </Box>

                    {/* Charts — collapsed by default, openable via breadcrumb button */}
                    {currentVersionId && (
                        <Box ref={chartsRef} bg="white" borderRadius="lg" border="1px solid" borderColor="gray.200" mb={3}>
                            <SectionToggle label="Charts" defaultOpen={false} open={chartsOpen} onOpenChange={setChartsOpen}>
                                <Flex gap={1} px={2} pb={2}>
                                    <Button
                                        size="2xs"
                                        variant={chartsTab === 'cost-basis' ? 'solid' : 'ghost'}
                                        colorPalette={chartsTab === 'cost-basis' ? 'blue' : 'gray'}
                                        onClick={() => setChartsTab('cost-basis')}
                                    >
                                        Cost Basis vs Value
                                    </Button>
                                    <Button
                                        size="2xs"
                                        variant={chartsTab === 'performance' ? 'solid' : 'ghost'}
                                        colorPalette={chartsTab === 'performance' ? 'blue' : 'gray'}
                                        onClick={() => setChartsTab('performance')}
                                    >
                                        Performance
                                    </Button>
                                </Flex>
                                <Box px={2} pb={2}>
                                    {chartsTab === 'cost-basis' && (
                                        <CostBasisVsMarketValueChart
                                            points={periodFilteredPoints}
                                            baseCurrency={config.base_currency_symbol}
                                            isLoading={heroTimeline.isLoading}
                                        />
                                    )}
                                    {chartsTab === 'performance' && (
                                        <AssetPerformanceComparison
                                            versionId={currentVersionId}
                                            baseCurrency={config.base_currency_symbol}
                                            assets={filteredTreemapAssets}
                                            sharedTimeline={
                                                periodFilteredPoints !== (heroTimeline.data?.points || [])
                                                    ? { ...heroTimeline, data: heroTimeline.data ? { ...heroTimeline.data, points: periodFilteredPoints } : null }
                                                    : heroTimeline
                                            }
                                        />
                                    )}
                                </Box>
                            </SectionToggle>
                        </Box>
                    )}

                    {/* PnL Audit — collapsed by default, openable via breadcrumb button */}
                    {currentVersionId && (
                        <Box ref={auditRef} bg="white" borderRadius="lg" border="1px solid" borderColor="gray.200">
                            <SectionToggle label="PnL Audit" defaultOpen={false} open={auditOpen} onOpenChange={setAuditOpen}>
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
                                    initialFilters={periodDateFrom && periodDateTo && timeframeRange !== 'all' ? { dateFrom: periodDateFrom, dateTo: periodDateTo } : undefined}
                                />
                            </SectionToggle>
                        </Box>
                    )}
                </>
            )}

            {/* Level 1/2: Unified drill detail panel */}
            {drill.level > 0 && (
                <PnLDetailPanel
                    drill={drill}
                    onAssetClick={(id) => onAssetClick(id)}
                    onAccountClick={onAccountClick}
                    onAssetNavigate={onAssetNavigate}
                    onTransactionClick={onTransactionClick}
                    onUnitClick={onUnitClick}
                />
            )}
        </>
    );
};
