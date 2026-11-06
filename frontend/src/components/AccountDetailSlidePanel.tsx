import React, { useMemo, useState } from 'react';
import { FiChevronDown, FiChevronRight } from 'react-icons/fi';
import { useQuery } from '@tanstack/react-query';
import { SlidePanel } from './pnl/SlidePanel';
import { useAccountDetailPanel } from '../contexts/AccountDetailPanelContext';
import { useAccounts } from '../hooks/useAccounts';
import { useLatestPnLVersion } from '../hooks/useLatestPnLVersion';
import { useVersionMetrics } from '../hooks/useChartData';
import { API_URL } from '../types';
import type { TransactionStatusResponse } from '../types';
import type { PerAccountBalanceItem } from './pnl/types';
import { Badge, Button, Spinner } from './ui/primitives';
import AccountConnectors from './AccountConnectors';
import AccountFormDialog from './AccountFormDialog';
import { TransactionsTable } from './TransactionsTable';
import { defaultFilterState, type TransactionFilterState } from './TransactionFilters';
import { EntityInfoButton } from './EntityInfoButton';
import { fmtCurrency, fmtCurrencySigned } from './pnl/TotalReturnScorecard';
import { formatQuantity } from '../utils/numberUtils';

const SECTION_COLORS: Record<string, { bg: string; hoverBg: string; text: string }> = {
    blue: { bg: 'bg-blue-100', hoverBg: 'hover:bg-blue-200', text: 'text-blue-700' },
    teal: { bg: 'bg-teal-100', hoverBg: 'hover:bg-teal-200', text: 'text-teal-700' },
    cyan: { bg: 'bg-cyan-100', hoverBg: 'hover:bg-cyan-200', text: 'text-cyan-700' },
    green: { bg: 'bg-green-100', hoverBg: 'hover:bg-green-200', text: 'text-green-700' },
    orange: { bg: 'bg-orange-100', hoverBg: 'hover:bg-orange-200', text: 'text-orange-700' },
    purple: { bg: 'bg-purple-100', hoverBg: 'hover:bg-purple-200', text: 'text-purple-700' },
};

const Section: React.FC<{
    title: string;
    icon: string;
    colorScheme: keyof typeof SECTION_COLORS;
    defaultOpen?: boolean;
    badge?: React.ReactNode;
    children: React.ReactNode;
}> = ({ title, icon, colorScheme, defaultOpen = true, badge, children }) => {
    const [isOpen, setIsOpen] = useState(defaultOpen);
    const colors = SECTION_COLORS[colorScheme];
    return (
        <div className="mb-2">
            <button
                type="button"
                aria-expanded={isOpen}
                className={`flex w-full items-center gap-1 px-2 py-1.5 text-left ${colors.bg} ${colors.hoverBg}`}
                onClick={() => setIsOpen(o => !o)}
            >
                {isOpen ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                <span className={`text-[11px] font-bold uppercase ${colors.text}`}>{icon} {title}</span>
                {badge}
            </button>
            {isOpen && <div className="px-1 py-1">{children}</div>}
        </div>
    );
};

const DetailRow: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
    <div className="flex gap-2 text-xs">
        <span className="w-28 shrink-0 text-slate-500">{label}</span>
        <span className="min-w-0 break-all text-slate-800">{value || '—'}</span>
    </div>
);

/** Mounted once in App.tsx; driven by AccountDetailPanelContext. */
export const AccountDetailSlidePanel: React.FC = () => {
    const { panelState, closeAccountPanel } = useAccountDetailPanel();
    const { isOpen, accountId } = panelState;
    const { accounts, isLoading, refetchAccounts } = useAccounts(isOpen);
    const account = accounts.find(a => a.id === accountId) ?? null;
    const [editing, setEditing] = useState(false);

    return (
        <SlidePanel
            isOpen={isOpen}
            onClose={closeAccountPanel}
            title={account ? account.name : 'Account Details'}
            titleIcon={account ? (
                <Badge colorScheme={account.owned ? 'green' : 'gray'}>{account.owned ? 'Owned' : 'Not owned'}</Badge>
            ) : undefined}
            width="1050px"
            zIndex={1500}
        >
            {isLoading && !account && (
                <div className="flex justify-center py-10"><Spinner size="lg" /></div>
            )}
            {!isLoading && !account && accountId != null && (
                <p className="py-10 text-center text-red-500">Account not found (ID: {accountId})</p>
            )}
            {account && (
                <div className="flex flex-col">
                    <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                            <Section title="Details" icon="📋" colorScheme="blue">
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
                            </Section>
                        </div>
                        <div className="min-w-0 flex-1">
                            <Section title="Data Health" icon="🩺" colorScheme="orange">
                                <AccountHealth accountId={account.id} />
                            </Section>
                        </div>
                    </div>
                    <Section title="Connectors & Sync" icon="🔌" colorScheme="purple" defaultOpen={false}>
                        <AccountConnectors account={account} />
                    </Section>
                    <AccountPnLSections accountId={account.id} pnlVersionId={panelState.pnlVersionId} />
                    <Section title="Related Transactions" icon="📝" colorScheme="cyan" defaultOpen={false}>
                        <RelatedTransactions accountId={account.id} />
                    </Section>
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

const AccountHealth: React.FC<{ accountId: number }> = ({ accountId }) => {
    const { data, isLoading } = useQuery<TransactionStatusResponse>({
        queryKey: ['account-health', accountId],
        queryFn: async () => {
            const res = await fetch(`${API_URL}/transactions/data-health-check/status?account_ids=${accountId}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
    });
    if (isLoading || !data) return <div className="flex justify-center py-3"><Spinner size="sm" /></div>;
    const rows: [string, number][] = [
        ['Pending review', data.pending_count],
        ['Missing data', data.missing_data_issues_count],
        ['Unlinked', data.linkage_issues_count],
        ['Transfer issues', data.transfer_issues_count],
        ['Possible duplicates', data.duplicate_count],
    ];
    return (
        <div className="flex flex-col gap-1 p-1 text-xs">
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

const AccountPnLSections: React.FC<{ accountId: number; pnlVersionId: number | null }> = ({ accountId, pnlVersionId }) => {
    const { versionId: latestVersionId, baseCurrency, isLoading } = useLatestPnLVersion();
    const versionId = pnlVersionId ?? latestVersionId;
    const metrics = useVersionMetrics(versionId, { accountIds: [accountId] }, !!versionId);
    const balances = useQuery<PerAccountBalanceItem[]>({
        queryKey: ['account-balances-account', versionId, accountId],
        queryFn: async ({ signal }) => {
            const params = new URLSearchParams({ group_by_asset: 'false', include_unsettled_negative: 'true' });
            const res = await fetch(`${API_URL}/pnl/versions/${versionId}/balances?${params}`, { signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        enabled: !!versionId,
        staleTime: 5 * 60_000,
    });
    const holdings = useMemo(
        () => (balances.data ?? []).filter(b => b.account_id === accountId && Math.abs(b.qty) > 0)
            .sort((a, b) => b.cost_basis_in_base - a.cost_basis_in_base),
        [balances.data, accountId],
    );

    if (isLoading && !pnlVersionId) return null;
    if (!versionId) return null;
    const range = metrics.data?.ranges?.all;
    const fromPnl = pnlVersionId != null;

    return (
        <>
            <Section title="PnL Overview" icon="📊" colorScheme="green" defaultOpen={fromPnl}>
                {metrics.isLoading ? (
                    <div className="flex justify-center py-3"><Spinner size="sm" /></div>
                ) : range ? (
                    <div className="grid grid-cols-2 gap-2 p-1 text-xs md:grid-cols-5">
                        <Metric label="Value" value={fmtCurrency(range.current_value, baseCurrency)} />
                        <Metric label="Cost basis" value={fmtCurrency(range.cost_basis, baseCurrency)} />
                        <Metric label="Unrealized" value={fmtCurrencySigned(range.unrealized_pnl, baseCurrency)} tone={range.unrealized_pnl} />
                        <Metric label="Realized" value={fmtCurrencySigned(range.realized_pnl, baseCurrency)} tone={range.realized_pnl} />
                        <Metric label="Total return" value={fmtCurrencySigned(range.total_return, baseCurrency)} tone={range.total_return} />
                    </div>
                ) : (
                    <p className="py-3 text-center text-xs text-slate-400">No PnL data for this account.</p>
                )}
            </Section>
            <Section
                title="Holdings"
                icon="💼"
                colorScheme="teal"
                defaultOpen={fromPnl}
                badge={holdings.length > 0 ? <Badge colorScheme="blue" className="ml-1">{holdings.length}</Badge> : undefined}
            >
                {balances.isLoading ? (
                    <div className="flex justify-center py-3"><Spinner size="sm" /></div>
                ) : holdings.length === 0 ? (
                    <p className="py-3 text-center text-xs text-slate-400">No open positions.</p>
                ) : (
                    <table className="w-full text-xs">
                        <thead className="text-left text-[10px] uppercase text-slate-500">
                            <tr><th className="py-1">Asset</th><th className="text-right">Qty</th><th className="text-right">Cost basis</th><th className="text-right">Realized</th></tr>
                        </thead>
                        <tbody>
                            {holdings.map(h => (
                                <tr key={h.asset.id ?? h.asset.symbol} className="border-t border-slate-100">
                                    <td className="py-1">
                                        <span className="inline-flex items-center gap-1">
                                            {h.asset.symbol}
                                            <EntityInfoButton kind="asset" id={h.asset.id} label={h.asset.symbol} pnlVersionId={versionId ?? undefined} />
                                        </span>
                                    </td>
                                    <td className="text-right tabular-nums">{formatQuantity(h.qty)}</td>
                                    <td className="text-right tabular-nums">{fmtCurrency(h.cost_basis_in_base, baseCurrency)}</td>
                                    <td className={`text-right tabular-nums ${h.realized_pnl_in_base >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                                        {fmtCurrencySigned(h.realized_pnl_in_base, baseCurrency)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </Section>
        </>
    );
};

const Metric: React.FC<{ label: string; value: string; tone?: number }> = ({ label, value, tone }) => (
    <div className="border-l-[3px] border-l-slate-200 bg-slate-50 px-2 py-1">
        <span className="block text-[10px] uppercase text-slate-500">{label}</span>
        <span className={`block font-semibold tabular-nums ${tone == null ? 'text-slate-800' : tone >= 0 ? 'text-green-700' : 'text-red-700'}`}>{value}</span>
    </div>
);

const RelatedTransactions: React.FC<{ accountId: number }> = ({ accountId }) => {
    const baseFilters = useMemo<TransactionFilterState>(
        () => ({ ...defaultFilterState, relatedAccountIds: [String(accountId)] }),
        [accountId],
    );
    const [filters, setFilters] = useState<TransactionFilterState>(baseFilters);
    return (
        <TransactionsTable
            filters={filters}
            onFiltersChange={setFilters}
            resetFilters={baseFilters}
            compact
            embeddedMode
            showFilters={false}
            showBundles={false}
            hideLegend
            tableId={`account-detail-txns-${accountId}`}
        />
    );
};

export default AccountDetailSlidePanel;
