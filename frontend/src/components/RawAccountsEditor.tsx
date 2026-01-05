import {
    Badge, Box,
    Button, Dialog, Flex,
    Heading, Input, NativeSelect, Portal, Spinner,
    Table, Text, HStack
} from '@chakra-ui/react';
import React, { useEffect, useState, useMemo } from 'react';
import { API_URL, Account, RawAccount } from '../types';
import { Tooltip } from './ui/tooltip';

// Fuzzy matching utility for smart suggestions
const calculateSimilarity = (str1: string, str2: string): number => {
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();

    // Exact match
    if (s1 === s2) return 1.0;

    // Contains match
    if (s1.includes(s2) || s2.includes(s1)) return 0.8;

    // Starts/ends with match (good for addresses)
    if (s1.startsWith(s2) || s2.startsWith(s1)) return 0.7;
    if (s1.endsWith(s2) || s2.endsWith(s1)) return 0.6;

    // For blockchain addresses, compare first and last chars
    if (s1.length > 10 && s2.length > 10) {
        const prefix1 = s1.slice(0, 6);
        const prefix2 = s2.slice(0, 6);
        const suffix1 = s1.slice(-4);
        const suffix2 = s2.slice(-4);
        if (prefix1 === prefix2 && suffix1 === suffix2) return 0.95;
        if (prefix1 === prefix2 || suffix1 === suffix2) return 0.5;
    }

    // Levenshtein for short strings
    const maxLen = Math.max(s1.length, s2.length);
    if (maxLen === 0) return 1.0;
    if (maxLen > 20) return 0; // Skip for long addresses

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

    // Compute smart suggestions for unlinked raw accounts
    const suggestionsMap = useMemo(() => {
        const map = new Map<string, SuggestedMatch[]>();

        rawAccounts
            .filter(ra => ra.account_id === null || ra.account_id === undefined)
            .forEach(rawAccount => {
                const label = rawAccount.label;
                const suggestions: SuggestedMatch[] = [];

                for (const account of accounts) {
                    // Compare against account name and address
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

    // Quick accept suggestion
    const acceptSuggestion = async (rawAccount: RawAccount, accountId: number) => {
        try {
            const response = await fetch(`${API_URL}/raw-accounts/${encodeURIComponent(rawAccount.source)}/${encodeURIComponent(rawAccount.label)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ account_id: accountId })
            });
            if (!response.ok) throw new Error('Failed to update raw account');
            await fetchRawAccounts();
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to save');
        }
    };

    // Bulk auto-map all high-confidence suggestions
    const autoMapAll = async () => {
        const toMap: { rawAccount: RawAccount; accountId: number }[] = [];

        rawAccounts
            .filter(ra => ra.account_id === null || ra.account_id === undefined)
            .forEach(rawAccount => {
                const key = getEditKey(rawAccount);
                const suggestions = suggestionsMap.get(key) || [];
                if (suggestions.length > 0 && suggestions[0].confidence >= 0.9) {
                    toMap.push({ rawAccount, accountId: suggestions[0].account.id });
                }
            });

        if (toMap.length === 0) {
            alert('No high-confidence matches found to auto-map');
            return;
        }

        if (!confirm(`Auto-map ${toMap.length} raw account(s) with high confidence matches?`)) return;

        for (const { rawAccount, accountId } of toMap) {
            await acceptSuggestion(rawAccount, accountId);
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

    // Count suggestions available
    const suggestionsAvailableCount = Array.from(suggestionsMap.values()).filter(s => s.length > 0).length;
    const highConfidenceCount = Array.from(suggestionsMap.values()).filter(s => s.length > 0 && s[0].confidence >= 0.9).length;

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
                    {highConfidenceCount > 0 && (
                        <Button colorPalette="green" variant="outline" onClick={autoMapAll}>
                            ✨ Auto-Map ({highConfidenceCount})
                        </Button>
                    )}
                    <Button colorPalette="blue" onClick={() => setShowCreateDialog(true)}>
                        ➕ Add Mapping
                    </Button>
                    <Button onClick={fetchRawAccounts} variant="outline">
                        🔄 Refresh
                    </Button>
                </Flex>
            </Flex>

            {/* Smart Suggestions Banner */}
            {suggestionsAvailableCount > 0 && (
                <Box mb={4} p={3} bg="blue.50" borderRadius="md" borderWidth={1} borderColor="blue.200">
                    <HStack justify="space-between">
                        <Text fontSize="sm" color="blue.700">
                            💡 <strong>{suggestionsAvailableCount}</strong> unlinked account(s) have suggested matches.
                            {highConfidenceCount > 0 && ` ${highConfidenceCount} high-confidence match(es) can be auto-mapped.`}
                        </Text>
                    </HStack>
                </Box>
            )}

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
                            <Table.ColumnHeader>Suggestions</Table.ColumnHeader>
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
                                const suggestions = suggestionsMap.get(key) || [];
                                const isUnlinked = rawAccount.account_id === null || rawAccount.account_id === undefined;

                                return (
                                    <Table.Row key={key} bg={isUnlinked ? 'orange.50' : undefined}>
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
                                                    <Badge colorPalette="green">{getAccountName(rawAccount.account_id)}</Badge>
                                                ) : (
                                                    <Text fontSize="sm" color="gray.400">Not linked</Text>
                                                )
                                            )}
                                        </Table.Cell>
                                        <Table.Cell>
                                            {/* Smart Suggestions Column */}
                                            {isUnlinked && suggestions.length > 0 && !isEditing ? (
                                                <HStack gap={1} flexWrap="wrap">
                                                    {suggestions.map((s, idx) => (
                                                        <Tooltip key={idx} content={`${Math.round(s.confidence * 100)}% match - Click to accept`}>
                                                            <Button
                                                                size="xs"
                                                                variant={s.confidence >= 0.9 ? "solid" : "outline"}
                                                                colorPalette={s.confidence >= 0.9 ? "green" : s.confidence >= 0.7 ? "blue" : "gray"}
                                                                onClick={() => acceptSuggestion(rawAccount, s.account.id)}
                                                            >
                                                                {s.account.name}
                                                                {s.confidence >= 0.9 && " ✓"}
                                                            </Button>
                                                        </Tooltip>
                                                    ))}
                                                </HStack>
                                            ) : isUnlinked && !isEditing ? (
                                                <Text fontSize="xs" color="gray.400">No matches</Text>
                                            ) : (
                                                <Text fontSize="xs" color="gray.400">—</Text>
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
