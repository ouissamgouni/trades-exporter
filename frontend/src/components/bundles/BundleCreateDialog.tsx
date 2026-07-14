/**
 * BundleCreateDialog
 *
 * A modal dialog for creating a new bundle with full control over parameters:
 * pattern, label, notes, and taxability override.
 *
 * Opened from the TransactionsTable bulk action toolbar (Swap / Transfer / Bundle buttons).
 * The caller pre-fills defaultPattern and defaultLabel; the user can adjust before submitting.
 */

import React, { useEffect, useState } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { Button, Input, Textarea } from '../ui/primitives';
import { TaxabilityStatus, UnitPattern } from '../../enums';
import { API_URL } from '../../types';
import { toaster } from '../ui/toaster';
import { useAssets } from '../../hooks/useAssets';

// Human-readable labels for each pattern
const PATTERN_LABELS: Record<string, string> = {
    [UnitPattern.SWAP]: '🔄 Swap — Exchange of assets',
    [UnitPattern.INTERNAL_TRANSFER]: '↔ Internal Transfer — Between owned accounts',
    [UnitPattern.FLOW]: '➡ Flow — External single-leg movement',
    [UnitPattern.SPLIT]: '📊 Split — Stock/token split',
    [UnitPattern.SPINOFF]: '🏢 Spin-Off — Corporate spin-off with cost basis reallocation',
    [UnitPattern.CUSTOM]: '📦 Custom — User-defined grouping',
    [UnitPattern.UNKNOWN]: '❓ Unknown — Needs review',
};

// Ordered list of user-selectable patterns (exclude unmatched_internal_transfer — system-only)
const SELECTABLE_PATTERNS = [
    UnitPattern.SWAP,
    UnitPattern.INTERNAL_TRANSFER,
    UnitPattern.FLOW,
    UnitPattern.SPLIT,
    UnitPattern.SPINOFF,
    UnitPattern.CUSTOM,
    UnitPattern.UNKNOWN,
];

const TAXABILITY_BG: Record<string, string> = {
    [TaxabilityStatus.TAXABLE]: '#FED7AA',
    [TaxabilityStatus.NON_TAXABLE]: '#C6F6D5',
    [TaxabilityStatus.UNKNOWN]: '#FEFCBF',
};

export interface BundleCreateDefaults {
    /** Pre-selected pattern (from which button was clicked) */
    pattern: string;
    /** Pre-generated label */
    label: string;
    /** Transaction IDs to include */
    transactionIds: number[];
    /** Unique asset symbols involved in the selected transactions */
    selectedAssetSymbols?: string[];
}

interface BundleCreateDialogProps {
    isOpen: boolean;
    onClose: () => void;
    /** Called after a bundle is successfully created */
    onCreated: () => void;
    /** Defaults to pre-fill the form */
    defaults: BundleCreateDefaults;
    /** Function to regenerate label based on pattern (from TransactionsTable) */
    generateLabel: (pattern: string) => string;
}

export const BundleCreateDialog: React.FC<BundleCreateDialogProps> = ({
    isOpen,
    onClose,
    onCreated,
    defaults,
    generateLabel,
}) => {
    const [pattern, setPattern] = useState(defaults.pattern);
    const [label, setLabel] = useState(defaults.label);
    const [notes, setNotes] = useState('');
    const [taxability, setTaxability] = useState<string>(TaxabilityStatus.UNKNOWN);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    // Spinoff-specific fields
    const [spinoffSourceAssetId, setSpinoffSourceAssetId] = useState<string>('');
    const [spinoffAllocationPct, setSpinoffAllocationPct] = useState<string>('');
    const { assets } = useAssets();

    // Reset form when dialog opens with new defaults
    useEffect(() => {
        if (isOpen) {
            setPattern(defaults.pattern);
            setLabel(defaults.label);
            setNotes('');
            setTaxability(TaxabilityStatus.UNKNOWN);
            setSpinoffSourceAssetId('');
            setSpinoffAllocationPct('');
            setError('');
        }
    }, [isOpen, defaults]);

    // Re-generate label when pattern changes (unless user has manually edited it)
    const [labelManuallyEdited, setLabelManuallyEdited] = useState(false);

    useEffect(() => {
        if (isOpen) setLabelManuallyEdited(false);
    }, [isOpen]);

    // Auto-fill label when spinoff source asset changes
    useEffect(() => {
        if (pattern !== UnitPattern.SPINOFF || !spinoffSourceAssetId || labelManuallyEdited) return;
        const sourceAsset = assets.find(a => String(a.asset_id) === spinoffSourceAssetId);
        if (!sourceAsset) return;
        const targetSymbols = (defaults.selectedAssetSymbols ?? [])
            .filter(s => s !== sourceAsset.symbol);
        const target = targetSymbols.length > 0 ? targetSymbols.join(', ') : '?';
        const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
        setLabel(`${sourceAsset.symbol} → ${target} Spin-off ${now}`);
    }, [spinoffSourceAssetId, pattern, assets, defaults.selectedAssetSymbols, labelManuallyEdited]);

    const handlePatternChange = (newPattern: string) => {
        setPattern(newPattern);
        if (!labelManuallyEdited) {
            setLabel(generateLabel(newPattern));
        }
    };

    const handleLabelChange = (value: string) => {
        setLabel(value);
        setLabelManuallyEdited(true);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            // Validate spinoff fields
            if (pattern === UnitPattern.SPINOFF && !spinoffSourceAssetId) {
                throw new Error('Source (parent) asset is required for spin-off bundles');
            }

            const payload: Record<string, any> = {
                transaction_ids: defaults.transactionIds,
                label: label || null,
                pattern,
            };
            if (notes.trim()) payload.notes = notes.trim();
            if (taxability !== TaxabilityStatus.UNKNOWN) {
                payload.taxability_override = taxability;
            }

            // Attach spinoff metadata
            if (pattern === UnitPattern.SPINOFF) {
                const parsedAssetId = Number(spinoffSourceAssetId);
                if (isNaN(parsedAssetId)) {
                    throw new Error('Invalid source asset selection');
                }
                const meta: Record<string, any> = {
                    spinoff_source_asset_id: parsedAssetId,
                };
                if (spinoffAllocationPct.trim()) {
                    const pct = parseFloat(spinoffAllocationPct);
                    if (isNaN(pct) || pct < 0 || pct > 100) {
                        throw new Error('Allocation % must be between 0 and 100');
                    }
                    meta.spinoff_allocation_pct = pct / 100; // Backend expects 0-1
                }
                payload.metadata = meta;
            }

            const response = await fetch(`${API_URL}/bundles`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => null);
                throw new Error(errorData?.detail || 'Failed to create bundle');
            }

            toaster.success({
                title: 'Bundle created',
                description: `"${label || 'Bundle'}" with ${defaults.transactionIds.length} transaction(s)`,
            });
            onCreated();
            onClose();
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to create bundle';
            setError(msg);
            toaster.error({ title: 'Error', description: msg });
        } finally {
            setLoading(false);
        }
    };

    return (
        <RadixDialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
            <RadixDialog.Portal>
                <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
                <RadixDialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-[480px] -translate-x-1/2 -translate-y-1/2 border border-slate-200 bg-white shadow-xl">
                    <div className="border-b border-slate-100 px-5 py-4">
                        <RadixDialog.Title className="text-base font-semibold text-slate-900">Create Bundle</RadixDialog.Title>
                    </div>
                    <form onSubmit={handleSubmit}>
                        <div className="px-5 py-4">
                            <div className="flex flex-col gap-4">
                                {error && (
                                    <div className="border border-red-200 bg-red-50 p-2">
                                        <span className="text-sm text-red-600">{error}</span>
                                    </div>
                                )}

                                {/* Info */}
                                <div className="bg-slate-50 p-2">
                                    <span className="text-xs text-slate-600">
                                        Bundling {defaults.transactionIds.length} transaction{defaults.transactionIds.length !== 1 ? 's' : ''}
                                    </span>
                                </div>

                                {/* Pattern */}
                                <div>
                                    <span className="mb-1 block text-sm font-medium">Pattern</span>
                                    <select
                                        className="h-9 w-full border border-slate-200 bg-white px-3 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                        value={pattern}
                                        onChange={(e) => handlePatternChange(e.target.value)}
                                    >
                                        {SELECTABLE_PATTERNS.map(p => (
                                            <option key={p} value={p}>
                                                {PATTERN_LABELS[p] || p}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                {/* Spinoff-specific fields */}
                                {pattern === UnitPattern.SPINOFF && (
                                    <>
                                        <div>
                                            <span className="mb-1 block text-sm font-medium">
                                                Source (Parent) Asset <span className="text-red-400">*</span>
                                            </span>
                                            <span className="mb-1 block text-xs text-slate-500">
                                                The parent company whose cost basis will be reallocated
                                            </span>
                                            <select
                                                className="h-9 w-full border border-slate-200 bg-white px-3 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                                value={spinoffSourceAssetId}
                                                onChange={(e) => setSpinoffSourceAssetId(e.target.value)}
                                            >
                                                <option value="">— Select parent asset —</option>
                                                {assets
                                                    .filter(a => a.asset_id != null && a.symbol)
                                                    .sort((a, b) => (a.symbol || '').localeCompare(b.symbol || ''))
                                                    .map(a => (
                                                        <option key={a.asset_id} value={String(a.asset_id)}>
                                                            {a.symbol}{a.label ? ` — ${a.label}` : ''}
                                                        </option>
                                                    ))}
                                            </select>
                                        </div>
                                        <div>
                                            <span className="mb-1 block text-sm font-medium">
                                                Allocation % to New Company{' '}
                                                <span className="font-normal text-slate-400">(optional)</span>
                                            </span>
                                            <span className="mb-1 block text-xs text-slate-500">
                                                % of cost basis allocated to the spun-off company. Leave blank to auto-compute from FMV at spin-off date.
                                            </span>
                                            <Input
                                                value={spinoffAllocationPct}
                                                onChange={(e) => setSpinoffAllocationPct(e.target.value)}
                                                placeholder="e.g., 15 (for 15%)"
                                                type="number"
                                                min={0}
                                                max={100}
                                                step={0.01}
                                            />
                                        </div>
                                    </>
                                )}

                                {/* Label */}
                                <div>
                                    <span className="mb-1 block text-sm font-medium">Label</span>
                                    <Input
                                        value={label}
                                        onChange={(e) => handleLabelChange(e.target.value)}
                                        placeholder="e.g., BTC → ETH Swap"
                                    />
                                </div>

                                {/* Notes */}
                                <div>
                                    <span className="mb-1 block text-sm font-medium">
                                        Notes <span className="font-normal text-slate-400">(optional)</span>
                                    </span>
                                    <Textarea
                                        value={notes}
                                        onChange={(e) => setNotes(e.target.value)}
                                        placeholder="Additional context or reason for this bundle..."
                                        rows={2}
                                    />
                                </div>

                                {/* Taxability */}
                                <div>
                                    <span className="mb-1 block text-sm font-medium">Taxability Override</span>
                                    <select
                                        className="h-9 w-[160px] border border-slate-200 text-sm"
                                        value={taxability}
                                        onChange={(e) => setTaxability(e.target.value)}
                                        style={{
                                            fontSize: '12px',
                                            padding: '4px 8px',
                                            backgroundColor: TAXABILITY_BG[taxability] || '#FEFCBF',
                                        }}
                                    >
                                        <option value={TaxabilityStatus.UNKNOWN}>Unknown (auto-detect)</option>
                                        <option value={TaxabilityStatus.TAXABLE}>Taxable</option>
                                        <option value={TaxabilityStatus.NON_TAXABLE}>Non-Taxable</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                        <div className="flex gap-3 border-t border-slate-100 px-5 py-4">
                            <Button variant="outline" onClick={onClose} disabled={loading}>
                                Cancel
                            </Button>
                            <Button
                                type="submit"
                                colorScheme="gray"
                                className="bg-purple-600 text-white hover:bg-purple-700"
                                loading={loading}
                            >
                                Create Bundle
                            </Button>
                        </div>
                    </form>
                </RadixDialog.Content>
            </RadixDialog.Portal>
        </RadixDialog.Root>
    );
};
