/**
 * AssetSummaryHeader — sticky hero at the top of the asset side panel:
 * identity + categories, current price, position (P&L vs live qty, value, P&L) and token contracts.
 */

import React, { useContext, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FiCheck, FiCopy, FiDownloadCloud, FiExternalLink, FiRefreshCw } from 'react-icons/fi';
import { API_URL, type Account, type AccountBalance, type Asset, type PriceResponse } from '../types';
import { useVersionMetrics } from '../hooks/useChartData';
import { mergeAccountLiveBalances, useLiveBalanceSnapshot, type LiveBalanceSnapshot } from '../hooks/useLiveBalanceSnapshot';
import { useAccounts } from '../hooks/useAccounts';
import { AccountDetailPanelContext } from '../contexts/AccountDetailPanelContext';
import { getAccountColor } from '../utils/accountColors';
import { DeltaBar } from './pnl/DeltaBar';
import type { AccountBalanceBreakdown } from './pnl/types';
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

const MAX_CHIPS = 6;

/** One chip per holding account: quantity, value, share and live-balance delta. */
const HoldingsByAccountChips: React.FC<{
    symbol: string;
    breakdowns: AccountBalanceBreakdown[];
    unitPrice: number | null;
    baseCurrency: string;
    live: LiveBalanceSnapshot | null;
}> = ({ symbol, breakdowns, unitPrice, baseCurrency, live }) => {
    const accountPanel = useContext(AccountDetailPanelContext);
    const { accounts } = useAccounts();
    const [showAll, setShowAll] = useState(false);
    const [fetching, setFetching] = useState(false);
    const rows = [...breakdowns].filter(b => Math.abs(b.qty) > 0).sort((a, b) => b.qty - a.qty);
    if (!rows.length) return null;
    const totalQty = rows.reduce((s, b) => s + Math.max(b.qty, 0), 0);
    const accountById = new Map<number, Account>(accounts.map(a => [a.id, a]));
    const eligible = rows.filter(b => {
        const acc = accountById.get(b.account_id);
        return acc ? acc.enabled !== false && acc.live_balance_eligible !== false : false;
    });
    const key = symbol.toUpperCase();

    const fetchLive = async () => {
        setFetching(true);
        try {
            const results = await Promise.all(eligible.map(async b => {
                try {
                    const res = await fetch(`${API_URL}/balance/account/${b.account_id}`);
                    return res.ok ? (await res.json() as AccountBalance) : null;
                } catch {
                    return null;
                }
            }));
            mergeAccountLiveBalances(results.filter((r): r is AccountBalance => r != null));
        } finally {
            setFetching(false);
        }
    };

    const visible = showAll ? rows : rows.slice(0, MAX_CHIPS);
    return (
        <div className="mt-2" data-testid="asset-holdings-chips">
            <div className="mb-1 flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wide text-slate-400">By account</span>
                {eligible.length > 0 && (
                    <button
                        type="button"
                        onClick={fetchLive}
                        disabled={fetching}
                        className="inline-flex items-center gap-1 border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                        title="Fetch live balances for these accounts from their connectors"
                    >
                        {fetching ? <Spinner size="xs" /> : <FiDownloadCloud size={11} />} Fetch live
                    </button>
                )}
                {live && <span className="text-[10px] text-slate-400">live {formatRelativeTime(new Date(live.fetchedAt))}</span>}
            </div>
            <div className="flex flex-wrap gap-1.5">
                {visible.map(b => {
                    const acc = accountById.get(b.account_id);
                    const notEligible = acc != null && (acc.enabled === false || acc.live_balance_eligible === false);
                    const fetched = live?.fetchedAccountIds.has(b.account_id) ?? false;
                    const liveQty = fetched ? (live!.byAccount.get(key)?.get(b.account_id) ?? 0) : undefined;
                    const share = totalQty > 0 && b.qty > 0 ? (b.qty / totalQty) * 100 : null;
                    return (
                        <button
                            key={b.account_id}
                            type="button"
                            onClick={() => accountPanel?.openAccountPanel(b.account_id)}
                            className="flex min-w-[150px] flex-col items-start border border-slate-200 bg-slate-50 px-2 py-1 text-left hover:border-blue-300 hover:bg-blue-50/50"
                            style={{ borderLeft: `3px solid ${getAccountColor(b.account_id)}` }}
                            title={`Open ${b.account_name}`}
                        >
                            <span className="flex w-full items-center justify-between gap-2">
                                <span className="max-w-[140px] truncate text-[11px] font-semibold text-slate-700">{b.account_name}</span>
                                {share != null && <span className="text-[10px] tabular-nums text-slate-400">{share.toFixed(0)}%</span>}
                            </span>
                            <span className="flex items-center gap-1.5 text-[11px] tabular-nums text-slate-700">
                                <span className={b.qty < 0 ? 'text-red-700' : ''}>{formatQuantity(b.qty)}</span>
                                {unitPrice != null && <span className="text-slate-500">· {fmtCurrency(b.qty * unitPrice, baseCurrency)}</span>}
                            </span>
                            <span className="mt-0.5 text-[10px] text-slate-500">
                                {notEligible ? 'No live data (not eligible)'
                                    : fetched ? <DeltaBar delta={computeDelta(b.qty, liveQty)} liveQty={liveQty} pnlQty={b.qty} size="xs" />
                                        : 'Live: not fetched'}
                            </span>
                        </button>
                    );
                })}
                {rows.length > MAX_CHIPS && (
                    <button type="button" onClick={() => setShowAll(v => !v)} className="border border-dashed border-slate-300 px-2 text-[11px] text-slate-600 hover:bg-slate-50">
                        {showAll ? 'Show less' : `+${rows.length - MAX_CHIPS} more`}
                    </button>
                )}
            </div>
        </div>
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

            {versionId != null && (
                <HoldingsByAccountChips symbol={asset.symbol} breakdowns={breakdowns} unitPrice={priceValue} baseCurrency={baseCurrency} live={live} />
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
