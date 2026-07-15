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
import { Badge } from '../ui/primitives';
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
        <div>
            <div
                className="flex cursor-pointer select-none items-center gap-1.5 px-2 py-1.5 hover:bg-gray-50"
                onClick={() => setOpen(!open)}
            >
                {open ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                <span className="text-sm font-semibold text-gray-700">{label}</span>
                {badge && <Badge colorScheme="gray">{badge}</Badge>}
                {summary && <div className="ml-1 min-w-0 flex-1">{summary}</div>}
                {headerRight && (
                    <div className="ml-auto" onClick={(e) => e.stopPropagation()}>
                        {headerRight}
                    </div>
                )}
            </div>
            {open && (
                <div className="pb-2 pt-1">
                    {children}
                </div>
            )}
        </div>
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
        <div>
            {/* ── 1. Summary metrics + inline chart ── */}
            <div className="mb-2 border border-gray-200 bg-white">
                <SectionToggle
                    label="Overview"
                    defaultOpen
                    headerRight={isSingleAsset && drill.assetId != null && assetPanelCtx ? (
                        <button
                            type="button"
                            onClick={() => assetPanelCtx.openAssetPanel(drill.assetId!, { pnlVersionId: currentVersionId ?? undefined })}
                            className="p-0.5 text-gray-400 hover:bg-blue-50 hover:text-blue-500"
                            title="Asset details"
                        >
                            <LuInfo size={12} />
                        </button>
                    ) : undefined}
                >
                    <div className="px-2.5">
                        <div className="flex flex-wrap items-start gap-3 lg:flex-nowrap">
                            <div className="min-w-0 flex-1">
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
                                    <div className="mt-2 flex flex-wrap items-stretch gap-2">
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
                                                <div
                                                    key={b.account_id}
                                                    className="min-w-[140px] flex-1 border-l-[3px] border-l-blue-300 bg-gray-50 px-2.5 py-1.5"
                                                >
                                                    <AccountBadge accountId={b.account_id} accountName={b.account_name} size="xs" />
                                                    <div className="mt-1.5 flex items-center gap-1">
                                                        <span className="text-xs font-semibold text-gray-700">
                                                            {formatQuantity(b.qty)}
                                                        </span>
                                                        {isSingleAsset && <DeltaBar delta={delta} liveQty={liveQty} pnlQty={b.qty} size="xs" />}
                                                    </div>
                                                    {b.market_value != null && (
                                                        <div className="mt-0.5 text-xs text-gray-600">
                                                            {fmtCurrency(b.market_value, baseCurrency)}
                                                        </div>
                                                    )}
                                                    <div className={`mt-0.5 text-xs ${urPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                        {fmtCurrencySigned(urPnl, baseCurrency)}
                                                        {b.unrealized_pnl_pct != null && (
                                                            <span className="ml-1 text-gray-500">
                                                                ({b.unrealized_pnl_pct >= 0 ? '+' : ''}{b.unrealized_pnl_pct.toFixed(1)}%)
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}

                                    </div>
                                )}

                                {/* Warnings summary (all scopes) */}
                                {warningCounts.total > 0 && (
                                    <div className="mt-2 flex">
                                        <Tooltip content={scopedWarnings.slice(0, 10).map(w => w.message).join('\n')}>
                                            <div className="flex min-w-[120px] max-w-[280px] flex-col gap-1 border-l-[3px] border-l-orange-400 bg-orange-50 px-2.5 py-1.5">
                                                <div className="flex items-center gap-1">
                                                    <FiAlertTriangle size={12} className="text-orange-500" />
                                                    <span className="text-xs font-semibold text-orange-700">
                                                        Warnings
                                                    </span>
                                                </div>
                                                <div className="flex flex-wrap gap-2">
                                                    {warningCounts.errors > 0 && (
                                                        <Badge colorScheme="red">{warningCounts.errors} error{warningCounts.errors !== 1 ? 's' : ''}</Badge>
                                                    )}
                                                    {warningCounts.warnings > 0 && (
                                                        <Badge colorScheme="orange">{warningCounts.warnings} warn</Badge>
                                                    )}
                                                    {warningCounts.infos > 0 && (
                                                        <Badge colorScheme="blue">{warningCounts.infos} info</Badge>
                                                    )}
                                                </div>
                                            </div>
                                        </Tooltip>
                                    </div>
                                )}
                            </div>

                            {/* Inline chart (compact) */}
                            <div className="w-full flex-shrink-0 lg:w-[38%]">
                                <PeriodChartPanel
                                    points={effectiveTimeline.data?.points || []}
                                    baseCurrency={baseCurrency}
                                    range={state.timeframeRange}
                                    isLoading={effectiveTimeline.isLoading}
                                    versionId={currentVersionId}
                                    assets={scopedAssets}
                                    contextLabel={drill.assetSymbol ?? drill.entityLabel ?? undefined}
                                />
                            </div>
                        </div>
                    </div>
                </SectionToggle>
            </div>

            {/* ── 2. Assets (multi-asset scope only) ── */}
            {isMultiAsset && (
                <div className="mb-3 border border-gray-200 bg-white">
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
                            <div className="mx-3 mb-3 mt-1 overflow-hidden border-2 border-blue-100">
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
                            </div>
                        )}
                        {assetsView === 'pie' && (
                            <div className="mx-3 mb-3 mt-1 overflow-hidden border-2 border-blue-100">
                                <MarketValuePieChart
                                    assets={scopedAssets}
                                    dimensions={dimensions}
                                    baseCurrency={baseCurrency}
                                />
                            </div>
                        )}
                    </SectionToggle>
                </div>
            )}

            {/* ── 3. PnL Audit ── */}
            {currentVersionId && (
                <div className="border border-gray-200 bg-white">
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
                </div>
            )}
        </div>
    );
};
