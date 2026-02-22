/**
 * TransactionDetailPanel - Nested collapsible accordion sections
 * 
 * Structure:
 * - Overview (main section)
 *   - Key Infos: datetime, account, source, type, asset, qty, price, total, fee, review
 *   - P&L: include fees, taxability
 *   - Network: from/to account, network, network tx id
 *   - Tags
 *   - Notes
 * - Details (main section)
 *   - Source: all source_ prefixed fields
 *   - Source-Mappings: source vs resolved with alerts
 *   - Raw Data: raw data id + content
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
    Badge,
    Box,
    Button,
    Flex,
    Input,
    Text,
    Textarea,
} from '@chakra-ui/react';
import { FiCopy, FiCheck, FiLoader, FiTag, FiX, FiChevronDown, FiChevronRight, FiAlertTriangle, FiArrowDown, FiArrowUp } from 'react-icons/fi';
import { Transaction, Account, API_URL } from '../types';
import { AssetBadge } from './AssetBadge';
import { formatDateTimeLocale } from '../utils/dateUtils';
import { ValueDisplay } from './ValueDisplay';

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

// Using formatDateTimeLocale from utils/dateUtils for consistent date formatting

// ============================================================================
// Sub-components
// ============================================================================

interface InfoRowProps {
    label: string;
    value: React.ReactNode;
    muted?: boolean;
    alert?: boolean;
}

const InfoRow: React.FC<InfoRowProps> = ({ label, value, muted, alert }) => (
    <Flex justify="space-between" py={0.5} gap={2} align="center">
        <Text fontSize="10px" color="gray.500" flexShrink={0}>{label}</Text>
        <Flex align="center" gap={1}>
            {alert && <FiAlertTriangle size={10} color="orange" />}
            <Box
                as="span"
                fontSize="10px"
                color={alert ? 'orange.500' : muted ? 'gray.400' : 'gray.700'}
                fontFamily="mono"
                textAlign="right"
                css={{ wordBreak: 'break-all' }}
            >
                {value}
            </Box>
        </Flex>
    </Flex>
);

interface SectionProps {
    title: string;
    icon?: string;
    children: React.ReactNode;
    defaultOpen?: boolean;
    level?: 'main' | 'sub';
    colorScheme?: string;
}

const Section: React.FC<SectionProps> = ({
    title,
    icon,
    children,
    defaultOpen = true,
    level = 'sub',
    colorScheme = 'gray'
}) => {
    const [isOpen, setIsOpen] = useState(defaultOpen);

    const isMain = level === 'main';

    return (
        <Box mb={isMain ? 2 : 1}>
            <Flex
                align="center"
                gap={1}
                py={isMain ? 1.5 : 1}
                px={2}
                bg={isMain ? `${colorScheme}.100` : `${colorScheme}.50`}
                borderRadius="sm"
                cursor="pointer"
                onClick={() => setIsOpen(!isOpen)}
                _hover={{ bg: isMain ? `${colorScheme}.200` : `${colorScheme}.100` }}
            >
                {isOpen ? <FiChevronDown size={isMain ? 14 : 12} /> : <FiChevronRight size={isMain ? 14 : 12} />}
                <Text
                    fontSize={isMain ? "11px" : "10px"}
                    fontWeight="bold"
                    color={`${colorScheme}.700`}
                    textTransform={isMain ? "uppercase" : "none"}
                >
                    {icon && `${icon} `}{title}
                </Text>
            </Flex>
            {isOpen && (
                <Box px={isMain ? 1 : 2} py={1} ml={isMain ? 0 : 2}>
                    {children}
                </Box>
            )}
        </Box>
    );
};

interface TagChipProps {
    tag: Record<string, unknown>;
    onRemove?: () => void;
    editable?: boolean;
}

const TagChip: React.FC<TagChipProps> = ({ tag, onRemove, editable }) => {
    // Display each key:value pair as a separate badge
    const entries = Object.entries(tag);

    return (
        <>
            {entries.map(([key, value], index) => (
                <Badge
                    key={index}
                    size="xs"
                    colorPalette="blue"
                    variant="subtle"
                    display="flex"
                    alignItems="center"
                    gap={0.5}
                    px={1}
                    py={0.5}
                    fontSize="9px"
                >
                    <FiTag size={8} />
                    <Text fontSize="9px">{key === 'value' ? String(value) : `${key}: ${value}`}</Text>
                    {editable && onRemove && index === entries.length - 1 && (
                        <Box
                            as="button"
                            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onRemove(); }}
                            ml={0.5}
                            cursor="pointer"
                            _hover={{ color: 'red.500' }}
                        >
                            <FiX size={8} />
                        </Box>
                    )}
                </Badge>
            ))}
        </>
    );
};

// Helper function to normalize tags (convert dict with numeric keys to array)
const normalizeTags = (tags: any): Record<string, unknown>[] => {
    if (!tags) return [];
    if (Array.isArray(tags)) return tags;

    // Check if it's a dict with numeric keys like {"0": {...}, "1": {...}}
    const keys = Object.keys(tags);
    const allNumeric = keys.every(k => !isNaN(Number(k)));

    if (allNumeric) {
        // Convert to array by extracting values
        return keys.sort((a, b) => Number(a) - Number(b)).map(k => tags[k]);
    }

    // Otherwise, treat as a single tag object
    return [tags];
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
    // Normalize tags on component mount/update
    const normalizedTags = normalizeTags(tx.tags);

    // Bundle/Calculation Unit state
    const [bundleData, setBundleData] = useState<{ id: number; pattern: string | null; label: string | null } | null>(null);
    const [bundleLoading, setBundleLoading] = useState(false);

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

    // Fetch bundle data if transaction is part of a calculation unit
    useEffect(() => {
        const fetchBundle = async () => {
            if (!tx.user_calculation_unit_id) {
                setBundleData(null);
                return;
            }

            setBundleLoading(true);
            try {
                const response = await fetch(`${API_URL}/bundles/${tx.user_calculation_unit_id}`);
                if (response.ok) {
                    const data = await response.json();
                    setBundleData({
                        id: data.id,
                        pattern: data.pattern || null,
                        label: data.label || null,
                    });
                }
            } catch (err) {
                console.error('Failed to fetch bundle:', err);
            } finally {
                setBundleLoading(false);
            }
        };

        fetchBundle();
    }, [tx.user_calculation_unit_id]);

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

        if (onTagsChange) {
            onTagsChange(tx.id, [...normalizedTags, newTag]);
        }
        setNewTagKey('');
        setNewTagValue('');
    };

    // Remove tag
    const removeTag = (index: number) => {
        if (onTagsChange) {
            onTagsChange(tx.id, normalizedTags.filter((_: Record<string, unknown>, i: number) => i !== index));
        }
    };

    // Find account name by ID
    const getAccountName = (accountId: number | null | undefined): string => {
        if (!accountId) return '-';
        const account = accounts.find(a => a.id === accountId);
        return account?.name || `#${accountId}`;
    };

    return (
        <Box>
            {/* ============================================================ */}
            {/* OVERVIEW SECTION */}
            {/* ============================================================ */}
            <Section title="Overview" level="main" defaultOpen={true} colorScheme="blue">

                {/* Key Infos */}
                <Section title="Key Infos" icon="📊" defaultOpen={true} colorScheme="purple">
                    <InfoRow label="Date/Time" value={formatDateTimeLocale(tx.date_time)} />
                    <InfoRow label="Account" value={
                        <Box>
                            <Text fontSize="10px" fontFamily="mono" fontWeight="medium">{getAccountName(tx.account_id ?? null)}</Text>
                            {tx.source_account && (
                                <Text fontSize="8px" color="gray.500" fontFamily="mono" mt={0.5}>
                                    {tx.source_account}
                                </Text>
                            )}
                        </Box>
                    } />
                    <InfoRow label="Source" value={tx.source || '-'} muted />
                    <InfoRow
                        label="Type"
                        value={
                            <Flex align="center" gap={1} wrap="wrap">
                                {tx.source_transaction_type && (
                                    <Badge size="xs" colorPalette="blue" variant="subtle" fontSize="9px">
                                        {tx.source_transaction_type}
                                    </Badge>
                                )}
                                {tx.source_transaction_type && tx.transaction_type && (
                                    <Text fontSize="9px" color="gray.400">→</Text>
                                )}
                                <Badge size="xs" colorPalette="gray" fontSize="9px">
                                    {tx.transaction_type || '-'}
                                </Badge>
                                {tx.direction && (
                                    <Flex align="center" gap={0.5} ml={1}>
                                        {tx.direction === 'inflow' ? (
                                            <FiArrowDown size={10} color="var(--chakra-colors-green-500)" />
                                        ) : tx.direction === 'outflow' ? (
                                            <FiArrowUp size={10} color="var(--chakra-colors-red-500)" />
                                        ) : null}
                                        <Text fontSize="8px" color="gray.500">
                                            {tx.direction}
                                        </Text>
                                    </Flex>
                                )}
                            </Flex>
                        }
                    />
                    <InfoRow
                        label="Asset"
                        value={
                            <AssetBadge
                                asset={tx.linked_asset}
                                sourceSymbol={tx.source_asset_symbol}
                                size="xs"
                                colorPalette="purple"
                                maxLength={18}
                            />
                        }
                    />
                    <InfoRow label="Quantity" value={<ValueDisplay value={tx.quantity} />} />
                    <InfoRow
                        label="Price"
                        value={
                            <Flex align="center" gap={1}>
                                <Text fontSize="10px" fontFamily="mono"><ValueDisplay value={tx.price} /></Text>
                                <AssetBadge
                                    asset={tx.price_quote_asset}
                                    sourceSymbol={tx.source_price_quote_asset_symbol}
                                    size="xs"
                                    colorPalette="cyan"
                                    maxLength={12}
                                />
                            </Flex>
                        }
                    />
                    <InfoRow
                        label="Total"
                        value={
                            <Flex align="center" gap={1}>
                                <Text fontSize="10px" fontFamily="mono">
                                    <ValueDisplay value={tx.total} />
                                </Text>
                                <AssetBadge
                                    asset={tx.price_quote_asset}
                                    sourceSymbol={tx.source_price_quote_asset_symbol}
                                    size="xs"
                                    colorPalette="cyan"
                                    maxLength={12}
                                />
                            </Flex>
                        }
                    />
                    <InfoRow
                        label="Fee"
                        value={tx.fee ? (
                            <Flex align="center" gap={1}>
                                <Text fontSize="10px" fontFamily="mono"><ValueDisplay value={tx.fee} /></Text>
                                <AssetBadge
                                    asset={tx.fee_quote_asset}
                                    sourceSymbol={tx.source_fee_quote_asset_symbol}
                                    size="xs"
                                    colorPalette="orange"
                                    maxLength={12}
                                />
                            </Flex>
                        ) : '-'}
                    />
                    {tx.source_transaction_id && (
                        <InfoRow
                            label="Source Transaction ID"
                            value={
                                <Text fontSize="9px" fontFamily="mono" maxW="200px" truncate title={tx.source_transaction_id}>
                                    {tx.source_transaction_id}
                                </Text>
                            }
                        />
                    )}
                    <InfoRow
                        label="Review"
                        value={
                            <Badge
                                size="xs"
                                colorPalette={tx.review_status === 'valid' ? 'green' : tx.review_status === 'invalid' ? 'red' : 'yellow'}
                                fontSize="9px"
                            >
                                {tx.review_status}
                            </Badge>
                        }
                    />
                    {(tx.from_account_id || tx.source_from_account) && (
                        <InfoRow
                            label="From Account"
                            value={
                                <Badge size="xs" colorPalette={tx.from_account_id ? "cyan" : "orange"} variant="subtle" fontSize="9px">
                                    {tx.source_from_account && (
                                        <>
                                            Source: {tx.source_from_account}
                                            {tx.from_account_id && <Text as="span" mx={1}>→</Text>}
                                        </>
                                    )}
                                    {tx.from_account_id && (
                                        <>#{tx.from_account_id} {getAccountName(tx.from_account_id)}</>
                                    )}
                                </Badge>
                            }
                        />
                    )}
                    {(tx.to_account_id || tx.source_to_account) && (
                        <InfoRow
                            label="To Account"
                            value={
                                <Badge size="xs" colorPalette={tx.to_account_id ? "cyan" : "orange"} variant="subtle" fontSize="9px">
                                    {tx.source_to_account && (
                                        <>
                                            Source: {tx.source_to_account}
                                            {tx.to_account_id && <Text as="span" mx={1}>→</Text>}
                                        </>
                                    )}
                                    {tx.to_account_id && (
                                        <>#{tx.to_account_id} {getAccountName(tx.to_account_id)}</>
                                    )}
                                </Badge>
                            }
                        />
                    )}
                    <InfoRow label="Network" value={tx.network || '-'} />
                    <InfoRow label="Network TX ID" value={
                        tx.network_transaction_id ? (
                            <Text fontSize="9px" maxW="150px" truncate title={tx.network_transaction_id}>
                                {tx.network_transaction_id}
                            </Text>
                        ) : '-'
                    } />
                    {/* Bundle/Calculation Unit */}
                    {tx.user_calculation_unit_id && (
                        <InfoRow
                            label="Bundle"
                            value={
                                bundleLoading ? (
                                    <Text fontSize="9px" color="gray.400">Loading...</Text>
                                ) : bundleData ? (
                                    <Badge
                                        size="xs"
                                        colorPalette="blue"
                                        fontSize="9px"
                                        variant="subtle"
                                    >
                                        #{bundleData.id} {bundleData.pattern ? `• ${bundleData.pattern}` : ''}
                                    </Badge>
                                ) : (
                                    <Badge size="xs" colorPalette="gray" fontSize="9px">
                                        #{tx.user_calculation_unit_id}
                                    </Badge>
                                )
                            }
                        />
                    )}
                    {/* Spam/Phishing Detection Alert */}
                    {tx.review_status === 'invalid' && tx.review_notes && tx.review_notes.includes('Auto-flagged') && (
                        <Box
                            mt={2}
                            p={2}
                            bg="red.950"
                            borderWidth="1px"
                            borderColor="red.700"
                            borderRadius="md"
                        >
                            <Flex align="center" gap={1.5} mb={1}>
                                <Box color="red.400"><FiAlertTriangle size={14} /></Box>
                                <Text fontSize="10px" fontWeight="bold" color="red.300">
                                    Spam / Phishing Detection
                                </Text>
                            </Flex>
                            <Text fontSize="9px" color="red.200" whiteSpace="pre-wrap" fontFamily="mono">
                                {tx.review_notes}
                            </Text>
                        </Box>
                    )}
                </Section>

                {/* P&L */}
                <Section title="P&L" icon="💰" defaultOpen={true} colorScheme="green">
                    <InfoRow
                        label="Include Fees"
                        value={tx.include_fee ? '✓ Yes' : '✗ No'}
                        muted={!tx.include_fee}
                    />
                    <InfoRow
                        label="Taxability"
                        value={
                            <Badge
                                size="xs"
                                colorPalette={tx.taxability_status === 'taxable' ? 'orange' : tx.taxability_status === 'non_taxable' ? 'green' : 'yellow'}
                                fontSize="9px"
                            >
                                {(tx.taxability_status || 'unknown').toUpperCase()}
                            </Badge>
                        }
                    />
                </Section>

                {/* Tags */}
                <Section title="Tags" icon="🏷️" defaultOpen={false} colorScheme="blue">
                    <Flex gap={1} wrap="wrap" mb={1}>
                        {normalizedTags && normalizedTags.length > 0 ? (
                            normalizedTags.map((tag: Record<string, unknown>, i: number) => (
                                <TagChip
                                    key={i}
                                    tag={tag}
                                    editable={!!onTagsChange}
                                    onRemove={() => removeTag(i)}
                                />
                            ))
                        ) : (
                            <Text fontSize="9px" color="gray.400">No tags</Text>
                        )}
                    </Flex>
                    {onTagsChange && (
                        <Flex gap={1} mt={1}>
                            <Input
                                size="xs"
                                placeholder="Key"
                                value={newTagKey}
                                onChange={(e) => setNewTagKey(e.target.value)}
                                width="50px"
                                fontSize="9px"
                            />
                            <Input
                                size="xs"
                                placeholder="Value"
                                value={newTagValue}
                                onChange={(e) => setNewTagValue(e.target.value)}
                                flex="1"
                                fontSize="9px"
                                onKeyDown={(e) => e.key === 'Enter' && addTag()}
                            />
                            <Button size="xs" onClick={addTag} disabled={!newTagValue.trim()} px={2}>
                                +
                            </Button>
                        </Flex>
                    )}
                </Section>

                {/* Notes */}
                <Section title="Notes" icon="📝" defaultOpen={false} colorScheme="orange">
                    {isEditingNotes ? (
                        <Flex direction="column" gap={1}>
                            <Textarea
                                size="xs"
                                value={notesValue}
                                onChange={(e) => setNotesValue(e.target.value)}
                                placeholder="Add notes..."
                                rows={2}
                                fontSize="10px"
                            />
                            <Flex gap={1} justify="flex-end">
                                <Button size="xs" variant="ghost" onClick={() => {
                                    setNotesValue(tx.review_notes || '');
                                    setIsEditingNotes(false);
                                }} fontSize="9px" px={2}>
                                    Cancel
                                </Button>
                                <Button size="xs" colorPalette="blue" onClick={saveNotes} fontSize="9px" px={2}>
                                    Save
                                </Button>
                            </Flex>
                        </Flex>
                    ) : (
                        <Flex justify="space-between" align="flex-start">
                            <Text
                                fontSize="10px"
                                color={tx.review_notes ? 'gray.700' : 'gray.400'}
                                whiteSpace="pre-wrap"
                                flex="1"
                            >
                                {tx.review_notes || 'No notes'}
                            </Text>
                            {onNotesChange && (
                                <Button size="xs" variant="ghost" onClick={() => setIsEditingNotes(true)} px={1} fontSize="9px">
                                    Edit
                                </Button>
                            )}
                        </Flex>
                    )}
                </Section>
            </Section>

            {/* ============================================================ */}
            {/* DETAILS SECTION */}
            {/* ============================================================ */}
            <Section title="Details" level="main" defaultOpen={false} colorScheme="gray">

                {/* Source Data - Raw Data Button */}
                <Section title="Source" icon="📤" defaultOpen={true} colorScheme="orange">
                    {!tx.raw_transaction_id ? (
                        <Box p={2} bg="gray.50" borderRadius="md" textAlign="center">
                            <Text fontSize="9px" color="gray.500">
                                No raw transaction linked (manual entry)
                            </Text>
                        </Box>
                    ) : !hasFetchedRaw ? (
                        <Button
                            size="xs"
                            onClick={fetchRawData}
                            fontSize="9px"
                            w="100%"
                        >
                            Raw Data (Raw TX ID: {tx.raw_transaction_id})
                        </Button>
                    ) : rawDataLoading ? (
                        <Flex align="center" justify="center" py={2} gap={2}>
                            <FiLoader className="animate-spin" size={12} />
                            <Text fontSize="9px" color="gray.500">Loading...</Text>
                        </Flex>
                    ) : rawDataError ? (
                        <Box p={2} bg="red.50" borderRadius="md">
                            <Text fontSize="9px" color="red.500">Error: {rawDataError}</Text>
                            <Button
                                size="xs"
                                mt={1}
                                fontSize="9px"
                                onClick={() => {
                                    setHasFetchedRaw(false);
                                    setRawDataError(null);
                                }}
                            >
                                Retry
                            </Button>
                        </Box>
                    ) : rawData ? (
                        <Box>
                            <Flex justify="space-between" align="center" mb={1}>
                                <Flex align="center" gap={1}>
                                    <Badge size="xs" colorPalette="gray" fontSize="8px">{rawData.source}</Badge>
                                    <Text fontSize="8px" color="gray.500">ID: {rawData.source_transaction_id}</Text>
                                </Flex>
                                <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={copyJson}
                                    px={1}
                                    fontSize="9px"
                                >
                                    {copied ? <FiCheck size={10} /> : <FiCopy size={10} />}
                                </Button>
                            </Flex>
                            <Box
                                bg="gray.900"
                                color="green.300"
                                p={2}
                                borderRadius="md"
                                fontSize="8px"
                                fontFamily="mono"
                                maxH="200px"
                                overflowY="auto"
                                whiteSpace="pre-wrap"
                                wordBreak="break-all"
                            >
                                {JSON.stringify(rawData.raw_data, null, 2)}
                            </Box>
                            {/* Connector Metadata */}
                            {tx.connector_name && (
                                <Box mt={2} pt={2} borderTopWidth={1} borderColor="gray.200">
                                    <InfoRow
                                        label="Connector"
                                        value={
                                            <Badge size="xs" colorPalette="blue" fontSize="8px">
                                                {tx.connector_name}
                                            </Badge>
                                        }
                                    />
                                    {tx.sync_connector_run_id && (
                                        <InfoRow label="Run ID" value={tx.sync_connector_run_id} muted />
                                    )}
                                    {tx.run_datetime && (
                                        <InfoRow label="Run Datetime" value={formatDateTimeLocale(tx.run_datetime)} muted />
                                    )}
                                </Box>
                            )}
                            {/* Raw Transaction Ingestion Time */}
                            {rawData?.ingestion_time && (
                                <InfoRow label="Ingestion Time" value={formatDateTimeLocale(rawData.ingestion_time)} muted />
                            )}
                        </Box>
                    ) : null}
                </Section>

                {/* Source Mappings */}
                <Section title="Source-Mappings" icon="🔗" defaultOpen={true} colorScheme="blue">
                    <Text fontSize="9px" color="gray.500" mb={1}>Source value → Resolved ID</Text>

                    <InfoRow
                        label="Account"
                        value={
                            tx.account_id ? (
                                <Flex align="center" gap={1}>
                                    <Text fontSize="9px" color="gray.500" maxW="60px" truncate>{tx.source_account || '-'}</Text>
                                    <Text fontSize="9px">→</Text>
                                    <Badge size="xs" colorPalette="cyan" fontSize="8px">
                                        #{tx.account_id} {getAccountName(tx.account_id)}
                                    </Badge>
                                </Flex>
                            ) : tx.source_account ? (
                                <Flex align="center" gap={1}>
                                    <Text fontSize="9px" color="gray.500" maxW="60px" truncate>{tx.source_account}</Text>
                                    <Text fontSize="9px">→</Text>
                                    <Text fontSize="9px" color="orange.500">NOT LINKED</Text>
                                </Flex>
                            ) : '-'
                        }
                        alert={!tx.account_id && !!tx.source_account}
                    />

                    <InfoRow
                        label="Asset"
                        value={
                            tx.asset_id ? (
                                <Flex align="center" gap={1}>
                                    <Text fontSize="9px" color="gray.500">{tx.source_asset_symbol}</Text>
                                    <Text fontSize="9px">→</Text>
                                    <AssetBadge
                                        asset={tx.linked_asset}
                                        size="xs"
                                        colorPalette="purple"
                                        maxLength={15}
                                    />
                                </Flex>
                            ) : (
                                <Flex align="center" gap={1}>
                                    <Text fontSize="9px" color="gray.500">{tx.source_asset_symbol || '-'}</Text>
                                    <Text fontSize="9px">→</Text>
                                    <Text fontSize="9px" color="orange.500">NOT LINKED</Text>
                                </Flex>
                            )
                        }
                        alert={!tx.asset_id && !!tx.source_asset_symbol}
                    />

                    <InfoRow
                        label="Price Quote"
                        value={
                            tx.price_quote_asset_id ? (
                                <Flex align="center" gap={1}>
                                    <Text fontSize="9px" color="gray.500">{tx.source_price_quote_asset_symbol}</Text>
                                    <Text fontSize="9px">→</Text>
                                    <AssetBadge
                                        asset={tx.price_quote_asset}
                                        size="xs"
                                        colorPalette="green"
                                        maxLength={15}
                                    />
                                </Flex>
                            ) : (
                                <Flex align="center" gap={1}>
                                    <Text fontSize="9px" color="gray.500">{tx.source_price_quote_asset_symbol || '-'}</Text>
                                    <Text fontSize="9px">→</Text>
                                    <Text fontSize="9px" color="orange.500">NOT LINKED</Text>
                                </Flex>
                            )
                        }
                        alert={!tx.price_quote_asset_id && !!tx.source_price_quote_asset_symbol}
                    />

                    <InfoRow
                        label="Fee Quote"
                        value={
                            tx.fee_quote_asset_id ? (
                                <Flex align="center" gap={1}>
                                    <Text fontSize="9px" color="gray.500">{tx.source_fee_quote_asset_symbol}</Text>
                                    <Text fontSize="9px">→</Text>
                                    <AssetBadge
                                        asset={tx.fee_quote_asset}
                                        size="xs"
                                        colorPalette="green"
                                        maxLength={15}
                                    />
                                </Flex>
                            ) : tx.source_fee_quote_asset_symbol ? (
                                <Flex align="center" gap={1}>
                                    <Text fontSize="9px" color="gray.500">{tx.source_fee_quote_asset_symbol}</Text>
                                    <Text fontSize="9px">→</Text>
                                    <Text fontSize="9px" color="orange.500">NOT LINKED</Text>
                                </Flex>
                            ) : '-'
                        }
                        alert={!tx.fee_quote_asset_id && !!tx.source_fee_quote_asset_symbol}
                    />

                    <InfoRow
                        label="From Account"
                        value={
                            tx.from_account_id ? (
                                <Flex align="center" gap={1}>
                                    <Text fontSize="9px" color="gray.500" maxW="60px" truncate title={tx.source_from_account || undefined}>{tx.source_from_account || '-'}</Text>
                                    <Text fontSize="9px">→</Text>
                                    <Badge size="xs" colorPalette="cyan" fontSize="8px" title={`Source: ${tx.source_from_account || '-'}`}>
                                        #{tx.from_account_id} {getAccountName(tx.from_account_id)}
                                    </Badge>
                                </Flex>
                            ) : tx.source_from_account ? (
                                <Flex align="center" gap={1}>
                                    <Text fontSize="9px" color="gray.500" maxW="60px" truncate title={tx.source_from_account}>{tx.source_from_account}</Text>
                                    <Text fontSize="9px">→</Text>
                                    <Text fontSize="9px" color="orange.500">NOT LINKED</Text>
                                </Flex>
                            ) : '-'
                        }
                    />

                    <InfoRow
                        label="To Account"
                        value={
                            tx.to_account_id ? (
                                <Flex align="center" gap={1}>
                                    <Text fontSize="9px" color="gray.500" maxW="60px" truncate title={tx.source_to_account || undefined}>{tx.source_to_account || '-'}</Text>
                                    <Text fontSize="9px">→</Text>
                                    <Badge size="xs" colorPalette="cyan" fontSize="8px" title={`Source: ${tx.source_to_account || '-'}`}>
                                        #{tx.to_account_id} {getAccountName(tx.to_account_id)}
                                    </Badge>
                                </Flex>
                            ) : tx.source_to_account ? (
                                <Flex align="center" gap={1}>
                                    <Text fontSize="9px" color="gray.500" maxW="60px" truncate title={tx.source_to_account}>{tx.source_to_account}</Text>
                                    <Text fontSize="9px">→</Text>
                                    <Text fontSize="9px" color="orange.500">NOT LINKED</Text>
                                </Flex>
                            ) : '-'
                        }
                    />
                </Section>


            </Section>
        </Box>
    );
};

export default TransactionDetailPanel;
