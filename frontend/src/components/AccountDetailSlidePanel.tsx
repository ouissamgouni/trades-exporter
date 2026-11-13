/**
 * AccountDetailSlidePanel — Right-side slide panel for one account: sticky summary header
 * (identity, value, return, positions) + tabs (Overview / Holdings / P&L audit / Transactions / Health / Settings).
 * Mounted once in App.tsx; driven by AccountDetailPanelContext.
 */
import React, { useContext, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { LuChartLine, LuTriangleAlert } from 'react-icons/lu';
import { SlidePanel } from './pnl/SlidePanel';
import { useAccountDetailPanel } from '../contexts/AccountDetailPanelContext';
import { AssetDetailPanelContext } from '../contexts/AssetDetailPanelContext';
import { useAccounts } from '../hooks/useAccounts';
import { useEntityColors } from '../hooks/useEntityColors';
import { useLatestPnLVersion } from '../hooks/useLatestPnLVersion';
import { useScopedAssetRows } from '../hooks/useScopedAssetRows';
import { useLiveBalanceSnapshot } from '../hooks/useLiveBalanceSnapshot';
import { useBookMetrics, useIncomeEvents, useLiveMetrics } from '../hooks/useChartData';
import { API_URL } from '../types';
import type { Account, TransactionStatusResponse } from '../types';
import { Badge, Button, Spinner } from './ui/primitives';
import AccountConnectors from './AccountConnectors';
import AccountFormDialog from './AccountFormDialog';
import { TransactionsTable } from './TransactionsTable';
import { defaultFilterState, type TransactionFilterState } from './TransactionFilters';
import { EntityInfoButton } from './EntityInfoButton';
import { ScopedPnLOverview } from './pnl/ScopedPnLOverview';
import { AssetsSection } from './pnl/AssetsSection';
import type { BalanceStatusFilter, PnlStatusFilter } from './pnl/AssetPnLTable';
import { sumLiveBalancesForAccounts } from './pnl/pnlCalculations';
import { AssetPnLAuditSection } from './AssetPnLAuditSection';
import { DataHealthView } from './DataHealthView';
import { fmtCurrency, fmtCurrencySigned } from './pnl/TotalReturnScorecard';
import { InfoTip } from './pnl/pnlTerms';
import { formatDateTimeCompact } from '../utils/dateUtils';
import { pnlFocusPath } from '../utils/pnlFocus';

type AccountTab = 'overview' | 'holdings' | 'audit' | 'transactions' | 'health' | 'settings';

const TABS: { id: AccountTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'holdings', label: 'Holdings' },
    { id: 'audit', label: 'P&L audit' },
    { id: 'transactions', label: 'Transactions' },
    { id: 'health', label: 'Health' },
    { id: 'settings', label: 'Settings' },
];

const TAB_ALIASES: Record<string, AccountTab> = { pnl: 'audit' };

const toTab = (t: string | undefined): AccountTab =>
    TAB_ALIASES[t ?? ''] ?? (TABS.some(x => x.id === t) ? (t as AccountTab) : 'overview');

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

const Loading = () => <div className="flex justify-center py-6"><Spinner size="sm" /></div>;
const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <p className="py-6 text-center text-xs text-slate-400">{children}</p>
);

/** Same query key as DataHealthView so the tab badge and the tab content share one request. */
function useAccountHealthStatus(accountId: number | null) {
    return useQuery<TransactionStatusResponse>({
        queryKey: ['dataHealthStatus', String(accountId ?? '')],
        queryFn: async () => {
            const res = await fetch(`${API_URL}/transactions/data-health-check/status?account_ids=${accountId}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        enabled: accountId != null,
    });
}

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
    const health = useAccountHealthStatus(isOpen ? accountId : null);
    const issues = health.data?.total_issues ?? 0;

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
                                        ? '-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 border-blue-600 px-3 py-2 text-sm font-semibold text-blue-700'
                                        : '-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm text-slate-600 hover:text-slate-900'}
                                >
                                    {label}
                                    {id === 'health' && issues > 0 && (
                                        <Badge colorScheme="orange" title={`${issues} data health issue${issues === 1 ? '' : 's'} on this account`}>{issues}</Badge>
                                    )}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="pt-3">
                        {tab === 'overview' && (versionId
                            ? <ScopedPnLOverview versionId={versionId} baseCurrency={baseCurrency} accountIds={[account.id]} contextLabel={account.name} defaultGroupBy="asset" />
                            : <Empty>No P&L calculation yet — run one to see performance.</Empty>)}
                        {tab === 'holdings' && (versionId
                            ? <AccountHoldings account={account} accounts={accounts} versionId={versionId} baseCurrency={baseCurrency} />
                            : <Empty>No P&L calculation yet.</Empty>)}
                        {tab === 'audit' && (versionId
                            ? (
                                <>
                                    <AssetPnLAuditSection accountId={account.id} versionId={versionId} />
                                    <AccountIncome accountId={account.id} versionId={versionId} baseCurrency={baseCurrency} />
                                </>
                            )
                            : <Empty>No P&L calculation yet.</Empty>)}
                        {tab === 'transactions' && <RelatedTransactions accountId={account.id} />}
                        {tab === 'health' && <DataHealthView accountIds={[account.id]} />}
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
    const { rows } = useScopedAssetRows(versionId, scope.accountIds, baseCurrency);
    const openCount = rows ? rows.filter(r => r.has_open_position ?? Math.abs(r.quantity) > 0).length : null;
    // Open P&L warnings only (same source as the P&L page); unsettled negative cash lots are not warnings
    const warnings = (rows ?? []).reduce((s, r) => s + (r.warning_count ?? 0), 0);
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
                    <HeaderFigure label="Held assets" value={openCount ?? '…'} />
                    {warnings > 0 && (
                        <span className="inline-flex items-center gap-1 bg-orange-100 px-1.5 py-0.5 text-[11px] font-medium text-orange-700" title="Open P&L warnings on this account">
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

/* ── Holdings: the P&L page's assets section, scoped to this account ── */

const AccountHoldings: React.FC<{ account: Account; accounts: Account[]; versionId: number; baseCurrency: string }> = ({ account, accounts, versionId, baseCurrency }) => {
    const accountIds = useMemo(() => [account.id], [account.id]);
    const { rows, isLoading } = useScopedAssetRows(versionId, accountIds, baseCurrency);
    const assetPanel = useContext(AssetDetailPanelContext);
    const live = useLiveBalanceSnapshot();
    const liveBalances = useMemo(
        () => (live && live.fetchedAccountIds.has(account.id) ? sumLiveBalancesForAccounts(live.byAccount, accountIds) : undefined),
        [live, account.id, accountIds],
    );

    const [search, setSearch] = useState('');
    const [minMarketValue, setMinMarketValue] = useState(0);
    const [pnlStatus, setPnlStatus] = useState<PnlStatusFilter>('with_pnl');
    const [balanceStatus, setBalanceStatus] = useState<BalanceStatusFilter>('all');
    const [categoryIds, setCategoryIds] = useState<number[]>([]);

    if (isLoading && !rows) return <Loading />;
    if (!rows?.length) return <Empty>No positions on this account.</Empty>;

    return (
        <AssetsSection
            assets={rows}
            loading={isLoading}
            baseCurrency={baseCurrency}
            onAssetClick={(id) => assetPanel?.openAssetPanel(id, { pnlVersionId: versionId })}
            accounts={accounts}
            liveBalances={liveBalances}
            search={search}
            onSearchChange={setSearch}
            minMarketValue={minMarketValue}
            onMinMarketValueChange={setMinMarketValue}
            pnlStatus={pnlStatus}
            onPnlStatusChange={setPnlStatus}
            balanceStatus={balanceStatus}
            onBalanceStatusChange={setBalanceStatus}
            selectedAccountIds={[]}
            onSelectedAccountIdsChange={() => undefined}
            selectedCategoryIds={categoryIds}
            onSelectedCategoryIdsChange={setCategoryIds}
            pnlVersionId={versionId}
            persistToUrl={false}
        />
    );
};

/* ── Income (dividends, interest, rewards) ── */

const AccountIncome: React.FC<{ accountId: number; versionId: number; baseCurrency: string }> = ({ accountId, versionId, baseCurrency }) => {
    const income = useIncomeEvents(versionId, { accountId, sortBy: 'date', order: 'desc', limit: 15, page: 1 });
    return (
        <>
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
        </>
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
