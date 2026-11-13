/**
 * BenchmarkSummary — Total return card lines: TWR vs the main benchmark, and what the same
 * deposits/withdrawals would be worth in it (PME).
 */
import React from 'react';
import { BENCHMARK_PRESETS, useBenchmarkComparison } from '../../hooks/useChartData';
import { fmtCurrency, fmtCurrencySigned } from './TotalReturnScorecard';
import { InfoTip } from './pnlTerms';

const PME_HELP = 'Replays every deposit and withdrawal you made, on the same days and amounts, into the benchmark instead. Shows what that portfolio would be worth today and how far your actual value is from it.';

interface BenchmarkSummaryProps {
    versionId: number | null;
    ticker: string;
    onTickerChange: (ticker: string) => void;
    period: string;
    baseCurrency: string;
    scope: { assetIds?: number[]; accountIds?: number[]; categoryIds?: number[] };
}

const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;

export const BenchmarkSummary: React.FC<BenchmarkSummaryProps> = ({ versionId, ticker, onTickerChange, period, baseCurrency, scope }) => {
    const { data, isLoading, error } = useBenchmarkComparison(versionId, ticker, period, baseCurrency, scope);
    const label = BENCHMARK_PRESETS.find(b => b.ticker === ticker)?.label ?? ticker;
    const excess = data?.excess_pp;
    const pmeDiff = data?.pme_value != null ? data.actual_value - data.pme_value : null;

    return (
        <div className="mt-1 flex flex-col gap-0.5 text-[11px] text-gray-500" data-testid="benchmark-summary">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <select
                    value={ticker}
                    onChange={(e) => onTickerChange(e.target.value)}
                    className="h-6 border border-slate-200 bg-white px-1 text-[11px] text-slate-700"
                    aria-label="Benchmark"
                >
                    {BENCHMARK_PRESETS.map(b => <option key={b.ticker} value={b.ticker}>{b.label}</option>)}
                </select>
                {isLoading ? (
                    <span className="text-gray-300">…</span>
                ) : error || data?.benchmark_return_pct == null ? (
                    <span className="text-gray-400">no benchmark data</span>
                ) : (
                    <>
                        <span className="tabular-nums text-gray-700" title={data.converted ? `In ${data.currency}` : `In ${data.currency} (not converted)`}>{pct(data.benchmark_return_pct)}</span>
                        {excess != null && (
                            <span
                                className={`font-semibold tabular-nums ${excess >= 0 ? 'text-green-600' : 'text-red-600'}`}
                                title={`Your TWR minus the benchmark return over the same period: ${excess >= 0 ? 'outperformed' : 'underperformed'} by ${Math.abs(excess).toFixed(1)} pp${data.excess_annualized_pp != null ? ` (${data.excess_annualized_pp >= 0 ? '+' : ''}${data.excess_annualized_pp.toFixed(1)} pp per year)` : ''}`}
                            >
                                {excess >= 0 ? '▲' : '▼'} {excess >= 0 ? '+' : ''}{excess.toFixed(1)} pp
                                {data.excess_annualized_pp != null && (
                                    <span className="font-normal text-gray-400"> · {data.excess_annualized_pp >= 0 ? '+' : ''}{data.excess_annualized_pp.toFixed(1)}/y</span>
                                )}
                            </span>
                        )}
                        {!data.converted && <span className="text-orange-600" title="Exchange rate unavailable">{data.currency}</span>}
                    </>
                )}
            </div>
            {!isLoading && data?.pme_value != null && pmeDiff != null && (
                <div
                    className="inline-flex flex-wrap items-center gap-x-1"
                    title={`Your deposits in ${label} instead would be worth ${fmtCurrency(data.pme_value, baseCurrency)}; you are ${pmeDiff >= 0 ? 'ahead' : 'behind'} by ${fmtCurrency(Math.abs(pmeDiff), baseCurrency)}`}
                >
                    Same deposits: <span className="font-semibold tabular-nums text-gray-700">{fmtCurrency(data.pme_value, baseCurrency)}</span>
                    <span className={`tabular-nums ${pmeDiff >= 0 ? 'text-green-600' : 'text-red-600'}`}>· you {fmtCurrencySigned(pmeDiff, baseCurrency)}</span>
                    <InfoTip text={PME_HELP} size={10} />
                </div>
            )}
        </div>
    );
};
