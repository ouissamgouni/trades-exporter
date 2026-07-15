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
import { Badge, Button, Input, Spinner, type BadgeColorScheme } from './ui/primitives';
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
import { Transaction, Account, Asset, API_URL, DerivativePosition, Bundle } from '../types';
import { Direction, ReviewStatus, TransactionType, TaxabilityStatus, UnitPattern } from '../enums';
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
import { BundleMemberTransactionsTable } from './tables/wrappers/BundleMemberTransactionsTable';
import { toaster } from './ui/toaster';
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

const SECTION_COLORS: Record<string, { headerBg: string; headerBgMain: string; headerHover: string; headerHoverMain: string; text: string }> = {
    blue: { headerBg: 'bg-blue-50', headerBgMain: 'bg-blue-100', headerHover: 'hover:bg-blue-100', headerHoverMain: 'hover:bg-blue-200', text: 'text-blue-700' },
    purple: { headerBg: 'bg-purple-50', headerBgMain: 'bg-purple-100', headerHover: 'hover:bg-purple-100', headerHoverMain: 'hover:bg-purple-200', text: 'text-purple-700' },
    cyan: { headerBg: 'bg-cyan-50', headerBgMain: 'bg-cyan-100', headerHover: 'hover:bg-cyan-100', headerHoverMain: 'hover:bg-cyan-200', text: 'text-cyan-700' },
    green: { headerBg: 'bg-green-50', headerBgMain: 'bg-green-100', headerHover: 'hover:bg-green-100', headerHoverMain: 'hover:bg-green-200', text: 'text-green-700' },
    teal: { headerBg: 'bg-teal-50', headerBgMain: 'bg-teal-100', headerHover: 'hover:bg-teal-100', headerHoverMain: 'hover:bg-teal-200', text: 'text-teal-700' },
    orange: { headerBg: 'bg-orange-50', headerBgMain: 'bg-orange-100', headerHover: 'hover:bg-orange-100', headerHoverMain: 'hover:bg-orange-200', text: 'text-orange-700' },
    gray: { headerBg: 'bg-slate-50', headerBgMain: 'bg-slate-100', headerHover: 'hover:bg-slate-100', headerHoverMain: 'hover:bg-slate-200', text: 'text-slate-700' },
};

const InfoRow: React.FC<InfoRowProps> = ({ label, value, muted, alert }) => (
    <div className="flex items-center justify-between gap-2 py-0.5">
        <span className="shrink-0 text-[10px] text-slate-500">{label}</span>
        <div className="flex items-center gap-1">
            {alert && <FiAlertTriangle size={10} color="orange" />}
            <span
                className={`break-all text-right font-mono text-[10px] ${alert ? 'text-orange-500' : muted ? 'text-slate-400' : 'text-slate-700'}`}
            >
                {value}
            </span>
        </div>
    </div>
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
    const colors = SECTION_COLORS[colorScheme] ?? SECTION_COLORS.gray;

    return (
        <div className={isMain ? 'mb-2' : 'mb-1'}>
            <div
                onClick={() => {
                    const willOpen = !isOpen;
                    setIsOpen(willOpen);
                    if (willOpen && onOpen) onOpen();
                }}
                className={`flex cursor-pointer items-center gap-1 px-2 ${isMain ? 'py-1.5' : 'py-1'} ${isMain ? colors.headerBgMain : colors.headerBg} ${isMain ? colors.headerHoverMain : colors.headerHover}`}
            >
                {isOpen ? <FiChevronDown size={isMain ? 14 : 12} /> : <FiChevronRight size={isMain ? 14 : 12} />}
                <span
                    className={`${isMain ? 'text-[11px]' : 'text-[10px]'} font-bold ${colors.text} ${isMain ? 'uppercase' : ''}`}
                >
                    {icon && `${icon} `}{title}
                </span>
            </div>
            {isOpen && (
                <div className={`${isMain ? 'px-1' : 'px-2'} py-1 ${isMain ? 'ml-0' : 'ml-2'}`}>
                    {children}
                </div>
            )}
        </div>
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
                    colorScheme="blue"
                    className="inline-flex items-center gap-0.5 px-1 py-0.5 text-[9px]"
                >
                    <FiTag size={8} />
                    <span className="text-[9px]">{key === 'value' ? String(value) : `${key}: ${value}`}</span>
                    {editable && onRemove && index === entries.length - 1 && (
                        <button
                            type="button"
                            aria-label="Remove tag"
                            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onRemove?.(); }}
                            className="ml-0.5 cursor-pointer hover:text-red-500"
                        >
                            <FiX size={8} />
                        </button>
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
    const [bundleData, setBundleData] = useState<Bundle | null>(null);
    const [bundleLoading, setBundleLoading] = useState(false);
    const [bundleError, setBundleError] = useState<string | null>(null);
    const [bundleTaxability, setBundleTaxability] = useState<string>(TaxabilityStatus.UNKNOWN);
    const [taxabilityLoading, setTaxabilityLoading] = useState(false);

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
        field: 'asset_id' | 'price_quote_asset_id' | 'fee_quote_asset_id' | 'attributed_asset_id';
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
     * When total is saved, back-compute price = total / quantity
     * and patch both total + price in one call.
     */
    const saveTotalDerivePrice = async (newValue: string) => {
        const total = parseFloat(newValue);
        if (isNaN(total)) { await saveField('total', newValue); return; }

        const quantity = tx.quantity;
        const updates: Record<string, any> = { total: newValue };
        if (total > 0 && quantity > 0) {
            updates.price = (total / quantity).toFixed(8);
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
            setBundleError(null);
            try {
                const response = await fetch(`${API_URL}/bundles/${tx.user_calculation_unit_id}`);
                if (!response.ok) throw new Error('Failed to fetch bundle');
                const data = await response.json();
                setBundleData(data);
                setBundleTaxability(data.taxability_override || TaxabilityStatus.UNKNOWN);
            } catch (err) {
                console.error('Failed to fetch bundle:', err);
                setBundleError(err instanceof Error ? err.message : 'Unknown error');
            }
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
    // Bundle taxability handler
    // ============================================================

    const patternColors: Record<string, BadgeColorScheme> = {
        [UnitPattern.INTERNAL_TRANSFER]: 'blue',
        [UnitPattern.SWAP]: 'orange',
        [UnitPattern.SPLIT]: 'purple',
        [UnitPattern.FLOW]: 'blue',
        [UnitPattern.SPINOFF]: 'red',
        [UnitPattern.CUSTOM]: 'purple',
    };

    const handleBundleTaxabilityChange = async (newValue: string) => {
        if (!bundleData) return;
        setBundleTaxability(newValue);
        setTaxabilityLoading(true);
        try {
            const response = await fetch(`${API_URL}/bundles/${bundleData.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    taxability_override: newValue === TaxabilityStatus.UNKNOWN ? null : newValue,
                }),
            });
            if (!response.ok) throw new Error('Failed to update taxability');
            queryClient.invalidateQueries({ queryKey: ['bundles'] });
            queryClient.invalidateQueries({ queryKey: ['transactions'] });
            toaster.success({
                title: 'Taxability updated',
                description: `Bundle #${bundleData.id} set to ${newValue}`,
            });
        } catch (err) {
            setBundleTaxability(bundleData.taxability_override || TaxabilityStatus.UNKNOWN);
            toaster.error({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to update taxability',
            });
        } finally {
            setTaxabilityLoading(false);
        }
    };

    // ============================================================
    // RENDER
    // ============================================================

    const simplifiedType = deriveSimplifiedType(tx.transaction_type);

    return (
        <>
            <div className="select-text">

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
                            <Badge colorScheme={(tx.transaction_type === 'transfer' ? 'purple' : tx.transaction_type === 'margin' ? 'yellow' : tx.transaction_type === 'cost' ? 'gray' : 'blue') as BadgeColorScheme}>
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
                                colorScheme={(tx.direction === 'inflow' ? 'green' : tx.direction === 'outflow' ? 'red' : 'gray') as BadgeColorScheme}
                            >
                                <span className="inline-flex items-center gap-0.5">
                                    {tx.direction === 'inflow' ? (
                                        <FiArrowDown size={9} />
                                    ) : tx.direction === 'outflow' ? (
                                        <FiArrowUp size={9} />
                                    ) : null}
                                    {tx.direction || '-'}
                                </span>
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

                    {/* Attributed Asset (LinkableAssetField) - always visible */}
                    <LinkableAssetField
                        label="Attributed Asset"
                        sourceValue={tx.source_attributed_asset_symbol}
                        linkedId={tx.attributed_asset_id}
                        linkedAsset={tx.attributed_asset}
                        assets={assets}
                        onSourceChange={async (v) => {
                            await saveFields({ source_attributed_asset_symbol: v, attributed_asset_id: null });
                        }}
                        onLink={async (id) => { await saveField('attributed_asset_id', id); }}
                        colorPalette="orange"
                        maxLength={18}
                        source={tx.source}
                        onCreateNew={!tx.attributed_asset_id ? () => {
                            setQuickCreateAsset({
                                field: 'attributed_asset_id',
                                prefill: { symbol: tx.source_attributed_asset_symbol || '' },
                                rawSource: tx.source,
                                rawSymbol: tx.source_attributed_asset_symbol || undefined,
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
                                <div className={`mb-1 mt-1 p-2 ${transferType === 'internal' ? 'bg-green-100' : 'bg-orange-100'}`}>
                                    <span className={`text-[9px] font-bold ${transferType === 'internal' ? 'text-green-700' : 'text-orange-700'}`}>
                                        {transferType === 'internal'
                                            ? '🏠 Internal Transfer — Both accounts are owned. No taxable event.'
                                            : '🌐 External Transfer — To/from external party.'}
                                    </span>
                                </div>
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
                            <div className="flex flex-wrap items-center gap-1">
                                <span className="font-mono text-[10px]"><ValueDisplay value={tx.price} /></span>
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
                                            colorScheme={getConfidenceColor(s.confidence) as BadgeColorScheme}
                                            className="cursor-pointer text-[7px]"
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
                            </div>
                        }
                        renderEdit={(val, onChange, onSave, onCancel) => (
                            <div className="flex flex-col gap-1">
                                <Input
                                    type="number"
                                    step="any"
                                    value={val}
                                    onChange={(e) => onChange(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') { e.preventDefault(); onSave(); }
                                        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
                                    }}
                                    className="h-6 font-mono text-[10px]"
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
                                    <div className="flex flex-wrap gap-1">
                                        {priceQuoteSuggestions.map((s, i) => (
                                            <Tooltip key={i} content={`${s.item.symbol} - ${formatConfidence(s.confidence)} match`} openDelay={100}>
                                                <Badge
                                                    colorScheme={getConfidenceColor(s.confidence) as BadgeColorScheme}
                                                    className="cursor-pointer text-[8px]"
                                                    onClick={() => savePriceQuoteAsset(String(s.item.asset_id))}
                                                >
                                                    {s.item.symbol.slice(0, 8)}{s.item.symbol.length > 8 ? '\u2026' : ''}
                                                    {s.confidence >= 0.9 && ' \u2713'}
                                                </Badge>
                                            </Tooltip>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                        onSave={async (v) => { await savePriceOrQuantity('price', v); }}
                    />

                    {/* Total */}
                    <EditableField
                        label="Total"
                        value={String(tx.total ?? '')}
                        displayValue={
                            <div className="flex items-center gap-1">
                                <span className="font-mono text-[10px]"><ValueDisplay value={tx.total} /></span>
                                <AssetBadge
                                    asset={tx.price_quote_asset}
                                    sourceSymbol={tx.source_price_quote_asset_symbol}
                                    size="xs"
                                    colorPalette="cyan"
                                    maxLength={12}
                                />
                            </div>

                        }
                        type="number"
                        onSave={async (v) => { await saveTotalDerivePrice(v); }}
                    />

                    {/* Fee + Quote (compound edit) */}
                    <EditableField
                        label="Fee"
                        value={String(tx.fee ?? '')}
                        displayValue={tx.fee ? (
                            <div className="flex flex-wrap items-center gap-1">
                                <span className="font-mono text-[10px]"><ValueDisplay value={tx.fee} /></span>
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
                                            colorScheme={getConfidenceColor(s.confidence) as BadgeColorScheme}
                                            className="cursor-pointer text-[7px]"
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
                            </div>
                        ) : undefined}
                        renderEdit={(val, onChange, onSave, onCancel) => (
                            <div className="flex flex-col gap-1">
                                <Input
                                    type="number"
                                    step="any"
                                    value={val}
                                    onChange={(e) => onChange(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') { e.preventDefault(); onSave(); }
                                        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
                                    }}
                                    className="h-6 font-mono text-[10px]"
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
                                    <div className="flex flex-wrap gap-1">
                                        {feeQuoteSuggestions.map((s, i) => (
                                            <Tooltip key={i} content={`${s.item.symbol} - ${formatConfidence(s.confidence)} match`} openDelay={100}>
                                                <Badge
                                                    colorScheme={getConfidenceColor(s.confidence) as BadgeColorScheme}
                                                    className="cursor-pointer text-[8px]"
                                                    onClick={() => saveField('fee_quote_asset_id', s.item.asset_id)}
                                                >
                                                    {s.item.symbol.slice(0, 8)}{s.item.symbol.length > 8 ? '\u2026' : ''}
                                                    {s.confidence >= 0.9 && ' \u2713'}
                                                </Badge>
                                            </Tooltip>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                        onSave={async (v) => { await saveField('fee', v); }}
                    />
                </Section>

                {/* ============================================================ */}
                {/* 💰 P&L */}
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
                    {tx.has_fr_tax_override && (
                        <div className="flex items-center gap-2 bg-blue-50 px-2 py-1">
                            <Badge colorScheme="blue" className="text-[7px]">FR</Badge>
                            <span className="text-[9px] text-blue-600">French Tax override active — managed from the FR Tax tab</span>
                        </div>
                    )}
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
                        {bundleLoading ? (
                            <div className="flex items-center gap-2 py-2">
                                <Spinner size="xs" />
                                <span className="text-[9px] text-slate-400">Loading bundle...</span>
                            </div>
                        ) : bundleError ? (
                            <span className="text-[9px] text-red-400">{bundleError}</span>
                        ) : bundleData ? (
                            <>
                                {/* Header: pattern badge + bundle ID */}
                                <div className="mb-1 flex items-center justify-between">
                                    <Badge
                                        colorScheme={patternColors[bundleData.pattern || ''] || 'gray'}
                                    >
                                        {bundleData.pattern || 'unknown'}
                                    </Badge>
                                    <Badge colorScheme="purple">
                                        📦 #{bundleData.id}
                                    </Badge>
                                </div>

                                {/* Label */}
                                <p className="mb-0.5 text-[10px] font-bold text-slate-700">
                                    {bundleData.label || `Bundle #${bundleData.id}`}
                                </p>

                                {/* Notes */}
                                {bundleData.notes && (
                                    <p className="mb-1 text-[9px] text-slate-400">
                                        {bundleData.notes}
                                    </p>
                                )}

                                {/* Taxability Override */}
                                <div className="mb-2 flex items-center gap-2">
                                    <span className="shrink-0 text-[9px] text-slate-500">
                                        Taxability:
                                    </span>
                                    <select
                                        title="Bundle taxability"
                                        value={bundleTaxability}
                                        onChange={(e) => handleBundleTaxabilityChange(e.target.value)}
                                        disabled={taxabilityLoading}
                                        style={{
                                            fontSize: '10px',
                                            padding: '2px 6px',
                                            width: '120px',
                                            backgroundColor:
                                                bundleTaxability === TaxabilityStatus.TAXABLE
                                                    ? '#FED7AA'
                                                    : bundleTaxability === TaxabilityStatus.NON_TAXABLE
                                                        ? '#C6F6D5'
                                                        : '#FEFCBF',
                                        }}
                                        className="disabled:opacity-50"
                                    >
                                        <option value={TaxabilityStatus.UNKNOWN}>Unknown</option>
                                        <option value={TaxabilityStatus.TAXABLE}>Taxable</option>
                                        <option value={TaxabilityStatus.NON_TAXABLE}>Non-Taxable</option>
                                    </select>
                                    {taxabilityLoading && <Spinner size="xs" />}
                                </div>

                                {/* Transaction count + embedded table */}
                                <p className="mb-1 text-[9px] font-medium text-slate-500">
                                    {bundleData.transaction_count} transaction
                                    {bundleData.transaction_count !== 1 ? 's' : ''}
                                </p>
                                <div className="mb-2 max-h-[250px] overflow-y-auto">
                                    <BundleMemberTransactionsTable
                                        transactionIds={bundleData.transactions.map(t => t.id)}
                                    />
                                </div>

                                {/* Remove from bundle */}
                                <Button
                                    size="sm"
                                    variant="outline"
                                    colorScheme="red"
                                    className="mt-1 w-full text-[9px]"
                                    onClick={unbundleTransaction}
                                    disabled={unbundling}
                                >
                                    {unbundling ? 'Removing...' : '🔗 Remove from Bundle'}
                                </Button>
                            </>
                        ) : (
                            <Badge colorScheme="gray">
                                #{tx.user_calculation_unit_id}
                            </Badge>
                        )}
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
                    <div className="mt-2 border border-red-700 bg-red-950 p-2">
                        <div className="mb-1 flex items-center gap-1.5">
                            <span className="text-red-400"><FiAlertTriangle size={14} /></span>
                            <span className="text-[10px] font-bold text-red-300">Spam / Phishing Detection</span>
                        </div>
                        <p className="whitespace-pre-wrap font-mono text-[9px] text-red-200">
                            {tx.review_notes}
                        </p>
                    </div>
                )}

                {/* ============================================================ */}
                {/* 🏷️ Tags */}
                {/* ============================================================ */}
                <Section title="Tags" icon="🏷️" defaultOpen={false} colorScheme="blue">
                    <div className="mb-1 flex flex-wrap gap-1">
                        {normalizedTags.length > 0 ? (
                            normalizedTags.map((tag: Record<string, unknown>, i: number) => (
                                <TagChip key={i} tag={tag} editable onRemove={() => removeTag(i)} />
                            ))
                        ) : (
                            <span className="text-[9px] text-slate-400">No tags</span>
                        )}
                    </div>
                    <>
                        <div className="mt-1 flex gap-1">
                            <Input
                                placeholder="Key"
                                value={newTagKey}
                                onChange={(e) => setNewTagKey(e.target.value)}
                                className="h-6 w-[50px] text-[9px]"
                            />
                            <Input
                                placeholder="Value"
                                value={newTagValue}
                                onChange={(e) => setNewTagValue(e.target.value)}
                                className="h-6 flex-1 text-[9px]"
                                onKeyDown={(e) => e.key === 'Enter' && addTag()}
                            />
                            <Button size="sm" className="h-6 px-2" onClick={addTag} disabled={!newTagValue.trim()}>+</Button>
                        </div>
                        {/* Existing tag suggestions - limited to 6 */}
                        {availableTags.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
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
                                            colorScheme="gray"
                                            className="cursor-pointer text-[8px] hover:bg-blue-50"
                                            onClick={() => {
                                                const newTag = { [tag.key]: tag.value };
                                                applyTagsUpdate([...normalizedTags, newTag]);
                                            }}
                                        >
                                            + {tag.key}: {tag.value}
                                        </Badge>
                                    ))}
                            </div>
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
                            <div className="flex items-center gap-1.5">
                                <Badge
                                    colorScheme={(tx.review_status === 'valid' ? 'green' : tx.review_status === 'invalid' ? 'red' : 'yellow') as BadgeColorScheme}
                                >
                                    {tx.review_status}
                                </Badge>
                                {/* Quick action buttons */}
                                {tx.review_status !== 'valid' && (
                                    <Tooltip content="Mark as Valid" openDelay={100}>
                                        <Badge
                                            colorScheme="green"
                                            className="cursor-pointer px-1 text-[9px] hover:bg-green-100"
                                            onClick={(e: React.MouseEvent) => { e.stopPropagation(); saveField('review_status', ReviewStatus.VALID); }}
                                        >
                                            ✓ Valid
                                        </Badge>
                                    </Tooltip>
                                )}
                                {tx.review_status !== 'invalid' && (
                                    <Tooltip content="Mark as Invalid" openDelay={100}>
                                        <Badge
                                            colorScheme="red"
                                            className="cursor-pointer px-1 text-[9px] hover:bg-red-100"
                                            onClick={(e: React.MouseEvent) => { e.stopPropagation(); saveField('review_status', ReviewStatus.INVALID); }}
                                        >
                                            ✗ Invalid
                                        </Badge>
                                    </Tooltip>
                                )}
                            </div>
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
                                <Badge className="text-[8px]" style={{ backgroundColor: hexToRgba(getConnectorColor(tx.connector_name), 0.18), color: getConnectorColor(tx.connector_name) }}>{tx.connector_name}</Badge>
                            ) : <span className="text-[9px] text-slate-400">—</span>
                        }
                    />
                    <InfoRow
                        label="Source"
                        value={<Badge colorScheme="gray" className="text-[8px]">{tx.source || '—'}</Badge>}
                    />

                    {/* Run Job Data */}
                    {tx.sync_connector_run_id && (
                        <div className="mt-1 border-t border-slate-200 pt-1">
                            <InfoRow
                                label="Run ID"
                                value={
                                    <Badge
                                        colorScheme="blue"
                                        className="cursor-pointer text-[8px] hover:bg-blue-100"
                                        onClick={(e: React.MouseEvent) => { e.stopPropagation(); setShowRunDrawer(true); }}
                                    >
                                        #{tx.sync_connector_run_id} ↗
                                    </Badge>
                                }
                            />
                            {tx.run_datetime && (
                                <InfoRow label="Run Datetime" value={formatDateTimeLocale(tx.run_datetime)} muted />
                            )}
                        </div>
                    )}

                    {/* Raw Data (auto-fetched on section open) */}
                    {!tx.raw_transaction_id ? (
                        <div className="mt-1 bg-slate-50 p-2 text-center">
                            <span className="text-[9px] text-slate-500">No raw transaction linked (manual entry)</span>
                        </div>
                    ) : rawDataLoading ? (
                        <div className="mt-1 flex items-center justify-center gap-2 py-2">
                            <FiLoader className="animate-spin" size={12} />
                            <span className="text-[9px] text-slate-500">Loading raw data...</span>
                        </div>
                    ) : rawDataError ? (
                        <div className="mt-1 bg-red-50 p-2">
                            <span className="text-[9px] text-red-500">Error: {rawDataError}</span>
                            <Button size="sm" className="mt-1 text-[9px]" onClick={() => { setHasFetchedRaw(false); setRawDataError(null); }}>
                                Retry
                            </Button>
                        </div>
                    ) : rawData ? (
                        <div className="mt-1 border-t border-slate-200 pt-1">
                            <div className="mb-1 flex items-center justify-between">
                                <div className="flex items-center gap-1">
                                    <span className="text-[9px] text-slate-500">Raw TX ID: {rawData.id}</span>
                                    <span className="text-[8px] text-slate-400">• {rawData.source_transaction_id}</span>
                                </div>
                                <Button size="sm" variant="ghost" onClick={copyJson} className="px-1 text-[9px]">
                                    {copiedJson ? <FiCheck size={10} /> : <FiCopy size={10} />}
                                </Button>
                            </div>
                            <div className="max-h-[200px] select-text overflow-y-auto whitespace-pre-wrap break-all bg-slate-900 p-2 font-mono text-[8px] text-green-300">
                                {JSON.stringify(rawData.raw_data, null, 2)}
                            </div>
                            {rawData.ingestion_time && (
                                <InfoRow label="Ingestion Time" value={formatDateTimeLocale(rawData.ingestion_time)} muted />
                            )}
                        </div>
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
                    <p className="mb-1 text-[9px] text-slate-500">Source value → Resolved ID</p>

                    <InfoRow
                        label="Account"
                        value={
                            tx.account_id ? (
                                <div className="flex items-center gap-1">
                                    <span className="max-w-[60px] truncate text-[9px] text-slate-500">{tx.source_account || '-'}</span>
                                    <span className="text-[9px]">→</span>
                                    <AccountBadge
                                        account={accounts.find(a => a.id === tx.account_id)}
                                        accountId={tx.account_id}
                                        size="xs"
                                        colorPalette="cyan"
                                        maxLength={14}
                                    />
                                </div>
                            ) : tx.source_account ? (
                                <div className="flex items-center gap-1">
                                    <span className="max-w-[60px] truncate text-[9px] text-slate-500">{tx.source_account}</span>
                                    <span className="text-[9px]">→</span>
                                    <span className="text-[9px] text-orange-500">NOT LINKED</span>
                                </div>
                            ) : '-'
                        }
                        alert={!tx.account_id && !!tx.source_account}
                    />

                    <InfoRow
                        label="Asset"
                        value={
                            tx.asset_id ? (
                                <div className="flex items-center gap-1">
                                    <span className="text-[9px] text-slate-500">{tx.source_asset_symbol}</span>
                                    <span className="text-[9px]">→</span>
                                    <AssetBadge asset={tx.linked_asset} size="xs" colorPalette="purple" maxLength={15} />
                                </div>
                            ) : (
                                <div className="flex items-center gap-1">
                                    <span className="text-[9px] text-slate-500">{tx.source_asset_symbol || '-'}</span>
                                    <span className="text-[9px]">→</span>
                                    <span className="text-[9px] text-orange-500">NOT LINKED</span>
                                </div>
                            )
                        }
                        alert={!tx.asset_id && !!tx.source_asset_symbol}
                    />

                    <InfoRow
                        label="Price Quote"
                        value={
                            tx.price_quote_asset_id ? (
                                <div className="flex items-center gap-1">
                                    <span className="text-[9px] text-slate-500">{tx.source_price_quote_asset_symbol}</span>
                                    <span className="text-[9px]">→</span>
                                    <AssetBadge asset={tx.price_quote_asset} size="xs" colorPalette="green" maxLength={15} />
                                </div>
                            ) : (
                                <div className="flex items-center gap-1">
                                    <span className="text-[9px] text-slate-500">{tx.source_price_quote_asset_symbol || '-'}</span>
                                    <span className="text-[9px]">→</span>
                                    <span className="text-[9px] text-orange-500">NOT LINKED</span>
                                </div>
                            )
                        }
                        alert={!tx.price_quote_asset_id && !!tx.source_price_quote_asset_symbol}
                    />

                    <InfoRow
                        label="Fee Quote"
                        value={
                            tx.fee_quote_asset_id ? (
                                <div className="flex items-center gap-1">
                                    <span className="text-[9px] text-slate-500">{tx.source_fee_quote_asset_symbol}</span>
                                    <span className="text-[9px]">→</span>
                                    <AssetBadge asset={tx.fee_quote_asset} size="xs" colorPalette="green" maxLength={15} />
                                </div>
                            ) : tx.source_fee_quote_asset_symbol ? (
                                <div className="flex items-center gap-1">
                                    <span className="text-[9px] text-slate-500">{tx.source_fee_quote_asset_symbol}</span>
                                    <span className="text-[9px]">→</span>
                                    <span className="text-[9px] text-orange-500">NOT LINKED</span>
                                </div>
                            ) : '-'
                        }
                        alert={!tx.fee_quote_asset_id && !!tx.source_fee_quote_asset_symbol}
                    />

                    <InfoRow
                        label="From Account"
                        value={
                            tx.from_account_id ? (
                                <div className="flex items-center gap-1">
                                    <span className="max-w-[60px] truncate text-[9px] text-slate-500" title={tx.source_from_account || undefined}>{tx.source_from_account || '-'}</span>
                                    <span className="text-[9px]">→</span>
                                    <AccountBadge
                                        account={accounts.find(a => a.id === tx.from_account_id)}
                                        accountId={tx.from_account_id}
                                        size="xs"
                                        colorPalette="cyan"
                                        maxLength={14}
                                    />
                                </div>
                            ) : tx.source_from_account ? (
                                <div className="flex items-center gap-1">
                                    <span className="max-w-[60px] truncate text-[9px] text-slate-500" title={tx.source_from_account}>{tx.source_from_account}</span>
                                    <span className="text-[9px]">→</span>
                                    <span className="text-[9px] text-orange-500">NOT LINKED</span>
                                </div>
                            ) : '-'
                        }
                    />

                    <InfoRow
                        label="To Account"
                        value={
                            tx.to_account_id ? (
                                <div className="flex items-center gap-1">
                                    <span className="max-w-[60px] truncate text-[9px] text-slate-500" title={tx.source_to_account || undefined}>{tx.source_to_account || '-'}</span>
                                    <span className="text-[9px]">→</span>
                                    <AccountBadge
                                        account={accounts.find(a => a.id === tx.to_account_id)}
                                        accountId={tx.to_account_id}
                                        size="xs"
                                        colorPalette="cyan"
                                        maxLength={14}
                                    />
                                </div>
                            ) : tx.source_to_account ? (
                                <div className="flex items-center gap-1">
                                    <span className="max-w-[60px] truncate text-[9px] text-slate-500" title={tx.source_to_account}>{tx.source_to_account}</span>
                                    <span className="text-[9px]">→</span>
                                    <span className="text-[9px] text-orange-500">NOT LINKED</span>
                                </div>
                            ) : '-'
                        }
                    />
                </Section>
            </div>

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
            <div className="mt-2 border border-slate-600 bg-slate-800 p-2">
                <div className="mb-1 flex items-center gap-1.5">
                    <span className="text-[10px] font-bold text-slate-300">🎯 Position</span>
                </div>
                <span className="text-[9px] text-slate-400">Loading...</span>
            </div>
        );
    }

    if (!pos) return null;

    const sideColor = (pos.side === 'long' ? 'green' : 'red') as BadgeColorScheme;
    const statusColor = (pos.status === 'open' ? 'blue' : 'gray') as BadgeColorScheme;
    const pnlColor = pos.net_pnl >= 0 ? 'text-green-300' : 'text-red-300';

    return (
        <div className="mt-2 border border-slate-600 bg-slate-800 p-2">
            {/* Header */}
            <div className="mb-2 flex items-center gap-1.5">
                <span className="text-[10px] font-bold text-slate-300">🎯 Position</span>
                <Badge colorScheme="purple" className="text-[9px]">{pos.coin}</Badge>
                <Badge colorScheme={sideColor} className="text-[9px]">
                    {pos.side.toUpperCase()}
                </Badge>
                <Badge colorScheme={statusColor} className="text-[9px]">
                    {pos.status}
                </Badge>
            </div>

            {/* Body */}
            <div className="flex flex-col gap-0.5 text-[9px]">
                <div className="flex justify-between">
                    <span className="text-slate-400">Entry Price</span>
                    <span className="text-slate-200">${pos.entry_price?.toFixed(2)}</span>
                </div>
                {pos.exit_price != null && (
                    <div className="flex justify-between">
                        <span className="text-slate-400">Exit Price</span>
                        <span className="text-slate-200">${pos.exit_price.toFixed(2)}</span>
                    </div>
                )}
                <div className="flex justify-between">
                    <span className="text-slate-400">Size</span>
                    <span className="text-slate-200">{pos.size} {pos.coin}</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-slate-400">Realized P&L</span>
                    <span className={`font-bold ${pnlColor}`}>
                        {pos.realized_pnl >= 0 ? '+' : ''}{pos.realized_pnl?.toFixed(2)} {pos.margin_currency}
                    </span>
                </div>
                <div className="flex justify-between">
                    <span className="text-slate-400">Fees</span>
                    <span className="text-slate-200">{pos.total_fees?.toFixed(2)} {pos.margin_currency}</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-slate-400">Net P&L</span>
                    <span className={`font-bold ${pnlColor}`}>
                        {pos.net_pnl >= 0 ? '+' : ''}{pos.net_pnl?.toFixed(2)} {pos.margin_currency}
                    </span>
                </div>
                {pos.duration_hours != null && (
                    <div className="flex justify-between">
                        <span className="text-slate-400">Duration</span>
                        <span className="text-slate-200">
                            {pos.duration_hours < 24
                                ? `${pos.duration_hours.toFixed(1)}h`
                                : `${(pos.duration_hours / 24).toFixed(1)}d`}
                        </span>
                    </div>
                )}
                {pos.return_pct != null && (
                    <div className="flex justify-between">
                        <span className="text-slate-400">Return</span>
                        <span className={pnlColor}>{pos.return_pct >= 0 ? '+' : ''}{pos.return_pct.toFixed(2)}%</span>
                    </div>
                )}
            </div>
        </div>
    );
};
