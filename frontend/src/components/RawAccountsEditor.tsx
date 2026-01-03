import {
    Badge, Box,
    Button, Dialog, Flex,
    Heading, Input, NativeSelect, Portal, Spinner,
    Table, Text
} from '@chakra-ui/react';
import React, { useEffect, useState } from 'react';
import { API_URL, Account, RawAccount } from '../types';

export const RawAccountsEditor: React.FC = () => {
    const [rawAccounts, setRawAccounts] = useState<RawAccount[]>([]);
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [editingKey, setEditingKey] = useState<string | null>(null);
    const [editAccountId, setEditAccountId] = useState<number | null>(null);
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [newRawAccount, setNewRawAccount] = useState<Partial<RawAccount>>({});
    const [sourceFilter, setSourceFilter] = useState('');
    const [linkedFilter, setLinkedFilter] = useState<string>('');

    useEffect(() => {
        fetchRawAccounts();
        fetchAccounts();
    }, [sourceFilter, linkedFilter]);

    const fetchRawAccounts = async () => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (sourceFilter) params.append('source', sourceFilter);
            if (linkedFilter === 'linked') params.append('has_account_id', 'true');
            if (linkedFilter === 'unlinked') params.append('has_account_id', 'false');
            const response = await fetch(`${API_URL}/raw-accounts?${params}`);
            if (!response.ok) throw new Error('Failed to fetch raw accounts');
            const data = await response.json();
            setRawAccounts(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    };

    const fetchAccounts = async () => {
        try {
            const response = await fetch(`${API_URL}/accounts`);
            if (response.ok) {
                const data = await response.json();
                setAccounts(data);
            }
        } catch (err) {
            console.error('Failed to fetch accounts:', err);
        }
    };

    const getAccountName = (accountId: number | null | undefined) => {
        if (accountId === null || accountId === undefined) return null;
        const account = accounts.find(a => a.id === accountId);
        return account?.name || `ID:${accountId}`;
    };

    const getEditKey = (rawAccount: RawAccount) => `${rawAccount.source}:${rawAccount.label}`;

    const startEditing = (rawAccount: RawAccount) => {
        setEditingKey(getEditKey(rawAccount));
        setEditAccountId(rawAccount.account_id ?? null);
    };

    const saveRawAccount = async (rawAccount: RawAccount) => {
        try {
            const response = await fetch(`${API_URL}/raw-accounts/${encodeURIComponent(rawAccount.source)}/${encodeURIComponent(rawAccount.label)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ account_id: editAccountId })
            });
            if (!response.ok) throw new Error('Failed to update raw account');
            await fetchRawAccounts();
            setEditingKey(null);
            setEditAccountId(null);
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to save');
        }
    };

    const createRawAccount = async () => {
        if (!newRawAccount.label || !newRawAccount.source) {
            alert('Label and Source are required');
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
            await fetchRawAccounts();
            setNewRawAccount({});
            setShowCreateDialog(false);
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to create');
        }
    };

    const deleteRawAccount = async (rawAccount: RawAccount) => {
        if (!window.confirm(`Delete raw account "${rawAccount.label}" from ${rawAccount.source}?`)) return;
        try {
            const response = await fetch(`${API_URL}/raw-accounts/${encodeURIComponent(rawAccount.source)}/${encodeURIComponent(rawAccount.label)}`, {
                method: 'DELETE'
            });
            if (!response.ok) throw new Error('Failed to delete raw account');
            await fetchRawAccounts();
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to delete');
        }
    };

    const unlinkRawAccount = async (rawAccount: RawAccount) => {
        try {
            const response = await fetch(`${API_URL}/raw-accounts/${encodeURIComponent(rawAccount.source)}/${encodeURIComponent(rawAccount.label)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ account_id: null })
            });
            if (!response.ok) throw new Error('Failed to unlink raw account');
            await fetchRawAccounts();
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to unlink');
        }
    };

    // Truncate long labels (like blockchain addresses)
    const truncateLabel = (label: string, maxLength: number = 20) => {
        if (label.length <= maxLength) return label;
        return `${label.slice(0, 8)}...${label.slice(-6)}`;
    };

    // Get unique sources for filter
    const uniqueSources = [...new Set(rawAccounts.map(ra => ra.source))];

    if (loading) return (
        <Box textAlign="center" py={10} bg="gray.50" borderRadius="md">
            <Spinner size="xl" color="blue.500" />
            <Text mt={4}>Loading raw accounts...</Text>
        </Box>
    );

    if (error) return (
        <Box textAlign="center" py={10} bg="red.50" borderRadius="md" borderWidth={1} borderColor="red.200">
            <Text color="red.600">Error: {error}</Text>
        </Box>
    );

    const linkedCount = rawAccounts.filter(ra => ra.account_id !== null && ra.account_id !== undefined).length;
    const unlinkedCount = rawAccounts.filter(ra => ra.account_id === null || ra.account_id === undefined).length;

    return (
        <Box>
            <Flex justify="space-between" align="center" mb={6} borderBottom="1px" borderColor="gray.200" pb={2}>
                <Box>
                    <Heading as="h2" size="md" mb={1}>🔗 Raw Accounts Mapping</Heading>
                    <Text color="gray.600" fontSize="sm">
                        Link source-specific account labels/addresses to normalized accounts.
                    </Text>
                </Box>
                <Flex gap={2}>
                    <Button colorPalette="blue" onClick={() => setShowCreateDialog(true)}>
                        ➕ Add Mapping
                    </Button>
                    <Button onClick={fetchRawAccounts} variant="outline">
                        🔄 Refresh
                    </Button>
                </Flex>
            </Flex>

            <Flex gap={4} mb={6} align="center" flexWrap="wrap">
                <Flex align="center" gap={2}>
                    <Text fontWeight="medium" fontSize="sm">Source:</Text>
                    <NativeSelect.Root size="sm" width="150px">
                        <NativeSelect.Field
                            value={sourceFilter}
                            onChange={e => setSourceFilter(e.target.value)}
                        >
                            <option value="">All Sources</option>
                            {uniqueSources.map(source => (
                                <option key={source} value={source}>{source}</option>
                            ))}
                        </NativeSelect.Field>
                    </NativeSelect.Root>
                </Flex>
                <Flex align="center" gap={2}>
                    <Text fontWeight="medium" fontSize="sm">Status:</Text>
                    <NativeSelect.Root size="sm" width="120px">
                        <NativeSelect.Field
                            value={linkedFilter}
                            onChange={e => setLinkedFilter(e.target.value)}
                        >
                            <option value="">All</option>
                            <option value="linked">Linked</option>
                            <option value="unlinked">Unlinked</option>
                        </NativeSelect.Field>
                    </NativeSelect.Root>
                </Flex>
                {(sourceFilter || linkedFilter) && (
                    <Button size="sm" variant="outline" onClick={() => { setSourceFilter(''); setLinkedFilter(''); }}>
                        Clear Filters
                    </Button>
                )}
            </Flex>

            <Box overflowX="auto" bg="white" borderRadius="md" boxShadow="sm">
                <Table.Root size="sm">
                    <Table.Header>
                        <Table.Row>
                            <Table.ColumnHeader>Label / Address</Table.ColumnHeader>
                            <Table.ColumnHeader>Source</Table.ColumnHeader>
                            <Table.ColumnHeader>Linked Account</Table.ColumnHeader>
                            <Table.ColumnHeader>Status</Table.ColumnHeader>
                            <Table.ColumnHeader>Actions</Table.ColumnHeader>
                        </Table.Row>
                    </Table.Header>
                    <Table.Body>
                        {rawAccounts.length === 0 ? (
                            <Table.Row>
                                <Table.Cell colSpan={5}>
                                    <Text textAlign="center" py={8} color="gray.500">
                                        No raw accounts found
                                    </Text>
                                </Table.Cell>
                            </Table.Row>
                        ) : (
                            rawAccounts.map(rawAccount => {
                                const key = getEditKey(rawAccount);
                                const isEditing = editingKey === key;
                                return (
                                    <Table.Row key={key} bg={rawAccount.account_id === null || rawAccount.account_id === undefined ? 'orange.50' : undefined}>
                                        <Table.Cell>
                                            <Text
                                                fontWeight="medium"
                                                fontSize="sm"
                                                fontFamily="mono"
                                                title={rawAccount.label}
                                            >
                                                {truncateLabel(rawAccount.label)}
                                            </Text>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge colorPalette="purple">{rawAccount.source}</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {isEditing ? (
                                                <NativeSelect.Root size="sm" width="180px">
                                                    <NativeSelect.Field
                                                        value={editAccountId ?? ''}
                                                        onChange={e => setEditAccountId(e.target.value ? Number(e.target.value) : null)}
                                                    >
                                                        <option value="">Select account...</option>
                                                        {accounts.map(account => (
                                                            <option key={account.id} value={account.id}>
                                                                {account.name} ({account.account_type})
                                                            </option>
                                                        ))}
                                                    </NativeSelect.Field>
                                                </NativeSelect.Root>
                                            ) : (
                                                rawAccount.account_id ? (
                                                    <Badge colorPalette="blue">{getAccountName(rawAccount.account_id)}</Badge>
                                                ) : (
                                                    <Text fontSize="sm" color="gray.400">Not linked</Text>
                                                )
                                            )}
                                        </Table.Cell>
                                        <Table.Cell>
                                            {rawAccount.account_id !== null && rawAccount.account_id !== undefined ? (
                                                <Badge colorPalette="green">Linked</Badge>
                                            ) : (
                                                <Badge colorPalette="orange">Unlinked</Badge>
                                            )}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Flex gap={1}>
                                                {isEditing ? (
                                                    <>
                                                        <Button size="xs" colorPalette="blue" onClick={() => saveRawAccount(rawAccount)}>
                                                            💾
                                                        </Button>
                                                        <Button size="xs" variant="outline" onClick={() => { setEditingKey(null); setEditAccountId(null); }}>
                                                            ✗
                                                        </Button>
                                                    </>
                                                ) : (
                                                    <>
                                                        <Button size="xs" variant="outline" onClick={() => startEditing(rawAccount)}>
                                                            🔗
                                                        </Button>
                                                        {rawAccount.account_id !== null && rawAccount.account_id !== undefined && (
                                                            <Button size="xs" colorPalette="orange" variant="outline" onClick={() => unlinkRawAccount(rawAccount)}>
                                                                ⛓️‍💥
                                                            </Button>
                                                        )}
                                                        <Button size="xs" colorPalette="red" variant="outline" onClick={() => deleteRawAccount(rawAccount)}>
                                                            🗑️
                                                        </Button>
                                                    </>
                                                )}
                                            </Flex>
                                        </Table.Cell>
                                    </Table.Row>
                                );
                            })
                        )}
                    </Table.Body>
                </Table.Root>
            </Box>

            <Box mt={4} p={4} bg="white" borderRadius="md" boxShadow="sm">
                <Text fontSize="sm" color="gray.600">
                    <strong>Total:</strong> {rawAccounts.length} raw accounts
                    {' • '}<Badge colorPalette="green" size="sm">{linkedCount} linked</Badge>
                    {' • '}<Badge colorPalette="orange" size="sm">{unlinkedCount} unlinked</Badge>
                </Text>
            </Box>

            {/* Create Raw Account Dialog */}
            <Dialog.Root open={showCreateDialog} onOpenChange={(e) => setShowCreateDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>Add Raw Account Mapping</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Flex direction="column" gap={4}>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Source *</Text>
                                        <Input
                                            placeholder="e.g., blockscout_base, etherscan"
                                            value={newRawAccount.source || ''}
                                            onChange={e => setNewRawAccount({ ...newRawAccount, source: e.target.value })}
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Label / Address *</Text>
                                        <Input
                                            placeholder="e.g., 0x1234... or account name"
                                            value={newRawAccount.label || ''}
                                            onChange={e => setNewRawAccount({ ...newRawAccount, label: e.target.value })}
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Link to Account (optional)</Text>
                                        <NativeSelect.Root>
                                            <NativeSelect.Field
                                                value={newRawAccount.account_id ?? ''}
                                                onChange={e => setNewRawAccount({ ...newRawAccount, account_id: e.target.value ? Number(e.target.value) : undefined })}
                                            >
                                                <option value="">Select account...</option>
                                                {accounts.map(account => (
                                                    <option key={account.id} value={account.id}>
                                                        {account.name} ({account.account_type})
                                                    </option>
                                                ))}
                                            </NativeSelect.Field>
                                        </NativeSelect.Root>
                                    </Box>
                                </Flex>
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => { setShowCreateDialog(false); setNewRawAccount({}); }}>
                                        Cancel
                                    </Button>
                                    <Button colorPalette="blue" onClick={createRawAccount}>
                                        Create Mapping
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
