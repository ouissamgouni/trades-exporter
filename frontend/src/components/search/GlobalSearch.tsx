import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { LuChartLine, LuList, LuLocateFixed, LuSearch, LuTriangleAlert, LuX } from 'react-icons/lu';
import { API_URL, type Account, type Asset, type Transaction } from '../../types';
import { useFlatBalances } from '../../hooks/useFlatBalances';
import { useEntityColors } from '../../hooks/useEntityColors';
import { useAssets } from '../../hooks/useAssets';
import { useAccounts } from '../../hooks/useAccounts';
import { useLatestPnLVersion } from '../../hooks/useLatestPnLVersion';
import { useVersionPerformers, type PerformerItem } from '../../hooks/useChartData';
import { useShowInAllTransactions } from '../../hooks/useShowInAllTransactions';
import { useAssetDetailPanel } from '../../contexts/AssetDetailPanelContext';
import { useAccountDetailPanel } from '../../contexts/AccountDetailPanelContext';
import { useTransactionDetailPanel } from '../../contexts/TransactionDetailPanelContext';
import { fmtCurrency, fmtCurrencySigned } from '../pnl/TotalReturnScorecard';
import { formatDateTimeCompact } from '../../utils/dateUtils';
import { formatQuantity } from '../../utils/numberUtils';
import { pnlFocusPath } from '../../utils/pnlFocus';
import { cn } from '../../lib/cn';
import { parseQuery, rankItems } from './searchUtils';

const MAX_PER_GROUP = 6;
const RECENT_KEY = 'globalSearch.recent';
const MAX_RECENT = 6;

type Kind = 'tx' | 'asset' | 'account';
interface RecentEntry { kind: Kind; id: number }

type Option =
    | { kind: 'tx'; id: number; key: string }
    | { kind: 'asset'; id: number; key: string; asset: Asset }
    | { kind: 'account'; id: number; key: string; account: Account };

const isTypingTarget = (el: EventTarget | null) =>
    el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

function readRecent(): RecentEntry[] {
    try {
        const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
        return Array.isArray(parsed) ? parsed.filter(e => e && typeof e.id === 'number' && ['tx', 'asset', 'account'].includes(e.kind)) : [];
    } catch {
        return [];
    }
}

function pushRecent(entry: RecentEntry) {
    const next = [entry, ...readRecent().filter(e => !(e.kind === entry.kind && e.id === entry.id))].slice(0, MAX_RECENT);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* storage full or disabled */ }
}

const signClass = (v: number) => (v >= 0 ? 'text-green-700' : 'text-red-700');
const pct = (v: number | null | undefined) => (v == null ? '' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);

/** Global search next to the main tabs: assets, accounts and transaction ids. Opens with / or Cmd/Ctrl+K. */
export const GlobalSearch: React.FC = () => {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const [recent, setRecent] = useState<RecentEntry[]>(readRecent);
    const inputRef = useRef<HTMLInputElement>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const listId = useId();

    const navigate = useNavigate();
    const { openAssetPanel } = useAssetDetailPanel();
    const { openAccountPanel } = useAccountDetailPanel();
    const { openTransactionPanel } = useTransactionDetailPanel();
    const showInAllTransactions = useShowInAllTransactions();

    const { assets } = useAssets(open);
    const { accounts } = useAccounts(open);
    const { versionId, baseCurrency } = useLatestPnLVersion(open);
    const assetPerf = useVersionPerformers(versionId, { groupBy: 'asset', topN: 500, period: 'all' }, open);
    const accountPerf = useVersionPerformers(versionId, { groupBy: 'account', topN: 500, period: 'all' }, open);
    const balances = useFlatBalances(versionId, open);

    const perfById = useCallback((data: typeof assetPerf.data) => {
        const map = new Map<number, PerformerItem>();
        for (const p of [...(data?.top_performers ?? []), ...(data?.flop_performers ?? [])]) map.set(p.id, p);
        return map;
    }, []);
    const assetPerfMap = useMemo(() => perfById(assetPerf.data), [assetPerf.data, perfById]);
    const accountPerfMap = useMemo(() => perfById(accountPerf.data), [accountPerf.data, perfById]);

    const balanceStats = useMemo(() => {
        const accountsPerAsset = new Map<number, Set<number>>();
        const assetsPerAccount = new Map<number, Set<number>>();
        const assetWarnings = new Map<number, number>();
        for (const b of balances.data ?? []) {
            const assetId = b.asset.id;
            if (assetId == null) continue;
            if (b.warning_count > 0 || b.unsettled_negative_count > 0) {
                assetWarnings.set(assetId, (assetWarnings.get(assetId) ?? 0) + b.warning_count + b.unsettled_negative_count);
            }
            if (Math.abs(b.qty) <= 0) continue;
            if (!accountsPerAsset.has(assetId)) accountsPerAsset.set(assetId, new Set());
            accountsPerAsset.get(assetId)!.add(b.account_id);
            if (!assetsPerAccount.has(b.account_id)) assetsPerAccount.set(b.account_id, new Set());
            assetsPerAccount.get(b.account_id)!.add(assetId);
        }
        return { accountsPerAsset, assetsPerAccount, assetWarnings };
    }, [balances.data]);

    const parsed = useMemo(() => parseQuery(query), [query]);
    const [debouncedTxId, setDebouncedTxId] = useState<number | null>(null);
    useEffect(() => {
        const t = window.setTimeout(() => setDebouncedTxId(parsed.txId), 250);
        return () => window.clearTimeout(t);
    }, [parsed.txId]);

    const txQuery = useQuery<Transaction | null>({
        queryKey: ['global-search-tx', debouncedTxId],
        queryFn: async ({ signal }) => {
            const res = await fetch(`${API_URL}/transactions/${debouncedTxId}`, { signal });
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        enabled: open && debouncedTxId != null,
        staleTime: 30_000,
    });

    const assetById = useMemo(() => new Map(assets.filter(a => a.asset_id != null).map(a => [a.asset_id!, a])), [assets]);
    const accountById = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);

    const groups = useMemo(() => {
        const txOptions: Option[] = [];
        let assetOptions: Option[] = [];
        let accountOptions: Option[] = [];
        if (!parsed.text) {
            for (const r of recent) {
                if (r.kind === 'tx') txOptions.push({ kind: 'tx', id: r.id, key: `tx-${r.id}` });
                if (r.kind === 'asset' && assetById.has(r.id)) assetOptions.push({ kind: 'asset', id: r.id, key: `asset-${r.id}`, asset: assetById.get(r.id)! });
                if (r.kind === 'account' && accountById.has(r.id)) accountOptions.push({ kind: 'account', id: r.id, key: `account-${r.id}`, account: accountById.get(r.id)! });
            }
        } else {
            if (parsed.txId != null) txOptions.push({ kind: 'tx', id: parsed.txId, key: `tx-${parsed.txId}` });
            if (parsed.scope === 'all' || parsed.scope === 'assets') {
                assetOptions = rankItems(assets.filter(a => a.asset_id != null), parsed.text, a => [a.symbol, a.label, a.isin], MAX_PER_GROUP)
                    .map(a => ({ kind: 'asset', id: a.asset_id!, key: `asset-${a.asset_id}`, asset: a }));
            }
            if (parsed.scope === 'all' || parsed.scope === 'accounts') {
                accountOptions = rankItems(accounts, parsed.text, a => [a.name, a.group, a.account_type, a.address_or_identifier], MAX_PER_GROUP)
                    .map(a => ({ kind: 'account', id: a.id, key: `account-${a.id}`, account: a }));
            }
        }
        return [
            { id: 'tx', label: parsed.text ? 'Transactions' : 'Recent transactions', options: txOptions },
            { id: 'asset', label: parsed.text ? 'Assets' : 'Recent assets', options: assetOptions },
            { id: 'account', label: parsed.text ? 'Accounts' : 'Recent accounts', options: accountOptions },
        ].filter(g => g.options.length > 0);
    }, [parsed, recent, assets, accounts, assetById, accountById]);

    const flat = useMemo(() => groups.flatMap(g => g.options), [groups]);
    useEffect(() => { setActiveIndex(0); }, [query]);

    const close = useCallback(() => {
        setOpen(false);
        setQuery('');
        inputRef.current?.blur();
    }, []);

    const remember = (entry: RecentEntry) => {
        pushRecent(entry);
        setRecent(readRecent());
    };

    const openOption = (opt: Option) => {
        remember({ kind: opt.kind, id: opt.id });
        close();
        if (opt.kind === 'tx') openTransactionPanel(opt.id);
        else if (opt.kind === 'asset') openAssetPanel(opt.id, versionId != null ? { pnlVersionId: versionId } : undefined);
        else openAccountPanel(opt.id, versionId != null ? { pnlVersionId: versionId } : undefined);
    };

    const openInPnL = (opt: Option) => {
        if (opt.kind === 'tx') return;
        remember({ kind: opt.kind, id: opt.id });
        close();
        navigate(opt.kind === 'asset'
            ? pnlFocusPath({ kind: 'asset', id: opt.id, symbol: opt.asset.symbol, label: opt.asset.label })
            : pnlFocusPath({ kind: 'account', id: opt.id, name: opt.account.name }));
    };

    const showTransactions = (opt: Option) => {
        remember({ kind: opt.kind, id: opt.id });
        close();
        if (opt.kind === 'tx') showInAllTransactions(opt.id, txQuery.data?.id === opt.id ? txQuery.data.date_time : null);
        else if (opt.kind === 'asset') openAssetPanel(opt.id, { initialTab: 'transactions' });
        else openAccountPanel(opt.id, { initialTab: 'transactions' });
    };

    // "/" (outside inputs) and Cmd/Ctrl+K focus the search from anywhere.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const isK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
            const isSlash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target);
            if (!isK && !isSlash) return;
            e.preventDefault();
            setOpen(true);
            inputRef.current?.focus();
            inputRef.current?.select();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open]);

    const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            if (query) setQuery('');
            else close();
            return;
        }
        if (!flat.length) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActiveIndex(i => (i + 1) % flat.length);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex(i => (i - 1 + flat.length) % flat.length);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const opt = flat[Math.min(activeIndex, flat.length - 1)];
            if (e.shiftKey) openInPnL(opt);
            else if (e.altKey) showTransactions(opt);
            else openOption(opt);
        }
    };

    const activeOption = open ? flat[activeIndex] : undefined;
    const optionId = (opt: Option) => `${listId}-${opt.key}`;
    const showPanel = open && (flat.length > 0 || !!parsed.text);

    return (
        <div ref={rootRef} className="relative shrink-0">
            <div className={cn(
                'flex h-8 items-center gap-1.5 border bg-white px-2 transition-[width]',
                open ? 'w-72 max-w-[70vw] border-blue-400' : 'w-36 border-slate-200 lg:w-56',
            )}>
                <LuSearch size={14} className="shrink-0 text-slate-400" aria-hidden />
                <input
                    ref={inputRef}
                    type="text"
                    role="combobox"
                    aria-label="Search assets, accounts and transaction ids"
                    aria-expanded={showPanel}
                    aria-controls={listId}
                    aria-autocomplete="list"
                    aria-activedescendant={activeOption ? optionId(activeOption) : undefined}
                    placeholder="Search…"
                    value={query}
                    onChange={e => { setQuery(e.target.value); setOpen(true); }}
                    onFocus={() => setOpen(true)}
                    onKeyDown={onInputKeyDown}
                    className="min-w-0 flex-1 bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none"
                />
                {!query && !open && (
                    <kbd className="hidden shrink-0 border border-slate-200 px-1 text-[10px] text-slate-400 lg:inline" title="Press / or ⌘K / Ctrl+K">⌘K</kbd>
                )}
                {query && (
                    <button
                        type="button"
                        aria-label="Clear search"
                        className="text-slate-400 hover:text-slate-700"
                        onClick={() => { setQuery(''); inputRef.current?.focus(); }}
                    >
                        <LuX size={14} />
                    </button>
                )}
            </div>

            {showPanel && (
                <div className="absolute right-0 top-full z-[1400] mt-1 w-[min(560px,92vw)] border border-slate-200 bg-white shadow-lg">
                    <div id={listId} role="listbox" aria-label="Search results" className="max-h-[70vh] overflow-y-auto py-1">
                        {groups.map(group => (
                            <div key={group.id} role="group" aria-labelledby={`${listId}-${group.id}`}>
                                <div id={`${listId}-${group.id}`} className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                                    {group.label}
                                </div>
                                {group.options.map(opt => {
                                    const index = flat.indexOf(opt);
                                    const active = index === activeIndex;
                                    return (
                                        <div
                                            key={opt.key}
                                            id={optionId(opt)}
                                            role="option"
                                            aria-selected={active}
                                            onMouseEnter={() => setActiveIndex(index)}
                                            onMouseDown={e => e.preventDefault()}
                                            onClick={() => openOption(opt)}
                                            className={cn('group flex cursor-pointer items-center gap-2 px-3 py-1.5', active ? 'bg-blue-50' : 'hover:bg-slate-50')}
                                        >
                                            {opt.kind === 'tx' && <TxRow txId={opt.id} tx={txQuery.data?.id === opt.id ? txQuery.data : undefined} loading={parsed.txId === opt.id && (debouncedTxId !== opt.id || txQuery.isLoading)} notFound={debouncedTxId === opt.id && !txQuery.isLoading && txQuery.data === null} accountById={accountById} />}
                                            {opt.kind === 'asset' && (
                                                <AssetRow
                                                    asset={opt.asset}
                                                    perf={assetPerfMap.get(opt.id)}
                                                    accountCount={balanceStats.accountsPerAsset.get(opt.id)?.size}
                                                    warnings={balanceStats.assetWarnings.get(opt.id)}
                                                    baseCurrency={baseCurrency}
                                                />
                                            )}
                                            {opt.kind === 'account' && (
                                                <AccountRow
                                                    account={opt.account}
                                                    perf={accountPerfMap.get(opt.id)}
                                                    assetCount={balanceStats.assetsPerAccount.get(opt.id)?.size}
                                                    baseCurrency={baseCurrency}
                                                />
                                            )}
                                            <div className={cn('flex shrink-0 items-center gap-0.5', active ? 'visible' : 'invisible group-hover:visible')}>
                                                {opt.kind !== 'tx' && (
                                                    <RowAction label="Open in P&L (Shift+Enter)" onClick={() => openInPnL(opt)}><LuChartLine size={13} /></RowAction>
                                                )}
                                                <RowAction
                                                    label={opt.kind === 'tx' ? 'Show in context (Alt+Enter)' : 'Show transactions (Alt+Enter)'}
                                                    onClick={() => showTransactions(opt)}
                                                >
                                                    {opt.kind === 'tx' ? <LuLocateFixed size={13} /> : <LuList size={13} />}
                                                </RowAction>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                        {flat.length === 0 && (
                            <p className="px-3 py-4 text-center text-xs text-slate-500">
                                No matches for “{parsed.text}”. Try a symbol, account name, address or #id.
                            </p>
                        )}
                    </div>
                    <div className="flex flex-wrap gap-x-3 border-t border-slate-100 bg-slate-50 px-3 py-1 text-[10px] text-slate-500">
                        <span>↑↓ move · Enter open · Shift+Enter P&L · Alt+Enter transactions · Esc close</span>
                        <span>Prefixes: a: acc: tx:</span>
                    </div>
                    <div role="status" aria-live="polite" className="sr-only">
                        {parsed.text ? `${flat.length} result${flat.length === 1 ? '' : 's'}` : ''}
                    </div>
                </div>
            )}
        </div>
    );
};

const RowAction: React.FC<{ label: string; onClick: () => void; children: React.ReactNode }> = ({ label, onClick, children }) => (
    <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        title={label}
        onClick={e => { e.stopPropagation(); onClick(); }}
        className="p-1 text-slate-500 hover:bg-white hover:text-blue-600"
    >
        {children}
    </button>
);

const Monogram: React.FC<{ text: string; color?: string }> = ({ text, color }) => (
    <span
        aria-hidden
        className="flex h-7 w-7 shrink-0 items-center justify-center border border-slate-200 bg-slate-100 text-[10px] font-bold text-slate-600"
        style={color ? { backgroundColor: color, color: '#fff', borderColor: color } : undefined}
    >
        {text.slice(0, 3).toUpperCase()}
    </span>
);

const ReturnCell: React.FC<{ perf?: PerformerItem; baseCurrency: string }> = ({ perf, baseCurrency }) => (
    perf ? (
        <span className="flex shrink-0 flex-col items-end text-xs tabular-nums">
            <span className="font-semibold text-slate-800">{fmtCurrency(perf.market_value, baseCurrency)}</span>
            <span className={signClass(perf.total_return)}>
                {fmtCurrencySigned(perf.total_return, baseCurrency)} {pct(perf.roi_pct)}
            </span>
        </span>
    ) : null
);

const AssetRow: React.FC<{ asset: Asset; perf?: PerformerItem; accountCount?: number; warnings?: number; baseCurrency: string }> = ({ asset, perf, accountCount, warnings, baseCurrency }) => (
    <>
        <Monogram text={asset.symbol} />
        <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-1 truncate text-sm font-semibold text-slate-800">
                {asset.symbol}
                {!!warnings && (
                    <span className="inline-flex items-center gap-0.5 bg-orange-100 px-1 text-[10px] font-medium text-orange-700" title={`${warnings} P&L warning(s)`}>
                        <LuTriangleAlert size={10} aria-hidden /> {warnings}
                    </span>
                )}
            </span>
            <span className="truncate text-xs text-slate-500">
                {asset.label || asset.price_type || ''}
                {accountCount ? ` · ${accountCount} account${accountCount === 1 ? '' : 's'}` : ''}
            </span>
        </span>
        <ReturnCell perf={perf} baseCurrency={baseCurrency} />
    </>
);

const AccountRow: React.FC<{ account: Account; perf?: PerformerItem; assetCount?: number; baseCurrency: string }> = ({ account, perf, assetCount, baseCurrency }) => {
    const { getAccountColor } = useEntityColors();
    return (
        <>
            <Monogram text={account.name} color={getAccountColor(account.id, account.name, account.color)} />
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold text-slate-800">{account.name}</span>
                <span className="truncate text-xs text-slate-500">
                    {[account.account_type, account.group].filter(Boolean).join(' · ')}
                    {assetCount ? ` · ${assetCount} asset${assetCount === 1 ? '' : 's'}` : ''}
                </span>
            </span>
            <ReturnCell perf={perf} baseCurrency={baseCurrency} />
        </>
    );
};

const TxRow: React.FC<{ txId: number; tx?: Transaction; loading: boolean; notFound: boolean; accountById: Map<number, Account> }> = ({ txId, tx, loading, notFound, accountById }) => {
    const from = tx?.from_account_id ? accountById.get(tx.from_account_id)?.name : undefined;
    const to = tx?.to_account_id ? accountById.get(tx.to_account_id)?.name : undefined;
    return (
        <>
            <Monogram text="#" />
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold text-slate-800">Transaction #{txId}</span>
                <span className="truncate text-xs text-slate-500">
                    {loading ? 'Loading…' : notFound ? 'Not found' : tx ? [
                        formatDateTimeCompact(tx.date_time),
                        tx.transaction_type,
                        `${formatQuantity(tx.quantity)} ${tx.linked_asset_symbol ?? ''}`.trim(),
                        from || to ? `${from ?? '—'} → ${to ?? '—'}` : null,
                        tx.review_status,
                    ].filter(Boolean).join(' · ') : ''}
                </span>
            </span>
        </>
    );
};

export default GlobalSearch;
