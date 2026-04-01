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
import React, { useMemo, useState, useContext } from 'react';
import { Badge, Box, Collapsible, Flex, Text } from '@chakra-ui/react';
import { FiChevronDown, FiChevronRight, FiDollarSign, FiTrendingUp, FiTrendingDown, FiAlertTriangle } from 'react-icons/fi';
import { LuReceipt, LuInfo } from 'react-icons/lu';
import { usePnL } from './PnLContext';
import { AssetDetailPanelContext } from '../../contexts/AssetDetailPanelContext';
import { MetricItem, fmtCurrency, fmtCurrencySigned } from './TotalReturnScorecard';
import { HeroMetricsBar } from './HeroMetricsBar';
import { AssetPnLTable } from './AssetPnLTable';
import { AllocationTreemap } from './AllocationTreemap';
import { MarketValuePieChart } from './MarketValuePieChart';
import { PeriodChartPanel } from './PeriodChartPanel';
import { InvestigationView } from './InvestigationView';
import { DeltaBar } from './DeltaBar';
import { computeDelta } from './deltaUtils';
import { ViewModeToggle, type AssetsViewMode } from './ViewModeToggle';
import { AccountBadge } from '../AccountBadge';
import { Tooltip } from '../ui/tooltip';
import { useCategoryMaps } from '../../hooks/useCategoryMaps';
import { useVersionMetrics, usePortfolioTimeline } from '../../hooks/useChartData';
import { formatQuantity } from '../../utils/numberUtils';
import type { Range } from './TotalReturnScorecard';
import type { DrillDownState } from './pnlState';
import type { TransactionFilterState } from '../TransactionFilters';
import type { AssetPnLRow, AccountBalanceBreakdown, PnLWarningItem } from './types';
import type { RangeKey } from '../../hooks/useChartData';

// ─── Props ──────────────────────────────────────────────────────────────────

export interface PnLDetailPanelProps {
    drill: DrillDownState;
    /** Whether the assets section is open */
    assetsOpen?: boolean;
    /** Whether the audit section is open */
    auditOpen?: boolean;
    /** Toggle callbacks for mutual-exclusive accordion sections */
    onToggleAssets?: () => void;
    onToggleAudit?: () => void;
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
    assetsOpen = true,
    auditOpen = false,
    onToggleAssets,
    onToggleAudit,
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
        liveBalanceMap,
        liveAccountBalanceMap,
    } = usePnL();

    const { dimensions, accounts, accountBalances, currentVersionId } = state;

    const assetPanelCtx = useContext(AssetDetailPanelContext);

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

    // ── Scope label ──
    const scopeLabel = useMemo(() => {
        const parts: string[] = [];
        if (drill.entityLabel) parts.push(drill.entityLabel);
        // Only include asset name for single-asset drills
        if (drill.assetId != null) {
            const assetName = scopedAssets[0]?.asset?.label;
            if (assetName) parts.push(assetName);
            else if (drill.assetSymbol) parts.push(drill.assetSymbol);
        }
        if (drill.metric) parts.push(drill.metric.replace('_', ' '));
        return parts.join(' › ') || 'Detail';
    }, [drill, scopedAssets]);

    const scopedMetrics = useMemo(() => {
        // When entity/asset scope is active, try scoped backend range data first
        if (hasEntityScope) {
            const rangeData = scopedVersionMetrics.data?.ranges?.[(state.timeframeRange) as RangeKey];
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
            const rangeData = versionMetrics.data?.ranges?.[(state.timeframeRange) as RangeKey];
            if (rangeData) {
                return {
                    totalReturn: rangeData.total_return,
                    roi: rangeData.roi_pct,
                    currentValue: rangeData.current_value,
                    costBasis: rangeData.cost_basis,
                    unrealizedPnl: rangeData.unrealized_pnl,
                    realizedPnl: rangeData.realized_pnl,
                    taxableRealizedPnl: rangeData.taxable_realized_pnl ?? 0,
                    realizedInPeriod: rangeData.realized_in_period,
                    taxableRealizedInPeriod: (rangeData as any).taxable_realized_in_period ?? 0,
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
            taxableRealizedPnl: 0,
            realizedInPeriod: rp,
            taxableRealizedInPeriod: 0,
            costBasisInPeriod: cb,
            unrealizedInPeriod: ur,
            feesInPeriod: fees,
            totalFees: fees,
            feeEntryCount: feeCount,
        };
    }, [versionMetrics.data, scopedVersionMetrics.data, state.timeframeRange, scorecardSummary, scopedAssets, hasEntityScope]);

    const color = (val: number) => (val >= 0 ? 'green.600' : 'red.600');

    // ── Build initial filters for InvestigationView ──
    // Use relatedAssetIds / relatedAccountIds so the audit matches transactions
    // involving the entity in any role (from/to/fee quote), not just as primary.
    const initialFilters: Partial<TransactionFilterState> = useMemo(() => {
        const f: Partial<TransactionFilterState> = {};
        if (drill.assetId != null) {
            f.relatedAssetIds = [String(drill.assetId)];
        }
        if (drill.entityType === 'account' && drill.entityId != null) {
            f.relatedAccountIds = [String(drill.entityId)];
        }
        if (drill.entityType === 'category' && drill.entityId != null) {
            f.categoryIds = [String(drill.entityId)];
        }
        return f;
    }, [drill.assetId, drill.entityType, drill.entityId]);

    // ── Asset category maps for treemap ──
    const assetCategoryMaps = useCategoryMaps(dimensions, scopedAssets);

    const isSingleAsset = drill.assetId != null;
    const isMultiAsset = !isSingleAsset;

    const [assetsView, setAssetsView] = useState<AssetsViewMode>('list');

    // ── Scoped timeline for inline charts ──
    const timelineFilters = useMemo(() => ({
        granularity: 'daily' as const,
        assetIds: drill.assetId != null ? [drill.assetId] : undefined,
        accountIds: drill.entityType === 'account' && drill.entityId != null ? [drill.entityId] : undefined,
        categoryIds: drill.entityType === 'category' && drill.entityId != null ? [drill.entityId] : undefined,
    }), [drill.assetId, drill.entityType, drill.entityId]);
    const scopedTimeline = usePortfolioTimeline(currentVersionId, timelineFilters, !!currentVersionId && hasEntityScope);
    const effectiveTimeline = hasEntityScope ? scopedTimeline : heroTimeline;

    const assetsViewToggle = isMultiAsset ? (
        <ViewModeToggle value={assetsView} onChange={setAssetsView} />
    ) : null;

    // ── Balance-by-account cards data ──
    const accountBreakdowns: AccountBalanceBreakdown[] = useMemo(() => {
        // Helper: enrich a breakdown with market_value / unrealized_pnl using the asset's live price
        const enrich = (b: AccountBalanceBreakdown, unitValue: number | null | undefined): AccountBalanceBreakdown => {
            if (unitValue == null || unitValue <= 0) return b;
            const mv = b.qty * unitValue;
            const urPnl = mv - b.cost_basis_in_base;
            const urPct = b.cost_basis_in_base > 0 ? (urPnl / b.cost_basis_in_base) * 100 : 0;
            return { ...b, market_value: mv, unrealized_pnl: urPnl, unrealized_pnl_pct: urPct };
        };

        if (isSingleAsset && drill.assetId != null) {
            const raw = accountBalances.get(drill.assetId) ?? [];
            const unitValue = scopedAssets[0]?.unit_value;
            return raw.map(b => enrich(b, unitValue));
        }
        // Entity drill: aggregate across scoped assets
        const byAccount = new Map<number, AccountBalanceBreakdown>();
        for (const asset of scopedAssets) {
            const unitValue = asset.unit_value;
            const balances = accountBalances.get(asset.asset.id ?? 0) ?? [];
            for (const b of balances) {
                const enriched = enrich(b, unitValue);
                const existing = byAccount.get(enriched.account_id);
                if (existing) {
                    existing.qty += enriched.qty;
                    existing.cost_basis_in_base += enriched.cost_basis_in_base;
                    existing.lot_count += enriched.lot_count;
                    existing.market_value = (existing.market_value ?? 0) + (enriched.market_value ?? 0);
                    existing.unrealized_pnl = (existing.unrealized_pnl ?? 0) + (enriched.unrealized_pnl ?? 0);
                } else {
                    byAccount.set(enriched.account_id, { ...enriched });
                }
            }
        }
        // Recompute unrealized % for aggregated entries
        for (const b of byAccount.values()) {
            b.avg_unit_cost_in_base = b.qty > 0 ? b.cost_basis_in_base / b.qty : 0;
            b.unrealized_pnl_pct = b.cost_basis_in_base > 0
                ? ((b.unrealized_pnl ?? 0) / b.cost_basis_in_base) * 100
                : 0;
        }
        return Array.from(byAccount.values());
    }, [isSingleAsset, drill.assetId, scopedAssets, accountBalances]);

    // ── Scoped warnings (PnL engine + synthesized price warnings) ──
    const scopedWarnings: PnLWarningItem[] = useMemo(() => {
        // 1. PnL engine warnings filtered by scope
        let engineWarnings: PnLWarningItem[];
        if (isSingleAsset && drill.assetId != null) {
            engineWarnings = state.warnings.filter(w => w.asset_id === drill.assetId);
        } else {
            const scopedIds = new Set(scopedAssets.map(a => a.asset.id));
            engineWarnings = state.warnings.filter(w => w.asset_id != null && scopedIds.has(w.asset_id));
        }

        // 2. Synthesize price warnings from asset row fields
        const priceWarnings: PnLWarningItem[] = [];
        for (const a of scopedAssets) {
            if (a.price_error) {
                priceWarnings.push({
                    id: `price-error-${a.asset.id}`,
                    level: 'error',
                    warning_type: 'price_fetch_error',
                    message: `${a.asset.symbol ?? a.asset.label ?? 'Unknown'}: price fetch failed — ${a.price_error}`,
                    asset_id: a.asset.id ?? undefined,
                });
            } else if (a.unit_value == null && a.quantity !== 0) {
                priceWarnings.push({
                    id: `price-missing-${a.asset.id}`,
                    level: 'warning',
                    warning_type: 'price_missing',
                    message: `${a.asset.symbol ?? a.asset.label ?? 'Unknown'}: no live price available`,
                    asset_id: a.asset.id ?? undefined,
                });
            } else if (a.price_fetched_at) {
                const ageMs = Date.now() - new Date(a.price_fetched_at).getTime();
                const ageDays = ageMs / (1000 * 60 * 60 * 24);
                if (ageDays > 7) {
                    priceWarnings.push({
                        id: `price-stale-${a.asset.id}`,
                        level: 'warning',
                        warning_type: 'price_stale',
                        message: `${a.asset.symbol ?? a.asset.label ?? 'Unknown'}: price is ${Math.round(ageDays)} days old`,
                        asset_id: a.asset.id ?? undefined,
                    });
                }
            }
        }

        return [...engineWarnings, ...priceWarnings];
    }, [state.warnings, isSingleAsset, drill.assetId, scopedAssets]);

    const warningCounts = useMemo(() => {
        let errors = 0, warnings = 0, infos = 0;
        for (const w of scopedWarnings) {
            if (w.level === 'error') errors++;
            else if (w.level === 'warning') warnings++;
            else infos++;
        }
        return { errors, warnings, infos, total: scopedWarnings.length };
    }, [scopedWarnings]);

    return (
        <Box>
            {/* ── 1. Summary metrics + inline chart ── */}
            <Box bg="white" borderRadius="lg" border="1px solid" borderColor="gray.200" mb={2}>
                <SectionToggle
                    label="Overview"
                    defaultOpen
                    headerRight={isSingleAsset && drill.assetId != null && assetPanelCtx ? (
                        <Box
                            as="button"
                            onClick={() => assetPanelCtx.openAssetPanel(drill.assetId!, { pnlVersionId: currentVersionId ?? undefined })}
                            p={0.5}
                            borderRadius="sm"
                            color="gray.400"
                            _hover={{ color: 'blue.500', bg: 'blue.50' }}
                            title="Asset details"
                        >
                            <LuInfo size={12} />
                        </Box>
                    ) : undefined}
                >
                    <Box px={2.5}>
                        <Flex gap={3} align="flex-start" flexWrap={{ base: 'wrap', lg: 'nowrap' }}>
                            <Box flex="1" minW={0}>
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
                                    {state.timeframeRange !== 'all' ? (
                                        <>
                                            <MetricItem label="Value Δ" value={fmtCurrencySigned(scopedMetrics.unrealizedInPeriod + scopedMetrics.costBasisInPeriod, baseCurrency)} color={color(scopedMetrics.unrealizedInPeriod + scopedMetrics.costBasisInPeriod)} icon={<FiDollarSign size={14} />} bg="blue.50" />
                                            <MetricItem label="Cost Δ" value={fmtCurrencySigned(scopedMetrics.costBasisInPeriod, baseCurrency)} color="gray.700" icon={<LuReceipt size={14} />} bg="gray.100" />
                                            <MetricItem label="Unrealized Δ" value={fmtCurrencySigned(scopedMetrics.unrealizedInPeriod, baseCurrency)} color={color(scopedMetrics.unrealizedInPeriod)} icon={scopedMetrics.unrealizedInPeriod >= 0 ? <FiTrendingUp size={14} /> : <FiTrendingDown size={14} />} bg={scopedMetrics.unrealizedInPeriod >= 0 ? 'green.50' : 'red.50'} />
                                            <MetricItem label="Realized Δ" value={fmtCurrencySigned(scopedMetrics.realizedInPeriod, baseCurrency)} color={color(scopedMetrics.realizedInPeriod)} icon={scopedMetrics.realizedInPeriod >= 0 ? <FiTrendingUp size={14} /> : <FiTrendingDown size={14} />} bg={scopedMetrics.realizedInPeriod >= 0 ? 'green.50' : 'red.50'} />
                                            <MetricItem label="Fees Δ" value={fmtCurrencySigned(scopedMetrics.feesInPeriod, baseCurrency)} color={scopedMetrics.feesInPeriod !== 0 ? 'orange.700' : 'gray.600'} icon={<LuReceipt size={14} />} bg="orange.50" />
                                        </>
                                    ) : (
                                        <>
                                            <MetricItem label="Value" value={fmtCurrency(scopedMetrics.currentValue, baseCurrency)} color="gray.800" icon={<FiDollarSign size={14} />} bg="blue.50" />
                                            <MetricItem label="Cost" value={fmtCurrency(scopedMetrics.costBasis, baseCurrency)} color="gray.700" icon={<LuReceipt size={14} />} bg="gray.100" />
                                            <MetricItem label="Unrealized" value={fmtCurrencySigned(scopedMetrics.unrealizedPnl, baseCurrency)} color={color(scopedMetrics.unrealizedPnl)} icon={scopedMetrics.unrealizedPnl >= 0 ? <FiTrendingUp size={14} /> : <FiTrendingDown size={14} />} bg={scopedMetrics.unrealizedPnl >= 0 ? 'green.50' : 'red.50'} />
                                            <MetricItem label="Realized" value={fmtCurrencySigned(scopedMetrics.realizedPnl, baseCurrency)} color={color(scopedMetrics.realizedPnl)} icon={scopedMetrics.realizedPnl >= 0 ? <FiTrendingUp size={14} /> : <FiTrendingDown size={14} />} bg={scopedMetrics.realizedPnl >= 0 ? 'green.50' : 'red.50'} />
                                            <MetricItem label="Fees" value={fmtCurrency(scopedMetrics.totalFees, baseCurrency)} color="orange.700" icon={<LuReceipt size={14} />} bg="orange.50" />
                                        </>
                                    )}
                                </HeroMetricsBar>

                                {/* ── Balance-by-account + warnings (single-asset only) ── */}
                                {isSingleAsset && accountBreakdowns.length > 0 && (
                                    <Flex gap={2} mt={2} flexWrap="wrap" align="stretch">
                                        {accountBreakdowns.map(b => {
                                            const assetSymbol = isSingleAsset
                                                ? scopedAssets[0]?.asset?.symbol
                                                : undefined;
                                            const liveQty = assetSymbol
                                                ? liveAccountBalanceMap?.get(assetSymbol)?.get(b.account_id)
                                                : undefined;
                                            const delta = computeDelta(b.qty, liveQty);
                                            const urPnl = b.unrealized_pnl ?? 0;
                                            return (
                                                <Box
                                                    key={b.account_id}
                                                    bg="gray.50"
                                                    borderLeft="3px solid"
                                                    borderLeftColor="blue.300"
                                                    borderRadius="sm"
                                                    px={2.5}
                                                    py={1.5}
                                                    minW="140px"
                                                    flex="1"
                                                >
                                                    <AccountBadge accountId={b.account_id} accountName={b.account_name} size="xs" />
                                                    <Flex align="center" gap={1} mt={1.5}>
                                                        <Text fontSize="xs" fontWeight="semibold" color="gray.700">
                                                            {formatQuantity(b.qty)}
                                                        </Text>
                                                        {isSingleAsset && <DeltaBar delta={delta} liveQty={liveQty} pnlQty={b.qty} size="xs" />}
                                                    </Flex>
                                                    {b.market_value != null && (
                                                        <Text fontSize="xs" color="gray.600" mt={0.5}>
                                                            {fmtCurrency(b.market_value, baseCurrency)}
                                                        </Text>
                                                    )}
                                                    <Text fontSize="xs" color={urPnl >= 0 ? 'green.600' : 'red.600'} mt={0.5}>
                                                        {fmtCurrencySigned(urPnl, baseCurrency)}
                                                        {b.unrealized_pnl_pct != null && (
                                                            <Text as="span" color="gray.500" ml={1}>
                                                                ({b.unrealized_pnl_pct >= 0 ? '+' : ''}{b.unrealized_pnl_pct.toFixed(1)}%)
                                                            </Text>
                                                        )}
                                                    </Text>
                                                </Box>
                                            );
                                        })}

                                    </Flex>
                                )}

                                {/* Warnings summary (all scopes) */}
                                {warningCounts.total > 0 && (
                                    <Flex mt={2}>
                                        <Tooltip content={scopedWarnings.slice(0, 10).map(w => w.message).join('\n')}>
                                            <Flex
                                                bg="orange.50"
                                                borderLeft="3px solid"
                                                borderLeftColor="orange.400"
                                                borderRadius="sm"
                                                px={2.5}
                                                py={1.5}
                                                minW="120px"
                                                maxW="280px"
                                                direction="column"
                                                gap={1}
                                            >
                                                <Flex align="center" gap={1}>
                                                    <FiAlertTriangle size={12} color="var(--chakra-colors-orange-500)" />
                                                    <Text fontSize="xs" fontWeight="semibold" color="orange.700">
                                                        Warnings
                                                    </Text>
                                                </Flex>
                                                <Flex gap={2} flexWrap="wrap">
                                                    {warningCounts.errors > 0 && (
                                                        <Badge size="xs" colorPalette="red">{warningCounts.errors} error{warningCounts.errors !== 1 ? 's' : ''}</Badge>
                                                    )}
                                                    {warningCounts.warnings > 0 && (
                                                        <Badge size="xs" colorPalette="orange">{warningCounts.warnings} warn</Badge>
                                                    )}
                                                    {warningCounts.infos > 0 && (
                                                        <Badge size="xs" colorPalette="blue">{warningCounts.infos} info</Badge>
                                                    )}
                                                </Flex>
                                            </Flex>
                                        </Tooltip>
                                    </Flex>
                                )}
                            </Box>

                            {/* Inline chart (compact) */}
                            <Box w={{ base: '100%', lg: '38%' }} flexShrink={0}>
                                <PeriodChartPanel
                                    points={effectiveTimeline.data?.points || []}
                                    baseCurrency={baseCurrency}
                                    range={state.timeframeRange}
                                    isLoading={effectiveTimeline.isLoading}
                                    versionId={currentVersionId}
                                    assets={scopedAssets}
                                    contextLabel={drill.assetSymbol ?? drill.entityLabel ?? undefined}
                                />
                            </Box>
                        </Flex>
                    </Box>
                </SectionToggle>
            </Box>

            {/* ── 2. Assets (multi-asset scope only) ── */}
            {isMultiAsset && (
                <Box bg="white" borderRadius="lg" border="1px solid" borderColor="gray.200" mb={3}>
                    <SectionToggle label="Assets" defaultOpen open={assetsOpen} onOpenChange={() => onToggleAssets?.()} badge={`${scopedAssets.length}`}>
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
                            pnlVersionId={currentVersionId ?? undefined}
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

            {/* ── 3. PnL Audit ── */}
            {currentVersionId && (
                <Box bg="white" borderRadius="lg" border="1px solid" borderColor="gray.200">
                    <SectionToggle label="PnL Audit" defaultOpen={false} open={auditOpen} onOpenChange={() => onToggleAudit?.()}>
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
