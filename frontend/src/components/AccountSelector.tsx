import {
    Box,
    Button, Dialog, Flex, Input, NativeSelect, Portal, Text
} from '@chakra-ui/react';
import React, { useEffect, useRef, useState } from 'react';
import { API_URL, Account } from '../types';
import { toaster } from './ui/toaster';

interface AccountSelectorProps {
    value: number | null;
    onChange: (accountId: number | null) => void;
    accounts: Account[];
    onAccountCreated?: () => void;
    placeholder?: string;
    defaultName?: string; // Pre-fill new account name
    size?: 'sm' | 'md';
    // For linking raw_account when creating new account from mapping context
    rawAccountSource?: string;
    rawAccountLabel?: string;
}

export const AccountSelector: React.FC<AccountSelectorProps> = ({
    value,
    onChange,
    accounts,
    onAccountCreated,
    placeholder = 'Search or select account...',
    defaultName = '',
    size = 'sm',
    rawAccountSource,
    rawAccountLabel,
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

    const linkRawAccount = async (accountId: number) => {
        // If raw account context is provided, link the raw_account to the account
        if (rawAccountSource && rawAccountLabel && accountId) {
            try {
                // First try to PATCH (update existing raw account)
                const patchResponse = await fetch(`${API_URL}/raw-accounts/${encodeURIComponent(rawAccountSource)}/${encodeURIComponent(rawAccountLabel)}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ account_id: accountId })
                });

                // If raw account doesn't exist (404), create it
                if (patchResponse.status === 404) {
                    await fetch(`${API_URL}/raw-accounts`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            label: rawAccountLabel,
                            source: rawAccountSource,
                            account_id: accountId
                        })
                    });
                }
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
            await linkRawAccount(accountId);
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
                await linkRawAccount(created.id);
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
        <Box position="relative" ref={containerRef}>
            <Input
                size={size}
                value={isOpen ? search : (selectedAccount ? selectedAccount.name : '')}
                onChange={e => {
                    setSearch(e.target.value);
                    if (!isOpen) setIsOpen(true);
                }}
                onFocus={() => setIsOpen(true)}
                placeholder={placeholder}
                bg="white"
            />

            {isOpen && (
                <Box
                    position="absolute"
                    top="100%"
                    left={0}
                    right={0}
                    zIndex={1000}
                    bg="white"
                    border="1px solid"
                    borderColor="gray.200"
                    borderRadius="md"
                    boxShadow="lg"
                    maxH="250px"
                    overflowY="auto"
                    mt={1}
                >
                    {/* Clear selection option */}
                    <Box
                        p={2}
                        cursor="pointer"
                        _hover={{ bg: 'gray.100' }}
                        onClick={() => handleSelect(null)}
                        color="gray.500"
                        fontSize="sm"
                    >
                        -- Not linked --
                    </Box>

                    {/* Filtered accounts */}
                    {filteredAccounts.map(account => (
                        <Box
                            key={account.id}
                            p={2}
                            cursor="pointer"
                            bg={value === account.id ? 'blue.50' : undefined}
                            _hover={{ bg: 'blue.100' }}
                            onClick={() => handleSelect(account.id)}
                            fontSize="sm"
                        >
                            <Text fontWeight="medium">{account.name}</Text>
                            <Text fontSize="xs" color="gray.500">
                                {account.account_type}
                                {account.address_or_identifier && ` • ${account.address_or_identifier.slice(0, 12)}...`}
                            </Text>
                        </Box>
                    ))}

                    {/* No results */}
                    {filteredAccounts.length === 0 && (
                        <Box p={2} color="gray.500" fontSize="sm">
                            No accounts found
                        </Box>
                    )}

                    {/* Create new account option */}
                    <Box
                        p={2}
                        cursor="pointer"
                        _hover={{ bg: 'green.50' }}
                        onClick={openCreateDialog}
                        color="green.600"
                        fontSize="sm"
                        borderTop="1px solid"
                        borderColor="gray.100"
                    >
                        ➕ Create new account {search && `"${search}"`}
                    </Box>
                </Box>
            )}

            {/* Create Account Dialog */}
            <Dialog.Root open={showCreateDialog} onOpenChange={(e) => setShowCreateDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>Create New Account</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Flex direction="column" gap={4}>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Name *</Text>
                                        <Input
                                            placeholder="e.g., My Binance, Main Wallet"
                                            value={newAccount.name || ''}
                                            onChange={e => setNewAccount({ ...newAccount, name: e.target.value })}
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Type *</Text>
                                        <NativeSelect.Root>
                                            <NativeSelect.Field
                                                value={newAccount.account_type || 'cex'}
                                                onChange={e => setNewAccount({ ...newAccount, account_type: e.target.value as any })}
                                            >
                                                <option value="cex">CEX (Exchange)</option>
                                                <option value="broker">Broker</option>
                                                <option value="wallet">Wallet</option>
                                            </NativeSelect.Field>
                                        </NativeSelect.Root>
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Address / Identifier</Text>
                                        <Input
                                            placeholder="e.g., 0x1234... or account ID"
                                            value={newAccount.address_or_identifier || ''}
                                            onChange={e => setNewAccount({ ...newAccount, address_or_identifier: e.target.value })}
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Tags</Text>
                                        <Input
                                            placeholder="e.g., trading, personal (comma-separated)"
                                            value={(newAccount.tags || []).join(', ')}
                                            onChange={e => setNewAccount({ ...newAccount, tags: e.target.value.split(',').map(t => t.trim()).filter(t => t) })}
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Owned</Text>
                                        <NativeSelect.Root>
                                            <NativeSelect.Field
                                                value={newAccount.owned ? 'true' : 'false'}
                                                onChange={e => setNewAccount({ ...newAccount, owned: e.target.value === 'true' })}
                                            >
                                                <option value="true">Yes (my account)</option>
                                                <option value="false">No (external/counterparty)</option>
                                            </NativeSelect.Field>
                                        </NativeSelect.Root>
                                    </Box>
                                </Flex>
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => { setShowCreateDialog(false); resetNewAccount(); }}>
                                        Cancel
                                    </Button>
                                    <Button
                                        colorPalette="green"
                                        onClick={createAccount}
                                        loading={creating}
                                        disabled={!newAccount.name?.trim()}
                                    >
                                        Create & Select
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>
        </Box>
    );
};
