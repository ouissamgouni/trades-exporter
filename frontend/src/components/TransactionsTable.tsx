import {
    Badge, Box,
    Button, Card, Checkbox, Collapsible, Dialog, Flex,
    Heading, Input, NativeSelect, Portal, Spinner,
    Switch, Table, Tabs, Text
} from '@chakra-ui/react';
import { BiTransfer } from 'react-icons/bi';
import { RiExchangeFundsLine } from 'react-icons/ri';
import { FaQuestion } from 'react-icons/fa';
import { LuPencil } from 'react-icons/lu';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL, Account, Asset, Bundle, BundleSuggestion, Transaction, TransactionStatus, WorkflowStatus, TaxabilityStatus } from '../types';
import { Direction, ReviewStatus, TaxabilityStatus as TaxabilityStatusEnum, UnitPattern } from '../enums';
import { AssetSelector } from './AssetSelector';
import { ACCOUNT_OPTIONS, ComboSelect, TRANSACTION_TYPE_OPTIONS } from './ComboSelect';
import { TransactionEditorDialog } from './TransactionEditorDialog';
import { BundleTransactionList } from './BundleTransactionList';
import { BundleTable } from './BundleTable';
import { TransactionDetailPanel } from './TransactionDetailPanel';
import { toaster } from './ui/toaster';

const ITEMS_PER_PAGE = 25;

// Direction color mapping for row backgrounds
const directionRowColors: Record<string, string> = {
    [Direction.INFLOW]: 'green.50',
    [Direction.OUTFLOW]: 'red.50',
    internal: 'gray.50',
};

// Status badge color mapping (for review_status column display)
const statusBadgeColors: Record<TransactionStatus, string> = {
    [ReviewStatus.VALID]: 'green',
    [ReviewStatus.PENDING]: 'yellow',
    [ReviewStatus.INVALID]: 'red',
};

// Review status options for filter dropdown (same as TransactionStatus)
const reviewStatusOptions = [
    { value: '', label: 'All Status' },
    { value: ReviewStatus.PENDING, label: 'Pending' },
    { value: ReviewStatus.VALID, label: 'Valid' },
    { value: ReviewStatus.INVALID, label: 'Invalid' },
];

// Taxability colors
const taxabilityColors: Record<TaxabilityStatus, string> = {
    [TaxabilityStatusEnum.TAXABLE]: 'orange',
    [TaxabilityStatusEnum.NON_TAXABLE]: 'green',
    [TaxabilityStatusEnum.UNKNOWN]: 'yellow',
};

// Pattern colors for suggestions (simplified to swap and transfer)
const patternColors: Record<string, string> = {
    [UnitPattern.TRANSFER]: 'blue',
    [UnitPattern.SWAP]: 'orange',
};

// Helper to format date as local datetime-local input value (avoids UTC timezone shift)
const toLocalDateTimeString = (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
};

// Props interface for configurable behavior
export interface TransactionsTableProps {
    /** Title displayed in the header */
    title?: string;
    /** Subtitle/description text */
    subtitle?: string;
    /** Default workflow filter (e.g., 'pending' for inbox) */
    defaultWorkflowFilter?: string;
    /** Whether to show the filter bar */
    showFilters?: boolean;
    /** Whether to show the bundles section */
    showBundles?: boolean;
    /** Whether to show bundle suggestions */
    showSuggestions?: boolean;
    /** Callback when data changes (for parent refresh) */
    onDataChange?: () => void;
}

// Editable cell types
type EditableField = 'account_id' | 'source_transaction_type' | 'direction' | 'transaction_type' | 'asset_id' | 'price_quote_asset_id' | 'fee_quote_asset_id' | 'review_status' | 'review_notes' | 'date_time' | 'source' | 'source_asset_symbol' | 'quantity' | 'price' | 'fee' | 'user_calculation_unit_id';

export const TransactionsTable: React.FC<TransactionsTableProps> = ({
    title = 'Transactions',
    subtitle = 'View, filter, and edit transaction details. Select transactions to create a bundle.',
    defaultWorkflowFilter = '',
    showFilters = true,
    showBundles = true,
    showSuggestions = false,
    onDataChange,
}) => {
    const queryClient = useQueryClient();
    const [bundles, setBundles] = useState<Bundle[]>([]);
    const [suggestions, setSuggestions] = useState<BundleSuggestion[]>([]);
    const [assets, setAssets] = useState<Asset[]>([]);
    const [accounts, setAccounts] = useState<Account[]>([]);
    // Cell-level editing: "txId:field" format, e.g., "123:account"
    const [editingCell, setEditingCell] = useState<string | null>(null);
    const [editValues, setEditValues] = useState<Partial<Transaction>>({});
    const editInputRef = useRef<HTMLInputElement | HTMLSelectElement>(null);
    const editValuesRef = useRef<Partial<Transaction>>({});
    const escapePressedRef = useRef(false);
    const [workflowFilter, setWorkflowFilter] = useState<string>(defaultWorkflowFilter);
    const [sourceFilter, setSourceFilter] = useState<string>('');
    const [accountFilter, setAccountFilter] = useState<string>('');
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [showBundleDialog, setShowBundleDialog] = useState(false);
    const [bundleLabel, setBundleLabel] = useState('');
    const [expandedRow, setExpandedRow] = useState<number | null>(null);
    const [bundlesExpanded, setBundlesExpanded] = useState(true);
    const [suggestionsExpanded, setSuggestionsExpanded] = useState(true);
    const [viewMode, setViewMode] = useState<'transactions' | 'bundles'>('transactions');

    // Bulk action states
    const [bulkActionLoading, setBulkActionLoading] = useState(false);
    const [showBulkStatusDialog, setShowBulkStatusDialog] = useState(false);
    const [showBulkTypeDialog, setShowBulkTypeDialog] = useState(false);
    const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
    const [bulkStatus, setBulkStatus] = useState<TransactionStatus>(ReviewStatus.VALID);
    const [bulkType, setBulkType] = useState<string>('');
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const [transactionToDelete, setTransactionToDelete] = useState<Transaction | null>(null);

    // Transaction editor dialog state
    const [showEditorDialog, setShowEditorDialog] = useState(false);
    const [transactionToEdit, setTransactionToEdit] = useState<Transaction | null>(null);

    // Pagination state
    const [currentPage, setCurrentPage] = useState(1);

    // TanStack Query for transactions - filters are part of the query key
    const { data: transactions = [], isLoading: loading, error: queryError, refetch: refetchTransactions } = useQuery({
        queryKey: ['transactions', workflowFilter, sourceFilter, accountFilter],
        queryFn: async () => {
            const params = new URLSearchParams();
            if (workflowFilter) params.append('review_status', workflowFilter);
            if (sourceFilter) params.append('source', sourceFilter);
            if (accountFilter) params.append('account_id', accountFilter);
            const response = await fetch(`${API_URL}/transactions?${params}`);
            if (!response.ok) throw new Error('Failed to fetch transactions');
            return response.json() as Promise<Transaction[]>;
        },
    });

    const error = queryError ? (queryError instanceof Error ? queryError.message : 'Unknown error') : null;

    // Fetch static data once on mount
    useEffect(() => {
        if (showBundles) {
            fetchBundles();
            fetchSuggestions(); // Always fetch suggestions for Bundles tab
        }
        if (showSuggestions && !showBundles) fetchSuggestions();
        fetchAssets();
        fetchAccounts();
    }, [showBundles, showSuggestions]);

    // Reset to first page when filters change
    useEffect(() => { setCurrentPage(1); }, [workflowFilter, sourceFilter, accountFilter]);

    // Keep editValuesRef in sync with editValues state
    useEffect(() => { editValuesRef.current = editValues; }, [editValues]);

    const fetchBundles = async () => {
        try {
            const response = await fetch(`${API_URL}/bundles?min_transaction_count=1`);
            if (response.ok) {
                const data = await response.json();
                setBundles(data);
            }
        } catch (err) {
            console.error('Failed to fetch bundles:', err);
        }
    };

    const fetchAssets = async () => {
        try {
            const response = await fetch(`${API_URL}/assets?limit=10000`);
            if (response.ok) {
                const data = await response.json();
                setAssets(data);
            }
        } catch (err) {
            console.error('Failed to fetch assets:', err);
        }
    };

    const fetchAccounts = async () => {
        try {
            const response = await fetch(`${API_URL}/accounts/`);
            if (response.ok) {
                const data = await response.json();
                setAccounts(data);
            }
        } catch (err) {
            console.error('Failed to fetch accounts:', err);
        }
    };

    const fetchSuggestions = async () => {
        try {
            const response = await fetch(`${API_URL}/bundles/suggestions?max_suggestions=10`);
            if (response.ok) {
                const data = await response.json();
                setSuggestions(data);
            }
        } catch (err) {
            console.error('Failed to fetch suggestions:', err);
        }
    };

    const acceptSuggestion = async (suggestion: BundleSuggestion) => {
        try {
            const response = await fetch(`${API_URL}/bundles/accept-suggestion`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pattern: suggestion.pattern,
                    transaction_ids: suggestion.transaction_ids,
                    label: suggestion.label,
                }),
            });
            if (response.ok) {
                queryClient.invalidateQueries({ queryKey: ['transactions'] });
                await fetchBundles();
                await fetchSuggestions();
                onDataChange?.();
            }
        } catch (err) {
            console.error('Failed to accept suggestion:', err);
        }
    };

    // Bundle update handler
    const handleBundleUpdate = async (bundleId: number, updates: Partial<Bundle>) => {
        try {
            const response = await fetch(`${API_URL}/bundles/${bundleId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates),
            });
            if (!response.ok) throw new Error('Failed to update bundle');
            await fetchBundles();
            onDataChange?.();
        } catch (err) {
            console.error('Failed to update bundle:', err);
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to update bundle' });
        }
    };

    // Bundle delete handler
    const handleBundleDelete = async (bundleId: number) => {
        try {
            const response = await fetch(`${API_URL}/bundles/${bundleId}`, {
                method: 'DELETE',
            });
            if (!response.ok) throw new Error('Failed to delete bundle');
            queryClient.invalidateQueries({ queryKey: ['transactions'] });
            await fetchBundles();
            onDataChange?.();
        } catch (err) {
            console.error('Failed to delete bundle:', err);
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to delete bundle' });
        }
    };

    // Remove transaction from bundle handler
    const handleRemoveTransactionFromBundle = async (bundleId: number, transactionId: number) => {
        try {
            const response = await fetch(`${API_URL}/transactions/${transactionId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_calculation_unit_id: null }),
            });
            if (!response.ok) throw new Error('Failed to remove transaction from bundle');
            queryClient.invalidateQueries({ queryKey: ['transactions'] });
            await fetchBundles();
            onDataChange?.();
        } catch (err) {
            console.error('Failed to remove transaction from bundle:', err);
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to remove transaction' });
        }
    };

    // Helper to update editValues state AND ref synchronously
    const updateEditValues = (updates: Partial<Transaction>) => {
        setEditValues(prev => {
            const newValues = { ...prev, ...updates };
            editValuesRef.current = newValues; // Sync ref immediately
            return newValues;
        });
    };

    // Direct save function that bypasses state/closure issues
    const saveFieldDirectly = async (txId: number, field: string, value: any) => {
        if (escapePressedRef.current) return;
        try {
            const response = await fetch(`${API_URL}/transactions/${txId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [field]: value })
            });
            if (!response.ok) throw new Error('Failed to update');
            queryClient.invalidateQueries({ queryKey: ['transactions'] });
            setEditingCell(null);
            setEditValues({});
        } catch (err) {
            toaster.error({ title: 'Error', description: `Failed to save ${field}` });
        }
    };

    // Pagination calculations
    const totalPages = Math.ceil(transactions.length / ITEMS_PER_PAGE);
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const paginatedTransactions = transactions.slice(startIndex, endIndex);

    const goToPage = (page: number) => {
        if (page >= 1 && page <= totalPages) {
            setCurrentPage(page);
            setExpandedRow(null); // Close any expanded row when changing pages
        }
    };

    // Start editing a specific cell
    const startCellEdit = (tx: Transaction, field: EditableField) => {
        escapePressedRef.current = false;
        setEditingCell(`${tx.id}:${field}`);
        setEditValues({
            asset_id: tx.asset_id,
            price_quote_asset_id: tx.price_quote_asset_id,
            fee_quote_asset_id: tx.fee_quote_asset_id,
            account_id: tx.account_id,
            source_transaction_type: tx.source_transaction_type || '',
            transaction_type: tx.transaction_type,
            direction: tx.direction,
            review_status: tx.review_status,
            review_notes: tx.review_notes || '',
            disposal_taxable: tx.disposal_taxable ?? false,
            include_fee: tx.include_fee ?? false,
            date_time: tx.date_time,
            source: tx.source,
            source_asset_symbol: tx.source_asset_symbol || '',
            quantity: tx.quantity,
            price: tx.price,
            fee: tx.fee,
            user_calculation_unit_id: tx.user_calculation_unit_id
        });
        // Focus input after render
        setTimeout(() => editInputRef.current?.focus(), 0);
    };

    // Check if a specific cell is being edited
    const isEditingCell = (txId: number, field: EditableField) => editingCell === `${txId}:${field}`;
    const getEditingTxId = () => editingCell ? parseInt(editingCell.split(':')[0]) : null;

    // Cancel editing
    const cancelEdit = useCallback(() => {
        escapePressedRef.current = true;
        setEditingCell(null);
        setEditValues({});
    }, []);

    // Global escape key listener
    useEffect(() => {
        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && editingCell) {
                e.preventDefault();
                cancelEdit();
            }
        };
        document.addEventListener('keydown', handleGlobalKeyDown);
        return () => document.removeEventListener('keydown', handleGlobalKeyDown);
    }, [editingCell, cancelEdit]);

    // Save and close (only if not cancelled via escape)
    const saveAndClose = useCallback(async () => {
        // Skip save if escape was pressed
        if (escapePressedRef.current) {
            escapePressedRef.current = false;
            return;
        }
        const txId = getEditingTxId();
        if (txId) {
            await saveTransaction(txId);
        }
    }, [editingCell]);

    // Handle keyboard events for editing
    const handleEditKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            cancelEdit();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            saveAndClose();
        }
    };

    // Direction options for dropdown
    const DIRECTION_OPTIONS = [
        { value: 'inflow', label: '↓' },
        { value: 'outflow', label: '↑' },
        { value: 'internal', label: '↔' }
    ];

    const saveTransaction = async (id: number) => {
        const values = editValuesRef.current;
        // Validate: cannot set status to "valid" if no asset_id
        if (values.review_status === 'valid' && !values.asset_id) {
            toaster.error({ title: 'Validation error', description: 'Cannot set status to "valid" without linking an asset. Please select or create an asset first.' });
            return;
        }

        try {
            const response = await fetch(`${API_URL}/transactions/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(values)
            });
            if (!response.ok) throw new Error('Failed to update transaction');
            queryClient.invalidateQueries({ queryKey: ["transactions"] });
            setEditingCell(null);
            setEditValues({});
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save' });
        }
    };

    // Quick toggle for taxable/include_fee (saves immediately)
    const quickToggle = async (tx: Transaction, field: 'disposal_taxable' | 'include_fee') => {
        try {
            const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [field]: !tx[field] })
            });
            if (!response.ok) throw new Error('Failed to update');
            queryClient.invalidateQueries({ queryKey: ["transactions"] });
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save' });
        }
    };

    const toggleSelection = (id: number) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    const toggleSelectAll = () => {
        // Select/deselect only items on current page
        const currentPageIds = paginatedTransactions.map(tx => tx.id);
        const allSelected = currentPageIds.every(id => selectedIds.has(id));

        if (allSelected) {
            setSelectedIds(prev => {
                const next = new Set(prev);
                currentPageIds.forEach(id => next.delete(id));
                return next;
            });
        } else {
            setSelectedIds(prev => {
                const next = new Set(prev);
                currentPageIds.forEach(id => next.add(id));
                return next;
            });
        }
    };

    const createBundle = async () => {
        if (!bundleLabel.trim() || selectedIds.size === 0) return;
        try {
            const response = await fetch(`${API_URL}/bundles`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    label: bundleLabel,
                    pattern: 'custom',
                    transaction_ids: Array.from(selectedIds)
                })
            });
            if (!response.ok) throw new Error('Failed to create bundle');
            queryClient.invalidateQueries({ queryKey: ["transactions"] });
            setSelectedIds(new Set());
            setBundleLabel('');
            setShowBundleDialog(false);
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to create bundle' });
        }
    };

    // Bulk action handlers
    const bulkUpdateStatus = async () => {
        if (selectedIds.size === 0) return;
        setBulkActionLoading(true);
        try {
            const response = await fetch(`${API_URL}/transactions/bulk/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transaction_ids: Array.from(selectedIds),
                    review_status: bulkStatus
                })
            });
            if (!response.ok) throw new Error('Failed to update transactions');
            const result = await response.json();
            toaster.success({ title: 'Success', description: result.message });
            queryClient.invalidateQueries({ queryKey: ["transactions"] });
            setSelectedIds(new Set());
            setShowBulkStatusDialog(false);
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to update' });
        } finally {
            setBulkActionLoading(false);
        }
    };

    const bulkUpdateType = async () => {
        if (selectedIds.size === 0 || !bulkType) return;
        setBulkActionLoading(true);
        try {
            const response = await fetch(`${API_URL}/transactions/bulk/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transaction_ids: Array.from(selectedIds),
                    transaction_type: bulkType
                })
            });
            if (!response.ok) throw new Error('Failed to update transactions');
            const result = await response.json();
            toaster.success({ title: 'Success', description: result.message });
            queryClient.invalidateQueries({ queryKey: ["transactions"] });
            setSelectedIds(new Set());
            setShowBulkTypeDialog(false);
            setBulkType('');
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to update' });
        } finally {
            setBulkActionLoading(false);
        }
    };

    const bulkDelete = async () => {
        if (selectedIds.size === 0) return;
        setBulkActionLoading(true);
        try {
            const response = await fetch(`${API_URL}/transactions/bulk/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transaction_ids: Array.from(selectedIds)
                })
            });
            if (!response.ok) throw new Error('Failed to delete transactions');
            const result = await response.json();
            toaster.success({ title: 'Success', description: result.message });
            queryClient.invalidateQueries({ queryKey: ["transactions"] });
            setSelectedIds(new Set());
            setShowBulkDeleteDialog(false);
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to delete' });
        } finally {
            setBulkActionLoading(false);
        }
    };

    const handleDeleteTransaction = async () => {
        if (!transactionToDelete) return;
        setBulkActionLoading(true);
        try {
            const response = await fetch(`${API_URL}/transactions/bulk/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transaction_ids: [transactionToDelete.id]
                })
            });
            if (!response.ok) throw new Error('Failed to delete transaction');
            const result = await response.json();
            toaster.success({ title: 'Success', description: result.message });
            queryClient.invalidateQueries({ queryKey: ["transactions"] });
            setShowDeleteDialog(false);
            setTransactionToDelete(null);
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to delete transaction' });
        } finally {
            setBulkActionLoading(false);
        }
    };

    const formatDateTime = (dt: string | number) => {
        const date = typeof dt === 'number' ? new Date(dt * 1000) : new Date(dt);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const mins = String(date.getMinutes()).padStart(2, '0');
        return `${month}/${day} ${hours}:${mins}`;
    };

    const getRowBgColor = (tx: Transaction) => {
        if (selectedIds.has(tx.id)) return 'blue.100';
        // Highlight if no asset_id linked (needs attention)
        if (!tx.asset_id) return 'orange.50';
        return directionRowColors[tx.direction] || 'white';
    };

    const getRowBorderColor = (tx: Transaction) => {
        // Use workflow status for border color indicator
        const workflowBorderColors: Record<string, string> = {
            pending: 'yellow.500',
            reviewed: 'green.500',
            excluded: 'gray.400',
        };
        return workflowBorderColors[tx.status || 'pending'] || 'gray.300';
    };

    if (loading) return (
        <Box textAlign="center" py={10} bg="gray.50" borderRadius="md">
            <Spinner size="xl" color="blue.500" />
            <Text mt={4}>Loading transactions...</Text>
        </Box>
    );

    if (error) return (
        <Box textAlign="center" py={10} bg="red.50" borderRadius="md" borderWidth={1} borderColor="red.200">
            <Text color="red.600">Error: {error}</Text>
        </Box>
    );

    const currentPageIds = paginatedTransactions.map(tx => tx.id);
    const allCurrentPageSelected = currentPageIds.length > 0 && currentPageIds.every(id => selectedIds.has(id));

    const handleRefresh = () => {
        queryClient.invalidateQueries({ queryKey: ['transactions'] });
        if (showBundles) fetchBundles();
        if (showSuggestions) fetchSuggestions();
    };

    return (
        <Box>
            <Flex justify="space-between" align="center" mb={6} borderBottom="1px" borderColor="gray.200" pb={2}>
                <Box>
                    <Heading as="h2" size="md" mb={1}>{title}</Heading>
                    <Text color="gray.600" fontSize="sm">{subtitle}</Text>
                </Box>
                <Flex gap={2}>
                    {selectedIds.size > 0 && (
                        <Button colorPalette="purple" onClick={() => setShowBundleDialog(true)}>
                            📦 Create Bundle ({selectedIds.size})
                        </Button>
                    )}
                    <Button onClick={handleRefresh} variant="outline">
                        🔄 Refresh
                    </Button>
                </Flex>
            </Flex>

            {/* Standalone Suggestions Section - only when showSuggestions but not showBundles */}
            {showSuggestions && !showBundles && (
                <Box mb={6} borderWidth={1} borderColor="teal.200" borderRadius="md" bg="teal.50">
                    <Flex
                        p={3}
                        justify="space-between"
                        align="center"
                        cursor="pointer"
                        onClick={() => setSuggestionsExpanded(!suggestionsExpanded)}
                        _hover={{ bg: 'teal.100' }}
                        borderRadius="md"
                    >
                        <Flex align="center" gap={2}>
                            <Text fontWeight="bold" color="teal.700">💡 Suggested Bundles ({suggestions.length})</Text>
                        </Flex>
                        <Text color="teal.600">{suggestionsExpanded ? '▼' : '▶'}</Text>
                    </Flex>
                    {suggestionsExpanded && (
                        <Box p={3} pt={0}>
                            {suggestions.length === 0 ? (
                                <Text color="teal.600" fontSize="sm">No bundle suggestions available. Add more transactions to get pattern-based suggestions.</Text>
                            ) : (
                                <Flex gap={3} flexWrap="wrap">
                                    {suggestions.map((suggestion, idx) => (
                                        <Card.Root key={idx} size="sm" width="320px" bg="white">
                                            <Card.Body p={3}>
                                                <Flex justify="space-between" align="center" mb={2}>
                                                    <Badge colorPalette={patternColors[suggestion.pattern] || 'gray'}>
                                                        {suggestion.pattern}
                                                    </Badge>
                                                    <Text fontSize="xs" color="gray.500">
                                                        {Math.round(suggestion.confidence * 100)}% confidence
                                                    </Text>
                                                </Flex>
                                                <Text fontWeight="bold" fontSize="sm">{suggestion.label}</Text>
                                                <Text fontSize="xs" color="gray.600" mt={1}>{suggestion.reason}</Text>
                                                {suggestion.total_quantity && (
                                                    <Text fontSize="xs" mt={1}>
                                                        {suggestion.total_quantity} {suggestion.asset_symbol}
                                                    </Text>
                                                )}
                                                {/* Expandable Transaction List */}
                                                <Box mt={2} pt={2} borderTopWidth={1} borderColor="gray.100">
                                                    <Text fontSize="xs" color="gray.500" mb={1}>
                                                        {suggestion.transaction_ids.length} transaction{suggestion.transaction_ids.length !== 1 ? 's' : ''}:
                                                    </Text>
                                                    <BundleTransactionList
                                                        transactions={suggestion.transactions || []}
                                                        maxVisible={3}
                                                        colorScheme="teal"
                                                    />
                                                </Box>
                                                <Flex mt={3} gap={2}>
                                                    <Button
                                                        size="xs"
                                                        colorPalette="green"
                                                        onClick={(e) => { e.stopPropagation(); acceptSuggestion(suggestion); }}
                                                    >
                                                        ✓ Create Bundle
                                                    </Button>
                                                    <Button size="xs" variant="ghost">Dismiss</Button>
                                                </Flex>
                                            </Card.Body>
                                        </Card.Root>
                                    ))}
                                </Flex>
                            )}
                        </Box>
                    )}
                </Box>
            )}

            {/* Bulk Actions Bar - shown when items are selected */}
            {selectedIds.size > 0 && (
                <Box mb={4} p={3} bg="blue.50" borderRadius="md" borderWidth={1} borderColor="blue.200">
                    <Flex justify="space-between" align="center" flexWrap="wrap" gap={2}>
                        <Text fontWeight="medium" color="blue.700">
                            {selectedIds.size} transaction(s) selected
                        </Text>
                        <Flex gap={2} flexWrap="wrap">
                            <Button
                                size="sm"
                                colorPalette="green"
                                variant="outline"
                                onClick={() => setShowBulkStatusDialog(true)}
                            >
                                ✓ Set Status
                            </Button>
                            <Button
                                size="sm"
                                colorPalette="purple"
                                variant="outline"
                                onClick={() => setShowBulkTypeDialog(true)}
                            >
                                🏷️ Set Type
                            </Button>
                            <Button
                                size="sm"
                                colorPalette="purple"
                                variant="outline"
                                onClick={() => setShowBundleDialog(true)}
                            >
                                📦 Create Bundle
                            </Button>
                            <Button
                                size="sm"
                                colorPalette="red"
                                variant="outline"
                                onClick={() => setShowBulkDeleteDialog(true)}
                            >
                                🗑️ Delete
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setSelectedIds(new Set())}
                            >
                                ✕ Clear Selection
                            </Button>
                        </Flex>
                    </Flex>
                </Box>
            )}

            {/* Tabbed View for Transactions/Bundles when showBundles is enabled */}
            {showBundles && (
                <Tabs.Root value={viewMode} onValueChange={(e) => setViewMode(e.value as 'transactions' | 'bundles')}>
                    <Tabs.List mb={4}>
                        <Tabs.Trigger value="transactions">📋 Transactions ({transactions.length})</Tabs.Trigger>
                        <Tabs.Trigger value="bundles">📦 Bundles ({bundles.length}) {suggestions.length > 0 && <Badge colorPalette="teal" ml={1}>{suggestions.length} 💡</Badge>}</Tabs.Trigger>
                    </Tabs.List>

                    <Tabs.Content value="bundles">
                        {/* Suggestions Section inside Bundles tab */}
                        <Box mb={4} borderWidth={1} borderColor="teal.200" borderRadius="md" bg="teal.50">
                            <Flex
                                p={3}
                                justify="space-between"
                                align="center"
                                cursor="pointer"
                                onClick={() => setSuggestionsExpanded(!suggestionsExpanded)}
                                _hover={{ bg: 'teal.100' }}
                                borderRadius="md"
                            >
                                <Flex align="center" gap={2}>
                                    <Text fontWeight="bold" color="teal.700">💡 Suggested Bundles ({suggestions.length})</Text>
                                </Flex>
                                <Text color="teal.600">{suggestionsExpanded ? '▼' : '▶'}</Text>
                            </Flex>
                            {suggestionsExpanded && (
                                <Box p={3} pt={0}>
                                    {suggestions.length === 0 ? (
                                        <Text color="teal.600" fontSize="sm">No bundle suggestions available. Add more transactions to get pattern-based suggestions.</Text>
                                    ) : (
                                        <Flex gap={3} flexWrap="wrap">
                                            {suggestions.map((suggestion, idx) => (
                                                <Card.Root key={idx} size="sm" width="320px" bg="white">
                                                    <Card.Body p={3}>
                                                        <Flex justify="space-between" align="center" mb={2}>
                                                            <Badge colorPalette={patternColors[suggestion.pattern] || 'gray'}>
                                                                {suggestion.pattern}
                                                            </Badge>
                                                            <Text fontSize="xs" color="gray.500">
                                                                {Math.round(suggestion.confidence * 100)}% confidence
                                                            </Text>
                                                        </Flex>
                                                        <Text fontWeight="bold" fontSize="sm">{suggestion.label}</Text>
                                                        <Text fontSize="xs" color="gray.600" mt={1}>{suggestion.reason}</Text>
                                                        {suggestion.total_quantity && (
                                                            <Text fontSize="xs" mt={1}>
                                                                {suggestion.total_quantity} {suggestion.asset_symbol}
                                                            </Text>
                                                        )}
                                                        {/* Expandable Transaction List */}
                                                        <Box mt={2} pt={2} borderTopWidth={1} borderColor="gray.100">
                                                            <Text fontSize="xs" color="gray.500" mb={1}>
                                                                {suggestion.transaction_ids.length} transaction{suggestion.transaction_ids.length !== 1 ? 's' : ''}:
                                                            </Text>
                                                            <BundleTransactionList
                                                                transactions={suggestion.transactions || []}
                                                                maxVisible={3}
                                                                colorScheme="teal"
                                                            />
                                                        </Box>
                                                        <Flex mt={3} gap={2}>
                                                            <Button
                                                                size="xs"
                                                                colorPalette="green"
                                                                onClick={(e) => { e.stopPropagation(); acceptSuggestion(suggestion); }}
                                                            >
                                                                ✓ Create Bundle
                                                            </Button>
                                                            <Button size="xs" variant="ghost">Dismiss</Button>
                                                        </Flex>
                                                    </Card.Body>
                                                </Card.Root>
                                            ))}
                                        </Flex>
                                    )}
                                </Box>
                            )}
                        </Box>

                        {/* Existing Bundles - New Table View */}
                        <BundleTable
                            bundles={bundles}
                            onBundleUpdate={handleBundleUpdate}
                            onBundleDelete={handleBundleDelete}
                            onRemoveTransaction={handleRemoveTransactionFromBundle}
                            onRefresh={fetchBundles}
                        />
                    </Tabs.Content>
                </Tabs.Root>
            )}

            {/* Only show transactions when in transactions view mode (or when bundles tab is not shown) */}
            {(!showBundles || viewMode === 'transactions') && (
                <>
                    {showFilters && (
                        <Flex gap={4} mb={6} align="center" flexWrap="wrap">
                            <Flex align="center" gap={2}>
                                <Text fontWeight="medium" fontSize="sm">Status:</Text>
                                <NativeSelect.Root size="sm" width="auto">
                                    <NativeSelect.Field
                                        value={workflowFilter}
                                        onChange={e => setWorkflowFilter(e.target.value)}
                                    >
                                        <option value="">All</option>
                                        <option value="pending">📥 Pending</option>
                                        <option value="valid">✅ Valid</option>
                                        <option value="invalid">🚫 Invalid</option>
                                    </NativeSelect.Field>
                                </NativeSelect.Root>
                            </Flex>
                            <Flex align="center" gap={2}>
                                <Text fontWeight="medium" fontSize="sm">Source:</Text>
                                <NativeSelect.Root size="sm" width="auto">
                                    <NativeSelect.Field
                                        value={sourceFilter}
                                        onChange={e => setSourceFilter(e.target.value)}
                                    >
                                        <option value="">All Sources</option>
                                        <option value="binance">Binance</option>
                                        <option value="mexc">MEXC</option>
                                        <option value="coinbase">Coinbase</option>
                                    </NativeSelect.Field>
                                </NativeSelect.Root>
                            </Flex>
                            <Flex align="center" gap={2}>
                                <Text fontWeight="medium" fontSize="sm">Account:</Text>
                                <NativeSelect.Root size="sm" width="auto">
                                    <NativeSelect.Field
                                        value={accountFilter}
                                        onChange={e => setAccountFilter(e.target.value)}
                                    >
                                        <option value="">All Accounts</option>
                                        <option value="binance">Binance</option>
                                        <option value="mexc">MEXC</option>
                                        <option value="okx">OKX</option>
                                        <option value="coinbase">Coinbase</option>
                                        <option value="onchain">Onchain</option>
                                    </NativeSelect.Field>
                                </NativeSelect.Root>
                            </Flex>
                            {(workflowFilter || sourceFilter || accountFilter) && (
                                <Button size="sm" variant="outline" onClick={() => { setWorkflowFilter(''); setSourceFilter(''); setAccountFilter(''); }}>
                                    Clear Filters
                                </Button>
                            )}

                            {/* Legend */}
                            <Flex ml="auto" gap={3} align="center">
                                <Text fontSize="xs" color="gray.500">Dir:</Text>
                                <Flex align="center" gap={1}>
                                    <Box w={3} h={3} bg="green.100" borderRadius="sm" />
                                    <Text fontSize="xs">↓In</Text>
                                </Flex>
                                <Flex align="center" gap={1}>
                                    <Box w={3} h={3} bg="red.100" borderRadius="sm" />
                                    <Text fontSize="xs">↑Out</Text>
                                </Flex>
                                <Flex align="center" gap={1}>
                                    <Box w={3} h={3} bg="gray.100" borderRadius="sm" />
                                    <Text fontSize="xs">↔Int</Text>
                                </Flex>
                                <Text fontSize="xs" color="gray.500" ml={2}>Workflow:</Text>
                                <Flex align="center" gap={1}>
                                    <Box w={1} h={3} bg="yellow.500" borderRadius="sm" />
                                    <Text fontSize="xs">Pending</Text>
                                </Flex>
                                <Flex align="center" gap={1}>
                                    <Box w={1} h={3} bg="green.500" borderRadius="sm" />
                                    <Text fontSize="xs">Reviewed</Text>
                                </Flex>
                                <Flex align="center" gap={1}>
                                    <Box w={1} h={3} bg="gray.400" borderRadius="sm" />
                                    <Text fontSize="xs">Excluded</Text>
                                </Flex>
                                <Flex align="center" gap={1}>
                                    <Box w={3} h={3} bg="orange.100" borderRadius="sm" />
                                    <Text fontSize="xs">No Asset</Text>
                                </Flex>
                            </Flex>
                        </Flex>
                    )}

                    <Box overflowX="auto" bg="white" borderRadius="md" boxShadow="sm" css={{ fontSize: '8px' }} position="relative">
                        <Table.Root size="sm" variant="line">
                            <Table.Header css={{ fontSize: '9px' }}>
                                <Table.Row>
                                    <Table.ColumnHeader position="sticky" left={0} bg="gray.100" zIndex={10} minW="30px" borderRight="2px solid" borderColor="gray.300">
                                        <Checkbox.Root
                                            checked={allCurrentPageSelected}
                                            onCheckedChange={toggleSelectAll}
                                        >
                                            <Checkbox.HiddenInput />
                                            <Checkbox.Control />
                                        </Checkbox.Root>
                                    </Table.ColumnHeader>
                                    <Table.ColumnHeader minW="20px"></Table.ColumnHeader>
                                    <Table.ColumnHeader>ID</Table.ColumnHeader>
                                    <Table.ColumnHeader>Date/Time</Table.ColumnHeader>
                                    <Table.ColumnHeader>Account</Table.ColumnHeader>
                                    <Table.ColumnHeader>Source</Table.ColumnHeader>
                                    <Table.ColumnHeader>Src Type</Table.ColumnHeader>
                                    <Table.ColumnHeader>Dir</Table.ColumnHeader>
                                    <Table.ColumnHeader>Type</Table.ColumnHeader>
                                    <Table.ColumnHeader maxW="60px">Src Sym</Table.ColumnHeader>
                                    <Table.ColumnHeader>Asset</Table.ColumnHeader>
                                    <Table.ColumnHeader>Qty</Table.ColumnHeader>
                                    <Table.ColumnHeader>Price</Table.ColumnHeader>
                                    <Table.ColumnHeader>Total</Table.ColumnHeader>
                                    <Table.ColumnHeader>Fee</Table.ColumnHeader>
                                    <Table.ColumnHeader>Tax</Table.ColumnHeader>
                                    <Table.ColumnHeader>Fee$</Table.ColumnHeader>
                                    <Table.ColumnHeader>Bundle</Table.ColumnHeader>
                                    <Table.ColumnHeader position="sticky" right="30px" bg="gray.100" zIndex={10} borderLeft="2px solid" borderColor="gray.300">Status</Table.ColumnHeader>
                                    <Table.ColumnHeader position="sticky" right={0} bg="gray.100" zIndex={10} minW="30px"></Table.ColumnHeader>
                                </Table.Row>
                            </Table.Header>
                            <Table.Body>
                                {paginatedTransactions.length === 0 ? (
                                    <Table.Row>
                                        <Table.Cell colSpan={20}>
                                            <Text textAlign="center" py={8} color="gray.500">
                                                No transactions found
                                            </Text>
                                        </Table.Cell>
                                    </Table.Row>
                                ) : (
                                    paginatedTransactions.map(tx => (
                                        <React.Fragment key={tx.id}>
                                            <Table.Row bg={getRowBgColor(tx)} _hover={{ bg: 'gray.50' }} borderLeft="4px solid" borderLeftColor={getRowBorderColor(tx)}>
                                                <Table.Cell position="sticky" left={0} bg={getRowBgColor(tx)} zIndex={5} borderRight="2px solid" borderColor="gray.300">
                                                    <Checkbox.Root
                                                        checked={selectedIds.has(tx.id)}
                                                        onCheckedChange={() => toggleSelection(tx.id)}
                                                    >
                                                        <Checkbox.HiddenInput />
                                                        <Checkbox.Control />
                                                    </Checkbox.Root>
                                                </Table.Cell>
                                                {/* Arrow for details */}
                                                <Table.Cell py={1}>
                                                    <Button size="xs" variant="ghost" onClick={() => setExpandedRow(expandedRow === tx.id ? null : tx.id)} p={0} minW="16px" h="16px">
                                                        {expandedRow === tx.id ? '▲' : '▼'}
                                                    </Button>
                                                </Table.Cell>
                                                <Table.Cell py={1}>
                                                    <Text fontSize="8px" fontFamily="mono" color="gray.500">{tx.id}</Text>
                                                </Table.Cell>
                                                {/* Date/Time - click to edit */}
                                                <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'date_time') && startCellEdit(tx, 'date_time')} cursor="pointer">
                                                    {isEditingCell(tx.id, 'date_time') ? (
                                                        <Input
                                                            ref={editInputRef as React.RefObject<HTMLInputElement>}
                                                            size="xs"
                                                            type="datetime-local"
                                                            value={typeof editValues.date_time === 'number'
                                                                ? toLocalDateTimeString(new Date(editValues.date_time * 1000))
                                                                : editValues.date_time ? toLocalDateTimeString(new Date(editValues.date_time)) : ''}
                                                            onChange={e => updateEditValues({ date_time: e.target.value })}
                                                            onKeyDown={handleEditKeyDown}
                                                            onBlur={saveAndClose}
                                                            width="130px"
                                                            fontSize="8px"
                                                            px={1}
                                                        />
                                                    ) : (
                                                        <Text fontSize="8px">{formatDateTime(tx.date_time)}</Text>
                                                    )}
                                                </Table.Cell>
                                                {/* Account column - click to edit */}
                                                <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'account_id') && startCellEdit(tx, 'account_id')} cursor="pointer">
                                                    {isEditingCell(tx.id, 'account_id') ? (
                                                        <NativeSelect.Root size="sm" width="80px">
                                                            <NativeSelect.Field
                                                                value={editValues.account_id ?? tx.account_id ?? ''}
                                                                onChange={async e => {
                                                                    const newAccountId = e.target.value ? parseInt(e.target.value) : null;
                                                                    try {
                                                                        const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                            method: 'PATCH',
                                                                            headers: { 'Content-Type': 'application/json' },
                                                                            body: JSON.stringify({
                                                                                account_id: newAccountId
                                                                            })
                                                                        });
                                                                        if (!response.ok) throw new Error('Failed to update');
                                                                        queryClient.invalidateQueries({ queryKey: ["transactions"] });
                                                                        setEditingCell(null);
                                                                        setEditValues({});
                                                                    } catch (err) {
                                                                        toaster.error({ title: 'Error', description: 'Failed to save account' });
                                                                    }
                                                                }}
                                                                onBlur={() => {
                                                                    if (!escapePressedRef.current) {
                                                                        setEditingCell(null);
                                                                        setEditValues({});
                                                                    }
                                                                }}
                                                                style={{ fontSize: '8px', padding: '2px' }}
                                                                autoFocus
                                                            >
                                                                <option value="">None</option>
                                                                {accounts.map(acc => (
                                                                    <option key={acc.id} value={acc.id}>{acc.name}</option>
                                                                ))}
                                                            </NativeSelect.Field>
                                                        </NativeSelect.Root>
                                                    ) : (
                                                        <Badge size="sm" colorPalette="purple">
                                                            {accounts.find(a => a.id === tx.account_id)?.name || '-'}
                                                        </Badge>
                                                    )}
                                                </Table.Cell>
                                                {/* Source - click to edit */}
                                                <Table.Cell py={1} maxW="80px" onClick={() => !isEditingCell(tx.id, 'source') && startCellEdit(tx, 'source')} cursor="pointer">
                                                    {isEditingCell(tx.id, 'source') ? (
                                                        <Input
                                                            ref={editInputRef as React.RefObject<HTMLInputElement>}
                                                            size="xs"
                                                            value={editValues.source ?? tx.source}
                                                            onChange={e => updateEditValues({ source: e.target.value })}
                                                            onKeyDown={e => {
                                                                if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                                                                else if (e.key === 'Enter') { e.preventDefault(); saveFieldDirectly(tx.id, 'source', editValuesRef.current.source); }
                                                            }}
                                                            onBlur={() => !escapePressedRef.current && saveFieldDirectly(tx.id, 'source', editValuesRef.current.source)}
                                                            width="70px"
                                                            fontSize="8px"
                                                            px={1}
                                                        />
                                                    ) : (
                                                        <Text fontSize="8px" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" title={tx.source}>
                                                            {tx.source}
                                                        </Text>
                                                    )}
                                                </Table.Cell>
                                                {/* Source Type column - click to edit */}
                                                <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'source_transaction_type') && startCellEdit(tx, 'source_transaction_type')} cursor="pointer">
                                                    {isEditingCell(tx.id, 'source_transaction_type') ? (
                                                        <Input
                                                            ref={editInputRef as React.RefObject<HTMLInputElement>}
                                                            size="xs"
                                                            value={editValues.source_transaction_type ?? tx.source_transaction_type ?? ''}
                                                            onChange={e => updateEditValues({ source_transaction_type: e.target.value })}
                                                            onKeyDown={handleEditKeyDown}
                                                            onBlur={saveAndClose}
                                                            placeholder="type"
                                                            width="60px"
                                                            fontSize="8px"
                                                            px={1}
                                                        />
                                                    ) : (
                                                        <Text fontSize="8px" color="gray.600">{tx.source_transaction_type || '-'}</Text>
                                                    )}
                                                </Table.Cell>
                                                {/* Direction - click to edit */}
                                                <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'direction') && startCellEdit(tx, 'direction')} cursor="pointer">
                                                    {isEditingCell(tx.id, 'direction') ? (
                                                        <NativeSelect.Root size="sm" width="45px">
                                                            <NativeSelect.Field
                                                                value={editValues.direction || tx.direction}
                                                                onChange={async e => {
                                                                    const newDir = e.target.value;
                                                                    // Save directly with the new value
                                                                    try {
                                                                        const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                            method: 'PATCH',
                                                                            headers: { 'Content-Type': 'application/json' },
                                                                            body: JSON.stringify({ direction: newDir })
                                                                        });
                                                                        if (!response.ok) throw new Error('Failed to update');
                                                                        queryClient.invalidateQueries({ queryKey: ["transactions"] });
                                                                        setEditingCell(null);
                                                                        setEditValues({});
                                                                    } catch (err) {
                                                                        toaster.error({ title: 'Error', description: 'Failed to save direction' });
                                                                    }
                                                                }}
                                                                onBlur={() => {
                                                                    if (!escapePressedRef.current) {
                                                                        setEditingCell(null);
                                                                        setEditValues({});
                                                                    }
                                                                }}
                                                                style={{ fontSize: '8px', padding: '2px' }}
                                                                autoFocus
                                                            >
                                                                {DIRECTION_OPTIONS.map(opt => (
                                                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                                                ))}
                                                            </NativeSelect.Field>
                                                        </NativeSelect.Root>
                                                    ) : (
                                                        <Badge size="sm" colorPalette={tx.direction === 'inflow' ? 'green' : tx.direction === 'outflow' ? 'red' : 'gray'}>
                                                            {tx.direction === 'inflow' ? '↓' : tx.direction === 'outflow' ? '↑' : '↔'}
                                                        </Badge>
                                                    )}
                                                </Table.Cell>
                                                {/* Type - click to edit */}
                                                <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'transaction_type') && startCellEdit(tx, 'transaction_type')} cursor="pointer">
                                                    {isEditingCell(tx.id, 'transaction_type') ? (
                                                        <NativeSelect.Root size="sm" width="80px">
                                                            <NativeSelect.Field
                                                                value={editValues.transaction_type || tx.transaction_type}
                                                                onChange={async e => {
                                                                    const newType = e.target.value;
                                                                    try {
                                                                        const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                            method: 'PATCH',
                                                                            headers: { 'Content-Type': 'application/json' },
                                                                            body: JSON.stringify({ transaction_type: newType })
                                                                        });
                                                                        if (!response.ok) throw new Error('Failed to update');
                                                                        queryClient.invalidateQueries({ queryKey: ["transactions"] });
                                                                        setEditingCell(null);
                                                                        setEditValues({});
                                                                    } catch (err) {
                                                                        toaster.error({ title: 'Error', description: 'Failed to save type' });
                                                                    }
                                                                }}
                                                                onBlur={() => {
                                                                    if (!escapePressedRef.current) {
                                                                        setEditingCell(null);
                                                                        setEditValues({});
                                                                    }
                                                                }}
                                                                style={{ fontSize: '8px', padding: '2px' }}
                                                                autoFocus
                                                            >
                                                                {TRANSACTION_TYPE_OPTIONS.map(opt => (
                                                                    <option key={opt} value={opt}>{opt}</option>
                                                                ))}
                                                            </NativeSelect.Field>
                                                        </NativeSelect.Root>
                                                    ) : (
                                                        <Flex align="center" gap={1}>
                                                            {tx.transaction_type === 'transfer' ? (
                                                                <BiTransfer color="#805AD5" size={12} title="Transfer" />
                                                            ) : tx.transaction_type === 'trade' ? (
                                                                <RiExchangeFundsLine color="#3182CE" size={12} title="Trade" />
                                                            ) : tx.transaction_type === 'technical' ? (
                                                                <FaQuestion color="#A0AEC0" size={10} title="Technical (approval, contract call)" />
                                                            ) : (
                                                                <FaQuestion color="#718096" size={10} title="Other" />
                                                            )}
                                                            <Badge size="xs" colorPalette="blue">{tx.transaction_type?.substring(0, 6)}</Badge>
                                                        </Flex>
                                                    )}
                                                </Table.Cell>
                                                {/* Source Asset Symbol - click to edit */}
                                                <Table.Cell py={1} maxW="60px" onClick={() => !isEditingCell(tx.id, 'source_asset_symbol') && startCellEdit(tx, 'source_asset_symbol')} cursor="pointer">
                                                    {isEditingCell(tx.id, 'source_asset_symbol') ? (
                                                        <Input
                                                            ref={editInputRef as React.RefObject<HTMLInputElement>}
                                                            size="xs"
                                                            value={editValues.source_asset_symbol ?? tx.source_asset_symbol ?? ''}
                                                            onChange={e => updateEditValues({ source_asset_symbol: e.target.value })}
                                                            onKeyDown={e => {
                                                                if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                                                                else if (e.key === 'Enter') { e.preventDefault(); saveFieldDirectly(tx.id, 'source_asset_symbol', editValuesRef.current.source_asset_symbol); }
                                                            }}
                                                            onBlur={() => !escapePressedRef.current && saveFieldDirectly(tx.id, 'source_asset_symbol', editValuesRef.current.source_asset_symbol)}
                                                            width="50px"
                                                            fontSize="8px"
                                                            px={1}
                                                        />
                                                    ) : (
                                                        <Text fontSize="8px" fontFamily="mono" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" title={tx.source_asset_symbol || ''}>
                                                            {tx.source_asset_symbol || '-'}
                                                        </Text>
                                                    )}
                                                </Table.Cell>
                                                {/* Linked Asset - click to edit */}
                                                <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'asset_id') && startCellEdit(tx, 'asset_id')} cursor="pointer">
                                                    {isEditingCell(tx.id, 'asset_id') ? (
                                                        <Box minW="90px">
                                                            <AssetSelector
                                                                value={editValues.asset_id ?? null}
                                                                onChange={(assetId) => {
                                                                    if (!escapePressedRef.current) {
                                                                        updateEditValues({ asset_id: assetId ?? undefined });
                                                                        saveAndClose();
                                                                    }
                                                                }}
                                                                assets={assets}
                                                                onAssetCreated={fetchAssets}
                                                                defaultSymbol={tx.source_asset_symbol || ''}
                                                                placeholder="Link..."
                                                                rawAssetSource={tx.source}
                                                                rawAssetSymbol={tx.source_asset_symbol}
                                                            />
                                                        </Box>
                                                    ) : (
                                                        tx.linked_asset_symbol ? (
                                                            <Badge size="sm" colorPalette="purple">{tx.linked_asset_symbol}</Badge>
                                                        ) : (
                                                            <Text color="orange.500" fontWeight="bold" fontSize="8px">⚠ Link</Text>
                                                        )
                                                    )}
                                                </Table.Cell>
                                                {/* Quantity - click to edit */}
                                                <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'quantity') && startCellEdit(tx, 'quantity')} cursor="pointer">
                                                    {isEditingCell(tx.id, 'quantity') ? (
                                                        <Input
                                                            ref={editInputRef as React.RefObject<HTMLInputElement>}
                                                            size="xs"
                                                            type="number"
                                                            step="any"
                                                            value={editValues.quantity ?? tx.quantity ?? ''}
                                                            onChange={e => updateEditValues({ quantity: parseFloat(e.target.value) || 0 })}
                                                            onKeyDown={e => {
                                                                if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                                                                else if (e.key === 'Enter') { e.preventDefault(); saveFieldDirectly(tx.id, 'quantity', editValuesRef.current.quantity); }
                                                            }}
                                                            onBlur={() => !escapePressedRef.current && saveFieldDirectly(tx.id, 'quantity', editValuesRef.current.quantity)}
                                                            width="60px"
                                                            fontSize="8px"
                                                            px={1}
                                                        />
                                                    ) : (
                                                        <Text fontSize="8px">{tx.quantity?.toFixed(4) ?? '-'}</Text>
                                                    )}
                                                </Table.Cell>
                                                {/* Price - click to edit value, click badge to edit quote asset */}
                                                <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'price') && !isEditingCell(tx.id, 'price_quote_asset_id') && startCellEdit(tx, 'price')} cursor="pointer">
                                                    <Flex direction="column" gap={0}>
                                                        {isEditingCell(tx.id, 'price') ? (
                                                            <Input
                                                                ref={editInputRef as React.RefObject<HTMLInputElement>}
                                                                size="xs"
                                                                type="number"
                                                                step="any"
                                                                value={editValues.price ?? tx.price ?? ''}
                                                                onChange={e => updateEditValues({ price: parseFloat(e.target.value) || 0 })}
                                                                onKeyDown={e => {
                                                                    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                                                                    else if (e.key === 'Enter') { e.preventDefault(); saveFieldDirectly(tx.id, 'price', editValuesRef.current.price); }
                                                                }}
                                                                onBlur={() => !escapePressedRef.current && saveFieldDirectly(tx.id, 'price', editValuesRef.current.price)}
                                                                width="60px"
                                                                fontSize="8px"
                                                                px={1}
                                                            />
                                                        ) : (
                                                            <Text fontSize="8px">{tx.price ? tx.price.toFixed(2) : '-'}</Text>
                                                        )}
                                                        {isEditingCell(tx.id, 'price_quote_asset_id') ? (
                                                            <Box minW="70px">
                                                                <AssetSelector
                                                                    value={editValues.price_quote_asset_id ?? null}
                                                                    onChange={(assetId) => {
                                                                        if (!escapePressedRef.current) {
                                                                            updateEditValues({ price_quote_asset_id: assetId ?? undefined });
                                                                            saveAndClose();
                                                                        }
                                                                    }}
                                                                    assets={assets}
                                                                    onAssetCreated={fetchAssets}
                                                                    defaultSymbol={tx.source_price_quote_asset_symbol || ''}
                                                                    placeholder="Quote..."
                                                                    rawAssetSource={tx.source}
                                                                    rawAssetSymbol={tx.source_price_quote_asset_symbol}
                                                                />
                                                            </Box>
                                                        ) : tx.linked_price_quote_asset_symbol ? (
                                                            <Badge size="xs" colorPalette="cyan" cursor="pointer" onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'price_quote_asset_id'); }}>{tx.linked_price_quote_asset_symbol}</Badge>
                                                        ) : tx.source_price_quote_asset_symbol ? (
                                                            <Text fontSize="8px" color="orange.500" fontWeight="bold" cursor="pointer" onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'price_quote_asset_id'); }}>⚠ {tx.source_price_quote_asset_symbol}</Text>
                                                        ) : null}
                                                    </Flex>
                                                </Table.Cell>
                                                <Table.Cell py={1}><Text fontSize="8px">{tx.total ? tx.total.toFixed(2) : '-'}</Text></Table.Cell>
                                                {/* Fee - click to edit value, click badge to edit quote asset */}
                                                <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'fee') && !isEditingCell(tx.id, 'fee_quote_asset_id') && startCellEdit(tx, 'fee')} cursor="pointer">
                                                    <Flex direction="column" gap={0}>
                                                        {isEditingCell(tx.id, 'fee') ? (
                                                            <Input
                                                                ref={editInputRef as React.RefObject<HTMLInputElement>}
                                                                size="xs"
                                                                type="number"
                                                                step="any"
                                                                value={editValues.fee ?? tx.fee ?? ''}
                                                                onChange={e => updateEditValues({ fee: parseFloat(e.target.value) || 0 })}
                                                                onKeyDown={e => {
                                                                    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                                                                    else if (e.key === 'Enter') { e.preventDefault(); saveFieldDirectly(tx.id, 'fee', editValuesRef.current.fee); }
                                                                }}
                                                                onBlur={() => !escapePressedRef.current && saveFieldDirectly(tx.id, 'fee', editValuesRef.current.fee)}
                                                                width="60px"
                                                                fontSize="8px"
                                                                px={1}
                                                            />
                                                        ) : (
                                                            <Text fontSize="8px">{tx.fee ? tx.fee.toFixed(4) : '-'}</Text>
                                                        )}
                                                        {isEditingCell(tx.id, 'fee_quote_asset_id') ? (
                                                            <Box minW="70px">
                                                                <AssetSelector
                                                                    value={editValues.fee_quote_asset_id ?? null}
                                                                    onChange={(assetId) => {
                                                                        if (!escapePressedRef.current) {
                                                                            updateEditValues({ fee_quote_asset_id: assetId ?? undefined });
                                                                            saveAndClose();
                                                                        }
                                                                    }}
                                                                    assets={assets}
                                                                    onAssetCreated={fetchAssets}
                                                                    defaultSymbol={tx.source_fee_quote_asset_symbol || ''}
                                                                    placeholder="Fee..."
                                                                    rawAssetSource={tx.source}
                                                                    rawAssetSymbol={tx.source_fee_quote_asset_symbol}
                                                                />
                                                            </Box>
                                                        ) : tx.linked_fee_quote_asset_symbol ? (
                                                            <Badge size="xs" colorPalette="cyan" cursor="pointer" onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'fee_quote_asset_id'); }}>{tx.linked_fee_quote_asset_symbol}</Badge>
                                                        ) : tx.source_fee_quote_asset_symbol ? (
                                                            <Text fontSize="8px" color="orange.500" fontWeight="bold" cursor="pointer" onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'fee_quote_asset_id'); }}>⚠ {tx.source_fee_quote_asset_symbol}</Text>
                                                        ) : null}
                                                    </Flex>
                                                </Table.Cell>
                                                {/* Taxable - always toggle, saves immediately */}
                                                <Table.Cell py={1}>
                                                    <Switch.Root
                                                        size="sm"
                                                        checked={tx.disposal_taxable ?? false}
                                                        onCheckedChange={() => quickToggle(tx, 'disposal_taxable')}
                                                    >
                                                        <Switch.HiddenInput />
                                                        <Switch.Control />
                                                    </Switch.Root>
                                                </Table.Cell>
                                                {/* Include Fee - always toggle, saves immediately */}
                                                <Table.Cell py={1}>
                                                    <Switch.Root
                                                        size="sm"
                                                        checked={tx.include_fee ?? false}
                                                        onCheckedChange={() => quickToggle(tx, 'include_fee')}
                                                    >
                                                        <Switch.HiddenInput />
                                                        <Switch.Control />
                                                    </Switch.Root>
                                                </Table.Cell>
                                                {/* Bundle - read only */}
                                                <Table.Cell py={1}>
                                                    {tx.user_calculation_unit_id ? <Badge size="sm" colorPalette="purple">📦 #{tx.user_calculation_unit_id}</Badge> : <Text fontSize="8px" color="gray.400">-</Text>}
                                                </Table.Cell>
                                                {/* Status - click to edit */}
                                                <Table.Cell position="sticky" right="30px" bg={getRowBgColor(tx)} zIndex={5} borderLeft="2px solid" borderColor="gray.300" onClick={() => !isEditingCell(tx.id, 'review_status') && startCellEdit(tx, 'review_status')} cursor="pointer">
                                                    {isEditingCell(tx.id, 'review_status') ? (
                                                        <NativeSelect.Root size="sm" width="70px">
                                                            <NativeSelect.Field
                                                                value={editValues.review_status || tx.review_status}
                                                                onChange={e => updateEditValues({ review_status: e.target.value as TransactionStatus })}
                                                                onKeyDown={handleEditKeyDown}
                                                                onBlur={saveAndClose}
                                                                style={{ fontSize: '8px', padding: '2px' }}
                                                            >
                                                                <option value="valid">Valid</option>
                                                                <option value="pending">Pending</option>
                                                                <option value="invalid">Invalid</option>
                                                            </NativeSelect.Field>
                                                        </NativeSelect.Root>
                                                    ) : (
                                                        <Badge size="sm" colorPalette={statusBadgeColors[tx.review_status] || 'gray'}>
                                                            {tx.review_status}
                                                        </Badge>
                                                    )}
                                                </Table.Cell>
                                                {/* Actions - show cancel when editing */}
                                                <Table.Cell position="sticky" right={0} bg={getRowBgColor(tx)} zIndex={5} minW="80px">
                                                    <Flex gap={1}>
                                                        {getEditingTxId() === tx.id ? (
                                                            <Button size="xs" variant="ghost" onClick={cancelEdit} title="Cancel (Esc)">
                                                                ✗
                                                            </Button>
                                                        ) : (
                                                            <>
                                                                <Button
                                                                    size="xs"
                                                                    variant="ghost"
                                                                    colorPalette="blue"
                                                                    onClick={() => {
                                                                        setTransactionToEdit(tx);
                                                                        setShowEditorDialog(true);
                                                                    }}
                                                                    title="Edit all fields"
                                                                >
                                                                    <LuPencil />
                                                                </Button>
                                                                <Button
                                                                    size="xs"
                                                                    variant="ghost"
                                                                    colorPalette="red"
                                                                    onClick={() => {
                                                                        setTransactionToDelete(tx);
                                                                        setShowDeleteDialog(true);
                                                                    }}
                                                                    title="Delete transaction"
                                                                >
                                                                    🗑️
                                                                </Button>
                                                            </>
                                                        )}
                                                    </Flex>
                                                </Table.Cell>
                                            </Table.Row>
                                            {expandedRow === tx.id && (
                                                <Table.Row>
                                                    <Table.Cell colSpan={20} p={0}>
                                                        <TransactionDetailPanel
                                                            transaction={tx}
                                                            accounts={accounts}
                                                            onNotesChange={async (txId, notes) => {
                                                                try {
                                                                    const response = await fetch(`${API_URL}/transactions/${txId}`, {
                                                                        method: 'PUT',
                                                                        headers: { 'Content-Type': 'application/json' },
                                                                        body: JSON.stringify({ review_notes: notes }),
                                                                    });
                                                                    if (response.ok) {
                                                                        queryClient.invalidateQueries({ queryKey: ['transactions'] });
                                                                        onDataChange?.();
                                                                    }
                                                                } catch (err) {
                                                                    console.error('Failed to update notes:', err);
                                                                }
                                                            }}
                                                            onTagsChange={async (txId, tags) => {
                                                                try {
                                                                    const response = await fetch(`${API_URL}/transactions/${txId}`, {
                                                                        method: 'PUT',
                                                                        headers: { 'Content-Type': 'application/json' },
                                                                        body: JSON.stringify({ tags }),
                                                                    });
                                                                    if (response.ok) {
                                                                        queryClient.invalidateQueries({ queryKey: ['transactions'] });
                                                                        onDataChange?.();
                                                                    }
                                                                } catch (err) {
                                                                    console.error('Failed to update tags:', err);
                                                                }
                                                            }}
                                                        />
                                                    </Table.Cell>
                                                </Table.Row>
                                            )}
                                        </React.Fragment>
                                    ))
                                )}
                            </Table.Body>
                        </Table.Root>
                    </Box>

                    {/* Pagination Controls */}
                    {
                        totalPages > 1 && (
                            <Flex justify="center" align="center" mt={4} gap={2}>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => goToPage(1)}
                                    disabled={currentPage === 1}
                                >
                                    ⟪
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => goToPage(currentPage - 1)}
                                    disabled={currentPage === 1}
                                >
                                    ←
                                </Button>

                                {/* Page numbers */}
                                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                                    let pageNum: number;
                                    if (totalPages <= 5) {
                                        pageNum = i + 1;
                                    } else if (currentPage <= 3) {
                                        pageNum = i + 1;
                                    } else if (currentPage >= totalPages - 2) {
                                        pageNum = totalPages - 4 + i;
                                    } else {
                                        pageNum = currentPage - 2 + i;
                                    }
                                    return (
                                        <Button
                                            key={pageNum}
                                            size="sm"
                                            variant={currentPage === pageNum ? 'solid' : 'outline'}
                                            colorPalette={currentPage === pageNum ? 'blue' : undefined}
                                            onClick={() => goToPage(pageNum)}
                                        >
                                            {pageNum}
                                        </Button>
                                    );
                                })}

                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => goToPage(currentPage + 1)}
                                    disabled={currentPage === totalPages}
                                >
                                    →
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => goToPage(totalPages)}
                                    disabled={currentPage === totalPages}
                                >
                                    ⟫
                                </Button>
                            </Flex>
                        )
                    }

                    <Box mt={4} p={4} bg="white" borderRadius="md" boxShadow="sm">
                        <Text fontSize="sm" color="gray.600">
                            <strong>Total:</strong> {transactions.length} transactions
                            {totalPages > 1 && (
                                <Text as="span"> • Page <strong>{currentPage}</strong> of <strong>{totalPages}</strong> (showing {startIndex + 1}-{Math.min(endIndex, transactions.length)})</Text>
                            )}
                            {selectedIds.size > 0 && <Text as="span"> • <strong>{selectedIds.size}</strong> selected</Text>}
                            {workflowFilter && <Text as="span"> • Filtered by workflow: <strong>{workflowFilter}</strong></Text>}
                            {sourceFilter && <Text as="span"> • Filtered by source: <strong>{sourceFilter}</strong></Text>}
                        </Text>
                    </Box>
                </>
            )}

            {/* Create Bundle Dialog */}
            <Dialog.Root open={showBundleDialog} onOpenChange={(e) => setShowBundleDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>Create Transaction Bundle</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Text mb={4}>
                                    Create a bundle for {selectedIds.size} selected transaction(s):
                                    <br />
                                    <Text as="span" fontWeight="bold" color="purple.600">
                                        IDs: {Array.from(selectedIds).join(', ')}
                                    </Text>
                                </Text>
                                <Input
                                    placeholder="Enter bundle label (e.g., 'ETH Transfer to Ledger')"
                                    value={bundleLabel}
                                    onChange={e => setBundleLabel(e.target.value)}
                                />
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => setShowBundleDialog(false)}>
                                        Cancel
                                    </Button>
                                    <Button colorPalette="purple" onClick={createBundle} disabled={!bundleLabel.trim()}>
                                        Create Bundle
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* Bulk Set Status Dialog */}
            <Dialog.Root open={showBulkStatusDialog} onOpenChange={(e) => setShowBulkStatusDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>Set Status for Selected Transactions</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Text mb={4}>
                                    Set status for {selectedIds.size} transaction(s)
                                </Text>
                                <NativeSelect.Root>
                                    <NativeSelect.Field
                                        value={bulkStatus}
                                        onChange={e => setBulkStatus(e.target.value as TransactionStatus)}
                                    >
                                        <option value="valid">Valid</option>
                                        <option value="pending">Pending</option>
                                        <option value="invalid">Invalid</option>
                                    </NativeSelect.Field>
                                </NativeSelect.Root>
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => setShowBulkStatusDialog(false)}>
                                        Cancel
                                    </Button>
                                    <Button colorPalette="green" onClick={bulkUpdateStatus} disabled={bulkActionLoading}>
                                        {bulkActionLoading ? 'Updating...' : 'Apply Status'}
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* Bulk Set Type Dialog */}
            <Dialog.Root open={showBulkTypeDialog} onOpenChange={(e) => setShowBulkTypeDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>Set Transaction Type for Selected</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Text mb={4}>
                                    Set transaction type for {selectedIds.size} transaction(s)
                                </Text>
                                <ComboSelect
                                    value={bulkType}
                                    onChange={val => setBulkType(val)}
                                    options={TRANSACTION_TYPE_OPTIONS}
                                    placeholder="Select transaction type..."
                                    width="100%"
                                />
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => { setShowBulkTypeDialog(false); setBulkType(''); }}>
                                        Cancel
                                    </Button>
                                    <Button colorPalette="purple" onClick={bulkUpdateType} disabled={bulkActionLoading || !bulkType}>
                                        {bulkActionLoading ? 'Updating...' : 'Apply Type'}
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* Bulk Delete Dialog */}
            <Dialog.Root open={showBulkDeleteDialog} onOpenChange={(e) => setShowBulkDeleteDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>Delete Selected Transactions</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Text color="red.600" fontWeight="bold" mb={2}>
                                    ⚠️ Warning: This action cannot be undone!
                                </Text>
                                <Text mb={4}>
                                    Are you sure you want to delete {selectedIds.size} transaction(s)?
                                </Text>
                                <Text fontSize="sm" color="gray.500">
                                    IDs: {Array.from(selectedIds).slice(0, 10).join(', ')}
                                    {selectedIds.size > 10 && ` ... and ${selectedIds.size - 10} more`}
                                </Text>
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => setShowBulkDeleteDialog(false)}>
                                        Cancel
                                    </Button>
                                    <Button colorPalette="red" onClick={bulkDelete} disabled={bulkActionLoading}>
                                        {bulkActionLoading ? 'Deleting...' : `Delete ${selectedIds.size} Transaction(s)`}
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* Delete Single Transaction Dialog */}
            <Dialog.Root open={showDeleteDialog} onOpenChange={(e) => setShowDeleteDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>Delete Transaction</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Text color="red.600" fontWeight="bold" mb={2}>
                                    ⚠️ Warning: This action cannot be undone!
                                </Text>
                                <Text mb={4}>
                                    Are you sure you want to delete this transaction?
                                </Text>
                                {transactionToDelete && (
                                    <Box p={3} bg="gray.50" borderRadius="md">
                                        <Text fontSize="sm"><strong>ID:</strong> {transactionToDelete.id}</Text>
                                        <Text fontSize="sm"><strong>Date:</strong> {formatDateTime(transactionToDelete.date_time)}</Text>
                                        <Text fontSize="sm"><strong>Type:</strong> {transactionToDelete.transaction_type}</Text>
                                        <Text fontSize="sm"><strong>Quantity:</strong> {transactionToDelete.quantity} {transactionToDelete.source_asset_symbol}</Text>
                                    </Box>
                                )}
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
                                        Cancel
                                    </Button>
                                    <Button colorPalette="red" onClick={handleDeleteTransaction} disabled={bulkActionLoading}>
                                        {bulkActionLoading ? 'Deleting...' : 'Delete Transaction'}
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* Transaction Editor Dialog */}
            <TransactionEditorDialog
                transaction={transactionToEdit}
                isOpen={showEditorDialog}
                onClose={() => {
                    setShowEditorDialog(false);
                    setTransactionToEdit(null);
                }}
            />
        </Box >
    );
};
