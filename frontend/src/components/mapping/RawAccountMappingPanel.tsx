import React, { useEffect, useState } from 'react';
import { LuCopy, LuEyeOff, LuPlus, LuTrash2, LuUnlink } from 'react-icons/lu';
import { SlidePanel } from '../pnl/SlidePanel';
import { AccountSelector } from '../AccountSelector';
import AccountFormDialog, { AccountPrefill } from '../AccountFormDialog';
import { TransactionsTable } from '../TransactionsTable';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Badge, Button } from '../ui/primitives';
import { toaster } from '../ui/toaster';
import { useAccounts } from '../../hooks/useAccounts';
import { useAccountDetailPanel } from '../../contexts/AccountDetailPanelContext';
import { formatDateShort } from '../../utils/dateUtils';
import { SUBPANEL, SECTION_LABEL } from '../../lib/ui';
import {
    deleteRawAccount,
    ignoreRawAccount,
    isVerified,
    rawAccountTransactionsUrl,
    RawAccountRow,
    restoreRawAccount,
    setRawAccountMapping,
} from '../../utils/mappingApi';
import { DetailRow, IgnoreForm, REASONS, StatusBadge, SuggestionChip } from './mappingUi';

const IGNORE_REASONS = ['External account, not mine', 'Third-party / counterparty', 'Service or protocol contract', 'Duplicate entry', 'Test data'];

type Role = 'all' | 'account' | 'from' | 'to';

const looksLikeAddress = (label: string) => /^0x[0-9a-fA-F]{40}$/.test(label) || (label.length >= 32 && !/\s/.test(label));

interface Props {
    row: RawAccountRow | null;
    onClose: () => void;
    onDone: () => void;
}

export const RawAccountMappingPanel: React.FC<Props> = ({ row, onClose, onDone }) => {
    const { accounts, refetchAccounts } = useAccounts();
    const { openAccountPanel } = useAccountDetailPanel();
    const [pickedId, setPickedId] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [ignoring, setIgnoring] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [creating, setCreating] = useState<AccountPrefill | null>(null);
    const [role, setRole] = useState<Role>('all');

    const rowKey = row ? `${row.id}` : '';
    useEffect(() => {
        setPickedId(null);
        setIgnoring(false);
        setRole('all');
    }, [rowKey]);

    if (!row) return null;
    const suggestion = row.suggestion;

    const run = async (action: () => Promise<unknown>, success: string) => {
        setBusy(true);
        try {
            await action();
            toaster.success({ title: success });
            onDone();
        } catch (err) {
            toaster.error({ title: 'Action failed', description: err instanceof Error ? err.message : undefined });
        } finally {
            setBusy(false);
        }
    };

    const mapTo = (accountId: number, name: string) =>
        run(() => setRawAccountMapping(row, accountId), `Mapped to ${name}`);

    const pickedName = accounts.find((a) => a.id === pickedId)?.name;

    const roleTabs: { id: Role; label: string; count: number }[] = [
        { id: 'all', label: 'All', count: row.usage_count },
        { id: 'account', label: 'As account', count: row.account_count },
        { id: 'from', label: 'As sender', count: row.from_count },
        { id: 'to', label: 'As recipient', count: row.to_count },
    ];

    return (
        <SlidePanel
            isOpen
            onClose={onClose}
            title={row.label.length > 28 ? `${row.label.slice(0, 10)}…${row.label.slice(-8)}` : row.label}
            titleIcon={<StatusBadge status={row.status} />}
            width="900px"
            zIndex={1200}
        >
            <div className="flex flex-col gap-3">
                <div className={`${SUBPANEL} flex flex-col gap-1.5 p-3`}>
                    <DetailRow label="Label">
                        <span className="inline-flex items-center gap-1 font-mono text-[11px]">
                            {row.label}
                            <button
                                type="button"
                                aria-label="Copy label"
                                className="text-slate-400 hover:text-slate-700"
                                onClick={() => { navigator.clipboard?.writeText(row.label); toaster.success({ title: 'Copied' }); }}
                            >
                                <LuCopy size={11} />
                            </button>
                        </span>
                    </DetailRow>
                    <DetailRow label="Source"><Badge colorScheme="purple">{row.source}</Badge></DetailRow>
                    <DetailRow label="Network">{row.network || <span className="text-slate-400">any (not chain-specific)</span>}</DetailRow>
                    <DetailRow label="Used in">
                        {row.usage_count.toLocaleString()} row(s): {row.account_count} as account, {row.from_count} as sender, {row.to_count} as recipient
                        {row.first_seen && ` · ${formatDateShort(row.first_seen)} → ${formatDateShort(row.last_seen)}`}
                    </DetailRow>
                </div>

                <section className="flex flex-col gap-2">
                    <span className={SECTION_LABEL}>Mapping</span>

                    {row.status === 'ignored' && (
                        <div className="flex items-center justify-between gap-2 border border-slate-200 bg-slate-50 p-2 text-xs">
                            <span className="text-slate-600">
                                Ignored{row.dismissed_reason && <>: <em>{row.dismissed_reason}</em></>}
                                {row.dismissed_at && ` (${formatDateShort(row.dismissed_at)})`}
                            </span>
                            <Button size="xs" variant="outline" disabled={busy} onClick={() => run(() => restoreRawAccount(row), 'Restored')}>
                                Restore
                            </Button>
                        </div>
                    )}

                    {row.account_id != null && (
                        <div className="flex items-center justify-between gap-2 border border-green-200 bg-green-50 p-2 text-xs">
                            <span className="text-green-900">
                                Mapped to{' '}
                                <button type="button" className="font-semibold underline-offset-2 hover:underline" onClick={() => openAccountPanel(row.account_id!)}>
                                    {row.account_name ?? `#${row.account_id}`}
                                </button>
                                {row.account_type && <span className="text-green-700"> · {row.account_type}</span>}
                            </span>
                            <Button
                                size="xs"
                                variant="outline"
                                leftIcon={<LuUnlink size={12} />}
                                disabled={busy}
                                onClick={() => run(() => setRawAccountMapping(row, null), 'Unmapped')}
                            >
                                Unmap
                            </Button>
                        </div>
                    )}

                    {suggestion && row.status === 'suggested' && (
                        <div className={`flex flex-col gap-1.5 border p-2 ${isVerified(suggestion) ? 'border-green-200 bg-white' : 'border-amber-200 bg-amber-50/40'}`}>
                            <SuggestionChip suggestion={suggestion} busy={busy} onAccept={() => mapTo(suggestion.id, suggestion.name)} />
                            <span className="text-[11px] text-slate-600">
                                {suggestion.reason ? REASONS[suggestion.reason].hint : 'Suggested match.'}
                            </span>
                        </div>
                    )}

                    <div className="flex flex-col gap-1.5">
                        <span className="text-[11px] text-slate-500">
                            {row.account_id != null ? 'Change to another account' : 'Map to an account'}
                            {row.network && ` (only ${row.network} transactions)`}
                        </span>
                        <div className="flex items-center gap-2">
                            <div className="min-w-0 flex-1">
                                <AccountSelector
                                    value={pickedId}
                                    onChange={(id) => setPickedId(id ?? null)}
                                    accounts={accounts}
                                    onAccountCreated={refetchAccounts}
                                    defaultName={row.label}
                                    rawAccountNetwork={row.network || undefined}
                                    placeholder="Search accounts…"
                                    size="sm"
                                />
                            </div>
                            <Button
                                size="xs"
                                colorScheme="blue"
                                disabled={pickedId == null || busy || pickedId === row.account_id}
                                onClick={() => pickedId != null && mapTo(pickedId, pickedName ?? `#${pickedId}`)}
                            >
                                Map
                            </Button>
                            <Button
                                size="xs"
                                variant="outline"
                                leftIcon={<LuPlus size={12} />}
                                disabled={busy}
                                onClick={() => setCreating({
                                    name: row.label,
                                    address_or_identifier: row.label,
                                    account_type: looksLikeAddress(row.label) ? 'wallet' : 'cex',
                                })}
                            >
                                New account
                            </Button>
                        </div>
                    </div>
                </section>

                <section className="flex flex-col gap-2">
                    {ignoring ? (
                        <IgnoreForm
                            reasons={IGNORE_REASONS}
                            busy={busy}
                            note="Ignored labels are hidden from the to-do tabs; their transactions stay as they are."
                            onCancel={() => setIgnoring(false)}
                            onConfirm={(reason) => run(() => ignoreRawAccount(row, reason), 'Ignored')}
                        />
                    ) : (
                        <div className="flex flex-wrap gap-2">
                            {row.status !== 'ignored' && (
                                <Button size="xs" variant="outline" leftIcon={<LuEyeOff size={12} />} disabled={busy} onClick={() => setIgnoring(true)}>
                                    Ignore
                                </Button>
                            )}
                            <Button size="xs" variant="outline" colorScheme="red" leftIcon={<LuTrash2 size={12} />} disabled={busy} onClick={() => setConfirmDelete(true)}>
                                Delete row
                            </Button>
                        </div>
                    )}
                </section>

                <section className="flex flex-col gap-1">
                    <span className={SECTION_LABEL}>Transactions</span>
                    <div role="tablist" aria-label="Role" className="flex gap-1">
                        {roleTabs.map((t) => (
                            <button
                                key={t.id}
                                type="button"
                                role="tab"
                                aria-selected={role === t.id}
                                disabled={t.count === 0}
                                onClick={() => setRole(t.id)}
                                className={`border px-2 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${role === t.id
                                    ? 'border-blue-500 bg-blue-500 text-white'
                                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                                    }`}
                            >
                                {t.label} ({t.count})
                            </button>
                        ))}
                    </div>
                    <TransactionsTable
                        key={`${rowKey}-${role}`}
                        tableId="raw-account-mapping-txns"
                        title=""
                        subtitle=""
                        compact
                        showFilters={false}
                        showBundles={false}
                        showSuggestions={false}
                        hideLegend
                        initialColumnVisibility={{ total: false, taxability: false, feeInBase: false, bundle: false }}
                        customApiUrl={rawAccountTransactionsUrl(row, role)}
                    />
                </section>
            </div>

            <ConfirmDialog
                isOpen={confirmDelete}
                onClose={() => setConfirmDelete(false)}
                onConfirm={() => run(() => deleteRawAccount(row), 'Row deleted')}
                title="Delete raw account row"
                message={`Delete "${row.label}" (${row.source})? Transactions keep their current account links.`}
                confirmLabel="Delete"
                isDestructive
            />
            <AccountFormDialog
                isOpen={creating !== null}
                account={null}
                prefill={creating ?? undefined}
                onClose={(createdId) => {
                    setCreating(null);
                    if (createdId) {
                        refetchAccounts();
                        mapTo(createdId, 'new account');
                    }
                }}
            />
        </SlidePanel>
    );
};
