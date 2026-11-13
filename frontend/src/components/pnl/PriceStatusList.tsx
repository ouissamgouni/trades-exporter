import React, { useMemo, useState } from 'react';
import { Badge, Button, Input, Spinner, type BadgeColorScheme } from '../ui/primitives';
import { FiCheckCircle, FiAlertCircle, FiAlertTriangle, FiSearch, FiDatabase, FiRefreshCw, FiChevronDown, FiEdit2, FiClock, FiMinusCircle, FiXCircle, FiArrowDown, FiArrowUp } from 'react-icons/fi';
import { PriceResponse, PriceState } from '../../types';
import { formatRelativeTime, formatDateTimeLocale } from '../../utils/dateUtils';
import { Tooltip } from '../ui/tooltip';
import { PriceSetterDialog } from './PriceSetterDialog';
import { GapFixPanel } from '../GapFixPanel';
import { AssetNameCell } from './AssetNameCell';
import { PRICE_STATE_LABELS, effectiveDate, effectivePrice, effectiveSource, resolvePriceState } from './priceState';

export interface AssetGapInfo {
    gap_count: number;
    total_missing_days: number;
}

interface PriceStatusListProps {
    prices: PriceResponse[];
    baseCurrency: string;
    quoteAssetId?: number;
    onPriceAdded?: (assetId: number) => void;
    onRetryFailed?: () => void;
    onRefreshAll?: () => void;
    onRefreshAsset?: (assetId: number) => void;
    loadingAssetIds?: Set<number>;
    /** id → asset ref for rows that have no price response yet */
    assetRefs?: Map<number, { symbol?: string | null; label?: string | null }>;
    totalAssetCount?: number;
    naAssets?: Array<{ id: number; symbol?: string | null; label?: string | null }>;
    gapMap?: Map<number, AssetGapInfo>;
    onGapsClick?: (assetId: number) => void;
    pnlVersionId?: number;
}

type Category = 'loading' | 'live' | 'cached' | 'fallback' | 'failed' | 'na';
type GapSort = 'none' | 'desc' | 'asc';

interface Row {
    item: PriceResponse;
    state: PriceState;
    category: Category;
    isLoading: boolean;
}

const CATEGORY_ORDER: Category[] = ['loading', 'failed', 'fallback', 'cached', 'live', 'na'];

const CATEGORY_META: Record<Category, { label: string; scheme: BadgeColorScheme; ring: string }> = {
    loading: { label: 'Refreshing', scheme: 'blue', ring: 'ring-blue-400' },
    live: { label: 'Live', scheme: 'green', ring: 'ring-green-400' },
    cached: { label: 'Cached', scheme: 'gray', ring: 'ring-slate-400' },
    fallback: { label: 'Fallback / stale', scheme: 'orange', ring: 'ring-orange-400' },
    failed: { label: 'No price', scheme: 'red', ring: 'ring-red-400' },
    na: { label: 'Not priced', scheme: 'gray', ring: 'ring-slate-400' },
};

const STATE_STYLE: Record<PriceState, { icon: React.ComponentType<{ size?: number }>; color: string; bg: string; hint: string }> = {
    live: { icon: FiCheckCircle, color: 'text-green-500', bg: 'hover:bg-gray-50', hint: 'Fresh price fetched live' },
    cached: { icon: FiClock, color: 'text-slate-500', bg: 'hover:bg-gray-50', hint: 'Stored price, not refreshed live yet' },
    fallback: { icon: FiAlertTriangle, color: 'text-orange-500', bg: 'bg-orange-50 hover:bg-orange-100', hint: 'Priced from a fallback source' },
    stale: { icon: FiAlertTriangle, color: 'text-orange-500', bg: 'bg-orange-50 hover:bg-orange-100', hint: 'Last known price is stale' },
    failed_with_last_known: { icon: FiAlertTriangle, color: 'text-orange-600', bg: 'bg-orange-50 hover:bg-orange-100', hint: 'Live fetch failed — using last known price' },
    failed: { icon: FiXCircle, color: 'text-red-500', bg: 'bg-red-50 hover:bg-red-100', hint: 'Price fetch failed, no price available' },
    missing: { icon: FiAlertCircle, color: 'text-red-500', bg: 'bg-red-50 hover:bg-red-100', hint: 'No price available' },
    skipped: { icon: FiMinusCircle, color: 'text-gray-400', bg: 'bg-gray-50 hover:bg-gray-100', hint: 'Not priced — no open position, or not eligible for a price fetch' },
};

const categoryOf = (state: PriceState): Category => {
    switch (state) {
        case 'live': return 'live';
        case 'cached': return 'cached';
        case 'fallback':
        case 'stale':
        case 'failed_with_last_known': return 'fallback';
        case 'skipped': return 'na';
        default: return 'failed';
    }
};

const formatCurrency = (value: number | null | undefined, currency: string): string => {
    if (value == null) return '—';
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
    }).format(value);
};

export const PriceStatusList: React.FC<PriceStatusListProps> = ({
    prices,
    baseCurrency,
    quoteAssetId,
    onPriceAdded,
    onRetryFailed,
    onRefreshAll,
    onRefreshAsset,
    loadingAssetIds,
    assetRefs,
    totalAssetCount,
    naAssets,
    gapMap,
    onGapsClick,
    pnlVersionId,
}) => {
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState<Category | 'all'>('all');
    const [gapSort, setGapSort] = useState<GapSort>('none');
    const [expandedAssetId, setExpandedAssetId] = useState<number | null>(null);
    const [dialogAsset, setDialogAsset] = useState<{ id: number; name: string } | null>(null);

    const rows: Row[] = useMemo(() => {
        const byId = new Map<number, PriceResponse>();
        for (const p of prices) if (p.asset.id != null) byId.set(p.asset.id, p);
        // Loading assets without any stored price yet get a placeholder row
        for (const id of loadingAssetIds ?? []) {
            if (!byId.has(id)) {
                const ref = assetRefs?.get(id);
                byId.set(id, { asset: { id, symbol: ref?.symbol ?? `#${id}`, label: ref?.label }, price: null, price_quote: baseCurrency, price_state: 'missing' });
            }
        }
        for (const na of naAssets ?? []) {
            if (!byId.has(na.id)) {
                byId.set(na.id, { asset: { id: na.id, symbol: na.symbol ?? `#${na.id}`, label: na.label }, price: null, price_quote: baseCurrency, skipped: true, price_state: 'skipped' });
            }
        }
        return [...byId.values()].map(item => {
            const state = resolvePriceState(item);
            const isLoading = loadingAssetIds?.has(item.asset.id!) ?? false;
            return { item, state, isLoading, category: isLoading ? 'loading' : categoryOf(state) };
        });
    }, [prices, loadingAssetIds, assetRefs, naAssets, baseCurrency]);

    const counts = useMemo(() => {
        const c: Record<Category, number> = { loading: 0, live: 0, cached: 0, fallback: 0, failed: 0, na: 0 };
        for (const r of rows) c[r.category] += 1;
        return c;
    }, [rows]);

    const missingDays = (id: number | null | undefined) => (id != null ? gapMap?.get(id)?.total_missing_days ?? 0 : 0);

    const displayed = useMemo(() => {
        const q = search.trim().toLowerCase();
        const nameOf = (r: Row) => (r.item.asset.label || r.item.asset.symbol || '').toLowerCase();
        return rows
            .filter(r => filter === 'all' || r.category === filter)
            .filter(r => !q
                || nameOf(r).includes(q)
                || (r.item.asset.symbol ?? '').toLowerCase().includes(q)
                || String(r.item.asset.id) === q
                || (effectiveSource(r.item) ?? '').toLowerCase().includes(q))
            .sort((a, b) => {
                if (gapSort !== 'none') {
                    const diff = missingDays(a.item.asset.id) - missingDays(b.item.asset.id);
                    if (diff !== 0) return gapSort === 'desc' ? -diff : diff;
                }
                const ca = CATEGORY_ORDER.indexOf(a.category);
                const cb = CATEGORY_ORDER.indexOf(b.category);
                if (ca !== cb) return ca - cb;
                return nameOf(a).localeCompare(nameOf(b));
            });
    }, [rows, filter, search, gapSort, gapMap]); // eslint-disable-line react-hooks/exhaustive-deps

    const pricedTotal = rows.length - counts.na;
    const skippedCount = totalAssetCount != null ? Math.max(totalAssetCount - rows.length, 0) : 0;
    const failedOrFallback = counts.failed + rows.filter(r => r.category !== 'loading' && r.state === 'failed_with_last_known').length;

    const cycleGapSort = () => setGapSort(s => (s === 'none' ? 'desc' : s === 'desc' ? 'asc' : 'none'));

    return (
        <div className="flex h-full flex-col">
            <div className="border-b border-gray-100 bg-gray-50 p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                    {CATEGORY_ORDER.filter(c => counts[c] > 0 || c === 'live').map(c => (
                        <Badge
                            key={c}
                            colorScheme={CATEGORY_META[c].scheme}
                            className={`cursor-pointer ${filter === c ? `ring-2 ${CATEGORY_META[c].ring}` : ''}`}
                            onClick={() => setFilter(prev => (prev === c ? 'all' : c))}
                        >
                            {c === 'loading' && <Spinner size="xs" className="mr-1" />}
                            {counts[c]} {CATEGORY_META[c].label}
                        </Badge>
                    ))}
                    {skippedCount > 0 && <span className="text-xs text-gray-400" title="Assets without an id cannot be listed">{skippedCount} unlisted</span>}
                    <div className="ml-auto flex items-center gap-2">
                        {failedOrFallback > 0 && onRetryFailed && (
                            <Button size="sm" variant="outline" colorScheme="gray" onClick={onRetryFailed} disabled={counts.loading > 0} className="h-7 px-2 text-xs">
                                <FiRefreshCw size={12} />
                                <span className="ml-1">Retry failed ({failedOrFallback})</span>
                            </Button>
                        )}
                        {onRefreshAll && (
                            <Button size="sm" colorScheme="blue" onClick={onRefreshAll} disabled={counts.loading > 0} className="h-7 px-2 text-xs">
                                {counts.loading > 0 ? <Spinner size="xs" /> : <FiRefreshCw size={12} />}
                                <span className="ml-1">Refresh all live</span>
                            </Button>
                        )}
                    </div>
                </div>
                {counts.loading > 0 && (
                    <div className="mb-3 border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                        Refreshing {counts.loading} of {pricedTotal} price{pricedTotal !== 1 ? 's' : ''} live. Stored prices are shown and used for P&L until each refresh completes.
                    </div>
                )}
                <div className="relative">
                    <Input
                        placeholder="Search by name, symbol or source…"
                        aria-label="Search assets"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="bg-white pl-8"
                    />
                    <div className="absolute left-2.5 top-2.5 text-gray-400">
                        <FiSearch size={14} />
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                {displayed.length === 0 ? (
                    <div className="flex h-[200px] flex-col items-center justify-center text-gray-400">
                        <FiDatabase size={32} />
                        <div className="mt-2">{filter !== 'all' ? `No ${CATEGORY_META[filter].label.toLowerCase()} assets` : 'No price data available'}</div>
                    </div>
                ) : (
                    <table className="w-full text-xs">
                        <thead className="sticky top-0 z-[1] bg-white text-left text-gray-500">
                            <tr className="border-b border-gray-100">
                                <th className="w-[28px] py-2 pl-3"></th>
                                <th className="py-2">Asset</th>
                                <th className="py-2">Price</th>
                                <th className="py-2">Status</th>
                                <th className="py-2">
                                    <button type="button" onClick={cycleGapSort} className="inline-flex items-center gap-1 hover:text-blue-600" aria-label="Sort by missing price days">
                                        Gaps
                                        {gapSort === 'desc' && <FiArrowDown size={11} />}
                                        {gapSort === 'asc' && <FiArrowUp size={11} />}
                                    </button>
                                </th>
                                <th className="w-[84px] py-2 pr-3"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {displayed.map(({ item, state, isLoading }) => {
                                const id = item.asset.id!;
                                const style = STATE_STYLE[state];
                                const Icon = style.icon;
                                const price = effectivePrice(item);
                                const source = effectiveSource(item);
                                const asOf = effectiveDate(item);
                                const gaps = gapMap?.get(id);
                                const isExpanded = expandedAssetId === id;
                                const isNa = state === 'skipped';
                                const name = item.asset.label || item.asset.symbol || `#${id}`;
                                return (
                                    <React.Fragment key={id}>
                                        <tr className={`border-b border-gray-50 ${isLoading ? 'bg-blue-50/40' : style.bg}`}>
                                            <td className="py-1.5 pl-3">
                                                {isLoading ? <Spinner size="xs" className="text-blue-500" /> : <span className={style.color} title={style.hint} aria-label={style.hint}><Icon size={13} /></span>}
                                            </td>
                                            <td className="max-w-[260px] py-1.5">
                                                <AssetNameCell id={id} symbol={item.asset.symbol} label={item.asset.label} pnlVersionId={pnlVersionId} />
                                            </td>
                                            <td className="py-1.5">
                                                <span className={`${state === 'live' ? 'font-semibold' : ''} ${isLoading ? 'text-gray-400' : ''}`}>
                                                    {formatCurrency(price, baseCurrency)}
                                                </span>
                                            </td>
                                            <td className="py-1.5">
                                                {isNa ? (
                                                    <span className="text-gray-500">{item.valuation_note || 'No active lots'}</span>
                                                ) : (
                                                    <div className="flex flex-wrap items-center gap-1">
                                                        <Badge colorScheme={isLoading ? 'blue' : CATEGORY_META[categoryOf(state)].scheme}>
                                                            {isLoading ? (price != null ? `${PRICE_STATE_LABELS[state]} · refreshing` : 'Fetching') : PRICE_STATE_LABELS[state]}
                                                        </Badge>
                                                        {source && <span className="max-w-[120px] truncate text-gray-600" title={source}>{source}</span>}
                                                        {asOf && (
                                                            <Tooltip content={formatDateTimeLocale(asOf)} openDelay={200}>
                                                                <span className="whitespace-nowrap text-gray-400">{formatRelativeTime(asOf)}</span>
                                                            </Tooltip>
                                                        )}
                                                        {item.error && !isLoading && (
                                                            <Tooltip content={item.error} openDelay={150}>
                                                                <span className={state === 'failed' || state === 'missing' ? 'text-red-500' : 'text-orange-500'} aria-label="Price fetch error">
                                                                    <FiAlertTriangle size={12} />
                                                                </span>
                                                            </Tooltip>
                                                        )}
                                                    </div>
                                                )}
                                            </td>
                                            <td className="py-1.5">
                                                {gaps && gaps.total_missing_days > 0 ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => onGapsClick?.(id)}
                                                        className="whitespace-nowrap text-orange-700 underline decoration-dotted hover:text-orange-800"
                                                        title={`${gaps.gap_count} gap range${gaps.gap_count !== 1 ? 's' : ''} since first transaction — open in Gaps tab`}
                                                    >
                                                        {gaps.total_missing_days} d
                                                    </button>
                                                ) : (
                                                    <span className="text-gray-300">—</span>
                                                )}
                                            </td>
                                            <td className="py-1.5 pr-3">
                                                <div className="flex items-center justify-end gap-0.5">
                                                    {onRefreshAsset && !isNa && (
                                                        <button type="button" aria-label={`Refresh ${name} live`} title="Refresh live" disabled={isLoading} onClick={() => onRefreshAsset(id)} className="p-1 text-gray-500 hover:bg-blue-50 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50">
                                                            <FiRefreshCw size={12} />
                                                        </button>
                                                    )}
                                                    {quoteAssetId && !isNa && (
                                                        <button type="button" aria-label={`Set ${name} price manually`} title="Set price manually" onClick={() => setDialogAsset({ id, name })} className="p-1 text-gray-500 hover:bg-blue-50 hover:text-blue-600">
                                                            <FiEdit2 size={12} />
                                                        </button>
                                                    )}
                                                    <button type="button" aria-label={isExpanded ? 'Collapse price history' : 'Expand price history'} title="Price history & gaps" onClick={() => setExpandedAssetId(isExpanded ? null : id)} className="p-1 text-gray-500 hover:bg-gray-100">
                                                        <span className={`inline-block transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`}><FiChevronDown size={12} /></span>
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                        {isExpanded && (
                                            <tr>
                                                <td colSpan={6} className="bg-gray-50 p-3">
                                                    <GapFixPanel assetId={id} symbol={item.asset.symbol || ''} onOpenPriceSetter={quoteAssetId ? () => setDialogAsset({ id, name }) : undefined} />
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>

            {dialogAsset && quoteAssetId && (
                <PriceSetterDialog
                    isOpen
                    onClose={() => setDialogAsset(null)}
                    onSave={() => {
                        onPriceAdded?.(dialogAsset.id);
                        setDialogAsset(null);
                    }}
                    assetId={dialogAsset.id}
                    assetName={dialogAsset.name}
                    defaultDate={new Date().toISOString()}
                    quoteAssetId={quoteAssetId}
                    quoteAssetName={baseCurrency}
                />
            )}
        </div>
    );
};
