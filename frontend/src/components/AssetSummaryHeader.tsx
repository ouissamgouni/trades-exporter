/**
 * AssetSummaryHeader — sticky hero at the top of the asset side panel:
 * identity + categories, current price, position (P&L vs live qty, value, P&L) and token contracts.
 */

import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FiCheck, FiCopy, FiExternalLink, FiRefreshCw } from 'react-icons/fi';
import { API_URL, type Asset, type PriceResponse } from '../types';
import { useVersionMetrics } from '../hooks/useChartData';
import { useLiveBalanceSnapshot } from '../hooks/useLiveBalanceSnapshot';
import { useAccountBalances } from './AssetPnLOverviewSection';
import { fmtCurrency, fmtCurrencySigned } from './pnl/TotalReturnScorecard';
import { computeDelta, deltaColor, formatPct } from './pnl/deltaUtils';
import { PRICE_STATE_LABELS, effectiveDate, effectivePrice, effectiveSource, resolvePriceState } from './pnl/priceState';
import { formatQuantity } from '../utils/numberUtils';
import { formatDateTimeLocale, formatRelativeTime } from '../utils/dateUtils';
import { formatAddress, formatChainName } from '../utils/addressUtils';
import { tokenExplorerUrl } from '../utils/explorers';
import { Badge, Spinner, type BadgeColorScheme } from './ui/primitives';
import type { PriceState } from '../types';

interface AssetSummaryHeaderProps {
    asset: Asset;
    versionId: number | null;
    baseCurrency: string;
}

const PRICE_SCHEME: Record<PriceState, BadgeColorScheme> = {
    live: 'green',
    cached: 'gray',
    fallback: 'orange',
    stale: 'orange',
    failed_with_last_known: 'orange',
    failed: 'red',
    missing: 'red',
    skipped: 'gray',
};

const Stat: React.FC<{ label: string; children: React.ReactNode; hint?: string }> = ({ label, children, hint }) => (
    <div className="min-w-[96px] flex-1 border-l-2 border-slate-200 px-2 py-0.5" title={hint}>
        <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
        <div className="truncate text-sm font-semibold tabular-nums text-slate-800">{children}</div>
    </div>
);

const ContractChip: React.FC<{ network: string; address: string; txCount: number }> = ({ network, address, txCount }) => {
    const [copied, setCopied] = useState(false);
    const url = tokenExplorerUrl(network, address);
    const copy = async () => {
        await navigator.clipboard.writeText(address);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
    };
    return (
        <span className="inline-flex items-center border border-slate-200 bg-slate-50 text-[11px] text-slate-700" title={`${address} · ${txCount} transaction${txCount !== 1 ? 's' : ''}`}>
            <span className="border-r border-slate-200 bg-white px-1.5 py-0.5 font-medium">{formatChainName(network) || '—'}</span>
            <span className="px-1.5 py-0.5 font-mono">{formatAddress(address)}</span>
            <button type="button" onClick={copy} aria-label={`Copy ${network} contract address`} className="px-1 py-0.5 text-slate-500 hover:bg-slate-100 hover:text-blue-600">
                {copied ? <FiCheck size={11} /> : <FiCopy size={11} />}
            </button>
            {url && (
                <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${network} contract in explorer`} className="px-1 py-0.5 text-slate-500 hover:bg-slate-100 hover:text-blue-600">
                    <FiExternalLink size={11} />
                </a>
            )}
        </span>
    );
};

export const AssetSummaryHeader: React.FC<AssetSummaryHeaderProps> = ({ asset, versionId, baseCurrency }) => {
    const assetId = asset.asset_id!;
    const queryClient = useQueryClient();
    const [refreshing, setRefreshing] = useState(false);

    const priceKey = ['asset-hero-price', assetId, baseCurrency] as const;
    const priceQuery = useQuery<PriceResponse | null>({
        queryKey: priceKey,
        queryFn: async ({ signal }) => {
            const res = await fetch(`${API_URL}/pnl/prices/cached`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ asset_ids: [assetId], base_currency: baseCurrency }),
                signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const items: PriceResponse[] = await res.json();
            return items[0] ?? null;
        },
        staleTime: 60_000,
    });

    const refreshPrice = async () => {
        setRefreshing(true);
        try {
            const res = await fetch(`${API_URL}/pnl/prices/${assetId}?base_currency=${encodeURIComponent(baseCurrency)}&force_live=true&max_timeout_seconds=10`);
            if (res.ok) queryClient.setQueryData(priceKey, await res.json());
        } finally {
            setRefreshing(false);
        }
    };

    const metrics = useVersionMetrics(versionId, { assetIds: [assetId] }, !!versionId);
    const range = metrics.data?.ranges?.all;
    const { breakdowns, isLoading: qtyLoading } = useAccountBalances(versionId, assetId);
    const pnlQty = breakdowns.length > 0 ? breakdowns.reduce((s, b) => s + b.qty, 0) : (versionId && !qtyLoading ? 0 : null);

    const live = useLiveBalanceSnapshot();
    const liveQty = live?.qtyByKey.get(asset.symbol.toUpperCase());
    const delta = pnlQty != null ? computeDelta(pnlQty, liveQty) : null;

    const price = priceQuery.data;
    const priceState = price ? resolvePriceState(price) : null;
    const priceValue = price ? effectivePrice(price) : null;
    const priceSource = price ? effectiveSource(price) : null;
    const priceAsOf = price ? effectiveDate(price) : null;
    const contracts = asset.contracts ?? [];

    return (
        <div className="border-b border-slate-200 bg-white px-3 pb-2 pt-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                        <span className="truncate text-2xl font-semibold text-slate-900">{asset.symbol}</span>
                        {asset.label && asset.label !== asset.symbol && (
                            <span className="truncate text-sm text-slate-500">{asset.label}</span>
                        )}
                        <span className="shrink-0 text-xs text-slate-400">#{assetId}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                        <Badge colorScheme={asset.status === 0 ? 'green' : 'gray'}>{asset.status === 0 ? 'Active' : 'Inactive'}</Badge>
                        {asset.price_type && <Badge colorScheme="blue">{asset.price_type}</Badge>}
                        {asset.isin && <Badge colorScheme="gray" className="font-mono">{asset.isin}</Badge>}
                        {(asset.categories ?? []).map(c => (
                            <Badge key={c.id} colorScheme="gray" title={c.dimension_label}>
                                <span className="flex items-center gap-1">
                                    {c.color && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c.color }} />}
                                    {c.label}
                                </span>
                            </Badge>
                        ))}
                    </div>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-0.5">
                    <div className="flex items-center gap-1.5">
                        <span className="text-xl font-semibold tabular-nums text-slate-900">
                            {priceQuery.isLoading ? <Spinner size="xs" /> : priceValue != null ? fmtCurrency(priceValue, baseCurrency) : '—'}
                        </span>
                        <button
                            type="button"
                            onClick={refreshPrice}
                            disabled={refreshing}
                            aria-label="Refresh price live"
                            title="Refresh price live"
                            className="p-1 text-slate-500 hover:bg-blue-50 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {refreshing ? <Spinner size="xs" /> : <FiRefreshCw size={13} />}
                        </button>
                    </div>
                    <div className="flex items-center gap-1 text-[11px] text-slate-500">
                        {priceState && <Badge colorScheme={PRICE_SCHEME[priceState]}>{PRICE_STATE_LABELS[priceState]}</Badge>}
                        {priceSource && <span className="max-w-[110px] truncate" title={priceSource}>{priceSource}</span>}
                        {priceAsOf && <span title={formatDateTimeLocale(priceAsOf)}>{formatRelativeTime(priceAsOf)}</span>}
                    </div>
                </div>
            </div>

            {versionId != null && (
                <div className="mt-2 flex flex-wrap gap-y-1">
                    <Stat label="Quantity (P&L)">{pnlQty != null ? formatQuantity(pnlQty) : <Spinner size="xs" />}</Stat>
                    <Stat
                        label="Live balance"
                        hint={live ? `From the last live balance fetch (${formatRelativeTime(new Date(live.fetchedAt))})` : 'Fetch live balances from the P&L view to compare'}
                    >
                        {liveQty != null ? (
                            <span className="flex items-baseline gap-1">
                                {formatQuantity(liveQty)}
                                {delta && !delta.matched && (
                                    <span className={`text-[11px] font-normal ${deltaColor(delta.pct)}`}>{formatPct(delta.pct)}</span>
                                )}
                            </span>
                        ) : (
                            <span className="font-normal text-slate-400">{live ? '0' : '—'}</span>
                        )}
                    </Stat>
                    <Stat label="Value">{range ? fmtCurrency(range.current_value, baseCurrency) : '—'}</Stat>
                    <Stat label="Unrealized">
                        {range ? <span className={range.unrealized_pnl >= 0 ? 'text-green-700' : 'text-red-700'}>{fmtCurrencySigned(range.unrealized_pnl, baseCurrency)}</span> : '—'}
                    </Stat>
                    <Stat label="Realized">
                        {range ? <span className={range.realized_pnl >= 0 ? 'text-green-700' : 'text-red-700'}>{fmtCurrencySigned(range.realized_pnl, baseCurrency)}</span> : '—'}
                    </Stat>
                </div>
            )}

            {contracts.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1">
                    <span className="text-[10px] uppercase tracking-wide text-slate-400">Contracts</span>
                    {contracts.map(c => (
                        <ContractChip key={`${c.network}:${c.contract_address}`} network={c.network} address={c.contract_address} txCount={c.tx_count} />
                    ))}
                </div>
            )}
        </div>
    );
};

export default AssetSummaryHeader;
