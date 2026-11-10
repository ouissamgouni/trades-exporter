import * as RadixDialog from '@radix-ui/react-dialog';
import React, { useEffect, useMemo, useState } from 'react';
import { AccountSelector } from '../AccountSelector';
import { Button, Input, Spinner } from '../ui/primitives';
import { toaster } from '../ui/toaster';
import { useAccounts } from '../../hooks/useAccounts';
import { createRawAccount, lookupRawAccount, RawAccountLookup } from '../../utils/mappingApi';
import { SuggestionChip } from './mappingUi';

const DEFAULT_NETWORKS = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc', 'avalanche', 'hyperevm', 'solana', 'sui', 'near', 'cardano', 'bitcoin'];

type Kind = 'exchange' | 'address';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onCreated: () => void;
    sources: string[];
    networks: string[];
}

export const AddRawAccountDialog: React.FC<Props> = ({ isOpen, onClose, onCreated, sources, networks }) => {
    const { accounts, refetchAccounts } = useAccounts();
    const [kind, setKind] = useState<Kind>('exchange');
    const [source, setSource] = useState('');
    const [label, setLabel] = useState('');
    const [network, setNetwork] = useState('');
    const [accountId, setAccountId] = useState<number | null>(null);
    const [lookup, setLookup] = useState<RawAccountLookup | null>(null);
    const [lookingUp, setLookingUp] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!isOpen) return;
        setKind('exchange'); setSource(''); setLabel(''); setNetwork(''); setAccountId(null); setLookup(null);
    }, [isOpen]);

    const networkOptions = useMemo(() => [...new Set([...networks, ...DEFAULT_NETWORKS])].sort(), [networks]);
    const isAddress = kind === 'address';

    useEffect(() => {
        if (!isOpen || !label.trim()) { setLookup(null); return; }
        let cancelled = false;
        const t = setTimeout(async () => {
            setLookingUp(true);
            try {
                const res = await lookupRawAccount(label.trim(), source.trim(), isAddress ? network : '');
                if (!cancelled) setLookup(res);
            } catch {
                if (!cancelled) setLookup(null);
            } finally {
                if (!cancelled) setLookingUp(false);
            }
        }, 400);
        return () => { cancelled = true; clearTimeout(t); };
    }, [isOpen, label, source, network, isAddress]);

    const effectiveNetwork = isAddress ? network : '';
    const duplicate = lookup?.existing.find((r) => r.source === source.trim() && r.label === label.trim() && r.network === effectiveNetwork);
    const elsewhere = (lookup?.existing ?? []).filter((r) => r !== duplicate);
    const canSave = !!source.trim() && !!label.trim() && (!isAddress || !!network) && !duplicate && !saving;

    const save = async () => {
        setSaving(true);
        try {
            await createRawAccount({ source: source.trim(), label: label.trim(), network: effectiveNetwork, account_id: accountId });
            toaster.success({ title: 'Mapping created' });
            onCreated();
            onClose();
        } catch (err) {
            toaster.error({ title: 'Could not create mapping', description: err instanceof Error ? err.message : undefined });
        } finally {
            setSaving(false);
        }
    };

    const kindBtn = (k: Kind, text: string) => (
        <button
            type="button"
            role="radio"
            aria-checked={kind === k}
            onClick={() => setKind(k)}
            className={`flex-1 border px-3 py-1.5 text-xs font-medium ${kind === k ? 'border-blue-500 bg-blue-500 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}
        >
            {text}
        </button>
    );

    return (
        <RadixDialog.Root open={isOpen} onOpenChange={(o) => !o && onClose()}>
            <RadixDialog.Portal>
                <RadixDialog.Overlay className="fixed inset-0 z-[1000] bg-black/40" />
                <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[1000] w-full max-w-[520px] -translate-x-1/2 -translate-y-1/2 border border-slate-200 bg-white shadow-xl">
                    <div className="border-b border-slate-200 px-4 py-3">
                        <RadixDialog.Title className="text-base font-semibold text-slate-800">Add account mapping</RadixDialog.Title>
                        <RadixDialog.Description className="text-xs text-slate-500">
                            Tell the importer which account a source label or address belongs to.
                        </RadixDialog.Description>
                    </div>
                    <div className="flex flex-col gap-3 px-4 py-3">
                        <div role="radiogroup" aria-label="Mapping kind" className="flex">
                            {kindBtn('exchange', 'Exchange account / label')}
                            {kindBtn('address', 'Wallet address')}
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="flex flex-col gap-1">
                                <label htmlFor="racc-source" className="text-xs font-medium text-slate-700">Source *</label>
                                <Input id="racc-source" list="racc-sources" value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. binance_trx" className="h-8 text-xs" />
                                <datalist id="racc-sources">{sources.map((s) => <option key={s} value={s} />)}</datalist>
                            </div>
                            <div className="flex flex-col gap-1">
                                <label htmlFor="racc-network" className="text-xs font-medium text-slate-700">Network {isAddress ? '*' : '(optional)'}</label>
                                <select id="racc-network" value={network} onChange={(e) => setNetwork(e.target.value)} disabled={!isAddress} className="h-8 border border-slate-200 bg-white px-2 text-xs disabled:opacity-50">
                                    <option value="">{isAddress ? 'Select…' : 'Any network'}</option>
                                    {networkOptions.map((n) => <option key={n} value={n}>{n}</option>)}
                                </select>
                            </div>
                        </div>
                        <div className="flex flex-col gap-1">
                            <label htmlFor="racc-label" className="text-xs font-medium text-slate-700">{isAddress ? 'Address *' : 'Label *'}</label>
                            <Input
                                id="racc-label"
                                value={label}
                                onChange={(e) => setLabel(e.target.value)}
                                placeholder={isAddress ? '0x… / base58 address' : 'e.g. spot, funding'}
                                className={`h-8 text-xs ${isAddress ? 'font-mono' : ''}`}
                            />
                            {isAddress && <span className="text-[11px] text-slate-500">The same address on another chain is a separate mapping.</span>}
                        </div>

                        {(lookingUp || lookup) && (
                            <div className="flex flex-col gap-1.5 border border-slate-200 bg-slate-50 p-2 text-xs" aria-live="polite">
                                {lookingUp && <span className="flex items-center gap-2 text-slate-500"><Spinner size="sm" /> Checking…</span>}
                                {!lookingUp && duplicate && <span className="text-red-600">This row already exists. Edit it from the list instead.</span>}
                                {!lookingUp && elsewhere.length > 0 && (
                                    <span className="text-slate-600">
                                        Seen in {elsewhere.length} other row(s): {[...new Set(elsewhere.map((r) => `${r.source}${r.network ? `/${r.network}` : ''}`))].slice(0, 3).join(', ')}
                                    </span>
                                )}
                                {!lookingUp && lookup?.suggestion && (
                                    <div className="flex items-center gap-2">
                                        <SuggestionChip suggestion={lookup.suggestion} />
                                        {accountId !== lookup.suggestion.id && (
                                            <Button size="xs" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setAccountId(lookup.suggestion!.id)}>
                                                Use
                                            </Button>
                                        )}
                                    </div>
                                )}
                                {!lookingUp && lookup && !lookup.suggestion && !duplicate && elsewhere.length === 0 && (
                                    <span className="text-slate-500">No known match. Pick an account below or create one.</span>
                                )}
                            </div>
                        )}

                        <div className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-slate-700">Account</span>
                            <AccountSelector
                                value={accountId}
                                onChange={(id) => setAccountId(id ?? null)}
                                accounts={accounts}
                                onAccountCreated={refetchAccounts}
                                defaultName={label}
                                rawAccountNetwork={effectiveNetwork || undefined}
                                placeholder="Search accounts…"
                                size="sm"
                            />
                            <span className="text-[11px] text-slate-500">Optional: leave empty to map later.</span>
                        </div>
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
