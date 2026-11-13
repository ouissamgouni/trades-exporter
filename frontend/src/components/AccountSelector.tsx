import * as RadixDialog from '@radix-ui/react-dialog';
import { Badge, Button, Input } from './ui/primitives';
import React, { useEffect, useRef, useState } from 'react';
import { API_URL, Account } from '../types';
import { linkRawAccount } from '../utils/rawAccountApi';
import { toaster } from './ui/toaster';

interface AccountSelectorProps {
    value: number | null;
    onChange: (accountId: number | null) => void;
    accounts: Account[];
    onAccountCreated?: () => void;
    placeholder?: string;
    defaultName?: string; // Pre-fill new account name
    size?: 'xs' | 'sm' | 'md';
    disabled?: boolean;
    showOwnershipBadge?: boolean; // Display 'Owned' badge for owned accounts
    // For linking raw_account when creating new account from mapping context
    rawAccountSource?: string;
    rawAccountLabel?: string;
    /** Network/chain for disambiguation (e.g. 'bsc', 'ethereum') */
    rawAccountNetwork?: string;
}

export const AccountSelector: React.FC<AccountSelectorProps> = ({
    value,
    onChange,
    accounts,
    onAccountCreated,
    placeholder = 'Search or select account...',
    defaultName = '',
    size = 'sm',
    disabled,
    showOwnershipBadge = false,
    rawAccountSource,
    rawAccountLabel,
    rawAccountNetwork,
}) => {
    const [search, setSearch] = useState('');
    const [isOpen, setIsOpen] = useState(false);
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [newAccount, setNewAccount] = useState<Partial<Account>>({
        name: defaultName,
        account_type: 'cex',
        address_or_identifier: '',
        tags: [],
        owned: true,
    });
    const [creating, setCreating] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Get current account
    const selectedAccount = accounts.find(a => a.id === value);

    // Filter accounts by search
    const filteredAccounts = accounts.filter(a =>
        a.name.toLowerCase().includes(search.toLowerCase()) ||
        (a.address_or_identifier && a.address_or_identifier.toLowerCase().includes(search.toLowerCase()))
    );

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const doLinkRawAccount = async (accountId: number) => {
        // If raw account context is provided, link the raw_account to the account
        if (rawAccountSource && rawAccountLabel && accountId) {
            try {
                await linkRawAccount({
                    source: rawAccountSource,
                    label: rawAccountLabel,
                    network: rawAccountNetwork,
                    accountId,
                });
            } catch (linkErr) {
                console.warn('Failed to link raw account:', linkErr);
                // Don't fail the whole operation if linking fails
            }
        }
    };

    const handleSelect = async (accountId: number | null) => {
        onChange(accountId);
        setIsOpen(false);
        setSearch('');

        // Link raw_account when selecting an existing account
        if (accountId) {
            await doLinkRawAccount(accountId);
        }
    };

    const createAccount = async () => {
        if (!newAccount.name?.trim()) {
            toaster.error({ title: 'Name is required' });
            return;
        }
        setCreating(true);
        try {
            const response = await fetch(`${API_URL}/accounts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newAccount.name,
                    account_type: newAccount.account_type || 'cex',
                    address_or_identifier: newAccount.address_or_identifier || null,
                    tags: newAccount.tags || null,
                    owned: newAccount.owned ?? true,
                })
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to create account');
            }
            const created = await response.json();

            // Link the raw_account to the new account
            if (created.id) {
                await doLinkRawAccount(created.id);
            }

            setShowCreateDialog(false);
            resetNewAccount();
            // Select the newly created account first
            onChange(created.id);
            // Then refresh the accounts list
            if (onAccountCreated) onAccountCreated();
        } catch (err) {
            toaster.error({ title: err instanceof Error ? err.message : 'Failed to create account' });
        } finally {
            setCreating(false);
        }
    };

    const resetNewAccount = () => {
        setNewAccount({
            name: '',
            account_type: 'cex',
            address_or_identifier: '',
            tags: [],
            owned: true,
        });
    };

    const openCreateDialog = () => {
        // Infer account type from label if available
        const inferredType = rawAccountLabel?.startsWith('0x') ? 'wallet' : 'cex';
        setNewAccount(prev => ({
            ...prev,
            name: search || defaultName || rawAccountLabel || '',
            address_or_identifier: rawAccountLabel || '',
            account_type: inferredType,
        }));
        setShowCreateDialog(true);
        setIsOpen(false);
    };

    return (
        <div className="relative" ref={containerRef}>
            <Input
                value={isOpen ? search : (selectedAccount ? selectedAccount.name : '')}
                onChange={e => {
                    setSearch(e.target.value);
                    if (!isOpen) setIsOpen(true);
                }}
                onFocus={() => setIsOpen(true)}
                placeholder={placeholder}
                disabled={disabled}
                className="h-6 px-1.5 text-[11px]"
            />

            {isOpen && (
                <div className="absolute left-0 right-0 top-full z-[1000] mt-1 max-h-[250px] overflow-y-auto border border-slate-200 bg-white shadow-lg">
                    {/* Clear selection option */}
                    <div
                        className="cursor-pointer p-2 text-xs text-slate-500 hover:bg-slate-100"
                        onClick={() => handleSelect(null)}
                    >
                        -- Not linked --
                    </div>

                    {/* Filtered accounts */}
                    {filteredAccounts.map(account => (
                        <div
                            key={account.id}
                            className={`cursor-pointer p-2 text-xs hover:bg-blue-100 ${value === account.id ? 'bg-blue-50' : ''}`}
                            onClick={() => handleSelect(account.id)}
                        >
                            <div className="flex items-center gap-2">
                                <span className="flex-1 font-medium">{account.name}</span>
                                {showOwnershipBadge && account.owned && (
                                    <Badge colorScheme="green">
                                        Owned
                                    </Badge>
                                )}
                            </div>
                            <span className="block text-xs text-slate-500">
                                {account.account_type}
                                {account.address_or_identifier && ` • ${account.address_or_identifier.slice(0, 12)}...`}
                            </span>
                        </div>
                    ))}

                    {/* No results */}
                    {filteredAccounts.length === 0 && (
                        <div className="p-2 text-xs text-slate-500">
                            No accounts found
                        </div>
                    )}

                    {/* Create new account option */}
                    <div
                        className="cursor-pointer border-t border-slate-100 p-2 text-xs text-green-600 hover:bg-green-50"
                        onClick={openCreateDialog}
                    >
                        ➕ Create new account {search && `"${search}"`}
                    </div>
                </div>
            )}

            {/* Create Account Dialog */}
            <RadixDialog.Root open={showCreateDialog} onOpenChange={(open) => setShowCreateDialog(open)}>
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] w-full max-w-md -translate-x-1/2 -translate-y-1/2 border border-slate-200 bg-white shadow-xl">
                        <div className="border-b border-slate-100 px-5 py-4">
                            <RadixDialog.Title className="text-base font-semibold text-slate-900">
                                Create New Account
                            </RadixDialog.Title>
                        </div>
                        <div className="px-5 py-4">
                            <div className="flex flex-col gap-4">
                                <div>
                                    <span className="mb-1 block font-medium">Name *</span>
                                    <Input
                                        placeholder="e.g., My Binance, Main Wallet"
                                        value={newAccount.name || ''}
                                        onChange={e => setNewAccount({ ...newAccount, name: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <span className="mb-1 block font-medium">Type *</span>
                                    <select
                                        className="h-9 w-full border border-slate-200 bg-white px-3 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                        value={newAccount.account_type || 'cex'}
                                        onChange={e => setNewAccount({ ...newAccount, account_type: e.target.value as any })}
                                    >
                                        <option value="cex">CEX (Exchange)</option>
                                        <option value="broker">Broker</option>
                                        <option value="wallet">Wallet</option>
                                    </select>
                                </div>
                                <div>
                                    <span className="mb-1 block font-medium">Address / Identifier</span>
                                    <Input
                                        placeholder="e.g., 0x1234... or account ID"
                                        value={newAccount.address_or_identifier || ''}
                                        onChange={e => setNewAccount({ ...newAccount, address_or_identifier: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <span className="mb-1 block font-medium">Tags</span>
                                    <Input
                                        placeholder="e.g., trading, personal (comma-separated)"
                                        value={(newAccount.tags || []).map(t => Object.keys(t)[0]).filter(Boolean).join(', ')}
                                        onChange={e => {
                                            const tagStrings = e.target.value.split(',').map(t => t.trim()).filter(t => t);
                                            const tags = tagStrings.map(tag => ({ [tag]: true }));
                                            setNewAccount({ ...newAccount, tags });
                                        }}
                                    />
                                </div>
                                <div>
                                    <span className="mb-1 block font-medium">Owned</span>
                                    <select
                                        className="h-9 w-full border border-slate-200 bg-white px-3 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                        value={newAccount.owned ? 'true' : 'false'}
                                        onChange={e => setNewAccount({ ...newAccount, owned: e.target.value === 'true' })}
                                    >
                                        <option value="true">Yes (my account)</option>
                                        <option value="false">No (external/counterparty)</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-4">
                            <Button variant="outline" onClick={() => { setShowCreateDialog(false); resetNewAccount(); }}>
                                Cancel
                            </Button>
                            <Button
                                colorScheme="green"
                                onClick={createAccount}
                                loading={creating}
                                disabled={!newAccount.name?.trim()}
                            >
                                Create & Select
                            </Button>
                        </div>
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>
        </div>
    );
};
