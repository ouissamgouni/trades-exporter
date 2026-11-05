/**
 * ContextView — Unified scoped view for all drill levels.
 *
 * Layout (top to bottom):
 *   1. Breadcrumb row + period cards (scoped ROI%) — always visible
 *   2. Tree-style section toggles:
 *      ├── [±] Overview   — hero metrics, charts, best/worst (scoped)
 *      ├── [±] Assets     — asset list + treemap/pie (scoped, with local filters)
 *      └── [±] PnL Audit  — investigation view (scoped)
 *
 * The ContextScope (derived from navigation) drives ALL sections uniformly.
 * Period cards show ROI% scoped to the current breadcrumb context.
 * Clicking best/worst item or asset name updates scope for the whole view.
 */
import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '../ui/primitives';
import { FiChevronDown, FiChevronRight, FiTrendingUp, FiTrendingDown, FiDollarSign } from 'react-icons/fi';
import { LuInfo, LuReceipt } from 'react-icons/lu';
import { usePnL } from './PnLContext';
import { AssetDetailPanelContext } from '../../contexts/AssetDetailPanelContext';
import { SectionToggle } from './PnLDetailPanel';
import { TimeframeIndicators, RANGES, MetricItem, fmtCurrency, fmtCurrencySigned } from './TotalReturnScorecard';
import { AccountBadge } from '../AccountBadge';
import { PnLBreakdownBar } from './PnLBreakdownBar';
import { formatQuantity } from '../../utils/numberUtils';
import { AssetPnLTable, type PnlStatusFilter, type BalanceStatusFilter } from './AssetPnLTable';
import { AllocationTreemap } from './AllocationTreemap';
import { MarketValuePieChart } from './MarketValuePieChart';
import { InvestigationView } from './InvestigationView';
import { ViewModeToggle, type AssetsViewMode } from './ViewModeToggle';
import { useCategoryMaps } from '../../hooks/useCategoryMaps';
import {
    useVersionMetrics,
    useBookMetrics,
    useLiveMetrics,
    useVersionPerformers,
    usePortfolioTimeline,
    useAssetPeriodDeltas,
} from '../../hooks/useChartData';
import type { ContextScope } from './pnlState';
import type { Range } from './TotalReturnScorecard';
import type { TransactionFilterState } from '../TransactionFilters';
import type { AssetPnLRow, AccountBalanceBreakdown } from './types';
import type { GroupBy, RangeKey, TimelinePoint } from '../../hooks/useChartData';

// ─── Tiny sparkline for collapsed overview ──────────────────────────────────

const MiniSparkline: React.FC<{ points: TimelinePoint[]; width?: number; height?: number }> = ({ points, width = 80, height = 20 }) => {
    if (points.length < 2) return null;
    const values = points.map(p => {
        const cb = p.cost_basis_in_base;
        if (cb <= 0) return 0;
        return ((p.unrealized_pnl + p.cumulative_realized_pnl) / cb) * 100;
    });
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const coords = values.map((v, i) =>
        `${(i / (values.length - 1)) * width},${height - ((v - min) / range) * (height - 2) - 1}`
    ).join(' ');
    const isPositive = values[values.length - 1] >= values[0];
    return (
        <svg width={width} height={height} style={{ display: 'block', flexShrink: 0, border: '1px solid #E2E8F0' }}>
            <polyline fill="none" stroke={isPositive ? '#38A169' : '#E53E3E'} strokeWidth={1.5} points={coords} />
        </svg>
    );
};

// ─── Props ──────────────────────────────────────────────────────────────────

export interface ContextViewProps {
    scope: ContextScope;
    onAssetClick: (assetId: number) => void;
    onAccountClick?: (assetId: number, accountId: number) => void;
    onAssetNavigate: (assetId: number, assetSymbol: string) => void;
    onTransactionClick: (txId: number) => void;
    onUnitClick: (unitId: number) => void;
    onPerformerClick: (id: number, groupType: string, name: string) => void;
    onWarningsClick: () => void;
    onRefreshPrices: () => void;
    isRefreshingPrices: boolean;
    onLoadAccountBalances: () => void;
}

// ─── Component ──────────────────────────────────────────────────────────────

export const ContextView: React.FC<ContextViewProps> = ({
    scope,
    onAssetClick,
    onAccountClick,
    onAssetNavigate,
    onTransactionClick,
    onUnitClick,
    onPerformerClick,
    onWarningsClick,
    onRefreshPrices,
    isRefreshingPrices,
    onLoadAccountBalances,
}) => {
    const {
        state,
        dispatch,
        assets,
        displayAssets,
        scorecardSummary,
        balanceHealth,
        heroTimeline,
        versionMetrics,
        bookMetrics,
        liveMetrics,
        performers,
        pricesReady,
        baseCurrency,
        liveBalanceMap,
        liveAccountBalanceMap,
        liveAccountErrors,
        liveFetchedAccountIds,
        liveBalanceLoading,
        unmappedLiveAssets,
        availableAccountIds,
        availableCategoryIds,
        versionsQuery,
    } = usePnL();

    const {
        dimensions, accounts, accountBalances, currentVersionId,
        prices, summary, pnlAssets, warningTypeCounts,
        performerGroupBy, performerDimensionId, deltaThreshold,
        showMismatchedOnly, timeframeRange, loadingPriceAssetIds,
    } = state;

    const assetPanelCtx = useContext(AssetDetailPanelContext);

    // ── Derived state ──
    const isPortfolio = scope.level === 'portfolio';
    const isAsset = scope.level === 'asset';
    const isMultiAsset = !isAsset;

    // ── Section open state ──
    const [overviewOpen, setOverviewOpen] = useState(true);
    const [assetsOpen, setAssetsOpen] = useState(true);
    const [auditOpen, setAuditOpen] = useState(false);

    // ── Section refs for scroll-to-section ──
    const overviewRef = useRef<HTMLDivElement>(null);
    const assetsRef = useRef<HTMLDivElement>(null);
    const auditRef = useRef<HTMLDivElement>(null);

    // Reset on scope change
    useEffect(() => {
        setOverviewOpen(true);
        setAssetsOpen(true);
        setAuditOpen(false);
    }, [scope.level, scope.entityId]);

    // Reset best/worst groupBy to 'asset' on scope change
    useEffect(() => {
        dispatch({ type: 'SET_PERFORMER_GROUP_BY', groupBy: 'asset' as GroupBy });
    }, [scope.level, scope.entityId, dispatch]);

    // When auditDefaultPanel is set, open audit section
    const auditDefaultPanel = state.auditDefaultPanel;
    useEffect(() => {
        if (auditDefaultPanel) setAuditOpen(true);
    }, [auditDefaultPanel]);

    // ── Scope-based API filters ──
    const hasScope = !isPortfolio;
    const scopeApiFilters = useMemo(() => ({
        assetIds: scope.assetIds,
        accountIds: scope.accountIds,
        categoryIds: scope.categoryIds,
    }), [scope.assetIds, scope.accountIds, scope.categoryIds]);

    // ── Scoped metrics (backend-filtered) ──
    const scopedVersionMetrics = useVersionMetrics(
        currentVersionId,
        {
            ...scopeApiFilters,
            groupBy: performerGroupBy,
            topN: 25,
            dimensionId: performerGroupBy === 'category' ? performerDimensionId : undefined,
        },
        !!currentVersionId && hasScope,
    );

    const scopedBook = useBookMetrics(
        currentVersionId,
        scopeApiFilters,
        !!currentVersionId && hasScope,
    );

    const scopedLive = useLiveMetrics(
        currentVersionId,
        { ...scopeApiFilters, pricesReady },
        !!currentVersionId && hasScope,
    );

    const scopedPerformers = useVersionPerformers(
        currentVersionId,
        {
            period: timeframeRange,
            groupBy: performerGroupBy,
            topN: 500,
            dimensionId: performerGroupBy === 'category' ? performerDimensionId : undefined,
            ...scopeApiFilters,
            pricesReady,
        },
        !!currentVersionId && hasScope,
    );

    // ── Scoped timeline ──
    const timelineFilters = useMemo(() => ({
        granularity: 'daily' as const,
        ...scopeApiFilters,
    }), [scopeApiFilters]);
    const scopedTimeline = usePortfolioTimeline(currentVersionId, timelineFilters, !!currentVersionId && hasScope);

    // ── Asset period deltas for period-aware cards ──
    const assetPeriodDeltas = useAssetPeriodDeltas(
        currentVersionId,
        timeframeRange,
        !!currentVersionId && timeframeRange !== 'all',
    );

    // ── Effective data: scoped when not at portfolio, global otherwise ──
    const effectiveMetrics = hasScope ? scopedVersionMetrics : versionMetrics;
    const effectiveBook = hasScope ? scopedBook : bookMetrics;
    const effectiveLive = hasScope ? scopedLive : liveMetrics;
    const effectivePerformers = hasScope ? scopedPerformers : performers;
    const effectiveTimeline = hasScope ? scopedTimeline : heroTimeline;

    const effectiveSummary = useMemo(() => {
        const s = effectiveBook.data?.summary;
        const m = effectiveLive.data?.summary;
        if (s) {
            return {
                costBasis: s.cost_basis,
                realizedPnl: s.realized_pnl,
                taxableRealizedPnl: s.taxable_realized_pnl ?? 0,
                totalFees: s.total_fees,
                feeEntryCount: s.fee_entry_count,
                portfolioValue: m?.current_value ?? 0,
                unrealizedPnl: m?.unrealized_pnl ?? 0,
            };
        }
        return scorecardSummary;
    }, [effectiveBook.data, effectiveLive.data, scorecardSummary]);

    // ── Filter assets by scope ──
    const scopedAssets: AssetPnLRow[] = useMemo(() => {
        let filtered = assets;
        if (scope.categoryIds?.length) {
            filtered = filtered.filter(a => a.category_ids.some(id => scope.categoryIds!.includes(id)));
        }
        if (scope.accountIds?.length) {
            filtered = filtered.filter(a => a.account_ids.some(id => scope.accountIds!.includes(id)));
        }
        if (scope.assetIds?.length) {
            filtered = filtered.filter(a => scope.assetIds!.includes(a.asset.id!));
        }
        return filtered;
    }, [assets, scope.categoryIds, scope.accountIds, scope.assetIds]);

    const scopedDisplayAssets: AssetPnLRow[] = useMemo(() => {
        let filtered = displayAssets;
        if (scope.categoryIds?.length) {
            filtered = filtered.filter(a => a.category_ids.some(id => scope.categoryIds!.includes(id)));
        }
        if (scope.accountIds?.length) {
            filtered = filtered.filter(a => a.account_ids.some(id => scope.accountIds!.includes(id)));
        }
        return filtered;
    }, [displayAssets, scope.categoryIds, scope.accountIds]);

    // ── Asset category maps for treemap ──
    const assetCategoryMaps = useCategoryMaps(dimensions, scopedAssets);

    // ── Local asset table filters (do NOT affect metrics) ──
    const [search, setSearch] = useState('');
    const [minMarketValue, setMinMarketValue] = useState(0);
    const [pnlStatus, setPnlStatus] = useState<PnlStatusFilter>('with_pnl');
    const [balanceStatus, setBalanceStatus] = useState<BalanceStatusFilter>('all');
    const [assetsView, setAssetsView] = useState<AssetsViewMode>('list');

    // Context-derived filter values for AssetPnLTable (scope shown as active filters)
    const [localAccountIds, setLocalAccountIds] = useState<number[]>([]);
    const [localCategoryIds, setLocalCategoryIds] = useState<number[]>([]);

    // Sync scope filters to local table filters on scope change
    useEffect(() => {
        setLocalAccountIds(scope.accountIds ?? []);
        setLocalCategoryIds(scope.categoryIds ?? []);
        setSearch('');
        setAssetsView('list');
    }, [scope.level, scope.entityId, scope.accountIds, scope.categoryIds]);

    // ── Treemap asset filtering (uses scope-filtered assets, not local table filters) ──
    const filteredTreemapAssets = useMemo(() => {
        return scopedDisplayAssets.filter(a => {
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
    }, [scopedDisplayAssets, pnlStatus, balanceStatus, minMarketValue, liveBalanceMap]);

    // ── InvestigationView filters (scope + period) ──
    const auditFilters = useMemo(() => {
        const f: Partial<TransactionFilterState> = {};
        if (scope.dateFrom && scope.dateTo && scope.period !== 'all') {
            f.dateFrom = scope.dateFrom;
            f.dateTo = scope.dateTo;
        }
        if (scope.assetIds?.length) f.relatedAssetIds = scope.assetIds.map(String);
        if (scope.accountIds?.length) f.relatedAccountIds = scope.accountIds.map(String);
        if (scope.categoryIds?.length) f.categoryIds = scope.categoryIds.map(String);
        return Object.keys(f).length > 0 ? f : undefined;
    }, [scope]);

    // ── Period card ROI (scoped) ──
    const allRangeRois = useMemo(() => {
        const result: Record<Range, number | null> = { all: null, '3y': null, '1y': null, '6m': null, '3m': null, '1m': null, '1w': null };
        const mktData = effectiveLive.data;
        for (const r of RANGES) {
            const mkt = mktData?.ranges?.[r.key as RangeKey];
            if (mkt) result[r.key] = mkt.roi_pct;
        }
        return result;
    }, [effectiveLive.data]);

    // ── Tax status (on-demand) ──
    // Tax tab is always visible when a version exists — no longer gated by jurisdiction

    // ── Account balance breakdowns (for asset-level balance cards) ──
    const accountBreakdowns: AccountBalanceBreakdown[] = useMemo(() => {
        if (!isAsset || !scope.assetIds?.length) return [];
        const assetId = scope.assetIds[0];
        const raw = accountBalances.get(assetId) ?? [];
        const unitValue = scopedAssets[0]?.unit_value;
        return raw.map((b: AccountBalanceBreakdown) => {
            if (unitValue == null || unitValue <= 0) return b;
            const mv = b.qty * unitValue;
            const urPnl = mv - b.cost_basis_in_base;
            const urPct = b.cost_basis_in_base > 0 ? (urPnl / b.cost_basis_in_base) * 100 : 0;
            return { ...b, market_value: mv, unrealized_pnl: urPnl, unrealized_pnl_pct: urPct };
        });
    }, [isAsset, scope.assetIds, accountBalances, scopedAssets]);

    // ── Breadcrumb data ──
    const { breadcrumbs } = state.drill;

    const firstCrumbLabel = breadcrumbs.length > 0 ? breadcrumbs[0].label : 'Portfolio';

    // ═══════════════════════════════════════════════════════════════════
    // Render
    // ═══════════════════════════════════════════════════════════════════

    return (
        <div>
            {/* ─── 1. Breadcrumb + Period Cards row ─── */}
            <div className="mb-0 flex flex-wrap items-center gap-2 border border-gray-200 bg-gray-50 px-3 py-2">
                {/* Breadcrumb trail */}
                <div className="flex flex-wrap items-center gap-1.5">
                    {breadcrumbs.map((crumb, idx) => {
                        const isLast = idx === breadcrumbs.length - 1;
                        const label = idx === 0 ? firstCrumbLabel : crumb.label;
                        return (
                            <React.Fragment key={idx}>
                                {idx > 0 && (
                                    <FiChevronRight
                                        size={14}
                                        className="shrink-0"
                                        color="#A0AEC0"
                                    />
                                )}
                                {isLast ? (
                                    <div className="flex items-center gap-1">
                                        <Badge colorScheme="blue" className="px-2 py-0.5 font-semibold">
                                            {label}
                                        </Badge>
                                        {isAsset && scope.assetIds?.[0] != null && assetPanelCtx && (
                                            <button
                                                type="button"
                                                className="cursor-pointer text-gray-400 hover:text-blue-500"
                                                onClick={() => assetPanelCtx.openAssetPanel(scope.assetIds![0], { pnlVersionId: currentVersionId ?? undefined })}
                                                title="Asset details"
                                            >
                                                <LuInfo size={14} />
                                            </button>
                                        )}
                                    </div>
                                ) : (
                                    <span
                                        className="cursor-pointer whitespace-nowrap text-sm font-medium text-blue-600 hover:underline"
                                        onClick={() => dispatch({ type: 'DRILL_TO_BREADCRUMB', index: idx })}
                                    >
                                        {label}
                                    </span>
                                )}
                            </React.Fragment>
                        );
                    })}
                </div>

                {/* Period cards (scoped ROI%) — right-aligned */}
                <div className="ml-auto flex shrink-0 gap-1 overflow-x-auto">
                    {RANGES.map(r => {
                        const roi = allRangeRois[r.key];
                        const isActive = timeframeRange === r.key;
                        return (
                            <div
                                key={r.key}
                                onClick={() => dispatch({ type: 'SET_TIMEFRAME_RANGE', range: r.key })}
                                className={`min-w-[52px] cursor-pointer border-2 px-1.5 py-1 text-center transition-colors ${isActive ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'}`}
                            >
                                <div className={`text-[10px] font-bold ${isActive ? 'text-blue-700' : 'text-gray-500'}`}>
                                    {r.label}
                                </div>
                                {roi !== null ? (
                                    <div className={`text-[10px] font-bold ${roi >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                        {roi >= 0 ? '+' : ''}{roi.toFixed(1)}%
                                    </div>
                                ) : (
                                    <div className="text-[10px] text-gray-300">—</div>
                                )}
                            </div>
                        );
                    })}
                </div>

                {/* Separator + section nav pills */}
                <div className="mx-2 h-5 w-px shrink-0 bg-gray-300" />
                <div className="flex shrink-0 gap-1">
                    {([
                        { key: 'overview', label: 'Overview', open: overviewOpen, ref: overviewRef },
                        ...(isMultiAsset || currentVersionId ? [{ key: 'assets', label: 'Assets', open: assetsOpen, ref: assetsRef }] : []),
                        ...(currentVersionId ? [{ key: 'audit', label: 'Audit', open: auditOpen, ref: auditRef }] : []),
                    ] as { key: string; label: string; open: boolean; ref: React.RefObject<HTMLDivElement | null> }[]).map(s => (
                        <div
                            key={s.key}
                            className={`min-w-[52px] cursor-pointer border-2 px-1.5 py-1 text-center transition-colors ${s.open ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'}`}
                            onClick={() => {
                                setOverviewOpen(s.key === 'overview');
                                setAssetsOpen(s.key === 'assets');
                                setAuditOpen(s.key === 'audit');
                                setTimeout(() => s.ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
                            }}
                        >
                            <div className={`text-[10px] font-bold ${s.open ? 'text-blue-700' : 'text-gray-500'}`}>
                                {s.label}
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* ─── 2. Tree-style sections ─── */}
            <div className="mt-0 ml-4 border-l-2 border-gray-200 pl-3">
                {/* ── Overview Section ── */}
                <div ref={overviewRef}>
                    <TreeSection
                        label="Overview"
                        open={overviewOpen}
                        onToggle={() => setOverviewOpen(v => !v)}
                        isLast={!isMultiAsset && !currentVersionId}
                        sectionBg="bg-blue-50"
                        headerRight={isAsset && scope.assetIds?.[0] != null && assetPanelCtx ? (
                            <button
                                type="button"
                                onClick={() => assetPanelCtx.openAssetPanel(scope.assetIds![0], { pnlVersionId: currentVersionId ?? undefined })}
                                className="p-0.5 text-gray-400 hover:bg-blue-50 hover:text-blue-500"
                                title="Asset details"
                            >
                                <LuInfo size={12} />
                            </button>
                        ) : undefined}
                        summary={!overviewOpen && effectiveSummary ? (() => {
                            // Use period-specific metrics when a period is selected
                            const settled = effectiveBook.data?.ranges?.[timeframeRange as RangeKey];
                            const market = effectiveLive.data?.ranges?.[timeframeRange as RangeKey];
                            const isPeriod = timeframeRange !== 'all' && (settled || market);

                            const costVal = isPeriod ? (settled?.cost_basis_in_period ?? 0) : effectiveSummary.costBasis;
                            const realizedVal = isPeriod ? (settled?.realized_in_period ?? 0) : effectiveSummary.realizedPnl;
                            const unrealizedVal = isPeriod ? (market?.unrealized_in_period ?? 0) : effectiveSummary.unrealizedPnl;
                            const feesVal = isPeriod ? (settled?.fees_in_period ?? 0) : effectiveSummary.totalFees;
                            const valueVal = isPeriod ? (market?.current_value ?? effectiveSummary.portfolioValue) : effectiveSummary.portfolioValue;
                            const totalReturn = unrealizedVal + realizedVal;
                            const costBase = isPeriod ? costVal : effectiveSummary.costBasis;
                            const roi = costBase > 0 ? (totalReturn / costBase) * 100 : 0;
                            const clr = totalReturn >= 0 ? 'green.600' : 'red.600';
                            const suffix = isPeriod ? ' Δ' : '';
                            return (
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1">
                                        <MetricItem label="ROI" value={`${fmtCurrencySigned(totalReturn, baseCurrency)} (${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%)`} color={clr} icon={totalReturn >= 0 ? <FiTrendingUp size={10} /> : <FiTrendingDown size={10} />} bg={totalReturn >= 0 ? 'green.50' : 'red.50'} compact />
                                        {!isPeriod && <MetricItem label="Value" value={fmtCurrency(valueVal, baseCurrency)} color="gray.800" icon={<FiDollarSign size={10} />} bg="blue.50" compact />}
                                        <MetricItem label={`Cost${suffix}`} value={isPeriod ? fmtCurrencySigned(costVal, baseCurrency) : fmtCurrency(costVal, baseCurrency)} color="gray.700" icon={<LuReceipt size={10} />} bg="gray.100" compact />
                                        <MetricItem label={`Unreal.${suffix}`} value={fmtCurrencySigned(unrealizedVal, baseCurrency)} color={unrealizedVal >= 0 ? 'green.600' : 'red.600'} icon={null} bg={unrealizedVal >= 0 ? 'green.50' : 'red.50'} compact />
                                        <MetricItem label={`Real.${suffix}`} value={fmtCurrencySigned(realizedVal, baseCurrency)} color={realizedVal >= 0 ? 'green.600' : 'red.600'} icon={null} bg={realizedVal >= 0 ? 'green.50' : 'red.50'} compact />
                                        <MetricItem label={`Fees${suffix}`} value={isPeriod ? fmtCurrencySigned(feesVal, baseCurrency) : fmtCurrency(feesVal, baseCurrency)} color="orange.700" icon={null} bg="orange.50" compact />
                                        <MiniSparkline points={effectiveTimeline.data?.points || []} />
                                    </div>
                                    <div className="mt-0.5">
                                        <PnLBreakdownBar costBasis={costBase} unrealizedPnl={unrealizedVal} realizedPnl={realizedVal} fees={feesVal} baseCurrency={baseCurrency} height={4} />
                                    </div>
                                </div>
                            );
                        })() : undefined}
                    >
                        {/* TimeframeIndicators provides hero metrics, chart, PnL bar, best/worst — all scoped */}
                        <TimeframeIndicators
                            points={effectiveTimeline.data?.points || []}
                            baseCurrency={baseCurrency}
                            isLoading={effectiveTimeline.isLoading || effectiveBook.isLoading}
                            summary={effectiveSummary}
                            periodSummaryData={effectiveMetrics.data ?? undefined}
                            bookData={effectiveBook.data ?? undefined}
                            liveData={effectiveLive.data ?? undefined}
                            isLiveLoading={effectiveLive.isLoading}
                            performersData={effectivePerformers.data ?? undefined}
                            isPerformersLoading={effectivePerformers.isLoading}
                            range={timeframeRange}
                            onRangeChange={(r: Range) => dispatch({ type: 'SET_TIMEFRAME_RANGE', range: r })}
                            contextLabel={scope.assetSymbol || scope.entityLabel || undefined}
                            assetId={isAsset && scope.assetIds?.[0] != null ? scope.assetIds[0] : undefined}
                            assetSymbol={isAsset ? scope.assetSymbol : undefined}
                            groupBy={performerGroupBy}
                            onGroupByChange={(g: GroupBy) => dispatch({ type: 'SET_PERFORMER_GROUP_BY', groupBy: g })}
                            onPerformerClick={onPerformerClick}
                            onFeesClick={() => { }}
                            onIncomeClick={() => { }}
                            dimensions={dimensions}
                            selectedDimensionId={performerDimensionId}
                            onDimensionChange={(id: number | null) => dispatch({ type: 'SET_PERFORMER_DIMENSION_ID', id })}
                            versionId={currentVersionId}
                            assets={scopedAssets}
                            hidePeriodCards
                            hidePerformers={isAsset}
                            performerSlot={isAsset && accountBreakdowns.length > 0 ? (
                                <div>
                                    <div className="mb-1.5 text-xs font-semibold text-gray-600">Balance by Account</div>
                                    <div className="flex flex-wrap items-stretch gap-2">
                                        {accountBreakdowns.map(b => {
                                            const urPnl = b.unrealized_pnl ?? 0;
                                            const assetSymbol = scopedAssets[0]?.asset?.symbol;
                                            const liveQty = assetSymbol ? liveAccountBalanceMap?.get(assetSymbol)?.get(b.account_id) : undefined;
                                            return (
                                                <div key={b.account_id} className="min-w-[140px] flex-1 border-l-[3px] border-blue-300 bg-gray-50 px-2.5 py-1.5">
                                                    <AccountBadge accountId={b.account_id} accountName={b.account_name} size="xs" />
                                                    <div className="mt-1.5 flex items-center gap-1">
                                                        <span className="text-xs font-semibold text-gray-700">{formatQuantity(b.qty)}</span>
                                                        {liveQty != null && (
                                                            <Badge colorScheme={Math.abs(b.qty - liveQty) < 0.001 ? 'green' : 'orange'}>
                                                                Live: {formatQuantity(liveQty)}
                                                            </Badge>
                                                        )}
                                                    </div>
                                                    {b.market_value != null && (
                                                        <div className="mt-0.5 text-xs text-gray-600">{fmtCurrency(b.market_value, baseCurrency)}</div>
                                                    )}
                                                    <div className={`mt-0.5 text-xs ${urPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                        {fmtCurrencySigned(urPnl, baseCurrency)}
                                                        {b.unrealized_pnl_pct != null && (
                                                            <span className="ml-1 text-gray-500">({b.unrealized_pnl_pct >= 0 ? '+' : ''}{b.unrealized_pnl_pct.toFixed(1)}%)</span>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ) : undefined}
                        />
                    </TreeSection>
                </div>

                {/* ── Assets Section (multi-asset only) ── */}
                {isMultiAsset && (
                    <div ref={assetsRef}>
                        <TreeSection
                            label="Assets"
                            open={assetsOpen}
                            onToggle={() => setAssetsOpen(v => !v)}
                            isLast={!currentVersionId}
                            badge={`${scopedDisplayAssets.length}`}
                            sectionBg="bg-green-50"
                        >
                            {/* View mode tabs inside section content */}
                            <div className="flex gap-0 border-b border-gray-200 px-3 pt-2">
                                {(['list', 'treemap', 'pie'] as AssetsViewMode[]).map(mode => {
                                    const active = assetsView === mode;
                                    const labels: Record<AssetsViewMode, string> = { list: '📋 List', treemap: '🗺️ Treemap', pie: '🥧 Pie' };
                                    return (
                                        <div
                                            key={mode}
                                            onClick={() => setAssetsView(mode)}
                                            className={`-mb-px cursor-pointer border px-3 py-1.5 text-xs transition-colors ${active ? 'border-blue-200 border-b-0 border-t-2 border-t-blue-500 bg-white font-semibold text-blue-700' : 'border-transparent font-normal text-gray-500 hover:bg-gray-100 hover:text-gray-700'}`}
                                        >
                                            {labels[mode]}
                                        </div>
                                    );
                                })}
                            </div>

                            {/* List view */}
                            {assetsView === 'list' && (
                                <div className="p-2">
                                    <AssetPnLTable
                                        assets={scopedDisplayAssets}
                                        baseCurrency={baseCurrency}
                                        onAssetClick={(id) => id != null && onAssetClick(id)}
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
                                        selectedAccountIds={localAccountIds}
                                        onSelectedAccountIdsChange={setLocalAccountIds}
                                        selectedCategoryIds={localCategoryIds}
                                        onSelectedCategoryIdsChange={setLocalCategoryIds}
                                        backendSummary={effectiveSummary ? {
                                            totalCost: effectiveSummary.costBasis,
                                            totalUnrealized: effectiveSummary.unrealizedPnl,
                                            totalRealized: effectiveSummary.realizedPnl,
                                            totalFees: effectiveSummary.totalFees,
                                            totalValue: effectiveSummary.portfolioValue,
                                        } : undefined}
                                        periodDeltaMap={timeframeRange !== 'all' ? assetPeriodDeltas.deltaMap : undefined}
                                        periodLabel={timeframeRange !== 'all' ? timeframeRange.toUpperCase() : undefined}
                                        pnlVersionId={currentVersionId ?? undefined}
                                    />
                                </div>
                            )}

                            {/* Treemap view */}
                            {assetsView === 'treemap' && (
                                <div className="p-2">
                                    <AllocationTreemap
                                        points={effectiveTimeline.data?.points || []}
                                        assetCategoryMaps={assetCategoryMaps}
                                        dimensions={dimensions}
                                        accounts={accounts}
                                        assets={filteredTreemapAssets}
                                        baseCurrency={baseCurrency}
                                        isLoading={effectiveTimeline.isLoading}
                                        accountBalances={accountBalances}
                                        onAssetNavigate={onAssetNavigate}
                                    />
                                </div>
                            )}

                            {/* Pie view */}
                            {assetsView === 'pie' && (
                                <div className="p-2">
                                    <MarketValuePieChart
                                        assets={filteredTreemapAssets}
                                        dimensions={dimensions}
                                        baseCurrency={baseCurrency}
                                    />
                                </div>
                            )}
                        </TreeSection>
                    </div>
                )}

                {/* ── PnL Audit Section ── */}
                {currentVersionId && (
                    <div ref={auditRef}>
                        <TreeSection
                            label="PnL Audit"
                            open={auditOpen}
                            onToggle={() => setAuditOpen(v => !v)}
                            isLast
                            sectionBg="bg-orange-50"
                        >
                            <div className="p-3">
                                <InvestigationView
                                    versionId={currentVersionId}
                                    baseCurrency={baseCurrency}
                                    onTransactionClick={onTransactionClick}
                                    onAssetClick={(id) => onAssetClick(id)}
                                    onUnitClick={onUnitClick}
                                    initialFilters={auditFilters}
                                    defaultPanel={auditDefaultPanel}
                                    onPanelChange={() => {
                                        if (auditDefaultPanel) dispatch({ type: 'SET_AUDIT_DEFAULT_PANEL', panel: null });
                                    }}
                                    assets={scopedAssets.map(a => ({
                                        id: a.asset.id ?? 0,
                                        symbol: a.asset.symbol ?? '',
                                        label: a.asset.label ?? undefined,
                                    }))}
                                />
                            </div>
                        </TreeSection>
                    </div>
                )}
            </div>
        </div>
    );
};

// ─── TreeSection — tree-style collapsible section toggle ────────────────────

interface TreeSectionProps {
    label: string;
    open: boolean;
    onToggle: () => void;
    isLast?: boolean;
    badge?: string;
    summary?: React.ReactNode;
    headerRight?: React.ReactNode;
    children: React.ReactNode;
    sectionBg?: string;
}

/**
 * A section toggle that looks like a tree branch with highlighted border:
 *   ├── [±] Label
 *   │   content...
 *   └── [±] Last Label
 */
const TreeSection: React.FC<TreeSectionProps> = ({
    label, open, onToggle, isLast = false, badge, summary, headerRight, children, sectionBg,
}) => {
    return (
        <div className="relative">
            {/* Vertical connector to next sibling section */}
            {!isLast && (
                <div className="absolute bottom-0 left-[-15px] top-0 w-0.5 bg-gray-200" />
            )}

            {/* Branch connector */}
            <div className="absolute left-[-15px] top-3 h-0.5 w-3.5 bg-gray-200" />

            {/* Section wrapper with highlighted border */}
            <div
                className={`mb-1 border transition-colors ${open ? `border-blue-300 ${sectionBg ?? 'bg-white'}` : 'border-gray-200 bg-transparent'}`}
            >
                {/* Header */}
                <div
                    className="flex cursor-pointer select-none items-center gap-1.5 px-2 py-1.5 hover:bg-gray-50"
                    onClick={onToggle}
                >
                    {open ? <FiChevronDown size={14} color="#3182CE" /> : <FiChevronRight size={14} />}
                    <span className={`text-sm font-semibold ${open ? 'text-blue-700' : 'text-gray-700'}`}>{label}</span>
                    {badge && <Badge colorScheme="gray">{badge}</Badge>}
                    {summary && <div className="ml-1 min-w-0 flex-1">{summary}</div>}
                    {headerRight && (
                        <div className="ml-auto" onClick={(e) => e.stopPropagation()}>
                            {headerRight}
                        </div>
                    )}
                </div>

                {/* Content */}
                {open && (
                    <div className="border-t border-gray-100 pt-1 pb-2">
                        {children}
                    </div>
                )}
            </div>
        </div>
    );
};
