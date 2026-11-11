/**
 * ContributorsPanel — top contributors / detractors as diverging bars centred on zero.
 * Header shows the net of the current grouping; gains/losses subtotals underneath.
 */
import React, { useContext, useMemo, useState } from 'react';
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
        className={`h-6 border px-2 text-[11px] font-medium transition-colors ${active ? 'border-blue-500 bg-blue-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
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
    const [count, setCount] = useState(7);
    const assetPanelCtx = useContext(AssetDetailPanelContext);

    const { positives, negatives, gains, losses, net } = useMemo(() => splitContributors(items, metric), [items, metric]);
    const visible = [...positives.slice(0, count), ...negatives.slice(0, count)];
    const maxAbs = Math.max(...visible.map(p => Math.abs(metricValue(p, metric))), 1);
    const maxCount = Math.max(positives.length, negatives.length, 3);

    const totalCost = items.reduce((acc, p) => acc + (p.cost_basis ?? 0), 0);
    const netPct = totalCost > 0 ? (items.reduce((acc, p) => acc + p.total_return, 0) / totalCost) * 100 : null;
    const showNet = metric !== 'Eff';

    const renderRow = (p: PerformerItem) => {
        const v = metricValue(p, metric);
        const pct = Math.max((Math.abs(v) / maxAbs) * 100, 3);
        const positive = v >= 0;
        const clickable = !!onItemClick && p.id >= 0;
        const primary = display === '%' ? fmtPct(p.roi_pct) : fmtMetric(v, metric, baseCurrency);
        const secondary = display === '%' ? fmtCurrencySigned(p.total_return, baseCurrency) : fmtPct(p.roi_pct);
        return (
            <div
                key={`${p.group_type}-${p.id}`}
                className={`grid grid-cols-[96px_1fr_1fr_92px] items-center gap-1.5 py-1 ${clickable ? 'cursor-pointer hover:bg-slate-50' : ''}`}
                onClick={clickable ? () => onItemClick!(p) : undefined}
            >
                <div className="flex min-w-0 items-center gap-1">
                    <Tooltip content={p.label || p.name} openDelay={300}>
                        <span className="truncate text-xs font-semibold text-gray-700">{p.label || p.name}</span>
                    </Tooltip>
                    {groupBy === 'asset' && assetPanelCtx && (
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); assetPanelCtx.openAssetPanel(p.id, { pnlVersionId: versionId ?? undefined }); }}
                            className="shrink-0 text-gray-300 hover:text-blue-500"
                            title="Asset details"
                        >
                            <LuInfo size={11} />
                        </button>
                    )}
                </div>
                <div className="flex h-4 justify-end bg-slate-50">
                    {!positive && <div className="h-full bg-red-400" style={{ width: `${pct}%` }} />}
                </div>
                <div className="flex h-4 justify-start bg-slate-50">
                    {positive && <div className="h-full bg-green-400" style={{ width: `${pct}%` }} />}
                </div>
                <div className="flex flex-col items-end leading-tight">
                    <span className={`text-xs font-bold tabular-nums ${positive ? 'text-green-600' : 'text-red-600'}`}>{primary}</span>
                    <span className="text-[10px] tabular-nums text-gray-400">{secondary}</span>
                </div>
            </div>
        );
    };

    return (
        <div className="border border-slate-200 bg-white p-3">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-gray-700">Contributors</span>
                    <span className="border border-slate-200 px-1.5 text-[10px] font-semibold text-slate-500">{periodLabel}</span>
                </div>
                {showNet && !isLoading && (
                    <div className="text-right">
                        <span className="text-xs text-gray-500">Net </span>
                        <span className={`text-lg font-bold tabular-nums ${net >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {display === '%' && netPct != null && metric === 'TR' ? fmtPct(netPct) : fmtMetric(net, metric, baseCurrency)}
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
            ) : visible.length === 0 ? (
                <div className="py-6 text-center text-xs text-gray-400">No contributions in this period</div>
            ) : (
                <>
                    {showNet && metric !== 'MV' && (
                        <div className="mb-1 grid grid-cols-[96px_1fr_1fr_92px] gap-1.5 text-[10px] text-gray-400">
                            <span />
                            <span className="text-right">▼ {fmtMetric(losses, metric, baseCurrency)}</span>
                            <span>▲ {fmtMetric(gains, metric, baseCurrency)}</span>
                            <span />
                        </div>
                    )}
                    <div className="max-h-[300px] overflow-y-auto">
                        {positives.slice(0, count).map(renderRow)}
                        {negatives.length > 0 && positives.length > 0 && <div className="my-1 border-t border-dashed border-slate-200" />}
                        {negatives.slice(0, count).map(renderRow)}
                    </div>
                </>
            )}
        </div>
    );
};
