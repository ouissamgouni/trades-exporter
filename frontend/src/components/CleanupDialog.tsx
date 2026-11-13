"use client"

import * as RadixDialog from '@radix-ui/react-dialog';
import React, { useEffect, useState } from 'react';
import { FiAlertTriangle } from 'react-icons/fi';
import { API_URL } from '../types';
import { toaster } from './ui/toaster';
import { Badge, Button, Spinner, type BadgeColorScheme } from './ui/primitives';

interface CleanupPreview {
    connector_ids: number[];
    connector_names: string[];
    transactions: number;
    raw_transactions: number;
    cost_lots: number;
    sync_runs: number;
    file_imports: number;
    transfer_references: number;
    derivative_positions: number;
    pnl_legs_affected: number;
}

interface CleanupDialogProps {
    isOpen: boolean;
    onClose: () => void;
    connectorIds: number[];
    /** 'purge' = keep connector config, 'delete' = remove everything */
    defaultMode?: 'purge' | 'delete';
    title: string;
    onCompleted: () => void;
    /** If set, use account-level cleanup endpoints instead of connector-level */
    accountId?: number;
}

const IMPACT_LABELS: { key: keyof CleanupPreview; label: string; icon: string; isWarning?: boolean }[] = [
    { key: 'transactions', label: 'Transactions', icon: '📄' },
    { key: 'raw_transactions', label: 'Raw transactions', icon: '📋' },
    { key: 'cost_lots', label: 'Cost lots', icon: '📦' },
    { key: 'sync_runs', label: 'Sync runs', icon: '🔄' },
    { key: 'file_imports', label: 'File imports', icon: '📁' },
    { key: 'derivative_positions', label: 'Derivative positions', icon: '📊' },
    { key: 'transfer_references', label: 'Transfer references (cleared, not deleted)', icon: '↔️', isWarning: true },
];

export const CleanupDialog: React.FC<CleanupDialogProps> = ({
    isOpen,
    onClose,
    connectorIds,
    defaultMode = 'purge',
    title,
    onCompleted,
    accountId,
}) => {
    const [preview, setPreview] = useState<CleanupPreview | null>(null);
    const [loading, setLoading] = useState(false);
    const [executing, setExecuting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [mode, setMode] = useState<'purge' | 'delete'>(defaultMode);

    useEffect(() => {
        setMode(defaultMode);
    }, [defaultMode]);

    useEffect(() => {
        if (!isOpen || (connectorIds.length === 0 && !accountId)) {
            setPreview(null);
            setError(null);
            return;
        }

        let cancelled = false;
        const fetchPreview = async () => {
            setLoading(true);
            setError(null);
            try {
                let res: Response;
                if (accountId) {
                    res = await fetch(`${API_URL}/accounts/${accountId}/cleanup-preview`, {
                        method: 'POST',
                    });
                } else {
                    res = await fetch(`${API_URL}/connectors/cleanup-preview`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            connector_ids: connectorIds,
                            delete_connectors: false,
                        }),
                    });
                }
                if (!res.ok) throw new Error('Failed to load cleanup preview');
                const data: CleanupPreview = await res.json();
                if (!cancelled) setPreview(data);
            } catch (e: any) {
                if (!cancelled) setError(e.message ?? 'Unknown error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        fetchPreview();
        return () => { cancelled = true; };
    }, [isOpen, connectorIds, accountId]);

    const handleConfirm = async () => {
        setExecuting(true);
        try {
            let res: Response;
            if (accountId) {
                res = await fetch(`${API_URL}/accounts/${accountId}/cleanup`, {
                    method: 'POST',
                });
            } else {
                res = await fetch(`${API_URL}/connectors/cleanup`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        connector_ids: connectorIds,
                        delete_connectors: mode === 'delete',
                    }),
                });
            }
            if (!res.ok) throw new Error('Cleanup operation failed');

            toaster.success({
                title: 'Cleanup Complete',
                description: mode === 'delete'
                    ? 'Connectors and all data have been deleted.'
                    : 'Data has been purged. Connector configs preserved.',
            });
            onCompleted();
            onClose();
        } catch (e: any) {
            setError(e.message ?? 'Cleanup failed');
        } finally {
            setExecuting(false);
        }
    };

    const totalAffected = preview
        ? preview.transactions + preview.raw_transactions + preview.cost_lots +
        preview.sync_runs + preview.file_imports + preview.derivative_positions
        : 0;

    const hasAnyImpact = totalAffected > 0 || (preview?.transfer_references ?? 0) > 0;

    const confirmLabel = mode === 'delete' ? 'Delete Connector & Data' : 'Purge Data';

    return (
        <RadixDialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
            <RadixDialog.Portal>
                <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] w-full max-w-[520px] -translate-x-1/2 -translate-y-1/2 border border-slate-200 bg-white shadow-xl">
                    <div className="border-b border-slate-200 p-4">
                        <RadixDialog.Title className="text-base font-semibold">{title}</RadixDialog.Title>
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
                                {/* Connector names */}
                                {preview.connector_names.length > 0 && (
                                    <div>
                                        <span className="mb-1 block text-xs text-slate-500">Affected connectors:</span>
                                        <div className="flex flex-wrap gap-1">
                                            {preview.connector_names.map((name, idx) => (
                                                <Badge key={idx} colorScheme="blue">
                                                    {name}
                                                </Badge>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Impact summary */}
                                {hasAnyImpact ? (
                                    <div className="border border-red-200 bg-red-50 p-3">
                                        <div className="mb-2 flex items-center gap-2">
                                            <span className="text-red-500"><FiAlertTriangle /></span>
                                            <span className="text-sm font-semibold text-red-700">
                                                The following data will be permanently deleted:
                                            </span>
                                        </div>
                                        <div className="flex flex-col items-stretch gap-1 pl-1">
                                            {IMPACT_LABELS.map(({ key, label, icon, isWarning }) => {
                                                const count = preview[key] as number;
                                                if (count === 0) return null;
                                                return (
                                                    <div key={key} className="flex items-center justify-between text-sm">
                                                        <span className="text-slate-700">{icon} {label}</span>
                                                        <Badge
                                                            colorScheme={(isWarning ? 'yellow' : 'red') as BadgeColorScheme}
                                                        >
                                                            {count}
                                                        </Badge>
                                                    </div>
                                                );
                                            })}
                                        </div>

                                        {/* P&L warning */}
                                        {preview.pnl_legs_affected > 0 && (
                                            <div className="mt-2 border border-orange-200 bg-orange-50 p-2">
                                                <span className="text-xs text-orange-700">
                                                    ⚠️ {preview.pnl_legs_affected} P&L calculation legs reference these transactions. You will need to recalculate P&L after cleanup.
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <span className="text-sm text-slate-600">
                                        No data found for these connectors.
                                    </span>
                                )}

                                {/* Mode selection (only for connector-level, not account-level) */}
                                {!accountId && (
                                    <div>
                                        <span className="mb-2 block text-xs text-slate-500">Cleanup mode:</span>
                                        <div className="flex flex-col items-stretch gap-2">
                                            <label className="flex items-center gap-2 text-sm">
                                                <input
                                                    type="radio"
                                                    name="cleanup-mode"
                                                    value="purge"
                                                    checked={mode === 'purge'}
                                                    onChange={() => setMode('purge')}
                                                />
                                                Purge data only (keep connector configuration)
                                            </label>
                                            <label className="flex items-center gap-2 text-sm">
                                                <input
                                                    type="radio"
                                                    name="cleanup-mode"
                                                    value="delete"
                                                    checked={mode === 'delete'}
                                                    onChange={() => setMode('delete')}
                                                />
                                                Delete connectors entirely
                                            </label>
                                        </div>
                                    </div>
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
                            disabled={executing}
                        >
                            Cancel
                        </Button>
                        <Button
                            colorScheme="red"
                            onClick={handleConfirm}
                            loading={executing}
                            disabled={loading || !!error}
                        >
                            {confirmLabel}
                        </Button>
                    </div>
                </RadixDialog.Content>
            </RadixDialog.Portal>
        </RadixDialog.Root>
    );
};

export default CleanupDialog;
