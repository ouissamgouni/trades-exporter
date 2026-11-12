/**
 * AssetsSection — holdings view for the P&L page.
 *
 * One toolbar (search · filters popover with chips · group · view · columns), then:
 *   - Table: configurable columns, period Δ columns when a period is selected, sticky header and
 *     first column, collapsible group rows with subtotals, per-account expansion, totals footer
 *   - Cards (default): AssetPnLCard grid, split into best / worst halves; account aggregate cards
 *     when grouped by account
 *   - Allocation: treemap / pie rendered by the parent
 */
import React, { Fragment, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { FiAlertCircle, FiChevronDown, FiChevronRight, FiColumns, FiDollarSign, FiFilter, FiSearch, FiSliders, FiTrendingDown, FiTrendingUp, FiX } from 'react-icons/fi';
import { LuInfo, LuReceipt } from 'react-icons/lu';
import { Badge, Input, Spinner } from '../ui/primitives';
import { Tooltip } from '../ui/tooltip';
import { AssetDetailPanelContext } from '../../contexts/AssetDetailPanelContext';
import { getAccountColor } from '../../utils/accountColors';
import { AssetPnLCard } from './AssetPnLCard';
import { AccountPnLCard, accountAssetDetails, aggregateByAccount, liveValueByAccount } from './AccountPnLCard';
import { HeroMetricsBar } from './HeroMetricsBar';
import { DeltaBar } from './DeltaBar';
import { computeDelta } from './deltaUtils';
import { renderCost, renderValue, type BalanceStatusFilter, type PnlStatusFilter } from './AssetPnLTable';
import { MetricItem, fmtCurrency, fmtCurrencySigned, realizedSubLines } from './TotalReturnScorecard';
import { TERM_HELP, InfoTip } from './pnlTerms';
import type { AccountBalanceBreakdown, AssetPnLRow } from './types';
import type { Account, DimensionWithCategories } from '../../types';
import type { AssetPeriodDelta, PerformerItem } from '../../hooks/useChartData';

// ─── Types ──────────────────────────────────────────────────────────────────

export type AssetsViewMode = 'table' | 'cards' | 'allocation';
export type PositionFilter = 'all' | 'open' | 'closed';

export type ColumnId =
    | 'weight' | 'qty' | 'unitCost' | 'price' | 'value' | 'cost' | 'bought'
    | 'unrealized' | 'realized' | 'totalReturn' | 'fees' | 'income'
    | 'taxRealized' | 'taxIfSold' | 'deferred' | 'live' | 'lots' | 'efficiency'
    | 'retDelta' | 'roiDelta' | 'unrealDelta' | 'realDelta';

type SortKey = ColumnId | 'asset';

interface ColumnDef {
    id: ColumnId;
    label: string;
    group: 'Position' | 'P&L' | 'Period' | 'Tax' | 'Other';
    periodOnly?: boolean;
    sortable?: boolean;
    summable?: boolean;
    info?: string;
}

export const COLUMNS: ColumnDef[] = [
    { id: 'weight', label: 'Weight', group: 'Position', sortable: true },
    { id: 'qty', label: 'Qty', group: 'Position', sortable: true },
    { id: 'unitCost', label: 'Unit cost', group: 'Position', sortable: true },
    { id: 'price', label: 'Price', group: 'Position', sortable: true },
    { id: 'value', label: 'Value', group: 'Position', sortable: true, summable: true },
    { id: 'cost', label: 'Cost', group: 'Position', sortable: true, summable: true, info: TERM_HELP.cost },
    { id: 'bought', label: 'Bought', group: 'Position', sortable: true, summable: true, info: TERM_HELP.totalBought },
    { id: 'unrealized', label: 'Unrealized', group: 'P&L', sortable: true, summable: true },
    { id: 'realized', label: 'Realized', group: 'P&L', sortable: true, summable: true, info: TERM_HELP.realized },
    { id: 'totalReturn', label: 'Total return', group: 'P&L', sortable: true, summable: true },
    { id: 'fees', label: 'Fees', group: 'P&L', sortable: true, summable: true },
    { id: 'income', label: 'Income', group: 'P&L', sortable: true, summable: true },
    { id: 'retDelta', label: 'Return Δ', group: 'Period', periodOnly: true, sortable: true, summable: true },
    { id: 'roiDelta', label: 'ROI Δ', group: 'Period', periodOnly: true, sortable: true },
    { id: 'unrealDelta', label: 'Unrealized Δ', group: 'Period', periodOnly: true, sortable: true, summable: true },
    { id: 'realDelta', label: 'Realized Δ', group: 'Period', periodOnly: true, sortable: true, summable: true },
    { id: 'taxRealized', label: 'Taxable realized', group: 'Tax', sortable: true, summable: true, info: TERM_HELP.taxable },
    { id: 'taxIfSold', label: 'Taxable if sold', group: 'Tax', sortable: true, summable: true, info: TERM_HELP.taxableIfSold },
    { id: 'deferred', label: 'Deferred', group: 'Tax', sortable: true, summable: true, info: TERM_HELP.deferred },
    { id: 'live', label: 'Live Δ', group: 'Other' },
    { id: 'lots', label: 'Lots', group: 'Other', sortable: true },
    { id: 'efficiency', label: 'Efficiency', group: 'Other', sortable: true },
];

export const DEFAULT_COLUMNS: ColumnId[] = ['weight', 'value', 'unrealized', 'realized', 'totalReturn', 'retDelta', 'roiDelta'];

const COLUMNS_STORAGE_KEY = 'pnl.assets.columns';
const SPLIT_STORAGE_KEY = 'pnl.assets.split';

/** Best half sorted as-is, worst half from the other end (midpoint split, like the original split view). */
export function splitHalves<T>(sorted: T[]): { top: T[]; bottom: T[] } {
    const mid = Math.ceil(sorted.length / 2);
    return { top: sorted.slice(0, mid), bottom: sorted.slice(mid).reverse() };
}

const SORT_BAR: { key: ColumnId; label: string; periodOnly?: boolean }[] = [
    { key: 'totalReturn', label: 'Return' },
    { key: 'retDelta', label: 'Return Δ', periodOnly: true },
    { key: 'value', label: 'Value' },
    { key: 'cost', label: 'Cost' },
    { key: 'unrealized', label: 'Unrealized' },
    { key: 'realized', label: 'Realized' },
    { key: 'efficiency', label: 'Efficiency' },
];

/** One displayed line: a whole asset, or an asset's slice in one account (partial: no realized/fees split). */
export interface HoldingRow {
    key: string;
    src: AssetPnLRow;
    accountId?: number;
    accountName?: string;
    partial: boolean;
    qty: number;
    cost: number;
    value: number;
    unrealized: number;
    delta?: AssetPeriodDelta;
}

function toRow(a: AssetPnLRow, delta?: AssetPeriodDelta): HoldingRow {
    return {
        key: String(a.asset.id ?? `nopnl-${a.asset.symbol}`),
        src: a,
        partial: false,
        qty: a.quantity,
        cost: a.cost_basis,
        value: a.market_value,
        unrealized: a.unrealized_pnl,
        delta,
    };
}

function toAccountRow(a: AssetPnLRow, b: AccountBalanceBreakdown): HoldingRow {
    const value = a.unit_value != null ? b.qty * a.unit_value : 0;
    return {
        key: `${a.asset.id}-${b.account_id}`,
        src: a,
        accountId: b.account_id,
        accountName: b.account_name,
        partial: true,
        qty: b.qty,
        cost: b.cost_basis_in_base,
        value,
        unrealized: a.unit_value != null ? value - b.cost_basis_in_base : 0,
    };
}

/** Numeric value of a column for a row; null when not applicable (e.g. realized on an account slice). */
export function columnValue(id: ColumnId, r: HoldingRow, totalValue: number): number | null {
    const a = r.src;
    if (!a.has_lots && id !== 'qty') return null;
    switch (id) {
        case 'weight': return totalValue > 0 ? (r.value / totalValue) * 100 : null;
        case 'qty': return r.qty;
        case 'unitCost': return r.partial ? (r.qty ? r.cost / r.qty : null) : a.unit_cost ?? null;
        case 'price': return a.unit_value ?? null;
        case 'value': return a.unit_value == null ? null : r.value;
        case 'cost': return r.cost;
        case 'bought': return r.partial ? null : a.total_invested ?? null;
        case 'unrealized': return a.unit_value == null ? null : r.unrealized;
        case 'realized': return r.partial ? null : a.realized_pnl;
        case 'totalReturn': return r.partial ? null : a.unrealized_pnl + a.realized_pnl;
        case 'fees': return r.partial ? null : a.total_fees;
        case 'income': return r.partial ? null : r.delta?.income_in_period ?? null;
        case 'retDelta': return r.delta?.total_return ?? null;
        case 'roiDelta': return r.delta?.roi_pct ?? null;
        case 'unrealDelta': return r.delta?.unrealized_change ?? null;
        case 'realDelta': return r.delta?.realized_in_period ?? null;
        case 'taxRealized': return r.partial ? null : a.taxable_realized_pnl;
        case 'taxIfSold': return r.partial || a.tax_cost_basis == null ? null : a.market_value - a.tax_cost_basis;
        case 'deferred': return r.partial || a.tax_cost_basis == null ? null : a.cost_basis - a.tax_cost_basis;
        case 'lots': return r.partial ? null : a.lot_count;
        case 'efficiency': return r.partial || a.cost_basis <= 1 ? null : ((a.unrealized_pnl + a.realized_pnl) / a.cost_basis) * 100;
        default: return null;
    }
}

export function sumColumn(id: ColumnId, rows: HoldingRow[], totalValue: number): number | null {
    let sum = 0;
    let any = false;
    for (const r of rows) {
        const v = columnValue(id, r, totalValue);
        if (v == null) continue;
        sum += v;
        any = true;
    }
    return any ? sum : null;
}

const SIGNED: ReadonlySet<ColumnId> = new Set(['unrealized', 'realized', 'totalReturn', 'income', 'retDelta', 'unrealDelta', 'realDelta', 'taxRealized', 'taxIfSold', 'deferred']);

function fmtCol(id: ColumnId, v: number, baseCurrency: string): string {
    if (id === 'weight') return `${v.toFixed(1)}%`;
    if (id === 'roiDelta' || id === 'efficiency') return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
    if (id === 'qty' || id === 'lots') return v.toLocaleString(undefined, { maximumFractionDigits: 6 });
    if (SIGNED.has(id)) return fmtCurrencySigned(v, baseCurrency);
    return fmtCurrency(v, baseCurrency);
}

function signClass(id: ColumnId, v: number): string {
    if (!SIGNED.has(id) && id !== 'roiDelta' && id !== 'efficiency') return 'text-gray-700';
    if (id === 'income') return 'text-teal-700';
    return v >= 0 ? 'text-green-600' : 'text-red-600';
}

// ─── URL helpers ────────────────────────────────────────────────────────────

function readUrlParam(name: string): string | null {
    return new URLSearchParams(window.location.search).get(name);
}

function writeUrlParam(name: string, value: string | null) {
    const params = new URLSearchParams(window.location.search);
    if (value == null) params.delete(name);
    else params.set(name, value);
    const qs = params.toString();
    window.history.replaceState(window.history.state, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
}

function loadColumns(): ColumnId[] {
    try {
        const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
        if (raw) {
            const ids = (JSON.parse(raw) as string[]).filter((id): id is ColumnId => COLUMNS.some(c => c.id === id));
            if (ids.length) return ids;
        }
    } catch {
        // ignore malformed prefs
    }
    return DEFAULT_COLUMNS;
}

// ─── Small UI bits ──────────────────────────────────────────────────────────

const Seg: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode; title?: string }> = ({ active, onClick, children, title }) => (
    <button
        type="button"
        title={title}
        onClick={onClick}
        className={`h-7 border px-2.5 text-xs font-medium transition-colors ${active ? 'border-blue-500 bg-blue-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
    >
        {children}
    </button>
);

function useOutsideClose(open: boolean, onClose: () => void) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open, onClose]);
    return ref;
}

const PAGE_SIZES = [25, 50, 100, 0] as const; // 0 = all

// ─── Props ──────────────────────────────────────────────────────────────────

export interface AssetsSectionProps {
    assets: AssetPnLRow[];
    baseCurrency: string;
    loading?: boolean;
    onAssetClick: (assetId: number) => void;
    onAccountClick?: (assetId: number, accountId: number) => void;
    accountBalances?: Map<number, AccountBalanceBreakdown[]>;
    accounts?: Account[];
    dimensions?: DimensionWithCategories[];
    availableAccountIds?: Set<number>;
    availableCategoryIds?: Set<number>;
    onLoadAccountBalances?: () => void;
    liveBalances?: Map<string, number>;
    liveAccountBalances?: Map<string, Map<number, number>>;
    liveBalanceLoading?: boolean;
    liveAccountErrors?: Map<number, string[]>;
    search: string;
    onSearchChange: (v: string) => void;
    minMarketValue: number;
    onMinMarketValueChange: (v: number) => void;
    pnlStatus: PnlStatusFilter;
    onPnlStatusChange: (v: PnlStatusFilter) => void;
    balanceStatus: BalanceStatusFilter;
    onBalanceStatusChange: (v: BalanceStatusFilter) => void;
    selectedAccountIds: number[];
    onSelectedAccountIdsChange: (v: number[]) => void;
    selectedCategoryIds: number[];
    onSelectedCategoryIdsChange: (v: number[]) => void;
    /** Per-asset period deltas (also carries income for the Income column) */
    periodDeltaMap?: Map<number, AssetPeriodDelta>;
    /** Period label when a period other than "All" is selected */
    periodLabel?: string;
    /** Account performers for account group headers (period-aware realized/fees/return) */
    accountPerformers?: PerformerItem[];
    pnlVersionId?: number;
    renderAllocation?: (mode: 'treemap' | 'pie') => React.ReactNode;
}

interface Group {
    key: string;
    label: string;
    color?: string;
    rows: HoldingRow[];
    performer?: PerformerItem;
}

// ─── Component ──────────────────────────────────────────────────────────────

export const AssetsSection: React.FC<AssetsSectionProps> = (props) => {
    const {
        assets, baseCurrency, loading, onAssetClick, onAccountClick, accountBalances, accounts = [], dimensions = [],
        availableAccountIds, availableCategoryIds, onLoadAccountBalances, liveBalances, liveAccountBalances,
        liveBalanceLoading = false, liveAccountErrors, search, onSearchChange, minMarketValue, onMinMarketValueChange,
        pnlStatus, onPnlStatusChange, balanceStatus, onBalanceStatusChange, selectedAccountIds, onSelectedAccountIdsChange,
        selectedCategoryIds, onSelectedCategoryIdsChange, periodDeltaMap, periodLabel, accountPerformers, pnlVersionId,
        renderAllocation,
    } = props;
    const assetPanelCtx = useContext(AssetDetailPanelContext);
    const isPeriod = !!periodLabel;

    // ── View / group / sort / columns (URL + localStorage) ──
    const [view, setView] = useState<AssetsViewMode>(() => {
        const v = readUrlParam('aview');
        if (v === 'table' || v === 'cards' || v === 'allocation') return v;
        return 'cards';
    });
    const [groupKey, setGroupKey] = useState<string>(() => readUrlParam('agroup') ?? 'none');
    const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(() => {
        const raw = readUrlParam('asort');
        if (!raw) return null;
        const [key, dir] = raw.split(':');
        return { key: key as SortKey, dir: dir === 'asc' ? 'asc' : 'desc' };
    });
    const [columns, setColumns] = useState<ColumnId[]>(loadColumns);
    const [allocationMode, setAllocationMode] = useState<'treemap' | 'pie'>('treemap');
    const [positionFilter, setPositionFilter] = useState<PositionFilter>('all');
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [columnsOpen, setColumnsOpen] = useState(false);
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
    const [expandedAssets, setExpandedAssets] = useState<Set<number>>(new Set());
    const [page, setPage] = useState(0);
    const [pageSize, setPageSize] = useState<number>(25);
    const [split, setSplit] = useState<boolean>(() => localStorage.getItem(SPLIT_STORAGE_KEY) !== '0');
    const [splitPages, setSplitPages] = useState<[number, number]>([0, 0]);
    const [expandedAccountIds, setExpandedAccountIds] = useState<Set<number>>(new Set());

    useEffect(() => { writeUrlParam('aview', view === 'cards' ? null : view); }, [view]);
    useEffect(() => { localStorage.setItem(SPLIT_STORAGE_KEY, split ? '1' : '0'); }, [split]);
    useEffect(() => { writeUrlParam('agroup', groupKey === 'none' ? null : groupKey); }, [groupKey]);
    useEffect(() => { writeUrlParam('asort', sort ? `${sort.key}:${sort.dir}` : null); }, [sort]);
    useEffect(() => {
        try { localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(columns)); } catch { /* storage unavailable */ }
    }, [columns]);

    const filtersRef = useOutsideClose(filtersOpen, () => setFiltersOpen(false));
    const columnsRef = useOutsideClose(columnsOpen, () => setColumnsOpen(false));

    // Default sort follows the period; an explicit period-only sort falls back when the period is "All"
    const effectiveSort = useMemo((): { key: SortKey; dir: 'asc' | 'desc' } => {
        const fallback = { key: (isPeriod ? 'retDelta' : 'totalReturn') as SortKey, dir: 'desc' as const };
        if (!sort) return fallback;
        const col = COLUMNS.find(c => c.id === sort.key);
        if (col?.periodOnly && !isPeriod) return fallback;
        return sort;
    }, [sort, isPeriod]);

    const visibleColumns = useMemo(
        () => COLUMNS.filter(c => columns.includes(c.id) && (!c.periodOnly || isPeriod)),
        [columns, isPeriod],
    );

    const groupDimension = groupKey.startsWith('dim:') ? dimensions.find(d => `dim:${d.id}` === groupKey) : undefined;
    const effectiveGroupKey = groupKey === 'account' || groupDimension ? groupKey : 'none';

    useEffect(() => {
        if (effectiveGroupKey === 'account' && onLoadAccountBalances && (!accountBalances || accountBalances.size === 0)) {
            onLoadAccountBalances();
        }
    }, [effectiveGroupKey]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Filtering ──
    const { filtered, dustHidden } = useMemo(() => {
        let dust = 0;
        const q = search.trim().toLowerCase();
        const out = assets.filter(a => {
            if (q && ![a.asset.symbol, a.asset.label].some(v => v?.toLowerCase().includes(q))) return false;
            if (selectedAccountIds.length && !a.account_ids?.some(id => selectedAccountIds.includes(id))) return false;
            if (selectedCategoryIds.length && !a.category_ids?.some(id => selectedCategoryIds.includes(id))) return false;
            if (pnlStatus === 'with_pnl' && !a.has_lots) return false;
            if (pnlStatus === 'no_pnl' && a.has_lots) return false;
            const open = a.has_open_position ?? Math.abs(a.quantity) > 1e-12;
            if (positionFilter === 'open' && !open) return false;
            if (positionFilter === 'closed' && open) return false;
            const liveQty = liveBalances?.get(a.asset.symbol?.toUpperCase() ?? '');
            if (balanceStatus === 'mapped' && (liveQty == null || liveQty === 0)) return false;
            if (balanceStatus === 'unmapped' && liveQty != null && liveQty > 0) return false;
            if (minMarketValue > 0 && a.has_lots && a.unit_value != null) {
                const pnlValue = Math.abs(a.market_value);
                const liveValue = liveQty != null ? Math.abs(liveQty * a.unit_value) : pnlValue;
                // Closed positions with activity stay visible: dust only hides small open holdings
                if (open && pnlValue < minMarketValue && liveValue < minMarketValue) {
                    dust++;
                    return false;
                }
            }
            return true;
        });
        return { filtered: out, dustHidden: dust };
    }, [assets, search, selectedAccountIds, selectedCategoryIds, pnlStatus, positionFilter, balanceStatus, minMarketValue, liveBalances]);

    const baseRows = useMemo(
        () => filtered.map(a => toRow(a, a.asset.id != null ? periodDeltaMap?.get(a.asset.id) : undefined)),
        [filtered, periodDeltaMap],
    );
    const totalValue = useMemo(() => baseRows.reduce((acc, r) => acc + (r.src.has_lots && r.src.unit_value != null ? r.value : 0), 0), [baseRows]);

    const sortRows = (rows: HoldingRow[]): HoldingRow[] => {
        const { key, dir } = effectiveSort;
        const sign = dir === 'asc' ? 1 : -1;
        return [...rows].sort((x, y) => {
            if (key === 'asset') {
                const nx = (x.src.asset.label || x.src.asset.symbol || '').toLowerCase();
                const ny = (y.src.asset.label || y.src.asset.symbol || '').toLowerCase();
                return nx.localeCompare(ny) * sign;
            }
            const vx = columnValue(key, x, totalValue);
            const vy = columnValue(key, y, totalValue);
            if (vx == null && vy == null) return 0;
            if (vx == null) return 1;
            if (vy == null) return -1;
            return (vx - vy) * sign;
        });
    };

    // ── Grouping ──
    const groups = useMemo((): Group[] | null => {
        if (effectiveGroupKey === 'none') return null;
        const map = new Map<string, Group>();
        const add = (key: string, label: string, row: HoldingRow, color?: string, performer?: PerformerItem) => {
            const g = map.get(key) ?? { key, label, color, rows: [], performer };
            g.rows.push(row);
            map.set(key, g);
        };
        if (effectiveGroupKey === 'account') {
            const perfById = new Map((accountPerformers ?? []).map(p => [p.id, p]));
            for (const r of baseRows) {
                const id = r.src.asset.id;
                const breakdown = id != null ? accountBalances?.get(id) : undefined;
                if (breakdown && breakdown.length > 0) {
                    for (const b of breakdown) {
                        add(`acc-${b.account_id}`, b.account_name, toAccountRow(r.src, b), getAccountColor(b.account_id), perfById.get(b.account_id));
                    }
                } else {
                    add('acc-none', 'Unassigned', r);
                }
            }
        } else if (groupDimension) {
            const cats = [...groupDimension.categories].sort((a, b) => a.label.localeCompare(b.label));
            for (const r of baseRows) {
                // An asset with several categories in this dimension is listed under the first one (alphabetical)
                const cat = cats.find(c => r.src.category_ids?.includes(c.id));
                if (cat) add(`cat-${cat.id}`, cat.label, r, cat.color || undefined);
                else add('cat-none', 'Uncategorized', r);
            }
        }
        const list = Array.from(map.values());
        list.forEach(g => { g.rows = sortRows(g.rows); });
        return list.sort((a, b) => b.rows.reduce((s, r) => s + r.value, 0) - a.rows.reduce((s, r) => s + r.value, 0));
    }, [effectiveGroupKey, groupDimension, baseRows, accountBalances, accountPerformers, effectiveSort, totalValue]); // eslint-disable-line react-hooks/exhaustive-deps

    const sortedFlat = useMemo(() => sortRows(baseRows), [baseRows, effectiveSort, totalValue]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => { setPage(0); setSplitPages([0, 0]); }, [search, minMarketValue, pnlStatus, balanceStatus, positionFilter, selectedAccountIds, selectedCategoryIds, effectiveSort, effectiveGroupKey, view, split]);

    const pageCount = pageSize === 0 ? 1 : Math.max(1, Math.ceil(sortedFlat.length / pageSize));
    const safePage = Math.min(page, pageCount - 1);
    const pagedFlat = pageSize === 0 ? sortedFlat : sortedFlat.slice(safePage * pageSize, (safePage + 1) * pageSize);

    const splitActive = split && effectiveGroupKey === 'none' && view !== 'allocation' && sortedFlat.length > 1;
    const halves = useMemo(() => splitHalves(sortedFlat), [sortedFlat]);
    const pageOf = (rows: HoldingRow[], idx: 0 | 1) => {
        if (pageSize === 0) return { rows, page: 0, count: 1 };
        const count = Math.max(1, Math.ceil(rows.length / pageSize));
        const pg = Math.min(splitPages[idx], count - 1);
        return { rows: rows.slice(pg * pageSize, (pg + 1) * pageSize), page: pg, count };
    };

    // ── Totals bar (filtered assets) ──
    const totals = useMemo(() => {
        let cost = 0, unrealized = 0, realized = 0, taxable = 0, deferred = 0, fees = 0, value = 0;
        for (const a of filtered) {
            if (!a.has_lots) continue;
            cost += a.cost_basis;
            unrealized += a.unrealized_pnl;
            realized += a.realized_pnl;
            taxable += a.taxable_realized_pnl ?? 0;
            deferred += a.tax_cost_basis != null ? a.cost_basis - a.tax_cost_basis : 0;
            fees += a.total_fees;
            value += a.market_value;
        }
        return { cost, unrealized, realized, taxable, deferred, fees, value };
    }, [filtered]);

    // ── Account aggregate cards (cards view grouped by account) ──
    const accountCards = useMemo(
        () => (view === 'cards' && effectiveGroupKey === 'account' ? aggregateByAccount(filtered, accountBalances) : []),
        [view, effectiveGroupKey, filtered, accountBalances],
    );
    const accountLiveValues = useMemo(() => liveValueByAccount(liveAccountBalances, assets), [liveAccountBalances, assets]);

    // ── Filter chips ──
    const availableAccounts = useMemo(
        () => accounts.filter(acc => !availableAccountIds || availableAccountIds.size === 0 || availableAccountIds.has(acc.id)),
        [accounts, availableAccountIds],
    );
    const relevantDimensions = useMemo(
        () => dimensions
            .map(d => ({ ...d, categories: d.categories.filter(c => !availableCategoryIds || availableCategoryIds.size === 0 || availableCategoryIds.has(c.id)) }))
            .filter(d => d.categories.length > 0),
        [dimensions, availableCategoryIds],
    );

    const chips: { id: string; label: string; onRemove: () => void }[] = [];
    if (minMarketValue > 0) chips.push({ id: 'min', label: `Value ≥ ${fmtCurrency(minMarketValue, baseCurrency)}`, onRemove: () => onMinMarketValueChange(0) });
    if (pnlStatus !== 'all') chips.push({ id: 'pnl', label: pnlStatus === 'with_pnl' ? 'With P&L' : 'No P&L', onRemove: () => onPnlStatusChange('all') });
    if (positionFilter !== 'all') chips.push({ id: 'pos', label: positionFilter === 'open' ? 'Open' : 'Closed', onRemove: () => setPositionFilter('all') });
    if (balanceStatus !== 'all') chips.push({ id: 'bal', label: balanceStatus === 'mapped' ? 'Has live balance' : 'No live balance', onRemove: () => onBalanceStatusChange('all') });
    for (const id of selectedAccountIds) {
        chips.push({ id: `a${id}`, label: accounts.find(a => a.id === id)?.name ?? `Account ${id}`, onRemove: () => onSelectedAccountIdsChange(selectedAccountIds.filter(x => x !== id)) });
    }
    for (const id of selectedCategoryIds) {
        chips.push({ id: `c${id}`, label: dimensions.flatMap(d => d.categories).find(c => c.id === id)?.label ?? `Category ${id}`, onRemove: () => onSelectedCategoryIdsChange(selectedCategoryIds.filter(x => x !== id)) });
    }
    const clearAll = () => {
        onSearchChange('');
        onMinMarketValueChange(0);
        onPnlStatusChange('all');
        onBalanceStatusChange('all');
        setPositionFilter('all');
        onSelectedAccountIdsChange([]);
        onSelectedCategoryIdsChange([]);
    };

    const toggleSort = (key: SortKey) => {
        setSort(prev => {
            const cur = prev ?? effectiveSort;
            if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
            return { key, dir: key === 'asset' ? 'asc' : 'desc' };
        });
    };

    const toggleExpanded = (assetId: number) => {
        setExpandedAssets(prev => {
            const next = new Set(prev);
            if (next.has(assetId)) next.delete(assetId);
            else {
                next.add(assetId);
                if (onLoadAccountBalances && !accountBalances?.has(assetId)) onLoadAccountBalances();
            }
            return next;
        });
    };

    // ── Cells ──
    const renderAssetCell = (r: HoldingRow, depth: 0 | 1) => {
        const a = r.src;
        const id = a.asset.id;
        const isNoPnl = !a.has_lots;
        const expandable = depth === 0 && !r.partial && !isNoPnl && (a.account_ids?.length ?? 0) >= 1 && effectiveGroupKey !== 'account';
        const expanded = id != null && expandedAssets.has(id);
        const sym = a.asset.symbol?.toUpperCase() ?? '';
        const delta = computeDelta(r.qty, liveBalances?.get(sym));
        const liveMismatch = delta != null && !delta.matched && !r.partial;
        const hasPriceIssue = !!a.price_error || (a.price_state != null && !['live', 'cached'].includes(a.price_state));
        const errorAccounts = liveAccountErrors ? (a.account_ids ?? []).filter(acc => liveAccountErrors.has(acc)) : [];
        const breakdown = id != null ? accountBalances?.get(id) : undefined;
        return (
            <div className={`flex min-w-0 items-center gap-1 ${depth ? 'pl-6' : ''}`}>
                {expandable ? (
                    <button type="button" onClick={(e) => { e.stopPropagation(); if (id != null) toggleExpanded(id); }} className="p-0.5 text-gray-500 hover:bg-slate-200" aria-label={expanded ? 'Collapse accounts' : 'Expand accounts'}>
                        {expanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                    </button>
                ) : <span className="inline-block w-[18px] shrink-0" />}
                <Tooltip content={a.asset.label ? `${a.asset.label} (${a.asset.symbol})` : a.asset.symbol || ''} openDelay={300}>
                    <span className="truncate text-xs font-semibold text-gray-800">{a.asset.label || a.asset.symbol}</span>
                </Tooltip>
                {a.asset.label && <span className="shrink-0 text-[10px] text-gray-400">{a.asset.symbol}</span>}
                {id != null && assetPanelCtx && depth === 0 && (
                    <button type="button" onClick={(e) => { e.stopPropagation(); assetPanelCtx.openAssetPanel(id, { pnlVersionId }); }} className="shrink-0 p-0.5 text-gray-300 hover:text-blue-500" title="Asset details">
                        <LuInfo size={11} />
                    </button>
                )}
                {depth === 0 && breakdown && breakdown.length > 1 && (
                    <span className="flex shrink-0 gap-0.5">
                        {breakdown.slice(0, 3).map(b => (
                            <span key={b.account_id} className="inline-block h-[6px] w-[6px] rounded-full" style={{ backgroundColor: getAccountColor(b.account_id) }} title={b.account_name} />
                        ))}
                        {breakdown.length > 3 && <span className="text-[9px] text-gray-400">+{breakdown.length - 3}</span>}
                    </span>
                )}
                {isNoPnl && <Badge colorScheme={a.is_unmapped ? 'orange' : 'yellow'}>{a.is_unmapped ? 'Unmapped' : 'No P&L'}</Badge>}
                {!r.partial && a.warning_count > 0 && <Badge colorScheme="orange">{a.warning_count} ⚠</Badge>}
                {hasPriceIssue && (
                    <span title={a.price_error ? `Price error: ${a.price_error}` : 'Price is not live (fallback / stale)'} className="shrink-0">
                        <FiAlertCircle size={11} color={a.price_error ? '#E53E3E' : '#DD6B20'} />
                    </span>
                )}
                {(liveMismatch || errorAccounts.length > 0) && (
                    <span className="shrink-0 text-[10px] text-orange-500" title={errorAccounts.length ? 'Live balance fetch errors on some accounts' : 'Live balance differs from P&L quantity'}>≠live</span>
                )}
            </div>
        );
    };

    const renderCell = (col: ColumnId, r: HoldingRow) => {
        const a = r.src;
        if (col === 'value' && !r.partial) return renderValue(a, baseCurrency);
        if (col === 'cost' && !r.partial && a.has_lots) return renderCost(a.cost_basis, a.unit_cost, baseCurrency, a.total_invested);
        if (col === 'live') {
            if (liveBalanceLoading) return <Spinner size="xs" className="text-gray-400" />;
            const sym = a.asset.symbol?.toUpperCase() ?? '';
            const live = r.accountId != null ? liveAccountBalances?.get(sym)?.get(r.accountId) : liveBalances?.get(sym);
            return <DeltaBar delta={computeDelta(r.qty, live)} liveQty={live} pnlQty={r.qty} size="xs" />;
        }
        const v = columnValue(col, r, totalValue);
        if (v == null) return <span className="text-gray-300">—</span>;
        if (col === 'weight') {
            return (
                <div className="flex items-center justify-end gap-1.5">
                    <div className="h-1.5 w-12 bg-slate-100"><div className="h-full bg-blue-400" style={{ width: `${Math.min(v, 100)}%` }} /></div>
                    <span className="tabular-nums text-gray-600">{v.toFixed(1)}%</span>
                </div>
            );
        }
        if (col === 'unrealized' && !r.partial && a.cost_basis > 0) {
            return (
                <div className="flex flex-col items-end leading-tight">
                    <span className={`font-semibold ${signClass(col, v)}`}>{fmtCol(col, v, baseCurrency)}</span>
                    <span className="text-[10px] text-gray-400">{`${a.unrealized_pnl_pct >= 0 ? '+' : ''}${(a.unrealized_pnl_pct * 100).toFixed(1)}%`}</span>
                </div>
            );
        }
        if (col === 'totalReturn' && a.cost_basis > 0) {
            const pct = (v / a.cost_basis) * 100;
            return (
                <div className="flex flex-col items-end leading-tight">
                    <span className={`font-semibold ${signClass(col, v)}`}>{fmtCol(col, v, baseCurrency)}</span>
                    <span className="text-[10px] text-gray-400">{`${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`}</span>
                </div>
            );
        }
        return <span className={`${SIGNED.has(col) ? 'font-semibold' : ''} ${signClass(col, v)}`}>{fmtCol(col, v, baseCurrency)}</span>;
    };

    const renderTotalCell = (col: ColumnDef, rows: HoldingRow[], performer?: PerformerItem) => {
        if (performer) {
            const fromPerformer: Partial<Record<ColumnId, number>> = {
                realized: isPeriod ? undefined : performer.realized_pnl,
                totalReturn: isPeriod ? undefined : performer.total_return,
                fees: performer.total_fees,
                income: performer.income,
                retDelta: isPeriod ? performer.total_return : undefined,
                realDelta: isPeriod ? performer.realized_pnl : undefined,
            };
            const pv = fromPerformer[col.id];
            if (pv != null) return <span className={`font-semibold ${signClass(col.id, pv)}`}>{fmtCol(col.id, pv, baseCurrency)}</span>;
        }
        if (col.id === 'weight') {
            const v = rows.reduce((acc, r) => acc + (r.src.has_lots && r.src.unit_value != null ? r.value : 0), 0);
            return totalValue > 0 ? <span className="tabular-nums text-gray-600">{((v / totalValue) * 100).toFixed(1)}%</span> : null;
        }
        if (!col.summable) return null;
        const v = sumColumn(col.id, rows, totalValue);
        if (v == null) return <span className="text-gray-300">—</span>;
        return <span className={`font-semibold ${signClass(col.id, v)}`}>{fmtCol(col.id, v, baseCurrency)}</span>;
    };

    const rowsForTotals = baseRows;

    const renderTableRow = (r: HoldingRow, depth: 0 | 1) => {
        const a = r.src;
        const id = a.asset.id;
        const clickable = a.has_lots && id != null;
        return (
            <tr
                key={`${depth}-${r.key}`}
                className={`group border-b border-slate-100 ${clickable ? 'cursor-pointer hover:bg-blue-50' : ''} ${a.is_unmapped ? 'opacity-60' : ''} ${depth ? 'bg-slate-50/60' : 'bg-white'}`}
                onClick={clickable ? () => onAssetClick(id!) : undefined}
            >
                <td className={`sticky left-0 z-[1] max-w-[260px] px-2 py-1.5 ${depth ? 'bg-slate-50' : 'bg-white'} group-hover:bg-blue-50`}>
                    {renderAssetCell(r, depth)}
                </td>
                {visibleColumns.map(col => (
                    <td key={col.id} className="whitespace-nowrap px-2 py-1.5 text-right text-xs tabular-nums">{renderCell(col.id, r)}</td>
                ))}
            </tr>
        );
    };

    const renderExpansion = (r: HoldingRow) => {
        const id = r.src.asset.id;
        if (id == null || !expandedAssets.has(id)) return null;
        const breakdown = accountBalances?.get(id);
        if (!breakdown) {
            return (
                <tr key={`exp-${r.key}`}><td colSpan={visibleColumns.length + 1} className="bg-slate-50 px-8 py-1.5 text-[11px] text-gray-400">Loading accounts…</td></tr>
            );
        }
        return breakdown.map(b => {
            const sub = toAccountRow(r.src, b);
            return (
                <tr key={`exp-${sub.key}`} className="border-b border-slate-100 bg-slate-50">
                    <td className="sticky left-0 z-[1] bg-slate-50 px-2 py-1" style={{ borderLeft: `2px solid ${getAccountColor(b.account_id)}` }}>
                        <span
                            className={`pl-7 text-[11px] text-gray-700 ${onAccountClick ? 'cursor-pointer hover:text-blue-600 hover:underline' : ''}`}
                            onClick={onAccountClick ? (e) => { e.stopPropagation(); onAccountClick(id, b.account_id); } : undefined}
                        >
                            {b.account_name}
                        </span>
                        <span className="ml-1 text-[10px] text-gray-400">{b.lot_count} lots</span>
                    </td>
                    {visibleColumns.map(col => (
                        <td key={col.id} className="whitespace-nowrap px-2 py-1 text-right text-[11px] tabular-nums">{renderCell(col.id, sub)}</td>
                    ))}
                </tr>
            );
        });
    };

    const renderGroupHeader = (g: Group, colSpanFirst = true) => {
        const collapsed = collapsedGroups.has(g.key);
        const assetCount = new Set(g.rows.map(r => r.src.asset.id)).size;
        const accId = g.key.startsWith('acc-') && g.key !== 'acc-none' ? Number(g.key.slice(4)) : null;
        let liveValue: number | null = null;
        if (accId != null && liveAccountBalances) {
            liveValue = 0;
            for (const r of g.rows) {
                const q = liveAccountBalances.get(r.src.asset.symbol?.toUpperCase() ?? '')?.get(accId);
                if (q != null && r.src.unit_value != null) liveValue += q * r.src.unit_value;
            }
        }
        return (
            <tr
                key={`g-${g.key}`}
                className="cursor-pointer border-b border-slate-200 bg-slate-100 hover:bg-slate-200"
                onClick={() => setCollapsedGroups(prev => { const n = new Set(prev); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })}
            >
                <td className="sticky left-0 z-[1] bg-slate-100 px-2 py-1.5" style={g.color ? { borderLeft: `3px solid ${g.color}` } : undefined}>
                    <div className="flex items-center gap-1.5">
                        {collapsed ? <FiChevronRight size={12} /> : <FiChevronDown size={12} />}
                        <span className="text-xs font-semibold text-gray-800">{g.label}</span>
                        <Badge colorScheme="gray">{assetCount}</Badge>
                        {liveValue != null && liveValue > 0 && <span className="text-[10px] text-gray-500">live {fmtCurrency(liveValue, baseCurrency)}</span>}
                    </div>
                </td>
                {colSpanFirst && visibleColumns.map(col => (
                    <td key={col.id} className="whitespace-nowrap px-2 py-1.5 text-right text-xs tabular-nums">{renderTotalCell(col, g.rows, g.performer)}</td>
                ))}
            </tr>
        );
    };

    // ── Toolbar ──
    const toolbar = (
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2">
            <div className="relative w-full max-w-[220px]">
                <Input placeholder="Search asset…" value={search} onChange={(e) => onSearchChange(e.target.value)} className="h-7 pl-7 text-xs" aria-label="Search assets" />
                <FiSearch size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
            </div>

            <div className="relative" ref={filtersRef}>
                <button
                    type="button"
                    onClick={() => setFiltersOpen(v => !v)}
                    className={`flex h-7 items-center gap-1.5 border px-2.5 text-xs font-medium ${chips.length ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}
                >
                    <FiFilter size={12} /> Filters{chips.length ? ` (${chips.length})` : ''}
                </button>
                {filtersOpen && (
                    <div className="absolute left-0 top-8 z-30 w-[min(640px,90vw)] border border-slate-200 bg-white p-3 shadow-lg">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div>
                                <div className="mb-1 text-[10px] font-medium text-gray-500">Min value (open positions)</div>
                                <div className="flex items-center gap-2">
                                    <input type="range" min={0} max={100} step={1} value={minMarketValue} onChange={(e) => onMinMarketValueChange(Number(e.target.value))} className="h-1 w-full accent-blue-500" aria-label="Minimum value" />
                                    <span className="min-w-[40px] text-right text-xs text-gray-600">{fmtCurrency(minMarketValue, baseCurrency)}</span>
                                </div>
                            </div>
                            <div>
                                <div className="mb-1 text-[10px] font-medium text-gray-500">Position</div>
                                <div className="flex">
                                    {(['all', 'open', 'closed'] as PositionFilter[]).map(v => (
                                        <Seg key={v} active={positionFilter === v} onClick={() => setPositionFilter(v)}>{v === 'all' ? 'All' : v === 'open' ? 'Open' : 'Closed'}</Seg>
                                    ))}
                                </div>
                            </div>
                            <div>
                                <div className="mb-1 text-[10px] font-medium text-gray-500">P&L status</div>
                                <div className="flex">
                                    {([['all', 'All'], ['with_pnl', 'With P&L'], ['no_pnl', 'No P&L']] as [PnlStatusFilter, string][]).map(([v, l]) => (
                                        <Seg key={v} active={pnlStatus === v} onClick={() => onPnlStatusChange(v)}>{l}</Seg>
                                    ))}
                                </div>
                            </div>
                            <div>
                                <div className="mb-1 text-[10px] font-medium text-gray-500">Live balance</div>
                                <div className="flex">
                                    {([['all', 'All'], ['mapped', 'Has balance'], ['unmapped', 'No balance']] as [BalanceStatusFilter, string][]).map(([v, l]) => (
                                        <Seg key={v} active={balanceStatus === v} onClick={() => onBalanceStatusChange(v)}>{l}</Seg>
                                    ))}
                                </div>
                            </div>
                        </div>
                        {availableAccounts.length > 0 && (
                            <div className="mt-3">
                                <div className="mb-1 text-[10px] font-medium text-gray-500">Accounts</div>
                                <div className="flex max-h-[96px] flex-wrap gap-1 overflow-y-auto">
                                    {availableAccounts.map(acc => {
                                        const on = selectedAccountIds.includes(acc.id);
                                        const color = getAccountColor(acc.id);
                                        return (
                                            <button
                                                key={acc.id}
                                                type="button"
                                                onClick={() => onSelectedAccountIdsChange(on ? selectedAccountIds.filter(x => x !== acc.id) : [...selectedAccountIds, acc.id])}
                                                className="h-6 border px-2 text-[11px]"
                                                style={{ borderColor: color, backgroundColor: on ? color : '#ffffff', color: on ? '#ffffff' : '#374151' }}
                                            >
                                                {acc.name}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                        {relevantDimensions.map(dim => (
                            <div key={dim.id} className="mt-3">
                                <div className="mb-1 text-[10px] font-medium text-gray-500">{dim.label}</div>
                                <div className="flex max-h-[96px] flex-wrap gap-1 overflow-y-auto">
                                    {dim.categories.map(cat => {
                                        const on = selectedCategoryIds.includes(cat.id);
                                        return (
                                            <button
                                                key={cat.id}
                                                type="button"
                                                onClick={() => onSelectedCategoryIdsChange(on ? selectedCategoryIds.filter(x => x !== cat.id) : [...selectedCategoryIds, cat.id])}
                                                className={`h-6 border px-2 text-[11px] ${on ? 'border-blue-500 bg-blue-500 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}
                                            >
                                                {cat.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {chips.map(chip => (
                <span key={chip.id} className="inline-flex h-6 items-center gap-1 border border-blue-100 bg-blue-50 px-1.5 text-[11px] text-blue-700">
                    {chip.label}
                    <button type="button" onClick={chip.onRemove} className="text-blue-400 hover:text-blue-700" aria-label={`Remove ${chip.label}`}><FiX size={10} /></button>
                </span>
            ))}
            {(chips.length > 0 || search) && (
                <button type="button" onClick={clearAll} className="text-[11px] text-gray-500 hover:text-blue-600 hover:underline">Clear all</button>
            )}

            <div className="ml-auto flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-[11px] text-gray-500">
                    Group
                    <select value={effectiveGroupKey} onChange={(e) => setGroupKey(e.target.value)} className="h-7 border border-slate-200 bg-white px-1.5 text-xs text-slate-700">
                        <option value="none">None</option>
                        <option value="account">Account</option>
                        {dimensions.map(d => <option key={d.id} value={`dim:${d.id}`}>{d.label}</option>)}
                    </select>
                </label>
                <div className="flex">
                    <Seg active={view === 'table'} onClick={() => setView('table')}>Table</Seg>
                    <Seg active={view === 'cards'} onClick={() => setView('cards')}>Cards</Seg>
                    {renderAllocation && <Seg active={view === 'allocation'} onClick={() => setView('allocation')}>Allocation</Seg>}
                </div>
                {view === 'table' && (
                    <div className="relative" ref={columnsRef}>
                        <button type="button" onClick={() => setColumnsOpen(v => !v)} className="flex h-7 items-center gap-1.5 border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                            <FiSliders size={12} /> Columns
                        </button>
                        {columnsOpen && (
                            <div className="absolute right-0 top-8 z-30 w-[260px] border border-slate-200 bg-white p-3 shadow-lg">
                                {(['Position', 'P&L', 'Period', 'Tax', 'Other'] as const).map(groupName => (
                                    <div key={groupName} className="mb-2">
                                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                                            {groupName}{groupName === 'Period' && !isPeriod ? ' (select a period)' : ''}
                                        </div>
                                        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                                            {COLUMNS.filter(c => c.group === groupName).map(c => (
                                                <label key={c.id} className="flex cursor-pointer items-center gap-1.5 text-[11px] text-gray-700">
                                                    <input
                                                        type="checkbox"
                                                        checked={columns.includes(c.id)}
                                                        onChange={() => setColumns(prev => prev.includes(c.id) ? prev.filter(x => x !== c.id) : [...prev, c.id])}
                                                        className="accent-blue-500"
                                                    />
                                                    {c.label}
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                                <button type="button" onClick={() => setColumns(DEFAULT_COLUMNS)} className="text-[11px] text-blue-600 hover:underline">Reset to default</button>
                            </div>
                        )}
                    </div>
                )}
                {view !== 'allocation' && effectiveGroupKey === 'none' && (
                    <button
                        type="button"
                        onClick={() => setSplit(v => !v)}
                        title="Split: best half vs worst half by the current sort"
                        aria-pressed={split}
                        className={`flex h-7 items-center gap-1.5 border px-2.5 text-xs font-medium ${split ? 'border-blue-500 bg-blue-500 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}
                    >
                        <FiColumns size={12} /> Split
                    </button>
                )}
            </div>
        </div>
    );

    const sortBar = view === 'cards' && effectiveGroupKey !== 'account' && (
        <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 px-3 py-1.5">
            <span className="mr-1 text-[11px] text-gray-500">Sort</span>
            <div className="flex flex-wrap">
                {SORT_BAR.filter(o => !o.periodOnly || isPeriod).map(o => (
                    <Seg key={o.key} active={effectiveSort.key === o.key} onClick={() => toggleSort(o.key)}>
                        {o.label}{effectiveSort.key === o.key ? (effectiveSort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                    </Seg>
                ))}
                <Seg active={effectiveSort.key === 'asset'} onClick={() => toggleSort('asset')}>
                    Name{effectiveSort.key === 'asset' ? (effectiveSort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                </Seg>
            </div>
        </div>
    );

    const sortLabel = effectiveSort.key === 'asset' ? 'Name' : (COLUMNS.find(c => c.id === effectiveSort.key)?.label ?? '');
    const colorFn = (v: number) => (v >= 0 ? 'green.600' : 'red.600');
    const totalReturn = totals.unrealized + totals.realized;
    const totalsBar = view !== 'allocation' && filtered.length > 0 && totals.cost > 0 && (
        <div className="border-b border-slate-100 px-3 py-2" data-testid="assets-totals">
            <HeroMetricsBar
                totalReturn={totalReturn}
                roi={(totalReturn / totals.cost) * 100}
                baseCurrency={baseCurrency}
                costBasisInPeriod={totals.cost}
                unrealizedInPeriod={totals.unrealized}
                realizedInPeriod={totals.realized}
                feesInPeriod={totals.fees}
                fmtCurrencySigned={fmtCurrencySigned}
                color={colorFn}
            >
                <MetricItem label="Value" value={fmtCurrency(totals.value, baseCurrency)} color="gray.800" icon={<FiDollarSign size={14} />} bg="blue.50" />
                <MetricItem label="Cost" value={fmtCurrency(totals.cost, baseCurrency)} color="gray.700" icon={<LuReceipt size={14} />} bg="gray.100" info={TERM_HELP.cost} />
                <MetricItem label="Unrealized" value={fmtCurrencySigned(totals.unrealized, baseCurrency)} color={colorFn(totals.unrealized)} icon={totals.unrealized >= 0 ? <FiTrendingUp size={14} /> : <FiTrendingDown size={14} />} bg={totals.unrealized >= 0 ? 'green.50' : 'red.50'} />
                <MetricItem label="Realized" value={fmtCurrencySigned(totals.realized, baseCurrency)} color={colorFn(totals.realized)} icon={totals.realized >= 0 ? <FiTrendingUp size={14} /> : <FiTrendingDown size={14} />} bg={totals.realized >= 0 ? 'green.50' : 'red.50'} info={TERM_HELP.realized} subLines={realizedSubLines({ taxableRealizedPnl: totals.taxable, deferredGain: totals.deferred }, baseCurrency, fmtCurrencySigned)} />
                <MetricItem label="Fees" value={fmtCurrency(totals.fees, baseCurrency)} color="orange.700" icon={<LuReceipt size={14} />} bg="orange.50" />
            </HeroMetricsBar>
        </div>
    );

    const halfPager = (idx: 0 | 1, total: number, page: number, count: number) => pageSize !== 0 && count > 1 && (
        <div className="mt-2 flex items-center justify-end gap-2 text-[11px] text-gray-500">
            <span>{page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {total}</span>
            <Seg active={false} onClick={() => setSplitPages(p => (idx === 0 ? [Math.max(0, p[0] - 1), p[1]] : [p[0], Math.max(0, p[1] - 1)]))}>‹</Seg>
            <Seg active={false} onClick={() => setSplitPages(p => (idx === 0 ? [Math.min(count - 1, p[0] + 1), p[1]] : [p[0], Math.min(count - 1, p[1] + 1)]))}>›</Seg>
        </div>
    );

    const renderSplit = (renderHalf: (rows: HoldingRow[]) => React.ReactNode, vertical: boolean) => {
        const top = pageOf(halves.top, 0);
        const bottom = pageOf(halves.bottom, 1);
        const desc = effectiveSort.dir === 'desc';
        return (
            <div className={vertical ? 'flex flex-col gap-4' : 'flex flex-col gap-3 md:flex-row'} data-testid="assets-split">
                {([[top, halves.top.length, 0], [bottom, halves.bottom.length, 1]] as const).map(([half, total, idx]) => {
                    const best = idx === 0 ? desc : !desc;
                    return (
                        <div key={idx} className={`min-w-0 flex-1 ${!vertical && idx === 0 ? 'border-b border-slate-200 pb-3 md:border-b-0 md:border-r md:pb-0 md:pr-3' : ''}`}>
                            <div className="mb-2 flex items-center gap-2">
                                <span className={`text-sm font-semibold ${best ? 'text-green-700' : 'text-red-700'}`}>
                                    {idx === 0 ? '↓' : '↑'} {sortLabel} · {best ? 'top half' : 'bottom half'}
                                </span>
                                <Badge colorScheme="gray">{total}</Badge>
                            </div>
                            {renderHalf(half.rows as HoldingRow[])}
                            {halfPager(idx, total, half.page, half.count)}
                        </div>
                    );
                })}
            </div>
        );
    };

    // ── Cards ──
    const renderCard = (r: HoldingRow) => {
        const a = r.src;
        const id = a.asset.id;
        const sym = a.asset.symbol?.toUpperCase() ?? '';
        const liveQty = liveBalances?.get(sym);
        const errorAccounts = liveAccountErrors ? (a.account_ids ?? []).filter(acc => liveAccountErrors.has(acc)) : [];
        return (
            <AssetPnLCard
                key={r.key}
                row={a}
                baseCurrency={baseCurrency}
                onAssetClick={(assetId) => assetId != null && onAssetClick(assetId)}
                onAccountClick={onAccountClick}
                isExpanded={id != null && expandedAssets.has(id)}
                onToggleExpand={(assetId) => toggleExpanded(assetId)}
                accountBalances={id != null ? accountBalances?.get(id) : undefined}
                accounts={accounts}
                liveQty={liveQty}
                deltaInfo={computeDelta(a.quantity, liveQty)}
                liveBalanceLoading={liveBalanceLoading}
                liveAccountBalanceMap={liveAccountBalances?.get(sym)}
                liveAccountErrors={liveAccountErrors}
                assetErrorAccounts={errorAccounts}
                hasLiveErrors={errorAccounts.length > 0}
                unrealizedPnlRange={unrealizedRange}
                periodDelta={r.delta}
                periodLabel={periodLabel}
                pnlVersionId={pnlVersionId}
            />
        );
    };

    const unrealizedRange = useMemo(() => {
        const vals = filtered.filter(a => a.has_lots).map(a => a.unrealized_pnl);
        return vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : { min: 0, max: 0 };
    }, [filtered]);

    const cardGroups: Group[] = useMemo(() => {
        if (effectiveGroupKey === 'none') return [];
        // Cards show whole assets: dedupe account slices back to their asset
        return (groups ?? []).map(g => {
            const seen = new Set<string>();
            const rows: HoldingRow[] = [];
            for (const r of g.rows) {
                const key = String(r.src.asset.id);
                if (seen.has(key)) continue;
                seen.add(key);
                rows.push(r.partial ? toRow(r.src, r.src.asset.id != null ? periodDeltaMap?.get(r.src.asset.id) : undefined) : r);
            }
            return { ...g, rows };
        });
    }, [effectiveGroupKey, groups, periodDeltaMap]);

    const pagination = view !== 'allocation' && effectiveGroupKey === 'none' && !splitActive && sortedFlat.length > 25 && (
        <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-3 py-2 text-[11px] text-gray-500">
            <div className="flex items-center gap-1">
                Rows
                {PAGE_SIZES.map(size => (
                    <Seg key={size} active={pageSize === size} onClick={() => { setPageSize(size); setPage(0); }}>{size === 0 ? 'All' : size}</Seg>
                ))}
            </div>
            {pageSize !== 0 && (
                <div className="flex items-center gap-2">
                    <span>{safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, sortedFlat.length)} of {sortedFlat.length}</span>
                    <Seg active={false} onClick={() => setPage(p => Math.max(0, p - 1))}>‹</Seg>
                    <Seg active={false} onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}>›</Seg>
                </div>
            )}
        </div>
    );

    const renderTable = (flatRows: HoldingRow[] | null, withFooter: boolean, maxH = 'max-h-[70vh]') => (
                <div className={`${maxH} overflow-auto`}>
                    <table className="w-full border-collapse text-xs">
                        <thead className="sticky top-0 z-[2] bg-slate-50">
                            <tr className="border-b border-slate-200">
                                <th className="sticky left-0 z-[3] cursor-pointer bg-slate-50 px-2 py-2 text-left text-[11px] font-semibold text-gray-600" onClick={() => toggleSort('asset')}>
                                    Asset {effectiveSort.key === 'asset' && (effectiveSort.dir === 'asc' ? '↑' : '↓')}
                                </th>
                                {visibleColumns.map(col => (
                                    <th
                                        key={col.id}
                                        className={`whitespace-nowrap px-2 py-2 text-right text-[11px] font-semibold ${col.periodOnly ? 'text-blue-700' : 'text-gray-600'} ${col.sortable ? 'cursor-pointer hover:bg-slate-100' : ''}`}
                                        onClick={col.sortable ? () => toggleSort(col.id) : undefined}
                                    >
                                        <span className="inline-flex items-center gap-1">
                                            {col.label}{col.periodOnly && periodLabel ? ` ${periodLabel}` : ''}
                                            {col.info && <InfoTip text={col.info} size={9} />}
                                            {effectiveSort.key === col.id && (effectiveSort.dir === 'asc' ? '↑' : '↓')}
                                        </span>
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {flatRows
                                ? flatRows.map(r => (
                                    <Fragment key={r.key}>
                                        {renderTableRow(r, 0)}
                                        {renderExpansion(r)}
                                    </Fragment>
                                ))
                                : (groups ?? []).map(g => (
                                    <Fragment key={g.key}>
                                        {renderGroupHeader(g)}
                                        {!collapsedGroups.has(g.key) && g.rows.map(r => (
                                            <Fragment key={`${g.key}-${r.key}`}>
                                                {renderTableRow(r, 1)}
                                                {effectiveGroupKey !== 'account' && renderExpansion(r)}
                                            </Fragment>
                                        ))}
                                    </Fragment>
                                ))}
                        </tbody>
                        {withFooter && <tfoot className="sticky bottom-0 z-[2] bg-slate-100">
                            <tr className="border-t-2 border-slate-300">
                                <td className="sticky left-0 z-[3] bg-slate-100 px-2 py-2 text-xs font-bold text-gray-800">
                                    Total <span className="font-normal text-gray-500">({filtered.length})</span>
                                </td>
                                {visibleColumns.map(col => (
                                    <td key={col.id} className="whitespace-nowrap px-2 py-2 text-right text-xs tabular-nums">{renderTotalCell(col, rowsForTotals)}</td>
                                ))}
                            </tr>
                        </tfoot>}
                    </table>
                </div>
    );

    return (
        <div className="border border-slate-200 bg-white" data-testid="assets-section">
            {toolbar}
            {totalsBar}
            {sortBar}

            {view === 'allocation' && renderAllocation ? (
                <div className="p-3">
                    <div className="mb-2 flex">
                        <Seg active={allocationMode === 'treemap'} onClick={() => setAllocationMode('treemap')}>Treemap</Seg>
                        <Seg active={allocationMode === 'pie'} onClick={() => setAllocationMode('pie')}>Pie</Seg>
                    </div>
                    {renderAllocation(allocationMode)}
                </div>
            ) : loading ? (
                <div className="py-10 text-center text-xs text-gray-400">Loading assets…</div>
            ) : filtered.length === 0 ? (
                <div className="py-10 text-center text-xs text-gray-500">No assets match your criteria</div>
            ) : view === 'cards' ? (
                <div className="p-3">
                    {effectiveGroupKey === 'account' ? (
                        accountCards.length === 0 ? (
                            <div className="py-8 text-center text-xs text-gray-500">Loading account breakdown…</div>
                        ) : (
                            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5" data-testid="account-cards">
                                {accountCards.map(row => (
                                    <AccountPnLCard
                                        key={row.account_id}
                                        row={row}
                                        baseCurrency={baseCurrency}
                                        isExpanded={expandedAccountIds.has(row.account_id)}
                                        onToggleExpand={(id) => setExpandedAccountIds(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
                                        onAssetClick={(id) => id != null && onAssetClick(id)}
                                        details={expandedAccountIds.has(row.account_id) ? accountAssetDetails(row.account_id, filtered, accountBalances) : []}
                                        liveBalanceValue={accountLiveValues.get(row.account_id)}
                                        liveBalanceLoading={liveBalanceLoading}
                                    />
                                ))}
                            </div>
                        )
                    ) : splitActive ? (
                        renderSplit(rows => <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">{rows.map(renderCard)}</div>, false)
                    ) : effectiveGroupKey === 'none' ? (
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">{pagedFlat.map(renderCard)}</div>
                    ) : cardGroups.map(g => (
                        <div key={g.key} className="mb-4">
                            <div className="mb-2 flex items-center gap-2 border-b border-slate-200 pb-1" style={g.color ? { borderLeft: `3px solid ${g.color}`, paddingLeft: 6 } : undefined}>
                                <span className="text-xs font-semibold text-gray-800">{g.label}</span>
                                <Badge colorScheme="gray">{g.rows.length}</Badge>
                                <span className="text-[11px] tabular-nums text-gray-500">{fmtCurrency(g.rows.reduce((s, r) => s + (r.src.unit_value != null ? r.value : 0), 0), baseCurrency)}</span>
                            </div>
                            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">{g.rows.map(renderCard)}</div>
                        </div>
                    ))}
                </div>
            ) : splitActive ? (
                renderSplit(rows => renderTable(rows, false, 'max-h-[60vh]'), true)
            ) : (
                renderTable(effectiveGroupKey === 'none' ? pagedFlat : null, true)
            )}

            {pagination}
            {dustHidden > 0 && (
                <div className="px-3 pb-2 text-right text-[10px] text-gray-400">
                    {dustHidden} small-value asset{dustHidden !== 1 ? 's' : ''} hidden by the min value filter
                </div>
            )}
        </div>
    );
};
