/**
 * ReturnBridge — waterfall rows explaining the overview numbers.
 *
 *   Value row:   Cost → ±Unrealized = Value          (period: Start value → Cost Δ → Unrealized Δ = End value)
 *   Return row:  Unrealized ± Realized = Total return  (+ Income shown apart, fees noted as already included)
 */
import React from 'react';
import { InfoTip, TERM_HELP } from './pnlTerms';
import { fmtCurrency, fmtCurrencySigned, realizedSubLines, type MetricSubLine, type RangeMetrics } from './TotalReturnScorecard';

export type BridgeStepKind = 'start' | 'delta' | 'total' | 'extra';

export interface BridgeStep {
    key: string;
    label: string;
    value: number;
    kind: BridgeStepKind;
    /** Signed display (+/-) instead of plain amount */
    signed?: boolean;
    /** Depends on live prices (shows a placeholder while they load) */
    live?: boolean;
    info?: string;
    subLines?: MetricSubLine[];
    onClick?: () => void;
}

export interface BridgeRow {
    key: string;
    title: string;
    steps: BridgeStep[];
    note?: { label: string; value: string; onClick?: () => void };
}

export interface BridgeHandlers {
    onMetricClick?: (metric: 'total_return' | 'cost_basis' | 'unrealized' | 'realized') => void;
    onFeesClick?: () => void;
    onIncomeClick?: () => void;
}

/** Build the two bridge rows; each row's total equals the sum of its start/delta steps. */
export function buildBridgeRows(
    m: RangeMetrics,
    isPeriod: boolean,
    baseCurrency: string,
    handlers: BridgeHandlers = {},
): BridgeRow[] {
    const click = (metric: 'total_return' | 'cost_basis' | 'unrealized' | 'realized') =>
        handlers.onMetricClick ? () => handlers.onMetricClick!(metric) : undefined;

    const cost = isPeriod ? m.costBasisInPeriod : m.costBasis;
    const unrealized = isPeriod ? m.unrealizedInPeriod : m.unrealizedPnl;
    const realized = isPeriod ? m.realizedInPeriod : m.realizedPnl;
    const income = isPeriod
        ? m.incomeInPeriod - m.withholdingInPeriod
        : m.totalIncome - m.totalWithholding;
    const fees = isPeriod ? m.feesInPeriod : m.totalFees;

    const costSubLines: MetricSubLine[] = [];
    if (m.netDeposits) costSubLines.push({ label: 'Net deposits', value: fmtCurrencySigned(m.netDeposits, baseCurrency), info: TERM_HELP.netDeposits });
    if (!isPeriod && m.unfundedSpend) costSubLines.push({ label: 'Incl. unfunded spend', value: fmtCurrency((m.netDeposits ?? 0) + m.unfundedSpend, baseCurrency) });

    const realizedLines = isPeriod
        ? [{ label: 'Taxable', value: fmtCurrencySigned(m.taxableRealizedInPeriod, baseCurrency), info: TERM_HELP.taxable }]
        : realizedSubLines(m, baseCurrency, fmtCurrencySigned);

    const valueRow: BridgeRow = isPeriod
        ? {
            key: 'value',
            title: 'Value',
            steps: [
                { key: 'start', label: 'Start value', value: m.currentValue - cost - unrealized, kind: 'start', live: true },
                { key: 'cost', label: 'Cost Δ', value: cost, kind: 'delta', signed: true, info: TERM_HELP.cost, subLines: costSubLines, onClick: click('cost_basis') },
                { key: 'unrealized', label: 'Unrealized Δ', value: unrealized, kind: 'delta', signed: true, live: true, onClick: click('unrealized') },
                { key: 'end', label: 'End value', value: m.currentValue, kind: 'total', live: true, onClick: click('total_return') },
            ],
        }
        : {
            key: 'value',
            title: 'Value',
            steps: [
                { key: 'cost', label: 'Cost', value: cost, kind: 'start', info: TERM_HELP.cost, subLines: costSubLines, onClick: click('cost_basis') },
                { key: 'unrealized', label: 'Unrealized', value: unrealized, kind: 'delta', signed: true, live: true, onClick: click('unrealized') },
                { key: 'value', label: 'Value', value: cost + unrealized, kind: 'total', live: true, onClick: click('total_return') },
            ],
        };

    const sfx = isPeriod ? ' Δ' : '';
    const returnSteps: BridgeStep[] = [
        { key: 'unrealized', label: `Unrealized${sfx}`, value: unrealized, kind: 'start', signed: true, live: true, onClick: click('unrealized') },
        { key: 'realized', label: `Realized${sfx}`, value: realized, kind: 'delta', signed: true, info: TERM_HELP.realized, subLines: realizedLines, onClick: click('realized') },
        { key: 'total', label: `Total return${sfx}`, value: unrealized + realized, kind: 'total', signed: true, live: true, onClick: click('total_return') },
    ];
    if (Math.abs(income) >= 0.01 || m.incomeEventCount > 0) {
        returnSteps.push({ key: 'income', label: `Income${sfx}`, value: income, kind: 'extra', signed: true, info: 'Dividends, interest and rewards (net of withholding). Shown apart: not included in Total return.', onClick: handlers.onIncomeClick });
    }

    return [
        valueRow,
        {
            key: 'return',
            title: 'Return',
            steps: returnSteps,
            note: Math.abs(fees) >= 0.01
                ? { label: `Fees${sfx} (already in cost/realized)`, value: fmtCurrency(fees, baseCurrency), onClick: handlers.onFeesClick }
                : undefined,
        },
    ];
}

interface Segment { from: number; to: number }

/** Bar extents per step; start/total bars go from 0, deltas float from the running total. */
export function bridgeSegments(steps: BridgeStep[]): Segment[] {
    let running = 0;
    return steps.map(step => {
        if (step.kind === 'start') {
            running = step.value;
            return { from: 0, to: step.value };
        }
        if (step.kind === 'delta') {
            const seg = { from: running, to: running + step.value };
            running += step.value;
            return seg;
        }
        if (step.kind === 'total') return { from: 0, to: running };
        return { from: 0, to: step.value };
    });
}

const OPERATOR: Record<BridgeStepKind, string> = { start: '', delta: '+', total: '=', extra: '·' };

function barClass(step: BridgeStep, rowKey: string): string {
    if (step.kind === 'extra') return 'bg-teal-400';
    if (step.kind === 'delta') return step.value >= 0 ? 'bg-green-400' : 'bg-red-400';
    if (rowKey === 'return') return step.value >= 0 ? 'bg-green-600' : 'bg-red-600';
    return 'bg-slate-400';
}

function valueClass(step: BridgeStep): string {
    if (!step.signed) return 'text-gray-800';
    if (step.kind === 'extra') return 'text-teal-700';
    return step.value >= 0 ? 'text-green-600' : 'text-red-600';
}

interface ReturnBridgeProps {
    rows: BridgeRow[];
    baseCurrency: string;
    isLiveLoading?: boolean;
}

export const ReturnBridge: React.FC<ReturnBridgeProps> = ({ rows, baseCurrency, isLiveLoading }) => (
    <div className="flex flex-col gap-3">
        {rows.map(row => {
            const segments = bridgeSegments(row.steps);
            const lo = Math.min(0, ...segments.flatMap(s => [s.from, s.to]));
            const hi = Math.max(0, ...segments.flatMap(s => [s.from, s.to]));
            const span = hi - lo || 1;
            return (
                <div key={row.key} className="flex items-stretch gap-3" data-testid={`bridge-row-${row.key}`}>
                    <div className="flex w-14 shrink-0 flex-col justify-between pt-1">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{row.title}</span>
                    </div>
                    <div className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto">
                        {row.steps.map((step, i) => {
                            const seg = segments[i];
                            const pending = isLiveLoading && step.live;
                            const bottom = ((Math.min(seg.from, seg.to) - lo) / span) * 100;
                            const height = Math.max((Math.abs(seg.to - seg.from) / span) * 100, 2);
                            const display = step.signed ? fmtCurrencySigned(step.value, baseCurrency) : fmtCurrency(step.value, baseCurrency);
                            return (
                                <React.Fragment key={step.key}>
                                    {OPERATOR[step.kind] && (
                                        <div className={`flex w-4 shrink-0 items-center justify-center text-sm font-bold ${step.kind === 'extra' ? 'text-gray-300' : 'text-gray-400'}`}>
                                            {OPERATOR[step.kind]}
                                        </div>
                                    )}
                                    <div
                                        className={`flex min-w-[120px] flex-1 flex-col border px-2.5 py-2 transition-colors ${step.kind === 'total' ? 'border-slate-300 bg-slate-50' : step.kind === 'extra' ? 'border-dashed border-teal-200 bg-white' : 'border-slate-200 bg-white'} ${step.onClick ? 'cursor-pointer hover:border-blue-300' : ''}`}
                                        onClick={step.onClick}
                                    >
                                        <div className="flex items-center gap-1">
                                            <span className="whitespace-nowrap text-[11px] font-medium text-gray-500">{step.label}</span>
                                            {step.info && <InfoTip text={step.info} size={10} />}
                                        </div>
                                        <span className={`whitespace-nowrap text-base font-bold tabular-nums ${pending ? 'text-gray-300' : valueClass(step)}`}>
                                            {pending ? '…' : display}
                                        </span>
                                        {step.subLines?.map(line => (
                                            <span key={line.label} className="inline-flex items-center gap-1 whitespace-nowrap text-[10px] text-gray-500">
                                                {line.label}: {line.value}
                                                {line.info && <InfoTip text={line.info} size={9} />}
                                            </span>
                                        ))}
                                        <div className="relative mt-auto h-8 w-full bg-slate-50 pt-1">
                                            {!pending && (
                                                <div
                                                    className={`absolute left-1/4 right-1/4 ${barClass(step, row.key)}`}
                                                    style={{ bottom: `${bottom}%`, height: `${height}%` }}
                                                />
                                            )}
                                        </div>
                                    </div>
                                </React.Fragment>
                            );
                        })}
                        {row.note && (
                            <div
                                className={`ml-2 flex shrink-0 flex-col justify-center border-l border-slate-200 pl-3 ${row.note.onClick ? 'cursor-pointer hover:text-blue-600' : ''}`}
                                onClick={row.note.onClick}
                            >
                                <span className="whitespace-nowrap text-[10px] text-gray-400">{row.note.label}</span>
                                <span className="whitespace-nowrap text-xs font-semibold tabular-nums text-orange-700">{row.note.value}</span>
                            </div>
                        )}
                    </div>
                </div>
            );
        })}
    </div>
);
