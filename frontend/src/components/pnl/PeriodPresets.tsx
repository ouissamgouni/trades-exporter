/**
 * PeriodPresets — page-wide period selector: 1W … All with ROI, TWR or MWR per period,
 * benchmark comparison in each tooltip.
 */
import React from 'react';
import { RANGES, type Range } from './TotalReturnScorecard';

export type PeriodMetric = 'roi' | 'twr' | 'mwr';

export const PERIOD_METRICS: PeriodMetric[] = ['roi', 'twr', 'mwr'];

const METRIC_TITLES: Record<PeriodMetric, string> = {
    roi: 'ROI: return on the cost of what you hold now',
    twr: 'TWR: time-weighted return, not moved by deposits/withdrawals',
    mwr: 'MWR: money-weighted return (IRR) of your actual flows; yearly from 1Y on',
};

interface PeriodPresetsProps {
    range: Range;
    onChange: (r: Range) => void;
    metric: PeriodMetric;
    onMetricChange: (m: PeriodMetric) => void;
    roi: Record<Range, number | null>;
    twr: Record<Range, number | null>;
    mwr?: Record<Range, number | null>;
    /** Benchmark return per period (base currency) for the tooltip */
    benchmark?: { label: string; returns: Record<Range, number | null> };
    periodSpan: string;
}

const pct = (v: number | null | undefined, digits = 1) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`);

export function presetTooltip(label: string, roi: number | null, twr: number | null, bench?: { label: string; value: number | null }, mwr?: number | null): string {
    const parts = [label, `ROI ${pct(roi)}`, `TWR ${pct(twr)}`];
    if (mwr !== undefined) parts.push(`MWR ${pct(mwr)}`);
    if (bench && bench.value != null) {
        parts.push(`${bench.label} ${pct(bench.value)}`);
        if (twr != null) parts.push(`${twr - bench.value >= 0 ? '+' : ''}${(twr - bench.value).toFixed(1)} pp`);
    }
    return parts.join(' · ');
}

export const PeriodPresets: React.FC<PeriodPresetsProps> = ({ range, onChange, metric, onMetricChange, roi, twr, mwr, benchmark, periodSpan }) => {
    const values: Record<PeriodMetric, Record<Range, number | null> | undefined> = { roi, twr, mwr };
    const metrics = PERIOD_METRICS.filter(m => values[m] != null);
    return (
        <div className="flex items-stretch gap-2" data-testid="period-presets">
            <div className="flex h-11 flex-col justify-between" title="Value shown under each period">
                {metrics.map(m => (
                    <button
                        key={m}
                        type="button"
                        onClick={() => onMetricChange(m)}
                        title={METRIC_TITLES[m]}
                        className={`h-[14px] border px-1.5 text-[9px] font-semibold leading-none ${metric === m ? 'border-blue-500 bg-blue-500 text-white' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'}`}
                        aria-pressed={metric === m}
                    >
                        {m.toUpperCase()}
                    </button>
                ))}
            </div>
            <div className="flex border border-slate-200 bg-white" role="tablist" aria-label="Period">
                {RANGES.map(r => {
                    const v = (values[metric] ?? roi)[r.key];
                    const active = range === r.key;
                    return (
                        <button
                            key={r.key}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            onClick={() => onChange(r.key)}
                            title={`${presetTooltip(r.label, roi[r.key], twr[r.key], benchmark ? { label: benchmark.label, value: benchmark.returns[r.key] } : undefined, mwr ? mwr[r.key] : undefined)}${active ? ` · ${periodSpan}` : ''}`}
                            className={`flex h-11 min-w-[64px] flex-col items-center justify-center border-r border-slate-200 px-2 last:border-r-0 ${active ? 'bg-blue-500 text-white' : 'hover:bg-slate-50'}`}
                            data-testid={`period-${r.key}`}
                        >
                            <span className={`text-xs font-bold ${active ? 'text-white' : 'text-gray-600'}`}>{r.label}</span>
                            <span className={`text-xs font-semibold tabular-nums ${active ? 'text-blue-50' : v == null ? 'text-gray-300' : v >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                {pct(v)}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
};
