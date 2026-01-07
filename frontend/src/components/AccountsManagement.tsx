import {
    Badge, Box,
    Button, Card, Collapsible, Heading, HStack, IconButton, Input,
    Switch, Table, Text, useDisclosure, VStack
} from '@chakra-ui/react';
import React, { useEffect, useState } from 'react';
import { FiChevronDown, FiChevronRight, FiEdit2, FiPlus, FiTrash2 } from 'react-icons/fi';
import { Account, API_URL } from '../types';
import AccountConnectors from './AccountConnectors';
import AccountFormDialog from './AccountFormDialog';
import { ConfirmDialog, useConfirmDialog } from './ui/ConfirmDialog';
import { toaster } from './ui/toaster';

const AccountsManagement: React.FC = () => {
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [filteredAccounts, setFilteredAccounts] = useState<Account[]>([]);
    const [loading, setLoading] = useState(false);
    const [searchText, setSearchText] = useState('');
    const [accountTypeFilter, setAccountTypeFilter] = useState<string>('');
    const [editingAccount, setEditingAccount] = useState<Account | null>(null);
    const [expandedAccountIds, setExpandedAccountIds] = useState<Set<number>>(new Set());
    const { open: isDialogOpen, onOpen: openDialog, onClose: closeDialog } = useDisclosure();

    const deleteConfirm = useConfirmDialog<number>();

    const fetchAccounts = async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (accountTypeFilter) params.append('account_type', accountTypeFilter);
            if (searchText) params.append('search', searchText);

            const response = await fetch(`${API_URL}/accounts/?${params.toString()}`);
            if (!response.ok) throw new Error('Failed to fetch accounts');

            const data = await response.json();
            setAccounts(data);
            setFilteredAccounts(data);
        } catch (error) {
            console.error('Error fetching accounts:', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchAccounts();
    }, [accountTypeFilter, searchText]);

    const handleDelete = (accountId: number) => {
        deleteConfirm.open(accountId);
    };

    const executeDelete = async () => {
        if (!deleteConfirm.data) return;
        const accountId = deleteConfirm.data;
        try {
            const response = await fetch(`${API_URL}/accounts/${accountId}`, {
                method: 'DELETE',
            });
            if (!response.ok) throw new Error('Failed to delete account');

            fetchAccounts();
        } catch (error) {
            console.error('Error deleting account:', error);
            toaster.error({ title: 'Error', description: 'Failed to delete account' });
        }
    };

    const handleEdit = (account: Account) => {
        setEditingAccount(account);
        openDialog();
    };

    const handleCreate = () => {
        setEditingAccount(null);
        openDialog();
    };

    const handleDialogClose = () => {
        setEditingAccount(null);
        closeDialog();
        fetchAccounts();
    };

    const getAccountTypeBadgeColor = (type: string) => {
        switch (type) {
            case 'cex': return 'blue';
            case 'broker': return 'green';
            case 'wallet': return 'purple';
            default: return 'gray';
        }
    };

    const toggleExpand = (accountId: number) => {
        setExpandedAccountIds(prev => {
            const next = new Set(prev);
            if (next.has(accountId)) {
                next.delete(accountId);
            } else {
                next.add(accountId);
            }
            return next;
        });
    };

    const expandAll = () => {
        setExpandedAccountIds(new Set(filteredAccounts.map(a => a.id)));
    };

    const collapseAll = () => {
        setExpandedAccountIds(new Set());
    };

    const getAccountTypeIcon = (type: string) => {
        switch (type) {
            case 'cex': return '🏦';
            case 'broker': return '📈';
            case 'wallet': return '👛';
            default: return '📁';
        }
    };

    const toggleAccountEnabled = async (accountId: number, currentEnabled: boolean) => {
        try {
            const response = await fetch(`${API_URL}/accounts/${accountId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: !currentEnabled }),
            });
            if (!response.ok) throw new Error('Failed to update account');

            // Update local state
            setAccounts(prev => prev.map(a =>
                a.id === accountId ? { ...a, enabled: !currentEnabled } : a
            ));
            setFilteredAccounts(prev => prev.map(a =>
                a.id === accountId ? { ...a, enabled: !currentEnabled } : a
            ));

            toaster.success({
                title: 'Account Updated',
                description: `Account ${!currentEnabled ? 'enabled' : 'disabled'} for syncing`,
            });
        } catch (error) {
            console.error('Error toggling account enabled:', error);
            toaster.error({ title: 'Error', description: 'Failed to update account' });
        }
    };

    return (
        <Box p={6}>
            <VStack align="stretch" gap={4}>
                {/* Header */}
                <HStack justify="space-between">
                    <Box>
                        <Heading size="lg">Accounts & Connectors</Heading>
                        <Text fontSize="sm" color="gray.600" mt={1}>
                            Manage accounts with their data connectors inline. Click an account to configure connectors.
                        </Text>
                    </Box>
                    <HStack gap={2}>
                        <Button size="sm" variant="ghost" onClick={expandAll}>
                            Expand All
                        </Button>
                        <Button size="sm" variant="ghost" onClick={collapseAll}>
                            Collapse All
                        </Button>
                        <Button
                            colorScheme="blue"
                            onClick={handleCreate}
                        >
                            <FiPlus /> Add Account
                        </Button>
                    </HStack>
                </HStack>

                {/* Filters */}
                <HStack gap={4}>
                    <Input
                        placeholder="Search by name or identifier..."
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        maxW="400px"
                    />
                    <HStack>
                        <Button
                            size="sm"
                            variant={accountTypeFilter === '' ? 'solid' : 'outline'}
                            onClick={() => setAccountTypeFilter('')}
                        >
                            All
                        </Button>
                        <Button
                            size="sm"
                            variant={accountTypeFilter === 'cex' ? 'solid' : 'outline'}
                            colorScheme="blue"
                            onClick={() => setAccountTypeFilter('cex')}
                        >
                            CEX
                        </Button>
                        <Button
                            size="sm"
                            variant={accountTypeFilter === 'broker' ? 'solid' : 'outline'}
                            colorScheme="green"
                            onClick={() => setAccountTypeFilter('broker')}
                        >
                            Broker
                        </Button>
                        <Button
                            size="sm"
                            variant={accountTypeFilter === 'wallet' ? 'solid' : 'outline'}
                            colorScheme="purple"
                            onClick={() => setAccountTypeFilter('wallet')}
                        >
                            Wallet
                        </Button>
                    </HStack>
                </HStack>

                {/* Accounts as Expandable Cards */}
                <VStack align="stretch" gap={3}>
                    {loading ? (
                        <Box textAlign="center" py={8}>
                            <Text>Loading accounts...</Text>
                        </Box>
                    ) : filteredAccounts.length === 0 ? (
                        <Box textAlign="center" py={8} bg="gray.50" borderRadius="lg">
                            <Text color="gray.600" mb={4}>No accounts found</Text>
                            <Button colorScheme="blue" onClick={handleCreate}>
                                <FiPlus /> Create Your First Account
                            </Button>
                        </Box>
                    ) : (
                        filteredAccounts.map((account) => {
                            const isExpanded = expandedAccountIds.has(account.id);
                            const isEnabled = account.enabled !== false;
                            const bgColor = isEnabled ? ({
                                cex: 'blue.50',
                                broker: 'green.50',
                                wallet: 'purple.50'
                            }[account.account_type] || 'gray.50') : 'gray.100';

                            return (
                                <Card.Root key={account.id} variant="outline" opacity={isEnabled ? 1 : 0.7}>
                                    {/* Account Header - Clickable */}
                                    <Card.Body p={0}>
                                        <Box
                                            p={4}
                                            cursor="pointer"
                                            bg={bgColor}
                                            borderBottomWidth={isExpanded ? 1 : 0}
                                            borderColor="gray.200"
                                            onClick={() => toggleExpand(account.id)}
                                            _hover={{ opacity: 0.9 }}
                                            transition="all 0.15s"
                                        >
                                            <HStack justify="space-between">
                                                <HStack gap={3}>
                                                    {isExpanded ? <FiChevronDown /> : <FiChevronRight />}
                                                    <Text fontSize="lg">{getAccountTypeIcon(account.account_type)}</Text>
                                                    <Box>
                                                        <HStack gap={2}>
                                                            <Text fontWeight="semibold">{account.name}</Text>
                                                            <Badge colorScheme={getAccountTypeBadgeColor(account.account_type)}>
                                                                {account.account_type.toUpperCase()}
                                                            </Badge>
                                                        </HStack>
                                                        {account.address_or_identifier && (
                                                            <Text fontSize="xs" color="gray.600" fontFamily="mono">
                                                                {account.address_or_identifier.length > 40
                                                                    ? `${account.address_or_identifier.slice(0, 20)}...${account.address_or_identifier.slice(-10)}`
                                                                    : account.address_or_identifier}
                                                            </Text>
                                                        )}
                                                    </Box>
                                                </HStack>
                                                <HStack gap={2} onClick={(e) => e.stopPropagation()}>
                                                    {/* Enabled Toggle */}
                                                    <HStack gap={1} title={account.enabled !== false ? 'Click to disable syncing' : 'Click to enable syncing'}>
                                                        <Text fontSize="xs" color={account.enabled !== false ? 'green.600' : 'gray.400'}>
                                                            {account.enabled !== false ? 'Sync On' : 'Sync Off'}
                                                        </Text>
                                                        <Switch.Root
                                                            size="sm"
                                                            checked={account.enabled !== false}
                                                            onCheckedChange={() => toggleAccountEnabled(account.id, account.enabled !== false)}
                                                        >
                                                            <Switch.HiddenInput />
                                                            <Switch.Control>
                                                                <Switch.Thumb />
                                                            </Switch.Control>
                                                        </Switch.Root>
                                                    </HStack>
                                                    {account.tags?.slice(0, 2).map((tag, idx) => (
                                                        <Badge key={idx} size="sm" variant="subtle">
                                                            {tag}
                                                        </Badge>
                                                    ))}
                                                    <IconButton
                                                        aria-label="Edit account"
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={() => handleEdit(account)}
                                                    >
                                                        <FiEdit2 />
                                                    </IconButton>
                                                    <IconButton
                                                        aria-label="Delete account"
                                                        size="sm"
                                                        variant="ghost"
                                                        colorScheme="red"
                                                        onClick={() => handleDelete(account.id)}
                                                    >
                                                        <FiTrash2 />
                                                    </IconButton>
                                                </HStack>
                                            </HStack>
                                            {!isExpanded && (
                                                <Text fontSize="xs" color="gray.500" ml={10} mt={1}>
                                                    Click to configure connectors →
                                                </Text>
                                            )}
                                        </Box>

                                        {/* Inline Connectors Panel */}
                                        <Collapsible.Root open={isExpanded}>
                                            <Collapsible.Content>
                                                <Box p={4} bg="white">
                                                    <AccountConnectors account={account} />
                                                </Box>
                                            </Collapsible.Content>
                                        </Collapsible.Root>
                                    </Card.Body>
                                </Card.Root>
                            );
                        })
                    )}
                </VStack>

                {/* Summary */}
                <Text fontSize="sm" color="gray.600">
                    Showing {filteredAccounts.length} account{filteredAccounts.length !== 1 ? 's' : ''}
                </Text>
            </VStack>

            {/* Dialog */}
            <AccountFormDialog
                isOpen={isDialogOpen}
                onClose={handleDialogClose}
                account={editingAccount}
            />

            {/* Delete Confirmation Dialog */}
            <ConfirmDialog
                isOpen={deleteConfirm.isOpen}
                onClose={deleteConfirm.close}
                onConfirm={executeDelete}
                title="Delete Account"
                message="Are you sure you want to delete this account?"
                confirmLabel="Delete"
                isDestructive
            />
        </Box>
    );
};

export default AccountsManagement;
