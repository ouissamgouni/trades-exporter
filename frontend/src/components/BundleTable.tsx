/**
 * BundleTable - Compact table view for bundles with expandable rows
 * 
 * Features:
 * - Dense table layout with expandable row details
 * - Filter bar (pattern, asset, date range, taxability)
 * - Inline editing for label, taxability, notes
 * - Bulk selection and delete
 * - Transaction IDs shown as hoverable badges in Trx cell
 * - Expanded row shows full transaction table (like P&L calculation units)
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Badge, Button, Input } from './ui/primitives';
import { Tooltip } from './ui/tooltip';
import { toaster } from './ui/toaster';
import { ConfirmDialog, useConfirmDialog } from './ui/ConfirmDialog';
import { FiChevronDown, FiChevronRight, FiChevronLeft, FiChevronsLeft, FiChevronsRight, FiTrash2, FiX, FiCheck, FiFilter, FiSearch, FiLoader, FiFileText, FiRepeat, FiArrowRight, FiGitBranch, FiTrendingUp, FiShare2, FiTool, FiHelpCircle, FiDollarSign, FiShield } from 'react-icons/fi';
import { Bundle, TransactionSummary, TaxabilityStatus, API_URL, AssetRef } from '../types';
import { UnitPattern, TaxabilityStatus as TaxabilityEnum } from '../enums';
import { TransactionTooltip } from './TransactionTooltip';
import { AssetBadge } from './AssetBadge';
import { formatDateTimeCompact, parseApiDate } from '../utils/dateUtils';
import { formatQuantity } from '../utils/numberUtils';
import { ValueDisplay } from './ValueDisplay';
import { BundleMemberTransactionsTable } from './tables/wrappers/BundleMemberTransactionsTable';
import { BundleCompletionSuggestion } from './bundles/BundleCompletionSuggestion';
import { useAssets } from '../hooks/useAssets';

// ============================================================================
// Types
// ============================================================================

interface BundleTableProps {
    bundles: Bundle[];
    baseCurrency?: string;
    onBundleUpdate?: (bundleId: number, updates: Partial<Bundle>) => Promise<void>;
    onBundleDelete?: (bundleId: number) => Promise<void>;
    onRemoveTransaction?: (bundleId: number, transactionId: number) => Promise<void>;
    onRefresh?: () => void;
    onTransactionClick?: (txId: number) => void;
}

interface BundleFilters {
    search: string;
    pattern: string;
    taxability: string;
}

// ============================================================================
// Types
// ============================================================================

// Full transaction detail for expanded view
interface TransactionDetail {
    transaction_id: number;
    date_time?: string;
    account_id?: number;
    account_name?: string;
    source?: string;
    source_transaction_type?: string;
    transaction_type?: string;
    direction?: string;
    from_account_id?: number;
    from_account_name?: string;
    to_account_id?: number;
    to_account_name?: string;
    source_from_account?: string;
    source_to_account?: string;
    // Nested asset references (preferred)
    linked_asset?: AssetRef | null;
    price_quote_asset?: AssetRef | null;
    fee_quote_asset?: AssetRef | null;
    // Legacy flat fields for fallback
    asset_id?: number;
    asset_symbol?: string;
    quantity?: number;
    price?: number;
    price_quote_asset_id?: number;
    price_quote_asset_symbol?: string;
    total?: number;
    fee?: number;
    fee_quote_asset_id?: number;
    fee_quote_asset_symbol?: string;
    // Source symbols for unlinked fallback
    source_asset_symbol?: string;
    source_price_quote_asset_symbol?: string;
    source_fee_quote_asset_symbol?: string;
}

// ============================================================================
// Helpers
// ============================================================================



const getUniqueAssets = (transactions: TransactionSummary[]): AssetRef[] => {
    if (!transactions) return [];
    const assetMap = new Map<string, AssetRef>();
    transactions.forEach(t => {
        if (t.asset && t.asset.symbol) {
            assetMap.set(t.asset.symbol, t.asset);
        }
    });
    return Array.from(assetMap.values());
};

// ============================================================================
// Filter Bar Component
// ============================================================================

interface FilterBarProps {
    filters: BundleFilters;
    onFiltersChange: (filters: BundleFilters) => void;
    bundleCount: number;
    filteredCount: number;
    onRefresh?: () => void;
}

const FilterBar: React.FC<FilterBarProps> = ({ filters, onFiltersChange, bundleCount, filteredCount, onRefresh }) => {
    const [showFilters, setShowFilters] = useState(false);

    const hasActiveFilters = filters.search || filters.pattern || filters.taxability;

    return (
        <div className="mb-3">
            <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-bold">
                        📦 Bundles ({filteredCount}{filteredCount !== bundleCount && ` / ${bundleCount}`})
                    </span>
                </div>
                <div className="flex gap-2">
                    <Tooltip content="To create a bundle, select transactions in the Transactions tab and use the Bundle action" openDelay={100}>
                        <Button size="sm" variant="outline" colorScheme="gray" className="border-purple-300 text-purple-700 hover:bg-purple-50" disabled>
                            ➕ Create
                        </Button>
                    </Tooltip>
                    {onRefresh && (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={onRefresh}
                        >
                            🔄 Refresh
                        </Button>
                    )}
                    <Button
                        size="sm"
                        variant={showFilters ? 'solid' : 'outline'}
                        colorScheme={hasActiveFilters ? 'blue' : 'gray'}
                        onClick={() => setShowFilters(!showFilters)}
                    >
                        <FiFilter size={12} />
                        <span className="ml-1">Filter</span>
                        {hasActiveFilters && <Badge colorScheme="blue" className="ml-1">●</Badge>}
                    </Button>
                    {hasActiveFilters && (
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onFiltersChange({ search: '', pattern: '', taxability: '' })}
                        >
                            <FiX size={12} />
                            <span className="ml-1">Clear</span>
                        </Button>
                    )}
                </div>
            </div>

            {showFilters && (
                <div className="flex flex-wrap items-center gap-3 bg-slate-50 p-2">
                    <div className="flex items-center gap-1">
                        <FiSearch size={12} color="gray" />
                        <Input
                            placeholder="Search label..."
                            value={filters.search}
                            onChange={e => onFiltersChange({ ...filters, search: e.target.value })}
                            className="w-[140px]"
                        />
                    </div>
                    <div className="flex items-center gap-1">
                        <span className="text-xs text-slate-600">Pattern:</span>
                        <select
                            title="Pattern"
                            value={filters.pattern}
                            onChange={e => onFiltersChange({ ...filters, pattern: e.target.value })}
                            className="w-[100px] rounded-none border border-slate-200 px-1 py-0.5 text-[11px]"
                        >
                            <option value="">All</option>
                            <option value={UnitPattern.INTERNAL_TRANSFER}>Transfer</option>
                            <option value={UnitPattern.SWAP}>Swap</option>
                            <option value={UnitPattern.SPLIT}>Split</option>
                            <option value={UnitPattern.SPINOFF}>Spin-Off</option>
                            <option value={UnitPattern.UNKNOWN}>Unknown</option>
                        </select>
                    </div>
                    <div className="flex items-center gap-1">
                        <span className="text-xs text-slate-600">Tax:</span>
                        <select
                            title="Taxability"
                            value={filters.taxability}
                            onChange={e => onFiltersChange({ ...filters, taxability: e.target.value })}
                            className="w-[100px] rounded-none border border-slate-200 px-1 py-0.5 text-[11px]"
                        >
                            <option value="">All</option>
                            <option value={TaxabilityEnum.TAXABLE}>Taxable</option>
                            <option value={TaxabilityEnum.NON_TAXABLE}>Non-Taxable</option>
                            <option value={TaxabilityEnum.UNKNOWN}>Unknown</option>
                        </select>
                    </div>
                </div>
            )}
        </div>
    );
};

// ============================================================================
// Transaction Badges - Compact inline display for Trx cell
// ============================================================================

interface TransactionBadgesProps {
    transactions: TransactionSummary[];
    baseCurrency: string;
    maxVisible?: number;
    onTransactionClick?: (txId: number) => void;
}

const TransactionBadges: React.FC<TransactionBadgesProps> = ({
    transactions,
    baseCurrency,
    maxVisible = 3,
    onTransactionClick,
}) => {
    if (!transactions || transactions.length === 0) {
        return <span className="text-xs text-slate-400">-</span>;
    }

    const visibleTxs = transactions.slice(0, maxVisible);
    const hiddenCount = transactions.length - maxVisible;

    return (
        <div className="flex flex-wrap items-center gap-1">
            {visibleTxs.map(tx => (
                <TransactionTooltip key={tx.id} txId={tx.id} baseCurrency={baseCurrency} onTransactionClick={onTransactionClick}>
                    <Badge colorScheme="gray" className="cursor-pointer text-[9px]">
                        #{tx.id}
                    </Badge>
                </TransactionTooltip>
            ))}
            {hiddenCount > 0 && (
                <span className="text-xs text-slate-500">+{hiddenCount}</span>
            )}
        </div>
    );
};

// ============================================================================
// Expanded Transaction Table - Full details like P&L calculation unit
// ============================================================================

interface ExpandedTransactionTableProps {
    transactions: TransactionSummary[];
    bundleId: number;
    baseCurrency: string;
    onRemoveTransaction?: (bundleId: number, transactionId: number) => Promise<void>;
    onTransactionClick?: (txId: number) => void;
}

const ExpandedTransactionTable: React.FC<ExpandedTransactionTableProps> = ({
    transactions,
    bundleId,
    baseCurrency,
    onRemoveTransaction,
    onTransactionClick,
}) => {
    const [txDetails, setTxDetails] = useState<TransactionDetail[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [removingId, setRemovingId] = useState<number | null>(null);

    // Fetch full transaction details on mount
    useEffect(() => {
        const fetchDetails = async () => {
            if (!transactions || transactions.length === 0) return;
            setLoading(true);
            setError(null);
            try {
                const responses = await Promise.all(
                    transactions.map(tx => fetch(`${API_URL}/transactions/${tx.id}`))
                );
                const details: TransactionDetail[] = [];
                for (const response of responses) {
                    if (!response.ok) continue;
                    const data = await response.json();
                    details.push({
                        transaction_id: data.id,
                        date_time: data.date_time,
                        account_id: data.account_id,
                        account_name: data.account_name || '-',
                        source: data.source,
                        source_transaction_type: data.source_transaction_type,
                        transaction_type: data.transaction_type,
                        direction: data.direction,
                        from_account_id: data.from_account_id,
                        from_account_name: data.from_account_name,
                        to_account_id: data.to_account_id,
                        to_account_name: data.to_account_name,
                        source_from_account: data.source_from_account,
                        source_to_account: data.source_to_account,
                        // Nested asset refs
                        linked_asset: data.linked_asset,
                        price_quote_asset: data.price_quote_asset,
                        fee_quote_asset: data.fee_quote_asset,
                        // Legacy flat fields
                        asset_id: data.asset_id,
                        asset_symbol: data.linked_asset_symbol || data.source_asset_symbol,
                        quantity: data.quantity,
                        price: data.price,
                        price_quote_asset_id: data.price_quote_asset_id,
                        price_quote_asset_symbol: data.linked_price_quote_asset_symbol || data.source_price_quote_asset_symbol,
                        total: data.total,
                        fee: data.fee,
                        fee_quote_asset_id: data.fee_quote_asset_id,
                        fee_quote_asset_symbol: data.linked_fee_quote_asset_symbol || data.source_fee_quote_asset_symbol,
                        // Source symbols for fallback
                        source_asset_symbol: data.source_asset_symbol,
                        source_price_quote_asset_symbol: data.source_price_quote_asset_symbol,
                        source_fee_quote_asset_symbol: data.source_fee_quote_asset_symbol,
                    });
                }
                setTxDetails(details);
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Error loading transactions');
            } finally {
                setLoading(false);
            }
        };
        fetchDetails();
    }, [transactions]);

    const handleRemove = async (txId: number) => {
        if (!onRemoveTransaction) return;
        setRemovingId(txId);
        try {
            await onRemoveTransaction(bundleId, txId);
        } finally {
            setRemovingId(null);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2 py-3">
                <FiLoader className="animate-spin" />
                <span className="text-xs text-slate-500">Loading transaction details...</span>
            </div>
        );
    }

    if (error) {
        return <span className="text-xs text-red-500">Error: {error}</span>;
    }

    if (txDetails.length === 0) {
        return <span className="text-xs italic text-slate-500">No transactions</span>;
    }

    return (
        <div className="border border-slate-200 bg-white">
            <div className="p-3">
                <p className="mb-2 text-xs font-bold text-slate-600">
                    📄 Transactions ({txDetails.length})
                </p>
                <table className="w-full text-left">
                    <thead>
                        <tr>
                            <th className="w-[50px] text-[10px] font-medium text-slate-500">TX ID</th>
                            <th className="w-[50px] text-[10px] font-medium text-slate-500">Dir</th>
                            <th className="w-[60px] text-[10px] font-medium text-slate-500">Asset</th>
                            <th className="w-[80px] text-right text-[10px] font-medium text-slate-500">Qty</th>
                            <th className="w-[70px] text-right text-[10px] font-medium text-slate-500">Price</th>
                            <th className="w-[70px] text-right text-[10px] font-medium text-slate-500">Total</th>
                            <th className="w-[60px] text-right text-[10px] font-medium text-slate-500">Fee</th>
                            <th className="w-[70px] text-[10px] font-medium text-slate-500">Account</th>
                            <th className="w-[60px] text-[10px] font-medium text-slate-500">Type</th>
                            <th className="w-[70px] text-[10px] font-medium text-slate-500">From/To</th>
                            {onRemoveTransaction && (
                                <th className="w-[40px]"></th>
                            )}
                        </tr>
                    </thead>
                    <tbody>
                        {txDetails.map((tx) => {
                            const txType = tx.transaction_type || tx.source_transaction_type || '-';
                            const fromAccount = tx.from_account_name || tx.source_from_account;
                            const toAccount = tx.to_account_name || tx.source_to_account;
                            const fromToAccount = tx.direction === 'inflow' ? fromAccount : toAccount;
                            // Build source tooltip: show source address when linked account name is displayed
                            const fromToSource = tx.direction === 'inflow'
                                ? (tx.from_account_name && tx.source_from_account && tx.source_from_account !== tx.from_account_name ? `Source: ${tx.source_from_account}` : undefined)
                                : (tx.to_account_name && tx.source_to_account && tx.source_to_account !== tx.to_account_name ? `Source: ${tx.source_to_account}` : undefined);

                            return (
                                <tr key={tx.transaction_id}>
                                    <td className="py-1">
                                        <TransactionTooltip txId={tx.transaction_id} baseCurrency={baseCurrency} onTransactionClick={onTransactionClick}>
                                            <Badge colorScheme="gray" className="cursor-pointer">
                                                #{tx.transaction_id}
                                            </Badge>
                                        </TransactionTooltip>
                                    </td>
                                    <td className="py-1">
                                        <Badge
                                            colorScheme={tx.direction === 'inflow' ? 'green' : tx.direction === 'outflow' ? 'red' : 'gray'}
                                        >
                                            {tx.direction === 'inflow' ? '↓' : tx.direction === 'outflow' ? '↑' : '↔'}
                                        </Badge>
                                    </td>
                                    <td className="py-1">
                                        <AssetBadge
                                            asset={tx.linked_asset}
                                            sourceSymbol={tx.source_asset_symbol || tx.asset_symbol}
                                            size="xs"
                                            maxLength={15}
                                        />
                                    </td>
                                    <td className="py-1 text-right font-mono text-[10px]">
                                        <ValueDisplay value={tx.quantity} />
                                    </td>
                                    <td className="py-1 text-right text-[10px]">
                                        {tx.price ? <ValueDisplay value={tx.price} currency={baseCurrency} /> : '-'}
                                    </td>
                                    <td className="py-1 text-right text-[10px]">
                                        {tx.total ? <ValueDisplay value={tx.total} currency={baseCurrency} /> : '-'}
                                    </td>
                                    <td className="py-1 text-right text-[10px]">
                                        {tx.fee ? (
                                            <div className="flex items-center justify-end gap-1">
                                                <span className="text-orange-600">
                                                    <ValueDisplay value={tx.fee} />
                                                </span>
                                                <AssetBadge
                                                    asset={tx.fee_quote_asset}
                                                    sourceSymbol={tx.source_fee_quote_asset_symbol || tx.fee_quote_asset_symbol}
                                                    size="xs"
                                                    colorPalette="orange"
                                                    maxLength={10}
                                                />
                                            </div>
                                        ) : '-'}
                                    </td>
                                    <td className="py-1 text-[10px]">{tx.account_name || '-'}</td>
                                    <td className="py-1 text-[10px]">
                                        <Badge colorScheme={txType === 'transfer' ? 'blue' : 'gray'}>
                                            {txType}
                                        </Badge>
                                    </td>
                                    <td className="py-1 text-[10px] text-slate-600" title={fromToSource}>
                                        {fromToAccount || '-'}
                                    </td>
                                    {onRemoveTransaction && (
                                        <td className="py-1">
                                            <Button
                                                variant="ghost"
                                                colorScheme="red"
                                                className="h-5 min-w-[20px] p-0"
                                                onClick={() => handleRemove(tx.transaction_id)}
                                                loading={removingId === tx.transaction_id}
                                                title="Remove from bundle"
                                            >
                                                <FiX size={10} />
                                            </Button>
                                        </td>
                                    )}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

// ============================================================================
// Inline Edit Components
// ============================================================================

interface InlineEditLabelProps {
    value: string;
    onSave: (value: string) => Promise<void>;
    placeholder?: string;
}

const InlineEditLabel: React.FC<InlineEditLabelProps> = ({ value, onSave, placeholder = 'Bundle label...' }) => {
    const [editing, setEditing] = useState(false);
    const [editValue, setEditValue] = useState(value);
    const [saving, setSaving] = useState(false);

    const handleSave = async () => {
        if (editValue === value) {
            setEditing(false);
            return;
        }
        setSaving(true);
        try {
            await onSave(editValue);
            setEditing(false);
        } finally {
            setSaving(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleSave();
        } else if (e.key === 'Escape') {
            setEditValue(value);
            setEditing(false);
        }
    };

    if (editing) {
        return (
            <div className="flex items-center gap-1">
                <Input
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onBlur={handleSave}
                    autoFocus
                    className="w-[140px] text-[11px]"
                />
                <Button variant="ghost" colorScheme="green" onClick={handleSave} loading={saving} className="h-5 min-w-[20px] p-1">
                    <FiCheck size={10} />
                </Button>
                <Button variant="ghost" onClick={() => { setEditValue(value); setEditing(false); }} className="h-5 min-w-[20px] p-1">
                    <FiX size={10} />
                </Button>
            </div>
        );
    }

    return (
        <span
            className="cursor-pointer text-[11px] font-medium hover:text-blue-600 hover:underline"
            onClick={() => setEditing(true)}
            title="Click to edit"
        >
            {value || <span className="italic text-slate-400">{placeholder}</span>}
        </span>
    );
};

// ============================================================================
// Bundle Row Component
// ============================================================================

interface BundleRowProps {
    bundle: Bundle;
    baseCurrency: string;
    isExpanded: boolean;
    isSelected: boolean;
    onToggleExpand: () => void;
    onToggleSelect: () => void;
    onUpdate: (updates: Partial<Bundle>) => Promise<void>;
    onDelete: () => Promise<void>;
    onRemoveTransaction?: (bundleId: number, transactionId: number) => Promise<void>;
    onTransactionClick?: (txId: number) => void;
}

const BundleRow: React.FC<BundleRowProps> = ({
    bundle,
    baseCurrency,
    isExpanded,
    isSelected,
    onToggleExpand,
    onToggleSelect,
    onUpdate,
    onDelete,
    onRemoveTransaction,
    onTransactionClick,
}) => {
    const [deleting, setDeleting] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    const assets = getUniqueAssets(bundle.transactions);
    const { assets: allAssets } = useAssets();

    // Resolve spinoff parent asset from metadata
    const isSpinoff = bundle.pattern === UnitPattern.SPINOFF;
    const spinoffSourceAssetId = bundle.metadata?.spinoff_source_asset_id;
    const spinoffSourceAsset = isSpinoff && spinoffSourceAssetId
        ? allAssets.find(a => a.asset_id === spinoffSourceAssetId)
        : null;
    const spinoffAccountName = isSpinoff && bundle.transactions?.length
        ? bundle.transactions[0].account_name
        : null;

    const openDeleteConfirm = () => setShowDeleteConfirm(true);

    const handleDelete = async () => {
        setDeleting(true);
        try {
            await onDelete();
        } finally {
            setDeleting(false);
            setShowDeleteConfirm(false);
        }
    };

    const handleTaxabilityChange = async (newValue: string) => {
        await onUpdate({ taxability_override: newValue as TaxabilityStatus });
    };

    const handlePatternChange = async (newValue: string) => {
        await onUpdate({ pattern: newValue as UnitPattern });
    };

    // Compute a compact date range using short datetime format
    const txDates = (bundle.transactions || []).map(t => t.date_time).filter(Boolean);
    const compactDateRange = useMemo(() => {
        if (txDates.length === 0) return '-';
        const timestamps = txDates.map(d => parseApiDate(d)?.getTime()).filter((t): t is number => t != null && !isNaN(t));
        if (timestamps.length === 0) return '-';
        const minStr = formatDateTimeCompact(new Date(Math.min(...timestamps)));
        const maxStr = formatDateTimeCompact(new Date(Math.max(...timestamps)));
        return minStr === maxStr ? minStr : `${minStr} – ${maxStr}`;
    }, [txDates]);

    return (
        <>
            <div
                className={`border p-3 shadow-sm transition-colors hover:shadow-md ${isSelected ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-white'} ${isExpanded ? 'border-purple-300 hover:border-purple-400' : 'hover:border-blue-200'}`}
            >
                {/* Top row: checkbox + pattern icon + taxability icon + delete */}
                <div className="mb-1 flex items-center gap-1.5">
                    <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={onToggleSelect}
                        title="Select bundle"
                        className="h-4 w-4 cursor-pointer accent-blue-500"
                    />
                    <Tooltip content={{
                        [UnitPattern.SWAP]: 'Swap',
                        [UnitPattern.INTERNAL_TRANSFER]: 'Transfer',
                        [UnitPattern.SPLIT]: 'Split',
                        [UnitPattern.FLOW]: 'Flow',
                        [UnitPattern.SPINOFF]: 'Spin-Off',
                        [UnitPattern.UNMATCHED_INTERNAL_TRANSFER]: 'Unmatched Transfer',
                        [UnitPattern.CUSTOM]: 'Custom',
                        [UnitPattern.UNKNOWN]: 'Unknown',
                    }[bundle.pattern || UnitPattern.UNKNOWN] || 'Unknown'} openDelay={200}>
                        <span className="relative inline-flex">
                            <span
                                className="pointer-events-none flex h-[22px] w-[22px] items-center justify-center text-slate-700"
                                style={{
                                    backgroundColor: {
                                        [UnitPattern.INTERNAL_TRANSFER]: '#BEE3F8',
                                        [UnitPattern.SWAP]: '#FEEBC8',
                                        [UnitPattern.SPLIT]: '#E9D8FD',
                                        [UnitPattern.FLOW]: '#C6F6D5',
                                        [UnitPattern.SPINOFF]: '#FED7E2',
                                        [UnitPattern.UNMATCHED_INTERNAL_TRANSFER]: '#FEFCBF',
                                        [UnitPattern.CUSTOM]: '#E2E8F0',
                                        [UnitPattern.UNKNOWN]: '#EDF2F7',
                                    }[bundle.pattern || UnitPattern.UNKNOWN] || '#EDF2F7',
                                }}
                            >
                                {{
                                    [UnitPattern.SWAP]: <FiRepeat size={11} />,
                                    [UnitPattern.INTERNAL_TRANSFER]: <FiArrowRight size={11} />,
                                    [UnitPattern.SPLIT]: <FiGitBranch size={11} />,
                                    [UnitPattern.FLOW]: <FiTrendingUp size={11} />,
                                    [UnitPattern.SPINOFF]: <FiShare2 size={11} />,
                                    [UnitPattern.UNMATCHED_INTERNAL_TRANSFER]: <FiArrowRight size={11} />,
                                    [UnitPattern.CUSTOM]: <FiTool size={11} />,
                                    [UnitPattern.UNKNOWN]: <FiHelpCircle size={11} />,
                                }[bundle.pattern || UnitPattern.UNKNOWN] || <FiHelpCircle size={11} />}
                            </span>
                            <select
                                title="Pattern"
                                className="absolute inset-0 cursor-pointer opacity-0"
                                value={bundle.pattern || UnitPattern.UNKNOWN}
                                onChange={(e) => handlePatternChange(e.target.value)}
                            >
                                <option value={UnitPattern.SWAP}>Swap</option>
                                <option value={UnitPattern.INTERNAL_TRANSFER}>Transfer</option>
                                <option value={UnitPattern.SPLIT}>Split</option>
                                <option value={UnitPattern.FLOW}>Flow</option>
                                <option value={UnitPattern.SPINOFF}>Spin-Off</option>
                                <option value={UnitPattern.CUSTOM}>Custom</option>
                                <option value={UnitPattern.UNKNOWN}>Unknown</option>
                            </select>
                        </span>
                    </Tooltip>
                    <Tooltip content={{
                        [TaxabilityEnum.TAXABLE]: 'Taxable',
                        [TaxabilityEnum.NON_TAXABLE]: 'Non-Taxable',
                        [TaxabilityEnum.UNKNOWN]: 'Taxability Unknown',
                    }[bundle.taxability_override || TaxabilityEnum.UNKNOWN] || 'Taxability Unknown'} openDelay={200}>
                        <span className="relative inline-flex">
                            <span
                                className="pointer-events-none flex h-[22px] w-[22px] items-center justify-center text-slate-700"
                                style={{
                                    backgroundColor: bundle.taxability_override === TaxabilityEnum.TAXABLE ? '#FED7AA' :
                                        bundle.taxability_override === TaxabilityEnum.NON_TAXABLE ? '#C6F6D5' : '#FEFCBF',
                                }}
                            >
                                {bundle.taxability_override === TaxabilityEnum.TAXABLE ? <FiDollarSign size={11} /> :
                                    bundle.taxability_override === TaxabilityEnum.NON_TAXABLE ? <FiShield size={11} /> :
                                        <FiHelpCircle size={11} />}
                            </span>
                            <select
                                title="Taxability"
                                className="absolute inset-0 cursor-pointer opacity-0"
                                value={bundle.taxability_override || TaxabilityEnum.UNKNOWN}
                                onChange={(e) => handleTaxabilityChange(e.target.value)}
                            >
                                <option value={TaxabilityEnum.UNKNOWN}>Unknown</option>
                                <option value={TaxabilityEnum.TAXABLE}>Taxable</option>
                                <option value={TaxabilityEnum.NON_TAXABLE}>Non-Taxable</option>
                            </select>
                        </span>
                    </Tooltip>
                    <div className="flex-1" />
                    <Button
                        variant="ghost"
                        colorScheme="red"
                        onClick={openDeleteConfirm}
                        loading={deleting}
                        title="Delete bundle"
                        className="h-5 min-w-[20px] p-1"
                    >
                        <FiTrash2 size={11} />
                    </Button>
                </div>

                {/* Bundle name on its own line */}
                <div className="mb-1.5">
                    <InlineEditLabel
                        value={bundle.label || ''}
                        onSave={async (value) => onUpdate({ label: value })}
                        placeholder={`Bundle #${bundle.id}`}
                    />
                </div>

                {/* Assets + date + notes icon row */}
                <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-600">
                    <div className="flex flex-wrap items-center gap-1">
                        {assets.slice(0, 4).map((asset, idx) => (
                            <AssetBadge
                                key={asset.symbol || idx}
                                asset={asset}
                                size="xs"
                                colorPalette="purple"
                                maxLength={12}
                            />
                        ))}
                        {assets.length > 4 && (
                            <span className="text-[10px] text-slate-500">+{assets.length - 4}</span>
                        )}
                    </div>
                    <span className="text-[10px] text-slate-500">{compactDateRange}</span>
                    <Tooltip content={bundle.notes || 'No notes'} openDelay={200}>
                        <span
                            className={`cursor-pointer ${bundle.notes ? 'text-purple-500 hover:text-purple-600' : 'text-slate-300 hover:text-purple-600'}`}
                        >
                            <FiFileText size={12} />
                        </span>
                    </Tooltip>
                </div>

                {/* Spinoff source info row */}
                {isSpinoff && (spinoffSourceAsset || spinoffAccountName) && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
                        {spinoffSourceAsset && (
                            <div className="flex items-center gap-1">
                                <span className="text-[10px] text-slate-400">Parent:</span>
                                <AssetBadge
                                    asset={{ id: spinoffSourceAsset.asset_id!, symbol: spinoffSourceAsset.symbol || '?', label: spinoffSourceAsset.label }}
                                    size="xs"
                                    colorPalette="pink"
                                    maxLength={12}
                                />
                            </div>
                        )}
                        {spinoffAccountName && (
                            <Badge colorScheme="gray" className="border border-slate-300 bg-transparent text-slate-600">
                                {spinoffAccountName}
                            </Badge>
                        )}
                        {bundle.metadata?.spinoff_allocation_pct != null && (
                            <span className="text-[10px] text-slate-400">
                                {(bundle.metadata.spinoff_allocation_pct * 100).toFixed(0)}% alloc
                            </span>
                        )}
                    </div>
                )}

                {/* Collapsible transaction list */}
                <div
                    className="mt-1.5 cursor-pointer border-t border-slate-100 pt-1 text-center hover:text-purple-600"
                    onClick={onToggleExpand}
                >
                    <div className="flex items-center justify-center gap-1">
                        {isExpanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                        <span className="text-xs text-slate-500">
                            {bundle.transactions?.length || 0} transaction{(bundle.transactions?.length || 0) !== 1 ? 's' : ''}
                        </span>
                    </div>
                </div>

                {isExpanded && (
                    <div className="mt-1.5">
                        <BundleMemberTransactionsTable
                            transactionIds={(bundle.transactions || []).map(t => t.id)}
                            onTransactionClick={onTransactionClick}
                        />
                    </div>
                )}
                <BundleCompletionSuggestion
                    bundleId={bundle.id}
                    memberIds={(bundle.transactions || []).map(t => t.id)}
                    onTransactionClick={onTransactionClick}
                    className="mt-1.5"
                />
            </div>

            {/* Delete Confirmation Dialog */}
            <ConfirmDialog
                isOpen={showDeleteConfirm}
                onClose={() => setShowDeleteConfirm(false)}
                onConfirm={handleDelete}
                title="Delete Bundle"
                message={`Delete bundle "${bundle.label || `#${bundle.id}`}"?`}
                confirmLabel="Delete"
                isDestructive
                isLoading={deleting}
            />
        </>
    );
};

// ============================================================================
// Bulk Actions Bar
// ============================================================================

interface BulkActionsBarProps {
    selectedCount: number;
    onDelete: () => void;
    onClearSelection: () => void;
    loading?: boolean;
}

const BulkActionsBar: React.FC<BulkActionsBarProps> = ({ selectedCount, onDelete, onClearSelection, loading }) => {
    if (selectedCount === 0) return null;

    return (
        <div className="mb-3 border border-blue-200 bg-blue-50 p-2">
            <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-blue-700">
                    {selectedCount} bundle{selectedCount !== 1 ? 's' : ''} selected
                </span>
                <div className="flex gap-2">
                    <Button
                        colorScheme="red"
                        variant="outline"
                        onClick={onDelete}
                        loading={loading}
                    >
                        <FiTrash2 size={12} />
                        <span className="ml-1">Delete Selected</span>
                    </Button>
                    <Button variant="ghost" onClick={onClearSelection}>
                        <FiX size={12} />
                        <span className="ml-1">Clear</span>
                    </Button>
                </div>
            </div>
        </div>
    );
};

// ============================================================================
// Pagination Bar (reusable top + bottom)
// ============================================================================

interface PaginationBarProps {
    page: number;
    setPage: React.Dispatch<React.SetStateAction<number>>;
    pageSize: number;
    setPageSize: React.Dispatch<React.SetStateAction<number>>;
    pageSizeOptions: number[];
    totalItems: number;
    totalPages: number;
    rangeStart: number;
    rangeEnd: number;
    className?: string;
}

export const PaginationBar: React.FC<PaginationBarProps> = ({
    page, setPage, pageSize, setPageSize, pageSizeOptions,
    totalItems, totalPages, rangeStart, rangeEnd, className,
}) => (
    <div className={`flex items-center justify-between px-1 ${className || ''}`}>
        <div className="flex items-center gap-0">
            {pageSizeOptions.map(size => (
                <Button
                    key={size}
                    size="sm"
                    variant={pageSize === size ? 'solid' : 'outline'}
                    colorScheme={pageSize === size ? 'blue' : 'gray'}
                    onClick={() => setPageSize(size)}
                    className="h-6 px-2 font-normal"
                >
                    {size}
                </Button>
            ))}
        </div>
        <span className="text-xs text-slate-500">
            {rangeStart}–{rangeEnd} of {totalItems}
        </span>
        <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => setPage(0)} disabled={page === 0} className="h-6 px-1">
                <FiChevronsLeft size={14} />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPage((p: number) => Math.max(0, p - 1))} disabled={page === 0} className="h-6 px-1">
                <FiChevronLeft size={14} />
            </Button>
            <span className="px-1 text-xs text-slate-600">
                {page + 1}/{totalPages}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setPage((p: number) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} className="h-6 px-1">
                <FiChevronRight size={14} />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1} className="h-6 px-1">
                <FiChevronsRight size={14} />
            </Button>
        </div>
    </div>
);

// ============================================================================
// Main Component
// ============================================================================

export const BundleTable: React.FC<BundleTableProps> = ({
    bundles,
    baseCurrency = 'USD',
    onBundleUpdate,
    onBundleDelete,
    onRemoveTransaction,
    onRefresh,
    onTransactionClick,
}) => {
    const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [filters, setFilters] = useState<BundleFilters>({ search: '', pattern: '', taxability: '' });
    const [bulkLoading, setBulkLoading] = useState(false);
    const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);

    // Filter bundles
    const filteredBundles = useMemo(() => {
        return bundles.filter(bundle => {
            // Search filter (label, notes)
            if (filters.search) {
                const search = filters.search.toLowerCase();
                const matchLabel = (bundle.label || '').toLowerCase().includes(search);
                const matchNotes = (bundle.notes || '').toLowerCase().includes(search);
                const matchId = bundle.id.toString().includes(search);
                if (!matchLabel && !matchNotes && !matchId) return false;
            }
            // Pattern filter
            if (filters.pattern && bundle.pattern !== filters.pattern) return false;
            // Taxability filter
            if (filters.taxability && bundle.taxability_override !== filters.taxability) return false;
            return true;
        });
    }, [bundles, filters]);

    const toggleExpand = useCallback((id: number) => {
        setExpandedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const toggleSelect = useCallback((id: number) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const toggleSelectAll = useCallback(() => {
        const allIds = filteredBundles.map(b => b.id);
        const allSelected = allIds.every(id => selectedIds.has(id));
        if (allSelected) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(allIds));
        }
    }, [filteredBundles, selectedIds]);

    const openBulkDeleteConfirm = () => {
        if (selectedIds.size === 0) return;
        setShowBulkDeleteConfirm(true);
    };

    const handleBulkDelete = async () => {
        if (!onBundleDelete) return;

        setBulkLoading(true);
        try {
            for (const id of selectedIds) {
                await onBundleDelete(id);
            }
            setSelectedIds(new Set());
            onRefresh?.();
        } finally {
            setBulkLoading(false);
            setShowBulkDeleteConfirm(false);
        }
    };

    const handleUpdate = useCallback(async (bundleId: number, updates: Partial<Bundle>) => {
        if (onBundleUpdate) {
            await onBundleUpdate(bundleId, updates);
            onRefresh?.();
        }
    }, [onBundleUpdate, onRefresh]);

    const handleDelete = useCallback(async (bundleId: number) => {
        if (onBundleDelete) {
            await onBundleDelete(bundleId);
            onRefresh?.();
        }
    }, [onBundleDelete, onRefresh]);

    const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
    const [pageSize, setPageSize] = useState(10);
    const [page, setPage] = useState(0); // 0-indexed
    const totalPages = Math.max(1, Math.ceil(filteredBundles.length / pageSize));
    const pagedBundles = filteredBundles.slice(page * pageSize, (page + 1) * pageSize);
    const rangeStart = filteredBundles.length === 0 ? 0 : page * pageSize + 1;
    const rangeEnd = Math.min((page + 1) * pageSize, filteredBundles.length);

    // Reset to page 0 when filters or page size change
    useEffect(() => { setPage(0); }, [filters, pageSize]);

    const allSelected = filteredBundles.length > 0 && filteredBundles.every(b => selectedIds.has(b.id));

    if (bundles.length === 0) {
        return (
            <div className="bg-slate-50 py-8 text-center">
                <span className="text-sm text-slate-500">
                    No bundles yet. Accept suggestions or select transactions to create bundles.
                </span>
            </div>
        );
    }

    return (
        <div>
            <FilterBar
                filters={filters}
                onFiltersChange={setFilters}
                bundleCount={bundles.length}
                filteredCount={filteredBundles.length}
                onRefresh={onRefresh}
            />

            <BulkActionsBar
                selectedCount={selectedIds.size}
                onDelete={openBulkDeleteConfirm}
                onClearSelection={() => setSelectedIds(new Set())}
                loading={bulkLoading}
            />

            {filteredBundles.length === 0 ? (
                <div className="bg-slate-50 py-4 text-center">
                    <span className="text-sm text-slate-500">No bundles match the current filters</span>
                </div>
            ) : (
                <>
                    {/* Top pagination bar */}
                    <PaginationBar
                        page={page}
                        setPage={setPage}
                        pageSize={pageSize}
                        setPageSize={setPageSize}
                        pageSizeOptions={PAGE_SIZE_OPTIONS}
                        totalItems={filteredBundles.length}
                        totalPages={totalPages}
                        rangeStart={rangeStart}
                        rangeEnd={rangeEnd}
                        className="mb-2"
                    />

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                        {pagedBundles.map(bundle => (
                            <BundleRow
                                key={bundle.id}
                                bundle={bundle}
                                baseCurrency={baseCurrency}
                                isExpanded={expandedIds.has(bundle.id)}
                                isSelected={selectedIds.has(bundle.id)}
                                onToggleExpand={() => toggleExpand(bundle.id)}
                                onToggleSelect={() => toggleSelect(bundle.id)}
                                onUpdate={(updates) => handleUpdate(bundle.id, updates)}
                                onDelete={() => handleDelete(bundle.id)}
                                onRemoveTransaction={onRemoveTransaction}
                                onTransactionClick={onTransactionClick}
                            />
                        ))}
                    </div>

                    {/* Bottom pagination bar */}
                    <PaginationBar
                        page={page}
                        setPage={setPage}
                        pageSize={pageSize}
                        setPageSize={setPageSize}
                        pageSizeOptions={PAGE_SIZE_OPTIONS}
                        totalItems={filteredBundles.length}
                        totalPages={totalPages}
                        rangeStart={rangeStart}
                        rangeEnd={rangeEnd}
                        className="mt-3"
                    />
                </>
            )}

            {/* Bulk Delete Confirmation Dialog */}
            <ConfirmDialog
                isOpen={showBulkDeleteConfirm}
                onClose={() => setShowBulkDeleteConfirm(false)}
                onConfirm={handleBulkDelete}
                title="Delete Bundles"
                message={`Delete ${selectedIds.size} bundle(s)?`}
                confirmLabel="Delete"
                isDestructive
                isLoading={bulkLoading}
            />
        </div>
    );
};

export default BundleTable;
