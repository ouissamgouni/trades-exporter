import React, { useEffect, useState } from 'react';
import { toaster } from './ui/toaster';
import { MappingWorkbench, WorkbenchColumn } from './mapping/MappingWorkbench';
import { RawAccountMappingPanel } from './mapping/RawAccountMappingPanel';
import { AddRawAccountDialog } from './mapping/AddRawAccountDialog';
import { StatusBadge, SuggestionChip, UsageCell } from './mapping/mappingUi';
import { formatAddress } from '../utils/addressUtils';
import {
    acceptRawAccountSuggestions,
    isVerified,
    MappingFilters,
    RawAccountRow,
    setRawAccountMapping,
    useInvalidateMappings,
    useRawAccountOverview,
} from '../utils/mappingApi';

const keyOf = (r: RawAccountRow) => String(r.id);

const RoleHint: React.FC<{ row: RawAccountRow }> = ({ row }) => {
    const parts = [
        row.account_count && `${row.account_count} account`,
        row.from_count && `${row.from_count} sent`,
        row.to_count && `${row.to_count} received`,
    ].filter(Boolean);
    return parts.length ? <span className="text-[10px] text-slate-400">{parts.join(' · ')}</span> : null;
};

export const RawAccountsEditor: React.FC = () => {
    const [filters, setFilters] = useState<MappingFilters>({ status: 'suggested' });
    const { data, isLoading, isFetching, error, refetch } = useRawAccountOverview(filters);
    const invalidate = useInvalidateMappings();
    const [selected, setSelected] = useState<RawAccountRow | null>(null);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [accepting, setAccepting] = useState(false);
    const [adding, setAdding] = useState(false);
    const [landed, setLanded] = useState(false);

    // Land on "Unmapped" when there is nothing to accept
    useEffect(() => {
        if (landed || !data) return;
        setLanded(true);
        if (filters.status === 'suggested' && data.counts.suggested === 0) setFilters({ ...filters, status: 'unmapped' });
    }, [data, landed, filters]);

    const items = data?.items ?? [];

    const advanceFrom = (row: RawAccountRow) => {
        const idx = items.findIndex((r) => r.id === row.id);
        setSelected(items[idx + 1] ?? null);
        invalidate();
    };

    const quickAccept = async (row: RawAccountRow) => {
        if (!row.suggestion) return;
        if (!isVerified(row.suggestion)) { setSelected(row); return; }
        setBusyKey(keyOf(row));
        try {
            await setRawAccountMapping(row, row.suggestion.id);
            toaster.success({ title: `Mapped to ${row.suggestion.name}` });
            invalidate();
        } catch (err) {
            toaster.error({ title: 'Mapping failed', description: err instanceof Error ? err.message : undefined });
        } finally {
            setBusyKey(null);
        }
    };

    const acceptVerified = async () => {
        setAccepting(true);
        try {
            const res = await acceptRawAccountSuggestions();
            toaster.success({
                title: `${res.applied} mapping(s) applied`,
                description: res.skipped_unverified ? `${res.skipped_unverified} fuzzy suggestion(s) left for review` : undefined,
            });
            invalidate();
        } catch (err) {
            toaster.error({ title: 'Bulk accept failed', description: err instanceof Error ? err.message : undefined });
        } finally {
            setAccepting(false);
        }
    };

    const columns: WorkbenchColumn<RawAccountRow>[] = [
        {
            key: 'label',
            header: 'Source label / address',
            className: 'w-[32%] max-w-0',
            render: (r) => (
                <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-mono text-[11px] font-semibold text-slate-800" title={r.label}>
                        {r.label.length > 24 ? formatAddress(r.label, 8, 6) : r.label}
                    </span>
                    <RoleHint row={r} />
                </div>
            ),
        },
        {
            key: 'source',
            header: 'Source',
            render: (r) => (
                <div className="flex flex-col">
                    <span className="text-[11px] text-slate-600">{r.source}</span>
                    {r.network && <span className="text-[10px] text-slate-400">{r.network}</span>}
                </div>
            ),
        },
        {
            key: 'target',
            header: 'Account',
            className: 'w-[30%]',
            render: (r) => {
                if (r.account_id != null) {
                    return (
                        <span className="text-xs">
                            <span className="font-semibold text-slate-800">{r.account_name ?? `#${r.account_id}`}</span>
                            {r.account_type && <span className="text-slate-500"> · {r.account_type}</span>}
                        </span>
                    );
                }
                if (r.status === 'ignored') return <span className="text-[11px] italic text-slate-500">{r.dismissed_reason}</span>;
                if (r.suggestion) {
                    return <SuggestionChip suggestion={r.suggestion} busy={busyKey === keyOf(r)} onAccept={() => quickAccept(r)} />;
                }
                return <span className="text-[11px] text-slate-400">No match: open to map</span>;
            },
        },
        {
            key: 'usage',
            header: <span className="block text-right">Rows</span>,
            render: (r) => <UsageCell count={r.usage_count} first={r.first_seen} last={r.last_seen} />,
        },
        {
            key: 'status',
            header: 'Status',
            render: (r) => <StatusBadge status={r.status} />,
        },
    ];

    return (
        <>
            <MappingWorkbench
                title="Account mappings"
                description="How each source account label or address resolves to one of your accounts. Address rows with a network only apply to that chain."
                overview={data}
                isLoading={isLoading}
                isFetching={isFetching}
                error={error as Error | null}
                filters={filters}
                onFiltersChange={setFilters}
                onRefresh={() => refetch()}
                columns={columns}
                rowKey={keyOf}
                selectedKey={selected ? keyOf(selected) : null}
                onRowClick={setSelected}
                rowClassName={(r) => (r.status === 'ignored' ? 'opacity-60' : '')}
                searchPlaceholder="Label, address, account or source…"
                verifiedCount={data?.verified_count ?? 0}
                onAcceptVerified={acceptVerified}
                accepting={accepting}
                onAdd={() => setAdding(true)}
            />
            <RawAccountMappingPanel
                row={selected}
                onClose={() => setSelected(null)}
                onDone={() => selected && advanceFrom(selected)}
            />
            <AddRawAccountDialog
                isOpen={adding}
                onClose={() => setAdding(false)}
                onCreated={invalidate}
                sources={data?.sources ?? []}
                networks={data?.networks ?? []}
            />
        </>
    );
};
