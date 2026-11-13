/**
 * AccountsStrip — horizontally scrollable per-account cards for the overview.
 * Period-aware (return/realized/income follow the global period), sortable, with a Σ check
 * against the overview value.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { FiAlertTriangle, FiArrowDown, FiArrowUp } from 'react-icons/fi';
import { getAccountColor } from '../../utils/accountColors';
import { EntityInfoButton } from '../EntityInfoButton';
import { PnLBreakdownBar } from './PnLBreakdownBar';
import { fmtCurrency, fmtCurrencySigned } from './TotalReturnScorecard';
import type { PerformerItem, SparklinePoint } from '../../hooks/useChartData';
import type { Account } from '../../types';

export type AccountSortKey = 'value' | 'return' | 'roi' | 'realized' | 'fees' | 'weight' | 'name';

const SORT_OPTIONS: [AccountSortKey, string][] = [
    ['value', 'Value'],
    ['return', 'Return'],
    ['roi', 'ROI %'],
    ['realized', 'Realized'],
    ['fees', 'Fees'],
    ['weight', 'Weight'],
    ['name', 'Name'],
];

const STORAGE_KEY = 'pnl.accountsStrip';

interface StripPrefs { sort: AccountSortKey; dir: 'asc' | 'desc'; showClosed: boolean; groupBy: 'none' | 'group' }

const DEFAULT_PREFS: StripPrefs = { sort: 'value', dir: 'desc', showClosed: false, groupBy: 'none' };

function loadPrefs(): StripPrefs {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
    } catch {
        // ignore malformed prefs
    }
    return DEFAULT_PREFS;
}

export const UNGROUPED_LABEL = 'Ungrouped';

export interface AccountGroupBucket { key: string; label: string; items: PerformerItem[]; value: number; totalReturn: number }

/** Buckets accounts by their account group (largest value first, "Ungrouped" last); items keep their order. */
export function groupAccounts(items: PerformerItem[], groupOf: (id: number) => string | null | undefined): AccountGroupBucket[] {
    const map = new Map<string, AccountGroupBucket>();
    for (const p of items) {
        const label = groupOf(p.id)?.trim() || UNGROUPED_LABEL;
        const b = map.get(label) ?? { key: label, label, items: [], value: 0, totalReturn: 0 };
        b.items.push(p);
        b.value += p.market_value;
        b.totalReturn += p.total_return;
        map.set(label, b);
    }
    return [...map.values()].sort((a, b) => {
        if (a.label === UNGROUPED_LABEL) return 1;
        if (b.label === UNGROUPED_LABEL) return -1;
        return b.value - a.value;
    });
}

/** Sums member sparklines by date (dates missing in a member keep its last known value). */
export function sumSparklines(series: SparklinePoint[][]): SparklinePoint[] {
    const dates = [...new Set(series.flatMap(s => s.map(p => p.date)))].sort();
    return dates.map(date => {
        let value = 0;
        for (const s of series) {
            let last: number | null = null;
            for (const p of s) {
                if (p.date > date) break;
                last = p.value;
            }
            value += last ?? 0;
        }
        return { date, value, roi: null };
    });
}

/** Value-weighted average of member rates (null when none is known). */
export function weightedRate(items: PerformerItem[], rates: Record<string, number | null> | undefined): number | null {
    let num = 0;
    let den = 0;
    for (const p of items) {
        const r = rates?.[String(p.id)];
        if (r == null) continue;
        const w = Math.max(p.market_value, 0) || Math.max(p.cost_basis, 0);
        num += r * w;
        den += w;
    }
    return den > 0 ? num / den : null;
}

export function isClosedAccount(p: PerformerItem): boolean {
    return Math.abs(p.market_value) < 0.01;
}

export function sortAccounts(items: PerformerItem[], sort: AccountSortKey, dir: 'asc' | 'desc'): PerformerItem[] {
    const key = (p: PerformerItem): number | string => {
        switch (sort) {
            case 'return': return p.total_return;
            case 'roi': return p.roi_pct;
            case 'realized': return p.realized_pnl ?? 0;
            case 'fees': return p.total_fees;
            case 'name': return p.name.toLowerCase();
            default: return p.market_value; // value and weight order the same
        }
    };
    const sign = dir === 'asc' ? 1 : -1;
    return [...items].sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        if (typeof ka === 'string' && typeof kb === 'string') return ka.localeCompare(kb) * sign;
        return ((ka as number) - (kb as number)) * sign;
    });
}

/** True when the cards don't add up to the overview value (beyond rounding). */
export function accountsMismatch(items: PerformerItem[], overviewValue: number | null | undefined): number | null {
    if (overviewValue == null || items.length === 0) return null;
    const sum = items.reduce((acc, p) => acc + p.market_value, 0);
    const diff = sum - overviewValue;
    return Math.abs(diff) > Math.max(1, Math.abs(overviewValue) * 0.005) ? diff : null;
}

const Sparkline: React.FC<{ points: SparklinePoint[]; color: string }> = ({ points, color }) => {
    if (points.length < 2) return <div className="h-6" />;
    const values = points.map(p => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const w = 100;
    const h = 24;
    const coords = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / range) * (h - 2) - 1}`).join(' ');
    return (
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="block h-6 w-full">
            <polyline fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" points={coords} />
        </svg>
    );
};

interface AccountsStripProps {
    items: PerformerItem[];
    baseCurrency: string;
    periodLabel: string;
    isPeriod: boolean;
    isLoading?: boolean;
    overviewValue?: number | null;
    sparklines?: Record<string, SparklinePoint[]>;
    onAccountClick?: (accountId: number, name: string) => void;
    /** Accounts in the current (multi-)account scope */
    selectedIds?: number[];
    /** Ticked accounts are only applied to the scope on confirm */
    onApplySelection?: (accounts: { id: number; name: string }[]) => void;
    /** TWR % per account (keyed by id) */
    twr?: Record<string, number | null>;
    /** MWR % per account (keyed by id) */
    mwr?: Record<string, number | null>;
    benchmark?: { label: string; returnPct: number | null };
    /** Account records (for account groups) */
    accounts?: Account[];
    pnlVersionId?: number;
}

export const AccountsStrip: React.FC<AccountsStripProps> = ({
    items,
    baseCurrency,
    periodLabel,
    isPeriod,
    isLoading,
    overviewValue,
    sparklines,
    onAccountClick,
    selectedIds = [],
    onApplySelection,
    twr,
    mwr,
    benchmark,
    accounts = [],
    pnlVersionId,
}) => {
    const [prefs, setPrefs] = useState<StripPrefs>(loadPrefs);
    useEffect(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ }
    }, [prefs]);

    const selectedKey = selectedIds.join(',');
    const [pending, setPending] = useState<number[] | null>(null);
    useEffect(() => { setPending(null); }, [selectedKey]);
    const ticked = pending ?? selectedIds;
    const togglePending = (id: number) => setPending(prev => {
        const base = prev ?? selectedIds;
        return base.includes(id) ? base.filter(x => x !== id) : [...base, id];
    });
    const dirty = pending != null && (pending.length !== selectedIds.length || pending.some(id => !selectedIds.includes(id)));
    const applySelection = () => {
        if (!pending) return;
        onApplySelection?.(pending.map(id => ({ id, name: items.find(p => p.id === id)?.name ?? String(id) })));
        setPending(null);
    };

    const closedCount = items.filter(isClosedAccount).length;
    const visible = useMemo(() => {
        const base = prefs.showClosed ? items : items.filter(p => !isClosedAccount(p));
        return sortAccounts(base, prefs.sort, prefs.dir);
    }, [items, prefs]);

    const totalValue = items.reduce((acc, p) => acc + p.market_value, 0);
    const mismatch = accountsMismatch(items, overviewValue);

    const groupById = useMemo(() => new Map(accounts.map(a => [a.id, a.group])), [accounts]);
    const hasGroups = accounts.some(a => a.group?.trim());
    const grouped = hasGroups && prefs.groupBy === 'group';
    const buckets = useMemo(
        () => (grouped ? groupAccounts(visible, id => groupById.get(id)) : []),
        [grouped, visible, groupById],
    );
    const toggleGroupPending = (ids: number[], on: boolean) => setPending(prev => {
        const base = prev ?? selectedIds;
        return on ? [...new Set([...base, ...ids])] : base.filter(x => !ids.includes(x));
    });

    if (!isLoading && items.length === 0) return null;

    const renderCard = (p: PerformerItem) => {
        const color = getAccountColor(p.id);
        const weight = totalValue > 0 ? (p.market_value / totalValue) * 100 : 0;
        const positive = p.total_return >= 0;
        const series = sparklines?.[String(p.id)] ?? [];
        const selected = selectedIds.includes(p.id);
        const isTicked = ticked.includes(p.id);
        const accTwr = twr?.[String(p.id)];
        const accMwr = mwr?.[String(p.id)];
        const clickable = !!onAccountClick || !!onApplySelection;
        return (
            <div
                key={p.id}
                className={`flex w-[230px] shrink-0 flex-col gap-1.5 border p-2.5 transition-colors ${selected ? 'border-blue-500 bg-blue-50' : isTicked ? 'border-blue-300 bg-blue-50/40' : 'border-slate-200 bg-white'} ${clickable ? 'cursor-pointer hover:border-blue-300' : ''} ${isClosedAccount(p) ? 'opacity-70' : ''}`}
                style={{ borderLeft: `3px solid ${color}` }}
                onClick={clickable ? (e) => {
                    if (onApplySelection && (e.metaKey || e.ctrlKey)) togglePending(p.id);
                    else onAccountClick?.(p.id, p.name);
                } : undefined}
                data-testid={`account-card-${p.id}`}
            >
                <div
                    className={`-mx-1 -mt-1 flex items-center justify-between gap-2 px-1 pt-1 ${onApplySelection ? 'hover:bg-blue-50' : ''}`}
                    onClick={onApplySelection ? (e) => { e.stopPropagation(); togglePending(p.id); } : undefined}
                    title={onApplySelection ? (isTicked ? 'Untick to remove from the combined scope' : 'Tick to combine with other accounts') : undefined}
                    data-testid={`account-card-header-${p.id}`}
                >
                    <span className="flex min-w-0 items-center gap-1.5">
                        {onApplySelection && (
                            <input
                                type="checkbox"
                                checked={isTicked}
                                onClick={(e) => e.stopPropagation()}
                                onChange={() => togglePending(p.id)}
                                className="shrink-0 accent-blue-500"
                                aria-label={`Include ${p.name} in scope`}
                            />
                        )}
                        <span className="truncate text-xs font-semibold text-gray-700" title={p.name}>{p.name}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                        <span className="text-[10px] tabular-nums text-gray-500">{weight.toFixed(1)}%</span>
                        <EntityInfoButton kind="account" id={p.id} label={p.name} pnlVersionId={pnlVersionId} size={12} />
                    </span>
                </div>
                <div className="h-1 w-full bg-slate-100">
                    <div className="h-full" style={{ width: `${Math.min(weight, 100)}%`, backgroundColor: color }} />
                </div>
                <div className="flex items-baseline justify-between gap-2">
                    <span className="text-lg font-bold tabular-nums text-gray-800">{fmtCurrency(p.market_value, baseCurrency)}</span>
                    <span className={`text-xs font-semibold tabular-nums ${positive ? 'text-green-600' : 'text-red-600'}`}>
                        {positive ? '▲' : '▼'} {fmtCurrencySigned(p.total_return, baseCurrency)}
                    </span>
                </div>
                <div className="flex items-center justify-between text-[10px] text-gray-500">
                    <span>{isPeriod ? `Return ${periodLabel}` : 'Total return'}</span>
                    <span className={`font-semibold tabular-nums ${p.roi_pct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {p.roi_pct >= 0 ? '+' : ''}{p.roi_pct.toFixed(1)}%
                    </span>
                </div>
                {p.cost_basis > 0 && (
                    <PnLBreakdownBar
                        costBasis={p.cost_basis}
                        unrealizedPnl={p.unrealized_pnl}
                        realizedPnl={p.realized_pnl ?? 0}
                        fees={p.total_fees}
                        baseCurrency={baseCurrency}
                        height={4}
                    />
                )}
                {(accTwr != null || accMwr != null) && (
                    <div className="flex items-center justify-between text-[10px] text-gray-500" title="Time-weighted and money-weighted return over the period (weekly points)">
                        <span className="flex gap-2">
                            {accTwr != null && <span>TWR <span className={`font-semibold tabular-nums ${accTwr >= 0 ? 'text-green-600' : 'text-red-600'}`}>{accTwr >= 0 ? '+' : ''}{accTwr.toFixed(1)}%</span></span>}
                            {accMwr != null && <span data-testid={`account-mwr-${p.id}`}>MWR <span className={`font-semibold tabular-nums ${accMwr >= 0 ? 'text-green-600' : 'text-red-600'}`}>{accMwr >= 0 ? '+' : ''}{accMwr.toFixed(1)}%</span></span>}
                        </span>
                        {accTwr != null && benchmark?.returnPct != null && (
                            <span className={`tabular-nums ${accTwr - benchmark.returnPct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                vs {benchmark.label} {accTwr - benchmark.returnPct >= 0 ? '+' : ''}{(accTwr - benchmark.returnPct).toFixed(1)} pp
                            </span>
                        )}
                    </div>
                )}
                <div className="flex flex-wrap gap-x-2 text-[10px] tabular-nums text-gray-500">
                    <span>Unr. <span className={p.unrealized_pnl >= 0 ? 'text-green-600' : 'text-red-600'}>{fmtCurrencySigned(p.unrealized_pnl, baseCurrency)}</span></span>
                    <span>Real. <span className={(p.realized_pnl ?? 0) >= 0 ? 'text-green-600' : 'text-red-600'}>{fmtCurrencySigned(p.realized_pnl ?? 0, baseCurrency)}</span></span>
                    <span>Fees <span className="text-orange-700">{fmtCurrency(p.total_fees, baseCurrency)}</span></span>
                    {Math.abs(p.income ?? 0) >= 0.01 && (
                        <span>Inc. <span className="text-teal-700">{fmtCurrencySigned(p.income ?? 0, baseCurrency)}</span></span>
                    )}
                </div>
                <Sparkline points={series} color={color} />
            </div>
        );
    };

    const renderGroupCard = (b: AccountGroupBucket) => {
        const ids = b.items.map(p => p.id);
        const allTicked = ids.every(id => ticked.includes(id));
        const scoped = ids.length > 0 && ids.every(id => selectedIds.includes(id)) && selectedIds.length === ids.length;
        const weight = totalValue > 0 ? (b.value / totalValue) * 100 : 0;
        const cost = b.items.reduce((s, p) => s + p.cost_basis, 0);
        const unrealized = b.items.reduce((s, p) => s + p.unrealized_pnl, 0);
        const realized = b.items.reduce((s, p) => s + (p.realized_pnl ?? 0), 0);
        const fees = b.items.reduce((s, p) => s + p.total_fees, 0);
        const income = b.items.reduce((s, p) => s + (p.income ?? 0), 0);
        const roi = cost > 0 ? (b.totalReturn / cost) * 100 : null;
        const groupTwr = weightedRate(b.items, twr);
        const groupMwr = weightedRate(b.items, mwr);
        const positive = b.totalReturn >= 0;
        const series = sumSparklines(b.items.map(p => sparklines?.[String(p.id)] ?? []));
        const apply = () => onApplySelection?.(b.items.map(p => ({ id: p.id, name: p.name })));
        return (
            <div
                key={b.key}
                className={`flex w-[280px] shrink-0 flex-col gap-1.5 border border-l-4 border-l-slate-500 p-2.5 transition-colors ${scoped ? 'border-blue-500 bg-blue-50' : allTicked && pending ? 'border-blue-300 bg-blue-50/40' : 'border-slate-200 bg-white'} ${onApplySelection ? 'cursor-pointer hover:border-blue-300' : ''}`}
                onClick={onApplySelection ? apply : undefined}
                title={onApplySelection ? `Scope the page to the ${ids.length} account${ids.length === 1 ? '' : 's'} of ${b.label}` : undefined}
                data-testid={`account-group-card-${b.key}`}
            >
                <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                        {onApplySelection && (
                            <input
                                type="checkbox"
                                checked={allTicked}
                                onClick={(e) => e.stopPropagation()}
                                onChange={() => toggleGroupPending(ids, !allTicked)}
                                className="shrink-0 accent-blue-500"
                                aria-label={`Tick all accounts in ${b.label}`}
                            />
                        )}
                        <span className="truncate text-xs font-semibold text-gray-800" title={b.label}>{b.label}</span>
                        <span className="shrink-0 border border-slate-200 px-1 text-[10px] text-gray-500">{ids.length}</span>
                    </span>
                    <span className="text-[10px] tabular-nums text-gray-500">{weight.toFixed(1)}%</span>
                </div>
                <div className="h-1 w-full bg-slate-100">
                    <div className="h-full bg-slate-500" style={{ width: `${Math.min(weight, 100)}%` }} />
                </div>
                <div className="flex items-baseline justify-between gap-2">
                    <span className="text-lg font-bold tabular-nums text-gray-800">{fmtCurrency(b.value, baseCurrency)}</span>
                    <span className={`text-xs font-semibold tabular-nums ${positive ? 'text-green-600' : 'text-red-600'}`}>
                        {positive ? '▲' : '▼'} {fmtCurrencySigned(b.totalReturn, baseCurrency)}
                    </span>
                </div>
                <div className="flex items-center justify-between text-[10px] text-gray-500">
                    <span>{isPeriod ? `Return ${periodLabel}` : 'Total return'}</span>
                    {roi != null && (
                        <span className={`font-semibold tabular-nums ${roi >= 0 ? 'text-green-600' : 'text-red-600'}`}>{roi >= 0 ? '+' : ''}{roi.toFixed(1)}%</span>
                    )}
                </div>
                {cost > 0 && (
                    <PnLBreakdownBar costBasis={cost} unrealizedPnl={unrealized} realizedPnl={realized} fees={fees} baseCurrency={baseCurrency} height={4} />
                )}
                {(groupTwr != null || groupMwr != null) && (
                    <div className="flex gap-2 text-[10px] text-gray-500" title="Value-weighted average of the accounts' rates">
                        {groupTwr != null && <span>TWR ≈ <span className={`font-semibold tabular-nums ${groupTwr >= 0 ? 'text-green-600' : 'text-red-600'}`}>{groupTwr >= 0 ? '+' : ''}{groupTwr.toFixed(1)}%</span></span>}
                        {groupMwr != null && <span>MWR ≈ <span className={`font-semibold tabular-nums ${groupMwr >= 0 ? 'text-green-600' : 'text-red-600'}`}>{groupMwr >= 0 ? '+' : ''}{groupMwr.toFixed(1)}%</span></span>}
                    </div>
                )}
                <div className="flex flex-wrap gap-x-2 text-[10px] tabular-nums text-gray-500">
                    <span>Unr. <span className={unrealized >= 0 ? 'text-green-600' : 'text-red-600'}>{fmtCurrencySigned(unrealized, baseCurrency)}</span></span>
                    <span>Real. <span className={realized >= 0 ? 'text-green-600' : 'text-red-600'}>{fmtCurrencySigned(realized, baseCurrency)}</span></span>
                    <span>Fees <span className="text-orange-700">{fmtCurrency(fees, baseCurrency)}</span></span>
                    {Math.abs(income) >= 0.01 && <span>Inc. <span className="text-teal-700">{fmtCurrencySigned(income, baseCurrency)}</span></span>}
                </div>
                <Sparkline points={series} color="#64748b" />
                <div className="flex flex-wrap gap-1 border-t border-slate-100 pt-1.5">
                    {b.items.map(p => (
                        <button
                            key={p.id}
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onAccountClick?.(p.id, p.name); }}
                            className="inline-flex max-w-full items-center gap-1 border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-gray-700 hover:border-blue-300 hover:text-blue-700"
                            title={`${p.name}: ${fmtCurrency(p.market_value, baseCurrency)} · ${fmtCurrencySigned(p.total_return, baseCurrency)}`}
                        >
                            <span aria-hidden className="h-2 w-2 shrink-0" style={{ backgroundColor: getAccountColor(p.id) }} />
                            <span className="truncate">{p.name}</span>
                        </button>
                    ))}
                </div>
            </div>
        );
    };

    return (
        <div className="border border-slate-200 bg-white p-3" data-testid="accounts-strip">
            <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="border border-slate-200 px-1.5 text-[10px] font-semibold text-slate-500">{periodLabel}</span>
                <span className="text-xs text-gray-500">
                    {visible.length} account{visible.length !== 1 ? 's' : ''} · <span className="font-semibold tabular-nums text-gray-700">{fmtCurrency(totalValue, baseCurrency)}</span>
                </span>
                {mismatch != null && (
                    <span
                        className="inline-flex items-center gap-1 border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-[10px] text-orange-700"
                        title="Sum of account values differs from the overview value"
                    >
                        <FiAlertTriangle size={10} /> Σ accounts {fmtCurrencySigned(mismatch, baseCurrency)} vs overview
                    </span>
                )}
                {onApplySelection && !dirty && (
                    <span className="text-[10px] text-gray-400">Click a card to open it · click its header to tick and combine</span>
                )}
                <div className="ml-auto flex items-center gap-2">
                    {onApplySelection && dirty && (
                        <span className="inline-flex items-center gap-1.5 border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700" data-testid="accounts-selection-bar">
                            {pending!.length === 0 ? 'Clear selection' : `${pending!.length} account${pending!.length !== 1 ? 's' : ''} ticked`}
                            <button type="button" onClick={applySelection} className="bg-blue-500 px-2 py-0.5 font-semibold text-white hover:bg-blue-600">Apply</button>
                            <button type="button" onClick={() => setPending(null)} className="px-1 text-blue-600 hover:underline">Cancel</button>
                        </span>
                    )}
                    {hasGroups && (
                        <label className="flex items-center gap-1 text-[11px] text-gray-500">
                            Group
                            <select
                                value={prefs.groupBy}
                                onChange={(e) => setPrefs(p => ({ ...p, groupBy: e.target.value as StripPrefs['groupBy'] }))}
                                className="h-6 border border-slate-200 bg-white px-1 text-[11px] text-slate-700"
                                aria-label="Group accounts"
                            >
                                <option value="none">None</option>
                                <option value="group">Account group</option>
                            </select>
                        </label>
                    )}
                    {closedCount > 0 && (
                        <label className="flex cursor-pointer items-center gap-1 text-[11px] text-gray-500">
                            <input
                                type="checkbox"
                                checked={prefs.showClosed}
                                onChange={(e) => setPrefs(p => ({ ...p, showClosed: e.target.checked }))}
                                className="accent-blue-500"
                            />
                            Closed ({closedCount})
                        </label>
                    )}
                    <label className="flex items-center gap-1 text-[11px] text-gray-500">
                        Sort
                        <select
                            value={prefs.sort}
                            onChange={(e) => setPrefs(p => ({ ...p, sort: e.target.value as AccountSortKey }))}
                            className="h-6 border border-slate-200 bg-white px-1 text-[11px] text-slate-700"
                        >
                            {SORT_OPTIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                        </select>
                    </label>
                    <button
                        type="button"
                        onClick={() => setPrefs(p => ({ ...p, dir: p.dir === 'asc' ? 'desc' : 'asc' }))}
                        className="flex h-6 w-6 items-center justify-center border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                        aria-label={prefs.dir === 'asc' ? 'Sort ascending' : 'Sort descending'}
                        title={prefs.dir === 'asc' ? 'Ascending' : 'Descending'}
                    >
                        {prefs.dir === 'asc' ? <FiArrowUp size={12} /> : <FiArrowDown size={12} />}
                    </button>
                </div>
            </div>

            {isLoading ? (
                <div className="flex gap-2 overflow-hidden">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="h-[150px] w-[230px] shrink-0 animate-pulse border border-slate-100 bg-slate-50" />
                    ))}
                </div>
            ) : grouped ? (
                <div className="flex gap-2 overflow-x-auto pb-1" data-testid="accounts-groups">
                    {buckets.map(renderGroupCard)}
                </div>
            ) : (
                <div className="flex gap-2 overflow-x-auto pb-1">{visible.map(renderCard)}</div>
            )}
        </div>
    );
};
