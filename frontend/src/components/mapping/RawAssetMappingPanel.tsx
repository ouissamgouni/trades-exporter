import React, { useEffect, useState } from 'react';
import { LuEyeOff, LuTrash2, LuUnlink } from 'react-icons/lu';
import { SlidePanel } from '../pnl/SlidePanel';
import { AssetSelector } from '../AssetSelector';
import { TransactionsTable } from '../TransactionsTable';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Badge, Button } from '../ui/primitives';
import { toaster } from '../ui/toaster';
import { useAssets } from '../../hooks/useAssets';
import { useAssetDetailPanel } from '../../contexts/AssetDetailPanelContext';
import { contractAssetSymbol } from '../../utils/rawAccountApi';
import { formatDateShort } from '../../utils/dateUtils';
import { SUBPANEL, SECTION_LABEL } from '../../lib/ui';
import {
    deleteRawAsset,
    ignoreRawAsset,
    isVerified,
    rawAssetTransactionsUrl,
    RawAssetRow,
    restoreRawAsset,
    setRawAssetMapping,
} from '../../utils/mappingApi';
import { ContractChip, DetailRow, IgnoreForm, REASONS, StatusBadge, SuggestionChip } from './mappingUi';

const IGNORE_REASONS = ['Spam / scam token', 'Dust or airdrop', 'Test data', 'Not relevant for tracking'];

interface Props {
    row: RawAssetRow | null;
    onClose: () => void;
    /** Called after any change; the parent refreshes and moves to the next row. */
    onDone: () => void;
}

export const RawAssetMappingPanel: React.FC<Props> = ({ row, onClose, onDone }) => {
    const { assets, refetchAssets } = useAssets();
    const { openAssetPanel } = useAssetDetailPanel();
    const [pickedId, setPickedId] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [ignoring, setIgnoring] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);

    const rowKey = row ? `${row.source}|${row.symbol}|${row.network}|${row.contract_address}` : '';
    useEffect(() => {
        setPickedId(null);
        setIgnoring(false);
    }, [rowKey]);

    if (!row) return null;
    const isToken = !!row.contract_address;
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

    const mapTo = (assetId: number, label: string) =>
        run(() => setRawAssetMapping(row, assetId), `${row.symbol} → ${label}`);

    const pickedSymbol = assets.find((a) => a.asset_id === pickedId)?.symbol;

    return (
        <SlidePanel
            isOpen
            onClose={onClose}
            title={row.symbol}
            titleIcon={<StatusBadge status={row.status} />}
            width="900px"
            zIndex={1200}
        >
            <div className="flex flex-col gap-3">
                <div className={`${SUBPANEL} flex flex-col gap-1.5 p-3`}>
                    <DetailRow label="Source"><Badge colorScheme="purple">{row.source}</Badge></DetailRow>
                    <DetailRow label={isToken ? 'Token' : 'Kind'}>
                        {isToken
                            ? <ContractChip network={row.network} contract={row.contract_address} full />
                            : 'Exchange / native symbol (no contract)'}
                    </DetailRow>
                    <DetailRow label="Used in">
                        {row.usage_count.toLocaleString()} transaction row(s)
                        {row.first_seen && ` · ${formatDateShort(row.first_seen)} → ${formatDateShort(row.last_seen)}`}
                    </DetailRow>
                </div>

                <section className="flex flex-col gap-2">
                    <span className={SECTION_LABEL}>Mapping</span>

                    {row.status === 'ignored' && (
                        <div className="flex items-center justify-between gap-2 border border-slate-200 bg-slate-50 p-2 text-xs">
                            <span className="text-slate-600">
                                {row.dismissed
                                    ? <>Ignored{row.dismissed_reason && <>: <em>{row.dismissed_reason}</em></>}{row.dismissed_at && ` (${formatDateShort(row.dismissed_at)})`}</>
                                    : 'This contract is blocked as a spam token.'}
                            </span>
                            <Button
                                size="xs"
                                variant="outline"
                                disabled={busy}
                                onClick={() => run(() => restoreRawAsset(row), isToken ? 'Restored and marked not spam' : 'Restored')}
                            >
                                Restore
                            </Button>
                        </div>
                    )}

                    {row.asset_id != null && (
                        <div className="flex items-center justify-between gap-2 border border-green-200 bg-green-50 p-2 text-xs">
                            <span className="text-green-900">
                                Mapped to{' '}
                                <button type="button" className="font-semibold underline-offset-2 hover:underline" onClick={() => openAssetPanel(row.asset_id!)}>
                                    {row.asset_symbol ?? `#${row.asset_id}`}
                                </button>
                                {row.asset_label && row.asset_label !== row.asset_symbol && <span className="text-green-700"> · {row.asset_label}</span>}
                            </span>
                            <Button
                                size="xs"
                                variant="outline"
                                leftIcon={<LuUnlink size={12} />}
                                disabled={busy}
                                onClick={() => run(() => setRawAssetMapping(row, null), `${row.symbol} unmapped`)}
                            >
                                Unmap
                            </Button>
                        </div>
                    )}

                    {suggestion && row.status === 'suggested' && (
                        <div className={`flex flex-col gap-1.5 border p-2 ${isVerified(suggestion) ? 'border-green-200 bg-white' : 'border-amber-200 bg-amber-50/40'}`}>
                            <SuggestionChip
                                suggestion={suggestion}
                                busy={busy}
                                onAccept={() => mapTo(suggestion.id, suggestion.name)}
                            />
                            <span className="text-[11px] text-slate-600">
                                {suggestion.reason ? REASONS[suggestion.reason].hint : 'Suggested match.'}
                                {!isVerified(suggestion) && ' Accepting is allowed, but it is never done in bulk.'}
                            </span>
                        </div>
                    )}

                    <div className="flex flex-col gap-1.5">
                        <span className="text-[11px] text-slate-500">
                            {row.asset_id != null ? 'Change to another asset' : 'Map to an asset'}
                            {isToken && ' (this contract only; other contracts with the same symbol are not affected)'}
                        </span>
                        <div className="flex items-center gap-2">
                            <div className="min-w-0 flex-1">
                                <AssetSelector
                                    value={pickedId}
                                    onChange={setPickedId}
                                    assets={assets}
                                    onAssetCreated={refetchAssets}
                                    defaultSymbol={isToken ? contractAssetSymbol(row.symbol, row.contract_address) : row.symbol}
                                    placeholder="Search assets or create new…"
                                />
                            </div>
                            <Button
                                size="xs"
                                colorScheme="blue"
                                disabled={pickedId == null || busy || pickedId === row.asset_id}
                                onClick={() => pickedId != null && mapTo(pickedId, pickedSymbol ?? `#${pickedId}`)}
                            >
                                Map
                            </Button>
                        </div>
                    </div>
                </section>

                <section className="flex flex-col gap-2">
                    {ignoring ? (
                        <IgnoreForm
                            reasons={IGNORE_REASONS}
                            busy={busy}
                            note={isToken
                                ? 'Ignoring a token also blocks its contract as spam: its transactions are marked invalid, now and in future syncs.'
                                : 'Ignored symbols are hidden from the to-do tabs.'}
                            onCancel={() => setIgnoring(false)}
                            onConfirm={(reason) => run(() => ignoreRawAsset(row, reason), `${row.symbol} ignored`)}
                        />
                    ) : (
                        <div className="flex flex-wrap gap-2">
                            {row.status !== 'ignored' && (
                                <Button size="xs" variant="outline" leftIcon={<LuEyeOff size={12} />} disabled={busy} onClick={() => setIgnoring(true)}>
                                    {isToken ? 'Ignore / mark spam' : 'Ignore'}
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
                    <TransactionsTable
                        key={rowKey}
                        tableId="raw-asset-mapping-txns"
                        title=""
                        subtitle=""
                        compact
                        showFilters={false}
                        showBundles={false}
                        showSuggestions={false}
                        hideLegend
                        initialColumnVisibility={{ total: false, taxability: false, feeInBase: false, bundle: false }}
                        customApiUrl={rawAssetTransactionsUrl(row)}
                    />
                </section>
            </div>

            <ConfirmDialog
                isOpen={confirmDelete}
                onClose={() => setConfirmDelete(false)}
                onConfirm={() => run(() => deleteRawAsset(row), `${row.symbol} deleted`)}
                title="Delete raw asset row"
                message={`Delete ${row.symbol} (${row.source})? Transactions keep their current asset; the row is recreated on the next sync.`}
                confirmLabel="Delete"
                isDestructive
            />
        </SlidePanel>
    );
};
