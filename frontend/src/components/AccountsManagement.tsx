import {
    Badge, Box,
    Button, Card, Collapsible, Flex, Heading, HStack, IconButton, Input,
    SimpleGrid, Switch, Text, useDisclosure, VStack
} from '@chakra-ui/react';
import React, { useEffect, useMemo, useState } from 'react';
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

    // Group accounts by type, then by group within each type
    const accountsByTypeAndGroup = useMemo(() => {
        const result = new Map<string, Map<string, Account[]>>();
        for (const type of ['cex', 'dex', 'wallet', 'broker', 'bank', 'investment']) {
            const typeAccounts = filteredAccounts.filter(a => a.account_type === type);
            const groups = new Map<string, Account[]>();
            for (const account of typeAccounts) {
                const groupName = account.group || 'Ungrouped';
                const list = groups.get(groupName) || [];
                list.push(account);
                groups.set(groupName, list);
            }
            if (typeAccounts.length > 0) {
                result.set(type, groups);
            }
        }
        return result;
    }, [filteredAccounts]);

    const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
    const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

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

                {/* Search */}
                <HStack gap={4}>
                    <Input
                        placeholder="Search by name or identifier..."
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        maxW="400px"
                        size="sm"
                    />
                </HStack>

                {/* Account Type Sections */}
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
                    <VStack align="stretch" gap={2}>
                        {[{ type: 'cex', label: '🏦 CEX', colorScheme: 'blue' },
                        { type: 'dex', label: '🔗 DEX', colorScheme: 'cyan' },
                        { type: 'wallet', label: '💼 Wallets', colorScheme: 'purple' },
                        { type: 'broker', label: '📊 Brokers', colorScheme: 'green' },
                        { type: 'bank', label: '🏛️ Banks', colorScheme: 'teal' },
                        { type: 'investment', label: '📈 Investments', colorScheme: 'orange' }]
                            .filter(section => accountsByTypeAndGroup.has(section.type))
                            .map(section => {
                                const groupsMap = accountsByTypeAndGroup.get(section.type)!;
                                const allTypeAccounts = Array.from(groupsMap.values()).flat();
                                const isCollapsed = collapsedSections[section.type] ?? false;
                                const groupEntries = Array.from(groupsMap.entries());
                                const hasMultipleGroups = groupEntries.length > 1 || (groupEntries.length === 1 && groupEntries[0][0] !== 'Ungrouped');

                                return (
                                    <Box key={section.type} mb={2}>
                                        {/* Type Section Header */}
                                        <Flex
                                            align="center"
                                            justify="space-between"
                                            py={1.5}
                                            px={2}
                                            bg={`${section.colorScheme}.50`}
                                            borderRadius="md"
                                            mb={1}
                                            cursor="pointer"
                                            onClick={() => setCollapsedSections(prev => ({ ...prev, [section.type]: !isCollapsed }))}
                                            _hover={{ bg: `${section.colorScheme}.100` }}
                                        >
                                            <Flex align="center" gap={2}>
                                                <Text color="gray.400" fontSize="xs">{isCollapsed ? '▶' : '▼'}</Text>
                                                <Text fontWeight="medium" fontSize="sm" color="gray.700">
                                                    {section.label}
                                                </Text>
                                                <Badge colorPalette="gray" size="xs" variant="subtle">
                                                    {allTypeAccounts.length}
                                                </Badge>
                                            </Flex>
                                        </Flex>

                                        <Collapsible.Root open={!isCollapsed}>
                                            <Collapsible.Content>
                                                {groupEntries.map(([groupName, groupAccounts]) => {
                                                    const groupKey = `${section.type}:${groupName}`;
                                                    const isGroupCollapsed = collapsedGroups[groupKey] ?? false;

                                                    return (
                                                        <Card.Root key={groupKey} variant="outline" mb={2}>
                                                            <Card.Body p={0}>
                                                                {hasMultipleGroups && (
                                                                    <Flex
                                                                        align="center"
                                                                        py={2}
                                                                        px={3}
                                                                        bg="gray.50"
                                                                        borderBottomWidth="1px"
                                                                        borderColor="gray.200"
                                                                        cursor="pointer"
                                                                        onClick={() => setCollapsedGroups(prev => ({ ...prev, [groupKey]: !isGroupCollapsed }))}
                                                                        _hover={{ bg: 'gray.100' }}
                                                                    >
                                                                        <Flex align="center" gap={2}>
                                                                            <Text color="gray.500" fontSize="xs">{isGroupCollapsed ? '▶' : '▼'}</Text>
                                                                            <Text fontWeight="semibold" fontSize="sm" color="gray.700">
                                                                                {groupName}
                                                                            </Text>
                                                                            <Badge colorPalette="gray" size="xs" variant="subtle">
                                                                                {groupAccounts.length}
                                                                            </Badge>
                                                                        </Flex>
                                                                    </Flex>
                                                                )}

                                                                <Collapsible.Root open={!isGroupCollapsed || !hasMultipleGroups}>
                                                                    <Collapsible.Content>
                                                                        <SimpleGrid columns={2} gap={2} p={2}>
                                                                            {groupAccounts.map((account) => {
                                                                                const isExpanded = expandedAccountIds.has(account.id);
                                                                                const isEnabled = account.enabled !== false;

                                                                                return (
                                                                                    <Card.Root key={account.id} variant="outline" opacity={isEnabled ? 1 : 0.6} size="sm">
                                                                                        <Card.Body p={0}>
                                                                                            <Box
                                                                                                py={1}
                                                                                                px={2}
                                                                                                cursor="pointer"
                                                                                                bg={isEnabled ? 'white' : 'gray.50'}
                                                                                                borderBottomWidth={isExpanded ? 1 : 0}
                                                                                                borderColor="gray.200"
                                                                                                onClick={() => toggleExpand(account.id)}
                                                                                                _hover={{ bg: 'gray.50' }}
                                                                                                transition="all 0.1s"
                                                                                            >
                                                                                                <Flex justify="space-between" align="center">
                                                                                                    <Flex align="center" gap={1.5} minW={0} flex={1}>
                                                                                                        <Box color="gray.400" flexShrink={0}>
                                                                                                            {isExpanded ? <FiChevronDown size={10} /> : <FiChevronRight size={10} />}
                                                                                                        </Box>
                                                                                                        {account.color && (
                                                                                                            <Box w="8px" h="8px" borderRadius="full" bg={account.color} flexShrink={0} />
                                                                                                        )}
                                                                                                        <Text fontWeight="semibold" fontSize="xs" truncate>
                                                                                                            {account.name}
                                                                                                        </Text>
                                                                                                        {account.address_or_identifier && (
                                                                                                            <Text fontSize="2xs" color="gray.400" fontFamily="mono" truncate maxW="120px">
                                                                                                                {account.address_or_identifier.length > 20
                                                                                                                    ? `${account.address_or_identifier.slice(0, 6)}...${account.address_or_identifier.slice(-4)}`
                                                                                                                    : account.address_or_identifier}
                                                                                                            </Text>
                                                                                                        )}
                                                                                                        {/* Tags inline */}
                                                                                                        {account.tags && account.tags.length > 0 && (
                                                                                                            <Flex gap={0.5} flexWrap="wrap">
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
                                                                                                    <Flex align="center" gap={1} flexShrink={0} onClick={(e) => e.stopPropagation()}>
                                                                                                        <Switch.Root
                                                                                                            size="sm"
                                                                                                            checked={isEnabled}
                                                                                                            onCheckedChange={() => toggleAccountEnabled(account.id, isEnabled)}
                                                                                                            title={isEnabled ? 'Disable syncing' : 'Enable syncing'}
                                                                                                        >
                                                                                                            <Switch.HiddenInput />
                                                                                                            <Switch.Control>
                                                                                                                <Switch.Thumb />
                                                                                                            </Switch.Control>
                                                                                                        </Switch.Root>
                                                                                                        <IconButton
                                                                                                            aria-label="View balance"
                                                                                                            size="xs"
                                                                                                            variant="ghost"
                                                                                                            onClick={() => handleBalanceClick(account)}
                                                                                                            title="View live balance"
                                                                                                        >
                                                                                                            <FiPieChart />
                                                                                                        </IconButton>
                                                                                                        <IconButton
                                                                                                            aria-label="Purge data"
                                                                                                            size="xs"
                                                                                                            variant="ghost"
                                                                                                            onClick={() => handlePurgeAccount(account)}
                                                                                                            title="Purge all account data"
                                                                                                        >
                                                                                                            <LuEraser />
                                                                                                        </IconButton>
                                                                                                        <IconButton
                                                                                                            aria-label="Edit"
                                                                                                            size="xs"
                                                                                                            variant="ghost"
                                                                                                            onClick={() => handleEdit(account)}
                                                                                                        >
                                                                                                            <FiEdit2 />
                                                                                                        </IconButton>
                                                                                                        <IconButton
                                                                                                            aria-label="Delete"
                                                                                                            size="xs"
                                                                                                            variant="ghost"
                                                                                                            colorScheme="red"
                                                                                                            onClick={() => handleDelete(account)}
                                                                                                        >
                                                                                                            <FiTrash2 />
                                                                                                        </IconButton>
                                                                                                    </Flex>
                                                                                                </Flex>
                                                                                            </Box>

                                                                                            <Collapsible.Root open={isExpanded}>
                                                                                                <Collapsible.Content>
                                                                                                    <Box p={3} bg="white" overflowX="auto">
                                                                                                        <AccountConnectors account={account} />
                                                                                                    </Box>
                                                                                                </Collapsible.Content>
                                                                                            </Collapsible.Root>
                                                                                        </Card.Body>
                                                                                    </Card.Root>
                                                                                );
                                                                            })}
                                                                        </SimpleGrid>
                                                                    </Collapsible.Content>
                                                                </Collapsible.Root>
                                                            </Card.Body>
                                                        </Card.Root>
                                                    );
                                                })}
                                            </Collapsible.Content>
                                        </Collapsible.Root>
                                    </Box>
                                );
                            })}
                    </VStack>
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
