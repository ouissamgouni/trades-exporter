import {
    Badge, Box,
    Button, Card, Collapsible, Flex, Heading, HStack, IconButton, Input,
    SimpleGrid, Switch, Text, useDisclosure, VStack, Wrap
} from '@chakra-ui/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FiChevronDown, FiChevronRight, FiPieChart, FiEdit2, FiPlus, FiTrash2 } from 'react-icons/fi';
import { LuEraser } from 'react-icons/lu';
import { BalanceDrawer } from './BalanceDrawer';
import { Account, API_URL } from '../types';
import AccountConnectors from './AccountConnectors';
import AccountFormDialog from './AccountFormDialog';
import { DeleteAccountDialog } from './DeleteAccountDialog';
import { CleanupDialog } from './CleanupDialog';
import { toaster } from './ui/toaster';

const AccountsManagement: React.FC = () => {
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [filteredAccounts, setFilteredAccounts] = useState<Account[]>([]);
    const [loading, setLoading] = useState(false);
    const [searchText, setSearchText] = useState('');
    const [editingAccount, setEditingAccount] = useState<Account | null>(null);
    const [expandedAccountIds, setExpandedAccountIds] = useState<Set<number>>(new Set());
    const { open: isDialogOpen, onOpen: openDialog, onClose: closeDialog } = useDisclosure();

    // Delete dialog state
    const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null);
    const isDeleteOpen = deleteTarget !== null;

    // Balance drawer state
    const [balanceDrawerOpen, setBalanceDrawerOpen] = useState(false);
    const [balanceMode, setBalanceMode] = useState<'global' | 'account'>('global');
    const [balanceAccountId, setBalanceAccountId] = useState<number | undefined>();
    const [balanceTitle, setBalanceTitle] = useState<string>('');

    // Cleanup dialog state
    const [cleanupTarget, setCleanupTarget] = useState<{ accountId: number; title: string } | null>(null);
    const isCleanupOpen = cleanupTarget !== null;

    const handleBalanceClick = (account: Account) => {
        setBalanceMode('account');
        setBalanceAccountId(account.id);
        setBalanceTitle(`${account.name} Balance`);
        setBalanceDrawerOpen(true);
    };

    const handleGlobalBalanceClick = () => {
        setBalanceMode('global');
        setBalanceAccountId(undefined);
        setBalanceTitle('Global Balance');
        setBalanceDrawerOpen(true);
    };

    const handlePurgeAccount = (account: Account) => {
        setCleanupTarget({
            accountId: account.id,
            title: `Purge All Data: ${account.name}`,
        });
    };

    const handleCleanupClose = () => {
        setCleanupTarget(null);
    };

    const handleCleanupCompleted = () => {
        setCleanupTarget(null);
        fetchAccounts();
    };

    const fetchAccounts = async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
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
    }, [searchText]);

    const handleDelete = (account: Account) => {
        setDeleteTarget({ id: account.id, name: account.name });
    };

    const handleDeleteClose = () => {
        setDeleteTarget(null);
    };

    const handleDeleted = () => {
        setDeleteTarget(null);
        fetchAccounts();
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

    // Type metadata for badges and colors
    const TYPE_META: Record<string, { label: string; color: string; borderColor: string }> = {
        cex: { label: 'CEX', color: 'blue', borderColor: 'blue.400' },
        dex: { label: 'DEX', color: 'cyan', borderColor: 'cyan.400' },
        wallet: { label: 'Wallet', color: 'purple', borderColor: 'purple.400' },
        broker: { label: 'Broker', color: 'green', borderColor: 'green.400' },
        bank: { label: 'Bank', color: 'teal', borderColor: 'teal.400' },
        investment: { label: 'Invest', color: 'orange', borderColor: 'orange.400' },
    };

    // Filter chip state
    const [activeTypeFilters, setActiveTypeFilters] = useState<Set<string>>(new Set());
    const [activeGroupFilters, setActiveGroupFilters] = useState<Set<string>>(new Set());

    const toggleTypeFilter = useCallback((type: string) => {
        setActiveTypeFilters(prev => {
            const next = new Set(prev);
            if (next.has(type)) next.delete(type);
            else next.add(type);
            return next;
        });
    }, []);

    const toggleGroupFilter = useCallback((group: string) => {
        setActiveGroupFilters(prev => {
            const next = new Set(prev);
            if (next.has(group)) next.delete(group);
            else next.add(group);
            return next;
        });
    }, []);

    // Derive available types and groups from data
    const availableTypes = useMemo(() => {
        const types = new Set(filteredAccounts.map(a => a.account_type));
        return ['cex', 'dex', 'wallet', 'broker', 'bank', 'investment'].filter(t => types.has(t as any));
    }, [filteredAccounts]);

    const availableGroups = useMemo(() => {
        const groups = new Set(filteredAccounts.map(a => a.group).filter(Boolean) as string[]);
        return Array.from(groups).sort();
    }, [filteredAccounts]);

    // Flat sorted + filtered account list
    const displayedAccounts = useMemo(() => {
        let list = [...filteredAccounts];
        if (activeTypeFilters.size > 0) {
            list = list.filter(a => activeTypeFilters.has(a.account_type));
        }
        if (activeGroupFilters.size > 0) {
            list = list.filter(a => a.group && activeGroupFilters.has(a.group));
        }
        const typeOrder = ['cex', 'dex', 'wallet', 'broker', 'bank', 'investment'];
        list.sort((a, b) => {
            const typeA = typeOrder.indexOf(a.account_type);
            const typeB = typeOrder.indexOf(b.account_type);
            if (typeA !== typeB) return typeA - typeB;
            const groupA = (a.group || '').toLowerCase();
            const groupB = (b.group || '').toLowerCase();
            if (groupA !== groupB) return groupA.localeCompare(groupB);
            return a.name.localeCompare(b.name);
        });
        return list;
    }, [filteredAccounts, activeTypeFilters, activeGroupFilters]);

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
                        <Button size="sm" variant="ghost" onClick={handleGlobalBalanceClick}>
                            <FiPieChart /> Balance
                        </Button>
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

                {/* Search + Filter Chips */}
                <VStack align="stretch" gap={2}>
                    <Input
                        placeholder="Search by name or identifier..."
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        maxW="400px"
                        size="sm"
                    />
                    {(availableTypes.length > 1 || availableGroups.length > 0) && (
                        <Wrap gap={1.5}>
                            {availableTypes.map(type => {
                                const meta = TYPE_META[type];
                                const isActive = activeTypeFilters.has(type);
                                const count = filteredAccounts.filter(a => a.account_type === type).length;
                                return (
                                    <Badge
                                        key={type}
                                        size="sm"
                                        variant={isActive ? 'solid' : 'outline'}
                                        colorPalette={meta?.color || 'gray'}
                                        cursor="pointer"
                                        onClick={() => toggleTypeFilter(type)}
                                        _hover={{ opacity: 0.8 }}
                                        userSelect="none"
                                    >
                                        {meta?.label || type} ({count})
                                    </Badge>
                                );
                            })}
                            {availableGroups.length > 0 && (
                                <Box borderLeftWidth="1px" borderColor="gray.300" h="20px" mx={1} />
                            )}
                            {availableGroups.map(group => {
                                const isActive = activeGroupFilters.has(group);
                                const count = filteredAccounts.filter(a => a.group === group).length;
                                return (
                                    <Badge
                                        key={group}
                                        size="sm"
                                        variant={isActive ? 'solid' : 'outline'}
                                        colorPalette="gray"
                                        cursor="pointer"
                                        onClick={() => toggleGroupFilter(group)}
                                        _hover={{ opacity: 0.8 }}
                                        userSelect="none"
                                    >
                                        {group} ({count})
                                    </Badge>
                                );
                            })}
                        </Wrap>
                    )}
                </VStack>

                {/* Account Cards */}
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
                ) : displayedAccounts.length === 0 ? (
                    <Box textAlign="center" py={6}>
                        <Text color="gray.500" fontSize="sm">No accounts match the selected filters</Text>
                    </Box>
                ) : (
                    <SimpleGrid columns={{ base: 1, md: 2, lg: 3, xl: 4 }} gap={1.5}>
                        {displayedAccounts.map((account) => {
                            const isExpanded = expandedAccountIds.has(account.id);
                            const isEnabled = account.enabled !== false;
                            const meta = TYPE_META[account.account_type];

                            return (
                                <Card.Root
                                    key={account.id}
                                    variant="outline"
                                    opacity={isEnabled ? 1 : 0.6}
                                    size="sm"
                                    borderLeftWidth="3px"
                                    borderLeftColor={meta?.borderColor || 'gray.300'}
                                    gridColumn={isExpanded ? '1 / -1' : undefined}
                                >
                                    <Card.Body p={0}>
                                        <Box
                                            py={0.5}
                                            px={1.5}
                                            cursor="pointer"
                                            bg={isEnabled ? 'white' : 'gray.50'}
                                            borderBottomWidth={isExpanded ? 1 : 0}
                                            borderColor="gray.200"
                                            onClick={() => toggleExpand(account.id)}
                                            _hover={{ bg: 'gray.50' }}
                                            transition="all 0.1s"
                                        >
                                            {/* Type / Group header line */}
                                            <Flex align="center" gap={1} mb={-0.5}>
                                                <Text fontSize="2xs" color={`${meta?.color || 'gray'}.400`} fontWeight="medium" textTransform="uppercase" letterSpacing="wider">
                                                    {meta?.label || account.account_type}
                                                </Text>
                                                {account.envelope && (
                                                    <Badge
                                                        size="xs"
                                                        variant="subtle"
                                                        fontSize="2xs"
                                                        colorPalette={account.envelope === 'pea' ? 'green' : account.envelope === 'av' ? 'blue' : 'gray'}
                                                    >
                                                        {account.envelope.toUpperCase()}
                                                    </Badge>
                                                )}
                                                {account.group && (
                                                    <>
                                                        <Text fontSize="2xs" color="gray.300">/</Text>
                                                        <Text fontSize="2xs" color="gray.400">
                                                            {account.group}
                                                        </Text>
                                                    </>
                                                )}
                                            </Flex>
                                            <Flex justify="space-between" align="center">
                                                <Flex align="center" gap={1} minW={0} flex={1}>
                                                    <Box color="gray.400" flexShrink={0}>
                                                        {isExpanded ? <FiChevronDown size={10} /> : <FiChevronRight size={10} />}
                                                    </Box>
                                                    {account.color && (
                                                        <Box w="7px" h="7px" borderRadius="full" bg={account.color} flexShrink={0} />
                                                    )}
                                                    <Text fontWeight="semibold" fontSize="xs" truncate>
                                                        {account.name}
                                                    </Text>
                                                </Flex>
                                                <Flex align="center" gap={0} flexShrink={0} onClick={(e) => e.stopPropagation()}>
                                                    <Switch.Root
                                                        size="sm"
                                                        checked={isEnabled}
                                                        onCheckedChange={() => toggleAccountEnabled(account.id, isEnabled)}
                                                        title={isEnabled ? 'Disable syncing' : 'Enable syncing'}
                                                    >
                                                        <Switch.HiddenInput />
                                                        <Switch.Control w="22px" h="12px">
                                                            <Switch.Thumb w="10px" h="10px" />
                                                        </Switch.Control>
                                                    </Switch.Root>
                                                    <IconButton
                                                        aria-label="View balance"
                                                        size="2xs"
                                                        variant="ghost"
                                                        onClick={() => handleBalanceClick(account)}
                                                        title="View live balance"
                                                        p={0} minW="18px" h="18px"
                                                    >
                                                        <FiPieChart size={10} />
                                                    </IconButton>
                                                    <IconButton
                                                        aria-label="Purge data"
                                                        size="2xs"
                                                        variant="ghost"
                                                        onClick={() => handlePurgeAccount(account)}
                                                        title="Purge all account data"
                                                        p={0} minW="18px" h="18px"
                                                    >
                                                        <LuEraser size={10} />
                                                    </IconButton>
                                                    <IconButton
                                                        aria-label="Edit"
                                                        size="2xs"
                                                        variant="ghost"
                                                        onClick={() => handleEdit(account)}
                                                        p={0} minW="18px" h="18px"
                                                    >
                                                        <FiEdit2 size={10} />
                                                    </IconButton>
                                                    <IconButton
                                                        aria-label="Delete"
                                                        size="2xs"
                                                        variant="ghost"
                                                        colorScheme="red"
                                                        onClick={() => handleDelete(account)}
                                                        p={0} minW="18px" h="18px"
                                                    >
                                                        <FiTrash2 size={10} />
                                                    </IconButton>
                                                </Flex>
                                            </Flex>
                                        </Box>

                                        <Collapsible.Root open={isExpanded}>
                                            <Collapsible.Content>
                                                <Box p={3} bg="white" overflowX="auto" position="relative">
                                                    {/* ID + address + tags */}
                                                    <Flex justify="space-between" align="center" mb={2}>
                                                        <HStack gap={1.5}>
                                                            <Text fontSize="2xs" color="gray.400" fontFamily="mono">
                                                                #{account.id}
                                                            </Text>
                                                            {account.address_or_identifier && (
                                                                <Text fontSize="2xs" color="gray.400" fontFamily="mono" truncate maxW="160px">
                                                                    {account.address_or_identifier.length > 24
                                                                        ? `${account.address_or_identifier.slice(0, 8)}...${account.address_or_identifier.slice(-6)}`
                                                                        : account.address_or_identifier}
                                                                </Text>
                                                            )}
                                                        </HStack>
                                                        {account.tags && account.tags.length > 0 && (
                                                            <Flex gap={0.5} flexWrap="wrap" justify="flex-end">
                                                                {account.tags.map((tagObj, idx) => {
                                                                    const tagKey = typeof tagObj === 'string' ? tagObj : Object.keys(tagObj)[0];
                                                                    return tagKey ? (
                                                                        <Badge key={idx} size="xs" variant="subtle" fontSize="2xs" colorPalette="gray">
                                                                            {tagKey}
                                                                        </Badge>
                                                                    ) : null;
                                                                })}
                                                            </Flex>
                                                        )}
                                                    </Flex>
                                                    <AccountConnectors account={account} />
                                                </Box>
                                            </Collapsible.Content>
                                        </Collapsible.Root>
                                    </Card.Body>
                                </Card.Root>
                            );
                        })}
                    </SimpleGrid>
                )}
            </VStack>

            {/* Dialog */}
            <AccountFormDialog
                isOpen={isDialogOpen}
                onClose={handleDialogClose}
                account={editingAccount}
            />

            {/* Delete Confirmation Dialog */}
            <DeleteAccountDialog
                isOpen={isDeleteOpen}
                onClose={handleDeleteClose}
                accountId={deleteTarget?.id ?? null}
                accountName={deleteTarget?.name ?? ''}
                onDeleted={handleDeleted}
            />

            <BalanceDrawer
                isOpen={balanceDrawerOpen}
                onClose={() => setBalanceDrawerOpen(false)}
                mode={balanceMode}
                accountId={balanceAccountId}
                title={balanceTitle}
            />

            <CleanupDialog
                isOpen={isCleanupOpen}
                onClose={handleCleanupClose}
                connectorIds={[]}
                accountId={cleanupTarget?.accountId}
                defaultMode="purge"
                title={cleanupTarget?.title ?? ''}
                onCompleted={handleCleanupCompleted}
            />
        </Box>
    );
};

export default AccountsManagement;
