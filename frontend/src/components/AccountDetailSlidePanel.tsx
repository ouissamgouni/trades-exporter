/**
 * AccountDetailSlidePanel — Right-side slide panel for one account: sticky summary header
 * (identity, value, return, positions) + tabs (Overview / Holdings / P&L / Transactions / Health / Settings).
 * Mounted once in App.tsx; driven by AccountDetailPanelContext.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { LuChartLine, LuTriangleAlert } from 'react-icons/lu';
import { SlidePanel } from './pnl/SlidePanel';
import { useAccountDetailPanel } from '../contexts/AccountDetailPanelContext';
import { useAccounts } from '../hooks/useAccounts';
import { useEntityColors } from '../hooks/useEntityColors';
import { useLatestPnLVersion } from '../hooks/useLatestPnLVersion';
import { useFlatBalances } from '../hooks/useFlatBalances';
import {
    useBookMetrics,
    useFeeSummaryByPeriod,
    useIncomeEvents,
    useLiveMetrics,
    useVersionPerformers,
    type PerformerItem,
} from '../hooks/useChartData';
import { API_URL } from '../types';
import type { Account, TransactionStatusResponse } from '../types';
import type { PerAccountBalanceItem } from './pnl/types';
import { Badge, Button, Spinner } from './ui/primitives';
import AccountConnectors from './AccountConnectors';
import AccountFormDialog from './AccountFormDialog';
import { TransactionsTable } from './TransactionsTable';
import { defaultFilterState, type TransactionFilterState } from './TransactionFilters';
import { EntityInfoButton } from './EntityInfoButton';
import { ScopedPnLOverview } from './pnl/ScopedPnLOverview';
import { fmtCurrency, fmtCurrencySigned } from './pnl/TotalReturnScorecard';
import { TERM_HELP, InfoTip } from './pnl/pnlTerms';
import { formatQuantity } from '../utils/numberUtils';
import { formatDateTimeCompact } from '../utils/dateUtils';
import { pnlFocusPath } from '../utils/pnlFocus';

type AccountTab = 'overview' | 'holdings' | 'pnl' | 'transactions' | 'health' | 'settings';

const TABS: { id: AccountTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'holdings', label: 'Holdings' },
    { id: 'pnl', label: 'P&L details' },
    { id: 'transactions', label: 'Transactions' },
    { id: 'health', label: 'Health' },
    { id: 'settings', label: 'Settings' },
];

const toTab = (t: string | undefined): AccountTab => (TABS.some(x => x.id === t) ? (t as AccountTab) : 'overview');

const signClass = (v: number) => (v >= 0 ? 'text-green-700' : 'text-red-700');
const pctText = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);

const SubHeading: React.FC<{ children: React.ReactNode; badge?: React.ReactNode; info?: string }> = ({ children, badge, info }) => (
    <div className="mb-1.5 mt-4 flex items-center gap-1.5 border-b border-slate-100 pb-1 first:mt-0">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{children}</span>
        {info && <InfoTip text={info} size={10} />}
        {badge}
    </div>
);

const DetailRow: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
    <div className="flex gap-2 text-xs">
        <span className="w-28 shrink-0 text-slate-500">{label}</span>
        <span className="min-w-0 break-all text-slate-800">{value || '—'}</span>
    </div>
);

const Stat: React.FC<{ label: string; value: React.ReactNode; tone?: number; info?: string }> = ({ label, value, tone, info }) => (
    <div className="border-l-[3px] border-l-slate-200 bg-slate-50 px-2 py-1">
        <span className="flex items-center gap-1 text-[10px] uppercase text-slate-500">{label}{info && <InfoTip text={info} size={9} />}</span>
        <span className={`block text-sm font-semibold tabular-nums ${tone == null ? 'text-slate-800' : signClass(tone)}`}>{value}</span>
    </div>
);

const Loading = () => <div className="flex justify-center py-6"><Spinner size="sm" /></div>;
const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <p className="py-6 text-center text-xs text-slate-400">{children}</p>
);

export const AccountDetailSlidePanel: React.FC = () => {
    const { panelState, closeAccountPanel } = useAccountDetailPanel();
    const { isOpen, accountId } = panelState;
    const { accounts, isLoading, refetchAccounts } = useAccounts(isOpen);
    const account = accounts.find(a => a.id === accountId) ?? null;
    const { versionId: latestVersionId, baseCurrency } = useLatestPnLVersion(isOpen);
    const versionId = panelState.pnlVersionId ?? latestVersionId ?? null;
    const { getAccountColor } = useEntityColors();
    const navigate = useNavigate();
    const [editing, setEditing] = useState(false);
    const [tab, setTab] = useState<AccountTab>('overview');

    useEffect(() => {
        if (isOpen) setTab(toTab(panelState.initialTab));
    }, [isOpen, accountId, panelState.initialTab, panelState.openNonce]);

    const color = account ? getAccountColor(account.id, account.name, account.color) : undefined;

    const openInPnL = account && (
        <Button
            size="sm"
            variant="ghost"
            className="gap-1 text-xs"
            title="Open the P&L page scoped to this account"
            onClick={() => {
                closeAccountPanel();
                navigate(pnlFocusPath({ kind: 'account', id: account.id, name: account.name }));
            }}
        >
            <LuChartLine size={14} /> Open in P&L
        </Button>
    );

    return (
        <SlidePanel
            isOpen={isOpen}
            onClose={closeAccountPanel}
            title={account ? account.name : 'Account Details'}
            titleIcon={account ? (
                <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden className="h-3 w-3 shrink-0" style={{ backgroundColor: color }} />
                    <Badge colorScheme={account.owned ? 'green' : 'gray'}>{account.owned ? 'Owned' : 'Not owned'}</Badge>
                </span>
            ) : undefined}
            headerActions={openInPnL}
            width="1100px"
            zIndex={1500}
        >
            {isLoading && !account && <div className="flex justify-center py-10"><Spinner size="lg" /></div>}
            {!isLoading && !account && accountId != null && (
                <p className="py-10 text-center text-red-500">Account not found (ID: {accountId})</p>
            )}
            {account && (
                <div className="flex flex-col">
                    <div className="sticky -top-4 z-[2] -mx-4 -mt-4 bg-white">
                        <AccountSummaryHeader account={account} versionId={versionId} baseCurrency={baseCurrency} />
                        <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50 px-2">
                            {TABS.map(({ id, label }) => (
                                <button
                                    key={id}
                                    type="button"
                                    role="tab"
                                    aria-selected={tab === id}
                                    onClick={() => setTab(id)}
                                    className={tab === id
                                        ? '-mb-px shrink-0 border-b-2 border-blue-600 px-3 py-2 text-sm font-semibold text-blue-700'
                                        : '-mb-px shrink-0 border-b-2 border-transparent px-3 py-2 text-sm text-slate-600 hover:text-slate-900'}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="pt-3">
                        {tab === 'overview' && (versionId
                            ? <ScopedPnLOverview versionId={versionId} baseCurrency={baseCurrency} accountIds={[account.id]} contextLabel={account.name} defaultGroupBy="asset" />
                            : <Empty>No P&L calculation yet — run one to see performance.</Empty>)}
                        {tab === 'holdings' && (versionId
                            ? <AccountHoldings accountId={account.id} versionId={versionId} baseCurrency={baseCurrency} />
                            : <Empty>No P&L calculation yet.</Empty>)}
                        {tab === 'pnl' && (versionId
                            ? <AccountPnLDetails accountId={account.id} versionId={versionId} baseCurrency={baseCurrency} />
                            : <Empty>No P&L calculation yet.</Empty>)}
                        {tab === 'transactions' && <RelatedTransactions accountId={account.id} />}
                        {tab === 'health' && <AccountHealth accountId={account.id} />}
                        {tab === 'settings' && (
                            <>
                                <SubHeading>Details</SubHeading>
                                <div className="flex flex-col gap-1 p-1">
                                    <DetailRow label="Type" value={account.account_type} />
                                    <DetailRow label="Envelope" value={account.envelope} />
                                    <DetailRow label="Identifier" value={account.address_or_identifier} />
                                    <DetailRow label="Group" value={account.group} />
                                    <DetailRow label="Sync enabled" value={account.enabled ? 'Yes' : 'No'} />
                                    <div className="mt-1">
                                        <Button size="xs" variant="outline" onClick={() => setEditing(true)}>Edit account</Button>
                                    </div>
                                </div>
                                <SubHeading>Connectors & sync</SubHeading>
                                <AccountConnectors account={account} />
                            </>
                        )}
                    </div>
                </div>
            )}
            {account && editing && (
                <AccountFormDialog
                    isOpen={editing}
                    account={account}
                    onClose={() => {
                        setEditing(false);
                        refetchAccounts();
                    }}
                />
            )}
        </SlidePanel>
    );
};

/* ── Sticky summary ── */

const AccountSummaryHeader: React.FC<{ account: Account; versionId: number | null; baseCurrency: string }> = ({ account, versionId, baseCurrency }) => {
    const scope = useMemo(() => ({ accountIds: [account.id] }), [account.id]);
    const book = useBookMetrics(versionId, scope, !!versionId);
    const live = useLiveMetrics(versionId, scope, !!versionId);
    const balances = useFlatBalances(versionId);
    const rows = (balances.data ?? []).filter(b => b.account_id === account.id);
    const openCount = rows.filter(b => Math.abs(b.qty) > 0).length;
    const warnings = rows.reduce((s, b) => s + b.warning_count + b.unsettled_negative_count, 0);
    const all = live.data?.ranges?.all;
    const meta = [account.account_type, account.group, account.envelope].filter(Boolean).join(' · ');

    return (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-slate-200 px-4 py-2">
            <div className="flex min-w-0 flex-col">
                <span className="text-xs text-slate-500">{meta || '—'}</span>
                {account.address_or_identifier && (
                    <span className="max-w-[320px] truncate font-mono text-[11px] text-slate-400" title={account.address_or_identifier}>
                        {account.address_or_identifier}
                    </span>
                )}
            </div>
            {versionId && (
                <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
                    <HeaderFigure label="Value" value={all ? fmtCurrency(all.current_value, baseCurrency) : '…'} />
                    <HeaderFigure
                        label="Total return"
                        value={all ? <span className={signClass(all.total_return)}>{fmtCurrencySigned(all.total_return, baseCurrency)} <span className="text-[11px]">{pctText(all.roi_pct)}</span></span> : '…'}
                    />
                    <HeaderFigure label="Realized" value={book.data ? <span className={signClass(book.data.summary.realized_pnl)}>{fmtCurrencySigned(book.data.summary.realized_pnl, baseCurrency)}</span> : '…'} />
                    <HeaderFigure label="Open positions" value={balances.data ? openCount : '…'} />
                    {warnings > 0 && (
                        <span className="inline-flex items-center gap-1 bg-orange-100 px-1.5 py-0.5 text-[11px] font-medium text-orange-700" title="P&L warnings / unsettled negative lots on this account">
                            <LuTriangleAlert size={11} aria-hidden /> {warnings} warning{warnings === 1 ? '' : 's'}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
};

const HeaderFigure: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
    <div className="flex flex-col">
        <span className="text-[10px] uppercase text-slate-500">{label}</span>
        <span className="font-semibold tabular-nums text-slate-800">{value}</span>
    </div>
);

/* ── Holdings ── */

interface HoldingRow {
    balance: PerAccountBalanceItem;
    perf?: PerformerItem;
    marketValue: number | null;
}

const AccountHoldings: React.FC<{ accountId: number; versionId: number; baseCurrency: string }> = ({ accountId, versionId, baseCurrency }) => {
    const [showClosed, setShowClosed] = useState(false);
    const balances = useFlatBalances(versionId);
    const performers = useVersionPerformers(versionId, { accountIds: [accountId], groupBy: 'asset', topN: 500, period: 'all' });

    const perfByAsset = useMemo(() => {
        const map = new Map<number, PerformerItem>();
        for (const p of [...(performers.data?.top_performers ?? []), ...(performers.data?.flop_performers ?? [])]) map.set(p.id, p);
        return map;
    }, [performers.data]);

    const { open, closed, totalValue } = useMemo(() => {
        const rows: HoldingRow[] = (balances.data ?? [])
            .filter(b => b.account_id === accountId)
            .map(b => {
                const perf = b.asset.id != null ? perfByAsset.get(b.asset.id) : undefined;
                return { balance: b, perf, marketValue: perf ? perf.market_value : null };
            });
        const openRows = rows.filter(r => Math.abs(r.balance.qty) > 0)
            .sort((a, b) => (b.marketValue ?? b.balance.cost_basis_in_base) - (a.marketValue ?? a.balance.cost_basis_in_base));
        const closedRows = rows.filter(r => Math.abs(r.balance.qty) === 0 && (r.balance.realized_event_count > 0 || Math.abs(r.balance.realized_pnl_in_base) >= 0.01))
            .sort((a, b) => Math.abs(b.balance.realized_pnl_in_base) - Math.abs(a.balance.realized_pnl_in_base));
        const total = openRows.reduce((s, r) => s + Math.max(r.marketValue ?? 0, 0), 0);
        return { open: openRows, closed: closedRows, totalValue: total };
    }, [balances.data, perfByAsset, accountId]);

    if (balances.isLoading) return <Loading />;
    if (!open.length && !closed.length) return <Empty>No positions on this account.</Empty>;

    const rows = showClosed ? [...open, ...closed] : open;
    const sum = (f: (r: HoldingRow) => number) => open.reduce((s, r) => s + f(r), 0);

    return (
        <div className="flex flex-col gap-2">
            <AllocationBar rows={open} total={totalValue} />
            <div className="flex items-center justify-between text-xs text-slate-500">
                <span>{open.length} open · {closed.length} closed</span>
                <label className="inline-flex cursor-pointer items-center gap-1">
                    <input type="checkbox" className="accent-blue-500" checked={showClosed} onChange={e => setShowClosed(e.target.checked)} />
                    Show closed positions
                </label>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-left text-[10px] uppercase text-slate-500">
                        <tr>
                            <th className="px-1 py-1">Asset</th>
                            <th className="px-1 text-right">Qty</th>
                            <th className="px-1 text-right">Value</th>
                            <th className="px-1 text-right">Cost</th>
                            <th className="px-1 text-right">Unrealized</th>
                            <th className="px-1 text-right">Realized</th>
                            <th className="px-1 text-right">Total return</th>
                            <th className="px-1 text-right">ROI</th>
                            <th className="px-1 text-right">Weight</th>
                            <th className="px-1 text-right">Lots</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(({ balance: b, perf, marketValue }) => {
                            const isClosed = Math.abs(b.qty) === 0;
                            const weight = !isClosed && marketValue != null && totalValue > 0 ? (marketValue / totalValue) * 100 : null;
                            const warn = b.warning_count + b.unsettled_negative_count;
                            return (
                                <tr key={b.asset.id ?? b.asset.symbol} className={`border-t border-slate-100 ${isClosed ? 'text-slate-400' : ''}`}>
                                    <td className="px-1 py-1">
                                        <span className="inline-flex items-center gap-1">
                                            <span className="font-semibold">{b.asset.symbol}</span>
                                            <EntityInfoButton kind="asset" id={b.asset.id} label={b.asset.symbol} pnlVersionId={versionId} />
                                            {warn > 0 && <span title={`${warn} warning(s)`} className="text-orange-600"><LuTriangleAlert size={11} aria-label={`${warn} warnings`} /></span>}
                                        </span>
                                    </td>
                                    <td className="px-1 text-right tabular-nums">{formatQuantity(b.qty)}</td>
                                    <td className="px-1 text-right tabular-nums">{marketValue != null && !isClosed ? fmtCurrency(marketValue, baseCurrency) : '—'}</td>
                                    <td className="px-1 text-right tabular-nums">{isClosed ? '—' : fmtCurrency(b.cost_basis_in_base, baseCurrency)}</td>
                                    <td className={`px-1 text-right tabular-nums ${perf ? signClass(perf.unrealized_pnl) : ''}`}>{perf && !isClosed ? fmtCurrencySigned(perf.unrealized_pnl, baseCurrency) : '—'}</td>
                                    <td className={`px-1 text-right tabular-nums ${signClass(b.realized_pnl_in_base)}`}>{fmtCurrencySigned(b.realized_pnl_in_base, baseCurrency)}</td>
                                    <td className={`px-1 text-right tabular-nums ${perf ? signClass(perf.total_return) : ''}`}>{perf ? fmtCurrencySigned(perf.total_return, baseCurrency) : '—'}</td>
                                    <td className={`px-1 text-right tabular-nums ${perf ? signClass(perf.roi_pct) : ''}`}>{perf ? pctText(perf.roi_pct) : '—'}</td>
                                    <td className="px-1 text-right tabular-nums">{weight != null ? `${weight.toFixed(1)}%` : '—'}</td>
                                    <td className="px-1 text-right tabular-nums">{b.lot_count}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                    <tfoot className="border-t-2 border-slate-200 font-semibold">
                        <tr>
                            <td className="px-1 py-1">Open total</td>
                            <td />
                            <td className="px-1 text-right tabular-nums">{fmtCurrency(totalValue, baseCurrency)}</td>
                            <td className="px-1 text-right tabular-nums">{fmtCurrency(sum(r => r.balance.cost_basis_in_base), baseCurrency)}</td>
                            <td className={`px-1 text-right tabular-nums ${signClass(sum(r => r.perf?.unrealized_pnl ?? 0))}`}>{fmtCurrencySigned(sum(r => r.perf?.unrealized_pnl ?? 0), baseCurrency)}</td>
                            <td colSpan={5} />
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
};

const ALLOCATION_COLORS = ['bg-blue-600', 'bg-sky-500', 'bg-teal-500', 'bg-violet-500', 'bg-amber-500', 'bg-fuchsia-400', 'bg-lime-500', 'bg-slate-400'];

const AllocationBar: React.FC<{ rows: HoldingRow[]; total: number }> = ({ rows, total }) => {
    if (total <= 0) return null;
    const top = rows.filter(r => (r.marketValue ?? 0) > 0).slice(0, ALLOCATION_COLORS.length - 1);
    const rest = total - top.reduce((s, r) => s + (r.marketValue ?? 0), 0);
    const parts = [
        ...top.map((r, i) => ({ key: r.balance.asset.symbol, value: r.marketValue ?? 0, color: ALLOCATION_COLORS[i] })),
        ...(rest / total > 0.001 ? [{ key: 'Other', value: rest, color: ALLOCATION_COLORS[ALLOCATION_COLORS.length - 1] }] : []),
    ];
    return (
        <div>
            <div className="flex h-3 w-full overflow-hidden" role="img" aria-label="Allocation by asset">
                {parts.map(p => <div key={p.key} className={p.color} style={{ width: `${(p.value / total) * 100}%` }} title={`${p.key}: ${((p.value / total) * 100).toFixed(1)}%`} />)}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-600">
                {parts.map(p => (
                    <span key={p.key} className="inline-flex items-center gap-1">
                        <span aria-hidden className={`h-2 w-2 ${p.color}`} />{p.key} {((p.value / total) * 100).toFixed(1)}%
                    </span>
                ))}
            </div>
        </div>
    );
};

/* ── P&L details: flows, tax, realized by asset, income, fees, warnings ── */

const AccountPnLDetails: React.FC<{ accountId: number; versionId: number; baseCurrency: string }> = ({ accountId, versionId, baseCurrency }) => {
    const scope = useMemo(() => ({ accountIds: [accountId] }), [accountId]);
    const book = useBookMetrics(versionId, scope);
    const balances = useFlatBalances(versionId);
    const income = useIncomeEvents(versionId, { accountId, sortBy: 'date', order: 'desc', limit: 15, page: 1 });
    const fees = useFeeSummaryByPeriod(versionId, { ...scope, granularity: 'monthly', groupBy: 'none' });

    const rows = useMemo(() => (balances.data ?? []).filter(b => b.account_id === accountId), [balances.data, accountId]);
    const realizedRows = useMemo(
        () => rows.filter(b => b.realized_event_count > 0 || Math.abs(b.realized_pnl_in_base) >= 0.01)
            .sort((a, b) => Math.abs(b.realized_pnl_in_base) - Math.abs(a.realized_pnl_in_base)),
        [rows],
    );
    const warningRows = useMemo(() => rows.filter(b => b.warning_count + b.unsettled_negative_count > 0), [rows]);
    const feePeriods = useMemo(() => (fees.data?.periods ?? []).filter(p => p.total_fees_in_base > 0).slice(-12).reverse(), [fees.data]);
    const maxFee = Math.max(0, ...feePeriods.map(p => p.total_fees_in_base));

    const s = book.data?.summary;

    return (
        <div>
            <SubHeading>Flows, fees & tax</SubHeading>
            {book.isLoading ? <Loading /> : s ? (
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                    <Stat label="Total bought" info={TERM_HELP.totalBought} value={fmtCurrency(s.total_invested, baseCurrency)} />
                    <Stat label="Net deposits" info={TERM_HELP.netDeposits} value={fmtCurrencySigned(s.net_deposits ?? 0, baseCurrency)} />
                    <Stat label="Cost (open)" info={TERM_HELP.cost} value={fmtCurrency(s.cost_basis, baseCurrency)} />
                    <Stat label="Unfunded spend" value={fmtCurrency(s.unfunded_spend ?? 0, baseCurrency)} />
                    <Stat label="Realized" info={TERM_HELP.realized} value={fmtCurrencySigned(s.realized_pnl, baseCurrency)} tone={s.realized_pnl} />
                    <Stat label="Taxable realized" info={TERM_HELP.taxable} value={fmtCurrencySigned(s.taxable_realized_pnl, baseCurrency)} tone={s.taxable_realized_pnl} />
                    <Stat label="Deferred gain" info={TERM_HELP.deferred} value={fmtCurrencySigned(s.deferred_gain ?? 0, baseCurrency)} />
                    <Stat label="Fees" value={`${fmtCurrency(s.total_fees, baseCurrency)} · ${s.fee_entry_count}`} />
                    <Stat label="Income (net)" value={fmtCurrencySigned(s.total_income - s.total_withholding, baseCurrency)} tone={s.total_income - s.total_withholding} />
                    <Stat label="Withholding" value={fmtCurrency(s.total_withholding, baseCurrency)} />
                    <Stat label="Income events" value={s.income_event_count} />
                </div>
            ) : <Empty>No P&L data for this account.</Empty>}

            <SubHeading badge={realizedRows.length ? <Badge colorScheme="purple">{realizedRows.length}</Badge> : undefined}>Realized by asset</SubHeading>
            {balances.isLoading ? <Loading /> : realizedRows.length === 0 ? <Empty>Nothing realized yet.</Empty> : (
                <table className="w-full text-xs">
                    <thead className="text-left text-[10px] uppercase text-slate-500">
                        <tr><th className="py-1">Asset</th><th className="text-right">Disposals</th><th className="text-right">Realized</th><th className="text-right">Fees</th></tr>
                    </thead>
                    <tbody>
                        {realizedRows.map(b => (
                            <tr key={b.asset.id ?? b.asset.symbol} className="border-t border-slate-100">
                                <td className="py-1">
                                    <span className="inline-flex items-center gap-1">{b.asset.symbol}<EntityInfoButton kind="asset" id={b.asset.id} label={b.asset.symbol} pnlVersionId={versionId} /></span>
                                </td>
                                <td className="text-right tabular-nums">{b.realized_event_count}</td>
                                <td className={`text-right tabular-nums ${signClass(b.realized_pnl_in_base)}`}>{fmtCurrencySigned(b.realized_pnl_in_base, baseCurrency)}</td>
                                <td className="text-right tabular-nums">{b.total_fees_in_base != null ? fmtCurrency(b.total_fees_in_base, baseCurrency) : '—'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            <SubHeading badge={income.data?.total ? <Badge colorScheme="green">{income.data.total}</Badge> : undefined}>Income</SubHeading>
            {income.isLoading ? <Loading /> : !income.data?.items.length ? <Empty>No dividends, interest or rewards.</Empty> : (
                <table className="w-full text-xs">
                    <thead className="text-left text-[10px] uppercase text-slate-500">
                        <tr><th className="py-1">Date</th><th>Type</th><th>Asset</th><th className="text-right">Gross</th><th className="text-right">Withheld</th><th className="text-right">Net</th></tr>
                    </thead>
                    <tbody>
                        {income.data.items.map(ev => (
                            <tr key={ev.id} className="border-t border-slate-100">
                                <td className="py-1 tabular-nums">{ev.income_at ? formatDateTimeCompact(ev.income_at) : '—'}</td>
                                <td>{ev.income_type}</td>
                                <td>
                                    <span className="inline-flex items-center gap-1">
                                        {(ev.attributed_asset ?? ev.asset).symbol}
                                        <EntityInfoButton kind="asset" id={(ev.attributed_asset ?? ev.asset).id} label={(ev.attributed_asset ?? ev.asset).symbol} pnlVersionId={versionId} />
                                    </span>
                                </td>
                                <td className="text-right tabular-nums">{fmtCurrency(ev.gross_amount_in_base, baseCurrency)}</td>
                                <td className="text-right tabular-nums">{fmtCurrency(ev.withholding_amount_in_base, baseCurrency)}</td>
                                <td className="text-right tabular-nums text-teal-700">{fmtCurrency(ev.net_amount_in_base, baseCurrency)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {(income.data?.total ?? 0) > (income.data?.items.length ?? 0) && (
                <p className="mt-1 text-[11px] text-slate-400">Showing the latest {income.data!.items.length} of {income.data!.total}.</p>
            )}

            <SubHeading>Fees by month</SubHeading>
            {fees.isLoading ? <Loading /> : feePeriods.length === 0 ? <Empty>No fees.</Empty> : (
                <div className="flex flex-col gap-0.5">
                    {feePeriods.map(p => (
                        <div key={p.period} className="flex items-center gap-2 text-xs">
                            <span className="w-16 shrink-0 tabular-nums text-slate-500">{p.period.slice(0, 7)}</span>
                            <div className="h-2.5 flex-1 bg-slate-100">
                                <div className="h-full bg-orange-400" style={{ width: `${maxFee > 0 ? (p.total_fees_in_base / maxFee) * 100 : 0}%` }} />
                            </div>
                            <span className="w-24 shrink-0 text-right tabular-nums text-orange-700">{fmtCurrency(p.total_fees_in_base, baseCurrency)}</span>
                            <span className="w-10 shrink-0 text-right tabular-nums text-slate-400">{p.count}</span>
                        </div>
                    ))}
                </div>
            )}

            {warningRows.length > 0 && (
                <>
                    <SubHeading badge={<Badge colorScheme="orange">{warningRows.length}</Badge>}>Warnings</SubHeading>
                    <ul className="flex flex-col gap-0.5 text-xs">
                        {warningRows.map(b => (
                            <li key={b.asset.id ?? b.asset.symbol} className="flex items-center gap-2">
                                <LuTriangleAlert size={11} className="text-orange-600" aria-hidden />
                                <span className="inline-flex items-center gap-1 font-semibold">{b.asset.symbol}<EntityInfoButton kind="asset" id={b.asset.id} label={b.asset.symbol} pnlVersionId={versionId} /></span>
                                <span className="text-slate-500">
                                    {b.warning_count > 0 && `${b.warning_count} warning${b.warning_count === 1 ? '' : 's'}`}
                                    {b.warning_count > 0 && b.unsettled_negative_count > 0 && ' · '}
                                    {b.unsettled_negative_count > 0 && `${b.unsettled_negative_count} unsettled negative lot${b.unsettled_negative_count === 1 ? '' : 's'}`}
                                </span>
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </div>
    );
};

/* ── Health ── */

const AccountHealth: React.FC<{ accountId: number }> = ({ accountId }) => {
    const { data, isLoading } = useQuery<TransactionStatusResponse>({
        queryKey: ['account-health', accountId],
        queryFn: async () => {
            const res = await fetch(`${API_URL}/transactions/data-health-check/status?account_ids=${accountId}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
    });
    if (isLoading || !data) return <Loading />;
    const rows: [string, number][] = [
        ['Pending review', data.pending_count],
        ['Missing data', data.missing_data_issues_count],
        ['Unlinked', data.linkage_issues_count],
        ['Transfer issues', data.transfer_issues_count],
        ['Possible duplicates', data.duplicate_count],
    ];
    return (
        <div className="flex max-w-md flex-col gap-1 p-1 text-xs">
            <span className="text-slate-500">{data.total_count} transactions ({data.valid_count} valid)</span>
            {rows.map(([label, count]) => (
                <div key={label} className="flex justify-between">
                    <span className="text-slate-600">{label}</span>
                    <span className={count > 0 ? 'font-semibold text-orange-700' : 'text-slate-400'}>{count}</span>
                </div>
            ))}
        </div>
    );
};

/* ── Transactions (any side of the account) ── */

const RelatedTransactions: React.FC<{ accountId: number }> = ({ accountId }) => {
    const baseFilters = useMemo<TransactionFilterState>(
        () => ({ ...defaultFilterState, relatedAccountIds: [String(accountId)] }),
        [accountId],
    );
    const [filters, setFilters] = useState<TransactionFilterState>(baseFilters);
    useEffect(() => { setFilters(baseFilters); }, [baseFilters]);
    return (
        <TransactionsTable
            filters={filters}
            onFiltersChange={setFilters}
            resetFilters={baseFilters}
            title=""
            subtitle=""
            compact
            showSuggestions
            pinDateColumn
            tableId={`account-detail-txns-${accountId}`}
        />
    );
};

export default AccountDetailSlidePanel;
