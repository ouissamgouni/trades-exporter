/**
 * PeriodPresets — page-wide period selector: 1W … All with ROI or TWR per period,
 * benchmark comparison in each tooltip.
 */
import React from 'react';
import { RANGES, type Range } from './TotalReturnScorecard';

export type PeriodMetric = 'roi' | 'twr';

interface PeriodPresetsProps {
    range: Range;
    onChange: (r: Range) => void;
    metric: PeriodMetric;
    onMetricChange: (m: PeriodMetric) => void;
    roi: Record<Range, number | null>;
    twr: Record<Range, number | null>;
    /** Benchmark return per period (base currency) for the tooltip */
    benchmark?: { label: string; returns: Record<Range, number | null> };
    periodSpan: string;
}

const pct = (v: number | null | undefined, digits = 1) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`);

export function presetTooltip(label: string, roi: number | null, twr: number | null, bench?: { label: string; value: number | null }): string {
    const parts = [label, `ROI ${pct(roi)}`, `TWR ${pct(twr)}`];
    if (bench && bench.value != null) {
        parts.push(`${bench.label} ${pct(bench.value)}`);
        if (twr != null) parts.push(`${twr - bench.value >= 0 ? '+' : ''}${(twr - bench.value).toFixed(1)} pp`);
    }
    return parts.join(' · ');
}

export const PeriodPresets: React.FC<PeriodPresetsProps> = ({ range, onChange, metric, onMetricChange, roi, twr, benchmark, periodSpan }) => (
    <div className="flex items-stretch gap-2" data-testid="period-presets">
        <div className="flex flex-col justify-center" title="Value shown under each period">
            {(['roi', 'twr'] as PeriodMetric[]).map(m => (
                <button
                    key={m}
                    type="button"
                    onClick={() => onMetricChange(m)}
                    className={`h-5 border px-1.5 text-[10px] font-semibold ${metric === m ? 'border-blue-500 bg-blue-500 text-white' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'}`}
                    aria-pressed={metric === m}
                >
                    {m.toUpperCase()}
                </button>
            ))}
        </div>
        <div className="flex border border-slate-200 bg-white" role="tablist" aria-label="Period">
            {RANGES.map(r => {
                const v = metric === 'twr' ? twr[r.key] : roi[r.key];
                const active = range === r.key;
                return (
                    <button
                        key={r.key}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => onChange(r.key)}
                        title={`${presetTooltip(r.label, roi[r.key], twr[r.key], benchmark ? { label: benchmark.label, value: benchmark.returns[r.key] } : undefined)}${active ? ` · ${periodSpan}` : ''}`}
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
