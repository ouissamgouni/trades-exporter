/**
 * ContextView — Unified scoped view for all drill levels.
 *
 * Layout:
 *   Sticky bar: breadcrumb · [Performance | P&L audit] tabs · period presets
 *   Performance: overview (cards, accounts, contributors + chart) then Assets
 *   P&L audit: investigation view
 *
 * The ContextScope (derived from navigation) drives every section.
 */
import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { hasLocateInUrl } from '../../utils/pnlLocate';
import { Badge } from '../ui/primitives';
import { FiChevronRight, FiX } from 'react-icons/fi';
import { LuInfo } from 'react-icons/lu';
import { usePnL } from './PnLContext';
import { AssetDetailPanelContext } from '../../contexts/AssetDetailPanelContext';
import { TimeframeIndicators, RANGES, fmtCurrency, fmtCurrencySigned } from './TotalReturnScorecard';
import { AccountsStrip } from './AccountsStrip';
import { AssetsSection } from './AssetsSection';
import { PeriodPresets, type PeriodMetric } from './PeriodPresets';
import { BenchmarkSummary } from './BenchmarkSummary';
import { seriesReturnBetween } from './chartUtils';
import { AccountBadge } from '../AccountBadge';
import { formatQuantity } from '../../utils/numberUtils';
import type { PnlStatusFilter, BalanceStatusFilter } from './AssetPnLTable';
import { AllocationTreemap } from './AllocationTreemap';
import { MarketValuePieChart } from './MarketValuePieChart';
import { InvestigationView } from './InvestigationView';
import { useCategoryMaps } from '../../hooks/useCategoryMaps';
import {
    BENCHMARK_PRESETS,
    useVersionMetrics,
    useBookMetrics,
    useLiveMetrics,
    useVersionPerformers,
    usePortfolioTimeline,
    useAssetPeriodDeltas,
    useAccountSparklines,
    useReturnMetrics,
    useMultiBenchmarkSeries,
} from '../../hooks/useChartData';
import type { ContextScope } from './pnlState';
import type { Range } from './TotalReturnScorecard';
import type { TransactionFilterState } from '../TransactionFilters';
import type { AssetPnLRow, AccountBalanceBreakdown } from './types';
import type { GroupBy, RangeKey, PerformerItem } from '../../hooks/useChartData';

type ContextTab = 'performance' | 'audit';
const BENCHMARK_KEY = 'pnl.benchmark';
const PERIOD_METRIC_KEY = 'pnl.periodMetric';

function initialTab(): ContextTab {
    if (hasLocateInUrl()) return 'audit';
    return new URLSearchParams(window.location.search).get('tab') === 'audit' ? 'audit' : 'performance';
}

function rangeStartDate(range: Range): string | null {
    const days = RANGES.find(r => r.key === range)?.days;
    if (!days) return null;
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
}

// ─── Props ──────────────────────────────────────────────────────────────────

export interface ContextViewProps {
    scope: ContextScope;
    onAssetClick: (assetId: number) => void;
    onAccountClick?: (assetId: number, accountId: number) => void;
    onAssetNavigate: (assetId: number, assetSymbol: string) => void;
    onTransactionClick: (txId: number) => void;
    onUnitClick: (unitId: number) => void;
    onPerformerClick: (id: number, groupType: string, name: string) => void;
    onToggleAccountScope: (accountId: number, name: string) => void;
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
    onToggleAccountScope,
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
    const isAccountScope = scope.level === 'account';
    const isMultiAsset = !isAsset;
    const periodLabel = RANGES.find(r => r.key === timeframeRange)?.label ?? 'All';

    // ── Tabs / page-wide preferences ──
    const [tab, setTab] = useState<ContextTab>(initialTab);
    const [periodMetric, setPeriodMetric] = useState<PeriodMetric>(() => (localStorage.getItem(PERIOD_METRIC_KEY) === 'twr' ? 'twr' : 'roi'));
    const [mainBenchmark, setMainBenchmark] = useState<string>(() => {
        const v = localStorage.getItem(BENCHMARK_KEY);
        return v && BENCHMARK_PRESETS.some(b => b.ticker === v) ? v : '^GSPC';
    });
    useEffect(() => { localStorage.setItem(PERIOD_METRIC_KEY, periodMetric); }, [periodMetric]);
    useEffect(() => { localStorage.setItem(BENCHMARK_KEY, mainBenchmark); }, [mainBenchmark]);

    const overviewRef = useRef<HTMLDivElement>(null);
    const assetsRef = useRef<HTMLDivElement>(null);
    const scrollTo = (ref: React.RefObject<HTMLDivElement | null>) =>
        setTimeout(() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);

    // Reset best/worst groupBy to 'asset' on scope change
    useEffect(() => {
        dispatch({ type: 'SET_PERFORMER_GROUP_BY', groupBy: 'asset' as GroupBy });
    }, [scope.level, scope.entityId, dispatch]);

    // ── URL state: period + contributors grouping ──
    const urlInitRef = useRef(false);
    useEffect(() => {
        if (urlInitRef.current) return;
        urlInitRef.current = true;
        const params = new URLSearchParams(window.location.search);
        const period = params.get('period');
        if (period && RANGES.some(r => r.key === period) && period !== timeframeRange) {
            dispatch({ type: 'SET_TIMEFRAME_RANGE', range: period as Range });
        }
        const contrib = params.get('contrib');
        if (contrib === 'account' || contrib === 'category') {
            dispatch({ type: 'SET_PERFORMER_GROUP_BY', groupBy: contrib as GroupBy });
            const dim = Number(params.get('dim'));
            if (contrib === 'category' && dim) dispatch({ type: 'SET_PERFORMER_DIMENSION_ID', id: dim });
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!urlInitRef.current) return;
        const params = new URLSearchParams(window.location.search);
        if (timeframeRange === 'all') params.delete('period'); else params.set('period', timeframeRange);
        if (performerGroupBy === 'asset') params.delete('contrib'); else params.set('contrib', performerGroupBy);
        if (performerGroupBy === 'category' && performerDimensionId != null) params.set('dim', String(performerDimensionId)); else params.delete('dim');
        if (tab === 'audit') params.set('tab', 'audit'); else params.delete('tab');
        const qs = params.toString();
        window.history.replaceState(window.history.state, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
    }, [timeframeRange, performerGroupBy, performerDimensionId, tab]);

    // When auditDefaultPanel is set, open the audit tab
    const auditDefaultPanel = state.auditDefaultPanel;
    useEffect(() => {
        if (auditDefaultPanel) setTab('audit');
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

    // ── Per-account cards (strip) ──
    const showAccountsStrip = !isAsset;
    const accountPerformers = useVersionPerformers(
        currentVersionId,
        {
            period: timeframeRange,
            groupBy: 'account',
            topN: 500,
            assetIds: scope.assetIds,
            categoryIds: scope.categoryIds,
            pricesReady,
        },
        !!currentVersionId && showAccountsStrip,
    );
    const accountItems: PerformerItem[] = useMemo(() => {
        const d = accountPerformers.data;
        return d ? [...(d.top_performers ?? []), ...(d.flop_performers ?? [])] : [];
    }, [accountPerformers.data]);
    const accountSparklines = useAccountSparklines(
        currentVersionId,
        accountItems.map(a => a.id),
        timeframeRange,
        { assetIds: scope.assetIds, categoryIds: scope.categoryIds },
        !!currentVersionId && showAccountsStrip,
    );

    // ── TWR / IRR per period, and main benchmark returns per period ──
    const returnMetrics = useReturnMetrics(currentVersionId, scopeApiFilters, !!currentVersionId);

    // ── Asset period deltas (period columns + income) ──
    const assetPeriodDeltas = useAssetPeriodDeltas(
        currentVersionId,
        timeframeRange,
        !!currentVersionId,
        scopeApiFilters,
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

    // Context-derived filter values for AssetPnLTable (scope shown as active filters)
    const [localAccountIds, setLocalAccountIds] = useState<number[]>([]);
    const [localCategoryIds, setLocalCategoryIds] = useState<number[]>([]);

    // Sync scope filters to local table filters on scope change
    useEffect(() => {
        setLocalAccountIds(scope.accountIds ?? []);
        setLocalCategoryIds(scope.categoryIds ?? []);
        setSearch('');
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

    const allRangeTwrs = useMemo(() => {
        const result: Record<Range, number | null> = { all: null, '3y': null, '1y': null, '6m': null, '3m': null, '1m': null, '1w': null };
        for (const r of RANGES) result[r.key] = returnMetrics.data?.ranges?.[r.key]?.twr_pct ?? null;
        return result;
    }, [returnMetrics.data]);

    const timelineStart = effectiveTimeline.data?.points?.[0]?.date ?? null;
    const today = new Date().toISOString().slice(0, 10);
    const [mainBenchmarkSeries] = useMultiBenchmarkSeries([mainBenchmark], timelineStart, today, !!timelineStart, baseCurrency);
    const mainBenchmarkLabel = BENCHMARK_PRESETS.find(b => b.ticker === mainBenchmark)?.label ?? mainBenchmark;
    const benchmarkReturns = useMemo(() => {
        const result: Record<Range, number | null> = { all: null, '3y': null, '1y': null, '6m': null, '3m': null, '1m': null, '1w': null };
        const pts = mainBenchmarkSeries?.data?.points ?? [];
        for (const r of RANGES) result[r.key] = seriesReturnBetween(pts, rangeStartDate(r.key));
        return result;
    }, [mainBenchmarkSeries?.data]);

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

    const tabs: { key: ContextTab; label: string }[] = [
        { key: 'performance', label: 'Performance' },
        ...(currentVersionId ? [{ key: 'audit' as const, label: 'P&L audit' }] : []),
    ];

    return (
        <div>
            {/* ─── Sticky bar: breadcrumb, tabs, period ─── */}
            <div className="sticky top-0 z-20 border border-gray-200 bg-gray-50/95 px-3 pt-2 backdrop-blur">
                <div className="flex flex-wrap items-center gap-1.5">
                    {breadcrumbs.map((crumb, idx) => {
                        const isLast = idx === breadcrumbs.length - 1;
                        const label = idx === 0 ? firstCrumbLabel : crumb.label;
                        return (
                            <React.Fragment key={idx}>
                                {idx > 0 && <FiChevronRight size={14} className="shrink-0" color="#A0AEC0" />}
                                {isLast ? (
                                    <div className="flex items-center gap-1">
                                        <Badge colorScheme="blue" className="px-2 py-0.5 font-semibold">
                                            {label}
                                        </Badge>
                                        {isAccountScope && idx > 0 && (
                                            <button
                                                type="button"
                                                className="text-gray-400 hover:text-blue-500"
                                                onClick={() => dispatch({ type: 'DRILL_RESET' })}
                                                title="Clear account scope"
                                                aria-label="Clear account scope"
                                            >
                                                <FiX size={13} />
                                            </button>
                                        )}
                                        {isAsset && scope.assetIds?.[0] != null && assetPanelCtx && (
                                            <button
                                                type="button"
                                                className="cursor-pointer text-gray-400 hover:text-blue-500"
                                                onClick={() => assetPanelCtx.openAssetPanel(scope.assetIds![0], { pnlVersionId: currentVersionId ?? undefined })}
                                                title="Asset details"
                                                aria-label="Asset details"
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

                <div className="mt-1 flex flex-wrap items-end gap-x-4 gap-y-2">
                    <div className="flex items-end" role="tablist" aria-label="P&L sections">
                        {tabs.map(t => (
                            <button
                                key={t.key}
                                type="button"
                                role="tab"
                                aria-selected={tab === t.key}
                                onClick={() => setTab(t.key)}
                                className={`-mb-px h-10 border-b-2 px-4 text-sm transition-colors ${tab === t.key ? 'border-blue-500 font-semibold text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
                                data-testid={`context-tab-${t.key}`}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>
                    {tab === 'performance' && isMultiAsset && (
                        <div className="flex items-center gap-2 pb-2.5 text-xs text-gray-500">
                            <button type="button" className="hover:text-blue-600 hover:underline" onClick={() => scrollTo(overviewRef)}>Overview</button>
                            <span>·</span>
                            <button type="button" className="hover:text-blue-600 hover:underline" onClick={() => scrollTo(assetsRef)}>Assets ({scopedDisplayAssets.length}) ↓</button>
                        </div>
                    )}
                    <div className="ml-auto pb-2">
                        <PeriodPresets
                            range={timeframeRange}
                            onChange={(r) => dispatch({ type: 'SET_TIMEFRAME_RANGE', range: r })}
                            metric={periodMetric}
                            onMetricChange={setPeriodMetric}
                            roi={allRangeRois}
                            twr={allRangeTwrs}
                            benchmark={{ label: mainBenchmarkLabel, returns: benchmarkReturns }}
                            periodSpan={timeframeRange === 'all' || !scope.dateFrom ? 'All time' : `${scope.dateFrom} → today`}
                        />
                    </div>
                </div>
            </div>

            {tab === 'performance' ? (
                <div className="mt-3 flex flex-col gap-4">
                    <div ref={overviewRef} className="scroll-mt-32">
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
                            dimensions={dimensions}
                            selectedDimensionId={performerDimensionId}
                            onDimensionChange={(id: number | null) => dispatch({ type: 'SET_PERFORMER_DIMENSION_ID', id })}
                            versionId={currentVersionId}
                            assets={scopedAssets}
                            hidePeriodCards
                            hidePerformers={isAsset}
                            returnMetrics={returnMetrics.data?.ranges?.[timeframeRange] ?? null}
                            mainBenchmark={mainBenchmark}
                            benchmarkSlot={currentVersionId ? (
                                <BenchmarkSummary
                                    versionId={currentVersionId}
                                    ticker={mainBenchmark}
                                    onTickerChange={setMainBenchmark}
                                    period={timeframeRange}
                                    baseCurrency={baseCurrency}
                                    scope={scopeApiFilters}
                                />
                            ) : undefined}
                            accountsSlot={showAccountsStrip ? (
                                <AccountsStrip
                                    items={accountItems}
                                    baseCurrency={baseCurrency}
                                    periodLabel={periodLabel}
                                    isPeriod={timeframeRange !== 'all'}
                                    isLoading={accountPerformers.isLoading}
                                    overviewValue={isAccountScope ? null : effectiveLive.data?.ranges?.[timeframeRange as RangeKey]?.current_value ?? null}
                                    sparklines={accountSparklines.data?.accounts}
                                    onAccountClick={(id, name) => onPerformerClick(id, 'account', name)}
                                    selectedIds={isAccountScope ? scope.accountIds : []}
                                    onToggleAccount={onToggleAccountScope}
                                    twr={accountSparklines.data?.twr}
                                    benchmark={{ label: mainBenchmarkLabel, returnPct: benchmarkReturns[timeframeRange] }}
                                />
                            ) : isAsset && accountBreakdowns.length > 0 ? (
                                <div>
                                    <div className="mb-1.5 text-sm font-semibold text-gray-700">Balance by account</div>
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
                    </div>

                    {isMultiAsset && (
                        <div ref={assetsRef} className="scroll-mt-32">
                            <div className="mb-2 flex items-center gap-2 border-b border-slate-200 pb-1">
                                <span className="text-base font-semibold text-gray-800">Assets</span>
                                <Badge colorScheme="gray">{scopedDisplayAssets.length}</Badge>
                                <span className="border border-slate-200 px-1.5 text-[10px] font-semibold text-slate-500">{periodLabel}</span>
                            </div>
                            <AssetsSection
                                assets={scopedDisplayAssets}
                                baseCurrency={baseCurrency}
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
                                liveAccountErrors={liveAccountErrors}
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
                                periodDeltaMap={assetPeriodDeltas.deltaMap}
                                periodLabel={timeframeRange !== 'all' ? periodLabel : undefined}
                                accountPerformers={accountItems}
                                pnlVersionId={currentVersionId ?? undefined}
                                renderAllocation={(mode) => mode === 'treemap' ? (
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
                                ) : (
                                    <MarketValuePieChart
                                        assets={filteredTreemapAssets}
                                        dimensions={dimensions}
                                        baseCurrency={baseCurrency}
                                    />
                                )}
                            />
                        </div>
                    )}
                </div>
            ) : currentVersionId ? (
                <div className="mt-3 border border-slate-200 bg-white p-3">
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
            ) : null}
        </div>
    );
};
