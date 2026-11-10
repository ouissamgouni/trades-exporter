import React, { useEffect, useState } from 'react';
import { toaster } from './ui/toaster';
import { MappingWorkbench, WorkbenchColumn } from './mapping/MappingWorkbench';
import { RawAssetMappingPanel } from './mapping/RawAssetMappingPanel';
import { AddRawAssetDialog } from './mapping/AddRawAssetDialog';
import { ContractChip, StatusBadge, SuggestionChip, UsageCell } from './mapping/mappingUi';
import {
    acceptRawAssetSuggestions,
    isVerified,
    MappingFilters,
    RawAssetRow,
    setRawAssetMapping,
    useInvalidateMappings,
    useRawAssetOverview,
} from '../utils/mappingApi';

const keyOf = (r: RawAssetRow) => `${r.source}|${r.symbol}|${r.network}|${r.contract_address}`;

export const RawAssetsEditor: React.FC = () => {
    const [filters, setFilters] = useState<MappingFilters>({ status: 'suggested' });
    const { data, isLoading, isFetching, error, refetch } = useRawAssetOverview(filters);
    const invalidate = useInvalidateMappings();
    const [selected, setSelected] = useState<RawAssetRow | null>(null);
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

    /** After an action: refresh and move to the next row so the list can be triaged in one pass. */
    const advanceFrom = (row: RawAssetRow) => {
        const idx = items.findIndex((r) => keyOf(r) === keyOf(row));
        setSelected(items[idx + 1] ?? null);
        invalidate();
    };

    const quickAccept = async (row: RawAssetRow) => {
        if (!row.suggestion) return;
        if (!isVerified(row.suggestion)) { setSelected(row); return; }
        setBusyKey(keyOf(row));
        try {
            await setRawAssetMapping(row, row.suggestion.id);
            toaster.success({ title: `${row.symbol} → ${row.suggestion.name}` });
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
            const res = await acceptRawAssetSuggestions();
            toaster.success({
                title: `${res.applied} mapping(s) applied`,
                description: res.skipped_unverified ? `${res.skipped_unverified} unverified suggestion(s) left for review` : undefined,
            });
            invalidate();
        } catch (err) {
            toaster.error({ title: 'Bulk accept failed', description: err instanceof Error ? err.message : undefined });
        } finally {
            setAccepting(false);
        }
    };

    const columns: WorkbenchColumn<RawAssetRow>[] = [
        {
            key: 'symbol',
            header: 'Source symbol',
            className: 'w-[32%] max-w-0',
            render: (r) => (
                <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-xs font-semibold text-slate-800" title={r.symbol}>{r.symbol}</span>
                    {r.contract_address
                        ? <ContractChip network={r.network} contract={r.contract_address} />
                        : <span className="text-[10px] text-slate-400">exchange / native</span>}
                </div>
            ),
        },
        {
            key: 'source',
            header: 'Source',
            render: (r) => <span className="text-[11px] text-slate-600">{r.source}</span>,
        },
        {
            key: 'target',
            header: 'Asset',
            className: 'w-[30%]',
            render: (r) => {
                if (r.asset_id != null) {
                    return (
                        <span className="text-xs">
                            <span className="font-semibold text-slate-800">{r.asset_symbol ?? `#${r.asset_id}`}</span>
                            {r.asset_label && r.asset_label !== r.asset_symbol && <span className="text-slate-500"> · {r.asset_label}</span>}
                        </span>
                    );
                }
                if (r.status === 'ignored') {
                    return <span className="text-[11px] italic text-slate-500">{r.dismissed_reason || 'Blocked as spam'}</span>;
                }
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
                title="Asset mappings"
                description="How each source symbol or token contract resolves to an asset. Token rows map per contract; a new contract never inherits a symbol's mapping."
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
                searchPlaceholder="Symbol, contract, asset or source…"
                verifiedCount={data?.verified_count ?? 0}
                onAcceptVerified={acceptVerified}
                accepting={accepting}
                onAdd={() => setAdding(true)}
            />
            <RawAssetMappingPanel
                row={selected}
                onClose={() => setSelected(null)}
                onDone={() => selected && advanceFrom(selected)}
            />
            <AddRawAssetDialog
                isOpen={adding}
                onClose={() => setAdding(false)}
                onCreated={invalidate}
                sources={data?.sources ?? []}
                networks={data?.networks ?? []}
            />
        </>
    );
};
