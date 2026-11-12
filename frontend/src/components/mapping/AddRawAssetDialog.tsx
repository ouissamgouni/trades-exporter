import * as RadixDialog from '@radix-ui/react-dialog';
import React, { useEffect, useMemo, useState } from 'react';
import { AssetSelector } from '../AssetSelector';
import { Button, Input, Spinner } from '../ui/primitives';
import { toaster } from '../ui/toaster';
import { useAssets } from '../../hooks/useAssets';
import { contractAssetSymbol } from '../../utils/rawAccountApi';
import { createRawAsset, lookupRawAsset, RawAssetLookup } from '../../utils/mappingApi';
import { SuggestionChip } from './mappingUi';

const EVM_NETWORKS = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc', 'avalanche', 'hyperevm'];
const DEFAULT_NETWORKS = [...EVM_NETWORKS, 'solana', 'sui', 'near', 'cardano', 'algorand'];
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

type Kind = 'symbol' | 'token';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onCreated: () => void;
    sources: string[];
    networks: string[];
}

const Field: React.FC<{ label: string; htmlFor: string; error?: string | null; hint?: string; children: React.ReactNode }> = ({ label, htmlFor, error, hint, children }) => (
    <div className="flex flex-col gap-1">
        <label htmlFor={htmlFor} className="text-xs font-medium text-slate-700">{label}</label>
        {children}
        {error ? <span className="text-[11px] text-red-600">{error}</span> : hint && <span className="text-[11px] text-slate-500">{hint}</span>}
    </div>
);

export const AddRawAssetDialog: React.FC<Props> = ({ isOpen, onClose, onCreated, sources, networks }) => {
    const { assets, refetchAssets } = useAssets();
    const [kind, setKind] = useState<Kind>('symbol');
    const [source, setSource] = useState('');
    const [symbol, setSymbol] = useState('');
    const [network, setNetwork] = useState('');
    const [contract, setContract] = useState('');
    const [assetId, setAssetId] = useState<number | null>(null);
    const [lookup, setLookup] = useState<RawAssetLookup | null>(null);
    const [lookingUp, setLookingUp] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!isOpen) return;
        setKind('symbol'); setSource(''); setSymbol(''); setNetwork(''); setContract('');
        setAssetId(null); setLookup(null);
    }, [isOpen]);

    const networkOptions = useMemo(() => [...new Set([...networks, ...DEFAULT_NETWORKS])].sort(), [networks]);
    const isToken = kind === 'token';
    const contractError = isToken && contract && EVM_NETWORKS.includes(network) && !EVM_ADDRESS.test(contract.trim())
        ? 'Not a valid EVM address (0x + 40 hex chars).'
        : null;

    // Live lookup: what this row would resolve to and whether it already exists
    useEffect(() => {
        const ready = isToken ? !!(network && contract.trim() && !contractError) : !!symbol.trim();
        if (!isOpen || !ready) { setLookup(null); return; }
        let cancelled = false;
        const t = setTimeout(async () => {
            setLookingUp(true);
            try {
                const res = await lookupRawAsset(symbol.trim(), isToken ? network : '', isToken ? contract.trim() : '');
                if (!cancelled) setLookup(res);
            } catch {
                if (!cancelled) setLookup(null);
            } finally {
                if (!cancelled) setLookingUp(false);
            }
        }, 400);
        return () => { cancelled = true; clearTimeout(t); };
    }, [isOpen, isToken, symbol, network, contract, contractError]);

    const duplicate = lookup?.existing.find((r) => r.source === source.trim() && r.symbol === symbol.trim());
    const mappedElsewhere = (lookup?.existing ?? []).filter((r) => r.asset_id != null && r !== duplicate);
    const canSave = !!source.trim() && !!symbol.trim() && (!isToken || (!!network && !!contract.trim() && !contractError)) && !duplicate && !saving;

    const save = async () => {
        setSaving(true);
        try {
            await createRawAsset({
                source: source.trim(),
                symbol: symbol.trim(),
                network: isToken ? network : '',
                contract_address: isToken ? contract.trim() : '',
                asset_id: assetId,
            });
            toaster.success({ title: 'Mapping created' });
            onCreated();
            onClose();
        } catch (err) {
            toaster.error({ title: 'Could not create mapping', description: err instanceof Error ? err.message : undefined });
        } finally {
            setSaving(false);
        }
    };

    const kindBtn = (k: Kind, label: string) => (
        <button
            type="button"
            role="radio"
            aria-checked={kind === k}
            onClick={() => setKind(k)}
            className={`flex-1 border px-3 py-1.5 text-xs font-medium ${kind === k ? 'border-blue-500 bg-blue-500 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}
        >
            {label}
        </button>
    );

    return (
        <RadixDialog.Root open={isOpen} onOpenChange={(o) => !o && onClose()}>
            <RadixDialog.Portal>
                <RadixDialog.Overlay className="fixed inset-0 z-[1000] bg-black/40" />
                <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[1000] w-full max-w-[520px] -translate-x-1/2 -translate-y-1/2 border border-slate-200 bg-white shadow-xl">
                    <div className="border-b border-slate-200 px-4 py-3">
                        <RadixDialog.Title className="text-base font-semibold text-slate-800">Add asset mapping</RadixDialog.Title>
                        <RadixDialog.Description className="text-xs text-slate-500">
                            Tell the importer which asset a source symbol or token contract stands for.
                        </RadixDialog.Description>
                    </div>
                    <div className="flex flex-col gap-3 px-4 py-3">
                        <div role="radiogroup" aria-label="Mapping kind" className="flex">
                            {kindBtn('symbol', 'Exchange symbol')}
                            {kindBtn('token', 'On-chain token')}
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <Field label="Source *" htmlFor="ra-source">
                                <Input id="ra-source" list="ra-sources" value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. binance" className="h-8 text-xs" />
                                <datalist id="ra-sources">{sources.map((s) => <option key={s} value={s} />)}</datalist>
                            </Field>
                            <Field label="Symbol *" htmlFor="ra-symbol">
                                <Input id="ra-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder={isToken ? 'e.g. USDC' : 'e.g. BTC'} className="h-8 text-xs" />
                            </Field>
                        </div>
                        {isToken && (
                            <div className="grid grid-cols-[140px_1fr] gap-3">
                                <Field label="Network *" htmlFor="ra-network">
                                    <select id="ra-network" value={network} onChange={(e) => setNetwork(e.target.value)} className="h-8 border border-slate-200 bg-white px-2 text-xs">
                                        <option value="">Select…</option>
                                        {networkOptions.map((n) => <option key={n} value={n}>{n}</option>)}
                                    </select>
                                </Field>
                                <Field label="Contract address *" htmlFor="ra-contract" error={contractError} hint="Mapping applies to this contract only.">
                                    <Input id="ra-contract" value={contract} onChange={(e) => setContract(e.target.value)} placeholder="0x… / mint address" className="h-8 font-mono text-xs" />
                                </Field>
                            </div>
                        )}

                        {(lookingUp || lookup) && (
                            <div className="flex flex-col gap-1.5 border border-slate-200 bg-slate-50 p-2 text-xs" aria-live="polite">
                                {lookingUp && <span className="flex items-center gap-2 text-slate-500"><Spinner size="sm" /> Checking…</span>}
                                {!lookingUp && duplicate && <span className="text-red-600">This row already exists for {duplicate.source}. Edit it from the list instead.</span>}
                                {!lookingUp && mappedElsewhere.length > 0 && (
                                    <span className="text-slate-600">
                                        Already mapped in {mappedElsewhere.length} other source(s): {[...new Set(mappedElsewhere.map((r) => r.source))].slice(0, 3).join(', ')}
                                    </span>
                                )}
                                {!lookingUp && lookup?.suggestion && (
                                    <div className="flex items-center gap-2">
                                        <SuggestionChip suggestion={lookup.suggestion} />
                                        {assetId !== lookup.suggestion.id && (
                                            <Button size="xs" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setAssetId(lookup.suggestion!.id)}>
                                                Use
                                            </Button>
                                        )}
                                    </div>
                                )}
                                {!lookingUp && lookup && !lookup.suggestion && !duplicate && mappedElsewhere.length === 0 && (
                                    <span className="text-slate-500">No known match. Pick an asset below or create one.</span>
                                )}
                            </div>
                        )}

                        <Field label="Asset" htmlFor="ra-asset" hint="Optional: leave empty to map later.">
                            <AssetSelector
                                value={assetId}
                                onChange={setAssetId}
                                assets={assets}
                                onAssetCreated={refetchAssets}
                                defaultSymbol={isToken && contract ? contractAssetSymbol(symbol, contract) : symbol}
                                placeholder="Search assets or create new…"
                            />
                        </Field>
                    </div>
                    <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
                        <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
                        <Button size="sm" colorScheme="blue" disabled={!canSave} loading={saving} onClick={save}>
                            Create mapping
                        </Button>
                    </div>
                </RadixDialog.Content>
            </RadixDialog.Portal>
        </RadixDialog.Root>
    );
};
