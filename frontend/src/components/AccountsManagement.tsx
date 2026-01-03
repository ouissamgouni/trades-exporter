import {
    Badge, Box,
    Button, Collapsible, Heading, HStack, IconButton, Input,
    Table, Text, useDisclosure, VStack
} from '@chakra-ui/react';
import React, { useEffect, useState } from 'react';
import { FiChevronDown, FiChevronRight, FiEdit2, FiPlus, FiSettings, FiTrash2 } from 'react-icons/fi';
import { Account, API_URL } from '../types';
import AccountConnectors from './AccountConnectors';
import AccountFormDialog from './AccountFormDialog';

const AccountsManagement: React.FC = () => {
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [filteredAccounts, setFilteredAccounts] = useState<Account[]>([]);
    const [loading, setLoading] = useState(false);
    const [searchText, setSearchText] = useState('');
    const [accountTypeFilter, setAccountTypeFilter] = useState<string>('');
    const [editingAccount, setEditingAccount] = useState<Account | null>(null);
    const [expandedAccountId, setExpandedAccountId] = useState<number | null>(null);
    const { open: isDialogOpen, onOpen: openDialog, onClose: closeDialog } = useDisclosure();

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

    const handleDelete = async (accountId: number) => {
        if (!confirm('Are you sure you want to delete this account?')) return;

        try {
            const response = await fetch(`${API_URL}/accounts/${accountId}`, {
                method: 'DELETE',
            });
            if (!response.ok) throw new Error('Failed to delete account');

            fetchAccounts();
        } catch (error) {
            console.error('Error deleting account:', error);
            alert('Failed to delete account');
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
        setExpandedAccountId(prev => prev === accountId ? null : accountId);
    };

    return (
        <Box p={6}>
            <VStack align="stretch" gap={4}>
                {/* Header */}
                <HStack justify="space-between">
                    <Heading size="lg">Accounts Management</Heading>
                    <Button
                        colorScheme="blue"
                        onClick={handleCreate}
                    >
                        <FiPlus /> Add Account
                    </Button>
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

                {/* Table */}
                <Box overflowX="auto" borderWidth="1px" borderRadius="lg">
                    <Table.Root size="sm">
                        <Table.Header>
                            <Table.Row>
                                <Table.ColumnHeader>Name</Table.ColumnHeader>
                                <Table.ColumnHeader>Type</Table.ColumnHeader>
                                <Table.ColumnHeader>Address/Identifier</Table.ColumnHeader>
                                <Table.ColumnHeader>Tags</Table.ColumnHeader>
                                <Table.ColumnHeader>Created</Table.ColumnHeader>
                                <Table.ColumnHeader textAlign="right">Actions</Table.ColumnHeader>
                            </Table.Row>
                        </Table.Header>
                        <Table.Body>
                            {loading ? (
                                <Table.Row>
                                    <Table.Cell colSpan={6}>
                                        <Text textAlign="center" py={4}>Loading accounts...</Text>
                                    </Table.Cell>
                                </Table.Row>
                            ) : filteredAccounts.length === 0 ? (
                                <Table.Row>
                                    <Table.Cell colSpan={6}>
                                        <Text textAlign="center" py={4}>No accounts found</Text>
                                    </Table.Cell>
                                </Table.Row>
                            ) : (
                                filteredAccounts.map((account) => {
                                    const getRowBgColor = (type: string) => {
                                        switch (type) {
                                            case 'cex': return 'blue.50';
                                            case 'broker': return 'green.50';
                                            case 'wallet': return 'purple.50';
                                            default: return undefined;
                                        }
                                    };
                                    return (
                                        <React.Fragment key={account.id}>
                                            <Table.Row
                                                cursor="pointer"
                                                bg={getRowBgColor(account.account_type)}
                                                _hover={{ bg: 'gray.100' }}
                                                onClick={() => toggleExpand(account.id)}
                                            >
                                                <Table.Cell>
                                                    <HStack>
                                                        {expandedAccountId === account.id ? (
                                                            <FiChevronDown />
                                                        ) : (
                                                            <FiChevronRight />
                                                        )}
                                                        <Text fontWeight="medium">{account.name}</Text>
                                                    </HStack>
                                                </Table.Cell>
                                                <Table.Cell>
                                                    <Badge colorScheme={getAccountTypeBadgeColor(account.account_type)}>
                                                        {account.account_type.toUpperCase()}
                                                    </Badge>
                                                </Table.Cell>
                                                <Table.Cell>
                                                    <Text fontSize="sm" color="gray.600" truncate maxW="300px">
                                                        {account.address_or_identifier || '-'}
                                                    </Text>
                                                </Table.Cell>
                                                <Table.Cell>
                                                    <HStack gap={1} flexWrap="wrap">
                                                        {account.tags?.slice(0, 3).map((tag, idx) => (
                                                            <Badge key={idx} size="sm" variant="subtle">
                                                                {tag}
                                                            </Badge>
                                                        ))}
                                                        {account.tags?.length > 3 && (
                                                            <Badge size="sm" variant="subtle">
                                                                +{account.tags.length - 3}
                                                            </Badge>
                                                        )}
                                                    </HStack>
                                                </Table.Cell>
                                                <Table.Cell>
                                                    <Text fontSize="sm" color="gray.600">
                                                        {new Date(account.created_at).toLocaleDateString()}
                                                    </Text>
                                                </Table.Cell>
                                                <Table.Cell textAlign="right">
                                                    <HStack justify="flex-end" gap={2} onClick={(e) => e.stopPropagation()}>
                                                        <IconButton
                                                            aria-label="Configure connectors"
                                                            size="sm"
                                                            variant="ghost"
                                                            colorScheme="purple"
                                                            onClick={() => toggleExpand(account.id)}
                                                        >
                                                            <FiSettings />
                                                        </IconButton>
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
                                                </Table.Cell>
                                            </Table.Row>
                                            {/* Expanded Connectors Panel */}
                                            {expandedAccountId === account.id && (
                                                <Table.Row>
                                                    <Table.Cell colSpan={6} bg="gray.50" p={4}>
                                                        <AccountConnectors account={account} />
                                                    </Table.Cell>
                                                </Table.Row>
                                            )}
                                        </React.Fragment>
                                    )
                                })
                            )}
                        </Table.Body>
                    </Table.Root>
                </Box>

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
        </Box>
    );
};

export default AccountsManagement;
