"use client"

import * as RadixDialog from '@radix-ui/react-dialog';
import React, { useEffect, useState } from 'react';
import { FiAlertTriangle } from 'react-icons/fi';
import { API_URL } from '../types';
import { Badge, Button, Spinner } from './ui/primitives';

interface AssetDeletePreview {
    asset_id: number;
    asset_symbol: string;
    // Cascade (light, auto-deleted)
    asset_categories: number;
    price_getters: number;
    raw_assets: number;
    price_snapshots: number;
    // Heavy data (require force)
    transactions: number;
    cost_lots: number;
    realized_pnl: number;
    calculation_unit_legs: number;
    fee_entries: number;
    pnl_warnings: number;
}

interface DeleteAssetDialogProps {
    isOpen: boolean;
    onClose: () => void;
    assetId: number | null;
    assetSymbol: string;
    onDeleted: () => void;
}

const CASCADE_LABELS: { key: keyof AssetDeletePreview; label: string; icon: string }[] = [
    { key: 'asset_categories', label: 'Category assignments', icon: '🏷️' },
    { key: 'price_getters', label: 'Price getters', icon: '💰' },
    { key: 'raw_assets', label: 'Raw asset mappings', icon: '🔗' },
    { key: 'price_snapshots', label: 'Price snapshots', icon: '📈' },
];

const BLOCKER_LABELS: { key: keyof AssetDeletePreview; label: string; icon: string }[] = [
    { key: 'transactions', label: 'Transactions', icon: '📄' },
    { key: 'cost_lots', label: 'Cost lots', icon: '📦' },
    { key: 'realized_pnl', label: 'Realized P&L entries', icon: '💵' },
    { key: 'calculation_unit_legs', label: 'Calculation unit legs', icon: '📊' },
    { key: 'fee_entries', label: 'Fee entries', icon: '🧾' },
    { key: 'pnl_warnings', label: 'P&L warnings', icon: '⚠️' },
];

export const DeleteAssetDialog: React.FC<DeleteAssetDialogProps> = ({
    isOpen,
    onClose,
    assetId,
    assetSymbol,
    onDeleted,
}) => {
    const [preview, setPreview] = useState<AssetDeletePreview | null>(null);
    const [loading, setLoading] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!isOpen || assetId == null) {
            setPreview(null);
            setError(null);
            return;
        }

        let cancelled = false;
        const fetchPreview = async () => {
            setLoading(true);
            setError(null);
            try {
                const res = await fetch(`${API_URL}/assets/${assetId}/delete-preview`);
                if (!res.ok) throw new Error('Failed to load deletion preview');
                const data: AssetDeletePreview = await res.json();
                if (!cancelled) setPreview(data);
            } catch (e: any) {
                if (!cancelled) setError(e.message ?? 'Unknown error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        fetchPreview();
        return () => { cancelled = true; };
    }, [isOpen, assetId]);

    const hasBlockers = preview
        ? (preview.transactions + preview.cost_lots + preview.realized_pnl +
            preview.calculation_unit_legs + preview.fee_entries + preview.pnl_warnings) > 0
        : false;

    const hasCascade = preview
        ? (preview.asset_categories + preview.price_getters + preview.raw_assets + preview.price_snapshots) > 0
        : false;

    const hasAnyDependencies = hasBlockers || hasCascade;

    const handleDelete = async () => {
        if (assetId == null) return;
        setDeleting(true);
        try {
            const forceParam = hasBlockers ? '?force=true' : '';
            const res = await fetch(`${API_URL}/assets/${assetId}${forceParam}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Failed to delete asset');
            onDeleted();
            onClose();
        } catch (e: any) {
            setError(e.message ?? 'Deletion failed');
        } finally {
            setDeleting(false);
        }
    };

    return (
        <RadixDialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
            <RadixDialog.Portal>
                <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
                <RadixDialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-[480px] -translate-x-1/2 -translate-y-1/2 border border-slate-200 bg-white shadow-xl">
                    <div className="border-b border-slate-200 p-4">
                        <RadixDialog.Title className="text-base font-semibold">Delete Asset</RadixDialog.Title>
                    </div>

                    <div className="p-4">
                        {loading ? (
                            <div className="flex justify-center py-6">
                                <Spinner size="lg" />
                            </div>
                        ) : error ? (
                            <span className="text-red-500">{error}</span>
                        ) : preview ? (
                            <div className="flex flex-col items-stretch gap-3">
                                <span>
                                    Are you sure you want to delete{' '}
                                    <span className="font-bold">{assetSymbol}</span>?
                                </span>

                                {hasBlockers && (
                                    <div className="border border-red-200 bg-red-50 p-3">
                                        <div className="mb-2 flex items-center gap-2">
                                            <span className="text-red-500"><FiAlertTriangle /></span>
                                            <span className="text-sm font-semibold text-red-700">
                                                The following data will be permanently deleted:
                                            </span>
                                        </div>
                                        <div className="flex flex-col items-stretch gap-1 pl-1">
                                            {BLOCKER_LABELS.map(({ key, label, icon }) => {
                                                const count = preview[key] as number;
                                                if (count === 0) return null;
                                                return (
                                                    <div key={key} className="flex items-center justify-between text-sm">
                                                        <span className="text-slate-700">{icon} {label}</span>
                                                        <Badge colorScheme="red">
                                                            {count}
                                                        </Badge>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}

                                {hasCascade && (
                                    <div className="border border-orange-200 bg-orange-50 p-3">
                                        <span className="mb-2 block text-sm font-semibold text-orange-700">
                                            Also removed (auto-cascade):
                                        </span>
                                        <div className="flex flex-col items-stretch gap-1 pl-1">
                                            {CASCADE_LABELS.map(({ key, label, icon }) => {
                                                const count = preview[key] as number;
                                                if (count === 0) return null;
                                                return (
                                                    <div key={key} className="flex items-center justify-between text-sm">
                                                        <span className="text-slate-700">{icon} {label}</span>
                                                        <Badge colorScheme="orange">
                                                            {count}
                                                        </Badge>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}

                                {!hasAnyDependencies && (
                                    <span className="text-sm text-slate-600">
                                        This asset has no dependent data.
                                    </span>
                                )}

                                <span className="text-xs text-slate-500">
                                    This action cannot be undone.
                                </span>
                            </div>
                        ) : null}
                    </div>

                    <div className="flex justify-end gap-3 border-t border-slate-200 p-4">
                        <Button
                            variant="outline"
                            onClick={onClose}
                            disabled={deleting}
                        >
                            Cancel
                        </Button>
                        <Button
                            colorScheme="red"
                            onClick={handleDelete}
                            loading={deleting}
                            disabled={loading || !!error}
                        >
                            {hasBlockers ? 'Force Delete' : 'Delete'}
                        </Button>
                    </div>
                </RadixDialog.Content>
            </RadixDialog.Portal>
        </RadixDialog.Root>
    );
};

export default DeleteAssetDialog;
