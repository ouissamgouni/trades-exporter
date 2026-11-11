/**
 * AccountsStrip — horizontally scrollable per-account cards for the overview.
 * Period-aware (return/realized/income follow the global period), sortable, with a Σ check
 * against the overview value.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { FiAlertTriangle, FiArrowDown, FiArrowUp } from 'react-icons/fi';
import { getAccountColor } from '../../utils/accountColors';
import { PnLBreakdownBar } from './PnLBreakdownBar';
import { fmtCurrency, fmtCurrencySigned } from './TotalReturnScorecard';
import type { PerformerItem, SparklinePoint } from '../../hooks/useChartData';

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

interface StripPrefs { sort: AccountSortKey; dir: 'asc' | 'desc'; showClosed: boolean }

function loadPrefs(): StripPrefs {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return { sort: 'value', dir: 'desc', showClosed: false, ...JSON.parse(raw) };
    } catch {
        // ignore malformed prefs
    }
    return { sort: 'value', dir: 'desc', showClosed: false };
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
}) => {
    const [prefs, setPrefs] = useState<StripPrefs>(loadPrefs);
    useEffect(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ }
    }, [prefs]);

    const closedCount = items.filter(isClosedAccount).length;
    const visible = useMemo(() => {
        const base = prefs.showClosed ? items : items.filter(p => !isClosedAccount(p));
        return sortAccounts(base, prefs.sort, prefs.dir);
    }, [items, prefs]);

    const totalValue = items.reduce((acc, p) => acc + p.market_value, 0);
    const mismatch = accountsMismatch(items, overviewValue);

    if (!isLoading && items.length === 0) return null;

    return (
        <div className="border border-slate-200 bg-white p-3" data-testid="accounts-strip">
            <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-gray-700">Accounts</span>
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
                <div className="ml-auto flex items-center gap-2">
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
            ) : (
                <div className="flex gap-2 overflow-x-auto pb-1">
                    {visible.map(p => {
                        const color = getAccountColor(p.id);
                        const weight = totalValue > 0 ? (p.market_value / totalValue) * 100 : 0;
                        const positive = p.total_return >= 0;
                        const series = sparklines?.[String(p.id)] ?? [];
                        return (
                            <div
                                key={p.id}
                                className={`flex w-[230px] shrink-0 flex-col gap-1.5 border border-slate-200 bg-white p-2.5 transition-colors ${onAccountClick ? 'cursor-pointer hover:border-blue-300' : ''} ${isClosedAccount(p) ? 'opacity-70' : ''}`}
                                style={{ borderLeft: `3px solid ${color}` }}
                                onClick={onAccountClick ? () => onAccountClick(p.id, p.name) : undefined}
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <span className="truncate text-xs font-semibold text-gray-700" title={p.name}>{p.name}</span>
                                    <span className="shrink-0 text-[10px] tabular-nums text-gray-500">{weight.toFixed(1)}%</span>
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
                    })}
                </div>
            )}
        </div>
    );
};
