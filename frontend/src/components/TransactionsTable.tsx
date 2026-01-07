import {
    Badge, Box,
    Button, Card, Checkbox, Collapsible, Dialog, Flex,
    Heading, HStack, Input, NativeSelect, Portal, Spinner,
    Switch, Table, Tabs, Text, Progress
} from '@chakra-ui/react';
import { BiTransfer } from 'react-icons/bi';
import { RiExchangeFundsLine } from 'react-icons/ri';
import { FaQuestion } from 'react-icons/fa';
import { LuPencil, LuUpload } from 'react-icons/lu';
import { FiActivity, FiFileText } from 'react-icons/fi';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL, Account, Asset, Bundle, BundleSuggestion, Transaction, TransactionStatus, WorkflowStatus, TaxabilityStatus, ValidationSummary } from '../types';
import { Direction, ReviewStatus, TaxabilityStatus as TaxabilityStatusEnum, UnitPattern } from '../enums';
import { AssetSelector } from './AssetSelector';
import { AccountSelector } from './AccountSelector';
import { ACCOUNT_OPTIONS, ComboSelect, TRANSACTION_TYPE_OPTIONS } from './ComboSelect';
import { TransactionEditorDialog } from './TransactionEditorDialog';
import { BundleTransactionList } from './BundleTransactionList';
import { BundleTable } from './BundleTable';
import { TransactionDetailDrawer } from './TransactionDetailDrawer';
import { TransactionFilters, TransactionFilterState, defaultFilterState } from './TransactionFilters';
import { DataHealthCheckDrawer } from './DataHealthCheckDrawer';
import { toaster } from './ui/toaster';
import { Tooltip } from './ui/tooltip';
import { AssetBadge } from './AssetBadge';
import { AccountBadge } from './AccountBadge';
import { getAccountSuggestions, getAssetSuggestions, getConfidenceColor, formatConfidence, SuggestedMatch } from '../utils/similarity';
import {
    formatDateTimeCompact,
    toDateTimeLocalString,
    dateTimeLocalToISO,
} from '../utils/dateUtils';

// Types for CSV import
interface TradesImportPreviewTransaction {
    date_time: string | null;
    transaction_type: string;
    asset_ticker: string;
    asset_label: string;
    quantity: number | null;
    price: number | null;
    fee: number | null;
    account_code: string;
    is_fee_transaction: boolean;
}

interface TradesImportPreview {
    filename: string;
    transactions_count: number;
    accounts_count: number;
    assets_count: number;
    fee_transactions_count: number;
    errors: { row: number; error: string }[];
    warnings: string[];
    transactions: TradesImportPreviewTransaction[];
    accounts: string[];
    assets: string[];
}

interface TradesImportResult {
    transactions: { created: number; skipped: number; errors: any[] };
    raw_accounts: { created: number; skipped: number; errors: any[] };
    raw_assets: { created: number; skipped: number; errors: any[] };
    pending_review_count: number;
    parse_errors: any[];
    warnings: string[];
    dry_run: boolean;
    summary: { total_transactions: number; total_raw_accounts: number; total_raw_assets: number; total_errors: number };
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 200];
const DEFAULT_PAGE_SIZE = 25;

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

// SourceInfoCell - Merged cell displaying Source Account + Source + Source Type + Source Symbol
interface SourceInfoCellProps {
    sourceAccount?: string;      // Raw source_account field
    accountId?: number | null;   // Resolved account_id (to show warning if missing)
    resolvedAccount?: Account;   // Full resolved account object
    resolvedAccountName?: string; // Resolved account name for display
    source: string;
    sourceType?: string;
    sourceSymbol?: string;
    onClick?: () => void;
    /** Account suggestions for quick linking */
    accountSuggestions?: SuggestedMatch<Account>[];
    /** Callback to accept a suggested account */
    onAcceptSuggestion?: (accountId: number) => void;
}

const SourceInfoCell: React.FC<SourceInfoCellProps> = ({
    sourceAccount,
    accountId,
    resolvedAccount,
    resolvedAccountName,
    source,
    sourceType,
    sourceSymbol,
    onClick,
    accountSuggestions = [],
    onAcceptSuggestion,
}) => {
    // Build the secondary line: source · type · symbol (only non-empty parts)
    const parts = [
        source,
        sourceType,
        sourceSymbol
    ].filter(Boolean);
    const secondaryText = parts.join(' · ');

    // Determine if account is linked (resolved)
    const isAccountLinked = accountId != null;

    return (
        <Flex
            direction="column"
            gap={0}
            minW="100px"
            maxW="180px"
        >
            {/* Primary line: Account - show resolved badge or warning with source */}
            {isAccountLinked ? (
                <AccountBadge
                    account={resolvedAccount}
                    accountId={accountId}
                    accountName={resolvedAccountName}
                    size="sm"
                    maxLength={18}
                    onClick={onClick}
                />
            ) : (
                <Flex direction="column" gap={1}>
                    <Text
                        fontSize="8px"
                        color="orange.500"
                        fontWeight="bold"
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                        cursor="pointer"
                        onClick={onClick}
                        title={sourceAccount ? `Unlinked: ${sourceAccount}` : 'No account linked'}
                    >
                        ⚠ {sourceAccount || 'Link'}
                    </Text>
                    {/* Show compact suggestion chips for unlinked accounts */}
                    {accountSuggestions.length > 0 && (
                        <HStack gap={1} flexWrap="wrap">
                            {accountSuggestions.slice(0, 2).map((s, idx) => (
                                <Tooltip
                                    key={idx}
                                    content={`${formatConfidence(s.confidence)} match - Click to link`}
                                    openDelay={100}
                                >
                                    <Badge
                                        size="xs"
                                        colorPalette={getConfidenceColor(s.confidence)}
                                        variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                        cursor="pointer"
                                        fontSize="7px"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onAcceptSuggestion?.(s.item.id);
                                        }}
                                    >
                                        {s.item.name.slice(0, 10)}{s.item.name.length > 10 ? '…' : ''}
                                        {s.confidence >= 0.9 && ' ✓'}
                                    </Badge>
                                </Tooltip>
                            ))}
                        </HStack>
                    )}
                </Flex>
            )}
            {/* Secondary line: source · type · symbol */}
            <Text
                fontSize="7px"
                color="gray.500"
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
                title={secondaryText}
                mt="1px"
            >
                {secondaryText || '-'}
            </Text>
        </Flex>
    );
};

// Date formatting utilities imported from utils/dateUtils

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
    const [suggestionTaxabilityOverrides, setSuggestionTaxabilityOverrides] = useState<Record<number, TaxabilityStatus>>({});
    const [assets, setAssets] = useState<Asset[]>([]);
    const [accounts, setAccounts] = useState<Account[]>([]);
    // Cell-level editing: "txId:field" format, e.g., "123:account"
    const [editingCell, setEditingCell] = useState<string | null>(null);
    const [editValues, setEditValues] = useState<Partial<Transaction>>({});
    const editInputRef = useRef<HTMLInputElement | HTMLSelectElement>(null);
    const editValuesRef = useRef<Partial<Transaction>>({});
    const escapePressedRef = useRef(false);
    // New unified filter state
    const [filters, setFilters] = useState<TransactionFilterState>(() => ({
        ...defaultFilterState,
        reviewStatus: defaultWorkflowFilter ? [defaultWorkflowFilter] : [],
    }));
    // Pagination items per page
    const [itemsPerPage, setItemsPerPage] = useState<number>(DEFAULT_PAGE_SIZE);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [showBundleDialog, setShowBundleDialog] = useState(false);
    const [bundleLabel, setBundleLabel] = useState('');
    // Transaction detail drawer state (replaces expandedRow)
    const [drawerTransactionId, setDrawerTransactionId] = useState<number | null>(null);
    const [isDrawerOpen, setIsDrawerOpen] = useState(false);
    const [bundlesExpanded, setBundlesExpanded] = useState(true);
    const [suggestionsExpanded, setSuggestionsExpanded] = useState(true);
    const [viewMode, setViewMode] = useState<'transactions' | 'bundles'>('transactions');

    // Data Health Check drawer state
    const [isHealthCheckOpen, setIsHealthCheckOpen] = useState(false);
    const [validationSummary, setValidationSummary] = useState<ValidationSummary | null>(null);
    const [healthCheckRefreshTrigger, setHealthCheckRefreshTrigger] = useState(0);

    // Bulk action states
    const [bulkActionLoading, setBulkActionLoading] = useState(false);
    const [showBulkStatusDialog, setShowBulkStatusDialog] = useState(false);
    const [showBulkTypeDialog, setShowBulkTypeDialog] = useState(false);
    const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
    const [bulkStatus, setBulkStatus] = useState<TransactionStatus>(ReviewStatus.VALID);
    const [bulkType, setBulkType] = useState<string>('');
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const [transactionToDelete, setTransactionToDelete] = useState<Transaction | null>(null);

    // Deletion impact check
    const [deletionImpact, setDeletionImpact] = useState<Record<string, number>>({});
    const [isImpactLoading, setIsImpactLoading] = useState(false);

    const fetchDeletionImpact = async (ids: number[]) => {
        setIsImpactLoading(true);
        setDeletionImpact({});
        try {
            const response = await fetch(`${API_URL}/transactions/bulk/check-linked`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transaction_ids: ids })
            });
            if (response.ok) {
                const data = await response.json();
                setDeletionImpact(data);
            }
        } catch (err) {
            console.error('Failed to fetch deletion impact:', err);
        } finally {
            setIsImpactLoading(false);
        }
    };

    // Transaction editor dialog state
    const [showEditorDialog, setShowEditorDialog] = useState(false);
    const [transactionToEdit, setTransactionToEdit] = useState<Transaction | null>(null);

    // CSV Import state
    const [showImportDialog, setShowImportDialog] = useState(false);
    const [importFile, setImportFile] = useState<File | null>(null);
    const [importPreview, setImportPreview] = useState<TradesImportPreview | null>(null);
    const [importResult, setImportResult] = useState<TradesImportResult | null>(null);
    const [importLoading, setImportLoading] = useState(false);
    const [importStep, setImportStep] = useState<'select' | 'preview' | 'result'>('select');
    const [dryRunMode, setDryRunMode] = useState(true);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Pagination state
    const [currentPage, setCurrentPage] = useState(1);

    // TanStack Query for transactions - filters are part of the query key
    const { data: transactions = [], isLoading: loading, error: queryError, refetch: refetchTransactions } = useQuery({
        queryKey: ['transactions', filters],
        queryFn: async () => {
            const params = new URLSearchParams();
            // Apply review status filter (support multiple via comma-separated)
            if (filters.reviewStatus.length > 0) {
                // If only one, use it directly; otherwise API doesn't support multiple review_status currently
                // So we just take the first one for now (or could send comma-separated if backend supports)
                params.append('review_status', filters.reviewStatus[0]);
            }
            if (filters.taxability.length > 0) {
                params.append('taxability', filters.taxability.join(','));
            }
            if (filters.sources.length > 0) {
                params.append('source', filters.sources.join(','));
            }
            if (filters.accountIds.length > 0) {
                params.append('account_id', filters.accountIds.join(','));
            }
            if (filters.assetIds.length > 0) {
                params.append('asset_id', filters.assetIds.join(','));
            }
            if (filters.categoryIds.length > 0) {
                params.append('category_id', filters.categoryIds.join(','));
            }
            if (filters.transactionTypes.length > 0) {
                params.append('transaction_type', filters.transactionTypes.join(','));
            }
            if (filters.directions.length > 0) {
                params.append('direction', filters.directions.join(','));
            }
            if (filters.dateFrom) {
                params.append('date_from', filters.dateFrom);
            }
            if (filters.dateTo) {
                params.append('date_to', filters.dateTo);
            }
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
    useEffect(() => { setCurrentPage(1); }, [filters]);

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

    // Fetch validation summary for Data Health Check badge
    const fetchValidationSummary = async () => {
        try {
            const response = await fetch(`${API_URL}/transactions/data-health-check`);
            if (response.ok) {
                const data: ValidationSummary = await response.json();
                setValidationSummary(data);
            }
        } catch (err) {
            console.error('Failed to fetch validation summary:', err);
        }
    };

    // Fetch validation summary on mount and when data changes
    useEffect(() => {
        fetchValidationSummary();
    }, []);

    const acceptSuggestion = async (suggestion: BundleSuggestion, idx: number) => {
        try {
            // Use override if set, otherwise use the suggestion's taxability
            const taxabilityOverride = suggestionTaxabilityOverrides[idx] ?? suggestion.taxability_suggestion;
            const response = await fetch(`${API_URL}/bundles/accept-suggestion`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pattern: suggestion.pattern,
                    transaction_ids: suggestion.transactions.map(t => t.id),
                    label: suggestion.label,
                    taxability_override: taxabilityOverride,
                }),
            });
            if (response.ok) {
                queryClient.invalidateQueries({ queryKey: ['transactions'] });
                await fetchBundles();
                await fetchSuggestions();
                // Clear override for this suggestion
                setSuggestionTaxabilityOverrides(prev => {
                    const newOverrides = { ...prev };
                    delete newOverrides[idx];
                    return newOverrides;
                });
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
    const totalPages = Math.ceil(transactions.length / itemsPerPage);
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const paginatedTransactions = transactions.slice(startIndex, endIndex);

    const goToPage = (page: number) => {
        if (page >= 1 && page <= totalPages) {
            setCurrentPage(page);
            // Close drawer when changing pages
            setIsDrawerOpen(false);
            setDrawerTransactionId(null);
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
            // Convert date_time to ISO format if it's a local datetime string
            const payload = { ...values };
            if (typeof payload.date_time === 'string' && payload.date_time && !payload.date_time.includes('Z')) {
                payload.date_time = dateTimeLocalToISO(payload.date_time);
            }

            const response = await fetch(`${API_URL}/transactions/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
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

    // CSV Import handlers
    const openImportDialog = () => {
        setShowImportDialog(true);
        setImportStep('select');
        setImportFile(null);
        setImportPreview(null);
        setImportResult(null);
        setDryRunMode(true);
    };

    const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) {
            setImportFile(file);
        }
    };

    const handleFileDrop = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        const file = event.dataTransfer.files?.[0];
        if (file && file.name.endsWith('.csv')) {
            setImportFile(file);
        } else {
            toaster.error({ title: 'Invalid file', description: 'Please drop a CSV file' });
        }
    };

    const previewImport = async () => {
        if (!importFile) return;
        setImportLoading(true);
        try {
            const formData = new FormData();
            formData.append('file', importFile);

            const response = await fetch(`${API_URL}/transactions/import-csv/preview`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Preview failed');
            }

            const data: TradesImportPreview = await response.json();
            setImportPreview(data);
            setImportStep('preview');
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to preview CSV' });
        } finally {
            setImportLoading(false);
        }
    };

    const executeImport = async () => {
        if (!importFile) return;
        setImportLoading(true);
        try {
            const formData = new FormData();
            formData.append('file', importFile);

            const params = new URLSearchParams();
            params.append('dry_run', String(dryRunMode));

            const response = await fetch(`${API_URL}/transactions/import-csv?${params}`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Import failed');
            }

            const data: TradesImportResult = await response.json();
            setImportResult(data);
            setImportStep('result');

            // Refresh transactions list if not a dry run
            if (!dryRunMode) {
                queryClient.invalidateQueries({ queryKey: ['transactions'] });
                fetchValidationSummary();
                setHealthCheckRefreshTrigger(prev => prev + 1);
                onDataChange?.();
            }
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to import CSV' });
        } finally {
            setImportLoading(false);
        }
    };

    const resetImportDialog = () => {
        setImportStep('select');
        setImportFile(null);
        setImportPreview(null);
        setImportResult(null);
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    // Using formatDateTimeCompact from dateUtils for consistent date formatting

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
        // Force refetch the transactions query directly
        refetchTransactions();
        // Always refresh bundles in "All" tab (showBundles=true means we're in All tab)
        if (showBundles) {
            fetchBundles();
            fetchSuggestions();
        }
        if (showSuggestions) fetchSuggestions();
        // Refresh validation summary for Data Health Check
        fetchValidationSummary();
        setHealthCheckRefreshTrigger(prev => prev + 1);
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
                    {/* Data Health Check Button */}
                    <Tooltip content="Check data completeness for P&L calculations">
                        <Button
                            onClick={() => setIsHealthCheckOpen(true)}
                            variant="outline"
                            colorPalette={validationSummary?.has_issues ? 'orange' : 'green'}
                        >
                            <FiActivity />
                            {validationSummary?.has_issues ? (
                                <Badge colorPalette="orange" size="sm" ml={1}>
                                    {validationSummary.total_issues}
                                </Badge>
                            ) : (
                                <Text ml={1} fontSize="sm">✓</Text>
                            )}
                        </Button>
                    </Tooltip>
                    <Button onClick={handleRefresh} variant="outline">
                        🔄 Refresh
                    </Button>
                </Flex>
            </Flex>

            {/* Data Health Check Drawer */}
            <DataHealthCheckDrawer
                isOpen={isHealthCheckOpen}
                onClose={() => setIsHealthCheckOpen(false)}
                refreshTrigger={healthCheckRefreshTrigger}
                assets={assets}
                accounts={accounts}
                onAssetsUpdated={fetchAssets}
                onAccountsUpdated={fetchAccounts}
                onNavigateToPendingTransactions={() => {
                    setFilters(prev => ({ ...prev, reviewStatus: ['pending'] }));
                    setIsHealthCheckOpen(false);
                }}
                onNavigateToBundleSuggestions={() => {
                    setViewMode('bundles');
                    setIsHealthCheckOpen(false);
                }}
            />

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
                                    {suggestions.map((suggestion, idx) => {
                                        const currentTaxability = suggestionTaxabilityOverrides[idx] ?? suggestion.taxability_suggestion;
                                        return (
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
                                                    {/* Taxability Selector */}
                                                    <Box mt={2} pt={2} borderTopWidth={1} borderColor="gray.100">
                                                        <Flex align="center" gap={2}>
                                                            <Text fontSize="xs" color="gray.500">Taxability:</Text>
                                                            <NativeSelect.Root size="sm" width="100px">
                                                                <NativeSelect.Field
                                                                    value={currentTaxability || TaxabilityStatusEnum.UNKNOWN}
                                                                    onChange={e => {
                                                                        setSuggestionTaxabilityOverrides(prev => ({
                                                                            ...prev,
                                                                            [idx]: e.target.value as TaxabilityStatus,
                                                                        }));
                                                                    }}
                                                                    onClick={e => e.stopPropagation()}
                                                                    style={{
                                                                        fontSize: '10px',
                                                                        padding: '2px 4px',
                                                                        backgroundColor: currentTaxability === TaxabilityStatusEnum.TAXABLE ? '#FED7AA' :
                                                                            currentTaxability === TaxabilityStatusEnum.NON_TAXABLE ? '#C6F6D5' : '#FEFCBF',
                                                                        borderRadius: '4px',
                                                                    }}
                                                                >
                                                                    <option value={TaxabilityStatusEnum.UNKNOWN}>Unknown</option>
                                                                    <option value={TaxabilityStatusEnum.TAXABLE}>Taxable</option>
                                                                    <option value={TaxabilityStatusEnum.NON_TAXABLE}>Non-Tax</option>
                                                                </NativeSelect.Field>
                                                            </NativeSelect.Root>
                                                        </Flex>
                                                    </Box>
                                                    {/* Expandable Transaction List */}
                                                    <Box mt={2} pt={2} borderTopWidth={1} borderColor="gray.100">
                                                        <Text fontSize="xs" color="gray.500" mb={1}>
                                                            {suggestion.transactions.length} transaction{suggestion.transactions.length !== 1 ? 's' : ''}:
                                                        </Text>
                                                        <BundleTransactionList
                                                            transactions={suggestion.transactions}
                                                            maxVisible={3}
                                                            colorScheme="teal"
                                                            onTransactionClick={(txId) => {
                                                                setDrawerTransactionId(txId);
                                                                setIsDrawerOpen(true);
                                                            }}
                                                        />
                                                    </Box>
                                                    <Flex mt={3} gap={2}>
                                                        <Button
                                                            size="xs"
                                                            colorPalette="green"
                                                            onClick={(e) => { e.stopPropagation(); acceptSuggestion(suggestion, idx); }}
                                                        >
                                                            ✓ Create Bundle
                                                        </Button>
                                                        <Button size="xs" variant="ghost">Dismiss</Button>
                                                    </Flex>
                                                </Card.Body>
                                            </Card.Root>
                                        );
                                    })}
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
                                onClick={() => {
                                    fetchDeletionImpact(Array.from(selectedIds));
                                    setShowBulkDeleteDialog(true);
                                }}
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
                                            {suggestions.map((suggestion, idx) => {
                                                const currentTaxability = suggestionTaxabilityOverrides[idx] ?? suggestion.taxability_suggestion;
                                                return (
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
                                                            {/* Taxability Selector */}
                                                            <Box mt={2} pt={2} borderTopWidth={1} borderColor="gray.100">
                                                                <Flex align="center" gap={2}>
                                                                    <Text fontSize="xs" color="gray.500">Taxability:</Text>
                                                                    <NativeSelect.Root size="sm" width="100px">
                                                                        <NativeSelect.Field
                                                                            value={currentTaxability || TaxabilityStatusEnum.UNKNOWN}
                                                                            onChange={e => {
                                                                                setSuggestionTaxabilityOverrides(prev => ({
                                                                                    ...prev,
                                                                                    [idx]: e.target.value as TaxabilityStatus,
                                                                                }));
                                                                            }}
                                                                            onClick={e => e.stopPropagation()}
                                                                            style={{
                                                                                fontSize: '10px',
                                                                                padding: '2px 4px',
                                                                                backgroundColor: currentTaxability === TaxabilityStatusEnum.TAXABLE ? '#FED7AA' :
                                                                                    currentTaxability === TaxabilityStatusEnum.NON_TAXABLE ? '#C6F6D5' : '#FEFCBF',
                                                                                borderRadius: '4px',
                                                                            }}
                                                                        >
                                                                            <option value={TaxabilityStatusEnum.UNKNOWN}>Unknown</option>
                                                                            <option value={TaxabilityStatusEnum.TAXABLE}>Taxable</option>
                                                                            <option value={TaxabilityStatusEnum.NON_TAXABLE}>Non-Tax</option>
                                                                        </NativeSelect.Field>
                                                                    </NativeSelect.Root>
                                                                </Flex>
                                                            </Box>
                                                            {/* Expandable Transaction List */}
                                                            <Box mt={2} pt={2} borderTopWidth={1} borderColor="gray.100">
                                                                <Text fontSize="xs" color="gray.500" mb={1}>
                                                                    {suggestion.transactions.length} transaction{suggestion.transactions.length !== 1 ? 's' : ''}:
                                                                </Text>
                                                                <BundleTransactionList
                                                                    transactions={suggestion.transactions}
                                                                    maxVisible={3}
                                                                    colorScheme="teal"
                                                                    onTransactionClick={(txId) => {
                                                                        setDrawerTransactionId(txId);
                                                                        setIsDrawerOpen(true);
                                                                    }}
                                                                />
                                                            </Box>
                                                            <Flex mt={3} gap={2}>
                                                                <Button
                                                                    size="xs"
                                                                    colorPalette="green"
                                                                    onClick={(e) => { e.stopPropagation(); acceptSuggestion(suggestion, idx); }}
                                                                >
                                                                    ✓ Create Bundle
                                                                </Button>
                                                                <Button size="xs" variant="ghost">Dismiss</Button>
                                                            </Flex>
                                                        </Card.Body>
                                                    </Card.Root>
                                                );
                                            })}
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
                            onTransactionClick={(txId) => {
                                setDrawerTransactionId(txId);
                                setIsDrawerOpen(true);
                            }}
                        />
                    </Tabs.Content>
                </Tabs.Root>
            )}

            {/* Only show transactions when in transactions view mode (or when bundles tab is not shown) */}
            {(!showBundles || viewMode === 'transactions') && (
                <>
                    {showFilters && (
                        <TransactionFilters
                            filters={filters}
                            onChange={setFilters}
                            onClear={() => setFilters({ ...defaultFilterState, reviewStatus: defaultWorkflowFilter ? [defaultWorkflowFilter] : [] })}
                        />
                    )}

                    {/* Legend */}
                    <Flex mb={4} gap={3} align="center" flexWrap="wrap">
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

                    <Box overflowX="auto" bg="white" borderRadius="md" boxShadow="sm" css={{ fontSize: '8px' }} position="relative">
                        <Table.Root size="sm" variant="line">
                            <Table.Header css={{ fontSize: '9px' }}>
                                <Table.Row>
                                    <Table.ColumnHeader position="sticky" left={0} bg="gray.100" zIndex={10} minW="50px" borderRight="2px solid" borderColor="gray.300">
                                        <Checkbox.Root
                                            checked={allCurrentPageSelected}
                                            onCheckedChange={toggleSelectAll}
                                        >
                                            <Checkbox.HiddenInput />
                                            <Checkbox.Control />
                                        </Checkbox.Root>
                                    </Table.ColumnHeader>
                                    <Table.ColumnHeader>ID</Table.ColumnHeader>
                                    <Table.ColumnHeader>Date/Time</Table.ColumnHeader>
                                    <Table.ColumnHeader minW="100px">Source Info</Table.ColumnHeader>
                                    <Table.ColumnHeader>Dir</Table.ColumnHeader>
                                    <Table.ColumnHeader>Type</Table.ColumnHeader>
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
                                        <Table.Cell colSpan={17}>
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
                                                    <Flex gap={1} align="center">
                                                        <Checkbox.Root
                                                            checked={selectedIds.has(tx.id)}
                                                            onCheckedChange={() => toggleSelection(tx.id)}
                                                        >
                                                            <Checkbox.HiddenInput />
                                                            <Checkbox.Control />
                                                        </Checkbox.Root>
                                                        {/* Details button - opens drawer */}
                                                        <Button
                                                            size="xs"
                                                            variant="ghost"
                                                            onClick={() => {
                                                                setDrawerTransactionId(tx.id);
                                                                setIsDrawerOpen(true);
                                                            }}
                                                            p={0}
                                                            minW="16px"
                                                            h="16px"
                                                            color="gray.400"
                                                            _hover={{ color: 'blue.500' }}
                                                            title="View transaction details"
                                                        >
                                                            <FiFileText size={12} />
                                                        </Button>
                                                    </Flex>
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
                                                            value={toDateTimeLocalString(editValues.date_time)}
                                                            onChange={e => updateEditValues({ date_time: e.target.value })}
                                                            onKeyDown={handleEditKeyDown}
                                                            onBlur={saveAndClose}
                                                            width="130px"
                                                            fontSize="8px"
                                                            px={1}
                                                        />
                                                    ) : (
                                                        <Text fontSize="8px">{formatDateTimeCompact(tx.date_time)}</Text>
                                                    )}
                                                </Table.Cell>
                                                {/* Source Info - merged column with Source Account, Source, Source Type, Source Symbol */}
                                                <Table.Cell py={1} cursor="pointer">
                                                    {isEditingCell(tx.id, 'account_id') ? (
                                                        <Flex direction="column" gap={1} minW="120px">
                                                            <AccountSelector
                                                                value={editValues.account_id ?? null}
                                                                onChange={(accountId) => {
                                                                    if (!escapePressedRef.current) {
                                                                        updateEditValues({ account_id: accountId ?? undefined });
                                                                        saveAndClose();
                                                                    }
                                                                }}
                                                                accounts={accounts}
                                                                onAccountCreated={fetchAccounts}
                                                                defaultName={tx.source_account || ''}
                                                                placeholder="Link account..."
                                                                rawAccountSource={tx.source}
                                                                rawAccountLabel={tx.source_account}
                                                            />
                                                            {/* Show asset suggestions below the selector when editing */}
                                                            {tx.source_account && !tx.account_id && (() => {
                                                                const suggestions = getAccountSuggestions(tx.source_account, accounts);
                                                                return suggestions.length > 0 ? (
                                                                    <HStack gap={1} flexWrap="wrap" mt={1}>
                                                                        <Text fontSize="7px" color="gray.500">Suggestions:</Text>
                                                                        {suggestions.map((s, idx) => (
                                                                            <Tooltip
                                                                                key={idx}
                                                                                content={`${formatConfidence(s.confidence)} match`}
                                                                                openDelay={100}
                                                                            >
                                                                                <Badge
                                                                                    size="xs"
                                                                                    colorPalette={getConfidenceColor(s.confidence)}
                                                                                    variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                                                    cursor="pointer"
                                                                                    fontSize="7px"
                                                                                    onClick={(e) => {
                                                                                        e.stopPropagation();
                                                                                        updateEditValues({ account_id: s.item.id });
                                                                                        saveAndClose();
                                                                                    }}
                                                                                >
                                                                                    {s.item.name.slice(0, 12)}{s.item.name.length > 12 ? '…' : ''}
                                                                                    {s.confidence >= 0.9 && ' ✓'}
                                                                                </Badge>
                                                                            </Tooltip>
                                                                        ))}
                                                                    </HStack>
                                                                ) : null;
                                                            })()}
                                                            {/* Secondary info shown when editing */}
                                                            <Text fontSize="7px" color="gray.400">
                                                                {[tx.source, tx.source_transaction_type].filter(Boolean).join(' · ')}
                                                            </Text>
                                                        </Flex>
                                                    ) : (
                                                        <SourceInfoCell
                                                            sourceAccount={tx.source_account}
                                                            accountId={tx.account_id}
                                                            resolvedAccount={accounts.find(a => a.id === tx.account_id)}
                                                            resolvedAccountName={accounts.find(a => a.id === tx.account_id)?.name}
                                                            source={tx.source}
                                                            sourceType={tx.source_transaction_type}
                                                            sourceSymbol={tx.source_asset_symbol}
                                                            onClick={() => startCellEdit(tx, 'account_id')}
                                                            accountSuggestions={
                                                                !tx.account_id && tx.source_account
                                                                    ? getAccountSuggestions(tx.source_account, accounts, 0.5, 2)
                                                                    : []
                                                            }
                                                            onAcceptSuggestion={async (accountId) => {
                                                                try {
                                                                    const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                        method: 'PATCH',
                                                                        headers: { 'Content-Type': 'application/json' },
                                                                        body: JSON.stringify({ account_id: accountId })
                                                                    });
                                                                    if (!response.ok) throw new Error('Failed to update');
                                                                    // Also link the raw_account if it exists
                                                                    if (tx.source_account) {
                                                                        try {
                                                                            await fetch(`${API_URL}/raw-accounts/${encodeURIComponent(tx.source)}/${encodeURIComponent(tx.source_account)}`, {
                                                                                method: 'PATCH',
                                                                                headers: { 'Content-Type': 'application/json' },
                                                                                body: JSON.stringify({ account_id: accountId })
                                                                            });
                                                                        } catch (linkErr) {
                                                                            console.warn('Failed to link raw account:', linkErr);
                                                                        }
                                                                    }
                                                                    queryClient.invalidateQueries({ queryKey: ['transactions'] });
                                                                } catch (err) {
                                                                    toaster.error({ title: 'Error', description: 'Failed to link account' });
                                                                }
                                                            }}
                                                        />
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
                                                {/* Linked Asset - click to edit */}
                                                <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'asset_id') && startCellEdit(tx, 'asset_id')} cursor="pointer">
                                                    {isEditingCell(tx.id, 'asset_id') ? (
                                                        <Flex direction="column" gap={1} minW="90px">
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
                                                            {/* Show asset suggestions when editing unlinked asset */}
                                                            {tx.source_asset_symbol && !tx.asset_id && (() => {
                                                                const suggestions = getAssetSuggestions(tx.source_asset_symbol, assets, 0.5, 3);
                                                                return suggestions.length > 0 ? (
                                                                    <HStack gap={1} flexWrap="wrap">
                                                                        <Text fontSize="7px" color="gray.500">Suggestions:</Text>
                                                                        {suggestions.map((s, idx) => (
                                                                            <Tooltip
                                                                                key={idx}
                                                                                content={`${formatConfidence(s.confidence)} match`}
                                                                                openDelay={100}
                                                                            >
                                                                                <Badge
                                                                                    size="xs"
                                                                                    colorPalette={getConfidenceColor(s.confidence)}
                                                                                    variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                                                    cursor="pointer"
                                                                                    fontSize="7px"
                                                                                    onClick={(e) => {
                                                                                        e.stopPropagation();
                                                                                        updateEditValues({ asset_id: s.item.asset_id });
                                                                                        saveAndClose();
                                                                                    }}
                                                                                >
                                                                                    {s.item.symbol.slice(0, 10)}{s.item.symbol.length > 10 ? '…' : ''}
                                                                                    {s.confidence >= 0.9 && ' ✓'}
                                                                                </Badge>
                                                                            </Tooltip>
                                                                        ))}
                                                                    </HStack>
                                                                ) : null;
                                                            })()}
                                                        </Flex>
                                                    ) : (
                                                        tx.linked_asset_symbol ? (
                                                            <AssetBadge
                                                                asset={tx.linked_asset}
                                                                size="sm"
                                                                colorPalette="purple"
                                                                maxLength={15}
                                                                onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'asset_id'); }}
                                                            />
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
                                                            <Flex direction="column" gap={1} minW="70px">
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
                                                                {/* Show asset suggestions when editing unlinked price quote asset */}
                                                                {tx.source_price_quote_asset_symbol && !tx.price_quote_asset_id && (() => {
                                                                    const suggestions = getAssetSuggestions(tx.source_price_quote_asset_symbol, assets, 0.5, 3);
                                                                    return suggestions.length > 0 ? (
                                                                        <HStack gap={1} flexWrap="wrap">
                                                                            {suggestions.map((s, idx) => (
                                                                                <Tooltip
                                                                                    key={idx}
                                                                                    content={`${formatConfidence(s.confidence)} match`}
                                                                                    openDelay={100}
                                                                                >
                                                                                    <Badge
                                                                                        size="xs"
                                                                                        colorPalette={getConfidenceColor(s.confidence)}
                                                                                        variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                                                        cursor="pointer"
                                                                                        fontSize="6px"
                                                                                        onClick={(e) => {
                                                                                            e.stopPropagation();
                                                                                            updateEditValues({ price_quote_asset_id: s.item.asset_id });
                                                                                            saveAndClose();
                                                                                        }}
                                                                                    >
                                                                                        {s.item.symbol.slice(0, 6)}{s.confidence >= 0.9 && '✓'}
                                                                                    </Badge>
                                                                                </Tooltip>
                                                                            ))}
                                                                        </HStack>
                                                                    ) : null;
                                                                })()}
                                                            </Flex>
                                                        ) : tx.linked_price_quote_asset_symbol ? (
                                                            <AssetBadge
                                                                asset={tx.price_quote_asset}
                                                                size="xs"
                                                                colorPalette="cyan"
                                                                maxLength={12}
                                                                onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'price_quote_asset_id'); }}
                                                            />
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
                                                            <Flex direction="column" gap={1} minW="70px">
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
                                                                {/* Show asset suggestions when editing unlinked fee quote asset */}
                                                                {tx.source_fee_quote_asset_symbol && !tx.fee_quote_asset_id && (() => {
                                                                    const suggestions = getAssetSuggestions(tx.source_fee_quote_asset_symbol, assets, 0.5, 3);
                                                                    return suggestions.length > 0 ? (
                                                                        <HStack gap={1} flexWrap="wrap">
                                                                            {suggestions.map((s, idx) => (
                                                                                <Tooltip
                                                                                    key={idx}
                                                                                    content={`${formatConfidence(s.confidence)} match`}
                                                                                    openDelay={100}
                                                                                >
                                                                                    <Badge
                                                                                        size="xs"
                                                                                        colorPalette={getConfidenceColor(s.confidence)}
                                                                                        variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                                                        cursor="pointer"
                                                                                        fontSize="6px"
                                                                                        onClick={(e) => {
                                                                                            e.stopPropagation();
                                                                                            updateEditValues({ fee_quote_asset_id: s.item.asset_id });
                                                                                            saveAndClose();
                                                                                        }}
                                                                                    >
                                                                                        {s.item.symbol.slice(0, 6)}{s.confidence >= 0.9 && '✓'}
                                                                                    </Badge>
                                                                                </Tooltip>
                                                                            ))}
                                                                        </HStack>
                                                                    ) : null;
                                                                })()}
                                                            </Flex>
                                                        ) : tx.linked_fee_quote_asset_symbol ? (
                                                            <AssetBadge
                                                                asset={tx.fee_quote_asset}
                                                                size="xs"
                                                                colorPalette="cyan"
                                                                maxLength={12}
                                                                onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'fee_quote_asset_id'); }}
                                                            />
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
                                                                        fetchDeletionImpact([tx.id]);
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

                                {/* Items per page selector */}
                                <Flex align="center" gap={2} ml={4}>
                                    <Text fontSize="sm" color="gray.600">Show:</Text>
                                    <NativeSelect.Root size="sm" width="80px">
                                        <NativeSelect.Field
                                            value={itemsPerPage}
                                            onChange={e => {
                                                setItemsPerPage(Number(e.target.value));
                                                setCurrentPage(1);
                                            }}
                                        >
                                            {PAGE_SIZE_OPTIONS.map(size => (
                                                <option key={size} value={size}>{size}</option>
                                            ))}
                                        </NativeSelect.Field>
                                    </NativeSelect.Root>
                                </Flex>
                            </Flex>
                        )
                    }

                    <Box mt={4} p={4} bg="white" borderRadius="md" boxShadow="sm">
                        <Flex justify="space-between" align="center">
                            <Text fontSize="sm" color="gray.600">
                                <strong>Total:</strong> {transactions.length} transactions
                                {totalPages > 1 && (
                                    <Text as="span"> • Page <strong>{currentPage}</strong> of <strong>{totalPages}</strong> (showing {startIndex + 1}-{Math.min(endIndex, transactions.length)})</Text>
                                )}
                                {selectedIds.size > 0 && <Text as="span"> • <strong>{selectedIds.size}</strong> selected</Text>}
                            </Text>
                        </Flex>
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
            <Dialog.Root
                open={showBulkDeleteDialog}
                onOpenChange={(e) => {
                    setShowBulkDeleteDialog(e.open);
                    if (!e.open) {
                        setDeletionImpact({});
                    }
                }}
            >
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

                                {isImpactLoading ? (
                                    <Flex align="center" gap={2} mt={4}>
                                        <Spinner size="xs" />
                                        <Text fontSize="xs" color="gray.500">Checking for linked data...</Text>
                                    </Flex>
                                ) : Object.keys(deletionImpact).length > 0 && (
                                    <Box mt={4} p={3} bg="orange.50" border="1px solid" borderColor="orange.200" borderRadius="md">
                                        <Text fontSize="xs" fontWeight="bold" color="orange.800" mb={1}>
                                            ⚠️ Linked objects that will also be deleted:
                                        </Text>
                                        <Flex direction="column" gap={0.5}>
                                            {Object.entries(deletionImpact).map(([key, count]) => (
                                                <Text key={key} fontSize="10px" color="orange.700">
                                                    • {count} {key.replace(/_/g, ' ')}
                                                </Text>
                                            ))}
                                        </Flex>
                                        <Text fontSize="10px" color="orange.800" mt={2} fontStyle="italic">
                                            This data is linked to these transaction(s) and will be removed due to cascade deletion.
                                        </Text>
                                    </Box>
                                )}
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
            <Dialog.Root
                open={showDeleteDialog}
                onOpenChange={(e) => {
                    setShowDeleteDialog(e.open);
                    if (!e.open) {
                        setTransactionToDelete(null);
                        setDeletionImpact({});
                    }
                }}
            >
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
                                        <Text fontSize="sm"><strong>Date:</strong> {formatDateTimeCompact(transactionToDelete.date_time)}</Text>
                                        <Text fontSize="sm"><strong>Type:</strong> {transactionToDelete.transaction_type}</Text>
                                        <Text fontSize="sm"><strong>Quantity:</strong> {transactionToDelete.quantity} {transactionToDelete.source_asset_symbol}</Text>
                                    </Box>
                                )}

                                {isImpactLoading ? (
                                    <Flex align="center" gap={2} mt={4}>
                                        <Spinner size="xs" />
                                        <Text fontSize="xs" color="gray.500">Checking for linked data...</Text>
                                    </Flex>
                                ) : Object.keys(deletionImpact).length > 0 && (
                                    <Box mt={4} p={3} bg="orange.50" border="1px solid" borderColor="orange.200" borderRadius="md">
                                        <Text fontSize="xs" fontWeight="bold" color="orange.800" mb={1}>
                                            ⚠️ Linked objects that will also be deleted:
                                        </Text>
                                        <Flex direction="column" gap={0.5}>
                                            {Object.entries(deletionImpact).map(([key, count]) => (
                                                <Text key={key} fontSize="10px" color="orange.700">
                                                    • {count} {key.replace(/_/g, ' ')}
                                                </Text>
                                            ))}
                                        </Flex>
                                        <Text fontSize="10px" color="orange.800" mt={2} fontStyle="italic">
                                            This data is linked to this transaction and will be removed due to cascade deletion.
                                        </Text>
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

            {/* CSV Import Dialog */}
            <Dialog.Root open={showImportDialog} onOpenChange={(e) => setShowImportDialog(e.open)} size="xl">
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content maxW="900px">
                            <Dialog.Header>
                                <Dialog.Title>Import Trades from CSV</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                {importStep === 'select' && (
                                    <Box>
                                        <Text mb={4}>
                                            Upload a CSV file with trades to import. The file should have columns for:
                                            Date, Transaction Type, Asset, Quantity, Unit Price, Trading Fees, Investment Account.
                                        </Text>
                                        <Box
                                            border="2px dashed"
                                            borderColor="gray.300"
                                            borderRadius="md"
                                            p={8}
                                            textAlign="center"
                                            onDrop={handleFileDrop}
                                            onDragOver={(e) => e.preventDefault()}
                                            bg={importFile ? 'green.50' : 'gray.50'}
                                            cursor="pointer"
                                            onClick={() => fileInputRef.current?.click()}
                                            _hover={{ borderColor: 'teal.400', bg: 'teal.50' }}
                                        >
                                            <input
                                                type="file"
                                                accept=".csv"
                                                onChange={handleFileSelect}
                                                ref={fileInputRef}
                                                style={{ display: 'none' }}
                                            />
                                            {importFile ? (
                                                <Box>
                                                    <Text color="green.600" fontWeight="bold">✓ {importFile.name}</Text>
                                                    <Text fontSize="sm" color="gray.500">{(importFile.size / 1024).toFixed(1)} KB</Text>
                                                </Box>
                                            ) : (
                                                <Box>
                                                    <Text fontSize="lg" mb={2}>📁 Drop CSV file here or click to browse</Text>
                                                    <Text fontSize="sm" color="gray.500">Supports .csv files</Text>
                                                </Box>
                                            )}
                                        </Box>
                                    </Box>
                                )}

                                {importStep === 'preview' && importPreview && (
                                    <Box>
                                        <Flex gap={4} mb={4} flexWrap="wrap">
                                            <Badge colorPalette="blue" fontSize="sm" p={2}>
                                                📊 {importPreview.transactions_count} Transactions
                                            </Badge>
                                            <Badge colorPalette="purple" fontSize="sm" p={2}>
                                                👤 {importPreview.accounts_count} Accounts
                                            </Badge>
                                            <Badge colorPalette="teal" fontSize="sm" p={2}>
                                                💎 {importPreview.assets_count} Assets
                                            </Badge>
                                            {importPreview.fee_transactions_count > 0 && (
                                                <Badge colorPalette="orange" fontSize="sm" p={2}>
                                                    💰 {importPreview.fee_transactions_count} Fee Transactions
                                                </Badge>
                                            )}
                                        </Flex>

                                        {importPreview.errors.length > 0 && (
                                            <Box mb={4} p={3} bg="red.50" borderRadius="md" borderWidth={1} borderColor="red.200">
                                                <Text color="red.600" fontWeight="bold" mb={2}>⚠️ Parse Errors ({importPreview.errors.length})</Text>
                                                {importPreview.errors.slice(0, 5).map((err, i) => (
                                                    <Text key={i} fontSize="sm" color="red.600">Row {err.row}: {err.error}</Text>
                                                ))}
                                                {importPreview.errors.length > 5 && (
                                                    <Text fontSize="sm" color="red.500">...and {importPreview.errors.length - 5} more errors</Text>
                                                )}
                                            </Box>
                                        )}

                                        {importPreview.warnings.length > 0 && (
                                            <Box mb={4} p={3} bg="yellow.50" borderRadius="md" borderWidth={1} borderColor="yellow.200">
                                                <Text color="yellow.700" fontWeight="bold" mb={2}>⚠️ Warnings ({importPreview.warnings.length})</Text>
                                                {importPreview.warnings.slice(0, 5).map((warn, i) => (
                                                    <Text key={i} fontSize="sm" color="yellow.700">{warn}</Text>
                                                ))}
                                            </Box>
                                        )}

                                        <Box mb={4}>
                                            <Text fontWeight="bold" mb={2}>Accounts to create as RawAccount:</Text>
                                            <Flex gap={1} flexWrap="wrap">
                                                {importPreview.accounts.map((acc, i) => (
                                                    <Badge key={i} colorPalette="purple" fontSize="xs">{acc}</Badge>
                                                ))}
                                            </Flex>
                                        </Box>

                                        <Box mb={4}>
                                            <Text fontWeight="bold" mb={2}>Assets to create as RawAsset:</Text>
                                            <Flex gap={1} flexWrap="wrap" maxH="100px" overflow="auto">
                                                {importPreview.assets.slice(0, 30).map((asset, i) => (
                                                    <Badge key={i} colorPalette="teal" fontSize="xs">{asset}</Badge>
                                                ))}
                                                {importPreview.assets.length > 30 && (
                                                    <Badge colorPalette="gray" fontSize="xs">+{importPreview.assets.length - 30} more</Badge>
                                                )}
                                            </Flex>
                                        </Box>

                                        <Box>
                                            <Text fontWeight="bold" mb={2}>Transaction Preview (first 20) - Source → Transformed:</Text>
                                            <Box maxH="350px" overflow="auto" borderWidth={1} borderRadius="md">
                                                <Table.Root size="sm">
                                                    <Table.Header>
                                                        <Table.Row>
                                                            <Table.ColumnHeader>Date</Table.ColumnHeader>
                                                            <Table.ColumnHeader bg="gray.100">CSV Type</Table.ColumnHeader>
                                                            <Table.ColumnHeader bg="blue.50">→ DB Type</Table.ColumnHeader>
                                                            <Table.ColumnHeader bg="blue.50">→ Direction</Table.ColumnHeader>
                                                            <Table.ColumnHeader bg="gray.100">CSV Asset</Table.ColumnHeader>
                                                            <Table.ColumnHeader bg="blue.50">→ DB Asset</Table.ColumnHeader>
                                                            <Table.ColumnHeader>Qty</Table.ColumnHeader>
                                                            <Table.ColumnHeader bg="blue.50">→ Fee</Table.ColumnHeader>
                                                            <Table.ColumnHeader bg="gray.100">CSV Account</Table.ColumnHeader>
                                                        </Table.Row>
                                                    </Table.Header>
                                                    <Table.Body>
                                                        {importPreview.transactions.slice(0, 20).map((tx, i) => {
                                                            // Compute transformed values (what will actually be stored in DB)
                                                            const dbType = tx.is_fee_transaction ? 'technical' : 'trade';
                                                            const direction = tx.is_fee_transaction
                                                                ? 'neutral'
                                                                : (tx.transaction_type === 'Buy' ? 'inflow' : 'outflow');
                                                            const dbQty = tx.is_fee_transaction ? 0 : tx.quantity;
                                                            const dbFee = tx.is_fee_transaction ? tx.quantity : tx.fee;
                                                            // DB asset: None for FEES, pending RawAsset mapping for trades
                                                            const dbAsset = tx.is_fee_transaction ? null : tx.asset_ticker;

                                                            return (
                                                                <Table.Row key={i} bg={tx.is_fee_transaction ? 'orange.50' : undefined}>
                                                                    <Table.Cell fontSize="xs">{formatDateTimeCompact(tx.date_time)}</Table.Cell>
                                                                    {/* CSV Source Type */}
                                                                    <Table.Cell fontSize="xs" bg="gray.50">
                                                                        <Badge colorPalette="gray" size="sm" variant="outline">
                                                                            {tx.transaction_type}
                                                                        </Badge>
                                                                    </Table.Cell>
                                                                    {/* → DB transaction_type */}
                                                                    <Table.Cell fontSize="xs" bg="blue.50">
                                                                        <Badge colorPalette={tx.is_fee_transaction ? 'orange' : 'blue'} size="sm">
                                                                            {dbType}
                                                                        </Badge>
                                                                    </Table.Cell>
                                                                    {/* → DB direction */}
                                                                    <Table.Cell fontSize="xs" bg="blue.50">
                                                                        <Badge
                                                                            colorPalette={direction === 'inflow' ? 'green' : direction === 'outflow' ? 'red' : 'gray'}
                                                                            size="sm"
                                                                        >
                                                                            {direction}
                                                                        </Badge>
                                                                    </Table.Cell>
                                                                    {/* CSV Source Asset */}
                                                                    <Table.Cell fontSize="xs" bg="gray.50" maxW="100px" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" title={tx.asset_label}>
                                                                        {tx.asset_ticker}
                                                                    </Table.Cell>
                                                                    {/* → DB Asset (asset_id mapping) */}
                                                                    <Table.Cell fontSize="xs" bg="blue.50">
                                                                        {dbAsset ? (
                                                                            <Badge colorPalette="teal" size="sm" title="Will create RawAsset for mapping">
                                                                                {dbAsset}
                                                                            </Badge>
                                                                        ) : (
                                                                            <Text color="gray.400" fontSize="xs">None</Text>
                                                                        )}
                                                                    </Table.Cell>
                                                                    {/* Quantity */}
                                                                    <Table.Cell fontSize="xs">
                                                                        {tx.is_fee_transaction ? (
                                                                            <Text as="span" textDecoration="line-through" color="gray.400">{tx.quantity?.toFixed(2)}</Text>
                                                                        ) : (
                                                                            tx.quantity?.toFixed(4) || '-'
                                                                        )}
                                                                    </Table.Cell>
                                                                    {/* → DB Fee */}
                                                                    <Table.Cell fontSize="xs" bg="blue.50">
                                                                        {dbFee ? `€${dbFee.toFixed(2)}` : '-'}
                                                                    </Table.Cell>
                                                                    {/* CSV Account */}
                                                                    <Table.Cell fontSize="xs" bg="gray.50">{tx.account_code}</Table.Cell>
                                                                </Table.Row>
                                                            );
                                                        })}
                                                    </Table.Body>
                                                </Table.Root>
                                            </Box>
                                            <Flex mt={2} gap={4} fontSize="xs" color="gray.600">
                                                <Text><Box as="span" bg="gray.100" px={1} borderRadius="sm">Gray</Box> = CSV source values</Text>
                                                <Text><Box as="span" bg="blue.50" px={1} borderRadius="sm">Blue</Box> = Transformed DB values</Text>
                                            </Flex>
                                        </Box>

                                        <Box mt={4} p={3} bg="blue.50" borderRadius="md">
                                            <Flex align="center" gap={2}>
                                                <Switch.Root
                                                    checked={dryRunMode}
                                                    onCheckedChange={(e: { checked: boolean }) => setDryRunMode(e.checked)}
                                                >
                                                    <Switch.HiddenInput />
                                                    <Switch.Control />
                                                </Switch.Root>
                                                <Text fontWeight="bold">Dry Run Mode</Text>
                                            </Flex>
                                            <Text fontSize="sm" color="gray.600" mt={1}>
                                                {dryRunMode
                                                    ? 'Preview only - no changes will be saved to the database'
                                                    : '⚠️ Changes will be committed to the database'}
                                            </Text>
                                        </Box>
                                    </Box>
                                )}

                                {importStep === 'result' && importResult && (
                                    <Box>
                                        <Box mb={4} p={4} bg={importResult.dry_run ? 'blue.50' : 'green.50'} borderRadius="md">
                                            <Text fontSize="lg" fontWeight="bold" mb={2}>
                                                {importResult.dry_run ? '🔍 Dry Run Complete' : '✅ Import Complete'}
                                            </Text>
                                            {importResult.dry_run && (
                                                <Text fontSize="sm" color="blue.600">
                                                    No changes were saved. Run again with Dry Run disabled to commit.
                                                </Text>
                                            )}
                                        </Box>

                                        <Flex gap={4} mb={4} flexWrap="wrap">
                                            <Box p={3} bg="gray.50" borderRadius="md" flex="1" minW="150px">
                                                <Text fontSize="sm" color="gray.500">Transactions</Text>
                                                <Text fontSize="xl" fontWeight="bold" color="green.600">
                                                    {importResult.transactions.created} created
                                                </Text>
                                                <Text fontSize="sm" color="gray.500">
                                                    {importResult.transactions.skipped} skipped
                                                </Text>
                                            </Box>
                                            <Box p={3} bg="gray.50" borderRadius="md" flex="1" minW="150px">
                                                <Text fontSize="sm" color="gray.500">Raw Accounts</Text>
                                                <Text fontSize="xl" fontWeight="bold" color="purple.600">
                                                    {importResult.raw_accounts.created} created
                                                </Text>
                                                <Text fontSize="sm" color="gray.500">
                                                    {importResult.raw_accounts.skipped} skipped
                                                </Text>
                                            </Box>
                                            <Box p={3} bg="gray.50" borderRadius="md" flex="1" minW="150px">
                                                <Text fontSize="sm" color="gray.500">Raw Assets</Text>
                                                <Text fontSize="xl" fontWeight="bold" color="teal.600">
                                                    {importResult.raw_assets.created} created
                                                </Text>
                                                <Text fontSize="sm" color="gray.500">
                                                    {importResult.raw_assets.skipped} skipped
                                                </Text>
                                            </Box>
                                        </Flex>

                                        {importResult.pending_review_count > 0 && (
                                            <Box p={3} bg="yellow.50" borderRadius="md" mb={4}>
                                                <Text color="yellow.700">
                                                    ⚠️ <strong>{importResult.pending_review_count}</strong> transactions need review
                                                    (unmapped accounts or assets). Use the Raw Accounts and Raw Assets editors to map them.
                                                </Text>
                                            </Box>
                                        )}

                                        {importResult.summary.total_errors > 0 && (
                                            <Box p={3} bg="red.50" borderRadius="md">
                                                <Text color="red.600" fontWeight="bold">
                                                    ❌ {importResult.summary.total_errors} errors occurred
                                                </Text>
                                            </Box>
                                        )}
                                    </Box>
                                )}
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2} justify="space-between" width="100%">
                                    <Button variant="outline" onClick={() => setShowImportDialog(false)}>
                                        Close
                                    </Button>
                                    <Flex gap={2}>
                                        {importStep === 'select' && (
                                            <Button
                                                colorPalette="teal"
                                                onClick={previewImport}
                                                disabled={!importFile || importLoading}
                                            >
                                                {importLoading ? <Spinner size="sm" /> : 'Preview'}
                                            </Button>
                                        )}
                                        {importStep === 'preview' && (
                                            <>
                                                <Button variant="outline" onClick={resetImportDialog}>
                                                    ← Back
                                                </Button>
                                                <Button
                                                    colorPalette={dryRunMode ? 'blue' : 'green'}
                                                    onClick={executeImport}
                                                    disabled={importLoading}
                                                >
                                                    {importLoading ? <Spinner size="sm" /> : (dryRunMode ? 'Run Dry Import' : 'Import Now')}
                                                </Button>
                                            </>
                                        )}
                                        {importStep === 'result' && (
                                            <>
                                                <Button variant="outline" onClick={resetImportDialog}>
                                                    Import Another
                                                </Button>
                                                {importResult?.dry_run && (
                                                    <Button
                                                        colorPalette="green"
                                                        onClick={() => {
                                                            setDryRunMode(false);
                                                            setImportStep('preview');
                                                        }}
                                                    >
                                                        Commit Import
                                                    </Button>
                                                )}
                                            </>
                                        )}
                                    </Flex>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* Transaction Detail Drawer - Always rendered, available from any tab */}
            <TransactionDetailDrawer
                transactionId={drawerTransactionId}
                isOpen={isDrawerOpen}
                onClose={() => {
                    setIsDrawerOpen(false);
                    setDrawerTransactionId(null);
                }}
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
        </Box >
    );
};
