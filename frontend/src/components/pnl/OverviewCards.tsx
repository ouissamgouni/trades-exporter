/**
 * OverviewCards — Total return (ratios, benchmark, Gains│Losses), Unrealized/Realized stacked,
 * Value, Cost with Fees, then a composition bar whose colours match the card accents.
 */
import React from 'react';
import { FiTrendingDown, FiTrendingUp } from 'react-icons/fi';
import { Badge } from '../ui/primitives';
import { InfoTip, TERM_HELP } from './pnlTerms';
import { GainsLossesBar } from './GainsLossesBar';
import { fmtCurrency, fmtCurrencySigned, type RangeMetrics } from './TotalReturnScorecard';
import type { ReturnMetricsRange } from '../../hooks/useChartData';
import type { AssetPnLRow } from './types';

const ROI_HELP = 'Return on investment: total return ÷ cost of what you hold now. Not annualized, and it moves whenever you add or withdraw money, so recent deposits dilute it.';
const TWR_HELP = 'Time-weighted return: chains the daily returns, whatever the amount invested each day. Deposits and withdrawals do not affect it, so it is the fair comparison with an index. It is higher than ROI when gains were made on a smaller amount before later deposits. /y = annualized.';
const IRR_HELP = 'Money-weighted return (IRR): the yearly rate that turns your actual deposits and withdrawals into today\'s value. Above TWR/y means good timing of deposits; below means bad timing.';

/** Accent classes shared by cards and composition-bar segments (full literals for Tailwind). */
export const ACCENT = {
    cost: { border: 'border-l-slate-400', bg: 'bg-slate-400', tint: 'bg-slate-50' },
    unrealized: { border: 'border-l-sky-500', bg: 'bg-sky-500', tint: 'bg-sky-50/70' },
    realized: { border: 'border-l-violet-500', bg: 'bg-violet-500', tint: 'bg-violet-50/70' },
    fees: { border: 'border-l-orange-400', bg: 'bg-orange-400', tint: 'bg-orange-50/70' },
    value: { border: 'border-l-blue-700', bg: 'bg-blue-700', tint: 'bg-blue-50/60' },
} as const;

const HATCH: React.CSSProperties = {
    backgroundImage: 'repeating-linear-gradient(135deg, rgba(255,255,255,0.75) 0 3px, transparent 3px 6px)',
};

export interface CompositionSegment {
    key: 'cost' | 'unrealized' | 'realized';
    /** Left offset and width, in % of the bar */
    left: number;
    width: number;
    negative: boolean;
}

/**
 * Value = Cost + Unrealized as one solid run; a negative Unrealized is the hatched tail of Cost.
 * Realized sits apart after a gap since it is no longer in Value.
 */
export function compositionSegments(cost: number, unrealized: number, realized: number): { segments: CompositionSegment[]; valuePct: number; feesScale: number } {
    const value = cost + unrealized;
    const gap = realized !== 0 ? 1.5 : 0;
    const total = Math.max(cost, value, 0) + Math.abs(realized);
    if (total <= 0) return { segments: [], valuePct: 0, feesScale: 0 };
    const usable = 100 - gap;
    const pct = (v: number) => (Math.abs(v) / total) * usable;
    const segments: CompositionSegment[] = [];
    if (unrealized >= 0) {
        segments.push({ key: 'cost', left: 0, width: pct(cost), negative: false });
        segments.push({ key: 'unrealized', left: pct(cost), width: pct(unrealized), negative: false });
    } else {
        const kept = Math.max(value, 0);
        segments.push({ key: 'cost', left: 0, width: pct(kept), negative: false });
        segments.push({ key: 'unrealized', left: pct(kept), width: pct(cost - kept), negative: true });
    }
    const runEnd = pct(Math.max(cost, value, 0));
    if (realized !== 0) segments.push({ key: 'realized', left: runEnd + gap, width: pct(realized), negative: realized < 0 });
    return { segments, valuePct: pct(Math.max(value, 0)), feesScale: usable / total };
}

interface OverviewCardsProps {
    metrics: RangeMetrics;
    isPeriod: boolean;
    periodLabel: string;
    baseCurrency: string;
    isLiveLoading?: boolean;
    returnMetrics?: ReturnMetricsRange | null;
    gains?: number;
    losses?: number;
    gainCount?: number;
    lossCount?: number;
    isTotalsLoading?: boolean;
    /** Value at period start (from the timeline) for the Value Δ line */
    startValue?: number | null;
    assets?: AssetPnLRow[];
    /** Benchmark comparison lines rendered inside the Total return card */
    benchmarkSlot?: React.ReactNode;
    onFeesClick?: () => void;
    onIncomeClick?: () => void;
    /** Scrolls to the Contributors section */
    onContributorsClick?: () => void;
}

const pctText = (v: number | null | undefined, digits = 1) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
const signClass = (v: number) => (v >= 0 ? 'text-green-600' : 'text-red-600');

const Line: React.FC<{ label: string; value: React.ReactNode; info?: string; className?: string }> = ({ label, value, info, className }) => (
    <div className="flex items-center justify-between gap-2 text-[11px] text-gray-500">
        <span className="inline-flex items-center gap-1 whitespace-nowrap">{label}{info && <InfoTip text={info} size={9} />}</span>
        <span className={`whitespace-nowrap tabular-nums ${className ?? 'text-gray-700'}`}>{value}</span>
    </div>
);

const Card: React.FC<{ title: string; accent: { border: string; tint: string }; info?: string; aside?: React.ReactNode; children: React.ReactNode; className?: string; onClick?: () => void; testId?: string }> = ({ title, accent, info, aside, children, className, onClick, testId }) => (
    <div
        className={`flex flex-col gap-1 border border-l-4 border-slate-200 px-3 py-2 ${accent.border} ${accent.tint} ${onClick ? 'cursor-pointer hover:border-blue-300' : ''} ${className ?? ''}`}
        onClick={onClick}
        data-testid={testId}
    >
        <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                {title}{info && <InfoTip text={info} size={10} />}
            </span>
            {aside}
        </div>
        {children}
    </div>
);

const Ratio: React.FC<{ label: string; help: string; children: React.ReactNode }> = ({ label, help, children }) => (
    <span className="inline-flex items-center gap-1 border border-slate-200 bg-white px-1.5 py-0.5">
        <span className="text-gray-500">{label}</span>
        {children}
        <InfoTip text={help} size={10} />
    </span>
);

export const OverviewCards: React.FC<OverviewCardsProps> = ({
    metrics: m, isPeriod, periodLabel, baseCurrency, isLiveLoading, returnMetrics, gains, losses, gainCount, lossCount,
    isTotalsLoading, startValue, assets = [], benchmarkSlot, onFeesClick, onIncomeClick, onContributorsClick,
}) => {
    const sfx = isPeriod ? ' Δ' : '';
    const unrealized = isPeriod ? m.unrealizedInPeriod : m.unrealizedPnl;
    const realized = isPeriod ? m.realizedInPeriod : m.realizedPnl;
    const total = m.totalReturn;
    const fees = isPeriod ? m.feesInPeriod : m.totalFees;
    const income = isPeriod ? m.incomeInPeriod - m.withholdingInPeriod : m.totalIncome - m.totalWithholding;
    const live = (node: React.ReactNode) => (isLiveLoading ? <span className="text-gray-300">…</span> : node);

    const withLots = assets.filter(a => a.has_lots);
    const open = withLots.filter(a => a.quantity > 0);
    const closed = withLots.length - open.length;
    const upCount = open.filter(a => a.unrealized_pnl > 0).length;
    const downCount = open.filter(a => a.unrealized_pnl < 0).length;

    const twrAnn = returnMetrics?.twr_annualized_pct;
    const irr = returnMetrics?.irr_pct;
    const irrPeriod = returnMetrics?.irr_period_pct;
    const yearly = (returnMetrics?.days ?? 0) >= 365;

    const hasGL = gains != null && losses != null;

    const { segments, valuePct, feesScale } = compositionSegments(m.costBasis, m.unrealizedPnl, m.realizedPnl);
    const segColor: Record<CompositionSegment['key'], string> = { cost: ACCENT.cost.bg, unrealized: ACCENT.unrealized.bg, realized: ACCENT.realized.bg };

    return (
        <div className="flex flex-col gap-2" data-testid="overview-cards">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[2fr_1fr_1fr_1fr]">
                {/* Total return */}
                <div className="flex flex-col border border-slate-200 bg-white p-3 md:col-span-2 xl:col-span-1" data-testid="card-total-return">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Total return · {periodLabel}</span>
                        {onContributorsClick && (
                            <button type="button" onClick={onContributorsClick} className="text-[11px] text-blue-600 hover:underline" data-testid="link-contributors">
                                Contributors ↓
                            </button>
                        )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className={`inline-flex items-center gap-1.5 text-3xl font-bold tabular-nums ${isLiveLoading ? 'text-gray-300' : signClass(total)}`}>
                            {total >= 0 ? <FiTrendingUp size={22} /> : <FiTrendingDown size={22} />}
                            {isLiveLoading ? '…' : fmtCurrencySigned(total, baseCurrency)}
                        </span>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                            <Ratio label="ROI" help={ROI_HELP}>
                                <span className={`font-bold tabular-nums ${signClass(m.roi)}`}>{live(pctText(m.roi, 2))}</span>
                            </Ratio>
                            <Ratio label="TWR" help={TWR_HELP}>
                                <span className={`font-bold tabular-nums ${signClass(returnMetrics?.twr_pct ?? 0)}`}>{pctText(returnMetrics?.twr_pct)}</span>
                                {yearly && twrAnn != null && <span className="text-[10px] text-gray-400">{pctText(twrAnn)}/y</span>}
                            </Ratio>
                            <Ratio label="IRR" help={IRR_HELP}>
                                <span className={`font-bold tabular-nums ${signClass((yearly ? irr : irrPeriod) ?? 0)}`}>{pctText(yearly ? irr : irrPeriod)}{yearly && irr != null ? '/y' : ''}</span>
                            </Ratio>
                        </div>
                    </div>
                    {benchmarkSlot}
                    {(Math.abs(income) >= 0.01 || m.incomeEventCount > 0) && (
                        <div
                            className={`mt-1 text-[11px] text-gray-500 ${onIncomeClick ? 'cursor-pointer hover:text-blue-600' : ''}`}
                            onClick={onIncomeClick}
                            title="Dividends, interest and rewards (net of withholding). Not included in Total return."
                        >
                            Income{sfx} <span className="font-semibold tabular-nums text-teal-700">{fmtCurrencySigned(income, baseCurrency)}</span> <span className="text-gray-400">(separate)</span>
                        </div>
                    )}
                    <div className="mt-auto flex pt-2" data-testid="gains-losses-bar">
                        {isTotalsLoading || !hasGL ? (
                            <div className="h-5 flex-1 animate-pulse bg-slate-50" />
                        ) : (
                            <GainsLossesBar gains={gains!} losses={losses!} gainCount={gainCount} lossCount={lossCount} format={(v) => fmtCurrencySigned(v, baseCurrency)} />
                        )}
                    </div>
                </div>

                {/* Unrealized + Realized */}
                <div className="flex flex-col gap-3">
                    <Card title={`Unrealized${sfx}`} accent={ACCENT.unrealized} className="flex-1" testId="card-unrealized"
                        aside={<span className={`text-base font-bold tabular-nums ${isLiveLoading ? 'text-gray-300' : signClass(unrealized)}`}>{live(fmtCurrencySigned(unrealized, baseCurrency))}</span>}
                    >
                        <Line label="On cost" value={live(pctText(m.costBasis > 0 ? (m.unrealizedPnl / m.costBasis) * 100 : null))} />
                        {open.length > 0 && <Line label="Open positions" value={<><span className="text-green-600">{upCount}▲</span> <span className="text-red-600">{downCount}▼</span></>} />}
                        {isPeriod && <Line label="Total now" value={live(fmtCurrencySigned(m.unrealizedPnl, baseCurrency))} />}
                    </Card>
                    <Card title={`Realized${sfx}`} accent={ACCENT.realized} info={TERM_HELP.realized} className="flex-1" testId="card-realized"
                        aside={<span className={`text-base font-bold tabular-nums ${signClass(realized)}`}>{fmtCurrencySigned(realized, baseCurrency)}</span>}
                    >
                        <Line label="Taxable" info={TERM_HELP.taxable} value={fmtCurrencySigned(isPeriod ? m.taxableRealizedInPeriod : m.taxableRealizedPnl, baseCurrency)} />
                        {!isPeriod && m.deferredGain != null && Math.abs(m.deferredGain) >= 0.01 && (
                            <Line label="Deferred" info={TERM_HELP.deferred} value={fmtCurrencySigned(m.deferredGain, baseCurrency)} />
                        )}
                        {closed > 0 && <Line label="Closed positions" value={closed} />}
                    </Card>
                </div>

                {/* Value */}
                <Card title="Value" accent={ACCENT.value} testId="card-value">
                    <span className={`text-2xl font-bold tabular-nums ${isLiveLoading ? 'text-gray-300' : 'text-gray-800'}`}>{live(fmtCurrency(m.currentValue, baseCurrency))}</span>
                    {withLots.length > 0 && <Line label="Positions" value={`${open.length} open · ${closed} closed`} />}
                    {isPeriod && startValue != null && (
                        <Line label={`Δ ${periodLabel}`} value={live(fmtCurrencySigned(m.currentValue - startValue, baseCurrency))} className={signClass(m.currentValue - startValue)} />
                    )}
                    {isPeriod && startValue != null && <Line label="Start value" value={fmtCurrency(startValue, baseCurrency)} />}
                    <Line label="Cost + Unrealized" value={live(`${fmtCurrency(m.costBasis, baseCurrency)} ${m.unrealizedPnl >= 0 ? '+' : '−'} ${fmtCurrency(Math.abs(m.unrealizedPnl), baseCurrency)}`)} />
                </Card>

                {/* Cost, with Fees nested (fees are already inside cost / realized) */}
                <Card title="Cost" accent={ACCENT.cost} info={TERM_HELP.cost} testId="card-cost">
                    <span className="text-2xl font-bold tabular-nums text-gray-800">{fmtCurrency(m.costBasis, baseCurrency)}</span>
                    {isPeriod && <Line label={`Δ ${periodLabel}`} value={fmtCurrencySigned(m.costBasisInPeriod, baseCurrency)} />}
                    {m.netDeposits != null && Math.abs(m.netDeposits) >= 0.01 && <Line label="Net deposits" info={TERM_HELP.netDeposits} value={fmtCurrencySigned(m.netDeposits, baseCurrency)} />}
                    {!isPeriod && !!m.unfundedSpend && <Line label="Unfunded spend" value={fmtCurrency(m.unfundedSpend, baseCurrency)} />}
                    {m.totalInvested > 0 && <Line label="Total bought" info={TERM_HELP.totalBought} value={fmtCurrency(m.totalInvested, baseCurrency)} />}
                    <div
                        className={`mt-1 flex flex-col gap-0.5 border-l-2 border-orange-400 ${ACCENT.fees.tint} px-2 py-1 ${onFeesClick ? 'cursor-pointer hover:bg-orange-100/70' : ''}`}
                        onClick={onFeesClick}
                        title="Already included in cost / realized"
                        data-testid="card-fees"
                    >
                        <div className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="font-semibold uppercase tracking-wide text-gray-500">Fees{sfx}</span>
                            <span className="text-sm font-bold tabular-nums text-orange-700">{fmtCurrency(fees, baseCurrency)}</span>
                        </div>
                        <Line label="Of cost · of return" value={`${m.costBasis > 0 ? `${((fees / m.costBasis) * 100).toFixed(2)}%` : '—'} · ${!isLiveLoading && Math.abs(total) >= 0.01 ? `${((fees / Math.abs(total)) * 100).toFixed(1)}%` : '—'}`} />
                        {!isPeriod && m.feeEntryCount > 0 && <Line label="Entries" value={m.feeEntryCount} />}
                    </div>
                </Card>
            </div>

            {/* Composition bar (all-time amounts) */}
            {segments.length > 0 && !isLiveLoading && (
                <div data-testid="composition-bar">
                    <div className="relative h-4 w-full bg-slate-50">
                        {segments.map(s => (
                            <div
                                key={s.key}
                                className={`absolute top-0 h-full ${segColor[s.key]} ${s.key === 'realized' ? 'outline-dashed outline-1 outline-offset-1 outline-violet-300' : ''}`}
                                style={{ left: `${s.left}%`, width: `${Math.max(s.width, 0.3)}%`, ...(s.negative ? HATCH : {}) }}
                                title={`${s.key === 'cost' ? 'Cost' : s.key === 'unrealized' ? 'Unrealized' : 'Realized'}${s.negative ? ' (loss)' : ''}`}
                            />
                        ))}
                        {fees > 0 && (
                            <div
                                className={`absolute bottom-0 left-0 h-1 ${ACCENT.fees.bg}`}
                                style={{ width: `${Math.max(Math.min(m.totalFees * feesScale, valuePct), 0.3)}%` }}
                                title={`Fees ${fmtCurrency(m.totalFees, baseCurrency)} (included in cost / realized)`}
                            />
                        )}
                        <div className="absolute -top-1 h-6 w-px bg-blue-700" style={{ left: `${valuePct}%` }} title={`Value ${fmtCurrency(m.currentValue, baseCurrency)}`} />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[10px] text-gray-500">
                        <Badge colorScheme="gray">All time</Badge>
                        <span className="inline-flex items-center gap-1"><span className={`h-2 w-2 ${ACCENT.unrealized.bg}`} style={m.unrealizedPnl < 0 ? HATCH : undefined} />Unrealized {fmtCurrencySigned(m.unrealizedPnl, baseCurrency)}</span>
                        {m.realizedPnl !== 0 && <span className="inline-flex items-center gap-1"><span className={`h-2 w-2 ${ACCENT.realized.bg}`} style={m.realizedPnl < 0 ? HATCH : undefined} />Realized {fmtCurrencySigned(m.realizedPnl, baseCurrency)} (taken out of value)</span>}
                        <span className="inline-flex items-center gap-1"><span className={`h-2 w-2 ${ACCENT.cost.bg}`} />Cost {fmtCurrency(m.costBasis, baseCurrency)}</span>
                        {m.totalFees > 0 && <span className="inline-flex items-center gap-1"><span className={`h-1 w-3 ${ACCENT.fees.bg}`} />Fees {fmtCurrency(m.totalFees, baseCurrency)} (included)</span>}
                        <span className="inline-flex items-center gap-1"><span className="h-3 w-px bg-blue-700" />Value {fmtCurrency(m.currentValue, baseCurrency)}</span>
                    </div>
                </div>
            )}
        </div>
    );
};
