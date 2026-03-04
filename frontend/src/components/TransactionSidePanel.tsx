/**
 * TransactionSidePanel - Unified view + inline-edit panel for transactions.
 *
 * Replaces the old read-only TransactionDetailPanel and the modal-based
 * TransactionEditorDialog with a single 450px side-panel that:
 *   - Shows all transaction fields in organized sections:
 *       📍 Source & Timing, 💱 Transaction Details, 💰 Pricing & Fees,
 *       🔗 Network & Advanced, 💰 P&L, 📦 Bundle, 🏷️ Tags, ✅ Review
 *   - Allows inline editing of every field via EditableField
 *   - Preserves all calculation logic from ManualTransactionForm
 *   - Uses AccountBadge for all account displays
 *   - Provides copy buttons for addresses, TX IDs
 *   - Shows from→to with down arrow visualization
 *   - Supports unbundling from bundle section
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
    Badge,
    Box,
    Button,
    Flex,
    Input,
    Text,
} from '@chakra-ui/react';
import {
    FiCopy,
    FiCheck,
    FiLoader,
    FiTag,
    FiX,
    FiChevronDown,
    FiChevronRight,
    FiAlertTriangle,
    FiArrowDown,
    FiArrowUp,
} from 'react-icons/fi';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Transaction, Account, Asset, API_URL, DerivativePosition } from '../types';
import { Direction, ReviewStatus, TransactionType } from '../enums';
import { AssetBadge } from './AssetBadge';
import { AccountBadge } from './AccountBadge';
import { ComboSelect, SOURCE_OPTIONS } from './ComboSelect';
import { EditableField } from './EditableField';
import { ValueDisplay } from './ValueDisplay';
import { LinkableAccountField } from './LinkableAccountField';
import { LinkableAssetField } from './LinkableAssetField';
import { AssetSelector } from './AssetSelector';
import {
    formatDateTimeLocale,
    toDateTimeLocalString,
    dateTimeLocalToISO,
} from '../utils/dateUtils';
import { useTransactionPatch } from '../hooks/useTransactionPatch';
import { useEntityColors, hexToRgba } from '../hooks/useEntityColors';
import { useAssets } from '../hooks/useAssets';
import { usePositions } from '../hooks/usePositions';
import { getAssetSuggestions, getConfidenceColor, formatConfidence } from '../utils/similarity';
import { Tooltip } from './ui/tooltip';
import { ConnectorRunDetailDrawer } from './ConnectorRunDetailDrawer';
import AccountFormDialog, { AccountPrefill } from './AccountFormDialog';
import AssetFormDialog, { AssetPrefill } from './AssetFormDialog';

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

export interface TransactionSidePanelProps {
    transaction: Transaction;
    accounts: Account[];
    onTransactionUpdate?: (updated: Transaction) => void;
    onNotesChange?: (txId: number, notes: string) => void;
    onTagsChange?: (txId: number, tags: Record<string, unknown>[]) => void;
}

// ============================================================================
// Helpers ported from ManualTransactionForm
// ============================================================================

type SimplifiedType = typeof TransactionType.TRADE | typeof TransactionType.TRANSFER | typeof TransactionType.MARGIN | typeof TransactionType.COST;

const deriveTransactionType = (simplifiedType: SimplifiedType, _direction: string): string => {
    return simplifiedType;
};

const deriveSimplifiedType = (transactionType: string): SimplifiedType => {
    if (transactionType === TransactionType.TRANSFER) return TransactionType.TRANSFER;
    if (transactionType === TransactionType.MARGIN) return TransactionType.MARGIN;
    if (transactionType === TransactionType.COST) return TransactionType.COST;
    return TransactionType.TRADE;
};

// ============================================================================
// Sub-components (kept from TransactionDetailPanel)
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
    onOpen?: () => void;
}

const Section: React.FC<SectionProps> = ({
    title,
    icon,
    children,
    defaultOpen = true,
    level = 'sub',
    colorScheme = 'gray',
    onOpen,
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
                onClick={() => {
                    const willOpen = !isOpen;
                    setIsOpen(willOpen);
                    if (willOpen && onOpen) onOpen();
                }}
                _hover={{ bg: isMain ? `${colorScheme}.200` : `${colorScheme}.100` }}
            >
                {isOpen ? <FiChevronDown size={isMain ? 14 : 12} /> : <FiChevronRight size={isMain ? 14 : 12} />}
                <Text
                    fontSize={isMain ? '11px' : '10px'}
                    fontWeight="bold"
                    color={`${colorScheme}.700`}
                    textTransform={isMain ? 'uppercase' : 'none'}
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
                            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onRemove?.(); }}
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

const normalizeTags = (tags: any): Record<string, unknown>[] => {
    if (!tags) return [];
    if (Array.isArray(tags)) return tags;
    const keys = Object.keys(tags);
    const allNumeric = keys.every(k => !isNaN(Number(k)));
    if (allNumeric) return keys.sort((a, b) => Number(a) - Number(b)).map(k => tags[k]);
    return [tags];
};

// ============================================================================
// Main Component
// ============================================================================

export const TransactionSidePanel: React.FC<TransactionSidePanelProps> = ({
    transaction: initialTx,
    accounts,
    onTransactionUpdate,
    onNotesChange,
    onTagsChange,
}) => {
    // ------- Local transaction state (optimistic updates) -------
    const [tx, setTx] = useState<Transaction>(initialTx);
    useEffect(() => { setTx(initialTx); }, [initialTx]);

    const { patchField, patchFields } = useTransactionPatch(tx.id);
    const { getConnectorColor } = useEntityColors();
    const queryClient = useQueryClient();

    // ------- Assets query -------
    const { assets, refetchAssets } = useAssets();

    // ------- Available tags query -------
    const { data: availableTags = [] } = useQuery<{ key: string; value: string }[]>({
        queryKey: ['transactionTags'],
        queryFn: async () => {
            const r = await fetch(`${API_URL}/transactions/tags`);
            if (!r.ok) throw new Error('Failed to fetch tags');
            return r.json();
        },
        staleTime: 60_000,
    });

    // ------- Tags state -------
    const normalizedTags = normalizeTags(tx.tags);
    const [newTagKey, setNewTagKey] = useState('');
    const [newTagValue, setNewTagValue] = useState('');

    // ------- Bundle state -------
    const [bundleData, setBundleData] = useState<{ id: number; pattern: string | null; label: string | null } | null>(null);
    const [bundleLoading, setBundleLoading] = useState(false);

    // ------- Raw data state -------
    const [rawData, setRawData] = useState<RawTransactionData | null>(null);
    const [rawDataLoading, setRawDataLoading] = useState(false);
    const [rawDataError, setRawDataError] = useState<string | null>(null);
    const [hasFetchedRaw, setHasFetchedRaw] = useState(false);
    const [copiedJson, setCopiedJson] = useState(false);

    // ------- Connector run drawer state -------
    const [showRunDrawer, setShowRunDrawer] = useState(false);

    // ------- Quick-create dialog state -------
    const [quickCreateAccount, setQuickCreateAccount] = useState<{
        field: 'account_id' | 'from_account_id' | 'to_account_id';
        prefill: AccountPrefill;
    } | null>(null);

    const [quickCreateAsset, setQuickCreateAsset] = useState<{
        field: 'asset_id' | 'price_quote_asset_id' | 'fee_quote_asset_id';
        prefill: AssetPrefill;
        rawSource?: string;
        rawSymbol?: string;
    } | null>(null);

    // ------- Transfer inline account creation -------
    // (Account creation is now handled by AccountSelector inside LinkableAccountField)

    // ============================================================
    // Helper: save field(s) & update local state
    // ============================================================

    const saveField = async (field: string, value: any) => {
        const updated = await patchField(field, value);
        setTx(updated);
        onTransactionUpdate?.(updated);
    };

    const saveFields = async (updates: Record<string, any>) => {
        const updated = await patchFields(updates);
        setTx(updated);
        onTransactionUpdate?.(updated);
    };

    // Quick-create handlers: link newly created account/asset to the transaction
    const handleQuickAccountCreated = async (accountId?: number) => {
        if (accountId && quickCreateAccount) {
            try {
                await saveField(quickCreateAccount.field, accountId);
                queryClient.invalidateQueries({ queryKey: ['accounts'] });
            } catch {
                // error is shown by saveField
            }
        }
        setQuickCreateAccount(null);
    };

    const handleQuickAssetCreated = async (assetId?: number) => {
        if (assetId && quickCreateAsset) {
            try {
                await saveField(quickCreateAsset.field, assetId);
                queryClient.invalidateQueries({ queryKey: ['assets'] });
            } catch {
                // error is shown by saveField
            }
        }
        setQuickCreateAsset(null);
    };

    // ============================================================
    // Calculation logic (ported from ManualTransactionForm)
    // ============================================================

    /**
     * When price or quantity is saved, recompute total = price * qty
     * and patch both the changed field + total in one call.
     */
    const savePriceOrQuantity = async (field: 'price' | 'quantity', newValue: string) => {
        const numVal = parseFloat(newValue);
        if (isNaN(numVal)) { await saveField(field, newValue); return; }

        const price = field === 'price' ? numVal : (tx.price ?? 0);
        const quantity = field === 'quantity' ? numVal : tx.quantity;

        const updates: Record<string, any> = { [field]: newValue };
        if (price > 0 && quantity > 0) {
            updates.total = (price * quantity).toFixed(2);
        }
        await saveFields(updates);
    };

    /**
     * When simplified_type or direction changes, re-derive transaction_type
     * and patch both in one call.
     * Also handle transfer from/to account auto-assignment.
     */
    const saveTypeOrDirection = async (field: 'transaction_type' | 'direction', newValue: string) => {
        const simplifiedType = field === 'transaction_type'
            ? newValue as SimplifiedType
            : deriveSimplifiedType(tx.transaction_type);
        const direction = field === 'direction' ? newValue : tx.direction;

        const derivedType = field === 'transaction_type'
            ? deriveTransactionType(newValue as SimplifiedType, direction)
            : deriveTransactionType(simplifiedType, newValue);

        const updates: Record<string, any> = { [field === 'transaction_type' ? 'transaction_type' : 'direction']: newValue };

        // If changing simplified type → also set transaction_type
        if (field === 'transaction_type') {
            updates.transaction_type = derivedType;
        } else {
            // Direction changed → re-derive transaction_type
            updates.transaction_type = derivedType;
        }

        // Transfer from/to account auto-assignment
        if ((field === 'transaction_type' ? newValue : simplifiedType) === TransactionType.TRANSFER && tx.account_id) {
            const dir = field === 'direction' ? newValue : direction;
            if (dir === 'outflow') {
                updates.from_account_id = tx.account_id;
                if (tx.to_account_id === tx.account_id) updates.to_account_id = null;
            } else {
                updates.to_account_id = tx.account_id;
                if (tx.from_account_id === tx.account_id) updates.from_account_id = null;
            }
        }

        await saveFields(updates);
    };

    /**
     * When account_id changes for a transfer, auto-assign from/to account IDs.
     */
    const saveAccountId = async (newAccountId: string) => {
        const accountId = newAccountId ? parseInt(newAccountId, 10) : null;
        const isTransfer = deriveSimplifiedType(tx.transaction_type) === TransactionType.TRANSFER;

        const updates: Record<string, any> = { account_id: accountId };

        if (isTransfer && accountId) {
            if (tx.direction === 'outflow') {
                updates.from_account_id = accountId;
                if (tx.to_account_id === accountId) updates.to_account_id = null;
            } else {
                updates.to_account_id = accountId;
                if (tx.from_account_id === accountId) updates.from_account_id = null;
            }
        }

        await saveFields(updates);
    };

    /**
     * When price_quote_asset_id changes.
     */
    const savePriceQuoteAsset = async (newAssetId: string) => {
        await saveField('price_quote_asset_id', newAssetId || null);
    };

    // ============================================================
    // Transfer helpers
    // ============================================================

    const isTransfer = deriveSimplifiedType(tx.transaction_type) === TransactionType.TRANSFER;

    // Quote asset suggestions (client-side fuzzy match)
    const priceQuoteSuggestions = useMemo(() => {
        if (!tx.source_price_quote_asset_symbol || tx.price_quote_asset_id) return [];
        return getAssetSuggestions(tx.source_price_quote_asset_symbol, assets, 0.4, 3);
    }, [tx.source_price_quote_asset_symbol, tx.price_quote_asset_id, assets]);

    const feeQuoteSuggestions = useMemo(() => {
        if (!tx.source_fee_quote_asset_symbol || tx.fee_quote_asset_id) return [];
        return getAssetSuggestions(tx.source_fee_quote_asset_symbol, assets, 0.4, 3);
    }, [tx.source_fee_quote_asset_symbol, tx.fee_quote_asset_id, assets]);

    const getCounterpartyAccountId = () => {
        return tx.direction === 'outflow' ? tx.to_account_id : tx.from_account_id;
    };

    const getTransferType = () => {
        const mainAcc = accounts.find(a => a.id === tx.account_id);
        const counterpartyId = getCounterpartyAccountId();
        const counterpartyAcc = accounts.find(a => a.id === counterpartyId);
        if (!mainAcc || !counterpartyAcc) return null;
        const isInternal = mainAcc.owned && counterpartyAcc.owned;
        const isExternal = (mainAcc.owned && !counterpartyAcc.owned) || (!mainAcc.owned && counterpartyAcc.owned);
        return isInternal ? 'internal' : isExternal ? 'external' : null;
    };

    // ============================================================
    // Bundle fetch
    // ============================================================

    useEffect(() => {
        const fetchBundle = async () => {
            if (!tx.user_calculation_unit_id) { setBundleData(null); return; }
            setBundleLoading(true);
            try {
                const response = await fetch(`${API_URL}/bundles/${tx.user_calculation_unit_id}`);
                if (response.ok) {
                    const data = await response.json();
                    setBundleData({ id: data.id, pattern: data.pattern || null, label: data.label || null });
                }
            } catch (err) { console.error('Failed to fetch bundle:', err); }
            finally { setBundleLoading(false); }
        };
        fetchBundle();
    }, [tx.user_calculation_unit_id]);

    // ============================================================
    // Raw data fetch
    // ============================================================

    const fetchRawData = useCallback(async () => {
        if (!tx.raw_transaction_id || hasFetchedRaw || rawDataLoading) return;
        setRawDataLoading(true);
        setHasFetchedRaw(true);
        try {
            const response = await fetch(`${API_URL}/raw-transactions/${tx.raw_transaction_id}`);
            if (!response.ok) throw new Error('Failed to fetch raw transaction');
            setRawData(await response.json());
        } catch (err) {
            setRawDataError(err instanceof Error ? err.message : 'Unknown error');
        } finally { setRawDataLoading(false); }
    }, [tx.raw_transaction_id, hasFetchedRaw, rawDataLoading]);

    const copyJson = async () => {
        if (!rawData?.raw_data) return;
        await navigator.clipboard.writeText(JSON.stringify(rawData.raw_data, null, 2));
        setCopiedJson(true);
        setTimeout(() => setCopiedJson(false), 2000);
    };

    // ============================================================
    // Tags (kept from TransactionDetailPanel)
    // ============================================================

    const applyTagsUpdate = (tags: Record<string, unknown>[]) => {
        // Optimistic local update — reflect instantly without waiting for server round-trip
        setTx(prev => ({ ...prev, tags }));
        if (onTagsChange) {
            onTagsChange(tx.id, tags);
        } else {
            // Fallback: PATCH directly
            patchField('tags', tags);
        }
    };

    const addTag = () => {
        if (!newTagValue.trim()) return;
        const newTag = newTagKey.trim()
            ? { [newTagKey.trim()]: newTagValue.trim() }
            : { value: newTagValue.trim() };
        applyTagsUpdate([...normalizedTags, newTag]);
        setNewTagKey('');
        setNewTagValue('');
    };

    const removeTag = (index: number) => {
        applyTagsUpdate(normalizedTags.filter((_: Record<string, unknown>, i: number) => i !== index));
    };

    // Tag exists check
    const tagExists = (tags: { key: string; value: string }[], key: string, value: string) =>
        tags.some(t => t.key === key && t.value === value);

    // ============================================================
    // Unbundle handler
    // ============================================================

    const [unbundling, setUnbundling] = useState(false);
    const unbundleTransaction = async () => {
        if (!tx.user_calculation_unit_id) return;
        setUnbundling(true);
        try {
            const resp = await fetch(`${API_URL}/bundles/${tx.user_calculation_unit_id}/remove-transactions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transaction_ids: [tx.id] }),
            });
            if (resp.ok) {
                queryClient.invalidateQueries({ queryKey: ['transactions'] });
                queryClient.invalidateQueries({ queryKey: ['bundles'] });
                queryClient.invalidateQueries({ queryKey: ['bundleSuggestions'] });
                const updated = { ...tx, user_calculation_unit_id: null };
                setTx(updated as Transaction);
                onTransactionUpdate?.(updated as Transaction);
                setBundleData(null);
            }
        } catch (err) {
            console.error('Failed to unbundle:', err);
        } finally {
            setUnbundling(false);
        }
    };

    // ============================================================
    // RENDER
    // ============================================================

    const simplifiedType = deriveSimplifiedType(tx.transaction_type);

    return (
        <>
            <Box css={{ userSelect: 'text' }}>

                {/* ============================================================ */}
                {/* 📍 Source & Timing */}
                {/* ============================================================ */}
                <Section title="Source & Timing" icon="📍" defaultOpen={true} colorScheme="blue">
                    {/* Account (LinkableAccountField) */}
                    <LinkableAccountField
                        label="Account"
                        sourceValue={tx.source_account}
                        linkedId={tx.account_id}
                        accounts={accounts}
                        source={tx.source}
                        network={tx.network}
                        onSourceChange={async (v) => {
                            await saveFields({ source_account: v, account_id: null });
                        }}
                        onLink={async (id) => { await saveAccountId(String(id ?? '')); }}
                        colorPalette="purple"
                        maxLength={20}
                        copyable
                        truncateLength={20}
                        onCreateNew={!tx.account_id ? () => {
                            setQuickCreateAccount({
                                field: 'account_id',
                                prefill: {
                                    name: tx.source_account || '',
                                    account_type: tx.source_account?.startsWith('0x') ? 'wallet' : 'cex',
                                    address_or_identifier: tx.source_account || '',
                                },
                            });
                        } : undefined}
                    />

                    {/* Source */}
                    <EditableField
                        label="Source"
                        value={tx.source || ''}
                        muted
                        onSave={async (v) => { await saveField('source', v); }}
                        renderEdit={(val, onChange, onSave, onCancel) => (
                            <ComboSelect
                                value={val}
                                onChange={(v) => {
                                    onChange(v);
                                    setTimeout(async () => {
                                        try { await saveField('source', v); } catch { }
                                    }, 0);
                                }}
                                options={SOURCE_OPTIONS}
                                size="sm"
                                width="100%"
                            />
                        )}
                    />

                    {/* Date/Time */}
                    <EditableField
                        label="Date/Time"
                        value={toDateTimeLocalString(tx.date_time)}
                        displayValue={formatDateTimeLocale(tx.date_time)}
                        type="datetime"
                        onSave={async (v) => { await saveField('date_time', dateTimeLocalToISO(v)); }}
                    />

                    {/* Source Transaction Type */}
                    <EditableField
                        label="Source TX Type"
                        value={tx.source_transaction_type || ''}
                        muted={!tx.source_transaction_type}
                        onSave={async (v) => { await saveField('source_transaction_type', v); }}
                    />

                    {/* Source Transaction ID */}
                    <EditableField
                        label="Source TX ID"
                        value={tx.source_transaction_id || ''}
                        copyable
                        truncateLength={24}
                        onSave={async (v) => { await saveField('source_transaction_id', v); }}
                    />
                </Section>

                {/* ============================================================ */}
                {/* 💱 Transaction Details */}
                {/* ============================================================ */}
                <Section title="Transaction Details" icon="💱" defaultOpen={true} colorScheme="purple">
                    {/* Type (simplified) */}
                    <EditableField
                        label="Type"
                        value={simplifiedType}
                        displayValue={
                            <Badge size="xs" colorPalette={tx.transaction_type === 'transfer' ? 'purple' : tx.transaction_type === 'margin' ? 'yellow' : tx.transaction_type === 'cost' ? 'gray' : 'blue'} fontSize="9px">
                                {tx.transaction_type || '-'}
                            </Badge>
                        }
                        type="select"
                        options={[
                            { label: 'Trade', value: TransactionType.TRADE },
                            { label: 'Transfer', value: TransactionType.TRANSFER },
                            { label: 'Margin', value: TransactionType.MARGIN },
                            { label: 'Cost', value: TransactionType.COST },
                        ]}
                        onSave={async (v) => { await saveTypeOrDirection('transaction_type', v); }}
                    />

                    {/* Direction */}
                    <EditableField
                        label="Direction"
                        value={tx.direction || ''}
                        displayValue={
                            <Badge
                                size="xs"
                                colorPalette={tx.direction === 'inflow' ? 'green' : tx.direction === 'outflow' ? 'red' : 'gray'}
                                fontSize="9px"
                            >
                                <Flex align="center" gap={0.5}>
                                    {tx.direction === 'inflow' ? (
                                        <FiArrowDown size={9} />
                                    ) : tx.direction === 'outflow' ? (
                                        <FiArrowUp size={9} />
                                    ) : null}
                                    {tx.direction || '-'}
                                </Flex>
                            </Badge>
                        }
                        type="select"
                        options={[
                            { label: '↓ Inflow', value: Direction.INFLOW },
                            { label: '↑ Outflow', value: Direction.OUTFLOW },
                        ]}
                        onSave={async (v) => { await saveTypeOrDirection('direction', v); }}
                    />

                    {/* Asset (LinkableAssetField) */}
                    <LinkableAssetField
                        label="Asset"
                        sourceValue={tx.source_asset_symbol}
                        linkedId={tx.asset_id}
                        linkedAsset={tx.linked_asset}
                        assets={assets}
                        onSourceChange={async (v) => {
                            await saveFields({ source_asset_symbol: v, asset_id: null });
                        }}
                        onLink={async (id) => { await saveField('asset_id', id); }}
                        colorPalette="purple"
                        maxLength={18}
                        source={tx.source}
                        onCreateNew={!tx.asset_id ? () => {
                            setQuickCreateAsset({
                                field: 'asset_id',
                                prefill: { symbol: tx.source_asset_symbol || '' },
                                rawSource: tx.source,
                                rawSymbol: tx.source_asset_symbol || undefined,
                            });
                        } : undefined}
                    />

                    {/* Quantity */}
                    <EditableField
                        label="Quantity"
                        value={String(tx.quantity ?? '')}
                        displayValue={<ValueDisplay value={tx.quantity} />}
                        type="number"
                        onSave={async (v) => { await savePriceOrQuantity('quantity', v); }}
                    />
                </Section>

                {/* ============================================================ */}
                {/* 🔄 Transfer (consolidated from/to section) */}
                {/* ============================================================ */}
                {(isTransfer || tx.source_from_account || tx.from_account_id || tx.source_to_account || tx.to_account_id) && (
                    <Section title="Transfer" icon="🔄" defaultOpen={true} colorScheme="cyan">
                        {/* From Account (merged with address) */}
                        <LinkableAccountField
                            label="From"
                            sourceValue={tx.source_from_account}
                            linkedId={tx.from_account_id}
                            accounts={accounts}
                            source={tx.source}
                            network={tx.network}
                            onSourceChange={async (v) => {
                                await saveFields({ source_from_account: v, from_account_id: null });
                            }}
                            onLink={async (id) => { await saveField('from_account_id', id); }}
                            colorPalette="cyan"
                            maxLength={16}
                            copyable
                            truncateLength={20}
                            onCreateNew={!tx.from_account_id && tx.source_from_account ? () => {
                                setQuickCreateAccount({
                                    field: 'from_account_id',
                                    prefill: {
                                        name: tx.source_from_account || '',
                                        account_type: tx.source_from_account?.startsWith('0x') ? 'wallet' : 'cex',
                                        address_or_identifier: tx.source_from_account || '',
                                    },
                                });
                            } : undefined}
                        />

                        {/* To Account (merged with address) */}
                        <LinkableAccountField
                            label="To"
                            sourceValue={tx.source_to_account}
                            linkedId={tx.to_account_id}
                            accounts={accounts}
                            source={tx.source}
                            network={tx.network}
                            onSourceChange={async (v) => {
                                await saveFields({ source_to_account: v, to_account_id: null });
                            }}
                            onLink={async (id) => { await saveField('to_account_id', id); }}
                            colorPalette="cyan"
                            maxLength={16}
                            copyable
                            truncateLength={20}
                            onCreateNew={!tx.to_account_id && tx.source_to_account ? () => {
                                setQuickCreateAccount({
                                    field: 'to_account_id',
                                    prefill: {
                                        name: tx.source_to_account || '',
                                        account_type: tx.source_to_account?.startsWith('0x') ? 'wallet' : 'cex',
                                        address_or_identifier: tx.source_to_account || '',
                                    },
                                });
                            } : undefined}
                        />

                        {/* Internal/External Transfer Indicator */}
                        {tx.account_id && (tx.from_account_id || tx.to_account_id) && (() => {
                            const transferType = getTransferType();
                            if (!transferType) return null;
                            return (
                                <Box p={2} borderRadius="md" bg={transferType === 'internal' ? 'green.100' : 'orange.100'} mt={1} mb={1}>
                                    <Text fontSize="9px" fontWeight="bold" color={transferType === 'internal' ? 'green.700' : 'orange.700'}>
                                        {transferType === 'internal'
                                            ? '🏠 Internal Transfer — Both accounts are owned. No taxable event.'
                                            : '🌐 External Transfer — To/from external party.'}
                                    </Text>
                                </Box>
                            );
                        })()}
                    </Section>
                )}

                {/* ============================================================ */}
                {/* 💰 Pricing & Fees */}
                {/* ============================================================ */}
                <Section title="Pricing & Fees" icon="💰" defaultOpen={true} colorScheme="green">
                    {/* Price + Quote (compound edit) */}
                    <EditableField
                        label="Price"
                        value={String(tx.price ?? '')}
                        displayValue={
                            <Flex align="center" gap={1} wrap="wrap">
                                <Text fontSize="10px" fontFamily="mono"><ValueDisplay value={tx.price} /></Text>
                                <AssetBadge
                                    asset={tx.price_quote_asset}
                                    sourceSymbol={tx.source_price_quote_asset_symbol}
                                    size="xs"
                                    colorPalette="cyan"
                                    maxLength={12}
                                />
                                {priceQuoteSuggestions.map((s, i) => (
                                    <Tooltip key={i} content={`${s.item.symbol}${s.item.label ? ` (${s.item.label})` : ''} - ${formatConfidence(s.confidence)} match`} openDelay={100}>
                                        <Badge
                                            size="xs"
                                            colorPalette={getConfidenceColor(s.confidence)}
                                            variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                            cursor="pointer"
                                            fontSize="7px"
                                            onClick={(e: React.MouseEvent) => {
                                                e.stopPropagation();
                                                savePriceQuoteAsset(String(s.item.asset_id));
                                            }}
                                        >
                                            {s.item.symbol.slice(0, 6)}{s.item.symbol.length > 6 ? '\u2026' : ''}
                                            {s.confidence >= 0.9 && ' \u2713'}
                                        </Badge>
                                    </Tooltip>
                                ))}
                            </Flex>
                        }
                        renderEdit={(val, onChange, onSave, onCancel) => (
                            <Flex direction="column" gap={1}>
                                <Input
                                    size="xs"
                                    type="number"
                                    step="any"
                                    value={val}
                                    onChange={(e) => onChange(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') { e.preventDefault(); onSave(); }
                                        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
                                    }}
                                    fontSize="10px"
                                    fontFamily="mono"
                                    autoFocus
                                />
                                <AssetSelector
                                    value={tx.price_quote_asset_id ?? null}
                                    onChange={async (id) => { await savePriceQuoteAsset(String(id ?? '')); }}
                                    assets={assets}
                                    size="xs"
                                    defaultSymbol={tx.source_price_quote_asset_symbol || ''}
                                />
                                {priceQuoteSuggestions.length > 0 && (
                                    <Flex gap={1} wrap="wrap">
                                        {priceQuoteSuggestions.map((s, i) => (
                                            <Tooltip key={i} content={`${s.item.symbol} - ${formatConfidence(s.confidence)} match`} openDelay={100}>
                                                <Badge
                                                    size="xs"
                                                    colorPalette={getConfidenceColor(s.confidence)}
                                                    variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                    cursor="pointer"
                                                    fontSize="8px"
                                                    onClick={() => savePriceQuoteAsset(String(s.item.asset_id))}
                                                >
                                                    {s.item.symbol.slice(0, 8)}{s.item.symbol.length > 8 ? '\u2026' : ''}
                                                    {s.confidence >= 0.9 && ' \u2713'}
                                                </Badge>
                                            </Tooltip>
                                        ))}
                                    </Flex>
                                )}
                            </Flex>
                        )}
                        onSave={async (v) => { await savePriceOrQuantity('price', v); }}
                    />

                    {/* Total */}
                    <EditableField
                        label="Total"
                        value={String(tx.total ?? '')}
                        displayValue={
                            <Flex align="center" gap={1}>
                                <Text fontSize="10px" fontFamily="mono"><ValueDisplay value={tx.total} /></Text>
                                <AssetBadge
                                    asset={tx.price_quote_asset}
                                    sourceSymbol={tx.source_price_quote_asset_symbol}
                                    size="xs"
                                    colorPalette="cyan"
                                    maxLength={12}
                                />
                            </Flex>
                        }
                        type="number"
                        onSave={async (v) => { await saveField('total', v); }}
                    />

                    {/* Fee + Quote (compound edit) */}
                    <EditableField
                        label="Fee"
                        value={String(tx.fee ?? '')}
                        displayValue={tx.fee ? (
                            <Flex align="center" gap={1} wrap="wrap">
                                <Text fontSize="10px" fontFamily="mono"><ValueDisplay value={tx.fee} /></Text>
                                <AssetBadge
                                    asset={tx.fee_quote_asset}
                                    sourceSymbol={tx.source_fee_quote_asset_symbol}
                                    size="xs"
                                    colorPalette="cyan"
                                    maxLength={12}
                                />
                                {feeQuoteSuggestions.map((s, i) => (
                                    <Tooltip key={i} content={`${s.item.symbol}${s.item.label ? ` (${s.item.label})` : ''} - ${formatConfidence(s.confidence)} match`} openDelay={100}>
                                        <Badge
                                            size="xs"
                                            colorPalette={getConfidenceColor(s.confidence)}
                                            variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                            cursor="pointer"
                                            fontSize="7px"
                                            onClick={(e: React.MouseEvent) => {
                                                e.stopPropagation();
                                                saveField('fee_quote_asset_id', s.item.asset_id);
                                            }}
                                        >
                                            {s.item.symbol.slice(0, 6)}{s.item.symbol.length > 6 ? '\u2026' : ''}
                                            {s.confidence >= 0.9 && ' \u2713'}
                                        </Badge>
                                    </Tooltip>
                                ))}
                            </Flex>
                        ) : undefined}
                        renderEdit={(val, onChange, onSave, onCancel) => (
                            <Flex direction="column" gap={1}>
                                <Input
                                    size="xs"
                                    type="number"
                                    step="any"
                                    value={val}
                                    onChange={(e) => onChange(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') { e.preventDefault(); onSave(); }
                                        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
                                    }}
                                    fontSize="10px"
                                    fontFamily="mono"
                                    autoFocus
                                />
                                <AssetSelector
                                    value={tx.fee_quote_asset_id ?? null}
                                    onChange={async (id) => { await saveField('fee_quote_asset_id', id); }}
                                    assets={assets}
                                    size="xs"
                                    defaultSymbol={tx.source_fee_quote_asset_symbol || ''}
                                />
                                {feeQuoteSuggestions.length > 0 && (
                                    <Flex gap={1} wrap="wrap">
                                        {feeQuoteSuggestions.map((s, i) => (
                                            <Tooltip key={i} content={`${s.item.symbol} - ${formatConfidence(s.confidence)} match`} openDelay={100}>
                                                <Badge
                                                    size="xs"
                                                    colorPalette={getConfidenceColor(s.confidence)}
                                                    variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                    cursor="pointer"
                                                    fontSize="8px"
                                                    onClick={() => saveField('fee_quote_asset_id', s.item.asset_id)}
                                                >
                                                    {s.item.symbol.slice(0, 8)}{s.item.symbol.length > 8 ? '\u2026' : ''}
                                                    {s.confidence >= 0.9 && ' \u2713'}
                                                </Badge>
                                            </Tooltip>
                                        ))}
                                    </Flex>
                                )}
                            </Flex>
                        )}
                        onSave={async (v) => { await saveField('fee', v); }}
                    />
                </Section>

                {/* ============================================================ */}
                {/* � P&L */}
                {/* ============================================================ */}
                <Section title="P&L" icon="💰" defaultOpen={true} colorScheme="green">
                    <EditableField
                        label="Include Fees"
                        value={String(tx.include_fee ?? true)}
                        type="checkbox"
                        onSave={async (v) => { await saveField('include_fee', v); }}
                    />
                    <EditableField
                        label="Taxability"
                        value={tx.taxability_status || 'unknown'}
                        type="select"
                        options={[
                            { value: 'unknown', label: 'Unknown' },
                            { value: 'taxable', label: 'Taxable' },
                            { value: 'non_taxable', label: 'Non-Taxable' },
                        ]}
                        onSave={async (v) => { await saveField('taxability_status', v); }}
                    />
                </Section>

                {/* ============================================================ */}
                {/* 🔗 Network & Advanced */}
                {/* ============================================================ */}
                <Section title="Network & Advanced" icon="🔗" defaultOpen={isTransfer} colorScheme="teal">
                    <EditableField
                        label="Network"
                        value={tx.network || ''}
                        muted={!tx.network}
                        onSave={async (v) => { await saveField('network', v); }}
                    />
                    <EditableField
                        label="Network TX ID"
                        value={tx.network_transaction_id || ''}
                        copyable
                        truncateLength={20}
                        onSave={async (v) => { await saveField('network_transaction_id', v); }}
                    />
                    <EditableField
                        label="Token Contract"
                        value={tx.token_contract_address || ''}
                        copyable
                        truncateLength={20}
                        muted={!tx.token_contract_address}
                        onSave={async (v) => { await saveField('token_contract_address', v); }}
                    />
                </Section>

                {/* ============================================================ */}
                {/* 📦 Bundle */}
                {/* ============================================================ */}
                {tx.user_calculation_unit_id && (
                    <Section title="Bundle" icon="📦" defaultOpen={false} colorScheme="blue">
                        <InfoRow
                            label="Bundle ID"
                            value={
                                bundleLoading ? (
                                    <Text fontSize="9px" color="gray.400">Loading...</Text>
                                ) : bundleData ? (
                                    <Badge size="xs" colorPalette="blue" fontSize="9px" variant="subtle">
                                        #{bundleData.id} {bundleData.pattern ? `• ${bundleData.pattern}` : ''}
                                    </Badge>
                                ) : (
                                    <Badge size="xs" colorPalette="gray" fontSize="9px">
                                        #{tx.user_calculation_unit_id}
                                    </Badge>
                                )
                            }
                        />
                        <Button
                            size="xs"
                            variant="outline"
                            colorPalette="red"
                            mt={1}
                            fontSize="9px"
                            onClick={unbundleTransaction}
                            disabled={unbundling}
                            w="100%"
                        >
                            {unbundling ? 'Removing...' : '🔗 Remove from Bundle'}
                        </Button>
                    </Section>
                )}

                {/* ============================================================ */}
                {/* 🎯 Position (for perp_open / perp_close transactions) */}
                {/* ============================================================ */}
                {(tx.source_transaction_type === 'perp_open' || tx.source_transaction_type === 'perp_close') && (
                    <PositionCard transactionId={tx.id} />
                )}

                {/* Spam/Phishing Alert */}
                {tx.review_status === 'invalid' && tx.review_notes && tx.review_notes.includes('Auto-flagged') && (
                    <Box mt={2} p={2} bg="red.950" borderWidth="1px" borderColor="red.700" borderRadius="md">
                        <Flex align="center" gap={1.5} mb={1}>
                            <Box color="red.400"><FiAlertTriangle size={14} /></Box>
                            <Text fontSize="10px" fontWeight="bold" color="red.300">Spam / Phishing Detection</Text>
                        </Flex>
                        <Text fontSize="9px" color="red.200" whiteSpace="pre-wrap" fontFamily="mono">
                            {tx.review_notes}
                        </Text>
                    </Box>
                )}

                {/* ============================================================ */}
                {/* 🏷️ Tags */}
                {/* ============================================================ */}
                <Section title="Tags" icon="🏷️" defaultOpen={false} colorScheme="blue">
                    <Flex gap={1} wrap="wrap" mb={1}>
                        {normalizedTags.length > 0 ? (
                            normalizedTags.map((tag: Record<string, unknown>, i: number) => (
                                <TagChip key={i} tag={tag} editable onRemove={() => removeTag(i)} />
                            ))
                        ) : (
                            <Text fontSize="9px" color="gray.400">No tags</Text>
                        )}
                    </Flex>
                    <>
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
                            <Button size="xs" onClick={addTag} disabled={!newTagValue.trim()} px={2}>+</Button>
                        </Flex>
                        {/* Existing tag suggestions - limited to 6 */}
                        {availableTags.length > 0 && (
                            <Flex gap={1} wrap="wrap" mt={1}>
                                {availableTags
                                    .filter(tag => !tagExists(
                                        normalizedTags.flatMap(t => Object.entries(t).map(([k, v]) => ({ key: k, value: String(v) }))),
                                        tag.key,
                                        tag.value,
                                    ))
                                    .slice(0, 6)
                                    .map((tag, idx) => (
                                        <Badge
                                            key={idx}
                                            size="xs"
                                            colorPalette="gray"
                                            variant="outline"
                                            cursor="pointer"
                                            fontSize="8px"
                                            onClick={() => {
                                                const newTag = { [tag.key]: tag.value };
                                                applyTagsUpdate([...normalizedTags, newTag]);
                                            }}
                                            _hover={{ bg: 'blue.50' }}
                                        >
                                            + {tag.key}: {tag.value}
                                        </Badge>
                                    ))}
                            </Flex>
                        )}
                    </>
                </Section>

                {/* ============================================================ */}
                {/* ✅ Review */}
                {/* ============================================================ */}
                <Section title="Review" icon="✅" defaultOpen={true} colorScheme="green">
                    <EditableField
                        label="Review Status"
                        value={tx.review_status || ''}
                        displayValue={
                            <Flex align="center" gap={1.5}>
                                <Badge
                                    size="xs"
                                    colorPalette={tx.review_status === 'valid' ? 'green' : tx.review_status === 'invalid' ? 'red' : 'yellow'}
                                    fontSize="9px"
                                >
                                    {tx.review_status}
                                </Badge>
                                {/* Quick action buttons */}
                                {tx.review_status !== 'valid' && (
                                    <Tooltip content="Mark as Valid" openDelay={100}>
                                        <Badge
                                            size="xs"
                                            colorPalette="green"
                                            variant="outline"
                                            cursor="pointer"
                                            fontSize="9px"
                                            px={1}
                                            onClick={(e: React.MouseEvent) => { e.stopPropagation(); saveField('review_status', ReviewStatus.VALID); }}
                                            _hover={{ bg: 'green.100' }}
                                        >
                                            ✓ Valid
                                        </Badge>
                                    </Tooltip>
                                )}
                                {tx.review_status !== 'invalid' && (
                                    <Tooltip content="Mark as Invalid" openDelay={100}>
                                        <Badge
                                            size="xs"
                                            colorPalette="red"
                                            variant="outline"
                                            cursor="pointer"
                                            fontSize="9px"
                                            px={1}
                                            onClick={(e: React.MouseEvent) => { e.stopPropagation(); saveField('review_status', ReviewStatus.INVALID); }}
                                            _hover={{ bg: 'red.100' }}
                                        >
                                            ✗ Invalid
                                        </Badge>
                                    </Tooltip>
                                )}
                            </Flex>
                        }
                        type="select"
                        options={[
                            { label: 'Pending', value: ReviewStatus.PENDING },
                            { label: 'Valid', value: ReviewStatus.VALID },
                            { label: 'Invalid', value: ReviewStatus.INVALID },
                        ]}
                        onSave={async (v) => { await saveField('review_status', v); }}
                    />
                    <EditableField
                        label="Review Notes"
                        value={tx.review_notes || ''}
                        muted={!tx.review_notes}
                        onSave={async (v) => { await saveField('review_notes', v); }}
                    />
                </Section>

                {/* ============================================================ */}
                {/* 📤 Source / Raw Data */}
                {/* ============================================================ */}
                <Section
                    title="Source / Raw Data"
                    icon="📤"
                    defaultOpen={false}
                    colorScheme="orange"
                    onOpen={() => { if (tx.raw_transaction_id && !hasFetchedRaw && !rawDataLoading) fetchRawData(); }}
                >
                    {/* Connector | Source Name */}
                    <InfoRow
                        label="Connector"
                        value={
                            tx.connector_name ? (
                                <Badge size="xs" bg={hexToRgba(getConnectorColor(tx.connector_name), 0.18)} color={getConnectorColor(tx.connector_name)} fontSize="8px">{tx.connector_name}</Badge>
                            ) : <Text fontSize="9px" color="gray.400">—</Text>
                        }
                    />
                    <InfoRow
                        label="Source"
                        value={<Badge size="xs" colorPalette="gray" fontSize="8px">{tx.source || '—'}</Badge>}
                    />

                    {/* Run Job Data */}
                    {tx.sync_connector_run_id && (
                        <Box mt={1} pt={1} borderTopWidth={1} borderColor="gray.200">
                            <InfoRow
                                label="Run ID"
                                value={
                                    <Badge
                                        size="xs"
                                        colorPalette="blue"
                                        variant="outline"
                                        cursor="pointer"
                                        fontSize="8px"
                                        onClick={(e: React.MouseEvent) => { e.stopPropagation(); setShowRunDrawer(true); }}
                                        _hover={{ bg: 'blue.100' }}
                                    >
                                        #{tx.sync_connector_run_id} ↗
                                    </Badge>
                                }
                            />
                            {tx.run_datetime && (
                                <InfoRow label="Run Datetime" value={formatDateTimeLocale(tx.run_datetime)} muted />
                            )}
                        </Box>
                    )}

                    {/* Raw Data (auto-fetched on section open) */}
                    {!tx.raw_transaction_id ? (
                        <Box p={2} bg="gray.50" borderRadius="md" textAlign="center" mt={1}>
                            <Text fontSize="9px" color="gray.500">No raw transaction linked (manual entry)</Text>
                        </Box>
                    ) : rawDataLoading ? (
                        <Flex align="center" justify="center" py={2} gap={2} mt={1}>
                            <FiLoader className="animate-spin" size={12} />
                            <Text fontSize="9px" color="gray.500">Loading raw data...</Text>
                        </Flex>
                    ) : rawDataError ? (
                        <Box p={2} bg="red.50" borderRadius="md" mt={1}>
                            <Text fontSize="9px" color="red.500">Error: {rawDataError}</Text>
                            <Button size="xs" mt={1} fontSize="9px" onClick={() => { setHasFetchedRaw(false); setRawDataError(null); }}>
                                Retry
                            </Button>
                        </Box>
                    ) : rawData ? (
                        <Box mt={1} pt={1} borderTopWidth={1} borderColor="gray.200">
                            <Flex justify="space-between" align="center" mb={1}>
                                <Flex align="center" gap={1}>
                                    <Text fontSize="9px" color="gray.500">Raw TX ID: {rawData.id}</Text>
                                    <Text fontSize="8px" color="gray.400">• {rawData.source_transaction_id}</Text>
                                </Flex>
                                <Button size="xs" variant="ghost" onClick={copyJson} px={1} fontSize="9px">
                                    {copiedJson ? <FiCheck size={10} /> : <FiCopy size={10} />}
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
                                css={{ userSelect: 'text' }}
                            >
                                {JSON.stringify(rawData.raw_data, null, 2)}
                            </Box>
                            {rawData.ingestion_time && (
                                <InfoRow label="Ingestion Time" value={formatDateTimeLocale(rawData.ingestion_time)} muted />
                            )}
                        </Box>
                    ) : null}
                </Section>

                {/* Connector Run Detail Drawer */}
                {tx.sync_connector_run_id && (
                    <ConnectorRunDetailDrawer
                        runId={tx.sync_connector_run_id}
                        open={showRunDrawer}
                        onClose={() => setShowRunDrawer(false)}
                    />
                )}

                {/* ============================================================ */}
                {/* 🔗 Source-Mappings */}
                {/* ============================================================ */}
                <Section title="Source-Mappings" icon="🔗" defaultOpen={false} colorScheme="blue">
                    <Text fontSize="9px" color="gray.500" mb={1}>Source value → Resolved ID</Text>

                    <InfoRow
                        label="Account"
                        value={
                            tx.account_id ? (
                                <Flex align="center" gap={1}>
                                    <Text fontSize="9px" color="gray.500" maxW="60px" truncate>{tx.source_account || '-'}</Text>
                                    <Text fontSize="9px">→</Text>
                                    <AccountBadge
                                        account={accounts.find(a => a.id === tx.account_id)}
                                        accountId={tx.account_id}
                                        size="xs"
                                        colorPalette="cyan"
                                        maxLength={14}
                                    />
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
                                    <AssetBadge asset={tx.linked_asset} size="xs" colorPalette="purple" maxLength={15} />
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
                                    <AssetBadge asset={tx.price_quote_asset} size="xs" colorPalette="green" maxLength={15} />
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
                                    <AssetBadge asset={tx.fee_quote_asset} size="xs" colorPalette="green" maxLength={15} />
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
                                    <AccountBadge
                                        account={accounts.find(a => a.id === tx.from_account_id)}
                                        accountId={tx.from_account_id}
                                        size="xs"
                                        colorPalette="cyan"
                                        maxLength={14}
                                    />
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
                                    <AccountBadge
                                        account={accounts.find(a => a.id === tx.to_account_id)}
                                        accountId={tx.to_account_id}
                                        size="xs"
                                        colorPalette="cyan"
                                        maxLength={14}
                                    />
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
            </Box>

            {/* Quick-create dialogs */}
            {quickCreateAccount && (
                <AccountFormDialog
                    isOpen={true}
                    onClose={(createdId) => {
                        if (createdId) handleQuickAccountCreated(createdId);
                        else setQuickCreateAccount(null);
                    }}
                    prefill={quickCreateAccount.prefill}
                />
            )}
            {quickCreateAsset && (
                <AssetFormDialog
                    isOpen={true}
                    onClose={(createdId) => {
                        if (createdId) handleQuickAssetCreated(createdId);
                        else setQuickCreateAsset(null);
                    }}
                    prefill={quickCreateAsset.prefill}
                    rawAssetSource={quickCreateAsset.rawSource}
                    rawAssetSymbol={quickCreateAsset.rawSymbol}
                />
            )}
        </>
    );
};

export default TransactionSidePanel;


// ============================================================================
// PositionCard — Shows linked derivative position for perp transactions
// ============================================================================

const PositionCard: React.FC<{ transactionId: number }> = ({ transactionId }) => {
    const { positions, isLoading } = usePositions({
        transaction_id: transactionId,
        limit: 1,
        enabled: true,
    });

    const pos = positions[0] as DerivativePosition | undefined;

    if (isLoading) {
        return (
            <Box mt={2} p={2} bg="gray.800" borderRadius="md" borderWidth="1px" borderColor="gray.600">
                <Flex align="center" gap={1.5} mb={1}>
                    <Text fontSize="10px" fontWeight="bold" color="gray.300">🎯 Position</Text>
                </Flex>
                <Text fontSize="9px" color="gray.400">Loading...</Text>
            </Box>
        );
    }

    if (!pos) return null;

    const sideColor = pos.side === 'long' ? 'green' : 'red';
    const statusColor = pos.status === 'open' ? 'blue' : 'gray';
    const pnlColor = pos.net_pnl >= 0 ? 'green.300' : 'red.300';

    return (
        <Box mt={2} p={2} bg="gray.800" borderRadius="md" borderWidth="1px" borderColor="gray.600">
            {/* Header */}
            <Flex align="center" gap={1.5} mb={2}>
                <Text fontSize="10px" fontWeight="bold" color="gray.300">🎯 Position</Text>
                <Badge size="xs" colorPalette="purple" fontSize="9px">{pos.coin}</Badge>
                <Badge size="xs" colorPalette={sideColor} fontSize="9px" variant="solid">
                    {pos.side.toUpperCase()}
                </Badge>
                <Badge size="xs" colorPalette={statusColor} fontSize="9px" variant="subtle">
                    {pos.status}
                </Badge>
            </Flex>

            {/* Body */}
            <Flex direction="column" gap={0.5} fontSize="9px">
                <Flex justify="space-between">
                    <Text color="gray.400">Entry Price</Text>
                    <Text color="gray.200">${pos.entry_price?.toFixed(2)}</Text>
                </Flex>
                {pos.exit_price != null && (
                    <Flex justify="space-between">
                        <Text color="gray.400">Exit Price</Text>
                        <Text color="gray.200">${pos.exit_price.toFixed(2)}</Text>
                    </Flex>
                )}
                <Flex justify="space-between">
                    <Text color="gray.400">Size</Text>
                    <Text color="gray.200">{pos.size} {pos.coin}</Text>
                </Flex>
                <Flex justify="space-between">
                    <Text color="gray.400">Realized P&L</Text>
                    <Text color={pnlColor} fontWeight="bold">
                        {pos.realized_pnl >= 0 ? '+' : ''}{pos.realized_pnl?.toFixed(2)} {pos.margin_currency}
                    </Text>
                </Flex>
                <Flex justify="space-between">
                    <Text color="gray.400">Fees</Text>
                    <Text color="gray.200">{pos.total_fees?.toFixed(2)} {pos.margin_currency}</Text>
                </Flex>
                <Flex justify="space-between">
                    <Text color="gray.400">Net P&L</Text>
                    <Text color={pnlColor} fontWeight="bold">
                        {pos.net_pnl >= 0 ? '+' : ''}{pos.net_pnl?.toFixed(2)} {pos.margin_currency}
                    </Text>
                </Flex>
                {pos.duration_hours != null && (
                    <Flex justify="space-between">
                        <Text color="gray.400">Duration</Text>
                        <Text color="gray.200">
                            {pos.duration_hours < 24
                                ? `${pos.duration_hours.toFixed(1)}h`
                                : `${(pos.duration_hours / 24).toFixed(1)}d`}
                        </Text>
                    </Flex>
                )}
                {pos.return_pct != null && (
                    <Flex justify="space-between">
                        <Text color="gray.400">Return</Text>
                        <Text color={pnlColor}>{pos.return_pct >= 0 ? '+' : ''}{pos.return_pct.toFixed(2)}%</Text>
                    </Flex>
                )}
            </Flex>
        </Box>
    );
};
