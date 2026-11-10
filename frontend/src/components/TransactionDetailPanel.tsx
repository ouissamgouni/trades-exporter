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
import { Badge, Button, Input, Textarea, Spinner } from './ui/primitives';
import { FiCopy, FiCheck, FiLoader, FiTag, FiX, FiChevronDown, FiChevronRight, FiAlertTriangle, FiArrowDown, FiArrowUp } from 'react-icons/fi';
import { Transaction, Account, Bundle, API_URL } from '../types';
import { UnitPattern, TaxabilityStatus, getReviewStatusLabel } from '../enums';
import { AssetBadge } from './AssetBadge';
import { formatDateTimeLocale } from '../utils/dateUtils';
import { ValueDisplay } from './ValueDisplay';
import { BundleMemberTransactionsTable } from './tables/wrappers/BundleMemberTransactionsTable';
import { toaster } from './ui/toaster';

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
}

const SECTION_COLORS: Record<string, { mainBg: string; mainHoverBg: string; subBg: string; subHoverBg: string; text: string }> = {
    blue: { mainBg: 'bg-blue-100', mainHoverBg: 'hover:bg-blue-200', subBg: 'bg-blue-50', subHoverBg: 'hover:bg-blue-100', text: 'text-blue-700' },
    purple: { mainBg: 'bg-purple-100', mainHoverBg: 'hover:bg-purple-200', subBg: 'bg-purple-50', subHoverBg: 'hover:bg-purple-100', text: 'text-purple-700' },
    green: { mainBg: 'bg-green-100', mainHoverBg: 'hover:bg-green-200', subBg: 'bg-green-50', subHoverBg: 'hover:bg-green-100', text: 'text-green-700' },
    orange: { mainBg: 'bg-orange-100', mainHoverBg: 'hover:bg-orange-200', subBg: 'bg-orange-50', subHoverBg: 'hover:bg-orange-100', text: 'text-orange-700' },
    gray: { mainBg: 'bg-slate-100', mainHoverBg: 'hover:bg-slate-200', subBg: 'bg-slate-50', subHoverBg: 'hover:bg-slate-100', text: 'text-slate-700' },
};

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
    const colors = SECTION_COLORS[colorScheme] ?? SECTION_COLORS.gray;

    return (
        <div className={isMain ? 'mb-2' : 'mb-1'}>
            <div
                className={`flex cursor-pointer items-center gap-1 px-2 ${isMain ? 'py-1.5' : 'py-1'} ${isMain ? colors.mainBg : colors.subBg} ${isMain ? colors.mainHoverBg : colors.subHoverBg}`}
                onClick={() => setIsOpen(!isOpen)}
            >
                {isOpen ? <FiChevronDown size={isMain ? 14 : 12} /> : <FiChevronRight size={isMain ? 14 : 12} />}
                <span
                    className={`font-bold ${isMain ? 'text-[11px] uppercase' : 'text-[10px]'} ${colors.text}`}
                >
                    {icon && `${icon} `}{title}
                </span>
            </div>
            {isOpen && (
                <div className={`py-1 ${isMain ? 'px-1 ml-0' : 'px-2 ml-2'}`}>
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
    // Display each key:value pair as a separate badge
    const entries = Object.entries(tag);

    return (
        <>
            {entries.map(([key, value], index) => (
                <Badge
                    key={index}
                    colorScheme="blue"
                    className="flex items-center gap-0.5 px-1 py-0.5 text-[9px]"
                >
                    <FiTag size={8} />
                    <span className="text-[9px]">{key === 'value' ? String(value) : `${key}: ${value}`}</span>
                    {editable && onRemove && index === entries.length - 1 && (
                        <button
                            type="button"
                            title="Remove tag"
                            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onRemove(); }}
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
    const [bundleData, setBundleData] = useState<Bundle | null>(null);
    const [bundleLoading, setBundleLoading] = useState(false);
    const [bundleError, setBundleError] = useState<string | null>(null);
    const [bundleTaxability, setBundleTaxability] = useState<string>(TaxabilityStatus.UNKNOWN);
    const [taxabilityLoading, setTaxabilityLoading] = useState(false);

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
            } finally {
                setBundleLoading(false);
            }
        };

        fetchBundle();
    }, [tx.user_calculation_unit_id]);

    // Update bundle taxability override via PATCH
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
        <div>
            {/* ============================================================ */}
            {/* OVERVIEW SECTION */}
            {/* ============================================================ */}
            <Section title="Overview" level="main" defaultOpen={true} colorScheme="blue">

                {/* Key Infos */}
                <Section title="Key Infos" icon="📊" defaultOpen={true} colorScheme="purple">
                    <InfoRow label="Date/Time" value={formatDateTimeLocale(tx.date_time)} />
                    <InfoRow label="Account" value={
                        <div>
                            <p className="font-mono text-[10px] font-medium">{getAccountName(tx.account_id ?? null)}</p>
                            {tx.source_account && (
                                <p className="mt-0.5 font-mono text-[8px] text-slate-500">
                                    {tx.source_account}
                                </p>
                            )}
                        </div>
                    } />
                    <InfoRow label="Source" value={tx.source || '-'} muted />
                    <InfoRow
                        label="Type"
                        value={
                            <div className="flex flex-wrap items-center gap-1">
                                {tx.source_transaction_type && (
                                    <Badge colorScheme="blue" className="text-[9px]">
                                        {tx.source_transaction_type}
                                    </Badge>
                                )}
                                {tx.source_transaction_type && tx.transaction_type && (
                                    <span className="text-[9px] text-slate-400">→</span>
                                )}
                                <Badge colorScheme="gray" className="text-[9px]">
                                    {tx.transaction_type || '-'}
                                </Badge>
                                {tx.direction && (
                                    <div className="ml-1 flex items-center gap-0.5">
                                        {tx.direction === 'inflow' ? (
                                            <FiArrowDown size={10} className="text-green-500" />
                                        ) : tx.direction === 'outflow' ? (
                                            <FiArrowUp size={10} className="text-red-500" />
                                        ) : null}
                                        <span className="text-[8px] text-slate-500">
                                            {tx.direction}
                                        </span>
                                    </div>
                                )}
                            </div>
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
                            <div className="flex items-center gap-1">
                                <span className="font-mono text-[10px]"><ValueDisplay value={tx.price} /></span>
                                <AssetBadge
                                    asset={tx.price_quote_asset}
                                    sourceSymbol={tx.source_price_quote_asset_symbol}
                                    size="xs"
                                    colorPalette="cyan"
                                    maxLength={12}
                                />
                            </div>
                        }
                    />
                    <InfoRow
                        label="Total"
                        value={
                            <div className="flex items-center gap-1">
                                <span className="font-mono text-[10px]">
                                    <ValueDisplay value={tx.total} />
                                </span>
                                <AssetBadge
                                    asset={tx.price_quote_asset}
                                    sourceSymbol={tx.source_price_quote_asset_symbol}
                                    size="xs"
                                    colorPalette="cyan"
                                    maxLength={12}
                                />
                            </div>
                        }
                    />
                    <InfoRow
                        label="Fee"
                        value={tx.fee ? (
                            <div className="flex items-center gap-1">
                                <span className="font-mono text-[10px]"><ValueDisplay value={tx.fee} /></span>
                                <AssetBadge
                                    asset={tx.fee_quote_asset}
                                    sourceSymbol={tx.source_fee_quote_asset_symbol}
                                    size="xs"
                                    colorPalette="orange"
                                    maxLength={12}
                                />
                            </div>
                        ) : '-'}
                    />
                    {tx.source_transaction_id && (
                        <InfoRow
                            label="Source Transaction ID"
                            value={
                                <span className="max-w-[200px] truncate font-mono text-[9px]" title={tx.source_transaction_id}>
                                    {tx.source_transaction_id}
                                </span>
                            }
                        />
                    )}
                    <InfoRow
                        label="Review"
                        value={
                            <Badge
                                colorScheme={tx.review_status === 'valid' ? 'green' : tx.review_status === 'invalid' ? 'red' : 'yellow'}
                                className="text-[9px]"
                            >
                                {getReviewStatusLabel(tx.review_status || '')}
                            </Badge>
                        }
                    />
                    {(tx.from_account_id || tx.source_from_account) && (
                        <InfoRow
                            label="From Account"
                            value={
                                <Badge colorScheme={tx.from_account_id ? "blue" : "orange"} className="text-[9px]">
                                    {tx.source_from_account && (
                                        <>
                                            Source: {tx.source_from_account}
                                            {tx.from_account_id && <span className="mx-1">→</span>}
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
                                <Badge colorScheme={tx.to_account_id ? "blue" : "orange"} className="text-[9px]">
                                    {tx.source_to_account && (
                                        <>
                                            Source: {tx.source_to_account}
                                            {tx.to_account_id && <span className="mx-1">→</span>}
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
                            <span className="max-w-[150px] truncate text-[9px]" title={tx.network_transaction_id}>
                                {tx.network_transaction_id}
                            </span>
                        ) : '-'
                    } />
                    {/* Bundle/Calculation Unit - link to full section */}
                    {tx.user_calculation_unit_id && bundleData && (
                        <InfoRow
                            label="Bundle"
                            value={
                                <Badge colorScheme="purple" className="text-[9px]">
                                    📦 #{bundleData.id} {bundleData.pattern ? `• ${bundleData.pattern}` : ''}
                                </Badge>
                            }
                        />
                    )}
                    {/* Spam/Phishing Detection Alert */}
                    {tx.review_status === 'invalid' && tx.review_notes && tx.review_notes.includes('Auto-flagged') && (
                        <div className="mt-2 border border-red-700 bg-red-950 p-2">
                            <div className="mb-1 flex items-center gap-1.5">
                                <span className="text-red-400"><FiAlertTriangle size={14} /></span>
                                <span className="text-[10px] font-bold text-red-300">
                                    Spam / Phishing Detection
                                </span>
                            </div>
                            <p className="whitespace-pre-wrap font-mono text-[9px] text-red-200">
                                {tx.review_notes}
                            </p>
                        </div>
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
                                colorScheme={tx.taxability_status === 'taxable' ? 'orange' : tx.taxability_status === 'non_taxable' ? 'green' : 'yellow'}
                                className="text-[9px]"
                            >
                                {(tx.taxability_status || 'unknown').toUpperCase()}
                            </Badge>
                        }
                    />
                </Section>

                {/* Tags */}
                <Section title="Tags" icon="🏷️" defaultOpen={false} colorScheme="blue">
                    <div className="mb-1 flex flex-wrap gap-1">
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
                            <span className="text-[9px] text-slate-400">No tags</span>
                        )}
                    </div>
                    {onTagsChange && (
                        <div className="mt-1 flex gap-1">
                            <Input
                                placeholder="Key"
                                value={newTagKey}
                                onChange={(e) => setNewTagKey(e.target.value)}
                                className="w-[50px] text-[9px]"
                            />
                            <Input
                                placeholder="Value"
                                value={newTagValue}
                                onChange={(e) => setNewTagValue(e.target.value)}
                                className="flex-1 text-[9px]"
                                onKeyDown={(e) => e.key === 'Enter' && addTag()}
                            />
                            <Button size="sm" onClick={addTag} disabled={!newTagValue.trim()} className="px-2">
                                +
                            </Button>
                        </div>
                    )}
                </Section>

                {/* Notes */}
                <Section title="Notes" icon="📝" defaultOpen={false} colorScheme="orange">
                    {isEditingNotes ? (
                        <div className="flex flex-col gap-1">
                            <Textarea
                                value={notesValue}
                                onChange={(e) => setNotesValue(e.target.value)}
                                placeholder="Add notes..."
                                rows={2}
                                className="text-[10px]"
                            />
                            <div className="flex justify-end gap-1">
                                <Button variant="ghost" onClick={() => {
                                    setNotesValue(tx.review_notes || '');
                                    setIsEditingNotes(false);
                                }} className="px-2 text-[9px]">
                                    Cancel
                                </Button>
                                <Button colorScheme="blue" onClick={saveNotes} className="px-2 text-[9px]">
                                    Save
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex items-start justify-between">
                            <p
                                className={`flex-1 whitespace-pre-wrap text-[10px] ${tx.review_notes ? 'text-slate-700' : 'text-slate-400'}`}
                            >
                                {tx.review_notes || 'No notes'}
                            </p>
                            {onNotesChange && (
                                <Button variant="ghost" onClick={() => setIsEditingNotes(true)} className="px-1 text-[9px]">
                                    Edit
                                </Button>
                            )}
                        </div>
                    )}
                </Section>
            </Section>

            {/* ============================================================ */}
            {/* BUNDLE SECTION (only if transaction belongs to a bundle) */}
            {/* ============================================================ */}
            {tx.user_calculation_unit_id && (
                <Section title="Bundle" level="main" defaultOpen={true} colorScheme="purple">
                    {bundleLoading ? (
                        <div className="flex items-center gap-2 py-2">
                            <Spinner size="xs" />
                            <span className="text-xs text-slate-500">Loading bundle...</span>
                        </div>
                    ) : bundleError ? (
                        <span className="text-xs text-red-500">{bundleError}</span>
                    ) : bundleData ? (
                        <div>
                            {/* Header: pattern badge + ID */}
                            <div className="mb-2 flex items-center justify-between">
                                <div className="flex items-center gap-1.5">
                                    <Badge
                                        colorScheme={
                                            bundleData.pattern === UnitPattern.INTERNAL_TRANSFER ? 'blue' :
                                                bundleData.pattern === UnitPattern.SWAP ? 'orange' :
                                                    bundleData.pattern === UnitPattern.SPLIT ? 'purple' :
                                                        bundleData.pattern === UnitPattern.FLOW ? 'blue' :
                                                            bundleData.pattern === UnitPattern.CUSTOM ? 'purple' : 'gray'
                                        }
                                    >
                                        {bundleData.pattern || 'unknown'}
                                    </Badge>
                                    {bundleData.label && (
                                        <span className="text-[10px] font-bold text-purple-800">
                                            {bundleData.label}
                                        </span>
                                    )}
                                </div>
                                <Badge colorScheme="purple">
                                    📦 #{bundleData.id}
                                </Badge>
                            </div>

                            {/* Notes */}
                            {bundleData.notes && (
                                <p className="mb-2 text-[9px] text-slate-600">
                                    {bundleData.notes}
                                </p>
                            )}

                            {/* Taxability Override */}
                            <div className="mb-2 flex items-center gap-2">
                                <span className="shrink-0 text-[10px] text-slate-500">
                                    Taxability:
                                </span>
                                <select
                                    title="Taxability"
                                    value={bundleTaxability}
                                    onChange={(e) => handleBundleTaxabilityChange(e.target.value)}
                                    disabled={taxabilityLoading}
                                    className="rounded-none border border-slate-200 px-1.5 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-50"
                                    style={{
                                        backgroundColor:
                                            bundleTaxability === TaxabilityStatus.TAXABLE
                                                ? '#FED7AA'
                                                : bundleTaxability === TaxabilityStatus.NON_TAXABLE
                                                    ? '#C6F6D5'
                                                    : '#FEFCBF',
                                    }}
                                >
                                    <option value={TaxabilityStatus.UNKNOWN}>Unknown</option>
                                    <option value={TaxabilityStatus.TAXABLE}>Taxable</option>
                                    <option value={TaxabilityStatus.NON_TAXABLE}>Non-Taxable</option>
                                </select>
                                {taxabilityLoading && <Spinner size="xs" />}
                            </div>

                            {/* Transaction count */}
                            <p className="mb-1 text-xs font-medium text-slate-500">
                                {bundleData.transaction_count} transaction
                                {bundleData.transaction_count !== 1 ? 's' : ''}
                            </p>

                            {/* Embedded transactions table */}
                            <BundleMemberTransactionsTable
                                transactionIds={bundleData.transactions.map(t => t.id)}
                            />
                        </div>
                    ) : (
                        <span className="text-xs text-slate-500">
                            Bundle #{tx.user_calculation_unit_id}
                        </span>
                    )}
                </Section>
            )}

            {/* ============================================================ */}
            {/* DETAILS SECTION */}
            {/* ============================================================ */}
            <Section title="Details" level="main" defaultOpen={false} colorScheme="gray">

                {/* Source Data - Raw Data Button */}
                <Section title="Source" icon="📤" defaultOpen={true} colorScheme="orange">
                    {!tx.raw_transaction_id ? (
                        <div className="bg-slate-50 p-2 text-center">
                            <span className="text-[9px] text-slate-500">
                                No raw transaction linked (manual entry)
                            </span>
                        </div>
                    ) : !hasFetchedRaw ? (
                        <Button
                            onClick={fetchRawData}
                            className="w-full text-[9px]"
                        >
                            Raw Data (Raw TX ID: {tx.raw_transaction_id})
                        </Button>
                    ) : rawDataLoading ? (
                        <div className="flex items-center justify-center gap-2 py-2">
                            <FiLoader className="animate-spin" size={12} />
                            <span className="text-[9px] text-slate-500">Loading...</span>
                        </div>
                    ) : rawDataError ? (
                        <div className="bg-red-50 p-2">
                            <p className="text-[9px] text-red-500">Error: {rawDataError}</p>
                            <Button
                                className="mt-1 text-[9px]"
                                onClick={() => {
                                    setHasFetchedRaw(false);
                                    setRawDataError(null);
                                }}
                            >
                                Retry
                            </Button>
                        </div>
                    ) : rawData ? (
                        <div>
                            <div className="mb-1 flex items-center justify-between">
                                <div className="flex items-center gap-1">
                                    <Badge colorScheme="gray" className="text-[8px]">{rawData.source}</Badge>
                                    <span className="text-[8px] text-slate-500">ID: {rawData.source_transaction_id}</span>
                                </div>
                                <Button
                                    variant="ghost"
                                    onClick={copyJson}
                                    className="px-1 text-[9px]"
                                >
                                    {copied ? <FiCheck size={10} /> : <FiCopy size={10} />}
                                </Button>
                            </div>
                            <div className="max-h-[200px] overflow-y-auto whitespace-pre-wrap break-all bg-slate-900 p-2 font-mono text-[8px] text-green-300">
                                {JSON.stringify(rawData.raw_data, null, 2)}
                            </div>
                            {/* Connector Metadata */}
                            {tx.connector_name && (
                                <div className="mt-2 border-t border-slate-200 pt-2">
                                    <InfoRow
                                        label="Connector"
                                        value={
                                            <Badge colorScheme="blue" className="text-[8px]">
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
                                </div>
                            )}
                            {/* Raw Transaction Ingestion Time */}
                            {rawData?.ingestion_time && (
                                <InfoRow label="Ingestion Time" value={formatDateTimeLocale(rawData.ingestion_time)} muted />
                            )}
                        </div>
                    ) : null}
                </Section>

                {/* Source Mappings */}
                <Section title="Source-Mappings" icon="🔗" defaultOpen={true} colorScheme="blue">
                    <p className="mb-1 text-[9px] text-slate-500">Source value → Resolved ID</p>

                    <InfoRow
                        label="Account"
                        value={
                            tx.account_id ? (
                                <div className="flex items-center gap-1">
                                    <span className="max-w-[60px] truncate text-[9px] text-slate-500">{tx.source_account || '-'}</span>
                                    <span className="text-[9px]">→</span>
                                    <Badge colorScheme="blue" className="text-[8px]">
                                        #{tx.account_id} {getAccountName(tx.account_id)}
                                    </Badge>
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
                                    <AssetBadge
                                        asset={tx.linked_asset}
                                        size="xs"
                                        colorPalette="purple"
                                        maxLength={15}
                                    />
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
                                    <AssetBadge
                                        asset={tx.price_quote_asset}
                                        size="xs"
                                        colorPalette="green"
                                        maxLength={15}
                                    />
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
                                    <AssetBadge
                                        asset={tx.fee_quote_asset}
                                        size="xs"
                                        colorPalette="green"
                                        maxLength={15}
                                    />
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
                                    <Badge colorScheme="blue" className="text-[8px]" title={`Source: ${tx.source_from_account || '-'}`}>
                                        #{tx.from_account_id} {getAccountName(tx.from_account_id)}
                                    </Badge>
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
                                    <Badge colorScheme="blue" className="text-[8px]" title={`Source: ${tx.source_to_account || '-'}`}>
                                        #{tx.to_account_id} {getAccountName(tx.to_account_id)}
                                    </Badge>
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


            </Section>
        </div>
    );
};

export default TransactionDetailPanel;
