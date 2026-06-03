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
import {
    Badge,
    Box,
    Button,
    Card,
    Checkbox,
    Flex,
    Input,
    NativeSelect,
    SimpleGrid,
    Table,
    Text,
} from '@chakra-ui/react';
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
        <Box mb={3}>
            <Flex justify="space-between" align="center" mb={2}>
                <Flex align="center" gap={2}>
                    <Text fontWeight="bold" fontSize="sm">
                        📦 Bundles ({filteredCount}{filteredCount !== bundleCount && ` / ${bundleCount}`})
                    </Text>
                </Flex>
                <Flex gap={2}>
                    <Tooltip content="To create a bundle, select transactions in the Transactions tab and use the Bundle action" openDelay={100}>
                        <Button size="xs" variant="outline" colorPalette="purple" disabled>
                            ➕ Create
                        </Button>
                    </Tooltip>
                    {onRefresh && (
                        <Button
                            size="xs"
                            variant="outline"
                            onClick={onRefresh}
                        >
                            🔄 Refresh
                        </Button>
                    )}
                    <Button
                        size="xs"
                        variant={showFilters ? 'solid' : 'outline'}
                        colorPalette={hasActiveFilters ? 'blue' : 'gray'}
                        onClick={() => setShowFilters(!showFilters)}
                    >
                        <FiFilter size={12} />
                        <Text ml={1}>Filter</Text>
                        {hasActiveFilters && <Badge ml={1} size="xs" colorPalette="blue">●</Badge>}
                    </Button>
                    {hasActiveFilters && (
                        <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => onFiltersChange({ search: '', pattern: '', taxability: '' })}
                        >
                            <FiX size={12} />
                            <Text ml={1}>Clear</Text>
                        </Button>
                    )}
                </Flex>
            </Flex>

            {showFilters && (
                <Flex gap={3} p={2} bg="gray.50" borderRadius="md" flexWrap="wrap" align="center">
                    <Flex align="center" gap={1}>
                        <FiSearch size={12} color="gray" />
                        <Input
                            size="xs"
                            placeholder="Search label..."
                            value={filters.search}
                            onChange={e => onFiltersChange({ ...filters, search: e.target.value })}
                            width="140px"
                        />
                    </Flex>
                    <Flex align="center" gap={1}>
                        <Text fontSize="xs" color="gray.600">Pattern:</Text>
                        <NativeSelect.Root size="sm" width="100px">
                            <NativeSelect.Field
                                value={filters.pattern}
                                onChange={e => onFiltersChange({ ...filters, pattern: e.target.value })}
                                style={{ fontSize: '11px', padding: '2px 4px' }}
                            >
                                <option value="">All</option>
                                <option value={UnitPattern.INTERNAL_TRANSFER}>Transfer</option>
                                <option value={UnitPattern.SWAP}>Swap</option>
                                <option value={UnitPattern.SPLIT}>Split</option>
                                <option value={UnitPattern.SPINOFF}>Spin-Off</option>
                                <option value={UnitPattern.UNKNOWN}>Unknown</option>
                            </NativeSelect.Field>
                        </NativeSelect.Root>
                    </Flex>
                    <Flex align="center" gap={1}>
                        <Text fontSize="xs" color="gray.600">Tax:</Text>
                        <NativeSelect.Root size="sm" width="100px">
                            <NativeSelect.Field
                                value={filters.taxability}
                                onChange={e => onFiltersChange({ ...filters, taxability: e.target.value })}
                                style={{ fontSize: '11px', padding: '2px 4px' }}
                            >
                                <option value="">All</option>
                                <option value={TaxabilityEnum.TAXABLE}>Taxable</option>
                                <option value={TaxabilityEnum.NON_TAXABLE}>Non-Taxable</option>
                                <option value={TaxabilityEnum.UNKNOWN}>Unknown</option>
                            </NativeSelect.Field>
                        </NativeSelect.Root>
                    </Flex>
                </Flex>
            )}
        </Box>
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
        return <Text fontSize="2xs" color="gray.400">-</Text>;
    }

    const visibleTxs = transactions.slice(0, maxVisible);
    const hiddenCount = transactions.length - maxVisible;

    return (
        <Flex gap={1} flexWrap="wrap" align="center">
            {visibleTxs.map(tx => (
                <TransactionTooltip key={tx.id} txId={tx.id} baseCurrency={baseCurrency} onTransactionClick={onTransactionClick}>
                    <Badge
                        size="xs"
                        colorPalette="gray"
                        variant="subtle"
                        cursor="pointer"
                        fontSize="9px"
                    >
                        #{tx.id}
                    </Badge>
                </TransactionTooltip>
            ))}
            {hiddenCount > 0 && (
                <Text fontSize="2xs" color="gray.500">+{hiddenCount}</Text>
            )}
        </Flex>
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
            <Flex align="center" gap={2} py={3}>
                <FiLoader className="animate-spin" />
                <Text fontSize="xs" color="gray.500">Loading transaction details...</Text>
            </Flex>
        );
    }

    if (error) {
        return <Text fontSize="xs" color="red.500">Error: {error}</Text>;
    }

    if (txDetails.length === 0) {
        return <Text fontSize="xs" color="gray.500" fontStyle="italic">No transactions</Text>;
    }

    return (
        <Card.Root size="sm" variant="outline">
            <Card.Body p={3}>
                <Text fontSize="xs" fontWeight="bold" color="gray.600" mb={2}>
                    📄 Transactions ({txDetails.length})
                </Text>
                <Table.Root size="sm">
                    <Table.Header>
                        <Table.Row>
                            <Table.ColumnHeader fontSize="2xs" width="50px">TX ID</Table.ColumnHeader>
                            <Table.ColumnHeader fontSize="2xs" width="50px">Dir</Table.ColumnHeader>
                            <Table.ColumnHeader fontSize="2xs" width="60px">Asset</Table.ColumnHeader>
                            <Table.ColumnHeader fontSize="2xs" textAlign="right" width="80px">Qty</Table.ColumnHeader>
                            <Table.ColumnHeader fontSize="2xs" textAlign="right" width="70px">Price</Table.ColumnHeader>
                            <Table.ColumnHeader fontSize="2xs" textAlign="right" width="70px">Total</Table.ColumnHeader>
                            <Table.ColumnHeader fontSize="2xs" textAlign="right" width="60px">Fee</Table.ColumnHeader>
                            <Table.ColumnHeader fontSize="2xs" width="70px">Account</Table.ColumnHeader>
                            <Table.ColumnHeader fontSize="2xs" width="60px">Type</Table.ColumnHeader>
                            <Table.ColumnHeader fontSize="2xs" width="70px">From/To</Table.ColumnHeader>
                            {onRemoveTransaction && (
                                <Table.ColumnHeader fontSize="2xs" width="40px"></Table.ColumnHeader>
                            )}
                        </Table.Row>
                    </Table.Header>
                    <Table.Body>
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
                                <Table.Row key={tx.transaction_id}>
                                    <Table.Cell>
                                        <TransactionTooltip txId={tx.transaction_id} baseCurrency={baseCurrency} onTransactionClick={onTransactionClick}>
                                            <Badge size="xs" colorPalette="gray" variant="subtle" cursor="pointer">
                                                #{tx.transaction_id}
                                            </Badge>
                                        </TransactionTooltip>
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Badge
                                            size="xs"
                                            colorPalette={tx.direction === 'inflow' ? 'green' : tx.direction === 'outflow' ? 'red' : 'gray'}
                                        >
                                            {tx.direction === 'inflow' ? '↓' : tx.direction === 'outflow' ? '↑' : '↔'}
                                        </Badge>
                                    </Table.Cell>
                                    <Table.Cell>
                                        <AssetBadge
                                            asset={tx.linked_asset}
                                            sourceSymbol={tx.source_asset_symbol || tx.asset_symbol}
                                            size="xs"
                                            maxLength={15}
                                        />
                                    </Table.Cell>
                                    <Table.Cell fontSize="2xs" textAlign="right" fontFamily="mono">
                                        <ValueDisplay value={tx.quantity} />
                                    </Table.Cell>
                                    <Table.Cell fontSize="2xs" textAlign="right">
                                        {tx.price ? <ValueDisplay value={tx.price} currency={baseCurrency} /> : '-'}
                                    </Table.Cell>
                                    <Table.Cell fontSize="2xs" textAlign="right">
                                        {tx.total ? <ValueDisplay value={tx.total} currency={baseCurrency} /> : '-'}
                                    </Table.Cell>
                                    <Table.Cell fontSize="2xs" textAlign="right">
                                        {tx.fee ? (
                                            <Flex align="center" gap={1} justify="flex-end">
                                                <Text color="orange.600">
                                                    <ValueDisplay value={tx.fee} />
                                                </Text>
                                                <AssetBadge
                                                    asset={tx.fee_quote_asset}
                                                    sourceSymbol={tx.source_fee_quote_asset_symbol || tx.fee_quote_asset_symbol}
                                                    size="xs"
                                                    colorPalette="orange"
                                                    maxLength={10}
                                                />
                                            </Flex>
                                        ) : '-'}
                                    </Table.Cell>
                                    <Table.Cell fontSize="2xs">{tx.account_name || '-'}</Table.Cell>
                                    <Table.Cell fontSize="2xs">
                                        <Badge size="xs" colorPalette={txType === 'transfer' ? 'blue' : 'gray'}>
                                            {txType}
                                        </Badge>
                                    </Table.Cell>
                                    <Table.Cell fontSize="2xs" color="gray.600" title={fromToSource}>
                                        {fromToAccount || '-'}
                                    </Table.Cell>
                                    {onRemoveTransaction && (
                                        <Table.Cell>
                                            <Button
                                                size="xs"
                                                variant="ghost"
                                                colorPalette="red"
                                                p={0}
                                                minW="20px"
                                                h="20px"
                                                onClick={() => handleRemove(tx.transaction_id)}
                                                loading={removingId === tx.transaction_id}
                                                title="Remove from bundle"
                                            >
                                                <FiX size={10} />
                                            </Button>
                                        </Table.Cell>
                                    )}
                                </Table.Row>
                            );
                        })}
                    </Table.Body>
                </Table.Root>
            </Card.Body>
        </Card.Root>
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
            <Flex gap={1} align="center">
                <Input
                    size="xs"
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onBlur={handleSave}
                    autoFocus
                    width="140px"
                    fontSize="11px"
                />
                <Button size="xs" variant="ghost" colorPalette="green" onClick={handleSave} loading={saving} p={1} minW="20px" h="20px">
                    <FiCheck size={10} />
                </Button>
                <Button size="xs" variant="ghost" onClick={() => { setEditValue(value); setEditing(false); }} p={1} minW="20px" h="20px">
                    <FiX size={10} />
                </Button>
            </Flex>
        );
    }

    return (
        <Text
            fontSize="11px"
            fontWeight="medium"
            cursor="pointer"
            _hover={{ color: 'blue.600', textDecoration: 'underline' }}
            onClick={() => setEditing(true)}
            title="Click to edit"
        >
            {value || <Text as="span" color="gray.400" fontStyle="italic">{placeholder}</Text>}
        </Text>
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
            <Card.Root
                size="sm"
                variant="outline"
                bg={isSelected ? 'blue.50' : 'white'}
                borderColor={isExpanded ? 'purple.300' : isSelected ? 'blue.200' : undefined}
                _hover={{ shadow: 'md', borderColor: isExpanded ? 'purple.400' : 'blue.200' }}
                transition="all 0.15s"
            >
                <Card.Body p={3}>
                    {/* Top row: checkbox + pattern icon + taxability icon + delete */}
                    <Flex align="center" gap={1.5} mb={1}>
                        <Checkbox.Root checked={isSelected} onCheckedChange={onToggleSelect}>
                            <Checkbox.HiddenInput />
                            <Checkbox.Control />
                        </Checkbox.Root>
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
                            <Box position="relative" display="inline-flex">
                                <Box
                                    display="flex"
                                    alignItems="center"
                                    justifyContent="center"
                                    w="22px" h="22px"
                                    borderRadius="4px"
                                    bg={{
                                        [UnitPattern.INTERNAL_TRANSFER]: '#BEE3F8',
                                        [UnitPattern.SWAP]: '#FEEBC8',
                                        [UnitPattern.SPLIT]: '#E9D8FD',
                                        [UnitPattern.FLOW]: '#C6F6D5',
                                        [UnitPattern.SPINOFF]: '#FED7E2',
                                        [UnitPattern.UNMATCHED_INTERNAL_TRANSFER]: '#FEFCBF',
                                        [UnitPattern.CUSTOM]: '#E2E8F0',
                                        [UnitPattern.UNKNOWN]: '#EDF2F7',
                                    }[bundle.pattern || UnitPattern.UNKNOWN] || '#EDF2F7'}
                                    color="gray.700"
                                    pointerEvents="none"
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
                                </Box>
                                <select
                                    style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
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
                            </Box>
                        </Tooltip>
                        <Tooltip content={{
                            [TaxabilityEnum.TAXABLE]: 'Taxable',
                            [TaxabilityEnum.NON_TAXABLE]: 'Non-Taxable',
                            [TaxabilityEnum.UNKNOWN]: 'Taxability Unknown',
                        }[bundle.taxability_override || TaxabilityEnum.UNKNOWN] || 'Taxability Unknown'} openDelay={200}>
                            <Box position="relative" display="inline-flex">
                                <Box
                                    display="flex"
                                    alignItems="center"
                                    justifyContent="center"
                                    w="22px" h="22px"
                                    borderRadius="4px"
                                    bg={bundle.taxability_override === TaxabilityEnum.TAXABLE ? '#FED7AA' :
                                        bundle.taxability_override === TaxabilityEnum.NON_TAXABLE ? '#C6F6D5' : '#FEFCBF'}
                                    color="gray.700"
                                    pointerEvents="none"
                                >
                                    {bundle.taxability_override === TaxabilityEnum.TAXABLE ? <FiDollarSign size={11} /> :
                                        bundle.taxability_override === TaxabilityEnum.NON_TAXABLE ? <FiShield size={11} /> :
                                            <FiHelpCircle size={11} />}
                                </Box>
                                <select
                                    style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
                                    value={bundle.taxability_override || TaxabilityEnum.UNKNOWN}
                                    onChange={(e) => handleTaxabilityChange(e.target.value)}
                                >
                                    <option value={TaxabilityEnum.UNKNOWN}>Unknown</option>
                                    <option value={TaxabilityEnum.TAXABLE}>Taxable</option>
                                    <option value={TaxabilityEnum.NON_TAXABLE}>Non-Taxable</option>
                                </select>
                            </Box>
                        </Tooltip>
                        <Box flex={1} />
                        <Button
                            size="xs"
                            variant="ghost"
                            colorPalette="red"
                            onClick={openDeleteConfirm}
                            loading={deleting}
                            title="Delete bundle"
                            p={1}
                            minW="20px"
                            h="20px"
                        >
                            <FiTrash2 size={11} />
                        </Button>
                    </Flex>

                    {/* Bundle name on its own line */}
                    <Box mb={1.5}>
                        <InlineEditLabel
                            value={bundle.label || ''}
                            onSave={async (value) => onUpdate({ label: value })}
                            placeholder={`Bundle #${bundle.id}`}
                        />
                    </Box>

                    {/* Assets + date + notes icon row */}
                    <Flex align="center" gap={2} fontSize="10px" color="gray.600" flexWrap="wrap">
                        <Flex gap={1} align="center" flexWrap="wrap">
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
                                <Text fontSize="10px" color="gray.500">+{assets.length - 4}</Text>
                            )}
                        </Flex>
                        <Text fontSize="10px" color="gray.500">{compactDateRange}</Text>
                        <Tooltip content={bundle.notes || 'No notes'} openDelay={200}>
                            <Box
                                as="span"
                                cursor="pointer"
                                color={bundle.notes ? 'purple.500' : 'gray.300'}
                                _hover={{ color: 'purple.600' }}
                            >
                                <FiFileText size={12} />
                            </Box>
                        </Tooltip>
                    </Flex>

                    {/* Spinoff source info row */}
                    {isSpinoff && (spinoffSourceAsset || spinoffAccountName) && (
                        <Flex align="center" gap={1.5} mt={1} fontSize="10px" color="gray.500" flexWrap="wrap">
                            {spinoffSourceAsset && (
                                <Flex align="center" gap={1}>
                                    <Text fontSize="10px" color="gray.400">Parent:</Text>
                                    <AssetBadge
                                        asset={{ id: spinoffSourceAsset.asset_id!, symbol: spinoffSourceAsset.symbol || '?', label: spinoffSourceAsset.label }}
                                        size="xs"
                                        colorPalette="pink"
                                        maxLength={12}
                                    />
                                </Flex>
                            )}
                            {spinoffAccountName && (
                                <Badge size="xs" variant="outline" colorPalette="gray">
                                    {spinoffAccountName}
                                </Badge>
                            )}
                            {bundle.metadata?.spinoff_allocation_pct != null && (
                                <Text fontSize="10px" color="gray.400">
                                    {(bundle.metadata.spinoff_allocation_pct * 100).toFixed(0)}% alloc
                                </Text>
                            )}
                        </Flex>
                    )}

                    {/* Collapsible transaction list */}
                    <Box
                        mt={1.5}
                        pt={1}
                        borderTop="1px solid"
                        borderColor="gray.100"
                        cursor="pointer"
                        onClick={onToggleExpand}
                        _hover={{ color: 'purple.600' }}
                        textAlign="center"
                    >
                        <Flex align="center" justify="center" gap={1}>
                            {isExpanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                            <Text fontSize="2xs" color="gray.500">
                                {bundle.transactions?.length || 0} transaction{(bundle.transactions?.length || 0) !== 1 ? 's' : ''}
                            </Text>
                        </Flex>
                    </Box>

                    {isExpanded && (
                        <Box mt={1.5}>
                            <BundleMemberTransactionsTable
                                transactionIds={(bundle.transactions || []).map(t => t.id)}
                                onTransactionClick={onTransactionClick}
                            />
                        </Box>
                    )}
                </Card.Body>
            </Card.Root>

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
        <Box mb={3} p={2} bg="blue.50" borderRadius="md" borderWidth={1} borderColor="blue.200">
            <Flex justify="space-between" align="center">
                <Text fontSize="sm" fontWeight="medium" color="blue.700">
                    {selectedCount} bundle{selectedCount !== 1 ? 's' : ''} selected
                </Text>
                <Flex gap={2}>
                    <Button
                        size="xs"
                        colorPalette="red"
                        variant="outline"
                        onClick={onDelete}
                        loading={loading}
                    >
                        <FiTrash2 size={12} />
                        <Text ml={1}>Delete Selected</Text>
                    </Button>
                    <Button size="xs" variant="ghost" onClick={onClearSelection}>
                        <FiX size={12} />
                        <Text ml={1}>Clear</Text>
                    </Button>
                </Flex>
            </Flex>
        </Box>
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
    mt?: number | string;
    mb?: number | string;
}

const PaginationBar: React.FC<PaginationBarProps> = ({
    page, setPage, pageSize, setPageSize, pageSizeOptions,
    totalItems, totalPages, rangeStart, rangeEnd, mt, mb,
}) => (
    <Flex justify="space-between" align="center" px={1} mt={mt} mb={mb}>
        <Flex align="center" gap={0}>
            {pageSizeOptions.map(size => (
                <Button
                    key={size}
                    size="2xs"
                    variant={pageSize === size ? 'solid' : 'outline'}
                    colorPalette={pageSize === size ? 'blue' : 'gray'}
                    borderRadius={0}
                    onClick={() => setPageSize(size)}
                    px={2}
                    fontWeight="normal"
                    _first={{ borderLeftRadius: 'md' }}
                    _last={{ borderRightRadius: 'md' }}
                >
                    {size}
                </Button>
            ))}
        </Flex>
        <Text fontSize="xs" color="gray.500">
            {rangeStart}–{rangeEnd} of {totalItems}
        </Text>
        <Flex align="center" gap={1}>
            <Button size="2xs" variant="ghost" onClick={() => setPage(0)} disabled={page === 0}>
                <FiChevronsLeft size={14} />
            </Button>
            <Button size="2xs" variant="ghost" onClick={() => setPage((p: number) => Math.max(0, p - 1))} disabled={page === 0}>
                <FiChevronLeft size={14} />
            </Button>
            <Text fontSize="xs" color="gray.600" px={1}>
                {page + 1}/{totalPages}
            </Text>
            <Button size="2xs" variant="ghost" onClick={() => setPage((p: number) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}>
                <FiChevronRight size={14} />
            </Button>
            <Button size="2xs" variant="ghost" onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1}>
                <FiChevronsRight size={14} />
            </Button>
        </Flex>
    </Flex>
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
            <Box textAlign="center" py={8} bg="gray.50" borderRadius="md">
                <Text color="gray.500" fontSize="sm">
                    No bundles yet. Accept suggestions or select transactions to create bundles.
                </Text>
            </Box>
        );
    }

    return (
        <Box>
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
                <Box textAlign="center" py={4} bg="gray.50" borderRadius="md">
                    <Text color="gray.500" fontSize="sm">No bundles match the current filters</Text>
                </Box>
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
                        mb={2}
                    />

                    <SimpleGrid columns={{ base: 1, sm: 2, md: 3, lg: 4 }} gap={3}>
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
                    </SimpleGrid>

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
                        mt={3}
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
        </Box>
    );
};

export default BundleTable;
