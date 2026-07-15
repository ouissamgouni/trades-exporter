"use client"

import * as RadixDialog from '@radix-ui/react-dialog';
import React, { useEffect, useState } from 'react';
import { FiAlertTriangle } from 'react-icons/fi';
import { API_URL } from '../types';
import { Badge, Button, Spinner, type BadgeColorScheme } from './ui/primitives';

interface DeletePreview {
    account_id: number;
    account_name: string;
    transactions: number;
    connectors: number;
    cost_lots: number;
    derivative_positions: number;
    raw_accounts: number;
    transfer_references: number;
    sync_runs: number;
    file_imports: number;
}

interface DeleteAccountDialogProps {
    isOpen: boolean;
    onClose: () => void;
    accountId: number | null;
    accountName: string;
    onDeleted: () => void;
}

const DEPENDENCY_LABELS: { key: keyof DeletePreview; label: string; icon: string }[] = [
    { key: 'transactions', label: 'Transactions', icon: '📄' },
    { key: 'connectors', label: 'Connectors', icon: '🔌' },
    { key: 'cost_lots', label: 'Cost lots', icon: '📦' },
    { key: 'derivative_positions', label: 'Derivative positions', icon: '📊' },
    { key: 'raw_accounts', label: 'Raw account mappings', icon: '🔗' },
    { key: 'sync_runs', label: 'Sync runs', icon: '🔄' },
    { key: 'file_imports', label: 'File imports', icon: '📁' },
    { key: 'transfer_references', label: 'Transfer references (cleared, not deleted)', icon: '↔️' },
];

export const DeleteAccountDialog: React.FC<DeleteAccountDialogProps> = ({
    isOpen,
    onClose,
    accountId,
    accountName,
    onDeleted,
}) => {
    const [preview, setPreview] = useState<DeletePreview | null>(null);
    const [loading, setLoading] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!isOpen || accountId == null) {
            setPreview(null);
            setError(null);
            return;
        }

        let cancelled = false;
        const fetchPreview = async () => {
            setLoading(true);
            setError(null);
            try {
                const res = await fetch(`${API_URL}/accounts/${accountId}/delete-preview`);
                if (!res.ok) throw new Error('Failed to load deletion preview');
                const data: DeletePreview = await res.json();
                if (!cancelled) setPreview(data);
            } catch (e: any) {
                if (!cancelled) setError(e.message ?? 'Unknown error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        fetchPreview();
        return () => { cancelled = true; };
    }, [isOpen, accountId]);

    const handleDelete = async () => {
        if (accountId == null) return;
        setDeleting(true);
        try {
            const res = await fetch(`${API_URL}/accounts/${accountId}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Failed to delete account');
            onDeleted();
            onClose();
        } catch (e: any) {
            setError(e.message ?? 'Deletion failed');
        } finally {
            setDeleting(false);
        }
    };

    const totalAffected = preview
        ? preview.transactions + preview.connectors + preview.cost_lots +
        preview.derivative_positions + preview.raw_accounts +
        preview.sync_runs + preview.file_imports
        : 0;

    const hasAnyDependencies = totalAffected > 0 || (preview?.transfer_references ?? 0) > 0;

    return (
        <RadixDialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
            <RadixDialog.Portal>
                <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
                <RadixDialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-[480px] -translate-x-1/2 -translate-y-1/2 border border-slate-200 bg-white shadow-xl">
                    <div className="border-b border-slate-200 p-4">
                        <RadixDialog.Title className="text-base font-semibold">Delete Account</RadixDialog.Title>
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
                                    <span className="font-bold">{accountName}</span>?
                                </span>

                                {hasAnyDependencies ? (
                                    <div className="border border-red-200 bg-red-50 p-3">
                                        <div className="mb-2 flex items-center gap-2">
                                            <span className="text-red-500"><FiAlertTriangle /></span>
                                            <span className="text-sm font-semibold text-red-700">
                                                The following data will be permanently deleted:
                                            </span>
                                        </div>
                                        <div className="flex flex-col items-stretch gap-1 pl-1">
                                            {DEPENDENCY_LABELS.map(({ key, label, icon }) => {
                                                const count = preview[key] as number;
                                                if (count === 0) return null;
                                                return (
                                                    <div key={key} className="flex items-center justify-between text-sm">
                                                        <span className="text-slate-700">{icon} {label}</span>
                                                        <Badge
                                                            colorScheme={(key === 'transfer_references' ? 'yellow' : 'red') as BadgeColorScheme}
                                                        >
                                                            {count}
                                                        </Badge>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ) : (
                                    <span className="text-sm text-slate-600">
                                        This account has no dependent data.
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
                            Delete
                        </Button>
                    </div>
                </RadixDialog.Content>
            </RadixDialog.Portal>
        </RadixDialog.Root>
    );
};

export default DeleteAccountDialog;
