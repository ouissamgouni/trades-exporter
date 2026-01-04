/**
 * TransactionDetailPanel - Tabbed panel for expanded transaction details
 * 
 * Displays transaction details in a clean tabbed interface:
 * - Overview: Key info, tags, and notes
 * - Details: Source vs Linked info comparison
 * - Raw Data: On-demand fetch of original exchange data
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
    Badge,
    Box,
    Button,
    Card,
    Flex,
    Input,
    Tabs,
    Text,
    Textarea,
    Code,
} from '@chakra-ui/react';
import { FiCopy, FiCheck, FiLoader, FiExternalLink, FiTag, FiX } from 'react-icons/fi';
import { Transaction, Account, API_URL } from '../types';

// ============================================================================
// Types
// ============================================================================

interface RawTransactionData {
    id: number;
    source: string;
    source_transaction_id: string;
    raw_data: Record<string, unknown>;
    ingestion_time: string;
}

interface TransactionDetailPanelProps {
    transaction: Transaction;
    accounts: Account[];
    onNotesChange?: (txId: number, notes: string) => void;
    onTagsChange?: (txId: number, tags: Record<string, unknown>[]) => void;
}

// ============================================================================
// Helpers
// ============================================================================

const formatCurrency = (value: number | null | undefined, decimals = 2): string => {
    if (value == null) return '-';
    return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    }).format(value);
};

const formatQty = (value: number | null | undefined): string => {
    if (value == null) return '-';
    if (value === 0) return '0';
    // Show up to 8 decimal places, trimming trailing zeros
    return value.toFixed(8).replace(/\.?0+$/, '');
};

const formatDate = (dateStr: string | number | null | undefined): string => {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleString();
};

// ============================================================================
// Sub-components
// ============================================================================

interface InfoRowProps {
    label: string;
    value: React.ReactNode;
    muted?: boolean;
}

const InfoRow: React.FC<InfoRowProps> = ({ label, value, muted }) => (
    <Flex justify="space-between" py={1} borderBottom="1px solid" borderColor="gray.100">
        <Text fontSize="xs" color="gray.500" fontWeight="medium">{label}</Text>
        <Text fontSize="xs" color={muted ? 'gray.400' : 'gray.700'} fontFamily="mono">
            {value}
        </Text>
    </Flex>
);

interface TagChipProps {
    tag: Record<string, unknown>;
    onRemove?: () => void;
    editable?: boolean;
}

const TagChip: React.FC<TagChipProps> = ({ tag, onRemove, editable }) => {
    // Tags can be {key: value} or just strings converted to {value: string}
    const displayText = Object.entries(tag)
        .map(([k, v]) => k === 'value' ? String(v) : `${k}: ${v}`)
        .join(', ');

    return (
        <Badge
            size="xs"
            colorPalette="blue"
            variant="subtle"
            display="flex"
            alignItems="center"
            gap={0.5}
            px={1.5}
            py={0.5}
            fontSize="10px"
        >
            <FiTag size={8} />
            <Text fontSize="10px">{displayText}</Text>
            {editable && onRemove && (
                <Box
                    as="button"
                    onClick={onRemove}
                    ml={0.5}
                    cursor="pointer"
                    _hover={{ color: 'red.500' }}
                >
                    <FiX size={10} />
                </Box>
            )}
        </Badge>
    );
};

// ============================================================================
// Main Component
// ============================================================================

export const TransactionDetailPanel: React.FC<TransactionDetailPanelProps> = ({
    transaction: tx,
    accounts,
    onNotesChange,
    onTagsChange,
}) => {
    const [activeTab, setActiveTab] = useState('overview');
    
    // Raw data state
    const [rawData, setRawData] = useState<RawTransactionData | null>(null);
    const [rawDataLoading, setRawDataLoading] = useState(false);
    const [rawDataError, setRawDataError] = useState<string | null>(null);
    const [hasFetchedRaw, setHasFetchedRaw] = useState(false);
    const [copied, setCopied] = useState(false);

    // Notes editing state
    const [isEditingNotes, setIsEditingNotes] = useState(false);
    const [notesValue, setNotesValue] = useState(tx.review_notes || '');

    // Tags state
    const [newTagKey, setNewTagKey] = useState('');
    const [newTagValue, setNewTagValue] = useState('');

    // Fetch raw transaction data on-demand
    const fetchRawData = useCallback(async () => {
        if (!tx.raw_transaction_id || hasFetchedRaw || rawDataLoading) return;
        
        setRawDataLoading(true);
        setHasFetchedRaw(true);
        try {
            const response = await fetch(`${API_URL}/raw-transactions/${tx.raw_transaction_id}`);
            if (!response.ok) throw new Error('Failed to fetch raw transaction');
            const data = await response.json();
            setRawData(data);
        } catch (err) {
            setRawDataError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setRawDataLoading(false);
        }
    }, [tx.raw_transaction_id, hasFetchedRaw, rawDataLoading]);

    // Fetch raw data when switching to raw tab
    useEffect(() => {
        if (activeTab === 'raw' && !hasFetchedRaw) {
            fetchRawData();
        }
    }, [activeTab, hasFetchedRaw, fetchRawData]);

    // Copy JSON to clipboard
    const copyJson = async () => {
        if (!rawData?.raw_data) return;
        await navigator.clipboard.writeText(JSON.stringify(rawData.raw_data, null, 2));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // Save notes
    const saveNotes = () => {
        if (onNotesChange) {
            onNotesChange(tx.id, notesValue);
        }
        setIsEditingNotes(false);
    };

    // Add tag
    const addTag = () => {
        if (!newTagValue.trim()) return;
        const newTag = newTagKey.trim() 
            ? { [newTagKey.trim()]: newTagValue.trim() }
            : { value: newTagValue.trim() };
        
        const currentTags = tx.tags || [];
        if (onTagsChange) {
            onTagsChange(tx.id, [...currentTags, newTag]);
        }
        setNewTagKey('');
        setNewTagValue('');
    };

    // Remove tag
    const removeTag = (index: number) => {
        const currentTags = tx.tags || [];
        if (onTagsChange) {
            onTagsChange(tx.id, currentTags.filter((_, i) => i !== index));
        }
    };

    // Find account name by ID
    const getAccountName = (accountId: number | null | undefined): string => {
        if (!accountId) return '-';
        const account = accounts.find(a => a.id === accountId);
        return account?.name || `#${accountId}`;
    };

    return (
        <Box bg="gray.50" borderRadius="md" overflow="hidden">
            <Tabs.Root 
                value={activeTab} 
                onValueChange={(e) => setActiveTab(e.value)}
                size="sm"
            >
                <Tabs.List bg="white" borderBottom="1px solid" borderColor="gray.200" px={2}>
                    <Tabs.Trigger value="overview" fontSize="xs" px={3} py={2}>
                        📊 Overview
                    </Tabs.Trigger>
                    <Tabs.Trigger value="details" fontSize="xs" px={3} py={2}>
                        📋 Details
                    </Tabs.Trigger>
                    <Tabs.Trigger value="raw" fontSize="xs" px={3} py={2}>
                        🔗 Raw Data
                        {tx.raw_transaction_id && (
                            <Badge ml={1} size="xs" colorPalette="gray">#{tx.raw_transaction_id}</Badge>
                        )}
                    </Tabs.Trigger>
                </Tabs.List>

                {/* Overview Tab */}
                <Tabs.Content value="overview" p={3}>
                    <Flex gap={4} wrap="wrap">
                        {/* Key Info Card */}
                        <Card.Root size="sm" flex="1" minW="200px">
                            <Card.Body p={3}>
                                <Text fontSize="xs" fontWeight="bold" color="gray.600" mb={2}>
                                    📊 Key Information
                                </Text>
                                <InfoRow 
                                    label="Asset" 
                                    value={
                                        <Badge size="sm" colorPalette="purple">
                                            {tx.linked_asset_symbol || tx.source_asset_symbol || '-'}
                                        </Badge>
                                    } 
                                />
                                <InfoRow label="Quantity" value={formatQty(tx.quantity)} />
                                <InfoRow 
                                    label="Price" 
                                    value={`${formatCurrency(tx.price)} ${tx.linked_price_quote_asset_symbol || tx.source_price_quote_asset_symbol || ''}`} 
                                />
                                <InfoRow 
                                    label="Total" 
                                    value={`${formatCurrency(tx.total)} ${tx.linked_price_quote_asset_symbol || tx.source_price_quote_asset_symbol || ''}`} 
                                />
                                <InfoRow 
                                    label="Fee" 
                                    value={tx.fee ? `${formatQty(tx.fee)} ${tx.linked_fee_quote_asset_symbol || tx.source_fee_quote_asset_symbol || ''}` : '-'} 
                                />
                                <InfoRow 
                                    label="Include Fee" 
                                    value={tx.include_fee ? '✓ Yes' : '✗ No'} 
                                    muted={!tx.include_fee}
                                />
                            </Card.Body>
                        </Card.Root>

                        {/* Type & Status Card */}
                        <Card.Root size="sm" flex="1" minW="180px">
                            <Card.Body p={3}>
                                <Text fontSize="xs" fontWeight="bold" color="gray.600" mb={2}>
                                    🏷️ Type & Status
                                </Text>
                                <InfoRow 
                                    label="Direction" 
                                    value={
                                        <Badge 
                                            size="sm" 
                                            colorPalette={tx.direction === 'inflow' ? 'green' : tx.direction === 'outflow' ? 'red' : 'gray'}
                                        >
                                            {tx.direction}
                                        </Badge>
                                    } 
                                />
                                <InfoRow label="Type" value={tx.transaction_type || '-'} />
                                <InfoRow label="Source Type" value={tx.source_transaction_type || '-'} muted />
                                <InfoRow 
                                    label="Review" 
                                    value={
                                        <Badge 
                                            size="sm" 
                                            colorPalette={tx.review_status === 'valid' ? 'green' : tx.review_status === 'invalid' ? 'red' : 'yellow'}
                                        >
                                            {tx.review_status}
                                        </Badge>
                                    } 
                                />
                                <InfoRow label="Synced" value={formatDate(tx.synced_at)} muted />
                            </Card.Body>
                        </Card.Root>

                        {/* Accounts Card */}
                        <Card.Root size="sm" flex="1" minW="180px">
                            <Card.Body p={3}>
                                <Text fontSize="xs" fontWeight="bold" color="gray.600" mb={2}>
                                    👤 Accounts
                                </Text>
                                <InfoRow label="Account" value={getAccountName(tx.account_id ?? null)} />
                                <InfoRow label="From" value={getAccountName(tx.from_account_id)} />
                                <InfoRow label="To" value={getAccountName(tx.to_account_id)} />
                                {tx.network && (
                                    <InfoRow label="Network" value={tx.network} />
                                )}
                            </Card.Body>
                        </Card.Root>

                        {/* Tags Card */}
                        <Card.Root size="sm" flex="1" minW="200px">
                            <Card.Body p={3}>
                                <Text fontSize="xs" fontWeight="bold" color="gray.600" mb={2}>
                                    🏷️ Tags
                                </Text>
                                <Flex gap={1} wrap="wrap" mb={2}>
                                    {tx.tags && tx.tags.length > 0 ? (
                                        tx.tags.map((tag, i) => (
                                            <TagChip 
                                                key={i} 
                                                tag={tag} 
                                                editable={!!onTagsChange}
                                                onRemove={() => removeTag(i)}
                                            />
                                        ))
                                    ) : (
                                        <Text fontSize="xs" color="gray.400">No tags</Text>
                                    )}
                                </Flex>
                                {onTagsChange && (
                                    <Flex gap={1} mt={2}>
                                        <Input 
                                            size="xs" 
                                            placeholder="Key (optional)" 
                                            value={newTagKey}
                                            onChange={(e) => setNewTagKey(e.target.value)}
                                            width="80px"
                                        />
                                        <Input 
                                            size="xs" 
                                            placeholder="Value" 
                                            value={newTagValue}
                                            onChange={(e) => setNewTagValue(e.target.value)}
                                            flex="1"
                                            onKeyDown={(e) => e.key === 'Enter' && addTag()}
                                        />
                                        <Button size="xs" onClick={addTag} disabled={!newTagValue.trim()}>
                                            Add
                                        </Button>
                                    </Flex>
                                )}
                            </Card.Body>
                        </Card.Root>
                    </Flex>

                    {/* Notes Section */}
                    <Card.Root size="sm" mt={3}>
                        <Card.Body p={3}>
                            <Flex justify="space-between" align="center" mb={2}>
                                <Text fontSize="xs" fontWeight="bold" color="gray.600">
                                    📝 Notes
                                </Text>
                                {!isEditingNotes && onNotesChange && (
                                    <Button size="xs" variant="ghost" onClick={() => setIsEditingNotes(true)}>
                                        Edit
                                    </Button>
                                )}
                            </Flex>
                            {isEditingNotes ? (
                                <Flex direction="column" gap={2}>
                                    <Textarea
                                        size="sm"
                                        value={notesValue}
                                        onChange={(e) => setNotesValue(e.target.value)}
                                        placeholder="Add notes..."
                                        rows={3}
                                        fontSize="xs"
                                    />
                                    <Flex gap={2} justify="flex-end">
                                        <Button size="xs" variant="ghost" onClick={() => {
                                            setNotesValue(tx.review_notes || '');
                                            setIsEditingNotes(false);
                                        }}>
                                            Cancel
                                        </Button>
                                        <Button size="xs" colorPalette="blue" onClick={saveNotes}>
                                            Save
                                        </Button>
                                    </Flex>
                                </Flex>
                            ) : (
                                <Text 
                                    fontSize="xs" 
                                    color={tx.review_notes ? 'gray.700' : 'gray.400'}
                                    whiteSpace="pre-wrap"
                                >
                                    {tx.review_notes || 'No notes added'}
                                </Text>
                            )}
                        </Card.Body>
                    </Card.Root>
                </Tabs.Content>

                {/* Details Tab */}
                <Tabs.Content value="details" p={3}>
                    <Flex gap={4}>
                        {/* Source Data */}
                        <Card.Root size="sm" flex="1">
                            <Card.Body p={3}>
                                <Text fontSize="xs" fontWeight="bold" color="orange.600" mb={2}>
                                    📤 Source Data (Raw)
                                </Text>
                                <InfoRow label="Source" value={tx.source || '-'} />
                                <InfoRow label="Source TX ID" value={tx.source_transaction_id || '-'} />
                                <InfoRow label="Asset Symbol" value={tx.source_asset_symbol || '-'} />
                                <InfoRow label="Price Quote" value={tx.source_price_quote_asset_symbol || '-'} />
                                <InfoRow label="Fee Quote" value={tx.source_fee_quote_asset_symbol || '-'} />
                                <InfoRow label="TX Type" value={tx.source_transaction_type || '-'} />
                                <InfoRow label="From Address" value={
                                    <Text fontSize="xs" maxW="150px" truncate title={tx.source_from_account || ''}>
                                        {tx.source_from_account || '-'}
                                    </Text>
                                } />
                                <InfoRow label="To Address" value={
                                    <Text fontSize="xs" maxW="150px" truncate title={tx.source_to_account || ''}>
                                        {tx.source_to_account || '-'}
                                    </Text>
                                } />
                            </Card.Body>
                        </Card.Root>

                        {/* Linked/Resolved Data */}
                        <Card.Root size="sm" flex="1">
                            <Card.Body p={3}>
                                <Text fontSize="xs" fontWeight="bold" color="blue.600" mb={2}>
                                    🔗 Linked Data (Resolved)
                                </Text>
                                <InfoRow label="Asset" value={
                                    tx.asset_id ? (
                                        <Badge size="sm" colorPalette="purple">
                                            {tx.linked_asset_symbol || `#${tx.asset_id}`}
                                        </Badge>
                                    ) : <Text color="orange.500">Not linked</Text>
                                } />
                                <InfoRow label="Asset ID" value={tx.asset_id ?? 'Not linked'} muted={!tx.asset_id} />
                                <InfoRow label="Price Quote" value={
                                    tx.price_quote_asset_id ? (
                                        <Badge size="sm" colorPalette="green">
                                            {tx.linked_price_quote_asset_symbol || `#${tx.price_quote_asset_id}`}
                                        </Badge>
                                    ) : <Text color="orange.500">Not linked</Text>
                                } />
                                <InfoRow label="Fee Quote" value={
                                    tx.fee_quote_asset_id ? (
                                        <Badge size="sm" colorPalette="green">
                                            {tx.linked_fee_quote_asset_symbol || `#${tx.fee_quote_asset_id}`}
                                        </Badge>
                                    ) : <Text color="orange.500">Not linked</Text>
                                } />
                                <InfoRow label="TX Type" value={tx.transaction_type || '-'} />
                                <InfoRow label="From Account" value={getAccountName(tx.from_account_id)} />
                                <InfoRow label="To Account" value={getAccountName(tx.to_account_id)} />
                            </Card.Body>
                        </Card.Root>

                        {/* IDs & Metadata */}
                        <Card.Root size="sm" flex="1">
                            <Card.Body p={3}>
                                <Text fontSize="xs" fontWeight="bold" color="gray.600" mb={2}>
                                    🆔 Identifiers
                                </Text>
                                <InfoRow label="Transaction ID" value={tx.id} />
                                <InfoRow label="Raw TX ID" value={tx.raw_transaction_id ?? 'None'} muted={!tx.raw_transaction_id} />
                                <InfoRow label="Network TX" value={
                                    tx.network_transaction_id ? (
                                        <Text fontSize="xs" maxW="120px" truncate title={tx.network_transaction_id}>
                                            {tx.network_transaction_id}
                                        </Text>
                                    ) : '-'
                                } />
                                <InfoRow label="Contract" value={
                                    tx.token_contract_address ? (
                                        <Text fontSize="xs" maxW="120px" truncate title={tx.token_contract_address}>
                                            {tx.token_contract_address}
                                        </Text>
                                    ) : '-'
                                } />
                                <InfoRow label="Network" value={tx.network || '-'} />
                            </Card.Body>
                        </Card.Root>
                    </Flex>
                </Tabs.Content>

                {/* Raw Data Tab */}
                <Tabs.Content value="raw" p={3}>
                    {!tx.raw_transaction_id ? (
                        <Card.Root size="sm">
                            <Card.Body p={4} textAlign="center">
                                <Text fontSize="sm" color="gray.500">
                                    No raw transaction linked to this transaction.
                                </Text>
                                <Text fontSize="xs" color="gray.400" mt={1}>
                                    This may be a manually created transaction.
                                </Text>
                            </Card.Body>
                        </Card.Root>
                    ) : rawDataLoading ? (
                        <Flex align="center" justify="center" py={8} gap={2}>
                            <FiLoader className="animate-spin" />
                            <Text fontSize="sm" color="gray.500">Loading raw transaction data...</Text>
                        </Flex>
                    ) : rawDataError ? (
                        <Card.Root size="sm" borderColor="red.200">
                            <Card.Body p={4}>
                                <Text fontSize="sm" color="red.500">
                                    Error loading raw data: {rawDataError}
                                </Text>
                                <Button 
                                    size="xs" 
                                    mt={2} 
                                    onClick={() => {
                                        setHasFetchedRaw(false);
                                        setRawDataError(null);
                                        fetchRawData();
                                    }}
                                >
                                    Retry
                                </Button>
                            </Card.Body>
                        </Card.Root>
                    ) : rawData ? (
                        <Card.Root size="sm">
                            <Card.Body p={3}>
                                <Flex justify="space-between" align="center" mb={2}>
                                    <Flex align="center" gap={2}>
                                        <Text fontSize="xs" fontWeight="bold" color="gray.600">
                                            Raw Transaction #{rawData.id}
                                        </Text>
                                        <Badge size="xs" colorPalette="gray">{rawData.source}</Badge>
                                    </Flex>
                                    <Button 
                                        size="xs" 
                                        variant="ghost" 
                                        onClick={copyJson}
                                        leftIcon={copied ? <FiCheck /> : <FiCopy />}
                                    >
                                        {copied ? 'Copied!' : 'Copy JSON'}
                                    </Button>
                                </Flex>
                                <Text fontSize="xs" color="gray.500" mb={2}>
                                    Source ID: {rawData.source_transaction_id} • Ingested: {formatDate(rawData.ingestion_time)}
                                </Text>
                                <Box
                                    bg="gray.900"
                                    color="green.300"
                                    p={3}
                                    borderRadius="md"
                                    fontSize="xs"
                                    fontFamily="mono"
                                    maxH="300px"
                                    overflowY="auto"
                                    whiteSpace="pre-wrap"
                                    wordBreak="break-all"
                                >
                                    {JSON.stringify(rawData.raw_data, null, 2)}
                                </Box>
                            </Card.Body>
                        </Card.Root>
                    ) : null}
                </Tabs.Content>
            </Tabs.Root>
        </Box>
    );
};

export default TransactionDetailPanel;
