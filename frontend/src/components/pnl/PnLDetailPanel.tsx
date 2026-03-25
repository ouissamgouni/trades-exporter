/**
 * PnLDetailPanel — Unified drill-down detail view (Level 1 & 2).
 *
 * Replaces PnLLevel1, PnLLevel2, and DrillSidebar with a single
 * foldable-section layout:
 *
 *   1. Summary metrics row + PnLBreakdownBar  (always visible)
 *   2. Asset cards (foldable, default open for multi-asset scope)
 *   3. Treemap  (foldable, default closed)
 *   4. PnL Audit (InvestigationView with pre-applied filters, foldable, default open for single-asset)
 */
import React, { useMemo, useState } from 'react';
import { Badge, Box, Collapsible, Flex, Text } from '@chakra-ui/react';
import { FiChevronDown, FiChevronRight } from 'react-icons/fi';
import { usePnL } from './PnLContext';
import { MetricItem, fmtCurrency, fmtCurrencySigned } from './TotalReturnScorecard';
import { HeroMetricsBar } from './HeroMetricsBar';
import { AssetPnLTable } from './AssetPnLTable';
import { AllocationTreemap } from './AllocationTreemap';
import { MarketValuePieChart } from './MarketValuePieChart';
import { InvestigationView } from './InvestigationView';
import { ViewModeToggle, type AssetsViewMode } from './ViewModeToggle';
import { useCategoryMaps } from '../../hooks/useCategoryMaps';
import { useVersionMetrics } from '../../hooks/useChartData';
import type { DrillDownState } from './pnlState';
import type { TransactionFilterState } from '../TransactionFilters';
import type { AssetPnLRow } from './types';
import type { RangeKey } from '../../hooks/useChartData';

// ─── Props ──────────────────────────────────────────────────────────────────

export interface PnLDetailPanelProps {
    drill: DrillDownState;
    /** Callbacks bubble up to PnLPanel orchestrator */
    onAssetClick: (assetId: number) => void;
    onAccountClick?: (assetId: number, accountId: number) => void;
    onAssetNavigate: (assetId: number, assetSymbol: string) => void;
    onTransactionClick: (txId: number) => void;
    onUnitClick: (unitId: number) => void;
}

// ─── Section toggle component ───────────────────────────────────────────────

export const SectionToggle: React.FC<{
    label: string;
    defaultOpen: boolean;
    badge?: string;
    /** Inline summary shown in header (visible whether open or closed) */
    summary?: React.ReactNode;
    /** Extra controls rendered on the right side of the header */
    headerRight?: React.ReactNode;
    /** Controlled open state (overrides internal state when provided) */
    open?: boolean;
    /** Controlled open change callback */
    onOpenChange?: (open: boolean) => void;
    children: React.ReactNode;
}> = ({ label, defaultOpen, badge, summary, headerRight, open: controlledOpen, onOpenChange, children }) => {
    const [internalOpen, setInternalOpen] = useState(defaultOpen);
    const open = controlledOpen ?? internalOpen;
    const setOpen = (v: boolean) => { onOpenChange ? onOpenChange(v) : setInternalOpen(v); };
    return (
        <Collapsible.Root open={open} onOpenChange={(d) => setOpen(d.open)}>
            <Collapsible.Trigger asChild>
                <Flex
                    align="center"
                    gap={1.5}
                    py={1.5}
                    px={2}
                    cursor="pointer"
                    _hover={{ bg: 'gray.50' }}
                    borderRadius="md"
                    userSelect="none"
                >
                    {open ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                    <Text fontSize="sm" fontWeight="semibold" color="gray.700">{label}</Text>
                    {badge && <Badge size="xs" variant="subtle" colorPalette="gray">{badge}</Badge>}
                    {summary && <Box ml={1} flex="1" minW={0}>{summary}</Box>}
                    {headerRight && (
                        <Box ml="auto" onClick={(e) => e.stopPropagation()}>
                            {headerRight}
                        </Box>
                    )}
                </Flex>
            </Collapsible.Trigger>
            <Collapsible.Content>
                <Box pt={1} pb={2}>
                    {children}
                </Box>
            </Collapsible.Content>
        </Collapsible.Root>
    );
};

// ─── Main component ─────────────────────────────────────────────────────────

export const PnLDetailPanel: React.FC<PnLDetailPanelProps> = ({
    drill,
    onAssetClick,
    onAccountClick,
    onAssetNavigate,
    onTransactionClick,
    onUnitClick,
}) => {
    const {
        state,
        assets,
        scorecardSummary,
        heroTimeline,
        versionMetrics,
        baseCurrency,
    } = usePnL();

    const { dimensions, accounts, accountBalances, currentVersionId } = state;

    // ── Scoped metrics — flag: true when filtering by entity or single asset ──
    const hasEntityScope = (drill.entityType != null && drill.entityId != null) || drill.assetId != null;

    // ── Scoped version metrics for period-aware drill data ──
    const scopedVersionMetrics = useVersionMetrics(
        currentVersionId,
        {
            assetIds: drill.assetId != null ? [drill.assetId] : undefined,
            accountIds: drill.entityType === 'account' && drill.entityId != null ? [drill.entityId] : undefined,
            categoryIds: drill.entityType === 'category' && drill.entityId != null ? [drill.entityId] : undefined,
        },
        !!currentVersionId && hasEntityScope,
    );

    // ── Scope label ──
    const scopeLabel = useMemo(() => {
        const parts: string[] = [];
        if (drill.entityLabel) parts.push(drill.entityLabel);
        if (drill.assetSymbol) parts.push(drill.assetSymbol);
        if (drill.metric) parts.push(drill.metric.replace('_', ' '));
        return parts.join(' › ') || 'Detail';
    }, [drill]);

    // ── Filter assets by scope ──
    const scopedAssets: AssetPnLRow[] = useMemo(() => {
        let filtered = assets;

        // Filter by entity (category/account)
        if (drill.entityType === 'category' && drill.entityId != null) {
            filtered = filtered.filter(a => a.category_ids.includes(drill.entityId!));
        } else if (drill.entityType === 'account' && drill.entityId != null) {
            filtered = filtered.filter(a => a.account_ids.includes(drill.entityId!));
        }

        // Filter by single asset for L2
        if (drill.assetId != null) {
            filtered = filtered.filter(a => a.asset.id === drill.assetId);
        }

        return filtered;
    }, [assets, drill, dimensions, state.performerDimensionId, accountBalances]);

    const scopedMetrics = useMemo(() => {
        // When entity/asset scope is active, try scoped backend range data first
        if (hasEntityScope) {
            const rangeData = scopedVersionMetrics.data?.ranges?.[(drill.period ?? 'all') as RangeKey];
            if (rangeData) {
                return {
                    totalReturn: rangeData.total_return,
                    roi: rangeData.roi_pct,
                    currentValue: rangeData.current_value,
                    costBasis: rangeData.cost_basis,
                    unrealizedPnl: rangeData.unrealized_pnl,
                    realizedPnl: rangeData.realized_pnl,
                    realizedInPeriod: rangeData.realized_in_period,
                    costBasisInPeriod: rangeData.cost_basis_in_period ?? 0,
                    unrealizedInPeriod: rangeData.unrealized_in_period ?? 0,
                    feesInPeriod: rangeData.fees_in_period ?? 0,
                    totalFees: rangeData.total_return != null ? (scopedAssets.reduce((s, a) => s + (a.total_fees ?? 0), 0)) : 0,
                    feeEntryCount: scopedAssets.reduce((s, a) => s + (a.realized_event_count ?? 0), 0),
                };
            }
        }
        // No entity scope: use global range data
        if (!hasEntityScope) {
            const rangeData = versionMetrics.data?.ranges?.[(drill.period ?? 'all') as RangeKey];
            if (rangeData) {
                return {
                    totalReturn: rangeData.total_return,
                    roi: rangeData.roi_pct,
                    currentValue: rangeData.current_value,
                    costBasis: rangeData.cost_basis,
                    unrealizedPnl: rangeData.unrealized_pnl,
                    realizedPnl: rangeData.realized_pnl,
                    realizedInPeriod: rangeData.realized_in_period,
                    costBasisInPeriod: rangeData.cost_basis_in_period ?? 0,
                    unrealizedInPeriod: rangeData.unrealized_in_period ?? 0,
                    feesInPeriod: rangeData.fees_in_period ?? 0,
                    totalFees: scorecardSummary?.totalFees ?? 0,
                    feeEntryCount: scorecardSummary?.feeEntryCount ?? 0,
                };
            }
        }
        // Compute from scoped assets (entity-filtered)
        const cb = scopedAssets.reduce((s, a) => s + (a.cost_basis ?? 0), 0);
        const ur = scopedAssets.reduce((s, a) => s + (a.unrealized_pnl ?? 0), 0);
        const rp = scopedAssets.reduce((s, a) => s + (a.realized_pnl ?? 0), 0);
        const fees = scopedAssets.reduce((s, a) => s + (a.total_fees ?? 0), 0);
        const feeCount = scopedAssets.reduce((s, a) => s + (a.realized_event_count ?? 0), 0);
        const tr = ur + rp;
        const mv = scopedAssets.reduce((s, a) => s + (a.market_value ?? 0), 0);
        return {
            totalReturn: tr,
            roi: cb > 0 ? (tr / cb) * 100 : 0,
            currentValue: mv,
            costBasis: cb,
            unrealizedPnl: ur,
            realizedPnl: rp,
            realizedInPeriod: rp,
            costBasisInPeriod: cb,
            unrealizedInPeriod: ur,
            feesInPeriod: fees,
            totalFees: fees,
            feeEntryCount: feeCount,
        };
    }, [versionMetrics.data, scopedVersionMetrics.data, drill.period, scorecardSummary, scopedAssets, hasEntityScope]);

    const color = (val: number) => (val >= 0 ? 'green.600' : 'red.600');

    // ── Build initial filters for InvestigationView ──
    const initialFilters: Partial<TransactionFilterState> = useMemo(() => {
        const f: Partial<TransactionFilterState> = {};
        if (drill.assetId != null) {
            f.assetIds = [String(drill.assetId)];
        }
        if (drill.entityType === 'account' && drill.entityId != null) {
            f.accountIds = [String(drill.entityId)];
        }
        return f;
    }, [drill.assetId, drill.entityType, drill.entityId]);

    // ── Asset category maps for treemap ──
    const assetCategoryMaps = useCategoryMaps(dimensions, scopedAssets);

    const isSingleAsset = drill.assetId != null;
    const isMultiAsset = !isSingleAsset;

    const [assetsView, setAssetsView] = useState<AssetsViewMode>('list');

    const assetsViewToggle = isMultiAsset ? (
        <ViewModeToggle value={assetsView} onChange={setAssetsView} />
    ) : null;

    return (
        <Box>
            {/* ── 1. Summary metrics ── */}
            <Box p={3} bg="white" borderRadius="lg" border="1px solid" borderColor="gray.200" mb={3}>
                <Flex align="center" gap={2} mb={2}>
                    <Text fontSize="sm" fontWeight="bold" color="gray.700">{scopeLabel}</Text>
                    <Badge size="xs" variant="subtle" colorPalette="blue">
                        {scopedAssets.length} asset{scopedAssets.length !== 1 ? 's' : ''}
                    </Badge>
                </Flex>

                <HeroMetricsBar
                    totalReturn={scopedMetrics.totalReturn}
                    roi={scopedMetrics.roi}
                    baseCurrency={baseCurrency}
                    costBasisInPeriod={scopedMetrics.costBasisInPeriod}
                    unrealizedInPeriod={scopedMetrics.unrealizedInPeriod}
                    realizedInPeriod={scopedMetrics.realizedInPeriod}
                    feesInPeriod={scopedMetrics.feesInPeriod}
                    fmtCurrencySigned={fmtCurrencySigned}
                    color={color}
                >
                    {drill.period && drill.period !== 'all' ? (
                        <>
                            <MetricItem label="Value Δ" value={fmtCurrencySigned(scopedMetrics.unrealizedInPeriod + scopedMetrics.costBasisInPeriod, baseCurrency)} color={color(scopedMetrics.unrealizedInPeriod + scopedMetrics.costBasisInPeriod)} />
                            <MetricItem label="Cost Δ" value={fmtCurrencySigned(scopedMetrics.costBasisInPeriod, baseCurrency)} color={color(scopedMetrics.costBasisInPeriod)} />
                            <MetricItem label="Unrealized Δ" value={fmtCurrencySigned(scopedMetrics.unrealizedInPeriod, baseCurrency)} color={color(scopedMetrics.unrealizedInPeriod)} />
                            <MetricItem label="Realized Δ" value={fmtCurrencySigned(scopedMetrics.realizedInPeriod, baseCurrency)} color={color(scopedMetrics.realizedInPeriod)} />
                            <MetricItem label="Fees Δ" value={fmtCurrencySigned(scopedMetrics.feesInPeriod, baseCurrency)} color={scopedMetrics.feesInPeriod !== 0 ? 'red.600' : 'gray.600'} />
                        </>
                    ) : (
                        <>
                            <MetricItem label="Value" value={fmtCurrency(scopedMetrics.currentValue, baseCurrency)} color="gray.800" />
                            <MetricItem label="Cost" value={fmtCurrency(scopedMetrics.costBasis, baseCurrency)} color="gray.600" />
                            <MetricItem label="Unrealized" value={fmtCurrencySigned(scopedMetrics.unrealizedPnl, baseCurrency)} color={color(scopedMetrics.unrealizedPnl)} />
                            <MetricItem label="Realized" value={fmtCurrencySigned(scopedMetrics.realizedPnl, baseCurrency)} color={color(scopedMetrics.realizedPnl)} />
                            <MetricItem label="Fees" value={fmtCurrency(scopedMetrics.totalFees, baseCurrency)} color="gray.600" />
                        </>
                    )}
                </HeroMetricsBar>
            </Box>

            {/* ── 2. Assets / Treemap (foldable, toggle between list and treemap) ── */}
            {isMultiAsset && (
                <Box bg="white" borderRadius="lg" border="1px solid" borderColor="gray.200" mb={3}>
                    <SectionToggle label="Assets" defaultOpen badge={`${scopedAssets.length}`}>
                        <AssetPnLTable
                            assets={scopedAssets}
                            baseCurrency={baseCurrency}
                            onAssetClick={(id) => id != null && onAssetClick(id)}
                            onAccountClick={onAccountClick}
                            accountBalances={accountBalances}
                            accounts={accounts}
                            dimensions={dimensions}
                            selectedAccountIds={drill.entityType === 'account' && drill.entityId != null ? [drill.entityId] : undefined}
                            selectedCategoryIds={drill.entityType === 'category' && drill.entityId != null ? [drill.entityId] : undefined}
                            renderAfterFilters={assetsViewToggle}
                            contentHidden={assetsView !== 'list'}
                        />
                        {assetsView === 'treemap' && (
                            <Box mx={3} mb={3} mt={1} border="2px solid" borderColor="blue.100" borderRadius="md" overflow="hidden">
                                <AllocationTreemap
                                    points={heroTimeline.data?.points || []}
                                    assetCategoryMaps={assetCategoryMaps}
                                    dimensions={dimensions}
                                    accounts={accounts}
                                    assets={scopedAssets}
                                    baseCurrency={baseCurrency}
                                    isLoading={heroTimeline.isLoading}
                                    accountBalances={accountBalances}
                                    onAssetNavigate={onAssetNavigate}
                                />
                            </Box>
                        )}
                        {assetsView === 'pie' && (
                            <Box mx={3} mb={3} mt={1} border="2px solid" borderColor="blue.100" borderRadius="md" overflow="hidden">
                                <MarketValuePieChart
                                    assets={scopedAssets}
                                    dimensions={dimensions}
                                    baseCurrency={baseCurrency}
                                />
                            </Box>
                        )}
                    </SectionToggle>
                </Box>
            )}

            {/* ── 3. PnL Audit (foldable, default open for single asset) ── */}
            {currentVersionId && (
                <Box bg="white" borderRadius="lg" border="1px solid" borderColor="gray.200">
                    <SectionToggle label="PnL Audit" defaultOpen={isSingleAsset}>
                        <InvestigationView
                            versionId={currentVersionId}
                            baseCurrency={baseCurrency}
                            onTransactionClick={onTransactionClick}
                            onAssetClick={(id) => onAssetClick(id)}
                            onUnitClick={onUnitClick}
                            initialFilters={initialFilters}
                            assets={scopedAssets.map(a => ({
                                id: a.asset.id ?? 0,
                                symbol: a.asset.symbol ?? '',
                                label: a.asset.label ?? undefined,
                            }))}
                        />
                    </SectionToggle>
                </Box>
            )}
        </Box>
    );
};
