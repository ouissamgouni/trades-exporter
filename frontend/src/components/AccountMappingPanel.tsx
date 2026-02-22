import {
    Badge, Box, Button, Dialog, Flex, Heading, Input, NativeSelect,
    Portal, Spinner, Table, Text, HStack, Textarea, VStack
} from '@chakra-ui/react';
import React, { useEffect, useState, useMemo } from 'react';
import { FiChevronDown, FiChevronRight } from 'react-icons/fi';
import { API_URL, Account, RawAccount } from '../types';
import { AccountSelector } from './AccountSelector';
import { ConfirmDialog, useConfirmDialog } from './ui/ConfirmDialog';
import { toaster } from './ui/toaster';
import { Tooltip } from './ui/tooltip';
import AccountFormDialog, { AccountPrefill } from './AccountFormDialog';
import { TransactionsTable } from './TransactionsTable';

// Props interface for AccountMappingPanel
interface AccountMappingPanelProps {
    mode: 'full' | 'issues-only';
    includeDismissed?: boolean;
    onDismissedChange?: (includeDismissed: boolean) => void;
}

// Component to show transaction sections by field type
const TransactionFieldSections: React.FC<{ source: string; label: string }> = ({ source, label }) => {
    const [counts, setCounts] = useState<{ account: number; from: number; to: number } | null>(null);
    const [loading, setLoading] = useState(true);
    const [openSections, setOpenSections] = useState<Set<string>>(new Set());

    useEffect(() => {
        const fetchCounts = async () => {
            try {
                const response = await fetch(
                    `${API_URL}/raw-accounts/${encodeURIComponent(source)}/${encodeURIComponent(label)}/transactions?limit=1&offset=0`
                );
                if (response.ok) {
                    const data = await response.json();
                    setCounts({
                        account: data.metadata.account_count || 0,
                        from: data.metadata.from_count || 0,
                        to: data.metadata.to_count || 0,
                    });
                }
            } catch (err) {
                console.error('Failed to fetch transaction counts:', err);
            } finally {
                setLoading(false);
            }
        };
        fetchCounts();
    }, [source, label]);

    const toggleSection = (sectionId: string) => {
        setOpenSections(prev => {
            const newSet = new Set(prev);
            if (newSet.has(sectionId)) {
                newSet.delete(sectionId);
            } else {
                newSet.add(sectionId);
            }
            return newSet;
        });
    };

    if (loading) {
        return (
            <Flex justify="center" p={4}>
                <Spinner size="sm" />
            </Flex>
        );
    }

    if (!counts) {
        return <Text color="gray.500">Failed to load transaction counts</Text>;
    }

    const sections = [
        {
            id: 'account',
            title: '💼 Trade Account',
            description: 'Transactions where this account was used for trading (CEX trades, staking, etc.)',
            count: counts.account,
            fieldType: 'account',
        },
        {
            id: 'from',
            title: '📤 From (Sender)',
            description: 'Transactions where this address/account was the sender (withdrawals, outbound transfers)',
            count: counts.from,
            fieldType: 'from',
        },
        {
            id: 'to',
            title: '📥 To (Recipient)',
            description: 'Transactions where this address/account was the recipient (deposits, inbound transfers)',
            count: counts.to,
            fieldType: 'to',
        },
    ];

    return (
        <Flex direction="column" gap={3}>
            {sections.map((section) => {
                const isOpen = openSections.has(section.id);
                return (
                    <Box key={section.id}>
                        <Button
                            variant="outline"
                            width="100%"
                            justifyContent="space-between"
                            size="sm"
                            disabled={section.count === 0}
                            onClick={() => toggleSection(section.id)}
                        >
                            <Flex align="center" gap={2}>
                                {isOpen ? <FiChevronDown /> : <FiChevronRight />}
                                <Text fontWeight="medium">{section.title}</Text>
                                <Badge colorPalette={section.count > 0 ? 'blue' : 'gray'}>
                                    {section.count}
                                </Badge>
                            </Flex>
                            <Text fontSize="2xs" color="gray.500">
                                {section.description}
                            </Text>
                        </Button>
                        {isOpen && section.count > 0 && (
                            <Box mt={2} p={3} bg="white" borderRadius="md" borderWidth="1px">
                                <TransactionsTable
                                    tableId={`accountMapping-${section.fieldType}`}
                                    title=""
                                    subtitle=""
                                    showFilters={false}
                                    showBundles={false}
                                    showSuggestions={false}
                                    hiddenColumns={['total', 'taxability', 'feeInBase', 'bundle']}
                                    customApiUrl={`${API_URL}/raw-accounts/${encodeURIComponent(source)}/${encodeURIComponent(label)}/transactions?field_type=${section.fieldType}`}
                                />
                            </Box>
                        )}
                    </Box>
                );
            })}
        </Flex>
    );
};

// Fuzzy matching utility
const calculateSimilarity = (str1: string, str2: string): number => {
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();

    if (s1 === s2) return 1.0;
    if (s1.includes(s2) || s2.includes(s1)) return 0.8;
    if (s1.startsWith(s2) || s2.startsWith(s1)) return 0.7;
    if (s1.endsWith(s2) || s2.endsWith(s1)) return 0.6;

    if (s1.length > 10 && s2.length > 10) {
        const prefix1 = s1.slice(0, 6);
        const prefix2 = s2.slice(0, 6);
        const suffix1 = s1.slice(-4);
        const suffix2 = s2.slice(-4);
        if (prefix1 === prefix2 && suffix1 === suffix2) return 0.95;
        if (prefix1 === prefix2 || suffix1 === suffix2) return 0.5;
    }

    const maxLen = Math.max(s1.length, s2.length);
    if (maxLen === 0) return 1.0;
    if (maxLen > 20) return 0;

    const distance = levenshteinDistance(s1, s2);
    return 1 - (distance / maxLen);
};

const levenshteinDistance = (str1: string, str2: string): number => {
    const m = str1.length;
    const n = str2.length;
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (str1[i - 1] === str2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }
    }
    return dp[m][n];
};

interface SuggestedMatch {
    account: Account;
    confidence: number;
}

// Truncate long labels
const truncateLabel = (label: string, maxLength: number = 20) => {
    if (label.length <= maxLength) return label;
    return `${label.slice(0, 8)}...${label.slice(-6)}`;
};

// Dismiss reason chips
const DISMISS_REASONS = [
    "🚫 External account - not owned",
    "🧪 Test/demo data",
    "📋 Duplicate entry",
    "🔗 Third-party address",
    "💼 Service/protocol account"
];

// Source group component
const SourceGroup: React.FC<{
    source: string;
    rawAccounts: RawAccount[];
    accounts: Account[];
    suggestionsMap: Map<string, SuggestedMatch[]>;
    onRefresh: () => void;
}> = ({ source, rawAccounts, accounts, suggestionsMap, onRefresh }) => {
    const [isExpanded, setIsExpanded] = useState(true);
    const [expandedRawIds, setExpandedRawIds] = useState<Set<string>>(new Set());
    const [editingKey, setEditingKey] = useState<string | null>(null);
    const [editAccountId, setEditAccountId] = useState<number | null>(null);
    
    // Dismiss state
    const [showDismissDialog, setShowDismissDialog] = useState(false);
    const [dismissingRawAccount, setDismissingRawAccount] = useState<RawAccount | null>(null);
    const [dismissReason, setDismissReason] = useState('');
    
    // Account creation
    const [showAccountDialog, setShowAccountDialog] = useState(false);
    const [accountPrefill, setAccountPrefill] = useState<AccountPrefill | undefined>(undefined);
    const [pendingRawAccount, setPendingRawAccount] = useState<RawAccount | null>(null);

    const getEditKey = (rawAccount: RawAccount) => `${rawAccount.source}:${rawAccount.label}`;

    const getAccountName = (accountId: number | null | undefined) => {
        if (accountId === null || accountId === undefined) return null;
        const account = accounts.find(a => a.id === accountId);
        return account?.name || `ID:${accountId}`;
    };

    const startEditing = (rawAccount: RawAccount) => {
        setEditingKey(getEditKey(rawAccount));
        setEditAccountId(rawAccount.account_id ?? null);
    };

    const saveRawAccount = async (rawAccount: RawAccount) => {
        try {
            const response = await fetch(
                `${API_URL}/raw-accounts/${encodeURIComponent(rawAccount.source)}/${encodeURIComponent(rawAccount.label)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ account_id: editAccountId })
                }
            );
            if (!response.ok) throw new Error('Failed to update raw account');
            await onRefresh();
            setEditingKey(null);
            setEditAccountId(null);
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save' });
        }
    };

    const acceptSuggestion = async (rawAccount: RawAccount, accountId: number) => {
        try {
            const response = await fetch(
                `${API_URL}/raw-accounts/${encodeURIComponent(rawAccount.source)}/${encodeURIComponent(rawAccount.label)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ account_id: accountId })
                }
            );
            if (!response.ok) throw new Error('Failed to update raw account');
            await onRefresh();
            toaster.success({ title: 'Mapping accepted' });
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save' });
        }
    };

    const openDismissDialog = (rawAccount: RawAccount) => {
        setDismissingRawAccount(rawAccount);
        setDismissReason('');
        setShowDismissDialog(true);
    };

    const executeDismiss = async () => {
        if (!dismissingRawAccount || !dismissReason.trim()) {
            toaster.error({ title: 'Error', description: 'Reason is required' });
            return;
        }

        try {
            const response = await fetch(
                `${API_URL}/raw-accounts/${encodeURIComponent(dismissingRawAccount.source)}/${encodeURIComponent(dismissingRawAccount.label)}/dismiss`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reason: dismissReason })
                }
            );
            if (!response.ok) throw new Error('Failed to dismiss raw account');
            await onRefresh();
            setShowDismissDialog(false);
            setDismissingRawAccount(null);
            setDismissReason('');
            toaster.success({ title: 'Raw account dismissed' });
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to dismiss' });
        }
    };

    const undismissRawAccount = async (rawAccount: RawAccount) => {
        try {
            const response = await fetch(
                `${API_URL}/raw-accounts/${encodeURIComponent(rawAccount.source)}/${encodeURIComponent(rawAccount.label)}/dismiss`,
                {
                    method: 'DELETE'
                }
            );
            if (!response.ok) throw new Error('Failed to un-dismiss raw account');
            await onRefresh();
            toaster.success({ title: 'Raw account un-dismissed' });
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to un-dismiss' });
        }
    };

    const unlinkRawAccount = async (rawAccount: RawAccount) => {
        try {
            const response = await fetch(
                `${API_URL}/raw-accounts/${encodeURIComponent(rawAccount.source)}/${encodeURIComponent(rawAccount.label)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ account_id: null })
                }
            );
            if (!response.ok) throw new Error('Failed to unlink raw account');
            await onRefresh();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to unlink' });
        }
    };

    const createAccountFromRaw = (rawAccount: RawAccount) => {
        const isWalletAddress = rawAccount.label.startsWith('0x') ||
            rawAccount.source.toLowerCase().includes('chain') ||
            rawAccount.source.toLowerCase().includes('scan') ||
            rawAccount.source.toLowerCase().includes('wallet');

        const accountType: 'cex' | 'broker' | 'wallet' = isWalletAddress ? 'wallet' : 'cex';

        setAccountPrefill({
            name: rawAccount.label,
            address_or_identifier: rawAccount.label,
            account_type: accountType,
        });
        setPendingRawAccount(rawAccount);
        setShowAccountDialog(true);
    };

    const handleAccountDialogClose = async (createdAccountId?: number) => {
        setShowAccountDialog(false);

        if (createdAccountId && pendingRawAccount) {
            await acceptSuggestion(pendingRawAccount, createdAccountId);
            toaster.success({
                title: 'Account created & linked',
                description: `Created account and linked to "${pendingRawAccount.label}"`
            });
        }

        setAccountPrefill(undefined);
        setPendingRawAccount(null);
    };

    const toggleRawAccountExpansion = (rawAccountId: string) => {
        setExpandedRawIds(prev => {
            const newSet = new Set(prev);
            if (newSet.has(rawAccountId)) {
                newSet.delete(rawAccountId);
            } else {
                newSet.add(rawAccountId);
            }
            return newSet;
        });
    };

    return (
        <Box>
            {/* Source header */}
            <Button
                variant="ghost"
                width="100%"
                justifyContent="flex-start"
                onClick={() => setIsExpanded(!isExpanded)}
                p={3}
                mb={2}
                bg="gray.50"
                _hover={{ bg: 'gray.100' }}
            >
                <Flex align="center" gap={2} width="100%">
                    {isExpanded ? <FiChevronDown /> : <FiChevronRight />}
                    <Text fontWeight="bold" fontSize="2xs">{source}</Text>
                    <Badge colorPalette="blue">{rawAccounts.length} raw account(s)</Badge>
                </Flex>
            </Button>

            {/* Raw accounts table */}
            {isExpanded && (
                <Table.Root size="sm" variant="outline">
                    <Table.Body>
                        {rawAccounts.map((rawAccount) => {
                            const key = getEditKey(rawAccount);
                            const isEditing = editingKey === key;
                            const isExpanded = expandedRawIds.has(key);
                            const suggestions = suggestionsMap.get(key) || [];
                            const isDismissed = rawAccount.dismissed;

                            return (
                                <React.Fragment key={key}>
                                    <Table.Row bg={isDismissed ? 'gray.50' : 'white'} opacity={isDismissed ? 0.6 : 1}>
                                        <Table.Cell width="40%">
                                            <Flex align="center" gap={2}>
                                                <Button
                                                    size="xs"
                                                    variant="ghost"
                                                    onClick={() => toggleRawAccountExpansion(key)}
                                                >
                                                    {isExpanded ? <FiChevronDown /> : <FiChevronRight />}
                                                </Button>
                                                <Tooltip content={rawAccount.label}>
                                                    <Text fontFamily="mono" fontSize="2xs">
                                                        {truncateLabel(rawAccount.label)}
                                                    </Text>
                                                </Tooltip>
                                                {isDismissed && (
                                                    <Badge colorPalette="gray" size="sm">Dismissed</Badge>
                                                )}
                                            </Flex>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {isEditing ? (
                                                <AccountSelector
                                                    value={editAccountId ?? undefined}
                                                    onChange={(id) => setEditAccountId(id ?? null)}
                                                    size="sm"
                                                />
                                            ) : rawAccount.account_id ? (
                                                <Badge colorPalette="green">{getAccountName(rawAccount.account_id)}</Badge>
                                            ) : (
                                                <Text color="gray.500" fontSize="2xs">Not linked</Text>
                                            )}
                                        </Table.Cell>
                                        <Table.Cell>
                                            {!isDismissed && suggestions.length > 0 && (
                                                <HStack gap={1}>
                                                    {suggestions.slice(0, 2).map((s, idx) => (
                                                        <Tooltip key={idx} content={`${(s.confidence * 100).toFixed(0)}% match`}>
                                                            <Button
                                                                size="xs"
                                                                fontSize="2xs"
                                                                variant="outline"
                                                                colorPalette={s.confidence >= 0.9 ? 'green' : 'blue'}
                                                                onClick={() => acceptSuggestion(rawAccount, s.account.id)}
                                                            >
                                                                {s.account.name}
                                                            </Button>
                                                        </Tooltip>
                                                    ))}
                                                </HStack>
                                            )}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <HStack gap={1}>
                                                {isEditing ? (
                                                    <>
                                                        <Button size="xs" fontSize="2xs" colorPalette="blue" onClick={() => saveRawAccount(rawAccount)}>
                                                            Save
                                                        </Button>
                                                        <Button size="xs" fontSize="2xs" variant="outline" onClick={() => setEditingKey(null)}>
                                                            Cancel
                                                        </Button>
                                                    </>
                                                ) : (
                                                    <>
                                                        {!rawAccount.account_id && !isDismissed && (
                                                            <>
                                                                <Button size="xs" fontSize="2xs" variant="outline" onClick={() => startEditing(rawAccount)}>
                                                                    Link
                                                                </Button>
                                                                <Button size="xs" fontSize="2xs" variant="outline" colorPalette="blue" onClick={() => createAccountFromRaw(rawAccount)}>
                                                                    Create
                                                                </Button>
                                                            </>
                                                        )}
                                                        {rawAccount.account_id && !isDismissed && (
                                                            <Button size="xs" fontSize="2xs" variant="outline" onClick={() => unlinkRawAccount(rawAccount)}>
                                                                Unlink
                                                            </Button>
                                                        )}
                                                        {!isDismissed ? (
                                                            <Button size="xs" fontSize="2xs" variant="outline" colorPalette="orange" onClick={() => openDismissDialog(rawAccount)}>
                                                                Dismiss
                                                            </Button>
                                                        ) : (
                                                            <Button size="xs" fontSize="2xs" variant="outline" colorPalette="green" onClick={() => undismissRawAccount(rawAccount)}>
                                                                Un-dismiss
                                                            </Button>
                                                        )}
                                                    </>
                                                )}
                                            </HStack>
                                        </Table.Cell>
                                    </Table.Row>
                                    {isExpanded && (
                                        <Table.Row>
                                            <Table.Cell colSpan={4} p={4} bg="gray.50">
                                                <TransactionFieldSections source={rawAccount.source} label={rawAccount.label} />
                                            </Table.Cell>
                                        </Table.Row>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </Table.Body>
                </Table.Root>
            )}

            {/* Dismiss dialog */}
            <Dialog.Root open={showDismissDialog} onOpenChange={(e) => setShowDismissDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>Dismiss Raw Account Mapping</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <VStack align="stretch" gap={4}>
                                    <Text fontSize="2xs" color="gray.600">
                                        Dismissing will hide this raw account from default views. Select a reason:
                                    </Text>
                                    <Flex wrap="wrap" gap={2}>
                                        {DISMISS_REASONS.map((reason) => (
                                            <Button
                                                key={reason}
                                                size="sm"
                                                variant="outline"
                                                colorPalette={dismissReason === reason ? 'blue' : 'gray'}
                                                onClick={() => setDismissReason(reason)}
                                            >
                                                {reason}
                                            </Button>
                                        ))}
                                    </Flex>
                                    <Textarea
                                        value={dismissReason}
                                        onChange={(e) => setDismissReason(e.target.value)}
                                        placeholder="Edit reason or type custom reason..."
                                        rows={3}
                                    />
                                </VStack>
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Dialog.ActionTrigger asChild>
                                    <Button variant="outline">Cancel</Button>
                                </Dialog.ActionTrigger>
                                <Button
                                    colorPalette="orange"
                                    onClick={executeDismiss}
                                    disabled={!dismissReason.trim()}
                                >
                                    Dismiss
                                </Button>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* Account creation dialog */}
            <AccountFormDialog
                isOpen={showAccountDialog}
                onClose={handleAccountDialogClose}
                account={null}
                prefill={accountPrefill}
            />
        </Box>
    );
};

// Main component
export const AccountMappingPanel: React.FC<AccountMappingPanelProps> = ({
    mode,
    includeDismissed = false,
    onDismissedChange
}) => {
    const [rawAccounts, setRawAccounts] = useState<RawAccount[]>([]);
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [sourceFilter, setSourceFilter] = useState('');

    useEffect(() => {
        fetchData();
    }, [mode, includeDismissed, sourceFilter]);

    const fetchData = async () => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (sourceFilter) params.append('source', sourceFilter);
            if (mode === 'issues-only') {
                params.append('has_account_id', 'false');
                params.append('only_valid_pending', 'true');
            }
            params.append('include_dismissed', includeDismissed.toString());

            const [rawAccountsRes, accountsRes] = await Promise.all([
                fetch(`${API_URL}/raw-accounts?${params}`),
                fetch(`${API_URL}/accounts`)
            ]);

            if (!rawAccountsRes.ok) throw new Error('Failed to fetch raw accounts');
            if (!accountsRes.ok) throw new Error('Failed to fetch accounts');

            const rawAccountsData = await rawAccountsRes.json();
            const accountsData = await accountsRes.json();

            setRawAccounts(rawAccountsData);
            setAccounts(accountsData);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    };

    // Compute smart suggestions
    const suggestionsMap = useMemo(() => {
        const map = new Map<string, SuggestedMatch[]>();

        rawAccounts
            .filter(ra => !ra.account_id)
            .forEach(rawAccount => {
                const label = rawAccount.label;
                const suggestions: SuggestedMatch[] = [];

                for (const account of accounts) {
                    const nameSim = calculateSimilarity(label, account.name);
                    const addrSim = account.address_or_identifier
                        ? calculateSimilarity(label, account.address_or_identifier)
                        : 0;
                    const similarity = Math.max(nameSim, addrSim);

                    if (similarity >= 0.5) {
                        suggestions.push({ account, confidence: similarity });
                    }
                }

                suggestions.sort((a, b) => b.confidence - a.confidence);
                const key = `${rawAccount.source}:${rawAccount.label}`;
                map.set(key, suggestions.slice(0, 3));
            });

        return map;
    }, [rawAccounts, accounts]);

    // Group by source
    const groupedBySource = useMemo(() => {
        const groups = new Map<string, RawAccount[]>();
        rawAccounts.forEach(ra => {
            if (!groups.has(ra.source)) {
                groups.set(ra.source, []);
            }
            groups.get(ra.source)!.push(ra);
        });
        return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
    }, [rawAccounts]);

    const uniqueSources = [...new Set(rawAccounts.map(ra => ra.source))];

    if (loading) {
        return (
            <Box textAlign="center" py={10}>
                <Spinner size="xl" color="blue.500" />
                <Text mt={4}>Loading account mappings...</Text>
            </Box>
        );
    }

    if (error) {
        return (
            <Box textAlign="center" py={10} bg="red.50" borderRadius="md" borderWidth={1} borderColor="red.200">
                <Text color="red.600">Error: {error}</Text>
            </Box>
        );
    }

    if (rawAccounts.length === 0) {
        return (
            <Box textAlign="center" py={10} bg="green.50" borderRadius="md">
                <Text fontSize="2xs" fontWeight="medium" color="green.700">
                    ✅ {mode === 'issues-only' ? 'All accounts mapped!' : 'No raw accounts found'}
                </Text>
            </Box>
        );
    }

    return (
        <Box>
            {mode === 'full' && (
                <Flex gap={4} mb={4} align="center" flexWrap="wrap">
                    <Flex align="center" gap={2}>
                        <Text fontWeight="medium" fontSize="2xs">Source:</Text>
                        <NativeSelect.Root size="sm" width="150px" value={sourceFilter} onValueChange={(e) => setSourceFilter(e.value[0])}>
                            <NativeSelect.Field placeholder="All">
                                <option value="">All sources</option>
                                {uniqueSources.map(s => (
                                    <option key={s} value={s}>{s}</option>
                                ))}
                            </NativeSelect.Field>
                        </NativeSelect.Root>
                    </Flex>
                    {onDismissedChange && (
                        <Button
                            size="sm"
                            fontSize="2xs"
                            variant="outline"
                            onClick={() => onDismissedChange(!includeDismissed)}
                        >
                            {includeDismissed ? 'Hide' : 'Show'} Dismissed
                        </Button>
                    )}
                </Flex>
            )}

            {groupedBySource.map(([source, sourceRawAccounts]) => (
                <SourceGroup
                    key={source}
                    source={source}
                    rawAccounts={sourceRawAccounts}
                    accounts={accounts}
                    suggestionsMap={suggestionsMap}
                    onRefresh={fetchData}
                />
            ))}
        </Box>
    );
};
