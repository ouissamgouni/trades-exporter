/**
 * ContributorsPanel — Best and Worst side by side, ranked by the chosen metric.
 * Header shows the net of the current grouping with total gains and losses.
 */
import React, { useContext, useMemo, useState } from 'react';
import { FiTrendingDown, FiTrendingUp } from 'react-icons/fi';
import { LuInfo } from 'react-icons/lu';
import { Tooltip } from '../ui/tooltip';
import { AssetDetailPanelContext } from '../../contexts/AssetDetailPanelContext';
import { fmtCurrency, fmtCurrencySigned } from './TotalReturnScorecard';
import type { GroupBy, PerformerItem } from '../../hooks/useChartData';
import type { DimensionWithCategories } from '../../types';

export type ContributorMetric = 'TR' | 'U' | 'MV' | 'Eff';
export type ContributorDisplay = '$' | '%';

const METRICS: [ContributorMetric, string, string][] = [
    ['TR', 'Return', 'Total return'],
    ['U', 'Unreal.', 'Unrealized P&L'],
    ['MV', 'Value', 'Market value'],
    ['Eff', 'Eff.', 'Efficiency (return / cost)'],
];

export function metricValue(p: PerformerItem, metric: ContributorMetric): number {
    switch (metric) {
        case 'U': return p.unrealized_pnl ?? 0;
        case 'MV': return p.market_value ?? 0;
        case 'Eff': return p.efficiency ?? 0;
        default: return p.total_return;
    }
}

/** Split into positive (desc) and negative (asc) lists by the chosen metric. */
export function splitContributors(items: PerformerItem[], metric: ContributorMetric) {
    const positives = items.filter(p => metricValue(p, metric) > 0).sort((a, b) => metricValue(b, metric) - metricValue(a, metric));
    const negatives = items.filter(p => metricValue(p, metric) < 0).sort((a, b) => metricValue(a, metric) - metricValue(b, metric));
    const sum = (list: PerformerItem[]) => list.reduce((acc, p) => acc + metricValue(p, metric), 0);
    return { positives, negatives, gains: sum(positives), losses: sum(negatives), net: sum(positives) + sum(negatives) };
}

function fmtMetric(v: number, metric: ContributorMetric, baseCurrency: string): string {
    if (metric === 'Eff') return `${v.toFixed(2)}x`;
    if (metric === 'MV') return fmtCurrency(v, baseCurrency);
    return fmtCurrencySigned(v, baseCurrency);
}

function fmtPct(v: number): string {
    return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

interface ContributorsPanelProps {
    items: PerformerItem[];
    baseCurrency: string;
    isLoading?: boolean;
    periodLabel: string;
    groupBy: GroupBy;
    onGroupByChange?: (groupBy: GroupBy) => void;
    dimensions?: DimensionWithCategories[];
    selectedDimensionId?: number | null;
    onDimensionChange?: (dimensionId: number) => void;
    onItemClick?: (item: PerformerItem) => void;
    versionId?: number | null;
}

const Seg: React.FC<{ active: boolean; onClick: () => void; title?: string; children: React.ReactNode }> = ({ active, onClick, title, children }) => (
    <button
        type="button"
        title={title}
        onClick={onClick}
        className={`h-7 border px-2.5 text-xs font-medium transition-colors ${active ? 'border-blue-500 bg-blue-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
    >
        {children}
    </button>
);

export const ContributorsPanel: React.FC<ContributorsPanelProps> = ({
    items,
    baseCurrency,
    isLoading,
    periodLabel,
    groupBy,
    onGroupByChange,
    dimensions = [],
    selectedDimensionId,
    onDimensionChange,
    onItemClick,
    versionId,
}) => {
    const [metric, setMetric] = useState<ContributorMetric>('TR');
    const [display, setDisplay] = useState<ContributorDisplay>('$');
    const [count, setCount] = useState(8);
    const assetPanelCtx = useContext(AssetDetailPanelContext);

    const { positives, negatives, gains, losses, net } = useMemo(() => splitContributors(items, metric), [items, metric]);
    const maxAbs = Math.max(...[...positives.slice(0, count), ...negatives.slice(0, count)].map(p => Math.abs(metricValue(p, metric))), 1);
    const maxCount = Math.max(positives.length, negatives.length, 3);

    const totalCost = items.reduce((acc, p) => acc + (p.cost_basis ?? 0), 0);
    const pctOfCost = (v: number) => (totalCost > 0 ? fmtPct((v / totalCost) * 100) : null);
    const summable = metric !== 'Eff';
    const showPct = display === '%' && metric === 'TR';

    const renderRow = (p: PerformerItem, rank: number, positive: boolean) => {
        const v = metricValue(p, metric);
        const width = Math.max((Math.abs(v) / maxAbs) * 100, 4);
        const clickable = !!onItemClick && p.id >= 0;
        const primary = display === '%' ? fmtPct(p.roi_pct) : fmtMetric(v, metric, baseCurrency);
        const secondary = display === '%' ? fmtCurrencySigned(p.total_return, baseCurrency) : fmtPct(p.roi_pct);
        return (
            <div
                key={`${p.group_type}-${p.id}`}
                className={`flex items-center gap-1.5 px-1 py-0.5 ${clickable ? 'cursor-pointer hover:bg-slate-50' : ''}`}
                onClick={clickable ? () => onItemClick!(p) : undefined}
            >
                <span className="w-4 shrink-0 text-right text-[10px] font-bold text-gray-400">{rank}</span>
                <Tooltip content={p.label || p.name} openDelay={300}>
                    <span className="w-[96px] shrink-0 truncate text-xs font-semibold text-gray-700">{p.label || p.name}</span>
                </Tooltip>
                {groupBy === 'asset' && assetPanelCtx && (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); assetPanelCtx.openAssetPanel(p.id, { pnlVersionId: versionId ?? undefined }); }}
                        className="shrink-0 text-gray-300 hover:text-blue-500"
                        title="Asset details"
                        aria-label={`${p.label || p.name} details`}
                    >
                        <LuInfo size={11} />
                    </button>
                )}
                <div className={`relative h-4 min-w-0 flex-1 overflow-hidden ${positive ? 'bg-green-50' : 'bg-red-50'}`}>
                    <div className={`h-full ${positive ? 'bg-green-400' : 'bg-red-400'}`} style={{ width: `${width}%` }} />
                    <span className={`absolute left-1 top-1/2 -translate-y-1/2 text-[10px] font-bold tabular-nums ${width > 35 ? 'text-white' : positive ? 'text-green-700' : 'text-red-700'}`}>
                        {primary}
                    </span>
                </div>
                <span className={`w-[64px] shrink-0 text-right text-[10px] font-semibold tabular-nums ${positive ? 'text-green-600' : 'text-red-600'}`}>{secondary}</span>
            </div>
        );
    };

    const column = (positive: boolean) => {
        const list = positive ? positives : negatives;
        const total = positive ? gains : losses;
        return (
            <div className="min-w-0">
                <div className="mb-1 flex items-center justify-between gap-2 border-b border-slate-100 pb-1">
                    <span className={`inline-flex items-center gap-1 text-sm font-semibold ${positive ? 'text-green-600' : 'text-red-600'}`}>
                        {positive ? <FiTrendingUp size={14} /> : <FiTrendingDown size={14} />}
                        {positive ? 'Best' : 'Worst'}
                        <span className="text-[10px] font-normal text-gray-400">{list.length}</span>
                    </span>
                    {summable && list.length > 0 && (
                        <span className="text-[10px] text-gray-500">
                            Total <span className={`font-semibold tabular-nums ${positive ? 'text-green-600' : 'text-red-600'}`}>{showPct ? pctOfCost(total) : fmtMetric(total, metric, baseCurrency)}</span>
                        </span>
                    )}
                </div>
                {list.length === 0 ? (
                    <div className="py-2 text-[11px] text-gray-400">{positive ? 'No positive contributions' : 'No negative contributions'}</div>
                ) : (
                    <div className="max-h-[320px] overflow-y-auto">
                        {list.slice(0, count).map((p, i) => renderRow(p, i + 1, positive))}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="border border-slate-200 bg-white p-3" data-testid="contributors-panel">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-gray-700">Contributors</span>
                    <span className="border border-slate-200 px-1.5 text-[10px] font-semibold text-slate-500">{periodLabel}</span>
                </div>
                {summable && !isLoading && (
                    <div className="flex flex-wrap items-baseline gap-x-4" data-testid="contributors-totals">
                        <span className="text-xs text-gray-500">
                            Gains <span className="font-bold tabular-nums text-green-600">{showPct ? pctOfCost(gains) : fmtMetric(gains, metric, baseCurrency)}</span>
                        </span>
                        <span className="text-xs text-gray-500">
                            Losses <span className="font-bold tabular-nums text-red-600">{showPct ? pctOfCost(losses) : fmtMetric(losses, metric, baseCurrency)}</span>
                        </span>
                        <span className="border-l border-slate-200 pl-4 text-xs text-gray-500">
                            Net <span className={`text-lg font-bold tabular-nums ${net >= 0 ? 'text-green-600' : 'text-red-600'}`}>{showPct ? pctOfCost(net) : fmtMetric(net, metric, baseCurrency)}</span>
                        </span>
                    </div>
                )}
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="flex flex-wrap">
                    <Seg active={groupBy === 'asset'} onClick={() => onGroupByChange?.('asset')}>Asset</Seg>
                    <Seg active={groupBy === 'account'} onClick={() => onGroupByChange?.('account')}>Account</Seg>
                    {dimensions.map(dim => (
                        <Seg
                            key={dim.id}
                            active={groupBy === 'category' && selectedDimensionId === dim.id}
                            onClick={() => { onGroupByChange?.('category'); onDimensionChange?.(dim.id); }}
                        >
                            {dim.label}
                        </Seg>
                    ))}
                </div>
                <div className="flex">
                    {METRICS.map(([key, label, tip]) => (
                        <Seg key={key} active={metric === key} onClick={() => setMetric(key)} title={tip}>{label}</Seg>
                    ))}
                </div>
                <div className="flex">
                    <Seg active={display === '$'} onClick={() => setDisplay('$')} title="Amounts">$</Seg>
                    <Seg active={display === '%'} onClick={() => setDisplay('%')} title="Percentages">%</Seg>
                </div>
                <label className="ml-auto flex items-center gap-1.5 text-[10px] text-gray-400">
                    Top {count}
                    <input
                        type="range"
                        min={3}
                        max={Math.max(maxCount, 5)}
                        step={1}
                        value={count}
                        onChange={(e) => setCount(Number(e.target.value))}
                        className="h-1 w-[60px] accent-blue-500"
                        aria-label="Number of contributors"
                    />
                </label>
            </div>

            {isLoading ? (
                <div className="py-6 text-center text-xs text-gray-400">Loading contributors…</div>
            ) : positives.length + negatives.length === 0 ? (
                <div className="py-6 text-center text-xs text-gray-400">No contributions in this period</div>
            ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {column(true)}
                    {column(false)}
                </div>
            )}
        </div>
    );
};
