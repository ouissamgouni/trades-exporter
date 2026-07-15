import {
    Badge, Button, Heading, Input, Text,
} from './ui/primitives';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FiChevronDown, FiChevronRight, FiPieChart, FiEdit2, FiPlus, FiTrash2 } from 'react-icons/fi';
import { LuEraser } from 'react-icons/lu';
import { BalanceDrawer } from './BalanceDrawer';
import { Account, API_URL } from '../types';
import { FOCUS_RING } from '../lib/ui';
import AccountConnectors from './AccountConnectors';
import AccountFormDialog from './AccountFormDialog';
import { DeleteAccountDialog } from './DeleteAccountDialog';
import { CleanupDialog } from './CleanupDialog';
import { toaster } from './ui/toaster';

const ToggleSwitch: React.FC<{ checked: boolean; onChange: () => void; title?: string }> = ({ checked, onChange, title }) => (
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        title={title}
        onClick={onChange}
        className={`relative h-3 w-[22px] shrink-0 transition-colors ${FOCUS_RING} ${checked ? 'bg-blue-500' : 'bg-gray-300'}`}
    >
        <span
            className={`absolute top-0.5 h-2.5 w-2.5 bg-white transition-transform ${checked ? 'translate-x-[10px]' : 'translate-x-0.5'}`}
        />
    </button>
);

const FILTER_CHIP_COLORS: Record<string, { active: string; inactive: string }> = {
    blue: { active: 'bg-blue-600 text-white', inactive: 'border border-blue-300 text-blue-700' },
    cyan: { active: 'bg-cyan-600 text-white', inactive: 'border border-cyan-300 text-cyan-700' },
    purple: { active: 'bg-purple-600 text-white', inactive: 'border border-purple-300 text-purple-700' },
    green: { active: 'bg-green-600 text-white', inactive: 'border border-green-300 text-green-700' },
    teal: { active: 'bg-teal-600 text-white', inactive: 'border border-teal-300 text-teal-700' },
    orange: { active: 'bg-orange-600 text-white', inactive: 'border border-orange-300 text-orange-700' },
    gray: { active: 'bg-gray-600 text-white', inactive: 'border border-gray-300 text-gray-700' },
};

const AccountsManagement: React.FC = () => {
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [filteredAccounts, setFilteredAccounts] = useState<Account[]>([]);
    const [loading, setLoading] = useState(false);
    const [searchText, setSearchText] = useState('');
    const [editingAccount, setEditingAccount] = useState<Account | null>(null);
    const [expandedAccountIds, setExpandedAccountIds] = useState<Set<number>>(new Set());
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const openDialog = () => setIsDialogOpen(true);
    const closeDialog = () => setIsDialogOpen(false);

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
        cex: { label: 'CEX', color: 'blue', borderColor: 'border-l-blue-400' },
        dex: { label: 'DEX', color: 'cyan', borderColor: 'border-l-cyan-400' },
        wallet: { label: 'Wallet', color: 'purple', borderColor: 'border-l-purple-400' },
        broker: { label: 'Broker', color: 'green', borderColor: 'border-l-green-400' },
        bank: { label: 'Bank', color: 'teal', borderColor: 'border-l-teal-400' },
        investment: { label: 'Invest', color: 'orange', borderColor: 'border-l-orange-400' },
    };

    const TYPE_TEXT_400: Record<string, string> = {
        blue: 'text-blue-400',
        cyan: 'text-cyan-400',
        purple: 'text-purple-400',
        green: 'text-green-400',
        teal: 'text-teal-400',
        orange: 'text-orange-400',
        gray: 'text-gray-400',
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
        <div className="p-6">
            <div className="flex flex-col gap-4">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <Heading className="text-lg">Accounts & Connectors</Heading>
                        <Text className="mt-1 block text-sm text-gray-600">
                            Manage accounts with their data connectors inline. Click an account to configure connectors.
                        </Text>
                    </div>
                    <div className="flex items-center gap-2">
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
                    </div>
                </div>

                {/* Search + Filter Chips */}
                <div className="flex flex-col gap-2">
                    <Input
                        placeholder="Search by name or identifier..."
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        className="max-w-[400px]"
                    />
                    {(availableTypes.length > 1 || availableGroups.length > 0) && (
                        <div className="flex flex-wrap gap-1.5">
                            {availableTypes.map(type => {
                                const meta = TYPE_META[type];
                                const isActive = activeTypeFilters.has(type);
                                const count = filteredAccounts.filter(a => a.account_type === type).length;
                                const chipColors = FILTER_CHIP_COLORS[meta?.color || 'gray'];
                                return (
                                    <button
                                        key={type}
                                        type="button"
                                        onClick={() => toggleTypeFilter(type)}
                                        className={`cursor-pointer select-none px-2 py-0.5 text-xs font-medium transition-colors hover:opacity-80 ${FOCUS_RING} ${isActive ? chipColors.active : chipColors.inactive}`}
                                    >
                                        {meta?.label || type} ({count})
                                    </button>
                                );
                            })}
                            {availableGroups.length > 0 && (
                                <div className="mx-1 h-[20px] border-l border-gray-300" />
                            )}
                            {availableGroups.map(group => {
                                const isActive = activeGroupFilters.has(group);
                                const count = filteredAccounts.filter(a => a.group === group).length;
                                const chipColors = FILTER_CHIP_COLORS.gray;
                                return (
                                    <button
                                        key={group}
                                        type="button"
                                        onClick={() => toggleGroupFilter(group)}
                                        className={`cursor-pointer select-none px-2 py-0.5 text-xs font-medium transition-colors hover:opacity-80 ${FOCUS_RING} ${isActive ? chipColors.active : chipColors.inactive}`}
                                    >
                                        {group} ({count})
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Account Cards */}
                {loading ? (
                    <div className="py-8 text-center">
                        <Text>Loading accounts...</Text>
                    </div>
                ) : filteredAccounts.length === 0 ? (
                    <div className="bg-gray-50 py-8 text-center">
                        <Text className="mb-4 block text-gray-600">No accounts found</Text>
                        <Button colorScheme="blue" onClick={handleCreate}>
                            <FiPlus /> Create Your First Account
                        </Button>
                    </div>
                ) : displayedAccounts.length === 0 ? (
                    <div className="py-6 text-center">
                        <Text className="text-sm text-gray-500">No accounts match the selected filters</Text>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {displayedAccounts.map((account) => {
                            const isExpanded = expandedAccountIds.has(account.id);
                            const isEnabled = account.enabled !== false;
                            const meta = TYPE_META[account.account_type];

                            return (
                                <div
                                    key={account.id}
                                    className={`border border-slate-200 border-l-[3px] bg-white shadow-sm transition-shadow hover:shadow ${meta?.borderColor || 'border-l-gray-300'} ${isEnabled ? 'opacity-100' : 'opacity-60'} ${isExpanded ? 'col-span-full' : ''}`}
                                >
                                    <div
                                        className={`cursor-pointer px-1.5 py-0.5 transition-all duration-100 hover:bg-gray-50 ${isEnabled ? 'bg-white' : 'bg-gray-50'} ${isExpanded ? 'border-b border-gray-200' : ''}`}
                                        onClick={() => toggleExpand(account.id)}
                                    >
                                        {/* Type / Group header line */}
                                        <div className="mb-[-2px] flex items-center gap-1">
                                            <Text className={`text-[10px] font-medium uppercase tracking-wider ${TYPE_TEXT_400[meta?.color || 'gray']}`}>
                                                {meta?.label || account.account_type}
                                            </Text>
                                            {account.envelope && (
                                                <Badge
                                                    colorScheme={account.envelope === 'pea' ? 'green' : account.envelope === 'av' ? 'blue' : 'gray'}
                                                    className="text-[10px]"
                                                >
                                                    {account.envelope.toUpperCase()}
                                                </Badge>
                                            )}
                                            {account.group && (
                                                <>
                                                    <Text className="text-[10px] text-gray-300">/</Text>
                                                    <Text className="text-[10px] text-gray-400">
                                                        {account.group}
                                                    </Text>
                                                </>
                                            )}
                                        </div>
                                        <div className="flex items-center justify-between">
                                            <div className="flex min-w-0 flex-1 items-center gap-1">
                                                <span className="shrink-0 text-gray-400">
                                                    {isExpanded ? <FiChevronDown size={10} /> : <FiChevronRight size={10} />}
                                                </span>
                                                {account.color && (
                                                    <span
                                                        className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
                                                        style={{ backgroundColor: account.color }}
                                                    />
                                                )}
                                                <Text className="truncate text-xs font-semibold">
                                                    {account.name}
                                                </Text>
                                            </div>
                                            <div className="flex shrink-0 items-center gap-0" onClick={(e) => e.stopPropagation()}>
                                                <ToggleSwitch
                                                    checked={isEnabled}
                                                    onChange={() => toggleAccountEnabled(account.id, isEnabled)}
                                                    title={isEnabled ? 'Disable syncing' : 'Enable syncing'}
                                                />
                                                <Button
                                                    aria-label="View balance"
                                                    variant="ghost"
                                                    onClick={() => handleBalanceClick(account)}
                                                    title="View live balance"
                                                    className="h-[18px] min-w-[18px] p-0"
                                                >
                                                    <FiPieChart size={10} />
                                                </Button>
                                                <Button
                                                    aria-label="Purge data"
                                                    variant="ghost"
                                                    onClick={() => handlePurgeAccount(account)}
                                                    title="Purge all account data"
                                                    className="h-[18px] min-w-[18px] p-0"
                                                >
                                                    <LuEraser size={10} />
                                                </Button>
                                                <Button
                                                    aria-label="Edit"
                                                    variant="ghost"
                                                    onClick={() => handleEdit(account)}
                                                    className="h-[18px] min-w-[18px] p-0"
                                                >
                                                    <FiEdit2 size={10} />
                                                </Button>
                                                <Button
                                                    aria-label="Delete"
                                                    variant="ghost"
                                                    colorScheme="red"
                                                    onClick={() => handleDelete(account)}
                                                    className="h-[18px] min-w-[18px] p-0"
                                                >
                                                    <FiTrash2 size={10} />
                                                </Button>
                                            </div>
                                        </div>
                                    </div>

                                    {isExpanded && (
                                        <div className="border-t border-slate-200 bg-slate-50 p-3">
                                            {/* ID + address + tags */}
                                            <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                                                <div className="flex min-w-0 items-center gap-3">
                                                    <span className="inline-flex items-center gap-1 font-mono text-[11px] text-slate-500">
                                                        <span className="uppercase tracking-wide text-slate-400">ID</span>
                                                        #{account.id}
                                                    </span>
                                                    {account.address_or_identifier && (
                                                        <span
                                                            className="min-w-0 truncate font-mono text-[11px] text-slate-500"
                                                            title={account.address_or_identifier}
                                                        >
                                                            {account.address_or_identifier.length > 24
                                                                ? `${account.address_or_identifier.slice(0, 8)}...${account.address_or_identifier.slice(-6)}`
                                                                : account.address_or_identifier}
                                                        </span>
                                                    )}
                                                </div>
                                                {account.tags && account.tags.length > 0 && (
                                                    <div className="flex flex-wrap justify-end gap-1">
                                                        {account.tags.map((tagObj, idx) => {
                                                            const tagKey = typeof tagObj === 'string' ? tagObj : Object.keys(tagObj)[0];
                                                            return tagKey ? (
                                                                <Badge key={idx} colorScheme="gray" className="text-[10px]">
                                                                    {tagKey}
                                                                </Badge>
                                                            ) : null;
                                                        })}
                                                    </div>
                                                )}
                                            </div>
                                            <AccountConnectors account={account} />
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

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
        </div>
    );
};

export default AccountsManagement;
