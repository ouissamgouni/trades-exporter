import * as RadixDialog from '@radix-ui/react-dialog';
import React, { useState } from 'react';
import { API_URL, RawAccount } from '../types';
import { AccountMappingPanel } from './AccountMappingPanel';
import { toaster } from './ui/toaster';
import { Button, Input } from './ui/primitives';

export const RawAccountsEditor: React.FC = () => {
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [newRawAccount, setNewRawAccount] = useState<Partial<RawAccount>>({});
    const [includeDismissed, setIncludeDismissed] = useState(false);

    const createRawAccount = async () => {
        if (!newRawAccount.label || !newRawAccount.source) {
            toaster.error({ title: 'Validation error', description: 'Label and Source are required' });
            return;
        }
        try {
            const response = await fetch(`${API_URL}/raw-accounts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newRawAccount)
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to create raw account');
            }
            setNewRawAccount({});
            setShowCreateDialog(false);
            toaster.success({ title: 'Raw account created' });
            // Force refresh by reloading
            window.location.reload();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to create' });
        }
    };

    return (
        <div>
            <div className="mb-6 flex items-center justify-between border-b border-slate-200 pb-2">
                <div>
                    <h2 className="mb-1 text-base font-semibold">🔗 Raw Accounts Mapping</h2>
                    <p className="text-sm text-slate-600">
                        Link source-specific account labels/addresses to normalized accounts.
                    </p>
                </div>
                <div className="flex gap-2">
                    <Button colorScheme="blue" onClick={() => setShowCreateDialog(true)}>
                        ➕ Add Mapping
                    </Button>
                </div>
            </div>

            <AccountMappingPanel
                mode="full"
                includeDismissed={includeDismissed}
                onDismissedChange={setIncludeDismissed}
            />

            {/* Create Raw Account Dialog */}
            <RadixDialog.Root open={showCreateDialog} onOpenChange={setShowCreateDialog}>
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 border border-slate-200 bg-white shadow-xl">
                        <div className="border-b border-slate-100 px-5 py-4">
                            <RadixDialog.Title className="text-base font-semibold text-slate-900">
                                Add Raw Account Mapping
                            </RadixDialog.Title>
                        </div>
                        <div className="flex flex-col gap-4 px-5 py-4">
                            <div>
                                <p className="mb-1 font-medium">Source</p>
                                <Input
                                    value={newRawAccount.source || ''}
                                    onChange={(e) => setNewRawAccount({ ...newRawAccount, source: e.target.value })}
                                    placeholder="e.g., binance_trx, solana_helius"
                                />
                            </div>
                            <div>
                                <p className="mb-1 font-medium">Label</p>
                                <Input
                                    value={newRawAccount.label || ''}
                                    onChange={(e) => setNewRawAccount({ ...newRawAccount, label: e.target.value })}
                                    placeholder="e.g., spot, 0x1234..."
                                />
                            </div>
                        </div>
                        <div className="flex justify-end gap-3 border-t border-slate-100 px-5 py-4">
                            <RadixDialog.Close asChild>
                                <Button variant="outline">Cancel</Button>
                            </RadixDialog.Close>
                            <Button colorScheme="blue" onClick={createRawAccount}>
                                Create
                            </Button>
                        </div>
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>
        </div>
    );
};
